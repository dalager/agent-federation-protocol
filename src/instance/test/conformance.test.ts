/**
 * Spec conformance beyond the acceptance gate.
 *
 * Each test here exists because a review of the P1 implementation against the
 * spec found it missing: admission recorded as activities, a byte-stable
 * roster, deadline sweeps, and provenance for evidence from outside AFP.
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

describe("spec conformance — findings from the P1 review", () => {
  it("admission is on the record: the roster is derived from a Vouch trail", async () => {
    const { instance } = await freshDemo();
    const instanceUrl = String(instance.instanceDocument().id);

    const vouches = instance.outbox
      .byActor(instanceUrl)
      .filter((entry) => entry.activity.type === "afp:Vouch");
    assert.equal(vouches.length, instance.specs.length,
      "every agent should have a signed Vouch, not a config entry");

    // The roster is a projection of that trail, not a source of truth.
    const roster = instance.rosterDocument();
    const rostered = (roster.orderedItems as Record<string, string>[]).map((e) => e.agent).sort();
    const vouched = vouches.map((v) => String((v.activity.object as Record<string, string>).agent)).sort();
    assert.deepEqual(rostered, vouched);

    // Disowning is equally on the record, and the projection follows it.
    instance.disownAgent("reviewer", "no longer in service");
    const after = (instance.rosterDocument().orderedItems as Record<string, string>[]).map((e) => e.agent);
    assert.ok(!after.some((a) => a.endsWith("/reviewer")), "Disown did not remove the entry");
    instance.close();
  });

  it("the roster is byte-stable between reads", async () => {
    const { instance } = await freshDemo();
    const first = JSON.stringify(instance.rosterDocument());
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = JSON.stringify(instance.rosterDocument());
    assert.equal(first, second,
      "regenerating the roster with a fresh timestamp makes tampering indistinguishable from noise");
    instance.close();
  });

  it("a deadline that passes with no outcome becomes a recorded afp:Error", async () => {
    const paths = workspace();
    const config = loadConfig(paths);
    const instance = new AfpInstance(config, agentRegistrations(config), fixedClock());

    // Offer a task whose deadline is already in the past, and never deliver it:
    // "thinking" and "dead" are indistinguishable, so the delegator must decide.
    instance.delegate({
      from: "writer", to: "reviewer", capability: "afp:cap:review",
      content: "review", thread: `${config.origin}/threads/late`, correlationId: "task-late",
      deadline: "2020-01-01T00:00:00.000Z",
    });

    assert.equal(instance.sweepOverdue(), 1, "the overdue task was not swept");
    const errors = instance.outbox
      .byActor(instance.actorId("writer"))
      .filter((entry) => objectType(entry.activity) === "afp:Error");
    assert.equal(errors.length, 1);
    assert.match(String(errorCode(errors[0].activity)), /deadline-missed/);
    assert.equal(instance.tasks.get("task-late")?.state, "failed");
    instance.close();
  });

  it("evidence from outside AFP carries its source provenance", async () => {
    const { instance } = await freshDemo();
    const links = instance.specs
      .flatMap((spec) => instance.outbox.byActor(instance.actorId(spec.name)))
      .flatMap((entry) => attachmentsOf(entry.activity));

    const external = instance.artifacts.all().filter((ref) => ref.sourceUrl);
    assert.ok(external.length > 0, "the operator's brief should record where it came from");
    for (const ref of external) {
      assert.ok(ref.fetchedAt, `${ref.digest} has a sourceUrl but no fetchedAt`);
    }
    assert.ok(links.length > 0);
    instance.close();
  });

  it("the instance's own outbox is part of the export", async () => {
    const { instance, exported } = await freshDemo();
    const path = join(exported.dir, "outbox", "instance.jsonld");
    const outbox = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(outbox.attributedTo, String(instance.instanceDocument().id));
    assert.ok(outbox.orderedItems.length > 0,
      "without the instance outbox a reader sees who is on the roster but not how");
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
      signer: fileSigner(key),
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
