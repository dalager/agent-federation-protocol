/**
 * The P2 hub demo: enrollment plus a full L0 weighted-quorum round.
 *
 *   node --experimental-sqlite --test test/hub.test.ts
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { loadConfig } from "../src/config.ts";
import { AfpInstance, type AgentRegistration } from "../src/instance.ts";
import { fixedClock } from "../src/demo.ts";
import { CountingBrain } from "../src/brains/stub.ts";
import { publicKeyFromMultibase, loadOrCreateHubKeyPair, type KeyPair } from "../src/crypto/keys.ts";
import { verifyProof } from "../src/crypto/proof.ts";
import { agentActor } from "../src/ap/documents.ts";
import { vouch } from "../src/ap/activities.ts";
import { exportBundle } from "../src/export.ts";
import { enroll, castVote, type Envelope } from "../src/hub/activities.ts";
import { Hub, hubTransport } from "../src/hub/hub.ts";
import { cleanupWorkspaces, runVerifier, workspace } from "./helpers.ts";

after(cleanupWorkspaces);

// a1-a4 are enrolled; a5 stays on the instance roster but is never enrolled in
// the hub, so it is a validly-keyed actor sitting outside the pinned snapshot
// — exactly the mid-round-enrollment attack 02 names.
const ENROLLED = ["a1", "a2", "a3", "a4"] as const;
const OUTSIDER = "a5";
const HUB_ID = "consortium";

function dummyBrain(name: string): CountingBrain {
  return new CountingBrain(name, ["afp:cap:vote"], () => ({ ok: true, content: "n/a" }));
}

function setupInstance() {
  const paths = workspace();
  const config = loadConfig(paths);
  const since = "2026-08-17T00:00:00Z";
  const agents: AgentRegistration[] = [...ENROLLED, OUTSIDER].map((name) => ({
    spec: { name, capabilities: ["afp:cap:vote"], keyCustody: "instance", since },
    brain: dummyBrain(name),
  }));
  const instance = new AfpInstance(config, agents, fixedClock());
  return { instance, config };
}

/** Hub-scoped keys (ADR-0002 Decision 4), generated once per enrolled agent. */
function issueHubKeys(instance: AfpInstance, config: ReturnType<typeof loadConfig>): Map<string, KeyPair> {
  const keys = new Map<string, KeyPair>();
  for (const name of ENROLLED) {
    keys.set(name, loadOrCreateHubKeyPair(config.keyDir, name, instance.actorId(name), HUB_ID));
  }
  return keys;
}

/** Build the hub, wiring its actor-document lookup back to the instance's own documents. */
function makeHub(instance: AfpInstance, config: ReturnType<typeof loadConfig>, hubKeys: Map<string, KeyPair>): Hub {
  let hub!: Hub;
  const fetchActor = (actorId: string) => {
    if (actorId === hub.actorId) return hub.actorDocument();
    if (actorId === instance.instanceDocument().id) return instance.instanceDocument();
    const name = instance.nameOf(actorId);
    if (!name) return null;
    const spec = instance.specs.find((s) => s.name === name)!;
    const hubKey = hubKeys.get(name);
    return agentActor(instance.config.origin, spec, instance.key(name), hubKey ? [hubKey] : []);
  };

  hub = new Hub({
    origin: config.origin,
    hubId: HUB_ID,
    db: instance.db,
    keyDir: config.keyDir,
    instanceActorId: instance.instanceDocument().id as string,
    maxDeliveryAttempts: config.maxDeliveryAttempts,
    backoffBaseMs: config.backoffBaseMs,
    fetchActor,
    now: () => instance.clock.now(),
  });
  return hub;
}

/** Enroll one agent: instance-issued `afp:Enroll`, delivered through the shared transport. */
function enrollAgent(instance: AfpInstance, hub: Hub, hubKeys: Map<string, KeyPair>, name: string) {
  const agentId = instance.actorId(name);
  const hubKey = hubKeys.get(name)!;
  return instance.publishAsInstance([hub.actorId], "urn:afp:thread:enroll", "hub", (envelope: Envelope) =>
    enroll(envelope, { agent: agentId, hub: hub.actorId, capabilities: ["afp:cap:vote"], hubKey: hubKey.keyId }),
  );
}

