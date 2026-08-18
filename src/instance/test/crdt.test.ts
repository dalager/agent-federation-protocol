/**
 * P2 CRDT gate — property tests proving each of the four hand-rolled merges
 * (ADR-0002 Decision 2) is commutative, associative, and idempotent, plus the
 * OR-Set tombstone/re-add semantics and LWW tiebreak determinism 02 requires.
 *
 *   node --experimental-sqlite --test test/crdt.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { canonicalize } from "../src/crypto/jcs.ts";
import { openDb } from "../src/store/db.ts";
import {
  CRDTStore,
  emptyGSet,
  emptyORMap,
  emptyORSet,
  fieldOf,
  isMember,
  joinGSet,
  joinLWW,
  joinORMap,
  joinORSet,
  liveElements,
  mergeGSet,
  mergeLWW,
  mergeORMap,
  mergeORSet,
} from "../src/crdt/index.ts";
import type {
  CRDTDeltaEnvelope,
  GSetState,
  LWWState,
  ORMapDelta,
  ORMapState,
  ORSetDelta,
  ORSetState,
} from "../src/crdt/types.ts";

/** Canonical form for a G-Set state independent of internal element order. */
function canonicalGSet<T>(state: GSetState<T>): string {
  const sorted = [...state.elements].map((e) => canonicalize(e as any)).sort();
  return JSON.stringify(sorted);
}

function shuffled<T>(items: T[], seed: number): T[] {
  const arr = [...items];
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------------------------------------------------------------------------
// G-Set: commutative, associative, idempotent set union.

describe("G-Set", () => {
  const receipts = [
    { voteId: "v1", weight: 1 },
    { voteId: "v2", weight: 1 },
    { voteId: "v3", weight: 1 },
  ];

  it("merge is commutative under randomized delta order", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const orderA = shuffled(receipts, seed);
      const orderB = shuffled(receipts, seed + 1000);

      let stateA: GSetState<(typeof receipts)[number]> = emptyGSet();
      for (const r of orderA) stateA = mergeGSet(stateA, { adds: [r] });

      let stateB: GSetState<(typeof receipts)[number]> = emptyGSet();
      for (const r of orderB) stateB = mergeGSet(stateB, { adds: [r] });

      assert.equal(canonicalGSet(stateA), canonicalGSet(stateB));
    }
  });

  it("merge is associative: (a join b) join c == a join (b join c)", () => {
    const a: GSetState<{ voteId: string }> = { elements: [{ voteId: "v1" }] };
    const b: GSetState<{ voteId: string }> = { elements: [{ voteId: "v2" }] };
    const c: GSetState<{ voteId: string }> = { elements: [{ voteId: "v3" }] };

    const left = joinGSet(joinGSet(a, b), c);
    const right = joinGSet(a, joinGSet(b, c));
    assert.equal(canonicalGSet(left), canonicalGSet(right));
  });

  it("merge is idempotent: merging the same delta twice changes nothing", () => {
    let state: GSetState<{ voteId: string }> = emptyGSet();
    state = mergeGSet(state, { adds: [{ voteId: "v1" }] });
    const once = canonicalGSet(state);
    state = mergeGSet(state, { adds: [{ voteId: "v1" }] });
    assert.equal(canonicalGSet(state), once);
  });

  it("a missing vote is detectable from the receipt set alone", () => {
    let state: GSetState<{ voteId: string }> = emptyGSet();
    state = mergeGSet(state, { adds: [{ voteId: "v1" }, { voteId: "v2" }] });
    const ids = state.elements.map((e) => e.voteId);
    assert.ok(!ids.includes("v3"));
  });
});

// ---------------------------------------------------------------------------
// LWW-Register: highest timestamp wins, nodeId tiebreak.

