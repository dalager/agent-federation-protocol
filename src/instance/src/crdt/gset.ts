/**
 * G-Set — grow-only set, set union. Used for the vote-receipt store: signed
 * receipts are never removed, only added, so union alone is the whole merge
 * rule (ADR-0002 Decision 2, Decision 3 — "the receipts are the evidence").
 */

import { canonicalize, type JsonValue } from "../crypto/jcs.ts";
import type { GSetDelta, GSetState } from "./types.ts";

export function emptyGSet<T>(): GSetState<T> {
  return { elements: [] };
}

/** Merge is plain set union, deduplicated by canonical JSON form. */
export function mergeGSet<T extends JsonValue>(
  state: GSetState<T>,
  delta: GSetDelta<T>,
): GSetState<T> {
  const seen = new Map<string, T>();
  for (const el of state.elements) seen.set(canonicalize(el), el);
  for (const el of delta.adds) seen.set(canonicalize(el), el);
  return { elements: [...seen.values()] };
}

/** Union of two G-Set states — the join used by the property tests directly. */
export function joinGSet<T extends JsonValue>(a: GSetState<T>, b: GSetState<T>): GSetState<T> {
  return mergeGSet(a, { adds: b.elements });
}
