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
import { serveHandler } from "../src/runtime/adapters/node.ts";
import { jsonResponse, readCappedBody, TOO_LARGE, type Handler } from "../src/runtime/httpPort.ts";
import { connect } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSecretFile } from "../src/config.ts";
import { nodeinfoDocument } from "../src/ap/nodeinfo.ts";
import { fileSecrets, useSecretLoader } from "../src/runtime/secrets.ts";
import { Schedule } from "../src/runtime/schedule.ts";
import { policedFetch } from "../src/federation/fetchPolicy.ts";
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

  it("G11: an oversized POST is answered 413 and the socket is closed, so the sender stops", async () => {
    // ADR-0025 Decision 4's other half: the 413 answers the sender, and
    // closing the socket is what stops it. Remove the `req.destroy()` in
    // `serveHandler` and this case fails in seconds — the connection stays
    // open on keep-alive with the body still arriving.
    //
    // What this case does NOT do is choose between the two conditions an
    // adapter could destroy on, and the measurements are worth recording
    // because both intuitions about them were wrong. Here `content-length`
    // exceeds the cap, so `readCappedBody` refuses before touching the
    // stream and `request.bodyUsed` is still **false** — meaning the
    // tempting `!request.bodyUsed` would also close, correctly. On a chunked
    // body the cap is only reached by reading, so `bodyUsed` is **true** and
    // `!bodyUsed` would not close — but node closes that one itself, so a
    // test of it would pass for a reason the adapter did not supply. The
    // explicit condition stays because "node cleans up after a mid-stream
    // refusal" is a property no hosted adapter inherits.
    const handler: Handler = async (request) => {
      const body = await readCappedBody(request, 64);
      return body === TOO_LARGE ? jsonResponse(413, { error: "payload too large" }) : jsonResponse(200, { ok: true });
    };
    const server = serveHandler(handler, "http://127.0.0.1");
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as { port: number };

    try {
      const { status, closed } = await new Promise<{ status: string; closed: boolean }>((resolve, reject) => {
        const socket = connect(port, "127.0.0.1", () => {
          socket.write(`POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 100000\r\nConnection: keep-alive\r\n\r\n`);
          socket.write("x".repeat(4096));
        });
        let received = "";
        socket.on("data", (chunk) => {
          received += String(chunk);
        });
        socket.on("close", () => resolve({ status: received.split("\r\n")[0], closed: true }));
        socket.on("error", reject);
        setTimeout(() => resolve({ status: received.split("\r\n")[0], closed: false }), 3000).unref();
      });

      assert.match(status, /^HTTP\/1\.1 413 /, "the cap answered");
      assert.ok(closed, "the server closed the connection — a keep-alive here leaves the sender still sending");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ------------------------------------------ WP-3, the schedule and the resolver

describe("ADR-0036 WP-3 — one alarm's worth of schedule", () => {
  const specs = [
    { name: "sweep" as const, intervalMs: 30_000, jitterMs: 0 },
    { name: "flush" as const, intervalMs: 10_000, jitterMs: 0 },
    { name: "converge" as const, intervalMs: 60_000, jitterMs: 0 },
    { name: "heartbeat" as const, intervalMs: 0, jitterMs: 0 },
  ];

  it("G12: a loop with interval 0 is off, and never becomes due", () => {
    const schedule = new Schedule(specs, 0);
    // Asserted through the only two methods a driver has, rather than by
    // reading the schedule's own state: heartbeat is configured at 0 and
    // never appears among the due loops, however far the clock is pushed.
    assert.deepEqual([...schedule.due(10_000_000)], ["sweep", "flush", "converge"], "heartbeat absent, as `start` never armed it");
    assert.deepEqual([...schedule.due(10_000_000_000)], ["sweep", "flush", "converge"], "and still absent much later");
  });

  it("G13: the alarm is the earliest next-due, and waking runs only what is due", () => {
    const schedule = new Schedule(specs, 0);
    assert.equal(schedule.dueAt(), 10_000, "flush is soonest at its 10s default");

    assert.deepEqual([...schedule.due(10_000)], ["flush"], "only flush at 10s");
    assert.equal(schedule.dueAt(), 20_000, "re-armed; flush is soonest again");

    assert.deepEqual([...schedule.due(20_000)], ["flush"]);
    assert.deepEqual([...schedule.due(30_000)], ["sweep", "flush"], "both, in declaration order");
    assert.deepEqual([...schedule.due(60_000)], ["sweep", "flush", "converge"], "all three coincide at a minute");
  });

  it("G14: a slept-through actor runs each due loop once, not once per interval missed", () => {
    // Eviction is normal under the hosted profile (Decision 4), so waking an
    // hour late must not mean 360 flushes. The loops are idempotent, so the
    // backlog lives in the work they find, not in the count of calls.
    const schedule = new Schedule(specs, 0);
    assert.deepEqual([...schedule.due(3_600_000)], ["sweep", "flush", "converge"], "one of each");
    // Re-armed from the wake, not from the missed slot: nothing is due one
    // millisecond short of a fresh flush interval after it.
    assert.deepEqual([...schedule.due(3_609_999)], [], "no catch-up backlog queued behind the wake");
    assert.deepEqual([...schedule.due(3_610_000)], ["flush"], "the next flush is one interval after waking");
  });

  it("G15: jitter is drawn once per loop and the period is kept, exactly as setInterval does", () => {
    const drawn: number[] = [];
    let n = 0;
    const jitter = (ms: number) => {
      const value = ms === 0 ? 0 : (n += 100);
      drawn.push(value);
      return value;
    };
    const schedule = new Schedule([{ name: "flush", intervalMs: 1_000, jitterMs: 500 }], 0, jitter);
    assert.deepEqual([...schedule.due(1_099)], [], "the draw pushed it past the bare interval");
    assert.deepEqual([...schedule.due(1_100)], ["flush"], "due at interval plus the draw");
    // The same period again, not a fresh draw: 1_100 + 1_100, because
    // `setInterval(fn, interval + jitter)` draws once and repeats.
    assert.deepEqual([...schedule.due(2_199)], [], "not yet");
    assert.deepEqual([...schedule.due(2_200)], ["flush"], "one period later, the same period");
    assert.deepEqual(drawn, [100], "exactly one draw, at construction — the node driver's rule");
  });

  it("G16: the resolver is a seam — the platform-enforced answer is honoured, not silently skipped", async () => {
    // ADR-0025 D2's own case still refuses: a hostname resolving into a
    // private range is an SSRF refusal under the node resolver.
    await assert.rejects(
      () => policedFetch("https://private.test/doc", { kind: "document" }, { devMode: false, resolve: async () => ({ kind: "address", address: "127.0.0.1" }) }),
      /private\/loopback\/link-local/,
      "the check still runs and still refuses",
    );

    // The hosted answer: no resolution to judge, because the platform's
    // egress cannot reach one. The address check passes and the fetch fails
    // later, on the network — not here, and not silently.
    await assert.rejects(
      () => policedFetch("https://unreachable.invalid/doc", { kind: "document" }, { devMode: false, resolve: async () => ({ kind: "platform-enforced" }) }),
      (error: Error) => !/private\/loopback\/link-local/.test(error.message),
      "platform-enforced skips the address judgement, and fails for some other reason instead",
    );
  });
});

// ------------------------------------------------- WP-4, secrets as bindings

describe("ADR-0036 WP-4 — a secret is a reference, and the profile resolves it", () => {
  it("G17: the file loader is the default, and an empty or missing file reads as absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "afp-secret-"));
    const present = join(dir, "pass");
    const empty = join(dir, "empty");
    writeFileSync(present, "  hunter2\n");
    writeFileSync(empty, "   \n");

    assert.equal(readSecretFile(present), "hunter2", "trimmed");
    assert.equal(readSecretFile(empty), undefined, "an empty file is absent, not the empty secret");
    assert.equal(readSecretFile(join(dir, "nope")), undefined, "a missing file is absent");
    assert.equal(readSecretFile(""), undefined, "an unset reference is absent");
    rmSync(dir, { recursive: true, force: true });
  });

  it("G18: a profile's loader replaces the file read, and resolves the same references", () => {
    // What a hosted adapter does: the schema still says AFP_*_FILE and still
    // carries a reference, but the reference names a binding rather than a
    // path, and nothing touches a filesystem.
    const bindings: Record<string, string> = { "kms://passphrase": "from-the-platform", "kms://blank": "  " };
    try {
      useSecretLoader((reference) => {
        const value = bindings[reference];
        return value !== undefined && value.trim().length > 0 ? value.trim() : undefined;
      });

      assert.equal(readSecretFile("kms://passphrase"), "from-the-platform", "resolved through the binding");
      assert.equal(readSecretFile("kms://blank"), undefined, "an empty binding is absent, exactly as an empty file is");
      assert.equal(readSecretFile("/etc/afp/passphrase"), undefined, "a path means nothing to this profile, and is not read from disk");
    } finally {
      useSecretLoader(fileSecrets);
    }

    // Restored: the default loader is the file one, so no other case in this
    // suite inherits the hosted profile's answers.
    const dir = mkdtempSync(join(tmpdir(), "afp-secret-"));
    const path = join(dir, "pass");
    writeFileSync(path, "back-to-files");
    assert.equal(readSecretFile(path), "back-to-files");
    rmSync(dir, { recursive: true, force: true });
  });
});

// -------------------------------- WP-5 (part), the profile the record names

describe("ADR-0036 WP-5 — an instance says which profile it runs", () => {
  it("G19: AFP_PROFILE defaults to self-hosted and refuses anything it does not know", () => {
    assert.equal(loadConfig({ ...workspace() }).profile, "self-hosted", "the reference profile is the default");
    assert.equal(loadConfig({ ...workspace(), profile: "hosted" }).profile, "hosted");

    const previous = process.env.AFP_PROFILE;
    try {
      process.env.AFP_PROFILE = "serverless";
      assert.throws(() => loadConfig({ ...workspace() }), /AFP_PROFILE must be/, "refused at load, not discovered later");
    } finally {
      if (previous === undefined) delete process.env.AFP_PROFILE;
      else process.env.AFP_PROFILE = previous;
    }
  });

  it("G20: NodeInfo publishes the profile, so a counterparty reads it without asking", () => {
    // ADR-0036 Decision 10 says to record this in the policy document's
    // `afp:terms`. It cannot go there: `afp:terms` is a {url, digest} pair
    // pointing at an external document (ap/policy.ts), not a place to put a
    // machine-readable fact. NodeInfo's metadata block is free-form and
    // already carries `afp:specRevision`, so the profile sits beside it and
    // needs no new AFP vocabulary.
    const selfHosted = nodeinfoDocument(2) as { metadata: { afp: { profile: string } } };
    assert.equal(selfHosted.metadata.afp.profile, "self-hosted", "the default is explicit on the wire, not implied by absence");

    const hosted = nodeinfoDocument(2, "hosted") as { metadata: { afp: { profile: string } } };
    assert.equal(hosted.metadata.afp.profile, "hosted");
  });
});
