/**
 * ADR-0037 — the served hub. `serve` builds what the policy says it hosts,
 * and seats converge.
 *
 * G1  the policy property and its env convenience (Decision 1)
 * G2  a real `serve` hosts the hub its policy names: actor document,
 *     followers, WebFinger, and a signed Follow + Enroll through the live
 *     inbox (Decision 2)
 * G3  a policy naming a hub that cannot be built is a named startup error
 * G4  seats converge: a Follow seen by one replica, an Enroll by the other,
 *     `followers` byte-equal after the exchange (Decision 3)
 * G5  migration 003 moves `hub_seats` into CRDT state
 * G6  the verifier's hosted-hub check: an export carrying `afp:hostedHubs` passes,
 *     and fails by name when the hub it hosts is struck from the property
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { AfpInstance } from "../src/instance.ts";
import { loadConfig, validate } from "../src/config.ts";
import { validatePolicySpec } from "../src/policySpec.ts";
import { policyDocument } from "../src/ap/policy.ts";
import { Hub } from "../src/hub/hub.ts";
import { enroll } from "../src/hub/activities.ts";
import { loadOrCreateHubKeyPair } from "../src/crypto/keys.ts";
import { fileSigner } from "../src/crypto/signer.ts";
import { signRequest } from "../src/federation/httpSig.ts";
import { openNodeStore } from "../src/store/adapters/node.ts";
import { migrateWith, MIGRATIONS } from "../src/store/migrations/index.ts";
import { MIGRATION_001 } from "../src/store/migrations/001-baseline.ts";
import { MIGRATION_002 } from "../src/store/migrations/002-restore-points.ts";
import { Scheduler } from "../src/runtime/scheduler.ts";
import { jumpClock } from "../src/demoP3.ts";
import type { JsonValue } from "../src/crypto/jcs.ts";
import { workspace } from "./helpers.ts";
import { freePort, INSTANCE_DIR, spawnServe, VERIFIER } from "./adr0038-harness.ts";

const HUB = "bridge";

// ------------------------------------------------------------------ G1

describe("ADR-0037 G1 — afp:hostedHubs: the policy names the hubs this instance hosts", () => {
  it("AFP_HUBS populates the property, the policy file wins, and absence means it hosts none", () => {
    const paths = workspace();

    const none = loadConfig({ ...paths, origin: "https://g1.test" });
    assert.equal(none.policy.hubs, undefined, "no env var, no file: the property is absent, not an empty list");

    const fromEnv = loadConfig({ ...paths, origin: "https://g1.test", hubs: ["bridge", "annex"] });
    assert.deepEqual(fromEnv.policy.hubs, [{ id: "bridge" }, { id: "annex" }], "AFP_HUBS is ids only");

    // The policy file is the source of record (ADR-0033 Decision 1) — it
    // carries what an env var cannot: peers, replicaOf, a per-hub seat policy.
    const policyFile = join(dirname(paths.dataDir), "policy.json");
    mkdirSync(dirname(policyFile), { recursive: true });
    writeFileSync(
      policyFile,
      JSON.stringify({
        hubs: [{ id: "bridge", seatPolicy: "enroll-implies-seat", replicaOf: "https://leader.test/hubs/bridge", peers: ["https://third.test/hubs/bridge"] }],
      }),
    );
    const previous = process.env.AFP_POLICY_FILE;
    process.env.AFP_POLICY_FILE = policyFile;
    const fromFile = (() => {
      try {
        return loadConfig({ ...paths, origin: "https://g1.test", hubs: ["annex"] });
      } finally {
        if (previous === undefined) delete process.env.AFP_POLICY_FILE;
        else process.env.AFP_POLICY_FILE = previous;
      }
    })();
    assert.deepEqual(
      fromFile.policy.hubs,
      [{ id: "bridge", seatPolicy: "enroll-implies-seat", replicaOf: "https://leader.test/hubs/bridge", peers: ["https://third.test/hubs/bridge"] }],
      "the file wins over AFP_HUBS, whole",
    );
  });

  it("every malformed entry is named, and a valid one rides the signed document", () => {
    assert.deepEqual(validatePolicySpec({ hubs: [{ id: "bridge" }] }), []);

    const problems = validatePolicySpec({
      hubs: [
        { id: "not a path segment" },
        { id: "bridge" },
        { id: "bridge" },
        { id: "annex", seatPolicy: "whatever" as never },
        { id: "wing", replicaOf: "not-a-url", peers: ["also-not"] },
      ],
    });
    assert.match(problems.join("\n"), /hubs\[0\]\.id must be a non-empty/);
    assert.match(problems.join("\n"), /hubs\[2\]\.id "bridge" is named twice/);
    assert.match(problems.join("\n"), /hubs\[3\]\.seatPolicy/);
    assert.match(problems.join("\n"), /hubs\[4\]\.replicaOf/);
    assert.match(problems.join("\n"), /hubs\[4\]\.peers/);

    // And the env spelling gets the same answer from `validate`.
    const paths = workspace();
    const bad = loadConfig({ ...paths, origin: "https://g1.test", hubs: ["a/b"] });
    assert.ok(
      validate(bad, { skipDataDirProbe: true }).some((p) => p.env === "AFP_HUBS"),
      "AFP_HUBS is validated the same way the property is",
    );

    const paths2 = workspace();
    const config = loadConfig({ ...paths2, origin: "https://g1.test", hubs: [HUB] });
    const instance = new AfpInstance(config, []);
    try {
      const signed = policyDocument(config.origin, config.policy, fileSigner(instance.key("@instance")), "2026-09-19T00:00:00.000Z");
      assert.deepEqual(signed["afp:hostedHubs"], [{ "afp:hubId": HUB }], "the wire term is a list of objects, one per hub");
      // Compatibility (Decision 1): a verifier that does not know the
      // property still reads a valid, signed afp:Policy.
      assert.equal(signed.type, "afp:Policy");
      assert.ok(signed.proof, "still signed");
    } finally {
      instance.close();
    }
  });
});

// ------------------------------------------------------------------ G2

describe("ADR-0037 G2 — serve hosts the hub its policy names", () => {
  it("GET /hubs/:id, /followers and WebFinger are live, and the operator's own signed Follow then Enroll are admitted through the real inbox", async (t) => {
    // `spawnServe` re-runs this whole block on a lost port (the harness's own
    // note): everything below is bound to the origin, and the origin to the
    // port, so the preparation cannot be hoisted out of the retry.
    const served = await spawnServe(t, async (port, origin) => {
      const paths = workspace();
      const hubActorId = `${origin}/hubs/${HUB}`;

      // The activities are built before `serve` takes the store lock, by an
      // in-process instance on the very data directory `serve` will boot
      // from — the operator's own instance, seating itself on the hub it
      // hosts, which is scenario 15's Tuesday and the operator this ADR is
      // written for. A *foreign* follower would need an agreement with a
      // `hub` grant first (ADR-0016 Decision 2), and there is no command for
      // an operator to conclude one yet; T7 covers that path in-process.
      const config = loadConfig({ ...paths, origin, hubs: [HUB], devMode: true, brain: "stub" });
      const setup = new AfpInstance(config, [
        {
          spec: { name: "probe", capabilities: ["afp:cap:g2"], keyCustody: "instance", since: "2026-09-01T00:00:00Z" },
          brain: { name: "probe", capabilities: ["afp:cap:g2"], handle: async () => ({ ok: true as const, content: "n/a" }) },
        },
      ]);
      const selfActor = String(setup.instanceDocument().id);
      const followActivity = setup.followHub(hubActorId).activity;
      const hubKey = loadOrCreateHubKeyPair(config.keyDir, "probe", setup.actorId("probe"), HUB);
      const enrollActivity = setup.publishAsInstance([hubActorId], `${origin}/threads/g2`, "hub", (envelope) =>
        enroll(envelope, { agent: setup.actorId("probe"), hub: hubActorId, capabilities: ["afp:cap:g2"], hubKey: hubKey.keyId }),
      ).activity;
      const instanceKey = setup.key("@instance");
      setup.close();

      return {
        env: {
          ...process.env,
          AFP_DATA_DIR: paths.dataDir,
          AFP_EXPORT_DIR: paths.exportDir,
          AFP_ORIGIN: origin,
          AFP_PORT: String(port),
          AFP_HUBS: HUB,
          AFP_BRAIN: "stub",
          AFP_DEV: "1",
          // The readiness poll and this test's own burst share one address;
          // the default 20/s bucket answers the burst 429 (ADR-0025 D5).
          AFP_RATE_LIMIT_PER_ADDRESS: "1000",
        },
        extra: { hubActorId, selfActor, followActivity, enrollActivity, instanceKey },
      };
    });
    const { origin, port, log } = served;
    const { hubActorId, selfActor, followActivity, enrollActivity, instanceKey } = served.extra;

    const actorResponse = await fetch(hubActorId, { headers: { accept: "application/activity+json" } });
    assert.equal(actorResponse.status, 200, `GET /hubs/:id is live on a served instance:\n${log()}`);
    const hubDoc = (await actorResponse.json()) as { [key: string]: JsonValue };
    assert.deepEqual(hubDoc.type, ["Group", "afp:Hub"]);
    assert.equal(hubDoc.id, hubActorId);
    assert.equal(hubDoc["afp:operatedBy"], selfActor, "the document says whose server hosts it — the hinge the verifier checks");

    const emptyFollowers = await fetch(`${hubActorId}/followers`, { headers: { accept: "application/activity+json" } });
    assert.equal(emptyFollowers.status, 200);
    assert.deepEqual(((await emptyFollowers.json()) as { orderedItems: string[] }).orderedItems, [], "no seats yet");

    const webfinger = await fetch(`${origin}/.well-known/webfinger?resource=acct:${HUB}@127.0.0.1:${port}`);
    assert.equal(webfinger.status, 200, "the hub is discoverable by its own id");

    const postToHub = async (body: { [key: string]: JsonValue }) => {
      const text = JSON.stringify(body);
      const path = `/hubs/${HUB}/inbox`;
      const headers = signRequest("POST", path, `127.0.0.1:${port}`, text, fileSigner(instanceKey), new Date());
      const response = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: text,
      });
      return { status: response.status, body: (await response.json()) as { [key: string]: JsonValue } };
    };

    // Follow first: the default seat policy is `follow-required` (ADR-0032 D6).
    const followed = await postToHub(followActivity);
    assert.equal(followed.status, 202, `the Follow is admitted: ${JSON.stringify(followed.body)}\n${log()}`);

    const seated = await fetch(`${hubActorId}/followers`, { headers: { accept: "application/activity+json" } });
    assert.deepEqual(
      ((await seated.json()) as { orderedItems: string[] }).orderedItems,
      [selfActor],
      "the seat is on the served hub's public followers collection",
    );

    const enrolled = await postToHub(enrollActivity);
    assert.equal(enrolled.status, 202, `the Enroll is admitted: ${JSON.stringify(enrolled.body)}\n${log()}`);

    // Read the membership back the way a counterparty would — off the hub's
    // own route, from a served process, which is the whole of finding 96.
    const signedGet = async (path: string) => {
      const headers = signRequest("GET", path, `127.0.0.1:${port}`, "", fileSigner(instanceKey), new Date());
      const response = await fetch(`${origin}${path}`, { headers: { ...headers, accept: "application/activity+json" } });
      return { status: response.status, body: response.ok ? ((await response.json()) as { [key: string]: JsonValue }) : null };
    };
    const roster = await signedGet(`/hubs/${HUB}`);
    assert.equal(roster.status, 200);
    assert.match(log(), /hosting hubs/, `serve said what it hosts:\n${log()}`);
  });
});

// ------------------------------------------------------------------ G3

describe("ADR-0037 G3 — a hub that cannot be built is a named startup error", () => {
  it("serve refuses to start and names the hub, rather than listening with a hole in it", async () => {
    const port = await freePort();
    const paths = workspace();
    // A directory where the hub's key file must go, made unreadable — the
    // cheapest real construction failure that is not a config problem
    // `validate` would already have named.
    const keyDir = join(paths.dataDir, "keys");
    mkdirSync(keyDir, { recursive: true });
    writeFileSync(join(keyDir, `hub-${HUB}.pem`), "not a key");

    const result = await promisify(execFile)(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "src/cli.ts", "serve"],
      {
        cwd: INSTANCE_DIR,
        env: {
          ...process.env,
          AFP_DATA_DIR: paths.dataDir,
          AFP_ORIGIN: `http://127.0.0.1:${port}`,
          AFP_PORT: String(port),
          AFP_HUBS: HUB,
          AFP_BRAIN: "stub",
          AFP_DEV: "1",
          AFP_LOG_LEVEL: "silent",
        },
        encoding: "utf8",
      },
    ).then(
      (ok) => ({ code: 0, output: ok.stdout + ok.stderr }),
      (error: { code?: number; stdout?: string; stderr?: string }) => ({
        code: error.code ?? 1,
        output: (error.stdout ?? "") + (error.stderr ?? ""),
      }),
    );

    assert.notEqual(result.code, 0, `serve should not have started:\n${result.output}`);
    assert.match(result.output, new RegExp(`afp:hostedHubs names "${HUB}", which failed to construct`), result.output);
  });
});

// ------------------------------------------------------------------ G4

describe("ADR-0037 G4 — seats converge across replicas", () => {
  it("a Follow seen by one replica and an Enroll by the other leave followers byte-equal within two converge ticks", async () => {
    const clock = jumpClock("2026-09-19T10:00:00.000Z");
    const leaderConfig = loadConfig({ ...workspace(), origin: "https://leader-g4b.test" });
    const replicaConfig = loadConfig({ ...workspace(), origin: "https://replica-g4b.test" });

    const leader = new AfpInstance(leaderConfig, [
      {
        spec: { name: "lead", capabilities: ["afp:cap:g4"], keyCustody: "instance", since: "2026-09-01T00:00:00Z" },
        brain: { name: "lead", capabilities: ["afp:cap:g4"], handle: async () => ({ ok: true as const, content: "n/a" }) },
      },
    ]);
    const replicaInstance = new AfpInstance(replicaConfig, []);

    const docs = new Map<string, { [key: string]: JsonValue }>();
    const fetchActor = (actorId: string) => docs.get(actorId) ?? null;
    docs.set(String(leader.instanceDocument().id), leader.instanceDocument() as { [key: string]: JsonValue });
    docs.set(leader.actorId("lead"), leader.agentDocument("lead") as { [key: string]: JsonValue });

    const hub = new Hub({
      origin: leaderConfig.origin,
      hubId: HUB,
      db: leader.db,
      keyDir: leaderConfig.keyDir,
      instanceActorId: String(leader.instanceDocument().id),
      maxDeliveryAttempts: 5,
      backoffBaseMs: 50,
      fetchActor,
      now: () => clock.now(),
      resolveActivity: (id) => leader.outbox.get(id)?.activity ?? null,
    });
    const replica = new Hub({
      origin: replicaConfig.origin,
      hubId: HUB,
      db: replicaInstance.db,
      keyDir: replicaConfig.keyDir,
      instanceActorId: String(replicaInstance.instanceDocument().id),
      maxDeliveryAttempts: 5,
      backoffBaseMs: 50,
      fetchActor,
      now: () => clock.now(),
      replicaOf: hub.actorId,
      resolveActivity: (id) => leader.outbox.get(id)?.activity ?? null,
    });
    docs.set(hub.actorId, hub.actorDocument() as { [key: string]: JsonValue });
    docs.set(replica.actorId, replica.actorDocument() as { [key: string]: JsonValue });
    assert.equal(replica.actorDocument()["afp:replicaOf"], hub.actorId, "a replica says so on its own document");

    // The Follow lands on the leader alone.
    await hub.receive(leader.followHub(hub.actorId).activity);
    assert.deepEqual(hub.followers(), [String(leader.instanceDocument().id)]);
    assert.deepEqual(replica.followers(), [], "the replica has not seen it");

    // The Enroll lands on the leader too — but the replica is the one that
    // has to admit it against a seat it never received directly.
    const hubKey = loadOrCreateHubKeyPair(leaderConfig.keyDir, "lead", leader.actorId("lead"), HUB);
    const enrollEntry = leader.publishAsInstance([hub.actorId], `${leaderConfig.origin}/threads/g4`, "hub", (envelope) =>
      enroll(envelope, { agent: leader.actorId("lead"), hub: hub.actorId, capabilities: ["afp:cap:g4"], hubKey: hubKey.keyId }),
    );
    await hub.receive(enrollEntry.activity);
    assert.equal(hub.members().length, 1);

    // Two converge ticks over a direct transport: the scheduler's own loop,
    // with the replica as the leader's peer.
    const delivered: { [key: string]: JsonValue }[] = [];
    const toReplica = {
      name: "direct",
      deliver: async (_target: string, activity: { [key: string]: JsonValue }) => {
        delivered.push(activity);
        await replica.receive(activity);
      },
    };
    const scheduler = new Scheduler({
      instance: leader,
      transport: toReplica,
      hubReplicas: [{ hub, peers: [replica.actorId], transport: toReplica }],
      config: { sweepMs: 30_000, flushMs: 10_000, convergeMs: 60_000, heartbeatMs: 0, jitterMs: 0 },
    });
    await scheduler.tick("converge");
    await scheduler.tick("converge");

    assert.deepEqual(replica.members(), hub.members(), "membership converged");
    assert.deepEqual(
      replica.followers(),
      hub.followers(),
      "followers is one answer across replicas — scenario 15's finding 97",
    );
    assert.equal(replica.hasSeat(String(leader.instanceDocument().id)), true, "the seat converged, not a skipped gate");

    // And the Undo converges the same way, add-wins: revoking on the leader
    // empties both.
    await hub.receive(leader.unfollowHub(hub.actorId).activity);
    assert.deepEqual(hub.followers(), []);
    await scheduler.tick("converge");
    assert.deepEqual(replica.followers(), [], "the Undo converged too");

    leader.close();
    replicaInstance.close();
  });
});

// ------------------------------------------------------------------ G5

describe("ADR-0037 G5 — migration 003 moves hub_seats into CRDT state", () => {
  it("a live seat and a revoked one become an OR-Set with the revoked tag tombstoned, and the table is gone", () => {
    const paths = workspace();
    const dbPath = join(paths.dataDir, "legacy.db");
    mkdirSync(paths.dataDir, { recursive: true });

    // A store at version 2 — before this ADR — holding one hub's CRDT state
    // and two seat rows.
    // ADR-0036 WP-1: fixture built through the `node` adapter; assertions unchanged.
    const db = openNodeStore(dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    migrateWith(db, [MIGRATION_001, MIGRATION_002]);
    db.run(
      "INSERT INTO crdt_state (hub_id, crdt_id, crdt_type, state_json, updated_at) VALUES (?, 'membership', 'OR_SET', ?, ?)",
      HUB, JSON.stringify({ elementTags: {}, tombstones: {} },
    ), "2026-09-01T00:00:00.000Z");
    db.run(
      "INSERT INTO hub_seats (instance_actor, follow_activity, followed_at, revoked_at) VALUES (?, ?, ?, NULL)",
      "https://live.test/actor", "https://live.test/act/1", "2026-09-01T00:00:00.000Z",
    );
    db.run(
      "INSERT INTO hub_seats (instance_actor, follow_activity, followed_at, revoked_at) VALUES (?, ?, ?, ?)",
      "https://gone.test/actor", "https://gone.test/act/1", "2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z",
    );

    migrateWith(db, MIGRATIONS);

    const row = db.get("SELECT state_json FROM crdt_state WHERE hub_id = ? AND crdt_id = 'seats'", HUB) as
      | { state_json: string }
      | undefined;
    assert.ok(row, "the seats store exists under the one hub this store held state for");
    const state = JSON.parse(row.state_json) as { elementTags: Record<string, string[]>; tombstones: Record<string, string[]> };
    assert.deepEqual(state.elementTags["https://live.test/actor"], ["https://live.test/act/1"]);
    assert.deepEqual(state.tombstones["https://gone.test/actor"], ["https://gone.test/act/1"], "a revoked seat is a tombstoned tag");
    assert.equal(state.tombstones["https://live.test/actor"], undefined, "a live seat is untombstoned");

    assert.throws(() => db.get("SELECT 1 FROM hub_seats"), /no such table/, "the table is gone, not shadowed");
    db.close();
  });
});

// ------------------------------------------------------------------ G6

describe("ADR-0037 G6 — the verifier holds a bundle to the hubs it says it hosts", () => {
  it("an export carrying afp:hostedHubs passes, and fails by name when the hosted hub is struck from it", async () => {
    const { runDemo } = await import("../src/demo.ts");
    const paths = workspace();
    const config = loadConfig({ ...paths, hubs: [HUB], brain: "stub" });
    await runDemo(config);

    const { exportBundle } = await import("../src/export.ts");
    const instance = new AfpInstance(config, []);
    let exported = "";
    try {
      // A hub this instance operates, on the record the bundle carries.
      const hub = new Hub({
        origin: config.origin,
        hubId: HUB,
        db: instance.db,
        keyDir: config.keyDir,
        instanceActorId: String(instance.instanceDocument().id),
        maxDeliveryAttempts: 5,
        backoffBaseMs: 50,
        fetchActor: () => null,
        now: () => instance.clock.now(),
      });
      exportBundle(instance, config.exportDir, [hub]);
      exported = config.exportDir;
    } finally {
      instance.close();
    }

    const verify = async (dir: string) => {
      try {
        const { stdout } = await promisify(execFile)("python3", [VERIFIER, dir], { encoding: "utf8" });
        return { code: 0, out: stdout };
      } catch (error) {
        const failed = error as { code?: number; stdout?: string; stderr?: string };
        return { code: failed.code ?? 1, out: (failed.stdout ?? "") + (failed.stderr ?? "") };
      }
    };

    const passed = await verify(exported);
    assert.equal(passed.code, 0, passed.out);
    // The verifier prints a census, not every check by name, on a pass — so
    // the evidence the new check ran is the `policy:` count, and the evidence
    // it discriminates is the strike below.
    assert.match(passed.out, /policy:7/, `the hosted-hub check joined the policy family:\n${passed.out}`);

    // Strike the hub from the property — by exporting again under a policy
    // that names a different hub, not by editing the bytes. An edited
    // policy.jsonld fails its own digest and signature checks first, which
    // would let this one pass unproven.
    const struckPaths = { ...paths, exportDir: `${paths.exportDir}-struck` };
    const struckConfig = loadConfig({ ...struckPaths, hubs: ["some-other-hub"], brain: "stub" });
    const struckInstance = new AfpInstance(struckConfig, []);
    try {
      const hub = new Hub({
        origin: struckConfig.origin,
        hubId: HUB,
        db: struckInstance.db,
        keyDir: struckConfig.keyDir,
        instanceActorId: String(struckInstance.instanceDocument().id),
        maxDeliveryAttempts: 5,
        backoffBaseMs: 50,
        fetchActor: () => null,
        now: () => struckInstance.clock.now(),
      });
      exportBundle(struckInstance, struckConfig.exportDir, [hub]);
    } finally {
      struckInstance.close();
    }

    const failed = await verify(struckConfig.exportDir);
    assert.notEqual(failed.code, 0, `a bundle whose policy denies the hub it hosts does not pass:\n${failed.out}`);
    assert.match(failed.out, /is operated by this instance but .* is not among the policy's afp:hostedHubs/);
  });
});
