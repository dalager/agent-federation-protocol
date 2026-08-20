/**
 * Checkable actuation (ADR-0006 Decision 1).
 *
 * The record already makes *how an answer was reached* recomputable; these
 * helpers are the writer's side of making *what was done about it* the same.
 * An acting activity carries `afp:actsOn` — the digest of the Synthesis it
 * acts on — and `afp:action`, the action name it claims; the announce pinned
 * `afp:actionPolicy` before any answer existed, and the verifier's `action.py`
 * recomputes the whole binding from the record.
 *
 * Deliberately a literal map, not a registry of named functions: category in,
 * action name out is a decision table, and a pinned table is recomputable by
 * definition — there is no computation here worth a second implementation.
 */

import type { JsonValue } from "../crypto/jcs.ts";

export type ActionPolicy = Readonly<Record<string, string>>;

/**
 * The one admissible action for `category` under a pinned policy. Throws on a
 * category outside the closed set — an answer the policy does not name is not
 * an answer the policy admits acting on.
 */
export function admissibleAction(policy: ActionPolicy, category: string): string {
  const action = policy[category];
  if (typeof action !== "string" || !action) {
    throw new Error(`category ${category} is not in the pinned afp:actionPolicy (${Object.keys(policy).sort().join(", ")})`);
  }
  return action;
}

/**
 * The two fields that hash-bind a consequence to its cause. Spread into the
 * acting activity's body; `synthesisDigest` is the digest of the signed
 * `Create{afp:Synthesis}` activity being acted on. Validates against the
 * pinned policy when given one — a writer should refuse to emit an action its
 * own announce made inadmissible, rather than leaving that to the verifier.
 */
export function actionStamp(
  action: string,
  synthesisDigest: string,
  policyCheck?: { policy: ActionPolicy; category: string },
): { [key: string]: JsonValue } {
  if (policyCheck && admissibleAction(policyCheck.policy, policyCheck.category) !== action) {
    throw new Error(
      `action ${action} is not admissible for category ${policyCheck.category} — the pinned policy says ${admissibleAction(policyCheck.policy, policyCheck.category)}`,
    );
  }
  return { "afp:action": action, "afp:actsOn": synthesisDigest };
}
