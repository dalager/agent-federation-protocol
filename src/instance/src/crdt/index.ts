/**
 * Public module surface for src/instance/src/crdt/ — the four hand-rolled
 * CRDT types from ADR-0002 Decision 2, plus the SQLite-backed store.
 *
 * Consumers (the hub/voting layer) should import from here rather than
 * reaching into individual files.
 */

export * from "./types.ts";
export { emptyGSet, mergeGSet, joinGSet } from "./gset.ts";
export { initialLWW, mergeLWW, joinLWW } from "./lww.ts";
export { emptyORSet, mergeORSet, joinORSet, liveElements, isMember } from "./orset.ts";
export { emptyORMap, mergeORMap, joinORMap, fieldOf, lwwFieldOf } from "./ormap.ts";
export { CRDTStore } from "./store.ts";
