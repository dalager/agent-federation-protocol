/**
 * ADR-0039 Decision 4: `afp hub <verb> …` — the CLI carrier for the four
 * hub acts. The signing, controller resolution and never-mint refusal are
 * `clientCli.ts`'s, shared with `task` and `show`; this file is the request
 * and its argument shape, nothing else. Never opens the store, because
 * `serve` holds it (ADR-0031 Decision 4) and the whole point is to run this
 * while the instance is up.
 *
 * A hub is named by its actor URL — `https://host/hubs/<id>` — because the
 * interesting hub is usually someone else's. A bare id is accepted as a
 * convenience and resolved under `AFP_ORIGIN`, which is the hub this
 * instance hosts (ADR-0037).
 */

import type { Config } from "../config.ts";
import { parsedBody, signedClient, type SignedClient } from "./clientCli.ts";
import { instanceActorId } from "../ap/documents.ts";

export { defaultController } from "./clientCli.ts";

export type HubCliVerb = "follow" | "unfollow" | "enroll" | "unenroll" | "list";

export interface HubCliArgs {
  verb: HubCliVerb;
  /** Absent only for `list`. */
  hub?: string;
  agent?: string;
  as?: string;
  role?: string;
  reason?: string;
  url?: string;
  capability: string[];
}

export const HUB_USAGE =
  "usage: hub follow|unfollow <hub-url-or-id> [--as <controller>] [--url <base>]\n" +
  "       hub enroll <agent> <hub-url-or-id> [--capability <id>]… [--role member|observer] [--as <controller>]\n" +
  "       hub unenroll <agent> <hub-url-or-id> [--reason <text>] [--as <controller>]\n" +
  "       hub list [--as <controller>]";

const VERBS = new Set<HubCliVerb>(["follow", "unfollow", "enroll", "unenroll", "list"]);

/** `argv` after the `hub` word. Throws the usage line on anything malformed. */
export function parseHubArgs(argv: readonly string[]): HubCliArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  const capability: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`--${arg.slice(2)} needs a value\n${HUB_USAGE}`);
      if (arg === "--capability") capability.push(value);
      else flags[arg.slice(2)] = value;
      i++;
      continue;
    }
    positional.push(arg);
  }

  const verb = positional[0] as HubCliVerb;
  if (!verb || !VERBS.has(verb)) throw new Error(`unknown hub verb ${JSON.stringify(positional[0] ?? "")}\n${HUB_USAGE}`);
  for (const flag of Object.keys(flags)) {
    if (!["as", "role", "reason", "url"].includes(flag)) throw new Error(`unknown flag --${flag}\n${HUB_USAGE}`);
  }

  if (verb === "list") return { verb, capability, ...flags } as HubCliArgs;

  if (verb === "follow" || verb === "unfollow") {
    const hub = positional[1];
    if (!hub) throw new Error(`${verb} needs a hub\n${HUB_USAGE}`);
    return { verb, hub, capability, ...flags } as HubCliArgs;
  }

  const [, agent, hub] = positional;
  if (!agent || !hub) throw new Error(`${verb} needs an agent and a hub\n${HUB_USAGE}`);
  return { verb, agent, hub, capability, ...flags } as HubCliArgs;
}

/** A hub actor URL as given, or a bare id resolved under this instance's own origin (the hub it hosts). */
export function hubActorUrl(config: Config, target: string): string {
  if (/^https?:/.test(target)) return target;
  if (!/^[\w-]+$/.test(target)) throw new Error(`not a hub url or id: ${target}`);
  return `${config.origin}/hubs/${target}`;
}

export interface HubCliResult {
  status: number;
  body: unknown;
  controller: string;
  url: string;
}

/**
 * `hub list` is a read, and deliberately two reads: this instance's own
 * Follow/Undo trail (what it *seeks*), and each of those hubs' `followers`
 * collection (what it *holds*). The two disagree exactly while a Follow is
 * in flight or was refused, which is the state an operator most needs to see
 * and which neither read alone would show.
 */
async function runList(client: SignedClient, selfActor: string, base: string | undefined): Promise<HubCliResult> {
  const response = await client.request("GET", "/afp/following", { accept: "application/json", base });
  const body = parsedBody(response) as { following?: string[] };
  const following = Array.isArray(body?.following) ? body.following : [];
  const seats: { hub: string; seated: boolean | "unknown" }[] = [];
  for (const hub of following) {
    try {
      const followers = await client.request("GET", `${new URL(hub).pathname}/followers`, { accept: "application/json", base });
      const parsed = parsedBody(followers) as { orderedItems?: unknown };
      const items = Array.isArray(parsed?.orderedItems) ? parsed.orderedItems.map(String) : null;
      seats.push({ hub, seated: items === null ? "unknown" : items.includes(selfActor) });
    } catch {
      // A hub this instance follows but cannot reach is not an error — it is
      // the answer "unknown", which is what an operator should read.
      seats.push({ hub, seated: "unknown" });
    }
  }
  return { status: response.status, body: { following, seats }, controller: client.controller, url: response.url };
}

export async function runHubCli(config: Config, args: HubCliArgs, fetchImpl: typeof fetch = fetch): Promise<HubCliResult> {
  const client = signedClient(config, args.as, fetchImpl);
  if (args.verb === "list") return runList(client, instanceActorId(config.origin), args.url);

  const hub = hubActorUrl(config, args.hub as string);
  const body = JSON.stringify({
    verb: args.verb,
    hub,
    ...(args.agent ? { agent: args.agent } : {}),
    ...(args.capability.length > 0 ? { capabilities: args.capability } : {}),
    ...(args.role ? { role: args.role } : {}),
    ...(args.reason ? { reason: args.reason } : {}),
  });
  const response = await client.request("POST", "/actor/command", { body, base: args.url });
  return { status: response.status, body: parsedBody(response), controller: client.controller, url: response.url };
}
