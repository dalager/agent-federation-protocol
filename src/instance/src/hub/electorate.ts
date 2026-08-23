/**
 * ADR-0021 Decisions 3 and 4: the writer's side of a recusal, and the state a
 * conviction leaves behind.
 *
 * Kept apart from `hub.ts` for the reason `equivocation.ts` is: these are pure
 * functions over signed activities, they are the parity twins of
 * `src/verifier/electorate.py`, and an auditor comparing the two
 * implementations should find each half self-contained in one file.
 *
 * The property that makes a declared recusal worth having is that it is
 * **recomputed, not trusted** — the estimator wall (ADR-0004) transplanted
 * from bid admission to the electorate. A proposer may not recuse its
 * opponents by declaring them recused; it may recuse the convicted and the
 * accused, and every reader can check which it did. A cause that does not
 * resolve is a named replay failure, and the hub refuses to sign one at
 * propose time rather than emitting a claim the verifier will reject.
 */

import type { JsonValue } from "../crypto/jcs.ts";
import { digestOf } from "../crypto/proof.ts";
import { convicts } from "./equivocation.ts";
import type { RecusalCause } from "./activities.ts";

type Activity = { [key: string]: JsonValue };

function objectOf(activity: Activity): Record<string, JsonValue> | null {
  const object = activity.object;
  if (typeof object !== "object" || object === null || Array.isArray(object)) return null;
  return object as Record<string, JsonValue>;
}

/**
 * The two `afp:Vote` activities carried verbatim inside an
 * `afp:EquivocationProof`, or `null` when it does not carry exactly two.
 * ADR-0020 Decision 1 embeds both signed votes precisely so a proof travels
 * self-contained; this is the reader of that promise.
 */
export function equivocationProofVotes(activity: Activity): [Activity, Activity] | null {
  const object = objectOf(activity);
  if (!object || object.type !== "afp:EquivocationProof") return null;
  const votes = object["afp:votes"];
  if (!Array.isArray(votes) || votes.length !== 2) return null;
  const [a, b] = votes;
  if (typeof a !== "object" || a === null || Array.isArray(a)) return null;
  if (typeof b !== "object" || b === null || Array.isArray(b)) return null;
  return [a as Activity, b as Activity];
}

/**
 * ADR-0021 Decision 3 / W2 — does this recusal cause resolve against the
 * record?
 *
 * The deliberate asymmetry, worth stating because it looks like an omission:
 * a cited proof must **convict** (`convicts` recomputed here), but its
 * signatures are *not* re-verified in this function. That is the replay-wide
 * layer's job — ADR-0020's V4 over the whole case file's key table — and
 * duplicating it would give two answers to one question, one of them from a
 * key table that does not contain the foreign actor's key.
 *
 * Closed registry (W0.7): an unrecognised `afp:form` returns false. It never
 * falls through to a default, because a form nobody recomputes is a way to
 * exclude a seat for free, which is the defect this decision exists to close.
 */
export function causeResolves(
  cause: RecusalCause | undefined,
  agent: string,
  proposal: Record<string, JsonValue>,
  allActivities: readonly Activity[],
): boolean {
  if (!cause || typeof cause !== "object") return false;
  switch (cause["afp:form"]) {
    case "equivocation-proof": {
      const wanted = (cause as { "afp:proof"?: unknown })["afp:proof"];
      if (typeof wanted !== "string") return false;
      const proofActivity = allActivities.find((activity) => digestOf(activity) === wanted);
      if (!proofActivity) return false;
      const votes = equivocationProofVotes(proofActivity);
      // The proof must convict *this* agent: a genuine proof against somebody
      // else is exactly the shape a proposer would reach for to recuse an
      // opponent cheaply.
      return votes !== null && votes[0].actor === agent && convicts(votes[0], votes[1]);
    }
    case "governance-subject":
      return proposal["afp:governanceSubject"] === agent;
    default:
      return false;
  }
}

/**
 * ADR-0021 Decision 4 / W2 — what the record can say about a convicted seat.
 *
 * Four states where there was previously one, and none of them changes what
 * zeroing does: a claim is not evidence (W0.3), so `zeroed-contested` weighs
 * exactly as much as `zeroed` — which is nothing. The value of the
 * distinction is that a governance round, and any later reader, can tell an
 * operator that says nothing from one that says its key was captured, and can
 * tell both from a hub that put the question to its members.
 */
export type ZeroState = "clear" | "zeroed" | "zeroed-contested" | "zeroed-by-decision" | "restored";
