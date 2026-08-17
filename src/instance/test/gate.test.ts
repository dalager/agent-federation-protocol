/**
 * The P1 acceptance gate — all eleven checks from 05-roadmap.md.
 *
 * This file is the phase's definition of done. Each test is named for the gate
 * item it discharges, and the last one shells out to the *independent* Python
 * verifier: if the two implementations ever disagree, that is the finding.
 *
 *   node --experimental-sqlite --test test/gate.test.ts
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

import { loadConfig } from "../src/config.ts";
import { AfpInstance } from "../src/instance.ts";
import { agentRegistrations, fixedClock, runDemo } from "../src/demo.ts";
import { makeFailingBrain } from "../src/brains/stub.ts";
import { attachProof, verifyProof } from "../src/crypto/proof.ts";
import { publicKeyFromMultibase, loadOrCreateKeyPair } from "../src/crypto/keys.ts";
import { exportBundle } from "../src/export.ts";
import type { JsonValue } from "../src/crypto/jcs.ts";

const workspaces: string[] = [];

function workspace(): { dataDir: string; exportDir: string } {
  const root = mkdtempSync(join(tmpdir(), "afp-gate-"));
  workspaces.push(root);
  return { dataDir: join(root, "data"), exportDir: join(root, "export") };
}

after(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

/** A full demo run in an isolated workspace. */
async function freshDemo() {
  const paths = workspace();
  return runDemo({ fresh: true, config: paths, clock: fixedClock() });
}

