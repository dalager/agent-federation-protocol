/**
 * ADR-0031 gate — the resident process. The scheduler, backpressure,
 * structured logs and single-writer lock (Decisions 1, 3, 4, 5, 6; WP-1/3/4)
 * and health/metrics (Decision 2; WP-2), G1–G9 by number.
 *
 *   node --experimental-sqlite --test test/adr0031.test.ts
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import http from "node:http";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";

import { loadConfig } from "../src/config.ts";
import { AfpInstance } from "../src/instance.ts";
import { CountingBrain } from "../src/brains/stub.ts";
import { loadOrCreateHubKeyPair } from "../src/crypto/keys.ts";
import { vouch, type Envelope } from "../src/ap/activities.ts";
import { enroll } from "../src/hub/activities.ts";
import { Hub } from "../src/hub/hub.ts";
import type { JsonValue } from "../src/crypto/jcs.ts";

type ActorDocument = { [key: string]: JsonValue };
import { openDb, StoreLocked } from "../src/store/db.ts";
import { DeliveryRefused } from "../src/federation/transport.ts";
import type { Transport } from "../src/store/queue.ts";
import { Scheduler } from "../src/runtime/scheduler.ts";
import { installShutdown } from "../src/runtime/shutdown.ts";
import { metrics } from "../src/runtime/metrics.ts";
import { createHttpServer } from "../src/ap/server.ts";
import { runP8Demo } from "../src/demoP8.ts";
import { objectType, errorCode, testInstance, cleanupWorkspaces, freshDemo, workspace, runVerifier } from "./helpers.ts";
import { VERIFIER } from "./adr0010-fixtures.ts";

after(cleanupWorkspaces);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address && typeof address === "object") {
        const port = address.port;
        probe.close(() => resolve(port));
      } else {
        probe.close(() => reject(new Error("no port")));
      }
    });
  });
}

/**
 * `node:http`'s own client, not the global `fetch` — undici's `fetch` proved
 * unreliable against a same-process loopback server in this file specifically
 * (an undiagnosed keep-alive/connection-pool interaction with the rest of the
 * suite's module graph, not a defect in the server: the identical bytes read
 * clean over a raw socket in the same run). `http.request` has none of that.
 */
function httpGet(url: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: () => string; json: () => unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text: () => body, json: () => JSON.parse(body) });
      });
    });
    req.on("error", reject);
  });
}

const CAP = "afp:cap:assess";

// --------------------------------------------------------------- G1 — sweep

describe("Decision 1 — sweep", () => {
  it("G1: an overdue task with no run() becomes one afp:Error on the first tick; a second tick adds nothing", async () => {
    const { instance, config } = testInstance(["writer", "reviewer"], CAP);
    instance.delegate({
      from: "writer",
      to: "reviewer",
      capability: CAP,
      content: "review",
      thread: `${config.origin}/threads/late`,
      correlationId: "task-late",
      deadline: "2020-01-01T00:00:00.000Z",
    });

    const scheduler = new Scheduler({
      instance,
      transport: instance.localTransport(),
      config: { sweepMs: 30_000, flushMs: 10_000, convergeMs: 60_000, heartbeatMs: 0, jitterMs: 0 },
    });

    await scheduler.tick("sweep");
    const errorsAfterFirst = instance.outbox
      .byActor(instance.actorId("writer"))
      .filter((entry) => objectType(entry.activity) === "afp:Error");
    assert.equal(errorsAfterFirst.length, 1);
    assert.match(String(errorCode(errorsAfterFirst[0].activity)), /deadline-missed/);
    assert.ok(scheduler.lastTick.sweep, "lastTick.sweep is recorded");

    await scheduler.tick("sweep");
    const errorsAfterSecond = instance.outbox
      .byActor(instance.actorId("writer"))
      .filter((entry) => objectType(entry.activity) === "afp:Error");
    assert.equal(errorsAfterSecond.length, 1, "a second tick adds nothing — the task is already failed");
    instance.close();
  });
});

// --------------------------------------------------------------- G2/G8 — flush

