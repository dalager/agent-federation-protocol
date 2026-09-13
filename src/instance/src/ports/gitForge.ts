/**
 * The git-forge actuator (ADR-0028 Decision 3, second bullet): issue read,
 * branch push, pull-request open as the actuation. `merge` is refused by
 * contract — 02's "no unreviewed code lands" is a human's act, and this
 * adapter must not be able to take it (Decision 3, Consequences: "accepted").
 */

import type { Clock } from "../instance.ts";
import type { ExternalActuator, Justification, ActuationReceipt } from "../ports/external.ts";

export interface Issue {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

export interface PullRequest {
  readonly number: number;
  readonly url: string;
  readonly key: string;
  readonly branch: string;
  readonly title: string;
  readonly body: string;
  /** `sha256:` + 64 hex over the PR's own fields — what the reconciliation's `afp:contentHash` binds to. */
  readonly contentHash: string;
}

/**
 * The whole of what this adapter asks of a forge. Defined here, on the port
 * side, so `tools/fake-forge/` implements it and a deployment's real adapter
 * is a second implementation — the dependency points from the fake to the
 * contract, never the other way.
 */
export interface Forge {
  readIssue(id: string): Issue | null;
  pushBranch(name: string, content: string): void;
  openPullRequest(request: { key: string; branch: string; title: string; body: string }): PullRequest;
  pullRequestByKey(key: string): PullRequest | null;
}

export function gitForgeActuator(options: { name: string; forge: Forge; clock?: Clock; branchPrefix?: string }): ExternalActuator {
  const clock: Clock = options.clock ?? { now: () => new Date() };
  const branchPrefix = options.branchPrefix ?? "afp";

  return {
    name: options.name,
    refuses: ["merge"],
    async act(action: string, j: Justification): Promise<ActuationReceipt> {
      // Belt and braces: `instance/external.ts` refuses `merge` before `act`
      // is ever called, because it is listed in `refuses` above. This second
      // check is here in case something someday calls `act` directly.
      if (action === "merge") {
        throw new Error(`${options.name} refuses to merge — that is a human's act (ADR-0028 Decision 3)`);
      }
      if (action !== "open-pull-request") {
        throw new Error(`${options.name} does not know action ${action}`);
      }

      const branch = `${branchPrefix}/${j.idempotencyKey.slice(0, 16)}`;
      options.forge.pushBranch(branch, `# ${j.actsOn}\n`);
      const pr = options.forge.openPullRequest({
        key: j.idempotencyKey,
        branch,
        title: `Fix for ${j.correlationId}`,
        body: `Opened by ${options.name} for actsOn digest ${j.actsOn}.`,
      });

      return {
        externalRef: pr.url,
        contentHash: pr.contentHash,
        observedAt: clock.now().toISOString(),
      };
    },
  };
}
