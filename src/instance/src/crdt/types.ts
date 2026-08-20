/**
 * The four hand-rolled CRDT types from ADR-0002 Decision 2, plus the
 * `afp:CRDTDelta` envelope shape from 02-hubs-and-state.md.
 *
 * All four merges are commutative, associative and idempotent joins over a
 * semilattice — that is what "receivers apply deltas on arrival with no
 * ordering requirement" (02) buys, and what test/crdt.test.ts property-tests.
 */

export type CRDTType = "G_SET" | "LWW_REGISTER" | "OR_SET" | "OR_MAP";

/** The required envelope every `Update{afp:CRDTDelta}` activity carries (02). */
export interface CRDTDeltaEnvelope<TDelta = unknown> {
  hub: string; // afp:hub — required, non-negotiable per 02
  crdtId: string;
  crdtType: CRDTType;
  delta: TDelta;
}

// ---------------------------------------------------------------------------
// G-Set — vote receipts, set union.

export interface GSetDelta<T> {
  adds: T[];
}

export interface GSetState<T> {
  elements: T[];
}

// ---------------------------------------------------------------------------
// LWW-Register — {status, load, lastSeen}, highest timestamp wins, nodeId tiebreak.

export interface LivenessValue {
  status: string;
  load: number;
  lastSeen: string;
}

export interface LWWDelta<T> {
  value: T;
  timestamp: number;
  nodeId: string;
}

export interface LWWState<T> {
  value: T;
  timestamp: number;
  nodeId: string;
}

// ---------------------------------------------------------------------------
// OR-Set — add/remove-wins via unique tags + tombstones.

export interface ORSetAdd {
  element: string;
  tag: string;
}

export interface ORSetRemove {
  element: string;
  tombstoneTags: string[];
}

export interface ORSetDelta {
  adds: ORSetAdd[];
  removes: ORSetRemove[];
}

/** elementTags: element -> live add-tags seen. tombstones: element -> tags removed. */
export interface ORSetState {
  elementTags: Record<string, string[]>;
  tombstones: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// OR-Map — the capability registry (OR-Set fields) and, since ADR-0004, the
// asset registry (LWW-Register fields: assetId → whole asset record).

export interface ORMapORSetDelta {
  key: string;
  fieldType: "OR_SET";
  adds: ORSetAdd[];
  removes: ORSetRemove[];
}

export interface ORMapLWWDelta<T = unknown> {
  key: string;
  fieldType: "LWW_REGISTER";
  value: T;
  timestamp: number;
  nodeId: string;
}

export type ORMapDelta = ORMapORSetDelta | ORMapLWWDelta;

export interface ORMapState {
  entries: Record<string, ORSetState>;
  /** LWW-valued fields (ADR-0004 asset registry). Absent on pre-ADR-0004 states. */
  lwwEntries?: Record<string, LWWState<unknown>>;
}

export type AnyDelta = GSetDelta<unknown> | LWWDelta<unknown> | ORSetDelta | ORMapDelta;
export type AnyState = GSetState<unknown> | LWWState<unknown> | ORSetState | ORMapState;