describe("LWW-Register", () => {
  function deltas() {
    return [
      { value: { status: "up", load: 1, lastSeen: "t1" }, timestamp: 10, nodeId: "node-a" },
      { value: { status: "up", load: 2, lastSeen: "t2" }, timestamp: 20, nodeId: "node-b" },
      { value: { status: "down", load: 0, lastSeen: "t3" }, timestamp: 20, nodeId: "node-a" },
    ];
  }

  it("merge is commutative under randomized order", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const orderA = shuffled(deltas(), seed);
      const orderB = shuffled(deltas(), seed + 1000);

      let stateA: LWWState<any> | null = null;
      for (const d of orderA) stateA = mergeLWW(stateA, d);

      let stateB: LWWState<any> | null = null;
      for (const d of orderB) stateB = mergeLWW(stateB, d);

      assert.equal(canonicalize(stateA as any), canonicalize(stateB as any));
    }
  });

  it("merge is associative", () => {
    const [d1, d2, d3] = deltas();
    const s1: LWWState<any> = { value: d1.value, timestamp: d1.timestamp, nodeId: d1.nodeId };
    const s2: LWWState<any> = { value: d2.value, timestamp: d2.timestamp, nodeId: d2.nodeId };
    const s3: LWWState<any> = { value: d3.value, timestamp: d3.timestamp, nodeId: d3.nodeId };

    const left = joinLWW(joinLWW(s1, s2), s3);
    const right = joinLWW(s1, joinLWW(s2, s3));
    assert.equal(canonicalize(left as any), canonicalize(right as any));
  });

  it("merge is idempotent", () => {
    const d = deltas()[0];
    const once = mergeLWW(null, d);
    const twice = mergeLWW(once, d);
    assert.equal(canonicalize(once as any), canonicalize(twice as any));
  });

  it("tiebreak is deterministic: equal timestamps resolve by nodeId", () => {
    const base = mergeLWW(null, { value: { status: "up" }, timestamp: 20, nodeId: "node-a" });
    const tied = mergeLWW(base, { value: { status: "down" }, timestamp: 20, nodeId: "node-b" });
    // "node-b" > "node-a" lexicographically, so it wins the tie.
    assert.deepEqual(tied.value, { status: "down" });
    assert.equal(tied.nodeId, "node-b");

    const reverseOrder = mergeLWW(
      mergeLWW(null, { value: { status: "down" }, timestamp: 20, nodeId: "node-b" }),
      { value: { status: "up" }, timestamp: 20, nodeId: "node-a" },
    );
    // Same winner regardless of arrival order.
    assert.equal(reverseOrder.nodeId, "node-b");
  });

  it("a strictly higher timestamp always wins over a tie candidate", () => {
    const s1 = mergeLWW(null, { value: { status: "up" }, timestamp: 20, nodeId: "node-z" });
    const s2 = mergeLWW(s1, { value: { status: "down" }, timestamp: 21, nodeId: "node-a" });
    assert.equal(s2.timestamp, 21);
    assert.deepEqual(s2.value, { status: "down" });
  });
});

// ---------------------------------------------------------------------------
// OR-Set: add/remove-wins via tags + tombstones.

describe("OR-Set", () => {
  function opDeltas(): ORSetDelta[] {
    return [
      { adds: [{ element: "agent-1", tag: "a1-1-1" }], removes: [] },
      { adds: [{ element: "agent-2", tag: "a2-1-1" }], removes: [] },
      { adds: [], removes: [{ element: "agent-1", tombstoneTags: ["a1-1-1"] }] },
    ];
  }

  it("merge is commutative under randomized delta order", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const orderA = shuffled(opDeltas(), seed);
      const orderB = shuffled(opDeltas(), seed + 1000);

      let stateA: ORSetState = emptyORSet();
      for (const d of orderA) stateA = mergeORSet(stateA, d);

      let stateB: ORSetState = emptyORSet();
      for (const d of orderB) stateB = mergeORSet(stateB, d);

      assert.equal(canonicalize(stateA as any), canonicalize(stateB as any));
      assert.deepEqual(liveElements(stateA), liveElements(stateB));
    }
  });

  it("merge is associative", () => {
    const [d1, d2, d3] = opDeltas();
    const s1 = mergeORSet(emptyORSet(), d1);
    const s2 = mergeORSet(emptyORSet(), d2);
    const s3 = mergeORSet(emptyORSet(), d3);

    const left = joinORSet(joinORSet(s1, s2), s3);
    const right = joinORSet(s1, joinORSet(s2, s3));
    assert.equal(canonicalize(left as any), canonicalize(right as any));
  });

  it("merge is idempotent", () => {
    const d = opDeltas()[0];
    const once = mergeORSet(emptyORSet(), d);
    const twice = mergeORSet(once, d);
    assert.equal(canonicalize(once as any), canonicalize(twice as any));
  });

  it("tombstone/re-add: removing then re-adding with a fresh tag restores membership", () => {
    let state = emptyORSet();
    state = mergeORSet(state, { adds: [{ element: "agent-1", tag: "t1" }], removes: [] });
    assert.ok(isMember(state, "agent-1"));

    state = mergeORSet(state, { adds: [], removes: [{ element: "agent-1", tombstoneTags: ["t1"] }] });
    assert.ok(!isMember(state, "agent-1"));

    state = mergeORSet(state, { adds: [{ element: "agent-1", tag: "t2" }], removes: [] });
    assert.ok(isMember(state, "agent-1"), "re-add with a new tag must restore membership");
  });

  it("a stale remove (old tag) never un-adds a later fresh tag, regardless of arrival order", () => {
    const add1: ORSetDelta = { adds: [{ element: "agent-1", tag: "t1" }], removes: [] };
    const remove1: ORSetDelta = { adds: [], removes: [{ element: "agent-1", tombstoneTags: ["t1"] }] };
    const add2: ORSetDelta = { adds: [{ element: "agent-1", tag: "t2" }], removes: [] };

    // Deliver remove1 (tombstoning t1) *after* add2 arrives — concurrent/out-of-order delivery.
    let state = emptyORSet();
    for (const d of [add1, add2, remove1]) state = mergeORSet(state, d);
    assert.ok(isMember(state, "agent-1"), "t2 must still be live; the tombstone only covers t1");
  });
});

