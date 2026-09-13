/**
 * An in-process fake git forge (ADR-0028 Decision 3, second bullet): proves
 * `gitForgeActuator`'s contract without a network dependency. A deployment's
 * real adapter is a second implementation of `Forge` (`ports/gitForge.ts`) —
 * this file owns nothing the interface does not name.
 *
 * Idempotent by construction: `openPullRequest` keyed on the same idempotency
 * key returns the PR already on file rather than opening a second one — the
 * contract a real forge honours through a branch name or a marker comment.
 */

import { createHash } from "node:crypto";
import type { Forge, Issue, PullRequest } from "../../ports/gitForge.ts";

export type { Forge, Issue, PullRequest };

/** `sha256:` + sha256 hex of the PR's own fields, canonically ordered — deterministic, no timestamp of its own. */
function prContentHash(number: number, branch: string, title: string, body: string): string {
  const canonical = JSON.stringify({ body, branch, number, title });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export class FakeForge implements Forge {
  /** When set, `openPullRequest` performs the write and THEN throws once — the crash between acting and reconciling. */
  failAfterWrite = false;

  private readonly issues = new Map<string, Issue>();
  private readonly branches = new Map<string, string>();
  private readonly pullRequestsByKey = new Map<string, PullRequest>();
  private nextNumber = 1;

  seedIssue(issue: Issue): void {
    this.issues.set(issue.id, issue);
  }

  readIssue(id: string): Issue | null {
    return this.issues.get(id) ?? null;
  }

  /**
   * Idempotent on the branch name — the same name a real forge honours as
   * its own idempotency token (a push to an existing branch is not a new
   * object). Distinct from `openPullRequest`'s key-based idempotency only in
   * which identifier it dedupes on.
   */
  pushBranch(name: string, content: string): void {
    this.branches.set(name, content);
  }

  openPullRequest(request: { key: string; branch: string; title: string; body: string }): PullRequest {
    const existing = this.pullRequestsByKey.get(request.key);
    if (existing) return existing;

    const number = this.nextNumber++;
    const pr: PullRequest = {
      number,
      url: `https://forge.example/pr/${number}`,
      key: request.key,
      branch: request.branch,
      title: request.title,
      body: request.body,
      contentHash: prContentHash(number, request.branch, request.title, request.body),
    };

    if (this.failAfterWrite) {
      this.failAfterWrite = false;
      // The write already landed — `pullRequestsByKey` holds it below — before
      // the throw: this is the crash between acting and reconciling ADR-0028
      // Decision 2 names. A retry presents the same key and finds it here.
      this.pullRequestsByKey.set(request.key, pr);
      throw new Error("fake forge: crashed after the write, before returning");
    }
    this.pullRequestsByKey.set(request.key, pr);
    return pr;
  }

  pullRequestByKey(key: string): PullRequest | null {
    return this.pullRequestsByKey.get(key) ?? null;
  }

  /** Distinct pull requests on file, keyed by idempotency key so a crash-and-retry never double-counts — the gate's G4 counts these. */
  count(): number {
    return this.pullRequestsByKey.size;
  }

  /** Arms a single crash on the next `openPullRequest` call that performs a write. */
  crashOnce(): void {
    this.failAfterWrite = true;
  }
}