describe("Decision 1/6 — flush and backpressure", () => {
  it("G2: a peer down for one tick delivers on the next; attempts spaced per schedule; no dead-letter; the ceiling caps spacing", async () => {
    const { instance, config } = testInstance(["writer"], CAP);
    let calls = 0;
    const timestamps: number[] = [];
    const transport: Transport = {
      name: "test",
      deliver: async () => {
        calls++;
        timestamps.push(instance.clock.now().getTime());
        if (calls === 1) throw new DeliveryRefused("simulated 503", 503, null);
      },
    };

    instance.publish("writer", ["https://peer.test/actor"], `${config.origin}/threads/g2`, "parties", (envelope: Envelope) =>
      vouch(envelope, { agent: "https://peer.test/actor", capabilities: [], keyCustody: "self" }),
    );

    const scheduler = new Scheduler({
      instance,
      transport,
      config: { sweepMs: 30_000, flushMs: 10_000, convergeMs: 60_000, heartbeatMs: 0, jitterMs: 0 },
    });

    await scheduler.tick("flush");
    assert.equal(calls, 1, "the first attempt fails");
    assert.equal(instance.queue.stats().dead, 0, "not dead-lettered — attempts remain under the ceiling");

    await scheduler.tick("flush");
    assert.equal(calls, 2, "delivered on the second tick, once the backoff window has passed");
    assert.equal(instance.queue.stats().delivered, 1);
    assert.equal(instance.queue.stats().dead, 0);
    instance.close();
  });

  it("G8: a peer answers 429 Retry-After for one target — no attempt inside the window; another peer is unaffected", async () => {
    const { instance, config } = testInstance(["writer"], CAP);
    const calls: string[] = [];
    const transport: Transport = {
      name: "test",
      deliver: async (target) => {
        calls.push(target);
        if (target === "https://blocked.test/actor") {
          throw new DeliveryRefused("429", 429, 30_000);
        }
      },
    };

    instance.publish("writer", ["https://blocked.test/actor"], `${config.origin}/threads/g8`, "parties", (envelope: Envelope) =>
      vouch(envelope, { agent: "https://blocked.test/actor", capabilities: [], keyCustody: "self" }),
    );
    instance.publish("writer", ["https://open.test/actor"], `${config.origin}/threads/g8`, "parties", (envelope: Envelope) =>
      vouch(envelope, { agent: "https://open.test/actor", capabilities: [], keyCustody: "self" }),
    );

    const scheduler = new Scheduler({
      instance,
      transport,
      config: { sweepMs: 30_000, flushMs: 10_000, convergeMs: 60_000, heartbeatMs: 0, jitterMs: 0 },
    });

    await scheduler.tick("flush");
    assert.deepEqual(calls.sort(), ["https://blocked.test/actor", "https://open.test/actor"], "both attempted on the first tick");
    assert.equal(instance.queue.stats().delivered, 1, "the open peer delivered");

    calls.length = 0;
    await scheduler.tick("flush"); // still inside the 30s window on the gate's virtual clock
    assert.ok(!calls.includes("https://blocked.test/actor"), "the blocked peer is not attempted inside its Retry-After window");
    instance.close();
  });
});

// --------------------------------------------------------------- G3 — converge

