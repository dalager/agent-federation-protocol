/**
 * ADR-0038 Decision 4: `afp task <agent> "<brief>"` — the CLI carrier for the
 * `task` form, and the one `cli.ts` command that talks to a *running*
 * instance instead of opening its store.
 *
 * `serve` holds the store lock (ADR-0031 Decision 4: one writer, enforced),
 * so a second process pointed at the same `AFP_DATA_DIR` cannot open it — and
 * must not try. This module never constructs an `AfpInstance` and never
 * touches the SQLite file: it loads the controller's key from the key
 * directory, signs `POST /agents/<agent>/command` exactly the way
 * `test/adr0029.test.ts`'s harness does (`signRequest` + `fileSigner`), and
 * sends it to the served instance. What happens next is the served process's
 * business, on the record.
 *
 * It also never mints: a controller whose key is absent fails by name
 * (`keyExists` before `loadOrCreateKeyPair`). A client tool that quietly
 * minted a fresh identity would put an actor on disk the roster never
 * vouched for.
 *
 * The request goes out with a plain `fetch`, not `policedFetch` — this is the
 * operator's own tool addressing their own instance, on loopback in dev mode
 * or at the origin they configured; ADR-0025's SSRF guard is for what the
 * *instance* fetches on a stranger's say-so, not for what the operator types.
 */

import type { Config } from "../config.ts";
import { keyExists, loadOrCreateKeyPair } from "../crypto/keys.ts";
import { fileSigner } from "../crypto/signer.ts";
import { signRequest } from "../federation/httpSig.ts";
import { agentActorId } from "../ap/documents.ts";

export interface TaskCliArgs {
  agent: string;
  brief: string;
  as?: string;
  capability?: string;
  thread?: string;
  deadline?: string;
  url?: string;
}

export const TASK_USAGE = 'usage: task <agent> "<brief>" [--as <controller-name>] [--capability <id>] [--thread <url>] [--deadline <iso>] [--url <base>]';

/** `argv` after the `task` word. Throws the usage line on anything malformed. */
export function parseTaskArgs(argv: readonly string[]): TaskCliArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value\n${TASK_USAGE}`);
      flags[arg.slice(2)] = value;
      i++;
    } else {
      positional.push(arg);
    }
  }
  const [agent, brief] = positional;
  if (!agent || !brief || positional.length > 2) throw new Error(TASK_USAGE);
  for (const flag of Object.keys(flags)) {
    if (!["as", "capability", "thread", "deadline", "url"].includes(flag)) throw new Error(`unknown flag --${flag}\n${TASK_USAGE}`);
  }
  return { agent, brief, ...flags } as TaskCliArgs;
}

/** Local name of a controller URL under this origin, or null for a foreign one. */
function localControllerName(config: Config, url: string): string | null {
  const prefix = `${config.origin}/agents/`;
  if (!url.startsWith(prefix)) return null;
  const name = url.slice(prefix.length);
  return /^[\w-]+$/.test(name) ? name : null;
}

/**
 * `--as` defaults to the first `afp:controllers` entry that names an actor
 * under this origin — the same "held here" test `executeCommand` applies on
 * the other side, resolved without opening the store.
 */
export function defaultController(config: Config): string | null {
  for (const url of config.policy.controllers ?? []) {
    const name = localControllerName(config, url);
    if (name !== null) return name;
  }
  return null;
}

export interface TaskCliResult {
  status: number;
  body: unknown;
  controller: string;
  url: string;
}

export async function runTaskCli(
  config: Config,
  args: TaskCliArgs,
  fetchImpl: typeof fetch = fetch,
): Promise<TaskCliResult> {
  const controller = args.as ?? defaultController(config);
  if (!controller) {
    throw new Error("no --as given and no afp:controllers entry names an actor under this origin — set AFP_CONTROLLERS or the policy file's controllers");
  }
  if (!keyExists(config.keyDir, controller)) {
    throw new Error(
      `controller key for "${controller}" not found in ${config.keyDir} — this command never mints one; ` +
        `the controller must be on the served instance's roster (AFP_AGENTS_FILE, brain "none") and its key minted by serve`,
    );
  }
  const controllerUrl = agentActorId(config.origin, controller);
  const pair = loadOrCreateKeyPair(config.keyDir, controller, controllerUrl);

  const path = `/agents/${args.agent}/command`;
  const target = new URL(path, args.url ?? config.origin);
  const body = JSON.stringify({
    content: `@${args.agent} task ${args.brief}`,
    ...(args.capability ? { capability: args.capability } : {}),
    ...(args.thread ? { thread: args.thread } : {}),
    ...(args.deadline ? { deadline: args.deadline } : {}),
  });
  const headers = signRequest("POST", target.pathname, target.host, body, fileSigner(pair), new Date());

  const response = await fetchImpl(target, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body,
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed, controller, url: target.toString() };
}
