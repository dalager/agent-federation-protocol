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
import type { ActionPolicy } from "../ap/pins.ts";

// The pin vocabulary moved down to the P1 layer when ADR-0010 gave the direct
// flow the same pins (see `ap/pins.ts` for why); re-exported here so ADR-0006's
// readers find it where it was.
export { NO_VERDICT_CATEGORY, buildPinSet, validateActionPolicy, NO_DECISION_CATEGORY, validateProposalActionPolicy } from "../ap/pins.ts";
export type { ActionPolicy, TaskPins } from "../ap/pins.ts";

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

/**
 * The two fields binding a consequence to a decision (ADR-0019 W1/W3). `outcome`
 * is the category — the DecisionRecord's own `afp:outcome` — so a writer cannot
 * claim an action its own round never admitted. Otherwise the shape of
 * `actionStamp`, over a `DecisionRecord` digest instead of a Synthesis one.
 */
export function decisionActionStamp(
  action: string,
  decisionDigest: string,
  policyCheck?: { policy: ActionPolicy; outcome: string },
): { [key: string]: JsonValue } {
  if (policyCheck && admissibleAction(policyCheck.policy, policyCheck.outcome) !== action) {
    throw new Error(
      `action ${action} is not admissible for outcome ${policyCheck.outcome} — the pinned policy says ${admissibleAction(policyCheck.policy, policyCheck.outcome)}`,
    );
  }
  return { "afp:action": action, "afp:actsOn": decisionDigest };
}

/**
 * The disposition edge (ADR-0007 Decision 3): when an answer is superseded,
 * every action that cited it gets dealt with on the record. The disposing
 * activity names the action it disposes of and acts on the *superseding*
 * Synthesis — the actuation loop run once more, under the same pinned policy.
 */
export function dispositionStamp(
  action: string,
  disposedActionDigest: string,
  supersedingSynthesisDigest: string,
  policyCheck?: { policy: ActionPolicy; category: string },
): { [key: string]: JsonValue } {
  return {
    ...actionStamp(action, supersedingSynthesisDigest, policyCheck),
    "afp:disposes": disposedActionDigest,
  };
}

/**
 * The `annotate` disposition (ADR-0011 Decision 2): for an action whose name
 * was declared irrevocable, the honest disposition is "we cannot undo this,
 * and here is the record saying so" — it binds the withdrawn justification to
 * the standing consequence and commands nothing external.
 *
 * Deliberately does NOT compose `actionStamp`: it carries no `afp:action`, so
 * there is nothing for the pinned policy to admit. ADR-0007's disposition duty
 * still gets satisfied — `afp:disposes` still names the disposed action, and
 * `afp:actsOn` still binds this activity to the superseding Synthesis — but
 * the check the verifier runs swaps rather than lapses: it asks whether the
 * disposed action's name appears in the `afp:irrevocableActions` pinned on the
 * thread that action was taken on, not whether the action is admissible.
 */
export function annotateStamp(
  disposedActionDigest: string,
  supersedingSynthesisDigest: string,
  irrevocableCheck?: { irrevocableActions: readonly string[]; disposedAction: string },
): { [key: string]: JsonValue } {
  // Symmetric with `actionStamp`'s policy guard: a writer refuses to claim an
  // escape hatch its own pins never opened, rather than leaving the verifier to
  // name it. The check is the disposed action's, not this activity's — the
  // declaration that matters was pinned on the thread where the irrevocable
  // thing was done, before it was done (ADR-0011 Decision 2).
  if (irrevocableCheck && !irrevocableCheck.irrevocableActions.includes(irrevocableCheck.disposedAction)) {
    throw new Error(
      `cannot annotate ${irrevocableCheck.disposedAction}: it is not in the pinned afp:irrevocableActions (${[...irrevocableCheck.irrevocableActions].sort().join(", ") || "none"}) — annotation is only available where irreversibility was declared (ADR-0011)`,
    );
  }
  return {
    "afp:disposition": "annotate",
    "afp:disposes": disposedActionDigest,
    "afp:actsOn": supersedingSynthesisDigest,
  };
}
