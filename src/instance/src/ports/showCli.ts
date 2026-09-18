/**
 * ADR-0038 Decision 4, the read side: `afp show …` — watch a served instance
 * from the terminal without stopping `serve`, as a signed reader.
 *
 *   show thread <url-or-slug>   GET /threads/:id/rendering   (ADR-0029 Watch)
 *   show agent  <name>          GET /agents/:name/timeline
 *   show status <name>          POST /agents/:name/command  "@<name> status"
 *   show result <url-or-slug>   the performer's afp:Result(s) on a task thread — the
 *                               rendering is the trail, this is the answer. Reads the
 *                               rendering to find the performer, then that agent's
 *                               GET /agents/:name/outbox, paged; no new server route.
 *
 * Every request is signed as the controller (`clientCli.ts`), and every
 * answer is the EXISTING read gate's (ADR-0013): a signed fetch is admitted
 * where the signer is a party, enrolled, or holds a grant; anything else is
 * 404, indistinguishable from a thread that does not exist. This tool widens
 * nothing and explains nothing — a refusal is reported as "not served to
 * <controller> (404)" and stops there, because the gate is deliberately not
 * an oracle and a client that speculated about why would be one.
 */

import type { Config } from "../config.ts";
import type { JsonValue } from "../crypto/jcs.ts";
import { parsedBody, signedClient, type SignedClient } from "./clientCli.ts";

export type ShowWhat = "thread" | "agent" | "status" | "result";

export interface ShowCliArgs {
  what: ShowWhat;
  target: string;
  as?: string;
  url?: string;
  json: boolean;
  /** `result` only: the performer, when the caller knows it. */
  agent?: string;
  /** `result` only: every Result on the thread, in order, instead of the latest. */
  all: boolean;
}

export const SHOW_USAGE =
  "usage: show thread <url-or-slug> | show agent <name> | show status <name> | show result <url-or-slug> [--agent <name>] [--all]   [--as <controller-name>] [--url <base>] [--json]";

