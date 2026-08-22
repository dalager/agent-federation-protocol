/**
 * The pins a task-bearing activity carries (ADR-0010 Decisions 1, 2 and 4).
 *
 * ADR-0006 put `afp:actionPolicy` in the Announce, and everything that reads a
 * policy lived in the allocation layer with it. ADR-0010's whole finding is
 * that this was the wrong home: the spec routes *direct* delegation whenever
 * the target is known, and pinning only in the Announce disarmed every check in
 * exactly the flow most deployments use. So the pin vocabulary lives here, in
 * the P1 layer both flows already depend on — the direct `Offer{afp:Task}` and
 * the `Announce{afp:Task}` are two carriers of one thing, not two things.
 *
 * `allocation/actions.ts` re-exports all of this, so ADR-0006's readers find it
 * where they left it.
 */

import type { JsonValue } from "../crypto/jcs.ts";

/** A closed map `category → admissible action` (ADR-0006 Decision 1). */
export type ActionPolicy = Readonly<Record<string, string>>;

/** ADR-0010 Decision 4: the reserved category every policy must declare an action for. */
export const NO_VERDICT_CATEGORY = "afp:no-verdict";

/**
 * The three pins, as one value. They travel together and are compared together
 * — a thread's activities must agree on the *whole* set, so an Offer pinning
 * two of three diverges from one pinning three.
 */
export interface TaskPins {
  actionPolicy?: ActionPolicy;
  answerSufficiency?: { [key: string]: JsonValue };
  /** ADR-0010 Decision 2: the one actor whose Synthesis is admissible for the thread. */
  synthesizer?: string;
  /**
   * ADR-0011 Decision 1: action names, drawn from the pinned policy's own
   * values, whose external effect cannot be recalled — declared at pin time,
   * before any answer exists, so the escape hatch it opens (the `annotate`
   * disposition) is not negotiable after the answers are in.
   */
  irrevocableActions?: readonly string[];
}

/**
 * ADR-0010 Decision 4: a policy that cannot state its no-verdict action is not
 * yet a policy — terminality must always release the actuator, so the writer
 * refuses to pin one missing the reserved key rather than leaving replay to
 * name the gap after an application has already parked forever.
 */
export function validateActionPolicy(policy: ActionPolicy): void {
  const action = policy[NO_VERDICT_CATEGORY];
  if (typeof action !== "string" || !action) {
    throw new Error(`afp:actionPolicy is missing a declared, non-empty ${NO_VERDICT_CATEGORY} action (ADR-0010)`);
  }
}

/**
 * ADR-0011 Decision 1: every declared irrevocable action name MUST appear as a
 * value of the pinned policy — a name matching no action declares the
 * irreversibility of nothing, which is the kind of dead clause an auditor
 * reasonably reads as a live one.
 */
export function validateIrrevocableActions(policy: ActionPolicy, names: readonly string[]): void {
  const admissible = new Set(Object.values(policy));
  for (const name of names) {
    if (!admissible.has(name)) {
      throw new Error(`afp:irrevocableActions names ${name}, which is not a value of the pinned afp:actionPolicy (ADR-0011)`);
    }
  }
}

/** ADR-0019 W1: the reserved category releasing an actuator when a round did not decide. */
export const NO_DECISION_CATEGORY = "afp:no-decision";

/**
 * A proposal-pinned policy MUST name an admissible action for every option the
 * round offers AND for `afp:no-decision`. Refused at pin time, like
 * `validateActionPolicy`'s no-verdict rule — a round whose policy cannot answer
 * one of its own outcomes leaves the actuator parked on exactly the morning it
 * mattered.
 */
export function validateProposalActionPolicy(policy: ActionPolicy, options: readonly string[]): void {
  for (const option of [...options, NO_DECISION_CATEGORY]) {
    const action = policy[option];
    if (typeof action !== "string" || !action) {
      throw new Error(`afp:actionPolicy is missing a declared, non-empty action for outcome ${option} (ADR-0019)`);
    }
  }
}

/**
 * The pin set as it goes onto the wire — keys present only when supplied.
 *
 * A fan-out builds this once and spreads the same object into every Offer of
 * the thread: pin-equality is checked over the whole set at replay, so building
 * it per-Offer is how a publisher accidentally ships two stories.
 */
export function buildPinSet(pins: TaskPins): { [key: string]: JsonValue } {
  const pinSet: { [key: string]: JsonValue } = {};
  if (pins.actionPolicy) pinSet["afp:actionPolicy"] = { ...pins.actionPolicy };
  if (pins.answerSufficiency) pinSet["afp:answerSufficiency"] = { ...pins.answerSufficiency };
  if (pins.synthesizer) pinSet["afp:synthesizer"] = pins.synthesizer;
  if (pins.irrevocableActions?.length) pinSet["afp:irrevocableActions"] = [...pins.irrevocableActions];
  return pinSet;
}