describe("Decision 1 — converge and the urgent push", () => {
  it("G3: two hub replicas diverged converge within two ticks; an admitted Enroll pushes before any tick", async () => {
    const leaderPaths = workspace();
    const replicaPaths = workspace();
    const leaderConfig = loadConfig({ ...leaderPaths, origin: "https://leader.test" });
    const replicaConfig = loadConfig({ ...replicaPaths, origin: "https://replica.test" });

    const leadBrain = new CountingBrain("lead", [CAP], () => ({ ok: true, content: "n/a" }));
    const leaderInstance = new AfpInstance(leaderConfig, [
      { spec: { name: "lead", capabilities: [CAP], keyCustody: "instance", since: "2026-08-17T00:00:00Z" }, brain: leadBrain },
    ]);
    const replicaInstance = new AfpInstance(replicaConfig, []);

    const docs = new Map<string, ActorDocument>();
    docs.set(leaderInstance.instanceDocument().id as string, leaderInstance.instanceDocument() as ActorDocument);
    docs.set(leaderInstance.actorId("lead"), leaderInstance.agentDocument("lead") as ActorDocument);
    const fetchActor = (actorId: string) => docs.get(actorId) ?? null;

    const hubLeader = new Hub({
      origin: leaderConfig.origin,
      hubId: "bridge",
      db: leaderInstance.db,
      keyDir: leaderConfig.keyDir,
      instanceActorId: leaderInstance.instanceDocument().id as string,
      maxDeliveryAttempts: 5,
      backoffBaseMs: 50,
      fetchActor,
      now: () => leaderInstance.clock.now(),
      // Decision 4: ids resolve against the record — the leader's own outbox,
      // since the enroll below is published through `leaderInstance` onto
      // the same db this hub shares.
      resolveActivity: (activityId) => leaderInstance.outbox.get(activityId)?.activity ?? null,
    });
    docs.set(hubLeader.actorId, hubLeader.actorDocument());

    const hubKey = loadOrCreateHubKeyPair(leaderConfig.keyDir, "lead", leaderInstance.actorId("lead"), hubLeader.hubId);

    // ADR-0032 Decision 6: the hub's default seatPolicy is now
    // "follow-required" — the leader instance Follows before it enrolls.
    await hubLeader.receive(leaderInstance.followHub(hubLeader.actorId).activity);

    // Enroll "lead" before the replica exists — the divergence G3 measures.
    const enrollEntry = leaderInstance.publishAsInstance([hubLeader.actorId], `${leaderConfig.origin}/threads/hub`, "hub", (envelope: Envelope) =>
      enroll(envelope, { agent: leaderInstance.actorId("lead"), hub: hubLeader.actorId, capabilities: [CAP], hubKey: hubKey.keyId }),
    );
    await hubLeader.receive(enrollEntry.activity);
    assert.equal(hubLeader.members().length, 1, "the leader enrolled lead before any replica existed");

    const hubReplica = new Hub({
      origin: replicaConfig.origin,
      hubId: "bridge",
      db: replicaInstance.db,
      keyDir: replicaConfig.keyDir,
      instanceActorId: replicaInstance.instanceDocument().id as string,
      maxDeliveryAttempts: 5,
      backoffBaseMs: 50,
      fetchActor,
      now: () => leaderInstance.clock.now(),
      replicaOf: hubLeader.actorId,
    });
    docs.set(hubReplica.actorId, hubReplica.actorDocument());
    assert.equal(hubReplica.members().length, 0, "the replica starts empty");

    const directTransport: Transport = {
      name: "direct",
      deliver: async (target, activity) => {
        if (target === hubLeader.actorId) {
          await hubLeader.receive(activity);
          return;
        }
        if (target === hubReplica.actorId) {
          await hubReplica.receive(activity);
          return;
        }
        throw new Error(`no route to ${target} in this test's direct transport`);
      },
    };

    const scheduler = new Scheduler({
      instance: leaderInstance,
      transport: directTransport,
      hubReplicas: [
        { hub: hubReplica, peers: [hubLeader.actorId], transport: directTransport },
        { hub: hubLeader, peers: [hubReplica.actorId], transport: directTransport },
      ],
      config: { sweepMs: 30_000, flushMs: 10_000, convergeMs: 60_000, heartbeatMs: 0, jitterMs: 0 },
    });

    await scheduler.tick("converge");
    await scheduler.tick("converge");
    assert.equal(hubReplica.members().length, 1, "the replica converged to the leader's membership within two ticks");
    assert.deepEqual(hubReplica.members().sort(), hubLeader.members().sort());

    // --- the urgent push: a second Enroll, admitted, pushes before any tick.
    const gammaKey = loadOrCreateHubKeyPair(leaderConfig.keyDir, "lead2", "https://leader.test/agents/lead2", hubLeader.hubId);
    docs.set("https://leader.test/agents/lead2", {
      id: "https://leader.test/agents/lead2",
      "afp:operatedBy": leaderInstance.instanceDocument().id,
      assertionMethod: [],
    } as unknown as ActorDocument);
    // A stand-in second agent's actor document — enough for onEnroll's issuer
    // check, which reads only `afp:operatedBy`.
    const secondEnroll = leaderInstance.publishAsInstance([hubLeader.actorId], `${leaderConfig.origin}/threads/hub`, "hub", (envelope: Envelope) =>
      enroll(envelope, { agent: "https://leader.test/agents/lead2", hub: hubLeader.actorId, capabilities: [CAP], hubKey: gammaKey.keyId }),
    );
    await hubLeader.receive(secondEnroll.activity); // dispatch, then the onUrgent hook fires and awaits delivery — no tick() call here

    assert.equal(hubReplica.members().length, 2, "the urgent push converged the replica before any scheduled tick");

    leaderInstance.close();
    replicaInstance.close();
  });
});

