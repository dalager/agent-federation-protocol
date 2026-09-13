/**
 * ADR-0032 — the deployment profile: TLS/origin, configuration-as-a-schema,
 * versioned migrations, backup/restore, the seat-default flip, and the
 * consolidated gate. Numbered G1–G8 match the ADR's own gate paragraph
 * verbatim; every case from `test/adr0032-wp2.test.ts` and
 * `test/adr0032-wp13.test.ts` is folded in here (those two files are
 * deleted), plus the D4/D6 cases that were `test/adr0017-d4-follow.test.ts`'s
 * own inverted-default proof, cited rather than repeated.
 *
 *   node --disable-warning=ExperimentalWarning --test test/adr0032.test.ts
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, describe, it } from "node:test";

import { runDemo, agentRegistrations } from "../src/demo.ts";
import { runP2Demo } from "../src/demoP2.ts";
import { runP3Demo } from "../src/demoP3.ts";
import { runP4Demo } from "../src/demoP4.ts";
import { runP5Demo } from "../src/demoP5.ts";
import { runP6Demo } from "../src/demoP6.ts";
import { runP7Demo } from "../src/demoP7.ts";
import { runP8Demo } from "../src/demoP8.ts";
import { loadConfig, validate, readSecretFile, type Config } from "../src/config.ts";
import { runConfigCheck } from "../src/runtime/configCheck.ts";
import { backupStore, restoreStore, RestoreRefused } from "../src/store/backup.ts";
import { openDb, schemaVersion, BINARY_SCHEMA_VERSION, StoreNewerThanBinary } from "../src/store/db.ts";
import { migrateWith, MIGRATIONS, type Migration } from "../src/store/migrations/index.ts";
import { MIGRATION_001 } from "../src/store/migrations/001-baseline.ts";
import { AfpInstance } from "../src/instance.ts";
import { exportBundle } from "../src/export.ts";
import { Hub } from "../src/hub/hub.ts";
import { hasSeat } from "../src/hub/store.ts";
import { enroll } from "../src/hub/activities.ts";
import { loadOrCreateHubKeyPair } from "../src/crypto/keys.ts";
import { jumpClock } from "../src/demoP3.ts";
import { cleanupWorkspaces, freshDemo, runVerifier, testInstance, workspace } from "./helpers.ts";

const VERIFIER = join(import.meta.dirname, "..", "..", "verifier", "afp_verify.py");
const LEGACY_SCHEMA_SQL = readFileSync(join(import.meta.dirname, "fixtures", "legacy-schema.sql"), "utf8");

const scratchDirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "afp-0032-"));
  scratchDirs.push(dir);
  return dir;
}

after(() => {
  cleanupWorkspaces();
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/** A reference `Config`: dev mode (AFP_DEV=1, set at helpers.ts import time), fresh workspace. */
function referenceConfig(): Config {
  return loadConfig(workspace());
}

/** Reopen `dbPath` and assert it is at BINARY_SCHEMA_VERSION with no further migration pending. */
function assertFullyMigrated(dbPath: string, label: string): void {
  const reopened = openDb(dbPath);
  assert.equal(schemaVersion(reopened), BINARY_SCHEMA_VERSION, `${label}: not at BINARY_SCHEMA_VERSION`);
  const { from, to } = migrateWith(reopened, MIGRATIONS);
  assert.equal(from, to, `${label}: a migration was still pending on reopen`);
  reopened.close();
}

// ------------------------------------------------------------------- G1

