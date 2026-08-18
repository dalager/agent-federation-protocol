/**
 * OR-Map<key, OR-Set<capability>> — the capability registry (ADR-0002 Decision 2).
 * Each key's field is itself an OR-Set; the map's join is per-key OR-Set join,
 * which inherits commutativity/associativity/idempotency from orset.ts.
 */

import { emptyORSet, joinORSet, mergeORSet } from "./orset.ts";
import type { ORMapDelta, ORMapState, ORSetState } from "./types.ts";

export function emptyORMap(): ORMapState {
  return { entries: {} };
}

export function mergeORMap(state: ORMapState, delta: ORMapDelta): ORMapState {
  const entries: Record<string, ORSetState> = {};
  for (const [key, field] of Object.entries(state.entries)) entries[key] = field;

  const current = entries[delta.key] ?? emptyORSet();
  entries[delta.key] = mergeORSet(current, { adds: delta.adds, removes: delta.removes });

  return { entries };
}

/** Join of two full map states — per-key OR-Set join, union of key sets. */
export function joinORMap(a: ORMapState, b: ORMapState): ORMapState {
  const entries: Record<string, ORSetState> = {};
  for (const [key, field] of Object.entries(a.entries)) entries[key] = field;
  for (const [key, field] of Object.entries(b.entries)) {
    entries[key] = entries[key] ? joinORSet(entries[key], field) : field;
  }
  return { entries };
}

/** Capabilities currently live for `key` (empty array if the key has never been touched). */
export function fieldOf(state: ORMapState, key: string): ORSetState {
  return state.entries[key] ?? emptyORSet();
}