// ---------------------------------------------------------------------------
// OR-Map<key, OR-Set<capability>>: capability registry.

describe("OR-Map", () => {
  function opDeltas(): ORMapDelta[] {
    return [
      { key: "agent-1", fieldType: "OR_SET", adds: [{ element: "cap:vision", tag: "a-1" }], removes: [] },
      { key: "agent-2", fieldType: "OR_SET", adds: [{ element: "cap:nlp", tag: "b-1" }], removes: [] },
      {
        key: "agent-1",
        fieldType: "OR_SET",
        adds: [],
        removes: [{ element: "cap:vision", tombstoneTags: ["a-1"] }],
      },
    ];
  }

  it("merge is commutative under randomized delta order", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const orderA = shuffled(opDeltas(), seed);
      const orderB = shuffled(opDeltas(), seed + 1000);

      let stateA: ORMapState = emptyORMap();
      for (const d of orderA) stateA = mergeORMap(stateA, d);

      let stateB: ORMapState = emptyORMap();
      for (const d of orderB) stateB = mergeORMap(stateB, d);

      assert.equal(canonicalize(stateA as any), canonicalize(stateB as any));
    }
  });

  it("merge is associative", () => {
    const [d1, d2, d3] = opDeltas();
    const s1 = mergeORMap(emptyORMap(), d1);
    const s2 = mergeORMap(emptyORMap(), d2);
    const s3 = mergeORMap(emptyORMap(), d3);

    const left = joinORMap(joinORMap(s1, s2), s3);
    const right = joinORMap(s1, joinORMap(s2, s3));
    assert.equal(canonicalize(left as any), canonicalize(right as any));
  });

  it("merge is idempotent", () => {
    const d = opDeltas()[0];
    const once = mergeORMap(emptyORMap(), d);
    const twice = mergeORMap(once, d);
    assert.equal(canonicalize(once as any), canonicalize(twice as any));
  });

  it("populated by afp:Enroll-shaped deltas: capability removal is per-key tombstoning", () => {
    let state = emptyORMap();
    for (const d of opDeltas()) state = mergeORMap(state, d);
    assert.deepEqual(liveElements(fieldOf(state, "agent-1")), []);
    assert.deepEqual(liveElements(fieldOf(state, "agent-2")), ["cap:nlp"]);
  });
});

// ---------------------------------------------------------------------------
// SQLite-backed store: persistence + version vector.

describe("CRDTStore", () => {
  it("persists merged state and is queryable by (hubId, crdtId)", () => {
    const db = openDb(":memory:");
    const store = new CRDTStore(db);
    const hub = "https://hub.example/actor";

    const envelope: CRDTDeltaEnvelope = {
      hub,
      crdtId: "vote-receipts",
      crdtType: "G_SET",
      delta: { adds: [{ voteId: "v1" }] },
    };
    store.apply(envelope, "https://alpha.example/agents/a1");
    store.apply(
      { ...envelope, delta: { adds: [{ voteId: "v2" }] } },
      "https://alpha.example/agents/a2",
    );

    const state = store.getState(hub, "vote-receipts") as GSetState<{ voteId: string }>;
    assert.deepEqual(
      state.elements.map((e) => e.voteId).sort(),
      ["v1", "v2"],
    );
  });

  it("maintains a per-store version vector on every write, queryable as a SELECT", () => {
    const db = openDb(":memory:");
    const store = new CRDTStore(db);
    const hub = "https://hub.example/actor";
    const envelope: CRDTDeltaEnvelope = {
      hub,
      crdtId: "vote-receipts",
      crdtType: "G_SET",
      delta: { adds: [{ voteId: "v1" }] },
    };

    store.apply(envelope, "https://alpha.example/agents/a1");
    store.apply(envelope, "https://alpha.example/agents/a1"); // duplicate delivery
    store.apply(
      { ...envelope, delta: { adds: [{ voteId: "v2" }] } },
      "https://alpha.example/agents/a2",
    );

    const vv = store.versionVector(hub, "vote-receipts");
    assert.equal(vv["https://alpha.example/agents/a1"], 2);
    assert.equal(vv["https://alpha.example/agents/a2"], 1);
  });

  it("keeps state independent across different hubs sharing a crdtId", () => {
    const db = openDb(":memory:");
    const store = new CRDTStore(db);

    store.apply(
      { hub: "hub-a", crdtId: "membership", crdtType: "OR_SET", delta: { adds: [{ element: "agent-1", tag: "t1" }], removes: [] } },
      "actor-1",
    );
    store.apply(
      { hub: "hub-b", crdtId: "membership", crdtType: "OR_SET", delta: { adds: [], removes: [] } },
      "actor-2",
    );

    const a = store.getState("hub-a", "membership") as ORSetState;
    const b = store.getState("hub-b", "membership") as ORSetState;
    assert.deepEqual(liveElements(a), ["agent-1"]);
    assert.deepEqual(liveElements(b), []);
  });
});