/** `argv` after the `show` word. Throws the usage line on anything malformed. */
export function parseShowArgs(argv: readonly string[]): ShowCliArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  let json = false;
  let all = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--all") {
      all = true;
    } else if (arg.startsWith("--")) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value\n${SHOW_USAGE}`);
      flags[arg.slice(2)] = value;
      i++;
    } else {
      positional.push(arg);
    }
  }
  const [what, target] = positional;
  if (!what || !target || positional.length > 2 || !["thread", "agent", "status", "result"].includes(what)) throw new Error(SHOW_USAGE);
  for (const flag of Object.keys(flags)) {
    const allowed = what === "result" ? ["as", "url", "agent"] : ["as", "url"];
    if (!allowed.includes(flag)) throw new Error(`unknown flag --${flag}\n${SHOW_USAGE}`);
  }
  if (all && what !== "result") throw new Error(`--all is for show result\n${SHOW_USAGE}`);
  return { what: what as ShowWhat, target, json, all, ...flags } as ShowCliArgs;
}

/** A full thread URL or a bare slug → the thread's slug under this origin. */
export function threadSlug(config: Config, target: string): string {
  let slug = target;
  if (/^https?:/.test(target)) {
    const url = new URL(target);
    const match = /^\/threads\/([\w-]+)$/.exec(url.pathname);
    if (url.origin !== new URL(config.origin).origin || !match) throw new Error(`not a thread under ${config.origin}: ${target}`);
    slug = match[1];
  }
  if (!/^[\w-]+$/.test(slug)) throw new Error(`not a thread under ${config.origin}: ${target}`);
  return slug;
}

export interface ShowCliResult {
  status: number;
  /** The narrative text, or the JSON document (pretty-printed) — what the CLI prints. */
  output: string;
  /** Set when the instance did not serve the request; one line, no speculation. */
  refused?: string;
  controller: string;
  url: string;
}

type Activity = { [key: string]: JsonValue };

/**
 * Every item of a signed, gated collection — `OrderedCollection` in one
 * piece under the page threshold, `first` → `next` chain above it
 * (`ap/server.ts` `collectionDocument`). Each page is its own signed GET;
 * the signature covers `@path` alone, so `?page=N` rides outside it.
 */
async function collectionItems(client: SignedClient, path: string, base?: string): Promise<{ status: number; items: Activity[] }> {
  const items: Activity[] = [];
  let next: string | null = path;
  while (next !== null) {
    const response = await client.request("GET", next, { accept: "application/json", base });
    if (response.status !== 200) return { status: response.status, items };
    const page = parsedBody(response) as { orderedItems?: unknown; first?: unknown; next?: unknown };
    if (Array.isArray(page.orderedItems)) items.push(...(page.orderedItems as Activity[]));
    const follow = Array.isArray(page.orderedItems) ? page.next : page.first;
    next = typeof follow === "string" ? `${new URL(follow).pathname}${new URL(follow).search}` : null;
  }
  return { status: 200, items };
}

const RESULT_LINE = /^\S+ (\S+) Create\/afp:Result — /;

/**
 * Who performed on this thread, read off the rendering the controller is
 * admitted to. A rendering entry is a narrative line built by
 * `render/rendering.ts`'s `narrativeLine` — `<published> <actorTail>
 * <type>/<objectType> — <clauses>` — and the parallel `afp:renders` digests;
 * it carries no actor field of its own, so the performer is the second token
 * of every `Create/afp:Result` line. When no such line exists yet (Offer and
 * Accept only), every actor tail in the narrative is a candidate: the outbox
 * pass below settles it, and answers "no result yet" if none has one.
 */
function performersOf(rendering: { narrative?: unknown }, agent?: string): string[] {
  if (agent) return [agent];
  const lines = Array.isArray(rendering.narrative) ? (rendering.narrative as string[]) : [];
  const fromResults = [...new Set(lines.map((line) => RESULT_LINE.exec(line)?.[1]).filter((tail): tail is string => !!tail))];
  if (fromResults.length > 0) return fromResults;
  return [...new Set(lines.map((line) => line.split(" ")[1]).filter((tail) => !!tail && /^[\w-]+$/.test(tail)))];
}

function formatResult(activity: Activity): string {
  const object = (activity.object ?? {}) as Activity;
  const agent = String(activity.actor ?? "").split("/").pop() ?? "";
  const lines = [`${agent} · ${String(activity.published ?? "")} · afp:producedBy: ${typeof object["afp:producedBy"] === "string" ? object["afp:producedBy"] : "—"}`];
  lines.push(typeof object.content === "string" ? object.content : "");
  const attachments = Array.isArray(object.attachment) ? (object.attachment as Activity[]) : [];
  for (const link of attachments) lines.push(`attachment: ${String(link.mediaType ?? "?")} ${String(link["afp:digest"] ?? "")}`);
  return lines.join("\n");
}

async function showResult(config: Config, client: SignedClient, args: ShowCliArgs): Promise<ShowCliResult> {
  const slug = threadSlug(config, args.target);
  const thread = `${config.origin}/threads/${slug}`;
  const base = { status: 200, controller: client.controller, url: `${args.url ?? config.origin}/threads/${slug}/rendering` };

  const rendering = await client.request("GET", `/threads/${slug}/rendering`, { accept: "application/json", base: args.url });
  if (rendering.status === 404) return { ...base, status: 404, output: "", refused: `not served to ${client.controller} (404)` };
  if (rendering.status !== 200) return { ...base, status: rendering.status, output: "", refused: `${rendering.url} answered ${rendering.status}` };

  const results: Activity[] = [];
  for (const performer of performersOf(parsedBody(rendering) as { narrative?: unknown }, args.agent)) {
    const outbox = await collectionItems(client, `/agents/${performer}/outbox`, args.url);
    if (outbox.status === 404) continue; // not an agent here, or nothing served — the rendering already said what the controller may see
    if (outbox.status !== 200) return { ...base, status: outbox.status, output: "", refused: `${config.origin}/agents/${performer}/outbox answered ${outbox.status}` };
    for (const activity of outbox.items) {
      const object = activity.object;
      if (activity.context === thread && object && typeof object === "object" && !Array.isArray(object) && (object as Activity).type === "afp:Result") {
        results.push(activity);
      }
    }
  }
  results.sort((a, b) => String(a.published ?? "").localeCompare(String(b.published ?? "")));
  if (results.length === 0) return { ...base, status: 200, output: "", refused: `no result yet on ${thread}` };

  const selected = args.all ? results : [results[results.length - 1]];
  const output = args.json
    ? JSON.stringify(args.all ? selected : selected[0], null, 2)
    : selected.map(formatResult).join("\n\n");
  return { ...base, output };
}

export async function runShowCli(config: Config, args: ShowCliArgs, fetchImpl: typeof fetch = fetch): Promise<ShowCliResult> {
  const client = signedClient(config, args.as, fetchImpl);
  const accept = args.json ? "application/json" : "text/plain";
  if (args.what === "result") return showResult(config, client, args);

  let response;
  if (args.what === "status") {
    const body = JSON.stringify({ content: `@${args.target} status` });
    response = await client.request("POST", `/agents/${args.target}/command`, { body, base: args.url });
  } else {
    const path = args.what === "thread" ? `/threads/${threadSlug(config, args.target)}/rendering` : `/agents/${args.target}/timeline`;
    response = await client.request("GET", path, { accept, base: args.url });
  }

  const parsed = parsedBody(response);
  const polite = response.status === 200 && typeof parsed === "object" && parsed !== null && "reply" in parsed;
  const output = typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2);
  const base = { status: response.status, output, controller: client.controller, url: response.url };
  if (response.status === 404) return { ...base, refused: `not served to ${client.controller} (404)` };
  if (polite) return { ...base, refused: `not served to ${client.controller} (polite reply)` };
  if (response.status !== 200) return { ...base, refused: `${response.url} answered ${response.status}` };
  return base;
}