describe("P1 acceptance gate", () => {
  it("1 — a repeated correlationId replays the cached Result; the brain runs once", async () => {
    const paths = workspace();
    const config = loadConfig(paths);
    const agents = agentRegistrations(config);
    const reviewer = agents.find((a) => a.spec.name === "reviewer")!;
    const instance = new AfpInstance(config, agents, fixedClock());

    const thread = "urn:afp:thread:replay";
    instance.delegate({
      from: "writer", to: "reviewer", capability: "afp:cap:review",
      content: "review this", thread, correlationId: "task-r1",
    });
    await instance.run();

    const invocationsAfterFirst = (reviewer.brain as { invocations: number }).invocations;
    const resultsAfterFirst = countResults(instance, "reviewer");

    // Same task, genuinely new activity id — layer 1 cannot catch this, only
    // the correlationId replay in layer 2 can.
    instance.delegate({
      from: "writer", to: "reviewer", capability: "afp:cap:review",
      content: "review this", thread, correlationId: "task-r1",
    });
    await instance.run();

    assert.equal(
      (reviewer.brain as { invocations: number }).invocations,
      invocationsAfterFirst,
      "brain was invoked a second time for a correlationId it had already answered",
    );
    assert.equal(countResults(instance, "reviewer"), resultsAfterFirst,
      "a second Result was published for the same task");
    instance.close();
  });

  it("2 — a redelivered activity id is dropped before dispatch", async () => {
    const paths = workspace();
    const config = loadConfig(paths);
    const agents = agentRegistrations(config);
    const reviewer = agents.find((a) => a.spec.name === "reviewer")!;
    const instance = new AfpInstance(config, agents, fixedClock());

    const entry = instance.delegate({
      from: "writer", to: "reviewer", capability: "afp:cap:review",
      content: "review this", thread: "urn:afp:thread:dupe", correlationId: "task-d1",
    });
    await instance.run();
    const invocations = (reviewer.brain as { invocations: number }).invocations;

    const outcome = await instance.receive(entry.activity);
    assert.equal(outcome.status, "duplicate", "redelivered activity id was not recognised");
    assert.equal((reviewer.brain as { invocations: number }).invocations, invocations,
      "a redelivered activity reached dispatch");
    assert.ok(instance.auditLog().some((row) => row.outcome === "duplicate"),
      "the duplicate was not audit-logged");
    instance.close();
  });

  it("3 — an unsigned or badly-signed delivery is dropped and audit-logged", async () => {
    const paths = workspace();
    const config = loadConfig(paths);
    const instance = new AfpInstance(config, agentRegistrations(config), fixedClock());

    const entry = instance.delegate({
      from: "writer", to: "reviewer", capability: "afp:cap:review",
      content: "review this", thread: "urn:afp:thread:sig", correlationId: "task-s1",
    });
    await instance.run();

    const unsigned = { ...entry.activity, id: `${entry.activityId}-unsigned` };
    delete (unsigned as Record<string, unknown>).proof;
    const unsignedOutcome = await instance.receive(unsigned);
    assert.equal(unsignedOutcome.status, "rejected");

    // A single altered character invalidates the proof.
    const tampered = JSON.parse(JSON.stringify(entry.activity)) as Record<string, JsonValue>;
    tampered.id = `${entry.activityId}-tampered`;
    (tampered.object as Record<string, JsonValue>).content = "review something else entirely";
    const tamperedOutcome = await instance.receive(tampered);
    assert.equal(tamperedOutcome.status, "rejected", "a tampered activity was accepted");

    const log = instance.auditLog().filter((row) => row.outcome === "rejected");
    assert.ok(log.length >= 2, `expected both drops in the audit log, found ${log.length}`);
    instance.close();
  });

  it("4 — an exhausted delivery dead-letters and surfaces as a local afp:Error", async () => {
    const paths = workspace();
    const config = loadConfig({ ...paths, maxDeliveryAttempts: 3, backoffBaseMs: 1 });
    const agents = agentRegistrations(config);
    const instance = new AfpInstance(config, agents, fixedClock());

    instance.delegate({
      from: "writer", to: "reviewer", capability: "afp:cap:review",
      content: "review this", thread: "urn:afp:thread:dead", correlationId: "task-x1",
    });

    // A transport that always fails — the network being down, in P1 terms.
    let attempts = 0;
    await instance.run({
      name: "always-fails",
      deliver: async () => {
        attempts++;
        throw new Error("connection refused");
      },
    });

    assert.equal(attempts, config.maxDeliveryAttempts, "delivery did not retry to the limit");
    assert.equal(instance.queue.stats().dead, 1, "the exhausted delivery was not dead-lettered");

    const errors = instance.outbox
      .byActor(instance.actorId("writer"))
      .filter((entry) => objectType(entry.activity) === "afp:Error");
    assert.equal(errors.length, 1, "dead-lettering did not surface as an afp:Error");
    assert.match(String(errorCode(errors[0].activity)), /undeliverable/);
    instance.close();
  });

  it("5 — every published activity declares a visibility class, and none defaults to public", async () => {
    const { instance } = await freshDemo();
    const entries = instance.specs.flatMap((spec) =>
      instance.outbox.byActor(instance.actorId(spec.name)),
    );
    assert.ok(entries.length > 0);

    for (const entry of entries) {
      assert.equal(typeof entry.activity["afp:visibility"], "string",
        `${entry.activityId} has no afp:visibility`);
      assert.notEqual(entry.visibility, "public",
        `${entry.activityId} defaulted to public — task traffic must not be world-readable`);
    }

    // And the builder refuses to produce one without a class at all.
    assert.throws(() => instance.outbox.append({ id: "urn:x", actor: "urn:y", proof: {} as JsonValue }),
      /afp:visibility/);
    instance.close();
  });

  it("6 — attachments carry a digest, and non-matching bytes are discarded", async () => {
    const { instance } = await freshDemo();

    const links = instance.specs
      .flatMap((spec) => instance.outbox.byActor(instance.actorId(spec.name)))
      .flatMap((entry) => attachmentsOf(entry.activity));
    assert.ok(links.length > 0, "the demo produced no attachments to check");
    for (const link of links) {
      assert.match(String(link["afp:digest"]), /^sha256:[0-9a-f]{64}$/);
    }

    // Corrupt the stored bytes; the store must refuse to hand them back.
    const ref = instance.artifacts.all()[0];
    assert.ok(instance.artifacts.get(ref.digest), "artifact should read back cleanly first");
    const path = join(instance.config.artifactDir, ref.digest.replace(":", "-"));
    const bytes = readFileSync(path);
    bytes[0] ^= 0x01;
    writeFileSync(path, bytes);
    assert.equal(instance.artifacts.get(ref.digest), null,
      "a fetch returning non-matching bytes was not discarded");
    instance.close();
  });

  it("7 — each outbox is an unbroken chain from its first activity, and a gap is detectable", async () => {
    const { instance } = await freshDemo();

    for (const spec of instance.specs) {
      const entries = instance.outbox.byActor(instance.actorId(spec.name));
      assert.ok(entries.length > 0);
      assert.equal(entries[0].prevActivity, null,
        `${spec.name}'s first activity claims a predecessor`);

      for (let i = 1; i < entries.length; i++) {
        assert.equal(entries[i].prevActivity, entries[i - 1].digest,
          `${spec.name}'s chain breaks at seq ${entries[i].seq}`);
      }

      // Removing any link is visible from the chain alone.
      if (entries.length >= 3) {
        const withGap = [entries[0], ...entries.slice(2)];
        assert.notEqual(withGap[1].prevActivity, withGap[0].digest,
          "a removed activity left the chain looking intact");
      }
    }
    instance.close();
  });

  it("8 — the thread is grouped by context, and no correlationId is reused across tasks", async () => {
    const { instance, thread } = await freshDemo();
    const entries = instance.outbox.byThread(thread);
    assert.ok(entries.length >= 6, `expected the full thread, got ${entries.length}`);

    for (const entry of entries) {
      assert.equal(entry.activity.context, thread);
    }

    // Two distinct tasks share one context — which is exactly the split the
    // spec forced after scenario 02, so the ids must not be the same value.
    const correlationIds = new Set(
      entries.map((entry) => correlationOf(entry.activity)).filter(Boolean),
    );
    assert.ok(correlationIds.size >= 2,
      "the demo's two tasks should carry two distinct correlationIds");
    assert.ok(!correlationIds.has(thread), "a correlationId was reused as the thread id");
    instance.close();
  });

  it("9 — the roster verifies as a whole from a cached copy, with no live roundtrip", async () => {
    const { instance } = await freshDemo();

    // "Cached copy": serialize it, drop the instance, verify from bytes alone.
    const cached = JSON.parse(JSON.stringify(instance.rosterDocument()));
    const instanceDoc = instance.instanceDocument();
    const method = (instanceDoc.assertionMethod as Record<string, string>[])[0];
    instance.close();

    const publicKey = publicKeyFromMultibase(method.publicKeyMultibase);
    assert.equal(verifyProof(cached, publicKey).ok, true, "the cached roster did not verify");

    cached.orderedItems.push({ type: "afp:RosterEntry", agent: "https://evil.example/agents/x" });
    assert.equal(verifyProof(cached, publicKey).ok, false,
      "an agent was added to the roster without breaking its signature");
  });

  it("10 — an independent verifier passes the clean export and fails each mutation", async () => {
    const { exported, thread } = await freshDemo();
    const verifier = join(import.meta.dirname, "..", "..", "verifier", "afp_verify.py");

    const clean = runVerifier(verifier, exported.dir, thread);
    assert.equal(clean.code, 0, `clean export failed to verify:\n${clean.output}`);
    assert.match(clean.output, /PASSED/);

    // Mutation A — flip one byte of archived evidence.
    const flipped = join(workspace().dataDir, "flipped");
    cpSync(exported.dir, flipped, { recursive: true });
    const artifactDir = join(flipped, "artifacts");
    const artifact = join(artifactDir, readdirSync(artifactDir)[0]);
    const bytes = readFileSync(artifact);
    bytes[0] ^= 0x01;
    writeFileSync(artifact, bytes);

    const tamperedArtifact = runVerifier(verifier, flipped, thread);
    assert.equal(tamperedArtifact.code, 1, "a flipped evidence byte was not detected");
    assert.match(tamperedArtifact.output, /matches its digest/);

    // Mutation B — remove one activity from the middle of an outbox.
    const gapped = join(workspace().dataDir, "gapped");
    cpSync(exported.dir, gapped, { recursive: true });
    const outboxPath = join(gapped, "outbox", "writer.jsonld");
    const outbox = JSON.parse(readFileSync(outboxPath, "utf8"));
    outbox.orderedItems.splice(1, 1);
    outbox.totalItems = outbox.orderedItems.length;
    writeFileSync(outboxPath, JSON.stringify(outbox, null, 2));

    const gappedResult = runVerifier(verifier, gapped, thread);
    assert.equal(gappedResult.code, 1, "a removed activity was not detected");
    assert.match(gappedResult.output, /links to its predecessor/);
  });

  it("11 — the record carries no trace of in-process wiring", async () => {
    const { instance, exported } = await freshDemo();
    const origin = instance.config.origin;

    const entries = instance.specs.flatMap((spec) =>
      instance.outbox.byActor(instance.actorId(spec.name)),
    );
    for (const entry of entries) {
      const activity = entry.activity;
      for (const field of ["id", "actor"]) {
        assert.ok(String(activity[field]).startsWith(origin),
          `${field} of ${entry.activityId} is not a published URL under ${origin}`);
      }
      assert.deepEqual(activity["@context"], [
        "https://www.w3.org/ns/activitystreams",
        "https://afp.example/ns/v3",
        "https://w3id.org/security/data-integrity/v1",
      ]);
      // A federated record would look identical; nothing may hint at transport,
      // process, host, or local paths.
      const serialized = JSON.stringify(activity);
      for (const leak of ["localhost", "127.0.0.1", "in-process", "inProcess", "file://", "/tmp/"]) {
        assert.ok(!serialized.includes(leak), `${entry.activityId} leaks ${leak}`);
      }
      assert.equal(activity.transport, undefined);
    }

    // The exported bundle must not carry key material either.
    const manifest = readFileSync(join(exported.dir, "MANIFEST.json"), "utf8");
    assert.ok(!manifest.includes("PRIVATE"), "the export mentions private key material");
    for (const spec of instance.specs) {
      const doc = readFileSync(join(exported.dir, "actors", `${spec.name}.jsonld`), "utf8");
      assert.ok(!doc.includes("PRIVATE KEY"), `${spec.name}'s actor document contains a private key`);
    }
    instance.close();
  });
});