describe("ADR-0032 gate — G1: config check fails on each named misconfiguration, passes on the reference one", () => {
  it("passes on the reference config, --offline", async () => {
    const config = referenceConfig();
    const result = await runConfigCheck(config, { offline: true });
    assert.deepEqual(result.problems, []);
    for (const line of result.lines) assert.ok(line.ok, `${line.name}: ${line.reason}`);
    assert.ok(result.allOk);
  });

  it("AFP_ORIGIN not https: outside dev mode is named", () => {
    const config: Config = { ...referenceConfig(), devMode: false, origin: "http://example.com" };
    const problems = validate(config);
    assert.ok(problems.some((p) => p.field === "origin" && p.env === "AFP_ORIGIN"));
  });

  it("a negative int field is named", () => {
    const config = { ...referenceConfig(), maxDeliveryAttempts: -1 };
    const problems = validate(config);
    assert.ok(problems.some((p) => p.field === "maxDeliveryAttempts" && p.env === "AFP_MAX_DELIVERY_ATTEMPTS"));
  });

  it("dataDir not writable by this process is named", () => {
    const dir = scratch();
    const unwritable = join(dir, "readonly");
    mkdirSync(unwritable, { recursive: true, mode: 0o500 });
    try {
      const config = { ...referenceConfig(), dataDir: unwritable };
      const problems = validate(config);
      if (process.getuid && process.getuid() === 0) return; // root bypasses the mode bit
      assert.ok(problems.some((p) => p.field === "dataDir"));
    } finally {
      rmSync(unwritable, { recursive: true, force: true, mode: 0o700 as unknown as undefined });
    }
  });

  it("a secret *_FILE path that is set but unreadable is named", () => {
    const missing = join(scratch(), "does-not-exist.txt");
    const config = { ...referenceConfig(), keyPassphraseFile: missing };
    const problems = validate(config);
    assert.ok(problems.some((p) => p.field === "keyPassphraseFile" && p.env === "AFP_KEY_PASSPHRASE_FILE"));
  });

  it("AFP_LLM_ALLOWED_ENDPOINTS entries that are not absolute URLs are named", () => {
    const config = { ...referenceConfig(), llmAllowedEndpoints: ["not-a-url", "http://ok.example"] };
    const problems = validate(config);
    assert.ok(problems.some((p) => p.field === "llmAllowedEndpoints" && p.message.includes("not-a-url")));
    assert.ok(!problems.some((p) => p.message.includes("http://ok.example")));
  });

  it("AFP_CONTROLLERS entries not http(s) URLs are named", () => {
    const config = { ...referenceConfig(), controllers: ["ftp://nope", "https://ok.example/actor"] };
    const problems = validate(config);
    assert.ok(problems.some((p) => p.field === "controllers" && p.message.includes("ftp://nope")));
  });

  it("a scheduler interval <= 0 is named, except heartbeat which allows 0 (off)", () => {
    const config = {
      ...referenceConfig(),
      scheduler: { sweepMs: 0, flushMs: 10_000, convergeMs: 60_000, heartbeatMs: 0, jitterMs: 0 },
    };
    const problems = validate(config);
    assert.ok(problems.some((p) => p.field === "scheduler.sweepMs"));
    assert.ok(!problems.some((p) => p.field === "scheduler.heartbeatMs"));
  });

  it("several misconfigurations at once are ALL named in one call", () => {
    const config = {
      ...referenceConfig(),
      devMode: false,
      origin: "http://example.com",
      maxDeliveryAttempts: -1,
      controllers: ["ftp://nope"],
    };
    const problems = validate(config);
    const fields = new Set(problems.map((p) => p.field));
    assert.ok(fields.has("origin"));
    assert.ok(fields.has("maxDeliveryAttempts"));
    assert.ok(fields.has("controllers"));
  });

  it("a mismatched self-check id FAILs that line only", async () => {
    const config = referenceConfig();
    const badFetch = async () => ({ id: "https://not-this-instance.example/actor" });
    const result = await runConfigCheck(config, { fetchActor: badFetch });
    const selfCheck = result.lines.find((l) => l.name === "self-check");
    assert.equal(selfCheck?.ok, false);
    assert.equal(selfCheck?.reason, "self-check-mismatch");
    const others = result.lines.filter((l) => l.name !== "self-check");
    for (const line of others) assert.ok(line.ok, `${line.name}: ${line.reason}`);
  });

  it("a store held by a live instance reports store-locked, and exit status stays 0", async () => {
    const config = referenceConfig();
    const instance = new AfpInstance(config, []);
    try {
      const result = await runConfigCheck(config, { offline: true });
      const store = result.lines.find((l) => l.name === "store");
      assert.equal(store?.ok, true);
      assert.match(store?.reason ?? "", /store-locked/);
      assert.ok(result.allOk, "a live-locked store does not fail the check");
    } finally {
      instance.close();
    }
  });
});

