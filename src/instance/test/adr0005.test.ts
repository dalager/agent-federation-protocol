/**
 * ADR-0005 acceptance gate: operators are equal against a hub.
 *
 * Two operators, deliberately lopsided — Alpha runs one agent, Beta runs
 * three. Under the uniform per-agent weight this replaces, Beta would carry
 * three votes to Alpha's one and could decide every round by hiring, which is
 * the cheapest attack on a consortium there is: no reasoning required, and
 * indistinguishable in the record from enthusiastic participation.
 *
 *   node --experimental-sqlite --test test/adr0005.test.ts
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { loadConfig } from "../src/config.ts";
import { AfpInstance, type AgentRegistration, type Clock } from "../src/instance.ts";
import { fixedClock } from "../src/demo.ts";
import { CountingBrain } from "../src/brains/stub.ts";
import { loadOrCreateHubKeyPair, type KeyPair } from "../src/crypto/keys.ts";
import { agentActor, AFP_CONTEXTS } from "../src/ap/documents.ts";
import { enroll, castVote, type Envelope } from "../src/hub/activities.ts";
import { controlTransfer, vouch } from "../src/ap/activities.ts";
import { agreementObject, createAgreement } from "../src/federation/federation.ts";
import { Hub } from "../src/hub/hub.ts";
import { exportBundle } from "../src/export.ts";
import { attachProof } from "../src/crypto/proof.ts";
import { mkdtempSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupWorkspaces, runVerifier, workspace } from "./helpers.ts";
import { VERIFIER } from "./adr0010-fixtures.ts";

after(cleanupWorkspaces);

const HUB_ID = "consortium";

/** One operator: its own origin, its own keys, its own agents. */
function operator(origin: string, agentNames: readonly string[], clock?: Clock) {
  const config = loadConfig({ ...workspace(), origin });
  const agents: AgentRegistration[] = agentNames.map((name) => ({
    spec: { name, capabilities: ["afp:cap:vote"], keyCustody: "instance", since: "2026-08-17T00:00:00Z" },
    brain: new CountingBrain(name, ["afp:cap:vote"], () => ({ ok: true, content: "n/a" })),
  }));
  const instance = new AfpInstance(config, agents, clock ?? fixedClock());
  const hubKeys = new Map<string, KeyPair>(
    agentNames.map((name) => [name, loadOrCreateHubKeyPair(config.keyDir, name, instance.actorId(name), HUB_ID)]),
  );
  return { config, instance, hubKeys, agentNames };
}

/**
 * A federated hub's bundle carries every seated instance's Enroll (and, now,
 * ControlTransfer) trail on the hub's own side of the boundary in real
 * deployments (ADR-0008's grant machinery, not exercised here). For this
 * gate, a foreign operator's own actor documents and outbox are folded
 * straight into the host's export directory instead — everything the
 * per-instance weight recompute reads (`enrolled_instances`,
 * `effective_operator`) is right there for a single-directory replay, without
 * standing up a federation agreement this ADR does not touch.
 */
