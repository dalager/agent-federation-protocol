/**
 * ADR-0015 gate: the case file at N parties.
 *
 * Four claims, each with the mutation that proves its check discriminates:
 *
 *  1. Cross-receiver consistency — two domains holding received copies of one
 *     sender activity must hold the same bytes as *each other*, the finding
 *     only the holder of the full set can see (N1). A three-bundle joint
 *     replay passes clean when they agree, which is also the first asserted
 *     N=3 joint in this repository.
 *  2. A foreign member's decline resolves as received bytes (N2): the hub
 *     host's bundle carries the member's Reject in received.jsonld, the
 *     declined-check reads the pool, and stripping the received evidence
 *     fails by name.
 *  3. An archived hub's carried state recomputes to its declared canon (N4);
 *     tampered state under standing hashes fails by name.
 *  4. The census prints zeros for conditional families that never ran —
 *     absence made visible rather than implied (N3).
 *
 *   node --experimental-sqlite --test test/adr0015.test.ts
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, describe, it } from "node:test";

import type { JsonValue } from "../src/crypto/jcs.ts";
import { digestOf } from "../src/crypto/proof.ts";
import { createResult, vouch } from "../src/ap/activities.ts";
import { castVote, enroll } from "../src/hub/activities.ts";
import { Hub } from "../src/hub/hub.ts";
import { agreementObject, createAgreement } from "../src/federation/federation.ts";
import { loadOrCreateHubKeyPair } from "../src/crypto/keys.ts";
import { exportBundle } from "../src/export.ts";
import { cleanupWorkspaces, mutateBundle, runVerifier, testInstance } from "./helpers.ts";
import { VERIFIER } from "./adr0010-fixtures.ts";

after(cleanupWorkspaces);

const CAPABILITY = "afp:cap:assess";

/** The N-dir form of runVerifier — the joint replay takes the whole set. */
function jointVerify(dirs: string[]): { code: number; output: string } {
  try {
    const output = execFileSync("python3", [VERIFIER, ...dirs, "--verbose"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("ADR-0015: the case file at N parties", () => {
  it("received copies must agree across receivers — the auditor's own check", async () => {
    // One sender, two receivers, three bundles. The sender's activity is
    // lawfully out of the sender's own scoped export; each receiver holds the
    // copy it was sent. When the copies agree, the three-bundle joint replay
    // is clean. When they diverge, the sender told two stories — and each
    // receiver alone can prove nothing, which is why the check belongs to
    // whoever holds the set.
    const sender = testInstance(["src"], CAPABILITY, "https://sender.example");
    const receiverA = testInstance(["ra"], CAPABILITY, "https://receiver-a.example");
    const receiverB = testInstance(["rb"], CAPABILITY, "https://receiver-b.example");

    const shared = "urn:afp:thread:engagement";
    const own = "urn:afp:thread:other-client";
    const sent = sender.instance.publish("src", [], shared, "parties", (envelope) =>
      createResult(envelope, { resultId: "urn:afp:result:view", correlationId: "view-1", content: "the leak originates at AS64500" }),
    );
    sender.instance.publish("src", [], own, "parties", (envelope) =>
      createResult(envelope, { resultId: "urn:afp:result:other", correlationId: "other-1", content: "unrelated" }),
    );
    // The sender's export is scoped to its other work: the shared-thread
    // activity becomes a stub, exactly ADR-0009's lawful redaction.
    const senderDir = mkdtempSync(join(tmpdir(), "afp-15-sender-"));
    exportBundle(sender.instance, senderDir, [], { threads: [own], omitActors: [] });

    const receivedBy = (copy: { [key: string]: JsonValue }) => ({
      receivedActivities: () => [
        { digest: digestOf(copy), fromInstance: String(sender.instance.instanceDocument().id), activity: copy },
      ],
    });
    const dirA = mkdtempSync(join(tmpdir(), "afp-15-ra-"));
    const dirB = mkdtempSync(join(tmpdir(), "afp-15-rb-"));
    exportBundle(receiverA.instance, dirA, [], undefined, receivedBy(sent.activity));

    // Clean control first: B holds the same bytes.
    exportBundle(receiverB.instance, dirB, [], undefined, receivedBy(sent.activity));
    const clean = jointVerify([senderDir, dirA, dirB]);
    assert.equal(clean.code, 0, `three-bundle joint failed:\n${clean.output}`);
    assert.match(clean.output, /joint: received copies of .* agree across receivers/);

    // The divergence: B's copy is the same activity id with different bytes.
    const twisted = JSON.parse(JSON.stringify(sent.activity)) as { [key: string]: JsonValue };
    (twisted.object as { [key: string]: JsonValue }).content = "the leak originates at AS64501 — a different culprit";
    const dirB2 = mkdtempSync(join(tmpdir(), "afp-15-rb2-"));
    exportBundle(receiverB.instance, dirB2, [], undefined, receivedBy(twisted));
    const diverged = jointVerify([senderDir, dirA, dirB2]);
    assert.notEqual(diverged.code, 0);
    assert.match(diverged.output, /FAIL \] joint: received copies of .* agree across receivers/);

    sender.instance.close();
    receiverA.instance.close();
    receiverB.instance.close();
  });

  it("a foreign member's decline resolves as received bytes, and only as evidence", async () => {
    const alpha = testInstance(["n-noc", "n-telemetry"], CAPABILITY, "https://alpha-host.example");
    const bravo = testInstance(["s-noc"], CAPABILITY, "https://bravo-member.example");
    const bravoActor = String(bravo.instance.instanceDocument().id);
    const snoc = bravo.instance.actorId("s-noc");

    const docCache = new Map<string, { [key: string]: JsonValue }>();
    const hub = new Hub({
      origin: alpha.config.origin,
      hubId: "bridge",
      db: alpha.instance.db,
      keyDir: alpha.config.keyDir,
      instanceActorId: String(alpha.instance.instanceDocument().id),
      maxDeliveryAttempts: alpha.config.maxDeliveryAttempts,
      backoffBaseMs: alpha.config.backoffBaseMs,
      fetchActor: (actorId) => docCache.get(actorId) ?? null,
      now: () => alpha.clock.now(),
    });
    for (const [inst, name] of [
      [alpha, "n-noc"],
      [alpha, "n-telemetry"],
      [bravo, "s-noc"],
    ] as const) {
      docCache.set(String(inst.instance.instanceDocument().id), inst.instance.instanceDocument());
      docCache.set(inst.instance.actorId(name), inst.instance.agentDocument(name));
      const hubKey = loadOrCreateHubKeyPair(inst.config.keyDir, name, inst.instance.actorId(name), "bridge");
      const entry = inst.instance.publishAsInstance([hub.actorId], "urn:afp:thread:enroll", "hub", (envelope) =>
        enroll(envelope, { agent: inst.instance.actorId(name), hub: hub.actorId, capabilities: [CAPABILITY], hubKey: hubKey.keyId }),
      );
      await hub.receive(entry.activity);
    }

    // The cross-boundary hub traffic needs its agreement on alpha's record —
    // the federation checks enforce scenario 10's own cast list.
    const object = agreementObject({
      parties: [String(alpha.instance.instanceDocument().id), bravoActor],
      grants: [{ "afp:grantType": "hub", "afp:hub": hub.actorId }],
      expires: new Date(alpha.clock.now().getTime() + 6 * 3600_000).toISOString(),
    });
    const alphaCreate = alpha.instance.publishAsInstance([bravoActor], "urn:afp:thread:fed", "parties", (envelope) =>
      createAgreement(envelope, object),
    );
    void alphaCreate;

    const thread = "urn:afp:thread:sev1";
    const proposal = hub.proposeRound({ round: "urn:afp:round:sev1", thread, question: "sev-1?", options: ["yes", "no"] });
    const proposalId = String((proposal.activity.object as Record<string, unknown>).id);
    const snapshot = String((proposal.activity.object as Record<string, unknown>)["afp:quorumSnapshot"]);
    await hub.receive(
      alpha.instance.publish("n-noc", [hub.actorId], thread, "hub", (envelope) =>
        castVote(envelope, { voteId: `${envelope.actor}/votes/sev1`, round: "urn:afp:round:sev1", proposalHash: proposal.digest, quorumSnapshot: snapshot, value: "yes" }),
      ).activity,
    );
    await hub.receive(
      alpha.instance.publish("n-telemetry", [hub.actorId], thread, "hub", (envelope) =>
        castVote(envelope, { voteId: `${envelope.actor}/votes/sev1`, round: "urn:afp:round:sev1", proposalHash: proposal.digest, quorumSnapshot: snapshot, value: "yes" }),
      ).activity,
    );
    // Bravo's member declines — a genuinely foreign-signed Reject.
    const reject = bravo.instance.publish("s-noc", [hub.actorId], thread, "hub", (envelope) =>
      ({
        "@context": ["https://www.w3.org/ns/activitystreams", "https://afp.example/ns/v3"],
        id: envelope.activityId,
        type: "Reject",
        actor: envelope.actor,
        to: [...envelope.to],
        published: envelope.published,
        context: envelope.thread,
        "afp:visibility": envelope.visibility,
        ...(envelope.prevActivity !== null ? { "afp:prevActivity": envelope.prevActivity } : {}),
        object: proposalId,
        summary: "cannot assent from here",
      }) as never,
    );
    await hub.receive(reject.activity);
    const decision = hub.closeRound("urn:afp:round:sev1");
    const uncounted = (decision.activity.object as Record<string, unknown>)["afp:uncounted"] as { agent: string; "afp:status": string }[];
    assert.equal(uncounted.length, 1);
    assert.equal(uncounted[0].agent, snoc);
    assert.equal(uncounted[0]["afp:status"], "declined");

    alpha.instance.publish("n-noc", [], thread, "parties", (envelope) =>
      createResult(envelope, { resultId: "urn:afp:result:sev1", correlationId: "sev1", content: "closed" }),
    );
    alpha.instance.publishAsInstance([], "urn:afp:thread:roster", "public", (envelope) =>
      vouch(envelope, { agent: hub.actorId, capabilities: ["afp:cap:hub"], keyCustody: "self" }),
    );

    // With the Reject as received evidence: the declined-check resolves it.
    const withReceived = mkdtempSync(join(tmpdir(), "afp-15-decl-"));
    exportBundle(alpha.instance, withReceived, [hub], undefined, {
      receivedActivities: () => [{ digest: digestOf(reject.activity), fromInstance: bravoActor, activity: reject.activity }],
    });
    const clean = runVerifier(VERIFIER, withReceived, thread, ["--verbose"]);
    assert.equal(clean.code, 0, `verifier failed:\n${clean.output}`);
    assert.match(clean.output, /decision: .*declined members declined on the record/);

    // Without it: a decline the bundle cannot produce.
    const without = mkdtempSync(join(tmpdir(), "afp-15-decl2-"));
    exportBundle(alpha.instance, without, [hub]);
    const stripped = runVerifier(VERIFIER, without, thread, ["--verbose"]);
    assert.notEqual(stripped.code, 0);
    assert.match(stripped.output, /FAIL \] decision: .*declined members declined on the record/);

    alpha.instance.close();
    bravo.instance.close();
  });

  it("an archived hub's carried state recomputes to its canon — and the census shows its zeros", async () => {
    const { instance, config, clock } = testInstance(["a1"], CAPABILITY);
    const docCache = new Map<string, { [key: string]: JsonValue }>();
    const hub = new Hub({
      origin: config.origin,
      hubId: "done",
      db: instance.db,
      keyDir: config.keyDir,
      instanceActorId: String(instance.instanceDocument().id),
      maxDeliveryAttempts: config.maxDeliveryAttempts,
      backoffBaseMs: config.backoffBaseMs,
      fetchActor: (actorId) => docCache.get(actorId) ?? null,
      now: () => clock.now(),
    });
    docCache.set(String(instance.instanceDocument().id), instance.instanceDocument());
    docCache.set(instance.actorId("a1"), instance.agentDocument("a1"));
    const hubKey = loadOrCreateHubKeyPair(config.keyDir, "a1", instance.actorId("a1"), "done");
    const entry = instance.publishAsInstance([hub.actorId], "urn:afp:thread:enroll", "hub", (envelope) =>
      enroll(envelope, { agent: instance.actorId("a1"), hub: hub.actorId, capabilities: [CAPABILITY], hubKey: hubKey.keyId }),
    );
    await hub.receive(entry.activity);
    hub.archive("incident closed");
    const archived = hub.outbox.byActor(hub.actorId).at(-1)!.activity as Record<string, unknown>;
    assert.ok(archived["afp:state"], "the converged state entered the record");

    instance.publishAsInstance([], "urn:afp:thread:roster", "public", (envelope) =>
      vouch(envelope, { agent: hub.actorId, capabilities: ["afp:cap:hub"], keyCustody: "self" }),
    );
    const exported = exportBundle(instance, config.exportDir, [hub]);
    const clean = runVerifier(VERIFIER, config.exportDir, "urn:afp:thread:hub-lifecycle", ["--verbose"]);
    assert.equal(clean.code, 0, `verifier failed:\n${clean.output}`);
    assert.match(clean.output, /archive: .*state matches its canonical hashes/);
    // N3: the census makes silence visible — this bundle ran no actuation
    // checks, and the reader sees the zero instead of nothing.
    assert.match(clean.output, /census — checks run per domain/);
    assert.match(clean.output, /action:0/);

    // Tampered state under standing hashes: a blob riding along is not state
    // entering the record, and the difference is exactly this check.
    const tampered = mutateBundle(VERIFIER, exported.dir, "urn:afp:thread:hub-lifecycle", "hub-done", (outbox) => {
      for (const activity of outbox.orderedItems) {
        const state = activity["afp:state"] as { membership?: unknown } | undefined;
        if (state?.membership) state.membership = ["https://elsewhere.example/agents/ghost"];
      }
    });
    assert.notEqual(tampered.code, 0);
    assert.match(tampered.output, /FAIL \] archive: .*state matches its canonical hashes/);

    instance.close();
  });
});
