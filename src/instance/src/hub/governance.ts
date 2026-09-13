/**
 * ADR-0033 Decision 4: the hub-policy answers to ADR-0021's two open
 * questions, enforced where the record already has hooks.
 *
 * Kept apart from `hub.ts` for the reason `equivocation.ts` and
 * `electorate.ts` are: these are pure functions over signed activities and
 * pinned state, mirrored on the Python side (WP-3's `decision.py`), so an
 * auditor comparing implementations finds each half self-contained here.
 */

import type { JsonValue } from "../crypto/jcs.ts";
import type { GovernanceSpec } from "../ap/policy.ts";
import { convicts } from "./equivocation.ts";
import { equivocationProofVotes } from "./electorate.ts";
import { thresholdOf, type QuorumRule } from "./quorum.ts";

type Activity = { [key: string]: JsonValue };

/** ADR-0033 Decision 4: today's behaviour (Q2: any-member) unless a policy names otherwise. */
export const DEFAULT_GOVERNANCE: GovernanceSpec = {
  subjectPrecondition: "any-member",
  electorateFloor: "no-decision:electorate-exhausted",
};

/** Thrown when a policy's governance answer refuses the round outright — named, never a silent no-op. */
export class GovernanceRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GovernanceRefused";
  }
}

function objectOf(activity: Activity): Record<string, JsonValue> | null {
  const object = activity.object;
  if (typeof object !== "object" || object === null || Array.isArray(object)) return null;
  return object as Record<string, JsonValue>;
}

/**
 * `proof-or-dispute-on-record`: does the hub's record hold either (a) an
 * `Announce{afp:EquivocationProof}` convicting `subject`, or (b) an
 * `afp:ContributionDispute` whose `afp:evidence` names an activity digest
 * authored by `subject`? `pool` is every activity the hub can see — the same
 * shared-db `outbox.actors()` sweep `recusalResolves` already runs. `digestOf`
 * is the caller's (`hub.ts` already imports `crypto/proof.ts`), so this takes
 * it as a parameter rather than importing it a second time.
 */
export function subjectPreconditionResolves(
  subject: string,
  pool: readonly Activity[],
  digestOf: (activity: Activity) => string,
): boolean {
  const byDigest = new Map(pool.map((activity) => [digestOf(activity), activity]));

  for (const activity of pool) {
    const object = objectOf(activity);
    if (!object) continue;

    if (object.type === "afp:EquivocationProof") {
      const votes = equivocationProofVotes(activity);
      if (votes && votes[0].actor === subject && convicts(votes[0], votes[1])) return true;
    }

    if (object.type === "afp:ContributionDispute") {
      const evidence = object["afp:evidence"];
      if (!Array.isArray(evidence)) continue;
      for (const cited of evidence) {
        const namedActivity = byDigest.get(String(cited));
        if (namedActivity && namedActivity.actor === subject) return true;
      }
    }
  }
  return false;
}

/**
 * ADR-0033 Decision 4's electorate floor: can the pinned electorate satisfy
 * the pinned quorum rule at all? A round with no quorum rule is exhausted
 * only when it has zero voters — the same "doom is meaningless without a
 * bar" reading `Hub.doomed` uses, extended to the moment of opening.
 */
export function electorateExhausted(voters: readonly string[], weights: Readonly<Record<string, number>>, quorumRule?: QuorumRule): boolean {
  if (!quorumRule) return voters.length === 0;
  const bar = thresholdOf(quorumRule, weights);
  if (bar === null) return false; // an unresolvable rule fails its own named check elsewhere
  const total = Object.values(weights).reduce((sum, w) => sum + w, 0);
  return total < bar;
}
