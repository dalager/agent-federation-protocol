/**
 * ADR-0038 Decision 4, the read side: `afp show …` — watch a served instance
 * from the terminal without stopping `serve`, as a signed reader.
 *
 *   show thread <url-or-slug>   GET /threads/:id/rendering   (ADR-0029 Watch)
 *   show agent  <name>          GET /agents/:name/timeline
 *   show status <name>          POST /agents/:name/command  "@<name> status"
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
import { parsedBody, signedClient } from "./clientCli.ts";

export type ShowWhat = "thread" | "agent" | "status";

export interface ShowCliArgs {
  what: ShowWhat;
  target: string;
  as?: string;
  url?: string;
  json: boolean;
}

export const SHOW_USAGE =
  "usage: show thread <url-or-slug> | show agent <name> | show status <name>   [--as <controller-name>] [--url <base>] [--json]";

/** `argv` after the `show` word. Throws the usage line on anything malformed. */
export function parseShowArgs(argv: readonly string[]): ShowCliArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
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
  if (!what || !target || positional.length > 2 || !["thread", "agent", "status"].includes(what)) throw new Error(SHOW_USAGE);
  for (const flag of Object.keys(flags)) {
    if (!["as", "url"].includes(flag)) throw new Error(`unknown flag --${flag}\n${SHOW_USAGE}`);
  }
  return { what: what as ShowWhat, target, json, ...flags } as ShowCliArgs;
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

export async function runShowCli(config: Config, args: ShowCliArgs, fetchImpl: typeof fetch = fetch): Promise<ShowCliResult> {
  const client = signedClient(config, args.as, fetchImpl);
  const accept = args.json ? "application/json" : "text/plain";

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
