/**
 * OR-Set — add/remove-wins via unique tags + tombstones (ADR-0002 Decision 2).
 * Used for hub membership (join-epoch tagged AgentRefs) and, per-key, for the
 * capability registry's OR-Map<agentId, OR-Set<capability>>.
 *
 * Semantics: an element is a *member* of the set iff it has at least one
 * add-tag that is not tombstoned. Adding again after a remove uses a fresh
 * tag, so re-add-after-remove makes the element live again — this is the
 * standard "add wins" OR-Set join: unioning tag sets and tombstone sets is
 * commutative, associative, and idempotent by construction (plain set union).
 */

import type { ORSetAdd, ORSetDelta, ORSetRemove, ORSetState } from "./types.ts";

export function emptyORSet(): ORSetState {
  return { elementTags: {}, tombstones: {} };
}

function unionInto(target: Record<string, string[]>, element: string, tags: string[]): void {
  const existing = new Set(target[element] ?? []);
  for (const tag of tags) existing.add(tag);
  target[element] = [...existing];
}

/** Apply one delta (adds + removes) on top of `state`, returning a new state. */
export function mergeORSet(state: ORSetState, delta: ORSetDelta): ORSetState {
  const elementTags: Record<string, string[]> = {};
  for (const [el, tags] of Object.entries(state.elementTags)) elementTags[el] = [...tags];
  const tombstones: Record<string, string[]> = {};
  for (const [el, tags] of Object.entries(state.tombstones)) tombstones[el] = [...tags];

  for (const add of delta.adds as ORSetAdd[]) unionInto(elementTags, add.element, [add.tag]);
  for (const remove of delta.removes as ORSetRemove[]) {
    unionInto(tombstones, remove.element, remove.tombstoneTags);
  }

  return { elementTags, tombstones };
}

/** Join of two full states — union of both maps, same rule as mergeORSet. */
export function joinORSet(a: ORSetState, b: ORSetState): ORSetState {
  let result = mergeORSet(a, { adds: [], removes: [] });
  for (const [element, tags] of Object.entries(b.elementTags)) {
    result = mergeORSet(result, { adds: tags.map((tag) => ({ element, tag })), removes: [] });
  }
  for (const [element, tags] of Object.entries(b.tombstones)) {
    result = mergeORSet(result, { adds: [], removes: [{ element, tombstoneTags: tags }] });
  }
  return result;
}

/** Elements currently live: at least one add-tag survives its tombstones. */
export function liveElements(state: ORSetState): string[] {
  const out: string[] = [];
  for (const [element, tags] of Object.entries(state.elementTags)) {
    const dead = new Set(state.tombstones[element] ?? []);
    if (tags.some((tag) => !dead.has(tag))) out.push(element);
  }
  return out.sort();
}

export function isMember(state: ORSetState, element: string): boolean {
  const tags = state.elementTags[element] ?? [];
  const dead = new Set(state.tombstones[element] ?? []);
  return tags.some((tag) => !dead.has(tag));
}
