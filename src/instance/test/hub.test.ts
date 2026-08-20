/**
 * The P2 hub demo: enrollment plus a full L0 weighted-quorum round.
 *
 *   node --experimental-sqlite --test test/hub.test.ts
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, writeFileSync, cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

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
function enrollAgent(
  instance: AfpInstance,
  hub: Hub,
  hubKeys: Map<string, KeyPair>,
  name: string,
  role?: "member" | "requester" | "observer",
) {
  const agentId = instance.actorId(name);
  const hubKey = hubKeys.get(name)!;
  return instance.publishAsInstance([hub.actorId], "urn:afp:thread:enroll", "hub", (envelope: Envelope) =>
    enroll(envelope, { agent: agentId, hub: hub.actorId, capabilities: ["afp:cap:vote"], hubKey: hubKey.keyId, role }),
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

    // The cited evidence is ordered, not whatever the store happened to scan
    // (H11): the same round must sign the same bytes twice.
    const counted = hub.roundVotes(round);
    assert.deepEqual(
      counted.map((v) => v.actor),
      [...counted.map((v) => v.actor)].sort(),
      "vote receipts come back in a defined order",
    );
    assert.deepEqual(
      decisionObject["afp:countedVotes"],
      counted.map((v) => v.digest),
      "afp:countedVotes follows that same order",
    );

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
    assert.match(clean.output, /decision: .* voter weights recompute per instance/);
    assert.match(clean.output, /enroll: .* enrolled by its own instance/);
    assert.match(clean.output, /PASSED/);

    // ADR-0005: both new checks must be able to fail, or they are decoration.
    const mutate = (name: string, edit: (outbox: { orderedItems: Record<string, unknown>[] }) => void) => {
      const dir = mkdtempSync(join(tmpdir(), "afp-adr5-mut-"));
      cpSync(config.exportDir, dir, { recursive: true });
      const path = join(dir, "outbox", `${name}.jsonld`);
      const outbox = JSON.parse(readFileSync(path, "utf8"));
      edit(outbox);
      outbox.totalItems = outbox.orderedItems.length;
      writeFileSync(path, JSON.stringify(outbox, null, 2));
      return runVerifier(verifier, dir, "urn:afp:thread:policy-1", ["--verbose"]);
    };

    // A hub that writes the weights it wants into its own proposal — the exact
    // reason recorded-for-inspection is not the same as recomputable.
    const forgedWeights = mutate(`hub-${hub.hubId}`, (outbox) => {
      for (const activity of outbox.orderedItems) {
        const object = activity.object as Record<string, unknown> | undefined;
        if (object?.type === "afp:Proposal") {
          const weights = object["afp:voterWeights"] as Record<string, number>;
          object["afp:voterWeights"] = Object.fromEntries(
            Object.entries(weights).map(([voter, w], i) => [voter, i === 0 ? w + 5 : w]),
          );
        }
      }
    });
    assert.notEqual(forgedWeights.code, 0);
    assert.match(forgedWeights.output, /FAIL \] decision: .*voter weights recompute per instance/);

    // An Enroll issued by someone other than the agent's own operator.
    const poachedEnroll = mutate("instance", (outbox) => {
      for (const activity of outbox.orderedItems) {
        if (activity.type === "afp:Enroll") { activity.actor = instance.actorId("a2"); break; }
      }
    });
    assert.notEqual(poachedEnroll.code, 0);
    assert.match(poachedEnroll.output, /FAIL \] enroll: .*enrolled by its own instance/);

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

  // ADR-0004 implementation parity note: an open round must survive a hub
  // restart — its row and vote receipts already persist in SQLite, and the
  // hub reads rounds statelessly from the store, so a fresh Hub over the same
  // db can keep accepting votes and close the round with the right tally.
  it("survives a restart mid-round: a fresh Hub over the same store keeps voting and closes correctly", async () => {
    const { instance, config } = setupInstance();
    const hubKeys = issueHubKeys(instance, config);
    const hub = makeHub(instance, config, hubKeys);
    const transport = hubTransport(hub, instance.localTransport(), (target) => instance.nameOf(target) !== null);

    for (const name of ENROLLED) enrollAgent(instance, hub, hubKeys, name);
    await instance.run(transport);

    const round = "urn:afp:round:restart-1";
    const proposalEntry = hub.proposeRound({
      round,
      thread: "urn:afp:thread:restart-1",
      question: "Restart-safe?",
      options: ["yes", "no"],
    });
    const quorumSnapshot = (proposalEntry.activity.object as Record<string, unknown>)["afp:quorumSnapshot"] as string;
    const proposalDigest = proposalEntry.digest;

    // Two votes land before the "restart".
    await hub.receive(agentVotes(instance, hub, round, proposalDigest, quorumSnapshot, "a1", "yes").activity);
    await hub.receive(agentVotes(instance, hub, round, proposalDigest, quorumSnapshot, "a2", "yes").activity);

    // Restart: a brand-new Hub object over the same SQLite db — no carried-over
    // in-memory state, no explicit rehydration call.
    const restarted = makeHub(instance, config, hubKeys);
    assert.equal(restarted.roundVotes(round).length, 2, "pre-restart votes are visible after restart");

    // A third vote is accepted by the restarted hub against the same open round.
    await restarted.receive(agentVotes(instance, restarted, round, proposalDigest, quorumSnapshot, "a3", "no").activity);
    assert.equal(restarted.roundVotes(round).length, 3);

    // And the restarted hub closes the round with the full tally.
    const decision = restarted.closeRound(round);
    const object = decision.activity.object as Record<string, unknown>;
    assert.equal(object["afp:outcome"], "yes");
    assert.deepEqual(object["afp:weightTally"], { yes: 2, no: 1, abstain: 1 });
    assert.equal((object["afp:countedVotes"] as string[]).length, 3);

    instance.close();
  });

  // ADR-0004 Decision 1: enrollment carries a role, enforced at
  // snapshot-pinning, bid admission and fan-out — and the requester write-path
  // (inbound Announce, actuals report) is narrow but real.
  it("enforces roles: requester/observer never pinned or bidding; requester announces and settles", async () => {
    const { instance, config } = setupInstance();
    const hubKeys = issueHubKeys(instance, config);
    const hub = makeHub(instance, config, hubKeys);
    const transport = hubTransport(hub, instance.localTransport(), (target) => instance.nameOf(target) !== null);

    // a1/a2 members, a3 requester, a4 observer.
    enrollAgent(instance, hub, hubKeys, "a1");
    enrollAgent(instance, hub, hubKeys, "a2", "member");
    enrollAgent(instance, hub, hubKeys, "a3", "requester");
    enrollAgent(instance, hub, hubKeys, "a4", "observer");
    await instance.run(transport);

    const [a1, a2, a3, a4] = ["a1", "a2", "a3", "a4"].map((n) => instance.actorId(n));
    assert.equal(hub.roleOf(a1), "member");
    assert.equal(hub.roleOf(a3), "requester");
    assert.equal(hub.roleOf(a4), "observer");
    assert.equal(hub.roleOf(instance.actorId(OUTSIDER)), null);
    assert.deepEqual(hub.broadcastTargets().sort(), [a1, a2, a4].sort(), "broadcasts go to members and observers");

    // Snapshot-pinning: only member-role agents are ever pinned into voters.
    const proposal = hub.proposeRound({
      round: "urn:afp:round:role-1",
      thread: "urn:afp:thread:role-1",
      question: "Roles?",
      options: ["yes", "no"],
    });
    const voters = (proposal.activity.object as Record<string, unknown>)["afp:voters"] as string[];
    assert.deepEqual([...voters].sort(), [a1, a2].sort(), "a requester or observer never appears in a quorum snapshot");

    // Requester announces a task through the inbound dispatch path; the hub
    // re-fans it out and records the requester as the settlement counterparty.
    const thread = "urn:afp:thread:req-ask-1";
    const window = {
      opens: instance.clock.now().toISOString(),
      closes: new Date(instance.clock.now().getTime() + 600_000).toISOString(),
    };
    const inboundAnnounce = instance.publish("a3", [hub.actorId], thread, "hub", (envelope: Envelope) => ({
      "@context": ["https://www.w3.org/ns/activitystreams", "https://afp.example/ns/v3"],
      id: envelope.activityId,
      type: "Announce",
      actor: envelope.actor,
      to: [...envelope.to],
      published: envelope.published,
      context: envelope.thread,
      "afp:visibility": envelope.visibility,
      ...(envelope.prevActivity !== null ? { "afp:prevActivity": envelope.prevActivity } : {}),
      object: {
        id: "urn:afp:task:req-ask-1",
        type: "afp:Task",
        "afp:hub": hub.actorId,
        "afp:capability": "afp:cap:vote",
        "afp:correlationId": "req-ask-1",
        content: "requester-scoped ask",
        "afp:bidWindow": window,
        "afp:selectionRule": { name: "ranking", params: { weights: { capabilityMatch: 1 } } },
        "afp:answerSufficiency": { count: 1 },
        "afp:estimatorPolicy": "exclude",
        "afp:estimators": [],
      },
    }));
    const announceOutcome = await hub.receive(inboundAnnounce.activity);
    assert.equal(announceOutcome.status, "dispatched");
    const auction = hub.allocation.auction("urn:afp:task:req-ask-1");
    assert.ok(auction, "the requester's announce opened an auction");
    assert.equal(auction!.requester, a3, "the announcing actor is the settlement's counterparty");

    // An observer's announce is rejected and audit-logged — never an auction.
    const observerAnnounce = instance.publish("a4", [hub.actorId], "urn:afp:thread:obs-ask", "hub", (envelope: Envelope) => ({
      "@context": ["https://www.w3.org/ns/activitystreams", "https://afp.example/ns/v3"],
      id: envelope.activityId,
      type: "Announce",
      actor: envelope.actor,
      to: [...envelope.to],
      published: envelope.published,
      context: envelope.thread,
      "afp:visibility": envelope.visibility,
      ...(envelope.prevActivity !== null ? { "afp:prevActivity": envelope.prevActivity } : {}),
      object: {
        id: "urn:afp:task:obs-ask",
        type: "afp:Task",
        "afp:hub": hub.actorId,
        "afp:bidWindow": window,
        "afp:selectionRule": { name: "ranking", params: {} },
      },
    }));
    await hub.receive(observerAnnounce.activity);
    assert.equal(hub.allocation.auction("urn:afp:task:obs-ask"), null, "an observer cannot announce");
    assert.ok(
      hub.allocation.admissions("urn:afp:task:obs-ask").some((a) => a.outcome === "rejected" && /role/.test(a.reason)),
      "the observer's announce rejection is audit-logged",
    );

    // Bid admission: a commit from a non-member role is rejected, audit-logged.
    const requesterCommit = instance.publish("a3", [hub.actorId], thread, "hub", (envelope: Envelope) => ({
      "@context": ["https://www.w3.org/ns/activitystreams", "https://afp.example/ns/v3"],
      id: envelope.activityId,
      type: "afp:bidCommit",
      actor: envelope.actor,
      to: [...envelope.to],
      published: envelope.published,
      context: envelope.thread,
      "afp:visibility": envelope.visibility,
      ...(envelope.prevActivity !== null ? { "afp:prevActivity": envelope.prevActivity } : {}),
      object: "urn:afp:task:req-ask-1",
      "afp:hub": hub.actorId,
      "afp:commitment": "sha256:whatever",
    }));
    await hub.receive(requesterCommit.activity);
    assert.equal(hub.allocation.bids("urn:afp:task:req-ask-1").length, 0, "a requester cannot bid");
    assert.ok(
      hub.allocation
        .admissions("urn:afp:task:req-ask-1")
        .some((a) => a.outcome === "rejected" && /only member-role/.test(a.reason)),
      "the non-member commit rejection is audit-logged",
    );

    // The requester reports observed actuals onto its own thread → Settlement.
    const actualsReport = instance.publish("a3", [hub.actorId], thread, "hub", (envelope: Envelope) => ({
      "@context": ["https://www.w3.org/ns/activitystreams", "https://afp.example/ns/v3"],
      id: envelope.activityId,
      type: "Create",
      actor: envelope.actor,
      to: [...envelope.to],
      published: envelope.published,
      context: envelope.thread,
      "afp:visibility": envelope.visibility,
      ...(envelope.prevActivity !== null ? { "afp:prevActivity": envelope.prevActivity } : {}),
      object: {
        id: "urn:afp:result:req-ask-1-actuals",
        type: "afp:Result",
        "afp:actuals": { [a1]: { unit: "EUR", value: 120 } },
      },
    }));
    // ...but settlement follows an *award*. This auction is still in bidding,
    // so the report is refused and audit-logged rather than putting a
    // settlement on the record for work nobody was awarded. (The award-then-
    // settle happy path, and the once-per-task guard, are in adr0004.test.ts.)
    const before = hub.outbox.nextSeq(hub.actorId);
    await hub.receive(actualsReport.activity);
    assert.equal(
      hub.outbox.nextSeq(hub.actorId),
      before,
      "no afp:Settlement is emitted for an auction that was never awarded",
    );
    assert.ok(
      hub.allocation
        .admissions("urn:afp:task:req-ask-1")
        .some((a) => a.outcome === "rejected" && /settlement follows an award/.test(a.reason)),
      "the premature actuals report is rejected on the record",
    );

    instance.close();
  });

  // H9/H12: the admission checks that keep the actuals-report authorization
  // meaningful — one auction per thread, and a bid window that can admit a bid.
  it("refuses a second auction on one thread, and a window no bid could land in", async () => {
    const { instance, config } = setupInstance();
    const hubKeys = issueHubKeys(instance, config);
    const hub = makeHub(instance, config, hubKeys);
    const transport = hubTransport(hub, instance.localTransport(), (target) => instance.nameOf(target) !== null);
    enrollAgent(instance, hub, hubKeys, "a1", "requester");
    await instance.run(transport);

    const thread = "urn:afp:thread:shared";
    const now = instance.clock.now();
    const announceOf = (taskId: string, thread: string, window: { opens: string; closes: string }) =>
      instance.publish("a1", [hub.actorId], thread, "hub", (envelope: Envelope) => ({
        "@context": ["https://www.w3.org/ns/activitystreams", "https://afp.example/ns/v3"],
        id: envelope.activityId,
        type: "Announce",
        actor: envelope.actor,
        to: [...envelope.to],
        published: envelope.published,
        context: envelope.thread,
        "afp:visibility": envelope.visibility,
        ...(envelope.prevActivity !== null ? { "afp:prevActivity": envelope.prevActivity } : {}),
        object: {
          id: taskId,
          type: "afp:Task",
          "afp:hub": hub.actorId,
          "afp:bidWindow": window,
          "afp:selectionRule": { name: "ranking", params: { weights: { capabilityMatch: 1 } } },
          "afp:answerSufficiency": { count: 1 },
          "afp:estimatorPolicy": "exclude",
          "afp:estimators": [],
        },
      }));

    const open = { opens: now.toISOString(), closes: new Date(now.getTime() + 600_000).toISOString() };
    await hub.receive(announceOf("urn:afp:task:first", thread, open).activity);
    assert.ok(hub.allocation.auction("urn:afp:task:first"), "the first auction opens");

    // A second auction on the same thread would make "which auction does this
    // actuals report settle?" unanswerable.
    await hub.receive(announceOf("urn:afp:task:second", thread, open).activity);
    assert.equal(hub.allocation.auction("urn:afp:task:second"), null, "one auction per thread");
    assert.ok(
      hub.allocation
        .admissions("urn:afp:task:second")
        .some((a) => /one auction per thread/.test(a.reason)),
      "the collision is rejected on the record",
    );

    // An inverted window, and one that already closed: no commit could ever
    // land inside either.
    await hub.receive(
      announceOf("urn:afp:task:inverted", "urn:afp:thread:inv", { opens: open.closes, closes: open.opens }).activity,
    );
    assert.equal(hub.allocation.auction("urn:afp:task:inverted"), null);
    assert.ok(hub.allocation.admissions("urn:afp:task:inverted").some((a) => /at or after it closes/.test(a.reason)));

    await hub.receive(
      announceOf("urn:afp:task:past", "urn:afp:thread:past", {
        opens: new Date(now.getTime() - 600_000).toISOString(),
        closes: new Date(now.getTime() - 300_000).toISOString(),
      }).activity,
    );
    assert.equal(hub.allocation.auction("urn:afp:task:past"), null);
    assert.ok(hub.allocation.admissions("urn:afp:task:past").some((a) => /closed at/.test(a.reason)));

    instance.close();
  });

  // ADR-0004's parity note in full: the *whole* hub comes back from its store,
  // not only its rounds. An amnesiac hub is not just unavailable — it would
  // re-admit a conflicting digest for an asset it had already registered.
  it("comes back from its store: membership, roles, capabilities, assets and lifecycle survive restart", async () => {
    const { instance, config } = setupInstance();
    const hubKeys = issueHubKeys(instance, config);
    const hub = makeHub(instance, config, hubKeys);
    const transport = hubTransport(hub, instance.localTransport(), (target) => instance.nameOf(target) !== null);

    enrollAgent(instance, hub, hubKeys, "a1");
    enrollAgent(instance, hub, hubKeys, "a2", "observer");
    await instance.run(transport);
    const [a1, a2] = ["a1", "a2"].map((n) => instance.actorId(n));

    const assetUpdate = (name: string, digest: string) =>
      instance.publish(name, [hub.actorId], "urn:afp:thread:assets", "hub", (envelope: Envelope) => ({
        "@context": ["https://www.w3.org/ns/activitystreams", "https://afp.example/ns/v3"],
        id: envelope.activityId,
        type: "Update",
        actor: envelope.actor,
        to: [...envelope.to],
        published: envelope.published,
        context: envelope.thread,
        "afp:visibility": envelope.visibility,
        ...(envelope.prevActivity !== null ? { "afp:prevActivity": envelope.prevActivity } : {}),
        "afp:hub": hub.actorId,
        object: {
          id: "urn:afp:asset:a",
          type: "afp:Asset",
          "afp:version": "1.0",
          "afp:digest": digest,
          attributedTo: envelope.actor,
        },
      }));
    await hub.receive(assetUpdate("a1", "sha256:original").activity);

    // --- Restart: a brand-new Hub object over the same SQLite file.
    const restarted = makeHub(instance, config, hubKeys);

    assert.deepEqual([...restarted.members()].sort(), [a1, a2].sort(), "membership survives");
    assert.equal(restarted.roleOf(a1), "member", "roles survive");
    assert.equal(restarted.roleOf(a2), "observer", "a non-default role survives");
    assert.deepEqual(restarted.capabilitiesOf(a1), ["afp:cap:vote"], "capabilities survive");
    assert.ok(restarted.isLive(a1), "liveness survives");
    assert.equal(restarted.assetOf("urn:afp:asset:a", "1.0")?.["afp:digest"], "sha256:original", "the registry survives");

    // The point of all that: immutability still holds across the restart.
    await restarted.receive(assetUpdate("a1", "sha256:rewritten").activity);
    assert.equal(
      restarted.assetOf("urn:afp:asset:a", "1.0")?.["afp:digest"],
      "sha256:original",
      "a restarted hub still refuses to mutate a registered (id, version)",
    );

    // And a restarted hub can still open a round — impossible with empty membership.
    const proposal = restarted.proposeRound({
      round: "urn:afp:round:after-restart",
      thread: "urn:afp:thread:after-restart",
      question: "Still working?",
      options: ["yes", "no"],
    });
    assert.deepEqual(
      (proposal.activity.object as Record<string, unknown>)["afp:voters"],
      [a1],
      "the member is pinned; the observer is not",
    );

    // Lifecycle is terminal across a restart: an archived hub stays archived.
    restarted.archive("done");
    const afterArchive = makeHub(instance, config, hubKeys);
    const rejected = await afterArchive.receive(assetUpdate("a1", "sha256:post-archive").activity);
    assert.equal(rejected.status, "rejected");
    assert.match((rejected as { reason: string }).reason, /archived/);

    instance.close();
  });

  // ADR-0004 Decision 2: the asset registry — registration on the record,
  // (id, version) immutability, member-only authority.
  it("registers assets: member-only, immutable per (id, version), readable back", async () => {
    const { instance, config } = setupInstance();
    const hubKeys = issueHubKeys(instance, config);
    const hub = makeHub(instance, config, hubKeys);
    const transport = hubTransport(hub, instance.localTransport(), (target) => instance.nameOf(target) !== null);

    enrollAgent(instance, hub, hubKeys, "a1");
    enrollAgent(instance, hub, hubKeys, "a3", "requester");
    await instance.run(transport);
    const a1 = instance.actorId("a1");

    const assetUpdate = (name: string, version: string, digest: string) =>
      instance.publish(name, [hub.actorId], "urn:afp:thread:assets", "hub", (envelope: Envelope) => ({
        "@context": ["https://www.w3.org/ns/activitystreams", "https://afp.example/ns/v3"],
        id: envelope.activityId,
        type: "Update",
        actor: envelope.actor,
        to: [...envelope.to],
        published: envelope.published,
        context: envelope.thread,
        "afp:visibility": envelope.visibility,
        ...(envelope.prevActivity !== null ? { "afp:prevActivity": envelope.prevActivity } : {}),
        "afp:hub": hub.actorId,
        object: {
          id: "urn:afp:asset:mitid-broker-adapter",
          type: "afp:Asset",
          "afp:version": version,
          "afp:digest": digest,
          "afp:sourceUrl": "https://git.example/integrations/mitid-broker-adapter",
          attributedTo: envelope.actor,
        },
      }));

    // A member registers version 3.1.
    await hub.receive(assetUpdate("a1", "3.1", "sha256:aaa").activity);
    assert.deepEqual(hub.assetOf("urn:afp:asset:mitid-broker-adapter", "3.1")?.["afp:digest"], "sha256:aaa");

    // A second Update with the same (id, version) but a different digest is rejected.
    await hub.receive(assetUpdate("a1", "3.1", "sha256:bbb").activity);
    assert.equal(
      hub.assetOf("urn:afp:asset:mitid-broker-adapter", "3.1")?.["afp:digest"],
      "sha256:aaa",
      "one (id, version) is immutable once registered",
    );

    // A new version is a new entry.
    await hub.receive(assetUpdate("a1", "3.2", "sha256:ccc").activity);
    assert.equal(hub.assetOf("urn:afp:asset:mitid-broker-adapter", "3.2")?.["afp:digest"], "sha256:ccc");
    assert.equal(hub.assetRegistry().size, 2);

    // A requester cannot register.
    await hub.receive(assetUpdate("a3", "4.0", "sha256:ddd").activity);
    assert.equal(hub.assetOf("urn:afp:asset:mitid-broker-adapter", "4.0"), null, "only members register assets");

    // The steward is on the record.
    assert.equal(hub.assetOf("urn:afp:asset:mitid-broker-adapter", "3.1")?.attributedTo, a1);

    instance.close();
  });
});
