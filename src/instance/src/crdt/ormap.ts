/**
 * OR-Map<key, OR-Set<capability>> — the capability registry (ADR-0002 Decision 2).
 * Each key's field is itself an OR-Set; the map's join is per-key OR-Set join,
 * which inherits commutativity/associativity/idempotency from orset.ts.
 */

import { emptyORSet, joinORSet, mergeORSet } from "./orset.ts";
import { joinLWW, mergeLWW } from "./lww.ts";
import type { LWWState, ORMapDelta, ORMapState, ORSetState } from "./types.ts";

export function emptyORMap(): ORMapState {
  return { entries: {} };
}

export function mergeORMap(state: ORMapState, delta: ORMapDelta): ORMapState {
  const entries: Record<string, ORSetState> = { ...state.entries };
  const lwwEntries: Record<string, LWWState<unknown>> = { ...(state.lwwEntries ?? {}) };

  if (delta.fieldType === "LWW_REGISTER") {
    // ADR-0004 asset registry: the field is a whole record, LWW per key. The
    // per-field merge inherits its lattice properties from lww.ts.
    lwwEntries[delta.key] = mergeLWW(lwwEntries[delta.key] ?? null, {
      value: delta.value,
      timestamp: delta.timestamp,
      nodeId: delta.nodeId,
    });
  } else {
    const current = entries[delta.key] ?? emptyORSet();
    entries[delta.key] = mergeORSet(current, { adds: delta.adds, removes: delta.removes });
  }

  return Object.keys(lwwEntries).length ? { entries, lwwEntries } : { entries };
}

/** Join of two full map states — per-key field join, union of key sets. */
export function joinORMap(a: ORMapState, b: ORMapState): ORMapState {
  const entries: Record<string, ORSetState> = {};
  for (const [key, field] of Object.entries(a.entries)) entries[key] = field;
  for (const [key, field] of Object.entries(b.entries)) {
    entries[key] = entries[key] ? joinORSet(entries[key], field) : field;
  }
  const lwwEntries: Record<string, LWWState<unknown>> = { ...(a.lwwEntries ?? {}) };
  for (const [key, field] of Object.entries(b.lwwEntries ?? {})) {
    lwwEntries[key] = lwwEntries[key] ? joinLWW(lwwEntries[key], field) : field;
  }
  return Object.keys(lwwEntries).length ? { entries, lwwEntries } : { entries };
}

/** The LWW field currently held for `key` (null if never written). */
export function lwwFieldOf(state: ORMapState, key: string): LWWState<unknown> | null {
  return state.lwwEntries?.[key] ?? null;
}

/** Capabilities currently live for `key` (empty array if the key has never been touched). */
export function fieldOf(state: ORMapState, key: string): ORSetState {
  return state.entries[key] ?? emptyORSet();
}