/** One agent casts a vote, signed with its P1 (instance-custody) key. */
function agentVotes(
  instance: AfpInstance,
  hub: Hub,
  round: string,
  proposalHash: string,
  quorumSnapshot: string,
  name: string,
  value: string,
) {
  return instance.publish(name, [hub.actorId], "urn:afp:thread:policy-1", "hub", (envelope: Envelope) =>
    castVote(envelope, {
      voteId: `${envelope.actor}/votes/${round}`,
      round,
      proposalHash,
      quorumSnapshot,
      value,
    }),
  );
}

describe("P2 hub: enrollment and an L0 weighted-quorum round", () => {
  it("enrolls agents, tallies a round, and rejects an out-of-snapshot vote", async () => {
    const { instance, config } = setupInstance();
    const hubKeys = issueHubKeys(instance, config);
    const hub = makeHub(instance, config, hubKeys);

    // The shared dispatch port: routes to the hub or to an agent by URL alone,
    // exactly like `AfpInstance.localTransport()` — nothing about in-process
    // wiring is observable from the activity bytes (gate check 11).
    const transport = hubTransport(hub, instance.localTransport(), (target) => instance.nameOf(target) !== null);

    // --- Enrollment: instance-issued afp:Enroll per agent, delivered to the hub.
    for (const name of ENROLLED) enrollAgent(instance, hub, hubKeys, name);
    await instance.run(transport);

    assert.deepEqual([...hub.members()].sort(), ENROLLED.map((n) => instance.actorId(n)).sort());
    for (const name of ENROLLED) {
      assert.ok(hub.isLive(instance.actorId(name)), `${name} should be live after enrollment`);
      assert.deepEqual(hub.capabilitiesOf(instance.actorId(name)), ["afp:cap:vote"]);
    }
    assert.ok(!hub.members().includes(instance.actorId(OUTSIDER)), "the outsider was never enrolled");

    // --- Open an L0 round over the enrolled membership.
    const round = "urn:afp:round:policy-1";
    const proposalEntry = hub.proposeRound({
      round,
      thread: "urn:afp:thread:policy-1",
      question: "Which policy should we adopt?",
      options: ["candidate-7", "candidate-2"],
    });
    const quorumSnapshot = (proposalEntry.activity.object as Record<string, unknown>)["afp:quorumSnapshot"] as string;
    const proposalDigest = proposalEntry.digest;

    // --- Three of four enrolled agents vote; the fourth abstains by omission.
    agentVotes(instance, hub, round, proposalDigest, quorumSnapshot, "a1", "candidate-7");
    agentVotes(instance, hub, round, proposalDigest, quorumSnapshot, "a2", "candidate-7");
    agentVotes(instance, hub, round, proposalDigest, quorumSnapshot, "a3", "candidate-2");
    await instance.run(transport);

    // A validly-signed vote from an actor outside the pinned quorumSnapshot
    // (enrolled nowhere, or enrolled after round start) must still be rejected
    // from the tally — the mid-round-enrollment defense (02).
    const outsiderVote = agentVotes(instance, hub, round, proposalDigest, quorumSnapshot, OUTSIDER, "candidate-7");
    const outsiderOutcome = await hub.receive(outsiderVote.activity);
    assert.equal(outsiderOutcome.status, "dispatched", "the outsider's signature itself still verifies");

    const votesOnRecord = hub.roundVotes(round).map((v) => v.actor);
    assert.ok(!votesOnRecord.includes(instance.actorId(OUTSIDER)), "the outsider's vote was not counted");
    assert.equal(votesOnRecord.length, 3, "only the three pinned-snapshot votes were counted");

    // A pinned voter whose ballot commits to the wrong proposal or the wrong
    // electorate is dropped too — afp:proposalHash and afp:quorumSnapshot must
    // both match the round they claim to answer.
    const wrongProposal = agentVotes(instance, hub, round, "sha256:not-this-proposal", quorumSnapshot, "a4", "candidate-2");
    await hub.receive(wrongProposal.activity);
    const wrongSnapshot = agentVotes(instance, hub, round, proposalDigest, "sha256:not-this-electorate", "a4", "candidate-2");
    await hub.receive(wrongSnapshot.activity);
    assert.equal(hub.roundVotes(round).length, 3, "mismatched proposalHash/quorumSnapshot ballots are not counted");

    // Version vectors are maintained from the first delta (ADR-0002 Decision 5):
    // four Enrolls from the instance actor, one receipt per counted voter.
    const instanceActor = String(instance.instanceDocument().id);
    assert.deepEqual(hub.versionVector("membership"), { [instanceActor]: 4 });
    assert.deepEqual(
      hub.versionVector(`receipts:${round}`),
      Object.fromEntries(["a1", "a2", "a3"].map((n) => [instance.actorId(n), 1])),
    );

    // --- Close the round: recompute the tally and publish the DecisionRecord.
    const decisionEntry = hub.closeRound(round);
    const decisionObject = decisionEntry.activity.object as Record<string, unknown>;

    assert.equal(decisionObject["afp:outcome"], "candidate-7");
    assert.deepEqual(decisionObject["afp:weightTally"], { "candidate-7": 2, "candidate-2": 1, abstain: 1 });
    assert.equal((decisionObject["afp:countedVotes"] as string[]).length, 3);

    // Any verifier recomputes the same tally straight from the counted votes alone.
    const recomputed: Record<string, number> = { "candidate-7": 0, "candidate-2": 0, abstain: 0 };
    for (const voter of hub.roundVoters(round)) {
      const vote = hub.roundVotes(round).find((v) => v.actor === voter);
      const value = vote && ["candidate-7", "candidate-2"].includes(vote.value) ? vote.value : "abstain";
      recomputed[value] += 1;
    }
    assert.deepEqual(recomputed, decisionObject["afp:weightTally"]);

    // The DecisionRecord verifies like any other signed P1 activity.
    const hubPublicKey = publicKeyFromMultibase(
      (hub.actorDocument().assertionMethod as { publicKeyMultibase: string }[])[0].publicKeyMultibase,
    );
    const result = verifyProof(decisionEntry.activity, hubPublicKey);
    assert.equal(result.ok, true, result.ok ? "" : result.reason);

    // --- End to end: export the real record — hub included — and hand it to
    // the independent Python verifier, decision checks and all. The hub is
    // vouched onto the roster first (self-custody): authority for its
    // DecisionRecord comes from the record, not from a verifier special case.
    instance.publishAsInstance([], "urn:afp:thread:roster", "public", (envelope: Envelope) =>
      vouch(envelope, { agent: hub.actorId, capabilities: ["afp:cap:hub"], keyCustody: "self" }),
    );
    const exported = exportBundle(instance, config.exportDir, [hub]);
    assert.ok(exported.activities > 0);
    const verifier = join(import.meta.dirname, "..", "..", "verifier", "afp_verify.py");
    const clean = runVerifier(verifier, config.exportDir, "urn:afp:thread:policy-1", ["--verbose"]);
    assert.equal(clean.code, 0, clean.output);
    assert.match(clean.output, /decision: .* weightTally recomputes from countedVotes/);
    assert.match(clean.output, /PASSED/);

    // --- Lifecycle: Freeze suspends new work but existing rounds still close;
    // Archive is terminal and read-only.
    const round2 = "urn:afp:round:policy-2";
    hub.proposeRound({ round: round2, thread: "urn:afp:thread:policy-2", question: "Second question?", options: ["yes", "no"] });
    hub.freeze("maintenance window");
    assert.throws(() => hub.proposeRound({ round: "urn:afp:round:policy-3", thread: "t", question: "?", options: ["a"] }), /frozen/);
    const frozenEnroll = enrollAgent(instance, hub, hubKeys, "a1");
    await hub.receive(frozenEnroll.activity);
    assert.deepEqual(hub.versionVector("membership"), { [instanceActor]: 4 }, "enrollment is new work — refused while frozen");
    const closed2 = hub.closeRound(round2); // in-flight work completes
    assert.equal((closed2.activity.object as Record<string, unknown>)["afp:outcome"], "abstain");

    hub.archive("consortium dissolved");
    const afterArchive = await hub.receive(
      agentVotes(instance, hub, round, proposalDigest, quorumSnapshot, "a1", "candidate-7").activity,
    );
    assert.equal(afterArchive.status, "rejected");
    assert.match((afterArchive as { reason: string }).reason, /archived/);
    assert.throws(() => hub.closeRound(round2), /archived/);

    instance.close();
  });
});
