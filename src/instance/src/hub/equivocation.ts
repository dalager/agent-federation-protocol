/**
 * ADR-0020 Decision 2/5, W1/W2: the L1 equivocation predicate.
 *
 * `convicts` decides whether two signed `afp:Vote` activities are a
 * conviction pair, exactly as the ADR's W2 pseudocode states it. Signature
 * verification is NOT performed here — the ADR's `convicts(a, b)` pseudocode
 * includes `verify(a) && verify(b)`, but this repo's verification helpers
 * (`hub.ts`'s `verifySignature`, `crypto/proof.ts`'s `verifyProof`) already
 * run at every call site before a vote is ever counted or handed to this
 * function, so folding a second verification path in here would duplicate
 * that machinery instead of reusing it. Callers MUST verify both votes
 * before relying on a `convicts` result. `voteTupleOf`/`convicts` mirror
 * `src/verifier/equivocation.py` (WP-3) — a parity pair like
 * `thresholdOf`/`threshold_of`.
 */

import type { JsonValue } from "../crypto/jcs.ts";

export type VotePhase = "prepare" | "commit";

export interface VoteTuple {
  actor: string;
  round: string;
  phase: VotePhase;
  seqNo: number;
}

/**
 * Extracts the L1 ballot-identity tuple from a `Create{afp:Vote}` activity.
 * Returns null if any L1 field is missing or malformed — an L0 vote (no
 * `afp:phase`/`afp:seqNo`) is not a tuple, it simply has none.
 */
export function voteTupleOf(activity: { [key: string]: JsonValue }): VoteTuple | null {
  const actor = activity.actor;
  const object = activity.object;
  if (typeof actor !== "string" || typeof object !== "object" || object === null || Array.isArray(object)) return null;
  const round = (object as Record<string, JsonValue>)["afp:round"];
  const phase = (object as Record<string, JsonValue>)["afp:phase"];
  const seqNo = (object as Record<string, JsonValue>)["afp:seqNo"];
  if (typeof round !== "string") return null;
  if (phase !== "prepare" && phase !== "commit") return null;
  if (typeof seqNo !== "number" || !Number.isInteger(seqNo) || seqNo < 1) return null;
  return { actor, round, phase, seqNo };
}

/**
 * ADR-0020 W2: `convicts(a, b) ⇔` same `(actor, round, phase, seqNo)` and
 * differing `value` or `afp:proposalHash`. `a` and `b` are full signed
 * `afp:Vote` activities — pure function, no I/O, no signature verification
 * (see the file header).
 */
export function convicts(a: { [key: string]: JsonValue }, b: { [key: string]: JsonValue }): boolean {
  const ta = voteTupleOf(a);
  const tb = voteTupleOf(b);
  if (ta === null || tb === null) return false;
  if (ta.actor !== tb.actor || ta.round !== tb.round || ta.phase !== tb.phase || ta.seqNo !== tb.seqNo) return false;

  const oa = a.object as Record<string, JsonValue>;
  const ob = b.object as Record<string, JsonValue>;
  return oa.value !== ob.value || oa["afp:proposalHash"] !== ob["afp:proposalHash"];
}