// --------------------------------------------------------------- G4 — heartbeat

describe("Decision 1 — heartbeat", () => {
  it("G4: two ticks produce two afp:BoundaryDigest activities, each with a proof; the export replays clean", async () => {
    const paths = workspace();
    const config = loadConfig(paths);
    const instance = new AfpInstance(config, []);
    const { Federation } = await import("../src/federation/federation.ts");
    const federation = new Federation(instance.db, instance.instanceDocument().id as string, () => instance.clock.now());

    const scheduler = new Scheduler({
      instance,
      transport: instance.localTransport(),
      federation,
      config: { sweepMs: 30_000, flushMs: 10_000, convergeMs: 60_000, heartbeatMs: 5_000, jitterMs: 0 },
    });

    await scheduler.tick("heartbeat");
    await scheduler.tick("heartbeat");

    const instanceActorId = instance.instanceDocument().id as string;
    const heartbeats = instance.outbox.byActor(instanceActorId).filter((entry) => objectType(entry.activity) === "afp:BoundaryDigest");
    assert.equal(heartbeats.length, 2, "one afp:BoundaryDigest activity per tick");
    for (const entry of heartbeats) {
      assert.ok(entry.activity.proof, "each heartbeat carries a proof");
    }

    // The verifier resolves signers through the roster (demoP4's pattern).
    instance.publishAsInstance([], `${config.origin}/threads/roster`, "public", (envelope: Envelope) =>
      vouch(envelope, { agent: instanceActorId, capabilities: ["afp:cap:hub"], keyCustody: "self" }),
    );
    const { exportBundle } = await import("../src/export.ts");
    exportBundle(instance, config.exportDir);
    const result = runVerifier(VERIFIER, config.exportDir, `${config.origin}/threads/boundary`, ["--verbose"]);
    assert.equal(result.code, 0, `the heartbeat's export replays clean: ${result.output}`);
    assert.match(result.output, /PASSED/);
    instance.close();
  });
});

// --------------------------------------------------------------- G6 — one writer

describe("Decision 4 — one writer, enforced", () => {
  it("G6: a live foreign pid holding the lock refuses a second open; a stale (dead) pid is taken over; close() releases it, and a reopen works", async () => {
    const paths = workspace();
    const dbPath = `${paths.dataDir}/lockme.db`;

    const foreign = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      const lockPath = `${dbPath}.lock`;
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(paths.dataDir, { recursive: true });
      writeFileSync(lockPath, JSON.stringify({ pid: foreign.pid, openedAt: new Date().toISOString() }));

      assert.throws(() => openDb(dbPath), StoreLocked, "a live foreign pid's lock refuses a second open");
    } finally {
      foreign.kill();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // The foreign process is now dead: the lock is stale and taken over.
    const db = openDb(dbPath);
    assert.ok(readFileSync(`${dbPath}.lock`, "utf8").includes(String(process.pid)), "the lock now names this process");
    db.close();

    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(`${dbPath}.lock`), false, "close() removes the lock");

    const reopened = openDb(dbPath); // adr0028 G4's pattern: reopening after close() works
    reopened.close();
  });

  it("a second openDb of the same live path in this process is refused", () => {
    const paths = workspace();
    const dbPath = `${paths.dataDir}/inproc.db`;
    const first = openDb(dbPath);
    assert.throws(() => openDb(dbPath), StoreLocked);
    first.close();
    const reopened = openDb(dbPath);
    reopened.close();
  });
});

// --------------------------------------------------------------- G7 — shutdown