// ------------------------------------------------------------------- G2

describe("ADR-0032 gate — G2: every shipped demo store migrates, nothing pending on reopen", () => {
  it("demo / demo:offline", async () => {
    const { instance } = await freshDemo();
    const dbPath = instance.config.dbPath;
    instance.close();
    assertFullyMigrated(dbPath, "demo");
  });

  it("demo:p2", async () => {
    const { instance } = await runP2Demo({ fresh: true, config: workspace() });
    const dbPath = instance.config.dbPath;
    instance.close();
    assertFullyMigrated(dbPath, "demo:p2");
  });

  it("demo:p3", async () => {
    const { instance } = await runP3Demo({ fresh: true, config: workspace() });
    const dbPath = instance.config.dbPath;
    instance.close();
    assertFullyMigrated(dbPath, "demo:p3");
  });

  it("demo:p4 — every operator's store", async () => {
    const paths = workspace();
    const demo = await runP4Demo({ rootDir: paths.dataDir, exportRoot: paths.exportDir });
    const stores = [demo.alpha, demo.beta, demo.mallory].map((op) => [op.name, op.instance.config.dbPath] as const);
    // `close()` stops the demo's HTTP servers as well as its instances — a
    // listening server left behind is an open handle that keeps the test
    // process alive after every case has passed.
    await demo.close();
    for (const [name, dbPath] of stores) assertFullyMigrated(dbPath, `demo:p4 ${name}`);
  });

  it("demo:p5 — every operator's store", async () => {
    const paths = workspace();
    const demo = await runP5Demo({ rootDir: paths.dataDir, exportRoot: paths.exportDir });
    const stores = [demo.alpha, demo.bravo, demo.gamma].map((op) => [op.name, op.instance.config.dbPath] as const);
    // `close()` stops the demo's HTTP servers as well as its instances — a
    // listening server left behind is an open handle that keeps the test
    // process alive after every case has passed.
    await demo.close();
    for (const [name, dbPath] of stores) assertFullyMigrated(dbPath, `demo:p5 ${name}`);
  });

  it("demo:p6 — every operator's store", async () => {
    const paths = workspace();
    const demo = await runP6Demo({ rootDir: paths.dataDir, exportRoot: paths.exportDir });
    const stores = [demo.atlas, demo.meridian, demo.pelican, demo.anchor, demo.harbor].map((op) => [op.name, op.instance.config.dbPath] as const);
    // `close()` stops the demo's HTTP servers as well as its instances — a
    // listening server left behind is an open handle that keeps the test
    // process alive after every case has passed.
    await demo.close();
    for (const [name, dbPath] of stores) assertFullyMigrated(dbPath, `demo:p6 ${name}`);
  });

  it("demo:p7 — every desk's store", async () => {
    const paths = workspace();
    const demo = await runP7Demo({ rootDir: paths.dataDir, exportRoot: paths.exportDir });
    const stores = Object.values(demo.desks).map((desk) => [desk.name, desk.instance.config.dbPath] as const);
    await demo.close();
    for (const [name, dbPath] of stores) assertFullyMigrated(dbPath, `demo:p7 ${name}`);
  });

  it("demo:p8", async () => {
    const paths = workspace();
    const demo = await runP8Demo({ fresh: true, config: { dataDir: paths.dataDir, exportDir: paths.exportDir } });
    const dbPath = demo.instance.config.dbPath;
    demo.instance.close();
    assertFullyMigrated(dbPath, "demo:p8");
  });
});

// ------------------------------------------------------------------- G3

