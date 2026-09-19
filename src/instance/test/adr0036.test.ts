/**
 * ADR-0036 gate — WP-1, the store port.
 *
 * The ADR's own gate for WP-1 is "every existing test passes against the
 * `node` adapters with no case changed", and the suite is that proof. These
 * cases cover what the suite cannot: the port's contract as a contract,
 * including the one verb — `transaction` — that the codebase declares and
 * does not yet call. An unused verb that ships untested is the part of a
 * port most likely to be wrong when its second adapter arrives and the
 * first thing that adapter copies is the first adapter's behaviour.
 *
 *   node --test test/adr0036.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openNodeStore } from "../src/store/adapters/node.ts";
import type { Store } from "../src/store/port.ts";
import { AfpInstance } from "../src/instance.ts";
import { loadConfig } from "../src/config.ts";
import { createHandler } from "../src/ap/server.ts";
import { workspace } from "./helpers.ts";

/** A row with its prototype normalised — see the port's note on row shape. */
function plain(row: unknown): unknown {
  return row === undefined ? undefined : { ...(row as object) };
}

function scratch(): Store {
  const store = openNodeStore(":memory:");
  store.exec("CREATE TABLE t (k TEXT PRIMARY KEY, v INTEGER)");
  return store;
}

describe("ADR-0036 WP-1 — the store port's contract", () => {
  it("G1: the four verbs round-trip bound parameters, and `get` of nothing is undefined", () => {
    const db = scratch();
    const result = db.run("INSERT INTO t (k, v) VALUES (?, ?)", "a", 1);
    assert.equal(Number(result.changes), 1);
    db.run("INSERT INTO t (k, v) VALUES (?, ?)", "b", 2);

    assert.deepEqual(plain(db.get("SELECT v FROM t WHERE k = ?", "a")), { v: 1 });
    assert.equal(db.get("SELECT v FROM t WHERE k = ?", "nope"), undefined, "no row is undefined, never null");
    assert.deepEqual(db.all("SELECT k FROM t ORDER BY k").map(plain), [{ k: "a" }, { k: "b" }]);
    db.close();
  });

  it("G2: a transaction commits on return and rolls back whole on throw", () => {
    const db = scratch();
    db.transaction(() => {
      db.run("INSERT INTO t (k, v) VALUES (?, ?)", "committed", 1);
    });
    assert.deepEqual(plain(db.get("SELECT v FROM t WHERE k = ?", "committed")), { v: 1 });

    assert.throws(
      () =>
        db.transaction(() => {
          db.run("INSERT INTO t (k, v) VALUES (?, ?)", "first", 1);
          db.run("INSERT INTO t (k, v) VALUES (?, ?)", "second", 2);
          throw new Error("boom");
        }),
      /boom/,
    );
    assert.equal(db.get("SELECT v FROM t WHERE k = ?", "first"), undefined, "the whole transaction rolled back");
    assert.equal(db.get("SELECT v FROM t WHERE k = ?", "second"), undefined);

    // The store is still usable after a rollback — a failed transaction must
    // not leave the connection inside an open one.
    db.run("INSERT INTO t (k, v) VALUES (?, ?)", "after", 3);
    assert.deepEqual(plain(db.get("SELECT v FROM t WHERE k = ?", "after")), { v: 3 });
    db.close();
  });

  it("G3: nesting reuses the outer transaction — an inner throw caught outside still rolls the outer back", () => {
    const db = scratch();
    assert.throws(() => {
      db.transaction(() => {
        db.run("INSERT INTO t (k, v) VALUES (?, ?)", "outer", 1);
        db.transaction(() => {
          db.run("INSERT INTO t (k, v) VALUES (?, ?)", "inner", 2);
        });
        throw new Error("outer fails after the inner returned");
      });
    }, /outer fails/);
    assert.equal(db.get("SELECT v FROM t WHERE k = ?", "inner"), undefined, "the inner is not independently committed");
    assert.equal(db.get("SELECT v FROM t WHERE k = ?", "outer"), undefined);
    db.close();
  });

  it("G4: `exec` invalidates the statement cache, so DDL under a live store is visible to later reads", () => {
    const db = scratch();
    db.run("INSERT INTO t (k, v) VALUES (?, ?)", "a", 1);
    assert.deepEqual(db.all("SELECT * FROM t").map(plain), [{ k: "a", v: 1 }]);

    // The same SQL text, over a reshaped table: a cached statement would
    // answer with the old column set, which is the bug the cache-clear in
    // `exec` exists to prevent. Migrations are exactly this case.
    db.exec("ALTER TABLE t ADD COLUMN note TEXT");
    assert.deepEqual(db.all("SELECT * FROM t").map(plain), [{ k: "a", v: 1, note: null }]);
    db.close();
  });

  it("G6: a row's prototype is unspecified, and the node adapter's is null — the port says so", () => {
    const db = scratch();
    db.run("INSERT INTO t (k, v) VALUES (?, ?)", "a", 1);
    const row = db.get("SELECT * FROM t") as object;
    assert.equal(Object.getPrototypeOf(row), null, "node:sqlite's own row shape, not normalised by the adapter");
    assert.equal((row as { k: string }).k, "a", "column access is all a consumer may do with it");
    db.close();
  });

  it("G7: the statement cache is bounded by the code's SQL texts, not by the data's shape", () => {
    // The cache never evicts, so it is safe only while the set of SQL texts
    // a path can produce is finite. WP-1's review found `queue.ts`'s
    // `ready()` building `IN (?,?,…)` from the pending-target count on the
    // delivery loop's polling call — one retained prepared statement per
    // distinct cardinality ever seen. The SQL there is static now; this is
    // what notices if it, or anything like it, comes back.
    const db = openNodeStore(":memory:") as Store & { preparedCount: number };
    db.exec("CREATE TABLE peers (target TEXT PRIMARY KEY)");

    const readWith = (n: number) => {
      for (let i = 0; i < n; i++) db.run("INSERT OR IGNORE INTO peers (target) VALUES (?)", `peer-${i}`);
      db.all("SELECT target FROM peers");
      return db.preparedCount;
    };

    // The invariant, not a magic number: growing the data twentyfold must
    // not grow the cache at all, because the SQL texts are the same two.
    const small = readWith(1);
    assert.equal(readWith(20), small, "cache size tracks the code's SQL texts, never the row count");
    db.close();
  });

  it("G5: no runtime type crosses the port — the interface names only SQL, bound values and rows", () => {
    // The port is structural, so this is a compile-time property the suite
    // cannot assert directly; what it can assert is the observable half —
    // a `Store` consumer never receives a statement, cursor or handle back.
    const db = scratch();
    const returned: unknown[] = [db.run("INSERT INTO t (k, v) VALUES (?, ?)", "a", 1), db.get("SELECT 1 AS n"), db.all("SELECT 1 AS n")];
    for (const value of returned) {
      assert.ok(
        value === undefined || typeof value === "object",
        "every port answer is a plain row, array or result record",
      );
      assert.equal(typeof (value as { prepare?: unknown })?.prepare, "undefined", "no statement-bearing handle crosses the port");
    }
    db.close();
  });
});