describe("cryptosuite", () => {
  it("round-trips a proof and rejects a modified document", () => {
    const paths = workspace();
    const key = loadOrCreateKeyPair(paths.dataDir, "t", "https://example.test/actor");
    const doc: { [key: string]: JsonValue } = {
      "@context": ["https://www.w3.org/ns/activitystreams"],
      id: "https://example.test/a/1",
      type: "Create",
      content: "hello",
    };

    const signed = attachProof(doc, {
      privateKey: key.privateKey,
      verificationMethod: key.keyId,
      created: "2026-08-17T09:00:00.000Z",
    });
    const publicKey = publicKeyFromMultibase(key.publicKeyMultibase);

    assert.equal(verifyProof(signed, publicKey).ok, true);
    assert.equal(verifyProof({ ...signed, content: "goodbye" }, publicKey).ok, false);
    // Key order must not matter — canonicalization is the whole point.
    const reordered: Record<string, JsonValue> = {};
    for (const key of Object.keys(signed).reverse()) {
      reordered[key] = (signed as Record<string, JsonValue>)[key];
    }
    assert.notDeepEqual(Object.keys(reordered), Object.keys(signed), "keys were not reordered");
    assert.equal(verifyProof(reordered, publicKey).ok, true,
      "a proof stopped verifying when its document's keys were reordered");
  });
});