describe("ADR-0032 gate — G3: backup then restore round-trips a store whose replay is byte-identical", () => {
  it("round-trips a live store: backup while open, restore into a new workspace, re-export matches", async () => {
    const { instance: source, exported: originalExport, thread } = await freshDemo();
    const backupDir = join(scratch(), "backup");

    const manifest = await backupStore(backupDir, {
      dbPath: source.config.dbPath,
      artifactDir: source.config.artifactDir,
      origin: source.config.origin,
    });
    assert.equal(manifest.schemaVersion, BINARY_SCHEMA_VERSION);
    source.close();

    const target = workspace();
    const targetConfig = loadConfig(target);
    const { restoredAt } = restoreStore(backupDir, {
      dbPath: targetConfig.dbPath,
      artifactDir: targetConfig.artifactDir,
      origin: targetConfig.origin,
    });
    assert.ok(!Number.isNaN(Date.parse(restoredAt)));

    // Keys stay a separate runbook (ADR-0026 Decision 6); copy them by hand so
    // the replayed record verifies against the keys that actually signed it.
    const { cpSync } = await import("node:fs");
    cpSync(source.config.keyDir, targetConfig.keyDir, { recursive: true });

    const restored = new AfpInstance(targetConfig, agentRegistrations(targetConfig));
    assert.equal(schemaVersion(restored.db), BINARY_SCHEMA_VERSION);

    const restorePoints = restored.db.prepare("SELECT * FROM restore_points").all();
    assert.equal(restorePoints.length, 1);

    const reExportDir = join(scratch(), "reexport");
    const reExported = exportBundle(restored, reExportDir);
    restored.close();

    const result = runVerifier(VERIFIER, reExported.dir, thread, ["--verbose"]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /PASSED/);

    const listOutbox = (dir: string): string[] => readdirSync(join(dir, "outbox")).sort();
    const originalFiles = listOutbox(originalExport.dir);
    const restoredFiles = listOutbox(reExported.dir);
    assert.deepEqual(restoredFiles, originalFiles);
    for (const file of originalFiles) {
      const original = readFileSync(join(originalExport.dir, "outbox", file), "utf8");
      const copy = readFileSync(join(reExported.dir, "outbox", file), "utf8");
      assert.equal(copy, original, `outbox/${file} differs after restore`);
    }
  });

  it("refuses to restore onto a live store, naming the pid", async () => {
    const live = await freshDemo();
    const backupDir = join(scratch(), "backup-live-src");
    await backupStore(backupDir, {
      dbPath: live.instance.config.dbPath,
      artifactDir: live.instance.config.artifactDir,
      origin: live.instance.config.origin,
    });

    assert.throws(
      () =>
        restoreStore(backupDir, {
          dbPath: live.instance.config.dbPath,
          artifactDir: live.instance.config.artifactDir,
          origin: live.instance.config.origin,
          force: true,
        }),
      (error: unknown) => error instanceof RestoreRefused && /pid \d+/.test((error as Error).message),
    );
    live.instance.close();
  });

  it("refuses a corrupt backup before anything is replaced", async () => {
    const source = await freshDemo();
    const backupDir = join(scratch(), "backup-corrupt");
    await backupStore(backupDir, {
      dbPath: source.instance.config.dbPath,
      artifactDir: source.instance.config.artifactDir,
      origin: source.instance.config.origin,
    });
    source.instance.close();

    writeFileSync(join(backupDir, "afp.db"), "not a sqlite file");

    const target = workspace();
    const targetConfig = loadConfig(target);
    const seedInstance = new AfpInstance(targetConfig, []);
    seedInstance.close();
    const before = readFileSync(targetConfig.dbPath);

    assert.throws(
      () =>
        restoreStore(backupDir, {
          dbPath: targetConfig.dbPath,
          artifactDir: targetConfig.artifactDir,
          origin: targetConfig.origin,
          force: true,
        }),
      RestoreRefused,
    );

    const after2 = readFileSync(targetConfig.dbPath);
    assert.deepEqual(after2, before, "the target store was not touched by a refused restore");
  });

  it("backupStore refuses a non-empty existing target directory", async () => {
    const source = await freshDemo();
    const dir = scratch();
    writeFileSync(join(dir, "something"), "x");
    await assert.rejects(
      () =>
        backupStore(dir, {
          dbPath: source.instance.config.dbPath,
          artifactDir: source.instance.config.artifactDir,
          origin: source.instance.config.origin,
        }),
      RestoreRefused,
    );
    source.instance.close();
  });
});

