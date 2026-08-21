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
  return pinSet;
}
