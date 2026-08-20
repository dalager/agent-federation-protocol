/**
 * The CRDT adapter surface (ADR-0002 Decision 2).
 *
 * `Hub` codes only against these four small classes. They hold no merge
 * logic of their own: every operation delegates to the real hand-rolled
 * implementation in `src/instance/src/crdt/` — one CRDT implementation in
 * the codebase, one class-shaped view of it for the hub's call sites.
 */

import { type JsonValue } from "../crypto/jcs.ts";
import {
  emptyGSet,
  emptyORMap,
  emptyORSet,
  joinGSet,
  joinLWW,
  joinORMap,
  joinORSet,
  liveElements,
  lwwFieldOf,
  mergeGSet,
  mergeLWW,
  mergeORMap,
  mergeORSet,
  type GSetState,
  type LWWState,
  type ORMapState,
  type ORSetState,
} from "../crdt/index.ts";

export interface CrdtStore<TState, TDelta> {
  /** Fold one delta into local state. Must be idempotent. */
  apply(delta: TDelta): void;
  /** Fold another replica's full state into this one. Must be commutative/associative. */
  merge(other: this): void;
  getState(): TState;
}

// --------------------------------------------------------------- OR-Set

export interface ORSetDelta<T> {
  op: "add" | "remove";
  value: T;
  /** Unique per add — remove-wins is tag-and-tombstone, not value equality. */
  tag: string;
}

/** Add/remove-wins set backed by `crdt/orset.ts` (02's membership store). */
export class ORSet<T extends string> implements CrdtStore<Set<T>, ORSetDelta<T>> {
  private state: ORSetState = emptyORSet();

  apply(delta: ORSetDelta<T>): void {
    this.state = mergeORSet(
      this.state,
      delta.op === "add"
        ? { adds: [{ element: delta.value, tag: delta.tag }], removes: [] }
        : { adds: [], removes: [{ element: delta.value, tombstoneTags: [delta.tag] }] },
    );
  }

  merge(other: this): void {
    this.state = joinORSet(this.state, other.state);
  }

  getState(): Set<T> {
    return new Set(liveElements(this.state) as T[]);
  }

  /** Live (non-tombstoned) tags currently backing `value` — the input `remove` needs. */
  tagsFor(value: T): string[] {
    const dead = new Set(this.state.tombstones[value] ?? []);
    return (this.state.elementTags[value] ?? []).filter((tag) => !dead.has(tag));
  }

  has(value: T): boolean {
    return this.tagsFor(value).length > 0;
  }

  /** Rehydrate from persisted `CRDTStore` state — see `Hub`'s startup hydration. */
  restore(state: ORSetState): void {
    this.state = state;
  }
}

// --------------------------------------------------------------- OR-Map

export interface ORMapDelta<K, V> {
  key: K;
  set: ORSetDelta<V>;
}

/** `OR-Map<K, OR-Set<V>>` backed by `crdt/ormap.ts` (02's capability registry). */
export class ORMap<K extends string, V extends string>
  implements CrdtStore<Map<K, Set<V>>, ORMapDelta<K, V>>
{
  private state: ORMapState = emptyORMap();

  apply(delta: ORMapDelta<K, V>): void {
    const { op, value, tag } = delta.set;
    this.state = mergeORMap(this.state, {
      key: delta.key,
      fieldType: "OR_SET",
      adds: op === "add" ? [{ element: value, tag }] : [],
      removes: op === "remove" ? [{ element: value, tombstoneTags: [tag] }] : [],
    });
  }

  merge(other: this): void {
    this.state = joinORMap(this.state, other.state);
  }

  getState(): Map<K, Set<V>> {
    const out = new Map<K, Set<V>>();
    for (const [key, set] of Object.entries(this.state.entries)) {
      out.set(key as K, new Set(liveElements(set) as V[]));
    }
    return out;
  }

  setFor(key: K): ORSet<V> {
    const view = new ORSet<V>();
    const entry = this.state.entries[key];
    if (entry) {
      for (const [element, tags] of Object.entries(entry.elementTags)) {
        for (const tag of tags) view.apply({ op: "add", value: element as V, tag });
      }
      for (const [element, tags] of Object.entries(entry.tombstones)) {
        for (const tag of tags) view.apply({ op: "remove", value: element as V, tag });
      }
    }
    return view;
  }

  /** Rehydrate from persisted `CRDTStore` state — see `Hub`'s startup hydration. */
  restore(state: ORMapState): void {
    this.state = state;
  }
}

// --------------------------------------------------------- OR-Map (LWW fields)

export interface ORMapLWWDelta<K, V> {
  key: K;
  value: V;
  timestamp: number;
  nodeId: string;
}

/**
 * `OR-Map<K, LWW-Register<V>>` backed by `crdt/ormap.ts` — the ADR-0004 asset
 * registry: assetId → whole asset record, last-writer-wins per key.
 */
export class ORMapLWW<K extends string, V> implements CrdtStore<Map<K, V>, ORMapLWWDelta<K, V>> {
  private state: ORMapState = emptyORMap();

  apply(delta: ORMapLWWDelta<K, V>): void {
    this.state = mergeORMap(this.state, {
      key: delta.key,
      fieldType: "LWW_REGISTER",
      value: delta.value,
      timestamp: delta.timestamp,
      nodeId: delta.nodeId,
    });
  }

  merge(other: this): void {
    this.state = joinORMap(this.state, other.state);
  }

  getState(): Map<K, V> {
    const out = new Map<K, V>();
    for (const [key, field] of Object.entries(this.state.lwwEntries ?? {})) {
      out.set(key as K, field.value as V);
    }
    return out;
  }

  get(key: K): V | null {
    return (lwwFieldOf(this.state, key)?.value as V | undefined) ?? null;
  }

  /** Rehydrate from persisted `CRDTStore` state — see `Hub`'s startup hydration. */
  restore(state: ORMapState): void {
    this.state = state;
  }
}

// --------------------------------------------------------------- LWW-Register

export interface LWWValue<T> {
  value: T;
  timestamp: number;
  nodeId: string;
}

/** Highest timestamp wins, `nodeId` breaks ties — backed by `crdt/lww.ts`. */
export class LWWRegister<T> implements CrdtStore<LWWValue<T> | null, LWWValue<T>> {
  private state: LWWState<T> | null = null;

  apply(delta: LWWValue<T>): void {
    this.state = mergeLWW(this.state, delta);
  }

  merge(other: this): void {
    if (other.state === null) return;
    this.state = this.state === null ? other.state : joinLWW(this.state, other.state);
  }

  getState(): LWWValue<T> | null {
    return this.state;
  }

  /** Rehydrate from persisted `CRDTStore` state — see `Hub`'s startup hydration. */
  restore(state: LWWState<T>): void {
    this.state = state;
  }
}

// --------------------------------------------------------------- G-Set

/** Set union, no removal — the vote-receipt evidence store, backed by `crdt/gset.ts`. */
export class GSet<T extends JsonValue> implements CrdtStore<Map<string, T>, { key: string; value: T }> {
  private state: GSetState<{ key: string; value: T }> = emptyGSet();

  apply(delta: { key: string; value: T }): void {
    this.state = mergeGSet(this.state, { adds: [{ key: delta.key, value: delta.value }] });
  }

  merge(other: this): void {
    this.state = joinGSet(this.state, other.state);
  }

  getState(): Map<string, T> {
    const out = new Map<string, T>();
    for (const el of this.state.elements) out.set(el.key, el.value);
    return out;
  }

  has(key: string): boolean {
    return this.state.elements.some((el) => el.key === key);
  }
}