// ------------------------------------------------------------------- G4

describe("ADR-0032 gate — G4: the seat-default flip", () => {
  it("D4's own gate stays green under both settings — cited, not repeated (test/adr0017-d4-follow.test.ts)", () => {
    // adr0017-d4-follow.test.ts carries the full Follow/Accept/Undo gate under
    // an explicit seatPolicy in every case but two: the inverted default case
    // ("ADR-0032 D6: default seatPolicy is now follow-required — an Enroll
    // without a Follow is refused") and the explicit-compat case
    // ("enroll-implies-seat, set explicitly, still enrolls without any Follow
    // — the pre-flip compat proof"). Both green is this half of G4; asserting
    // it here too would just re-run that file under a different name.
    assert.ok(existsSync(join(import.meta.dirname, "adr0017-d4-follow.test.ts")));
  });

  it("every demo bundle still verifies with the new default, and an Enroll without a seat is refused", async () => {
    // demo:p2 exercises the default path end to end: the instance Follows the
    // hub before it Enrolls (src/demoP2.ts), and its bundle replays clean.
    const { instance, exported, thread } = await runP2Demo({ fresh: true, config: workspace() });
    const result = runVerifier(VERIFIER, exported.dir, thread, ["--verbose"]);
    instance.close();
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /PASSED/);
  });

  it("a replica converges membership from carried activities under the default, without ever seeing a Follow (ADR-0016 D2)", async () => {
    const leaderConfig = loadConfig({ ...workspace(), origin: "https://leader-g4.test" });
    const replicaConfig = loadConfig({ ...workspace(), origin: "https://replica-g4.test" });
    const clock = jumpClock();

    const leaderInstance = new AfpInstance(leaderConfig, [
      { spec: { name: "lead", capabilities: ["afp:cap:g4"], keyCustody: "instance", since: "2026-08-17T00:00:00Z" }, brain: { name: "lead", capabilities: ["afp:cap:g4"], handle: async () => ({ ok: true as const, content: "n/a" }) } },
    ]);
    const replicaInstance = new AfpInstance(replicaConfig, []);

    const docs = new Map<string, { [key: string]: unknown }>();
    docs.set(leaderInstance.instanceDocument().id as string, leaderInstance.instanceDocument());
    docs.set(leaderInstance.actorId("lead"), leaderInstance.agentDocument("lead"));
    const fetchActor = (actorId: string) => (docs.get(actorId) ?? null) as { [key: string]: import("../src/crypto/jcs.ts").JsonValue } | null;

    const hubLeader = new Hub({
      origin: leaderConfig.origin,
      hubId: "g4-bridge",
      db: leaderInstance.db,
      keyDir: leaderConfig.keyDir,
      instanceActorId: leaderInstance.instanceDocument().id as string,
      maxDeliveryAttempts: 5,
      backoffBaseMs: 50,
      fetchActor,
      now: () => leaderInstance.clock.now(),
      resolveActivity: (activityId) => leaderInstance.outbox.get(activityId)?.activity ?? null,
    });
    docs.set(hubLeader.actorId, hubLeader.actorDocument());

    // The default: leaderInstance Follows before it Enrolls.
    await hubLeader.receive(leaderInstance.followHub(hubLeader.actorId).activity);
    const hubKey = loadOrCreateHubKeyPair(leaderConfig.keyDir, "lead", leaderInstance.actorId("lead"), hubLeader.hubId);
    const enrollEntry = leaderInstance.publishAsInstance([hubLeader.actorId], `${leaderConfig.origin}/threads/g4`, "hub", (envelope) =>
      enroll(envelope, { agent: leaderInstance.actorId("lead"), hub: hubLeader.actorId, capabilities: ["afp:cap:g4"], hubKey: hubKey.keyId }),
    );
    await hubLeader.receive(enrollEntry.activity);
    assert.equal(hubLeader.members().length, 1, "the leader enrolled lead under the default");

    // The replica: never Followed by anyone, never sees a seat of its own —
    // seat state does not sync (ADR-0016 D2, ADR-0032 D6's build note).
    const hubReplica = new Hub({
      origin: replicaConfig.origin,
      hubId: "g4-bridge",
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
    assert.equal(hasSeat(replicaInstance.db, leaderInstance.instanceDocument().id as string), false, "the replica never received a Follow");

    await hubReplica.receive(hubLeader.pushSync(hubReplica.actorId).activity);

    assert.equal(hubReplica.members().length, 1, "the replica converged membership from the carried Enroll alone");
    assert.deepEqual(hubReplica.members(), hubLeader.members());
    assert.equal(hasSeat(replicaInstance.db, leaderInstance.instanceDocument().id as string), false, "no seat was created by the relay — only membership was re-derived");

    leaderInstance.close();
    replicaInstance.close();
  });
});

// ------------------------------------------------------------------- G5

describe("ADR-0032 gate — G5: the legacy fixture migrates 0 → BINARY_SCHEMA_VERSION", () => {
  it("a fresh store opens at version 1, recorded by name and applied_at", () => {
    const { instance } = testInstance(["writer"], "afp:cap:write");
    assert.equal(schemaVersion(instance.db), BINARY_SCHEMA_VERSION);
    const row = instance.db
      .prepare("SELECT version, name, applied_at FROM schema_version WHERE version = 1")
      .get() as { version: number; name: string; applied_at: string } | undefined;
    assert.ok(row, "schema_version has a row for version 1");
    assert.equal(row!.name, "001-baseline");
    assert.ok(!Number.isNaN(Date.parse(row!.applied_at)), "applied_at is a real instant");
    instance.close();
  });

  it("legacy store: a pre-ADR-0032 database migrates to BINARY_SCHEMA_VERSION and gains the guarded columns", async () => {
    const paths = workspace();
    mkdirSync(paths.dataDir, { recursive: true });
    const dbPath = join(paths.dataDir, "afp.db");

    const raw = new DatabaseSync(dbPath);
    raw.exec(LEGACY_SCHEMA_SQL);
    const preExisting = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").get();
    assert.equal(preExisting, undefined, "the fixture predates schema_version");
    raw.close();

    const db = openDb(dbPath);
    assert.equal(schemaVersion(db), BINARY_SCHEMA_VERSION);

    const auctionCols = new Set(
      (db.prepare("PRAGMA table_info(alloc_auctions)").all() as { name: string }[]).map((c) => c.name),
    );
    for (const col of ["reputation_json", "snapshot_json", "excluded_prior_json"]) {
      assert.ok(auctionCols.has(col), `alloc_auctions gained ${col}`);
    }

    const roundCols = new Set(
      (db.prepare("PRAGMA table_info(hub_rounds)").all() as { name: string }[]).map((c) => c.name),
    );
    for (const col of ["deadline", "quorum_rule", "binding"]) {
      assert.ok(roundCols.has(col), `hub_rounds gained ${col}`);
    }

    const voteCols = new Set(
      (db.prepare("PRAGMA table_info(hub_vote_receipts)").all() as { name: string }[]).map((c) => c.name),
    );
    for (const col of ["phase", "seq_no"]) {
      assert.ok(voteCols.has(col), `hub_vote_receipts gained ${col}`);
    }

    for (const table of ["crdt_state", "crdt_version_vector", "crdt_provenance"]) {
      const present = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      assert.ok(present, `${table} exists after migration`);
    }
    db.close();

    const { instance, thread } = await runDemo({ config: paths, clock: { now: () => new Date("2026-08-17T09:00:00.000Z") } });
    const exported = exportBundle(instance, paths.exportDir);
    instance.close();
    const result = runVerifier(VERIFIER, exported.dir, thread, ["--verbose"]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /PASSED/);
  });
});

// ------------------------------------------------------------------- G6

describe("ADR-0032 gate — G6: a newer store is refused, and the lock released", () => {
  it("schema_version above BINARY_SCHEMA_VERSION refuses to open, and releases the lock", () => {
    const paths = workspace();
    mkdirSync(paths.dataDir, { recursive: true });
    const dbPath = join(paths.dataDir, "afp.db");

    const seed = openDb(dbPath);
    seed.prepare("INSERT INTO schema_version (version, applied_at, name) VALUES (?, ?, ?)").run(
      BINARY_SCHEMA_VERSION + 1,
      new Date().toISOString(),
      "from-the-future",
    );
    seed.close();

    assert.throws(() => openDb(dbPath), StoreNewerThanBinary);
    // A refused open must not leave a lock behind: a second attempt over the
    // same too-new store fails the same way, not with StoreLocked.
    assert.throws(() => openDb(dbPath), StoreNewerThanBinary);
  });
});

// ------------------------------------------------------------------- G7

describe("ADR-0032 gate — G7: no package.json script carries --experimental-sqlite", () => {
  it("every package.json script runs without --experimental-sqlite", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    for (const [name, command] of Object.entries(pkg.scripts)) {
      assert.ok(!command.includes("--experimental-sqlite"), `script "${name}" still passes --experimental-sqlite`);
    }
  });

  it("engines.node targets the current LTS line", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as {
      engines: { node: string };
    };
    assert.equal(pkg.engines.node, ">=24");
  });

  it("this very process ran node:sqlite without --experimental-sqlite (npm test proves the runtime)", () => {
    assert.ok(existsSync(join(import.meta.dirname, "..", "src", "store", "db.ts")));
  });
});

