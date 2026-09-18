/**
 * ADR-0038 Decision 4: `afp task <agent> "<brief>"` — the CLI carrier for the
 * `task` form. The signing, controller resolution and never-mint refusal are
 * `clientCli.ts`'s, shared with `show`; this file is the `task` request and
 * nothing else. Never opens the store.
 *
 * `--attach <digest>` (repeatable) names an artifact the store already holds
 * — the digest `show result` prints for a Result's attachment — so a review
 * can be pointed at a draft. It is a reference, never bytes: the command
 * port takes no content (ADR-0027's boundary; `ports/command.ts`).
 */

import type { Config } from "../config.ts";
import { parsedBody, signedClient, threadSlug } from "./clientCli.ts";

export { defaultController } from "./clientCli.ts";

export interface TaskCliArgs {
  agent: string;
  brief: string;
  as?: string;
  capability?: string;
  /** A thread URL or a bare slug, resolved under `AFP_ORIGIN` like `show`'s. */
  thread?: string;
  deadline?: string;
  url?: string;
  attach: string[];
}

const ARTIFACT_DIGEST = /^sha256:[0-9a-f]{64}$/;

export const TASK_USAGE =
  'usage: task <agent> "<brief>" [--as <controller-name>] [--capability <id>] [--thread <url-or-slug>] [--deadline <iso>] [--attach <digest>]… [--url <base>]';

/** `argv` after the `task` word. Throws the usage line on anything malformed. */
export function parseTaskArgs(argv: readonly string[]): TaskCliArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  const attach: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const value = argv[i + 1];
      if (arg === "--attach") {
        // Refused here, before anything is signed: an empty value (an unset
        // shell variable) must not become "a task with no attachment".
        if (value === undefined || !ARTIFACT_DIGEST.test(value)) throw new Error(`--attach needs a sha256:<hex> digest, got ${JSON.stringify(value ?? "")}\n${TASK_USAGE}`);
        attach.push(value);
      } else {
        if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value\n${TASK_USAGE}`);
        flags[arg.slice(2)] = value;
      }
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
  return { agent, brief, attach, ...flags } as TaskCliArgs;
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
  const client = signedClient(config, args.as, fetchImpl);
  const thread = args.thread ? `${config.origin}/threads/${threadSlug(config, args.thread)}` : undefined;
  const body = JSON.stringify({
    content: `@${args.agent} task ${args.brief}`,
    ...(args.capability ? { capability: args.capability } : {}),
    ...(thread ? { thread } : {}),
    ...(args.deadline ? { deadline: args.deadline } : {}),
    ...(args.attach.length > 0 ? { attachments: args.attach } : {}),
  });
  const response = await client.request("POST", `/agents/${args.agent}/command`, { body, base: args.url });
  return { status: response.status, body: parsedBody(response), controller: client.controller, url: response.url };
}
