/**
 * LWW-Register — highest timestamp wins, nodeId tiebreak (ADR-0002 Decision 2).
 * Used for agent liveness/load: `{status, load, lastSeen}`.
 *
 * The merge is `max` over the total order (timestamp, nodeId) — a valid join:
 * commutative and associative because `max` is, idempotent because merging a
 * value with itself yields the same (timestamp, nodeId) pair.
 */

import type { LWWDelta, LWWState } from "./types.ts";

export function initialLWW<T>(delta: LWWDelta<T>): LWWState<T> {
  return { value: delta.value, timestamp: delta.timestamp, nodeId: delta.nodeId };
}

/** True if `challenger` wins over `incumbent` under (timestamp, nodeId) ordering. */
function wins(
  challengerTs: number,
  challengerNode: string,
  incumbentTs: number,
  incumbentNode: string,
): boolean {
  if (challengerTs !== incumbentTs) return challengerTs > incumbentTs;
  return challengerNode > incumbentNode;
}

export function mergeLWW<T>(state: LWWState<T> | null, delta: LWWDelta<T>): LWWState<T> {
  if (!state) return initialLWW(delta);
  if (wins(delta.timestamp, delta.nodeId, state.timestamp, state.nodeId)) {
    return { value: delta.value, timestamp: delta.timestamp, nodeId: delta.nodeId };
  }
  return state;
}

/** Join of two register states — same (timestamp, nodeId) ordering. */
export function joinLWW<T>(a: LWWState<T>, b: LWWState<T>): LWWState<T> {
  return mergeLWW(a, b);
}
