/**
 * ADR-0014 gate, Decision 1: `afp:MembershipProof` — the hub vouches for its
 * members, portably.
 *
 * Scenario 10's third beat in miniature: the hub lives on one instance, the
 * serving instance is a different one, and the requester must prove enrollment
 * in a hub the server does not host. Before this decision, ADR-0013's `hub`
 * predicate answered that case with a correct and useless refusal — the shared
 * hub's members could not read the shared work.
 *
 * Tested at the gate, like adr0013.test.ts, because every case here is a
 * disclosure decision. The proof is transport machinery and never enters the
 * record, so there is no verifier surface and no export in these tests at all
 * — which is ADR-0013 Decision 5 showing up as test shape.
 *
 *   node --experimental-sqlite --test test/adr0014.test.ts
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import type { JsonValue } from "../src/crypto/jcs.ts";
import { attachProof } from "../src/crypto/proof.ts";
import { signRequest } from "../src/federation/httpSig.ts";
import { authorizeRead, type ReadGateDeps } from "../src/federation/readGate.ts";
import { castVote, enroll } from "../src/hub/activities.ts";
import { hubTransport } from "../src/hub/hub.ts";
import { exportBundle } from "../src/export.ts";
import { createResult } from "../src/ap/activities.ts";
import { cleanupWorkspaces, mutateBundle, runVerifier, testHub, testInstance } from "./helpers.ts";
import { VERIFIER } from "./adr0010-fixtures.ts";
import { fileSigner } from "../src/crypto/signer.ts";

after(cleanupWorkspaces);

const CAPABILITY = "afp:cap:assess";
const NOW = new Date("2026-08-21T10:00:00.000Z");

/**
 * Alpha hosts the hub and enrolls its agent; the GATE UNDER TEST belongs to a
 * peer that does not host it. `roleOf` answers null throughout — the server
 * genuinely cannot answer enrollment locally, which is the whole finding.
 */
async function threeParty(options: { seatPolicy?: "follow-required" | "enroll-implies-seat" } = {}) {
  const { instance, clock } = testInstance(["a1"], CAPABILITY);
  const { hub, hubKeys } = testHub(instance, ["a1"], "bridge", options);
  clock.jumpTo(NOW.toISOString());
  const agentId = instance.actorId("a1");
  // Membership is a recorded act even in miniature: enroll through the hub's
  // own transport path so `roleOf`/`membershipProof` answer from real state —
  // the same shape every hub-bearing gate test uses.
  const transport = hubTransport(hub, instance.localTransport(), (target) => instance.nameOf(target) !== null);
  instance.publishAsInstance([hub.actorId], `${instance.config.origin}/threads/enroll`, "hub", (envelope) =>
    enroll(envelope, {
      agent: agentId,
      hub: hub.actorId,
      capabilities: [CAPABILITY],
      hubKey: hubKeys.get("a1")!.keyId,
    }),
  );
  await instance.run(transport);

  const agreementWithBridge = {
    type: "afp:FederationAgreement",
    "afp:parties": [String(instance.instanceDocument().id), "https://server.example/actor"],
    "afp:grants": [{ "afp:grantType": "hub", "afp:hub": hub.actorId }],
  } as unknown as { [key: string]: JsonValue };

  const deps = (over: Partial<ReadGateDeps> = {}): ReadGateDeps => ({
    fetchDocument: async (url: string) => {
      if (url === agentId) return instance.agentDocument("a1");
      if (url === hub.actorId) return hub.actorDocument();
      return null;
    },
    isDenylisted: () => false,
    activeAgreementsWith: () => [agreementWithBridge],
    // The server does not host `bridge`: local enrollment is unanswerable.
    roleOf: () => null,
    grants: () => [],
    now: () => NOW,
    ...over,
  });

  const path = "/agents/w/outbox";
  const key = instance.key("a1");
  const signedHeaders = signRequest("GET", path, "server.example", "", fileSigner(key), NOW);
  const hubActivity = { "afp:visibility": "hub", "afp:hub": hub.actorId } as { [key: string]: JsonValue };

  return { instance, hub, agentId, deps, path, signedHeaders, hubActivity };
}

const encode = (proof: { [key: string]: JsonValue }): string =>
  Buffer.from(JSON.stringify(proof)).toString("base64url");

