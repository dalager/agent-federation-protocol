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
import { enroll } from "../src/hub/activities.ts";
import { hubTransport } from "../src/hub/hub.ts";
import { cleanupWorkspaces, testHub, testInstance } from "./helpers.ts";

after(cleanupWorkspaces);

const CAPABILITY = "afp:cap:assess";
const NOW = new Date("2026-08-21T10:00:00.000Z");

/**
 * Alpha hosts the hub and enrolls its agent; the GATE UNDER TEST belongs to a
 * peer that does not host it. `roleOf` answers null throughout — the server
 * genuinely cannot answer enrollment locally, which is the whole finding.
 */
async function threeParty() {
  const { instance, clock } = testInstance(["a1"], CAPABILITY);
  const { hub, hubKeys } = testHub(instance, ["a1"], "bridge");
  clock.jumpTo(NOW.toISOString());
  const agentId = instance.actorId("a1");
  // Membership is a recorded act even in miniature: enroll through the hub's
  // own transport path so `roleOf`/`membershipProof` answer from real state —
  // the same shape every hub-bearing gate test uses.
  const transport = hubTransport(hub, instance.localTransport(), (target) => instance.nameOf(target) !== null);
  instance.publishAsInstance([hub.actorId], "urn:afp:thread:enroll", "hub", (envelope) =>
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
  const signedHeaders = signRequest("GET", path, "server.example", "", key.keyId, key.privateKey, NOW);
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
      { privateKey: key.privateKey, verificationMethod: key.keyId, created: NOW.toISOString() },
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
  return signRequest("GET", t.path, "server.example", "", key.keyId, key.privateKey, at);
}