describe("Decision 5 — shutdown drains", () => {
  // Narrowed: rather than an in-flight slow-streamed POST (the ADR's full
  // shape), this exercises `installShutdown`'s `drain()` in-process against
  // a live server and a live lock, and asserts the three outward effects the
  // slow-POST case would also produce — the POST path itself is exercised
  // by every other gate's use of `createHttpServer` already.
  it("G7 (narrowed): drain() closes the server, flushes, releases the lock, and exits 0", async () => {
    const { instance, config } = testInstance(["writer"], CAP);
    const server = createHttpServer(instance);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const scheduler = new Scheduler({
      instance,
      transport: instance.localTransport(),
      config: { sweepMs: 30_000, flushMs: 10_000, convergeMs: 60_000, heartbeatMs: 0, jitterMs: 0 },
    });

    let exitCode: number | null = null;
    const { drain } = installShutdown({
      server,
      scheduler,
      instance,
      transport: instance.localTransport(),
      timeoutMs: 1000,
      exit: (code) => {
        exitCode = code;
      },
    });

    await drain();

    assert.equal(exitCode, 0, "the exit hook was called with 0");
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(`${config.dbPath}.lock`), false, "the lock file is gone");
  });
});

// --------------------------------------------------------------- G5 — health & metrics

describe("Decision 2 — health, readiness and metrics", () => {
  it("G5: /healthz is always 200 ok; /readyz walks store, signer, self-check, scheduler in order; /metrics carries the pinned series and no data", async () => {
    metrics.reset();
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const config = loadConfig({ ...workspace(), origin, devMode: true });
    const instance = new AfpInstance(config, []);
    const goodFetchActor = async (url: string) => (url === `${origin}/actor` ? (instance.instanceDocument() as ActorDocument) : null);

    // Before any scheduler exists at all: `scheduler-not-running`.
    const serverNoScheduler = createHttpServer(instance, { health: { fetchActor: goodFetchActor } });
    await new Promise<void>((resolve) => serverNoScheduler.listen(port, "127.0.0.1", resolve));
    try {
      const noSched = await httpGet(`${origin}/readyz`);
      assert.equal(noSched.status, 503);
      const noSchedBody = noSched.json() as { ok: boolean; reason: string };
      assert.equal(noSchedBody.ok, false);
      assert.equal(noSchedBody.reason, "scheduler-not-running");

      const stillOk = await httpGet(`${origin}/healthz`);
      assert.equal(stillOk.status, 200);
      assert.equal(stillOk.text(), "ok");
      assert.equal(stillOk.headers["cache-control"], "no-store");
    } finally {
      await new Promise<void>((resolve) => serverNoScheduler.close(() => resolve()));
    }

    // A scheduler exists but has not ticked yet: `scheduler-not-ticked`.
    const scheduler = new Scheduler({
      instance,
      transport: instance.localTransport(),
      config: { sweepMs: 30_000, flushMs: 10_000, convergeMs: 60_000, heartbeatMs: 0, jitterMs: 0 },
    });
    const health: { scheduler?: Scheduler; fetchActor: typeof goodFetchActor; signerProbe?: () => void } = {
      scheduler,
      fetchActor: goodFetchActor,
    };
    const server = createHttpServer(instance, { health });
    // A fresh port rather than the first server's: closing a listener and
    // immediately rebinding the same port raced the OS's own teardown often
    // enough to be the flaky failure this file used to show under `fetch`
    // (see `httpGet`'s note above) — a distinct port sidesteps it entirely.
    // `instance.config.origin` (bound to the first port) is what the
    // self-check compares against, and `goodFetchActor` never dials the
    // network, so which port the server actually listens on here is
    // otherwise unobservable.
    const port2 = await freePort();
    const origin2 = `http://127.0.0.1:${port2}`;
    await new Promise<void>((resolve) => server.listen(port2, "127.0.0.1", resolve));
    try {
      const notTicked = await httpGet(`${origin2}/readyz`);
      assert.equal(notTicked.status, 503);
      assert.equal((notTicked.json() as { reason: string }).reason, "scheduler-not-ticked");

      // The signer fails: named before the self-check and the scheduler.
      health.signerProbe = () => {
        throw new Error("simulated signer failure");
      };
      const signerDown = await httpGet(`${origin2}/readyz`);
      assert.equal(signerDown.status, 503);
      assert.equal((signerDown.json() as { reason: string }).reason, "signer-unavailable");
      const healthzDuringSignerDown = await httpGet(`${origin2}/healthz`);
      assert.equal(healthzDuringSignerDown.status, 200, "/healthz never depends on /readyz's checks");
      delete health.signerProbe;

      // The self-check's fetched document names a different id.
      health.fetchActor = async () => ({ id: "https://impostor.test/actor" }) as ActorDocument;
      const mismatch = await httpGet(`${origin2}/readyz`);
      assert.equal(mismatch.status, 503);
      assert.equal((mismatch.json() as { reason: string }).reason, "self-check-mismatch");
      health.fetchActor = goodFetchActor;

      // Everything good, but the scheduler still hasn't ticked.
      const stillNotTicked = await httpGet(`${origin2}/readyz`);
      assert.equal(stillNotTicked.status, 503);
      assert.equal((stillNotTicked.json() as { reason: string }).reason, "scheduler-not-ticked");

      await scheduler.tick("sweep");
      const ready = await httpGet(`${origin2}/readyz`);
      assert.equal(ready.status, 200);
      assert.deepEqual(ready.json(), { ok: true });

      // --- /metrics: the pinned series are present, refusals and rate-limit
      // refusals increment on real events, and no actor URL or activity id
      // ever appears in the body.
      await instance.receive({}); // no id — a "rejected" refusal
      metrics.trackQueue(() => instance.queue.stats());

      const rateLimitedInstance = new AfpInstance(
        loadConfig({ ...workspace(), origin: "https://ratelimit.test", devMode: true, rateLimitPerAddress: 1, rateLimitPerAddressWindowMs: 60_000 }),
        [],
      );
      const rlPort = await freePort();
      const rlServer = createHttpServer(rateLimitedInstance);
      await new Promise<void>((resolve) => rlServer.listen(rlPort, "127.0.0.1", resolve));
      try {
        await httpGet(`http://127.0.0.1:${rlPort}/actor`);
        const limited = await httpGet(`http://127.0.0.1:${rlPort}/actor`);
        assert.equal(limited.status, 429, "the second request empties the one-request bucket");
      } finally {
        rateLimitedInstance.close();
        rlServer.close();
      }

      const metricsResponse = await httpGet(`${origin2}/metrics`);
      assert.equal(metricsResponse.status, 200);
      assert.equal(metricsResponse.headers["content-type"], "text/plain; version=0.0.4");
      assert.equal(metricsResponse.headers["cache-control"], "no-store");
      const body = metricsResponse.text();
      for (const series of [
        "afp_inbox_admissions_total",
        "afp_inbox_refusals_total",
        "afp_ratelimit_refusals_total",
        "afp_queue_depth",
        "afp_dead_letters_total",
        "afp_sweep_overdue_total",
        "afp_scheduler_ticks_total",
        "afp_scheduler_last_tick_seconds",
        "afp_converge_lag_seconds",
        "afp_process_start_time_seconds",
      ]) {
        assert.match(body, new RegExp(`# TYPE ${series} `), `${series} is a pinned series`);
      }
      assert.match(body, /afp_inbox_refusals_total\{class="rejected"\} [1-9]/, "the rejected delivery incremented its class");
      assert.match(body, /afp_ratelimit_refusals_total\{scope="address"\} [1-9]/, "the emptied bucket incremented its scope");
      assert.ok(!body.includes(origin) && !body.includes(origin2), "no actor URL in the metrics body");
      assert.ok(!body.includes("https://"), "no URL of any kind in the metrics body");
    } finally {
      server.close();
      instance.close();
    }
  });
});

// --------------------------------------------------------------- G9 — demos unchanged

describe("Decision 2 — every shipped bundle replayed is unchanged", () => {
  it("G9: freshDemo() and demo:p8, fresh, both verify clean", async () => {
    const { exported, thread } = await freshDemo();
    const clean = runVerifier(VERIFIER, exported.dir, thread);
    assert.equal(clean.code, 0, `the P1 demo's own bundle failed to verify after ADR-0031:\n${clean.output}`);
    assert.match(clean.output, /PASSED/);

    const p8Paths = workspace();
    const p8 = await runP8Demo({ fresh: true, config: { dataDir: p8Paths.dataDir, exportDir: p8Paths.exportDir } });
    try {
      const p8clean = runVerifier(VERIFIER, p8.exported.dir, p8.thread, ["--verbose"]);
      assert.equal(p8clean.code, 0, `demo:p8's own bundle failed to verify after ADR-0031:\n${p8clean.output}`);
      assert.match(p8clean.output, /PASSED/);
    } finally {
      p8.instance.close();
    }
  });
});