// ------------------------------------------------------------------- helpers

function runVerifier(script: string, dir: string, thread: string) {
  try {
    const output = execFileSync("python3", [script, dir, "--thread", thread], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

function objectType(activity: { [key: string]: JsonValue }): string {
  const object = activity.object;
  return object && typeof object === "object" && !Array.isArray(object)
    ? String((object as Record<string, JsonValue>).type ?? "")
    : "";
}

function errorCode(activity: { [key: string]: JsonValue }): JsonValue | undefined {
  const object = activity.object as Record<string, JsonValue> | undefined;
  return object?.["afp:errorCode"];
}

function correlationOf(activity: { [key: string]: JsonValue }): string {
  const direct = activity["afp:correlationId"];
  if (typeof direct === "string") return direct;
  const object = activity.object as Record<string, JsonValue> | undefined;
  const nested = object?.["afp:correlationId"];
  return typeof nested === "string" ? nested : "";
}

function attachmentsOf(activity: { [key: string]: JsonValue }): Record<string, JsonValue>[] {
  const object = activity.object as Record<string, JsonValue> | undefined;
  const attachment = object?.attachment;
  return Array.isArray(attachment) ? (attachment as Record<string, JsonValue>[]) : [];
}

function countResults(instance: AfpInstance, actorName: string): number {
  return instance.outbox
    .byActor(instance.actorId(actorName))
    .filter((entry) => objectType(entry.activity) === "afp:Result").length;
}
