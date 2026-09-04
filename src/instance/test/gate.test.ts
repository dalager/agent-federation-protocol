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
import { cpSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "../src/config.ts";
import { AfpInstance } from "../src/instance.ts";
import { agentRegistrations, fixedClock } from "../src/demo.ts";
import {
  attachmentsOf,
  cleanupWorkspaces,
  correlationOf,
  countResults,
  errorCode,
  freshDemo,
  objectType,
  runVerifier,
  workspace,
} from "./helpers.ts";

import { makeFailingBrain } from "../src/brains/stub.ts";
import { attachProof, verifyProof } from "../src/crypto/proof.ts";
import { publicKeyFromMultibase, loadOrCreateKeyPair } from "../src/crypto/keys.ts";
import { exportBundle } from "../src/export.ts";
import type { JsonValue } from "../src/crypto/jcs.ts";
import { fileSigner } from "../src/crypto/signer.ts";

after(cleanupWorkspaces);

describe("P1 acceptance gate", () => {
  it("1 — a repeated correlationId replays the cached Result; the brain runs once", async () => {
    const paths = workspace();
    const config = loadConfig(paths);
    const agents = agentRegistrations(config);
    const reviewer = agents.find((a) => a.spec.name === "reviewer")!;
    const instance = new AfpInstance(config, agents, fixedClock());

    const thread = `${config.origin}/threads/replay`;
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
      content: "review this", thread: `${config.origin}/threads/dupe`, correlationId: "task-d1",
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
      content: "review this", thread: `${config.origin}/threads/sig`, correlationId: "task-s1",
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
      content: "review this", thread: `${config.origin}/threads/dead`, correlationId: "task-x1",
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

  it("10 — an independent verifier passes the clean export and fails all four mutations", async () => {
    const { instance, exported, thread } = await freshDemo();
    const config = instance.config;
    const verifier = join(import.meta.dirname, "..", "..", "verifier", "afp_verify.py");

    const clean = runVerifier(verifier, exported.dir, thread);
    assert.equal(clean.code, 0, `clean export failed to verify:\n${clean.output}`);
    assert.match(clean.output, /PASSED/);

    const mutate = (name: string): string => {
      const dir = join(workspace().dataDir, name);
      cpSync(exported.dir, dir, { recursive: true });
      return dir;
    };

    // A — flip one byte of archived evidence. Tests integrity.
    const flipped = mutate("flipped");
    const artifact = join(flipped, "artifacts", readdirSync(join(flipped, "artifacts"))[0]);
    const bytes = readFileSync(artifact);
    bytes[0] ^= 0x01;
    writeFileSync(artifact, bytes);
    const flippedResult = runVerifier(verifier, flipped, thread);
    assert.equal(flippedResult.code, 1, "a flipped evidence byte was not detected");
    assert.match(flippedResult.output, /matches its digest/);

    // B — remove one activity from the middle of an outbox. Tests log completeness.
    const gapped = mutate("gapped");
    const gappedPath = join(gapped, "outbox", "reviewer.jsonld");
    const gappedOutbox = JSON.parse(readFileSync(gappedPath, "utf8"));
    gappedOutbox.orderedItems.splice(1, 1);
    gappedOutbox.totalItems = gappedOutbox.orderedItems.length;
    writeFileSync(gappedPath, JSON.stringify(gappedOutbox, null, 2));
    const gappedResult = runVerifier(verifier, gapped, thread);
    assert.equal(gappedResult.code, 1, "a removed activity was not detected");
    assert.match(gappedResult.output, /links to its predecessor/);

    // C — re-sign the TAIL of an outbox with another agent's published key.
    // The chain cannot catch this: the last activity has no successor to break.
    // Only the roster's authority rule can (04 § Signature is not authority).
    const forged = mutate("forged");
    const reviewerKey = loadOrCreateKeyPair(
      config.keyDir,
      "reviewer",
      instance.actorId("reviewer"),
    );
    const forgedPath = join(forged, "outbox", "writer.jsonld");
    const forgedOutbox = JSON.parse(readFileSync(forgedPath, "utf8"));
    const tail = forgedOutbox.orderedItems.length - 1;
    const activity = JSON.parse(JSON.stringify(forgedOutbox.orderedItems[tail]));
    delete activity.proof;
    activity.object.content = "FORGED: approved, ship it.";
    forgedOutbox.orderedItems[tail] = attachProof(activity, {
      signer: fileSigner(reviewerKey),
      created: String(activity.published),
    });
    writeFileSync(forgedPath, JSON.stringify(forgedOutbox, null, 2));
    const forgedResult = runVerifier(verifier, forged, thread);
    assert.equal(forgedResult.code, 1, "a tail activity re-signed with another key was accepted");
    assert.match(forgedResult.output, /no authority over/);

    // D — delete a whole agent's outbox. Chains are per-actor, so no surviving
    // chain has a gap; only the roster shows the participant is missing.
    const erased = mutate("erased");
    rmSync(join(erased, "outbox", "writer.jsonld"));
    const erasedResult = runVerifier(verifier, erased, thread);
    assert.equal(erasedResult.code, 1, "a deleted participant was not detected");
    assert.match(erasedResult.output, /is on the signed roster but contributes no outbox/);

    instance.close();
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
        "https://dalager.github.io/agent-federation-protocol/ns/v3.jsonld",
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