function mergeForeignInstance(hostDir: string, foreign: AfpInstance, prefix: string): void {
  const written: string[] = [];
  const writeActor = (name: string, actorId: string, doc: { [key: string]: unknown }) => {
    writeFileSync(join(hostDir, "actors", `${name}.jsonld`), JSON.stringify(doc, null, 2));
    written.push(`actors/${name}.jsonld`);
    const activities = foreign.outbox.byActor(actorId).map((entry) => entry.activity);
    writeFileSync(
      join(hostDir, "outbox", `${name}.jsonld`),
      JSON.stringify(
        {
          "@context": AFP_CONTEXTS,
          id: `${actorId}/outbox`,
          type: "OrderedCollection",
          attributedTo: actorId,
          totalItems: activities.length,
          orderedItems: activities,
        },
        null,
        2,
      ),
    );
    written.push(`outbox/${name}.jsonld`);
  };

  const instanceDoc = foreign.instanceDocument() as { [key: string]: unknown };
  writeActor(`${prefix}-instance`, String(instanceDoc.id), instanceDoc);
  for (const spec of foreign.specs) {
    writeActor(`${prefix}-${spec.name}`, foreign.actorId(spec.name), foreign.agentDocument(spec.name) as { [key: string]: unknown });
  }

  const manifestPath = join(hostDir, "MANIFEST.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const members = new Set<string>([...(manifest["afp:members"] ?? []), ...written]);
  manifest["afp:members"] = [...members].sort();
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

/**
 * Re-sign the host manifest after folding foreign instances into it.
 *
 * `mergeForeignInstance` edits `afp:members`, and the manifest is a signed
 * document (ADR-0012 Decision 1) — so leaving the old proof in place would
 * produce a bundle whose self-description does not verify. ADR-0026 added the
 * check that notices; an exporter assembling a joint bundle would re-sign,
 * and so does this fixture.
 */
function resignManifest(hostDir: string, host: AfpInstance): void {
  const manifestPath = join(hostDir, "MANIFEST.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  delete manifest.proof;
  const signed = attachProof(manifest, { signer: host.signer("@instance") });
  writeFileSync(manifestPath, JSON.stringify(signed, null, 2));
}

/**
 * Copy a clean single-dir bundle and edit one outbox file in it — the same
 * shape as `helpers.ts`'s `mutateBundle`, kept local since this gate's host
 * bundle already has foreign instances folded in before mutation.
 */
function copyAndMutateOutbox(
  exportDir: string,
  outboxName: string,
  edit: (outbox: { orderedItems: Record<string, unknown>[] }) => void,
): string {
  const dir = mkdtempSync(join(tmpdir(), "afp-mut-adr0005-"));
  cpSync(exportDir, dir, { recursive: true });
  const path = join(dir, "outbox", `${outboxName}.jsonld`);
  const outbox = JSON.parse(readFileSync(path, "utf8"));
  edit(outbox);
  outbox.totalItems = outbox.orderedItems.length;
  writeFileSync(path, JSON.stringify(outbox, null, 2));
  return dir;
}

type Operator = ReturnType<typeof operator>;

/** Resolve any actor document either operator publishes — the hub holds no keys of its own for them. */
function actorResolver(hub: () => Hub, operators: readonly Operator[]) {
  return (actorId: string): { [key: string]: never } | null => {
    if (actorId === hub().actorId) return hub().actorDocument() as never;
    for (const op of operators) {
      if (actorId === op.instance.instanceDocument().id) return op.instance.instanceDocument() as never;
      const name = op.instance.nameOf(actorId);
      if (!name) continue;
      const spec = op.instance.specs.find((s) => s.name === name)!;
      const hubKey = op.hubKeys.get(name);
      return agentActor(op.config.origin, spec, op.instance.key(name), hubKey ? [hubKey] : []) as never;
    }
    return null;
  };
}

/** An operator enrolls one of its own agents — the only enrollment ADR-0005 admits. */
function enrolls(op: Operator, hub: Hub, name: string, role?: "member" | "requester" | "observer") {
  return op.instance.publishAsInstance([hub.actorId], `${op.config.origin}/threads/enroll`, "hub", (envelope: Envelope) =>
    enroll(envelope, {
      agent: op.instance.actorId(name),
      hub: hub.actorId,
      capabilities: ["afp:cap:vote"],
      hubKey: op.hubKeys.get(name)!.keyId,
      role,
    }),
  );
}

describe("ADR-0005 gate: operators are equal against a hub", () => {
  it("one agent weighs as much as three, when the three share an operator", async () => {
    const alpha = operator("https://alpha.operator.local", ["a1"]);
    const beta = operator("https://beta.operator.local", ["b1", "b2", "b3", "b4"]);

    let hub!: Hub;
    hub = new Hub({
      origin: alpha.config.origin,
      hubId: HUB_ID,
      db: alpha.instance.db,
      keyDir: alpha.config.keyDir,
      instanceActorId: alpha.instance.instanceDocument().id as string,
      maxDeliveryAttempts: alpha.config.maxDeliveryAttempts,
      backoffBaseMs: alpha.config.backoffBaseMs,
      fetchActor: actorResolver(() => hub, [alpha, beta]),
      now: () => alpha.instance.clock.now(),
    });

    // Each operator enrolls its own agents, signed by itself.
    await hub.receive(enrolls(alpha, hub, "a1").activity);
    for (const name of ["b1", "b2", "b3"]) await hub.receive(enrolls(beta, hub, name).activity);

    const a1 = alpha.instance.actorId("a1");
    const [b1, b2, b3, b4] = beta.agentNames.map((n) => beta.instance.actorId(n));
    assert.deepEqual([...hub.members()].sort(), [a1, b1, b2, b3].sort(), "all four are enrolled");
    assert.equal(hub.instanceOf(a1), alpha.instance.instanceDocument().id, "the enrolling operator is on the record");
    assert.equal(hub.instanceOf(b1), beta.instance.instanceDocument().id);

    // --- The round: four voters, two operators, equal say.
    const proposal = hub.proposeRound({
      round: `${alpha.config.origin}/rounds/equal-1`,
      thread: `${alpha.config.origin}/threads/equal-1`,
      question: "Whose weight decides?",
      options: ["alpha", "beta"],
    });
    const weights = (proposal.activity.object as Record<string, unknown>)["afp:voterWeights"] as Record<string, number>;

    assert.equal(weights[a1], 3, "Alpha's lone agent carries its operator's whole seat");
    assert.deepEqual([weights[b1], weights[b2], weights[b3]], [1, 1, 1], "Beta's three split theirs");
    assert.equal(weights[a1], weights[b1] + weights[b2] + weights[b3], "one operator, one weight");

    // Every weight is a whole number — the JCS numeric profile forbids
    // anything else in a document that gets signed.
    for (const w of Object.values(weights)) assert.ok(Number.isInteger(w), `weight ${w} is not an integer`);

    // --- Hiring buys nothing. Beta enrols a fourth agent and re-opens.
    await hub.receive(enrolls(beta, hub, "b4").activity);
    assert.ok(hub.members().includes(b4), "the fourth agent really is enrolled — or the next assertion proves nothing");

    const after2 = hub.proposeRound({
      round: `${alpha.config.origin}/rounds/equal-2`,
      thread: `${alpha.config.origin}/threads/equal-2`,
      question: "And now?",
      options: ["alpha", "beta"],
    });
    const w2 = (after2.activity.object as Record<string, unknown>)["afp:voterWeights"] as Record<string, number>;
    assert.equal(Object.keys(w2).length, 5, "five voters now");
    const betaTotal = [b1, b2, b3, b4].reduce((sum, agent) => sum + w2[agent], 0);
    assert.equal(w2[a1], betaTotal, "a fourth Beta agent still does not outweigh Alpha's one");
    assert.deepEqual([w2[b1], w2[b2], w2[b3], w2[b4]], [1, 1, 1, 1], "Beta's seat now splits four ways");
    assert.equal(w2[a1], 4, "Alpha's single agent absorbs the whole seat, whatever Beta's headcount");

    alpha.instance.close();
    beta.instance.close();
  });

  it("refuses an enrollment issued by anyone but the agent's own operator", async () => {
    const alpha = operator("https://alpha.operator.local", ["a1"]);
    const beta = operator("https://beta.operator.local", ["b1"]);

    let hub!: Hub;
    hub = new Hub({
      origin: alpha.config.origin,
      hubId: HUB_ID,
      db: alpha.instance.db,
      keyDir: alpha.config.keyDir,
      instanceActorId: alpha.instance.instanceDocument().id as string,
      maxDeliveryAttempts: alpha.config.maxDeliveryAttempts,
      backoffBaseMs: alpha.config.backoffBaseMs,
      fetchActor: actorResolver(() => hub, [alpha, beta]),
      now: () => alpha.instance.clock.now(),
    });

    const b1 = beta.instance.actorId("b1");

    // Alpha tries to enroll one of Beta's agents — validly signed by Alpha,
    // and refused anyway: a signature is not an entitlement to enroll.
    const poached = alpha.instance.publishAsInstance([hub.actorId], `${alpha.config.origin}/threads/enroll`, "hub", (envelope: Envelope) =>
      enroll(envelope, { agent: b1, hub: hub.actorId, capabilities: ["afp:cap:vote"], hubKey: "x", role: "member" }),
    );
    const outcome = await hub.receive(poached.activity);
    assert.equal(outcome.status, "dispatched", "the signature itself verifies — this is an authority failure, not a forgery");
    assert.ok(!hub.members().includes(b1), "Beta's agent is not enrolled by Alpha");

    // An agent enrolling itself as a member is the self-promotion this closes.
    const selfEnroll = beta.instance.publish("b1", [hub.actorId], `${beta.config.origin}/threads/enroll`, "hub", (envelope: Envelope) =>
      enroll(envelope, { agent: b1, hub: hub.actorId, capabilities: ["afp:cap:vote"], hubKey: "x", role: "member" }),
    );
    await hub.receive(selfEnroll.activity);
    assert.ok(!hub.members().includes(b1), "an agent cannot enroll itself");

    // Beta enrolling its own agent is admitted.
    await hub.receive(enrolls(beta, hub, "b1").activity);
    assert.ok(hub.members().includes(b1), "the agent's own operator may enroll it");

    alpha.instance.close();
    beta.instance.close();
  });
});

describe("ADR-0005 amendment: declared change of control (scenario 12, finding 63)", () => {
  it("a declared merger folds two seats into one operator's weight — but never retroactively", async () => {
    // Three operators sharing a real clock, so a round's `published` and a
    // ControlTransfer's `published` are strictly ordered across instances
    // regardless of which one calls it.
    const clock = fixedClock();
    const alpha = operator("https://alpha.operator.local", ["a1"], clock);
    const beta = operator("https://beta.operator.local", ["b1"], clock);
    const gamma = operator("https://gamma.operator.local", ["g1", "g2"], clock);

    let hub!: Hub;
    hub = new Hub({
      origin: alpha.config.origin,
      hubId: HUB_ID,
      db: alpha.instance.db,
      keyDir: alpha.config.keyDir,
      instanceActorId: alpha.instance.instanceDocument().id as string,
      maxDeliveryAttempts: alpha.config.maxDeliveryAttempts,
      backoffBaseMs: alpha.config.backoffBaseMs,
      fetchActor: actorResolver(() => hub, [alpha, beta, gamma]),
      now: () => clock.now(),
    });

    await hub.receive(enrolls(alpha, hub, "a1").activity);
    await hub.receive(enrolls(beta, hub, "b1").activity);
    for (const name of ["g1", "g2"]) await hub.receive(enrolls(gamma, hub, name).activity);

    const a1 = alpha.instance.actorId("a1");
    const b1 = beta.instance.actorId("b1");
    const [g1, g2] = ["g1", "g2"].map((n) => gamma.instance.actorId(n));

    // --- T2's other half: a round pinned BEFORE any transfer. Three
    // separate operators (counts 1, 1, 2), L = 2: the singletons carry the
    // whole seat each, gamma's pair splits its own.
    const round1 = hub.proposeRound({
      round: `${alpha.config.origin}/rounds/pre-merger`,
      thread: `${alpha.config.origin}/threads/pre-merger`,
      question: "Re-run the determination?",
      options: ["yes", "no"],
    });
    const w1 = (round1.activity.object as Record<string, unknown>)["afp:voterWeights"] as Record<string, number>;
    assert.equal(w1[a1], 2, "Alpha alone carries the whole seat, pre-merger");
    assert.equal(w1[b1], 2, "so does Beta, still a separate operator");
    assert.equal(w1[g1], 1, "Gamma's pair splits its one seat");
    assert.equal(w1[g2], 1);

    // --- Fourteen days later: Beta declares itself operated by Alpha (the
    // merger the snapshot could not see, made declared and checkable).
    const transfer = beta.instance.publishAsInstance(
      [hub.actorId],
      `${beta.config.origin}/threads/roster`,
      "public",
      (envelope: Envelope) => controlTransfer(envelope, alpha.instance.instanceDocument().id as string),
    );
    await hub.receive(transfer.activity);
    assert.equal(
      hub.effectiveOperatorOf(hub.instanceOf(b1)!),
      alpha.instance.instanceDocument().id,
      "Beta now counts as Alpha for weighting",
    );

    // --- T1: a round pinned AFTER the transfer. Two effective operators now
    // (alpha+beta merged, gamma unchanged), counts (2, 2), L = 2: the merged
    // pair SPLITS one seat's worth of weight between them, instead of each
    // carrying a whole one.
    const round2 = hub.proposeRound({
      round: `${alpha.config.origin}/rounds/post-merger`,
      thread: `${alpha.config.origin}/threads/post-merger`,
      question: "Re-run the determination?",
      options: ["yes", "no"],
    });
    const w2 = (round2.activity.object as Record<string, unknown>)["afp:voterWeights"] as Record<string, number>;
    assert.equal(w2[a1], 1, "Alpha's own weight is diluted by its new co-owner");
    assert.equal(w2[b1], 1, "Beta likewise");
    assert.equal(w2[a1] + w2[b1], 2, "together they carry exactly one seat's worth, not two");
    assert.equal(w2[g1], 1, "Gamma, untouched by the merger, is unchanged");
    assert.equal(w2[g2], 1);

    // --- T2: the round pinned before the transfer is untouched — no re-tally.
    const w1Again = (round1.activity.object as Record<string, unknown>)["afp:voterWeights"] as Record<string, number>;
    assert.deepEqual(w1Again, w1, "a closed/open round's pinned weights never move under a later declaration");

    // --- Close the post-merger round, so there is a DecisionRecord for the
    // verifier's weight recompute to run against (it fires per-DecisionRecord,
    // same as every other ADR-0005 check). A single vote is enough to close
    // an L0 round — who voted is not what this check is about; what the
    // proposal *pinned* is.
    const postMergerRound = `${alpha.config.origin}/rounds/post-merger`;
    const postMergerSnapshot = (round2.activity.object as Record<string, unknown>)["afp:quorumSnapshot"] as string;
    const ballot = alpha.instance.publish("a1", [hub.actorId], round2.activity.context as string, "hub", (envelope: Envelope) =>
      castVote(envelope, {
        voteId: `${envelope.actor}/votes/post-merger`,
        hub: hub.actorId,
        round: postMergerRound,
        proposalHash: round2.digest,
        quorumSnapshot: postMergerSnapshot,
        value: "yes",
      }),
    );
    await hub.receive(ballot.activity);
    hub.closeRound(postMergerRound);

    // --- Alpha's own bundle (with the hub), Beta's and Gamma's own actor
    // documents and outboxes folded straight in — one directory the verifier
    // can replay whole, the way its per-instance weight recompute reads it.
    alpha.instance.publishAsInstance([], `${alpha.config.origin}/threads/roster`, "public", (envelope: Envelope) =>
      vouch(envelope, { agent: hub.actorId, capabilities: ["afp:cap:vote"], keyCustody: "self" }),
    );
    // The hub's own proposal/decision activities address every pinned voter
    // directly, including Beta's and Gamma's — real cross-origin traffic
    // (ADR-0008), unrelated to this amendment but required for the bundle to
    // replay honestly. A minimal hub-scoped grant for each foreign operator.
    for (const foreign of [beta, gamma]) {
      const grantObject = agreementObject({
        parties: [alpha.instance.instanceDocument().id as string, foreign.instance.instanceDocument().id as string],
        grants: [{ "afp:grantType": "hub", "afp:hub": hub.actorId }],
        expires: "2027-01-01T00:00:00.000Z",
      });
      alpha.instance.publishAsInstance([], `${alpha.config.origin}/threads/federation`, "public", (envelope: Envelope) =>
        createAgreement(envelope, grantObject),
      );
    }
    const exported = exportBundle(alpha.instance, alpha.config.exportDir, [hub]);
    mergeForeignInstance(exported.dir, beta.instance, "beta");
    mergeForeignInstance(exported.dir, gamma.instance, "gamma");
    resignManifest(exported.dir, alpha.instance);

    const clean = runVerifier(VERIFIER, exported.dir, "", ["--verbose"]);
    assert.equal(clean.code, 0, `clean merged bundle should verify: ${clean.output}`);
    assert.match(clean.output, /weights: .* pinned weights honor declared control/, "the new check ran");

    // --- T3: rewrite the post-merger proposal's pinned weights back to the
    // pre-merger, unfolded split — the verifier must catch a hub that quietly
    // ignores a declared change of control.
    const mutatedDir = copyAndMutateOutbox(exported.dir, `hub-${HUB_ID}`, (outbox) => {
      const proposalActivity = outbox.orderedItems.find(
        (item) => (item.object as Record<string, unknown> | undefined)?.["afp:round"] === postMergerRound,
      );
      assert.ok(proposalActivity, "post-merger proposal present in the hub's own outbox");
      (proposalActivity!.object as Record<string, unknown>)["afp:voterWeights"] = {
        [a1]: 2,
        [b1]: 2,
        [g1]: 1,
        [g2]: 1,
      };
    });

    const broken = runVerifier(VERIFIER, mutatedDir, "", ["--verbose"]);
    assert.notEqual(broken.code, 0, "a mistallied proposal must fail the replay");
    assert.match(
      broken.output,
      /FAIL.*weights: .* pinned weights honor declared control/,
      "the named check catches the mistally",
    );

    alpha.instance.close();
    beta.instance.close();
    gamma.instance.close();
  });
});