describe("ADR-0014: a member proves enrollment to a peer that does not host the hub", () => {
  it("a valid proof admits — and its absence is exactly the old refusal", async () => {
    const t = await threeParty();
    const proof = t.hub.membershipProof(t.agentId);
    assert.ok(proof, "the hub vouches for its enrolled member");

    // Without the proof: ADR-0013's scoped predicate refuses, correctly and
    // uselessly. This is the control that shows the proof is what admits.
    const bare = await authorizeRead(t.deps(), { path: t.path, headers: t.signedHeaders });
    assert.notEqual(bare.requester, null);
    assert.equal(bare.admits(t.hubActivity), false, "no proof, no locally answerable enrollment: refused");

    const withProof = await authorizeRead(t.deps(), {
      path: t.path,
      headers: { ...t.signedHeaders, "afp-membership-proof": encode(proof!) },
    });
    assert.equal(withProof.admits(t.hubActivity), true, "the presented proof widens the enrollment clause");
    // Widening is surgical: internal stays absolute, other hubs stay closed.
    assert.equal(withProof.admits({ "afp:visibility": "internal", "afp:hub": t.hub.actorId }), false);
    assert.equal(withProof.admits({ "afp:visibility": "hub", "afp:hub": "https://elsewhere.example/hubs/x" }), false);
    t.instance.close();
  });

  it("an expired proof is a stranger again", async () => {
    const t = await threeParty();
    // Default TTL is fifteen minutes; the serving instance's clock is an hour
    // on. No clock trickery — just a proof past its lifetime, which is the
    // ordinary way this refusal will ever happen.
    const proof = t.hub.membershipProof(t.agentId);
    const later = new Date(NOW.getTime() + 60 * 60 * 1000);
    const auth = await authorizeRead(t.deps({ now: () => later }), {
      path: t.path,
      headers: { ...signRequestAt(t, later), "afp-membership-proof": encode(proof!) },
    });
    assert.equal(auth.admits(t.hubActivity), false);
    t.instance.close();
  });

  it("a proof about somebody else names somebody else", async () => {
    const t = await threeParty();
    const proof = t.hub.membershipProof(t.agentId)!;
    const forOther = { ...proof, agent: "https://elsewhere.example/agents/mallory" };
    const auth = await authorizeRead(t.deps(), {
      path: t.path,
      headers: { ...t.signedHeaders, "afp-membership-proof": encode(forOther) },
    });
    // Tampered agent also breaks the hub's signature; either way: refused.
    assert.equal(auth.admits(t.hubActivity), false);
    t.instance.close();
  });

  it("a proof signed by anyone but the hub is noise", async () => {
    const t = await threeParty();
    // The requester signs a statement about itself with its OWN key — a
    // self-issued membership claim, which is exactly what the hub's signature
    // exists to make worthless.
    const key = t.instance.key("a1");
    const selfIssued = attachProof(
      {
        type: "afp:MembershipProof",
        "afp:hub": t.hub.actorId,
        agent: t.agentId,
        "afp:role": "member",
        "afp:expires": new Date(NOW.getTime() + 600_000).toISOString(),
      },
      { signer: fileSigner(key), created: NOW.toISOString() },
    ) as { [key: string]: JsonValue };
    const auth = await authorizeRead(t.deps(), {
      path: t.path,
      headers: { ...t.signedHeaders, "afp-membership-proof": encode(selfIssued) },
    });
    assert.equal(auth.admits(t.hubActivity), false);
    t.instance.close();
  });

  it("the deny-list still refuses a proof-bearing member — nothing widens past it", async () => {
    const t = await threeParty();
    const proof = t.hub.membershipProof(t.agentId)!;
    const auth = await authorizeRead(t.deps({ isDenylisted: () => true }), {
      path: t.path,
      headers: { ...t.signedHeaders, "afp-membership-proof": encode(proof) },
    });
    assert.equal(auth.admits(t.hubActivity), false);
    t.instance.close();
  });

  it("the hub does not vouch for strangers", async () => {
    const t = await threeParty();
    assert.equal(t.hub.membershipProof("https://elsewhere.example/agents/nobody"), null);
    t.instance.close();
  });
});

/** Re-sign the GET at a later instant, so the date header stays inside skew. */
function signRequestAt(t: Awaited<ReturnType<typeof threeParty>>, at: Date) {
  const key = t.instance.key("a1");
  return signRequest("GET", t.path, "server.example", "", fileSigner(key), at);
}