// ------------------------------------------------- WP-2, the request port

describe("ADR-0036 WP-2 — the request port's contract", () => {
  it("G8: the handler answers a standard Request with a standard Response, no server involved", async () => {
    const paths = workspace();
    const instance = new AfpInstance(loadConfig({ ...paths }), []);
    try {
      const handler = createHandler(instance);
      const response = await handler(new Request(`${instance.config.origin}/actor`), { address: "203.0.113.7" });

      assert.ok(response instanceof Response, "a Response, not a written socket");
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /activity\+json/);
      const actor = (await response.json()) as { id: string };
      assert.equal(actor.id, String(instance.instanceDocument().id));
    } finally {
      instance.close();
    }
  });

  it("G9: the peer address is a parameter, not a header — a client cannot forge its own bucket", async () => {
    const paths = workspace();
    // A limit of one, so the second request from the same peer is refused.
    const instance = new AfpInstance(loadConfig({ ...paths, rateLimitPerAddress: 1, rateLimitPerAddressWindowMs: 60_000 }), []);
    try {
      const handler = createHandler(instance);
      const get = (address: string, headers: HeadersInit = {}) =>
        handler(new Request(`${instance.config.origin}/actor`, { headers }), { address });

      assert.equal((await get("198.51.100.1")).status, 200, "first from this peer");
      assert.equal((await get("198.51.100.1")).status, 429, "second from the same peer is bucketed");

      // The same peer, now claiming to be someone else in every header a
      // proxy-trusting implementation would have believed. The bucket is
      // keyed on the adapter's parameter, so none of it moves the answer.
      const forged = await get("198.51.100.1", {
        "x-forwarded-for": "203.0.113.9",
        "x-real-ip": "203.0.113.9",
        forwarded: "for=203.0.113.9",
      });
      assert.equal(forged.status, 429, "headers cannot buy a fresh bucket");

      assert.equal((await get("198.51.100.2")).status, 200, "a genuinely different peer has its own");
    } finally {
      instance.close();
    }
  });

  it("G10: an oversized body is refused before it is buffered, and the stream is left unread", async () => {
    const paths = workspace();
    const cap = 512;
    const instance = new AfpInstance(loadConfig({ ...paths, maxInboxBodyBytes: cap }), []);
    try {
      const handler = createHandler(instance, { inbox: { verify: async () => null } as never });

      let produced = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          produced += 1;
          // Far past the cap in total; the reader should stop asking long
          // before this runs enough times to hold it all in memory.
          if (produced > 100) {
            controller.close();
            return;
          }
          controller.enqueue(new Uint8Array(256));
        },
      });

      const response = await handler(
        new Request(`${instance.config.origin}/actor/inbox`, {
          method: "POST",
          body,
          headers: { host: "alpha.operator.local" },
          // @ts-expect-error — Node requires this for a streamed request body
          duplex: "half",
        }),
        { address: "203.0.113.20" },
      );

      assert.equal(response.status, 413);
      assert.deepEqual(await response.json(), { error: "payload too large" });
      assert.ok(produced < 100, `the producer was stopped early, at ${produced} chunks — refused, not buffered`);
    } finally {
      instance.close();
    }
  });
});