// ------------------------------------------------------------------- G8

describe("ADR-0032 gate — G8: every shipped bundle replayed", () => {
  it("freshDemo() + runP8Demo() verifiers both PASSED (adr0029 G6's shape)", async () => {
    const fresh = await freshDemo();
    const freshResult = runVerifier(VERIFIER, fresh.exported.dir, fresh.thread, ["--verbose"]);
    fresh.instance.close();
    assert.equal(freshResult.code, 0, freshResult.output);
    assert.match(freshResult.output, /PASSED/);

    const paths = workspace();
    const p8 = await runP8Demo({ fresh: true, config: { dataDir: paths.dataDir, exportDir: paths.exportDir } });
    const p8Result = runVerifier(VERIFIER, p8.exported.dir, p8.thread, ["--verbose"]);
    p8.instance.close();
    assert.equal(p8Result.code, 0, p8Result.output);
    assert.match(p8Result.output, /PASSED/);
  });
});

// ------------------------------------------------------------------- primitives

describe("ADR-0032 primitives", () => {
  it("readSecretFile trims and refuses an empty file", () => {
    const dir = scratch();
    const path = join(dir, "secret.txt");
    writeFileSync(path, "  s3cret  \n");
    assert.equal(readSecretFile(path), "s3cret");
    writeFileSync(path, "   \n");
    assert.equal(readSecretFile(path), undefined);
  });

  it("a failed migration rolls back: schema_version is unchanged and the half-applied table is absent", () => {
    const db = new DatabaseSync(":memory:");
    const poisoned: Migration = {
      version: 2,
      name: "002-poisoned",
      up(d) {
        d.exec("CREATE TABLE half_applied (x INTEGER)");
        throw new Error("boom — the second statement never runs");
      },
    };
    const { from, to } = migrateWith(db, [MIGRATION_001]);
    assert.equal(from, 0);
    assert.equal(to, 1);

    assert.throws(() => migrateWith(db, [MIGRATION_001, poisoned]), /boom/);

    const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null };
    assert.equal(row.v, 1, "schema_version was not advanced by the failed migration");
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'half_applied'")
      .get();
    assert.equal(table, undefined, "the half-applied table was rolled back");
  });
});