describe("ADR-0014 Decisions 2-4: the mesh edge, the hub's head, and the two silences", () => {
  it("a round tells declined from silent, and replay holds it to the arithmetic", async () => {
    const AGENTS = ["a1", "a2", "a3"] as const;
    const { instance, config } = testInstance(AGENTS, CAPABILITY);
    const { hub, hubKeys } = testHub(instance, AGENTS, "bridge");
    const transport = hubTransport(hub, instance.localTransport(), (t) => instance.nameOf(t) !== null);
    for (const name of AGENTS) {
      instance.publishAsInstance([hub.actorId], `${config.origin}/threads/enroll`, "hub", (envelope) =>
        enroll(envelope, { agent: instance.actorId(name), hub: hub.actorId, capabilities: [CAPABILITY], hubKey: hubKeys.get(name)!.keyId }),
      );
    }
    await instance.run(transport);
    const thread = `${config.origin}/threads/round-1`;

    const proposal = hub.proposeRound({ round: `${config.origin}/rounds/r1`, thread, question: "sev-1?", options: ["yes", "no"] });
    const proposalId = String((proposal.activity.object as Record<string, unknown>).id);
    const snapshot = String((proposal.activity.object as Record<string, unknown>)["afp:quorumSnapshot"]);

    // a1 votes; a2 declines on the record; a3 says nothing at all.
    await hub.receive(
      instance.publish("a1", [hub.actorId], thread, "hub", (envelope) =>
        castVote(envelope, { voteId: `${envelope.actor}/votes/r1`, round: `${config.origin}/rounds/r1`, proposalHash: proposal.digest, quorumSnapshot: snapshot, value: "yes" }),
      ).activity,
    );
    await hub.receive(
      instance.publish("a2", [hub.actorId], thread, "hub", (envelope) =>
        ({
          "@context": ["https://www.w3.org/ns/activitystreams", "https://dalager.github.io/agent-federation-protocol/ns/v3.jsonld"],
          id: envelope.activityId,
          type: "Reject",
          actor: envelope.actor,
          to: [...envelope.to],
          published: envelope.published,
          context: envelope.thread,
          "afp:visibility": envelope.visibility,
          ...(envelope.prevActivity !== null ? { "afp:prevActivity": envelope.prevActivity } : {}),
          object: proposalId,
          summary: "cannot assent without our own telemetry",
        }) as never,
      ).activity,
    );
    const decision = hub.closeRound(`${config.origin}/rounds/r1`);
    const record = decision.activity.object as Record<string, unknown>;
    const uncounted = record["afp:uncounted"] as { agent: string; "afp:status": string }[];
    assert.equal(uncounted.length, 2);
    const byAgent = Object.fromEntries(uncounted.map((u) => [u.agent, u["afp:status"]]));
    assert.equal(byAgent[instance.actorId("a2")], "declined", "a recorded Reject is participation without assent");
    assert.equal(byAgent[instance.actorId("a3")], "silent", "nothing at all is not an abstention");

    // Terminal outcome, vouch the hub, export, verify.
    instance.publish("a1", [], thread, "parties", (envelope) =>
      createResult(envelope, { resultId: `${config.origin}/results/r1`, correlationId: "r1", content: "closed" }),
    );
    const { vouch } = await import("../src/ap/activities.ts");
    instance.publishAsInstance([], `${config.origin}/threads/roster`, "public", (envelope) =>
      vouch(envelope, { agent: hub.actorId, capabilities: ["afp:cap:hub"], keyCustody: "self" }),
    );
    const exported = exportBundle(instance, config.exportDir, [hub]);
    const clean = runVerifier(VERIFIER, config.exportDir, thread, ["--verbose"]);
    assert.equal(clean.code, 0, `verifier failed:\n${clean.output}`);
    assert.match(clean.output, /decision: .*afp:uncounted partitions the pinned electorate/);
    assert.match(clean.output, /decision: .*declined members declined on the record/);

    // Mutation 1 — the decline the bundle cannot produce: strip a2's Reject.
    const noReject = mutateBundle(VERIFIER, exported.dir, thread, "a2", (outbox) => {
      outbox.orderedItems = outbox.orderedItems.filter((a) => a.type !== "Reject");
    });
    assert.notEqual(noReject.code, 0);
    assert.match(noReject.output, /FAIL \] decision: .*declined members declined on the record/);

    // Mutation 2 — the silent member quietly dropped from the accounting.
    const droppedSilent = mutateBundle(VERIFIER, exported.dir, thread, "hub-bridge", (outbox) => {
      for (const activity of outbox.orderedItems) {
        const object = activity.object as Record<string, unknown> | undefined;
        if (object?.type === "afp:DecisionRecord" && Array.isArray(object["afp:uncounted"])) {
          object["afp:uncounted"] = (object["afp:uncounted"] as { "afp:status": string }[]).filter(
            (u) => u["afp:status"] !== "silent",
          );
        }
      }
    });
    assert.notEqual(droppedSilent.code, 0);
    assert.match(droppedSilent.output, /FAIL \] decision: .*afp:uncounted partitions the pinned electorate/);

    instance.close();
  });

  it("mesh work rejoins the hub through afp:priorThread — the edge that already existed", async () => {
    // Decision 2's ruling in miniature: degraded-mode work is an ordinary P4
    // thread, and the reconciliation on the hub's return is ADR-0011's
    // priorThread edge, not new machinery.
    const { instance, config } = testInstance(["a1", "a2"], CAPABILITY);
    const mesh = `${config.origin}/threads/mesh-during-partition`;
    instance.delegate({ from: "a1", to: "a2", capability: CAPABILITY, content: "carry on pairwise", thread: mesh, correlationId: "m1" });
    instance.publish("a2", [], mesh, "parties", (envelope) =>
      createResult(envelope, { resultId: `${config.origin}/results/m1`, correlationId: "m1", content: "done off-hub" }),
    );
    instance.delegate({
      from: "a1", to: "a2", capability: CAPABILITY,
      content: "reconcile: the mesh stretch, rejoining the bridge",
      thread: `${config.origin}/threads/bridge-resumed`, correlationId: "m2",
      priorThread: mesh,
    });
    instance.publish("a2", [], `${config.origin}/threads/bridge-resumed`, "parties", (envelope) =>
      createResult(envelope, { resultId: `${config.origin}/results/m2`, correlationId: "m2", content: "rejoined" }),
    );
    exportBundle(instance, config.exportDir);
    const clean = runVerifier(VERIFIER, config.exportDir, `${config.origin}/threads/bridge-resumed`, ["--verbose"]);
    assert.equal(clean.code, 0, `verifier failed:\n${clean.output}`);
    assert.match(clean.output, /afp:priorThread resolves to a closed, unretracted thread/);
    instance.close();
  });

  it("the hub's chain head anchors like any actor's — ADR-0012's rule, no new rule", async () => {
    // ADR-0032 Decision 6: the default seatPolicy now makes the hub emit an
    // Accept{Follow} before this test's own premise ("never emitted") can be
    // checked — set explicitly here since this test's subject is the
    // chain-head/anchor invariant, not the seat-default flip.
    const t = await threeParty({ seatPolicy: "enroll-implies-seat" });
    assert.equal(t.hub.chainHead(), null, "a hub that never emitted has no head — receiving is not emitting");
    // The head exists once the hub authors something of its own.
    const config = (t.instance as unknown as { config: { origin: string; exportDir: string } }).config;
    t.hub.proposeRound({ round: `${config.origin}/rounds/anchor-me`, thread: `${config.origin}/threads/enroll`, question: "q?", options: ["yes", "no"] });
    const head = t.hub.chainHead();
    assert.ok(head, "a hub that has emitted has a head to anchor");
    const { vouch } = await import("../src/ap/activities.ts");
    t.instance.publishAsInstance([], `${config.origin}/threads/roster`, "public", (envelope) =>
      vouch(envelope, { agent: t.hub.actorId, capabilities: ["afp:cap:hub"], keyCustody: "self" }),
    );
    exportBundle(t.instance, config.exportDir, [t.hub], undefined, undefined, {
      retentionDuty: { horizon: "P5Y", basis: "test" },
      anchors: [{ actor: t.hub.actorId, head: t.hub.chainHead()!, instant: NOW.toISOString(), anchorRef: "https://ts.example/1" }],
    });
    const clean = runVerifier(VERIFIER, config.exportDir, `${config.origin}/threads/enroll`, ["--verbose"]);
    assert.equal(clean.code, 0, `verifier failed:\n${clean.output}`);
    assert.match(clean.output, /retention: every anchor names a chain head this bundle contains/);
    t.instance.close();
  });
});
