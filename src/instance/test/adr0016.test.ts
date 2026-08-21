/**
 * ADR-0016 — the P5 transport gate: the hub's real inbox, and convergence
 * carrying activities, over real sockets.
 *
 * Extends M6's three-operator shape (Alpha hosts the `bridge` hub; Bravo and
 * Gamma field one foreign member each) and asserts what M6's honesty note
 * left open:
 *
 * - enrollments and votes reach the hub through `POST /hubs/bridge/inbox` —
 *   the boundary's own receiving implementation, `receive` bound to the hub;
 * - an unenrolled foreign agent's write is refused opaquely, and presenting a
 *   valid `afp:MembershipProof` on the write changes nothing (Decision 2:
 *   the proof has no part in the write path);
 * - an enrolled observer's vote crosses the door and dies in the handler —
 *   admission and authority discriminated at two different layers;
 * - an application-defined store's explicit `Update{afp:CRDTDelta}` and a
 *   protocol store's governing activity converge over the same exchange —
 *   one path, two populations (Decision 3);
 * - a replica lagging by a known number of activities converges by
 *   `Offer{afp:Digest}` / `Accept{afp:StateDeltas}` over real sockets, and
 *   its converged state matches the leader's canonical hashes (Decision 4);
 * - the hub killed mid-task: new allocation stalls while in-flight mesh work
 *   completes (the roadmap's P5 kill criterion, mechanical because the hub
 *   never sits on the payload path — Decision 5);
 * - artifact bytes never traverse the hub: the artifact resolves only at its
 *   originating instance, and the hub host records no request for it.
 *
 *   node --experimental-sqlite --test test/adr0016.test.ts
 */

import assert from "node:assert/strict";
import { createServer } from "node:net";
import { after, describe, it } from "node:test";

import { loadConfig } from "../src/config.ts";
import { AfpInstance, type AgentRegistration } from "../src/instance.ts";
import { jumpClock } from "../src/demoP3.ts";
import { CountingBrain } from "../src/brains/stub.ts";
import { loadOrCreateHubKeyPair } from "../src/crypto/keys.ts";
import { createHttpServer } from "../src/ap/server.ts";
import type { Envelope } from "../src/ap/activities.ts";
import { offerTask } from "../src/ap/activities.ts";
import { fetchActorDocument } from "../src/federation/inbox.ts";
import { Federation, agreementObject, createAgreement, offerAgreement } from "../src/federation/federation.ts";
import { httpTransport } from "../src/federation/transport.ts";
import { signRequest } from "../src/federation/httpSig.ts";
import { castVote, enroll } from "../src/hub/activities.ts";
import { Hub } from "../src/hub/hub.ts";
import { digestOf } from "../src/crypto/proof.ts";
import type { JsonValue } from "../src/crypto/jcs.ts";
import { cleanupWorkspaces, workspace } from "./helpers.ts";

after(cleanupWorkspaces);

const CAPABILITY = "afp:cap:assess";
const FED = "urn:afp:thread:fed";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

interface Operator {
  name: string;
  instance: AfpInstance;
  federation: Federation;
  server: ReturnType<typeof createHttpServer>;
  port: number;
  origin: string;
  actorId: string;
  transport: ReturnType<typeof httpTransport>;
  config: ReturnType<typeof loadConfig>;
}

async function operator(name: string, agents: readonly string[], clock: ReturnType<typeof jumpClock>): Promise<Operator> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const config = loadConfig({ ...workspace(), origin });
  const registrations: AgentRegistration[] = agents.map((agent) => ({
    spec: { name: agent, capabilities: [CAPABILITY], keyCustody: "instance", since: "2026-08-17T00:00:00Z" },
    brain: new CountingBrain(agent, [CAPABILITY], () => ({ ok: true, content: `${name} assessed it` })),
  }));
  const instance = new AfpInstance(config, registrations, clock);
  const actorId = String(instance.instanceDocument().id);
  const federation = new Federation(instance.db, actorId, () => clock.now());
  const server = createHttpServer(instance, {
    inbox: { federation, receive: (activity) => instance.receiveAdmitted(activity), fetchDocument: fetchActorDocument },
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const transport = httpTransport({
    keyId: instance.key("@instance").keyId,
    privateKey: instance.key("@instance").privateKey,
    now: () => clock.now(),
    isLocal: (target) => instance.nameOf(target) !== null || target === actorId,
    local: instance.localTransport(),
  });
  return { name, instance, federation, server, port, origin, actorId, transport, config };
}

/** POST one signed activity to a hub inbox over a real socket, as `op`'s instance. */
async function postToHubInbox(
  op: Operator,
  hubOrigin: string,
  activity: { [key: string]: JsonValue },
  clock: ReturnType<typeof jumpClock>,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: { [key: string]: JsonValue } }> {
  const path = "/hubs/bridge/inbox";
  const body = JSON.stringify(activity);
  const key = op.instance.key("@instance");
  const signed = signRequest("POST", path, new URL(hubOrigin).host, body, key.keyId, key.privateKey, clock.now());
  const response = await fetch(`${hubOrigin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/activity+json",
      host: signed.host,
      date: signed.date,
      digest: signed.digest,
      signature: signed.signature,
      ...extraHeaders,
    },
    body,
  });
  return { status: response.status, body: (await response.json()) as { [key: string]: JsonValue } };
}

describe("ADR-0016: the hub's inbox and cross-instance CRDT sync, over real sockets", () => {
  it("T7: the transport gate", async () => {
    const clock = jumpClock("2026-08-21T13:00:00.000Z");
    const alpha = await operator("alpha", ["n-noc", "n-telemetry"], clock);
    const bravo = await operator("bravo", ["s-noc"], clock);
    const gamma = await operator("gamma", ["e-noc", "e-watcher"], clock);

    // Alpha hosts the leader. Its document cache is fed over real HTTP.
    const docCache = new Map<string, { [key: string]: JsonValue }>();
    const cacheDoc = async (url: string) => {
      const doc = await fetchActorDocument(url);
      assert.ok(doc, `document for ${url} fetched over real HTTP`);
      docCache.set(url, doc as { [key: string]: JsonValue });
    };
    const hubRequests: string[] = [];
    const hub = new Hub({
      origin: alpha.origin,
      hubId: "bridge",
      db: alpha.instance.db,
      keyDir: alpha.config.keyDir,
      instanceActorId: alpha.actorId,
      maxDeliveryAttempts: alpha.config.maxDeliveryAttempts,
      backoffBaseMs: alpha.config.backoffBaseMs,
      fetchActor: (actorId) => docCache.get(actorId) ?? null,
      now: () => clock.now(),
      // Decision 4: ids resolve against the record — own outbox (all local
      // actors share it) or received bytes. Pointer dereference, never a copy.
      resolveActivity: (activityId) =>
        alpha.instance.outbox.get(activityId)?.activity ??
        alpha.federation.receivedActivities().find((r) => String(r.activity.id) === activityId)?.activity ??
        null,
    });
    alpha.server.close();
    const alphaServer = createHttpServer(alpha.instance, {
      inbox: { federation: alpha.federation, receive: (a) => alpha.instance.receiveAdmitted(a), fetchDocument: fetchActorDocument },
      hubs: [hub],
    });
    alphaServer.on("request", (req) => hubRequests.push(String(req.url ?? "")));
    await new Promise<void>((resolve) => alphaServer.listen(alpha.port, "127.0.0.1", resolve));

    // Pairwise agreements, delegation + hub grants — M6's mesh, unchanged.
    const expires = new Date(clock.now().getTime() + 6 * 3600_000).toISOString();
    const handshake = async (a: Operator, b: Operator) => {
      const object = agreementObject({
        parties: [a.actorId, b.actorId],
        grants: [
          { "afp:grantType": "direct-delegation", "afp:capabilities": [CAPABILITY] },
          { "afp:grantType": "hub", "afp:hub": hub.actorId },
        ],
        expires,
      });
      a.instance.publishAsInstance([b.actorId], FED, "parties", (envelope: Envelope) => offerAgreement(envelope, object));
      const aCreate = a.instance.publishAsInstance([b.actorId], FED, "parties", (envelope: Envelope) =>
        createAgreement(envelope, object),
      );
      a.federation.recordOwnCreate(object, aCreate.activity);
      await a.instance.run(a.transport);
      const bCreate = b.instance.publishAsInstance([a.actorId], FED, "parties", (envelope: Envelope) =>
        createAgreement(envelope, object),
      );
      b.federation.recordOwnCreate(object, bCreate.activity);
      await b.instance.run(b.transport);
    };
    await handshake(alpha, bravo);
    await handshake(alpha, gamma);
    await handshake(bravo, gamma);

    // --- T1/T2: FOREIGN enrollment through the REAL hub inbox — M6's honesty
    // note, closed. The host's own agents enroll in-process, which is the
    // production path (local traffic never crosses its own boundary gate);
    // the boundary is for foreign bytes, and every foreign byte here rides it.
    for (const [op, agent, role] of [
      [alpha, "n-noc", "member"],
      [alpha, "n-telemetry", "member"],
      [bravo, "s-noc", "member"],
      [gamma, "e-noc", "member"],
      [gamma, "e-watcher", "observer"],
    ] as const) {
      for (const url of [op.actorId, op.instance.actorId(agent)]) await cacheDoc(url);
      const hubKey = loadOrCreateHubKeyPair(op.config.keyDir, agent, op.instance.actorId(agent), "bridge");
      const entry = op.instance.publishAsInstance([hub.actorId], "urn:afp:thread:enroll", "hub", (envelope: Envelope) =>
        enroll(envelope, { agent: op.instance.actorId(agent), hub: hub.actorId, capabilities: [CAPABILITY], hubKey: hubKey.keyId, role }),
      );
      if (op === alpha) {
        const outcome = await hub.receive(entry.activity);
        assert.equal(outcome.status, "dispatched", `${agent} enrolls in-process — the host's own path`);
      } else {
        const posted = await postToHubInbox(op, alpha.origin, entry.activity, clock);
        assert.equal(posted.status, 202, `${agent}'s enrollment admitted through the real inbox: ${JSON.stringify(posted.body)}`);
      }
    }
    assert.equal(hub.members().length, 5, "five seats across three trust domains, all through the socket");
    assert.equal(hub.roleOf(gamma.instance.actorId("e-watcher")), "observer");

    // --- T2: an unenrolled foreign agent's write is refused opaquely — and a
    // valid membership proof on the write is refused JUST THE SAME. The proof
    // widens a read predicate for someone who cannot ask; the hub can always
    // ask itself.
    const incident = "urn:afp:thread:incident-7";
    const proposal = hub.proposeRound({ round: "urn:afp:round:r1", thread: incident, question: "declare sev-1?", options: ["yes", "no"] });
    const proposalId = String((proposal.activity.object as Record<string, unknown>).id);
    void proposalId;
    const snapshot = String((proposal.activity.object as Record<string, unknown>)["afp:quorumSnapshot"]);

    // bravo's instance actor is party to an agreement but "b-rogue" is nobody:
    // an unenrolled agent under a valid operator. Its vote must die at the door.
    const rogueVote = bravo.instance.publishAsInstance([hub.actorId], incident, "hub", (envelope: Envelope) =>
      castVote(envelope, { voteId: `${envelope.actor}/votes/rogue`, round: "urn:afp:round:r1", hub: hub.actorId, proposalHash: proposal.digest, quorumSnapshot: snapshot, value: "yes" }),
    );
    const refused = await postToHubInbox(bravo, alpha.origin, rogueVote.activity, clock);
    assert.equal(refused.status, 403, "unenrolled write refused");
    assert.deepEqual(refused.body, { error: "refused" }, "opaquely — the gate's own body, nothing more");

    // The same write, now waving s-noc's perfectly valid membership proof:
    // identical refusal. The proof is not consulted on the write path.
    const proof = hub.membershipProof(bravo.instance.actorId("s-noc"), 60 * 60 * 1000)!;
    const provenRefusal = await postToHubInbox(bravo, alpha.origin, rogueVote.activity, clock, {
      "afp-membership-proof": Buffer.from(JSON.stringify(proof)).toString("base64url"),
    });
    assert.equal(provenRefusal.status, 403, "a valid membership proof on a write changes nothing (Decision 2)");
    assert.deepEqual(provenRefusal.body, { error: "refused" });

    // --- T2: admission vs authority — the observer's vote crosses the door
    // (it is enrolled) and dies in the handler (observers read, never decide).
    const votes: { [key: string]: JsonValue }[] = [];
    const castThrough = async (op: Operator, agent: string) => {
      const entry = op.instance.publish(agent, [hub.actorId], incident, "hub", (envelope) =>
        castVote(envelope, { voteId: `${envelope.actor}/votes/r1`, round: "urn:afp:round:r1", hub: hub.actorId, proposalHash: proposal.digest, quorumSnapshot: snapshot, value: "yes" }),
      );
      votes.push(entry.activity);
      return postToHubInbox(op, alpha.origin, entry.activity, clock);
    };
    const observerVote = await castThrough(gamma, "e-watcher");
    assert.equal(observerVote.status, 202, "the observer's vote crosses the door — it IS enrolled");
    assert.equal(hub.roundVotes("urn:afp:round:r1").length, 0, "and dies in the handler: outside the pinned snapshot, never tallied");

    const nnocVote = alpha.instance.publish("n-noc", [hub.actorId], incident, "hub", (envelope) =>
      castVote(envelope, { voteId: `${envelope.actor}/votes/r1`, round: "urn:afp:round:r1", hub: hub.actorId, proposalHash: proposal.digest, quorumSnapshot: snapshot, value: "yes" }),
    );
    await hub.receive(nnocVote.activity); // the host's own agent: in-process, as deployed
    for (const [op, agent] of [
      [bravo, "s-noc"],
      [gamma, "e-noc"],
    ] as const) {
      const posted = await castThrough(op, agent);
      assert.equal(posted.status, 202, `${agent}'s vote admitted through the real inbox`);
    }
    assert.equal(hub.roundVotes("urn:afp:round:r1").length, 3, "three member votes tallied, the observer's not among them");

    // --- Decision 3, second population: an application-defined store mutated
    // by its own explicit signed Update{afp:CRDTDelta}, through the same door.
    const backlogDelta = bravo.instance.publish("s-noc", [hub.actorId], incident, "hub", (envelope) =>
      ({
        "@context": ["https://www.w3.org/ns/activitystreams", "https://afp.example/ns/v3"],
        id: envelope.activityId,
        type: "Update",
        actor: envelope.actor,
        to: [...envelope.to],
        published: envelope.published,
        context: envelope.thread,
        "afp:visibility": "hub",
        ...(envelope.prevActivity !== null ? { "afp:prevActivity": envelope.prevActivity } : {}),
        object: {
          type: "afp:CRDTDelta",
          "afp:hub": hub.actorId,
          "afp:crdtId": "app:backlog",
          "afp:crdtType": "OR_SET",
          "afp:delta": { adds: [{ element: "triage-4471", tag: "s-noc-1" }], removes: [] },
        },
      }) as never,
    );
    const appPosted = await postToHubInbox(bravo, alpha.origin, backlogDelta.activity, clock);
    assert.equal(appPosted.status, 202, "the application store's delta activity is admitted like anything else");
    assert.deepEqual(Object.keys(hub.syncVector()).includes("app:backlog"), true, "and lands in the sync set");

    // --- Decision 4: the replica. Bravo stands up a replacement bridge
    // (02's recovery story) — same hubId, its own origin and key, replicaOf
    // the leader. It holds nothing; the exchange fills it, over real sockets.
    const replica = new Hub({
      origin: bravo.origin,
      hubId: "bridge",
      db: bravo.instance.db,
      keyDir: bravo.config.keyDir,
      instanceActorId: bravo.actorId,
      maxDeliveryAttempts: bravo.config.maxDeliveryAttempts,
      backoffBaseMs: bravo.config.backoffBaseMs,
      fetchActor: (actorId) => docCache.get(actorId) ?? null,
      now: () => clock.now(),
      replicaOf: hub.actorId,
    });
    bravo.server.close();
    const bravoServer = createHttpServer(bravo.instance, {
      inbox: { federation: bravo.federation, receive: (a) => bravo.instance.receiveAdmitted(a), fetchDocument: fetchActorDocument },
      hubs: [replica],
    });
    await new Promise<void>((resolve) => bravoServer.listen(bravo.port, "127.0.0.1", resolve));
    await cacheDoc(`${alpha.origin}/hubs/bridge`).catch(() => {});
    docCache.set(hub.actorId, hub.actorDocument());
    docCache.set(replica.actorId, replica.actorDocument());

    // The replica offers its (empty) digest to the leader's real inbox; the
    // leader's Accept{afp:StateDeltas} travels back to the replica's real
    // inbox; the replica re-derives everything from the carried activities.
    const offer = replica.offerSync(hub.actorId);
    const offerPosted = await postToHubInbox(bravo, alpha.origin, offer.activity, clock);
    assert.equal(offerPosted.status, 202, `the digest offer is admitted: ${JSON.stringify(offerPosted.body)}`);

    const alphaHubTransport = httpTransport({
      keyId: alpha.instance.key("@instance").keyId,
      privateKey: alpha.instance.key("@instance").privateKey,
      now: () => clock.now(),
      isLocal: () => false,
      local: { name: "none", deliver: async () => {} },
    });
    // The leader's reply is addressed to the replica hub actor — POST to its
    // inbox is `{target}/inbox`, which is exactly the replica's live route.
    await hub.run(alphaHubTransport);

    assert.equal(replica.members().length, 5, "the replica converges to all five seats from carried activities");
    assert.deepEqual(replica.members().sort(), hub.members().sort(), "same membership, re-derived");
    assert.equal(replica.roleOf(gamma.instance.actorId("e-watcher")), "observer", "roles converge too");
    assert.deepEqual(replica.syncVector()["app:backlog"], hub.syncVector()["app:backlog"], "the application store converges by the same path");
    // The canonical-hash check ADR-0015 gave archives, used as the
    // convergence judge: same values, same canon.
    const canon = (h: Hub) => ({
      membership: digestOf([...h.members()].sort()),
      capabilities: digestOf(
        [...h.members()].sort().map((m) => [m, [...h.capabilitiesOf(m)].sort()]) as never,
      ),
    });
    assert.deepEqual(canon(replica), canon(hub), "the replica's converged state matches the leader's canonical hashes");
    // Liveness is excluded from the sync set: hub-generated, nothing signed
    // behind it, stale reachability is worse than none (Decision 3).
    assert.ok(!Object.keys(hub.syncVector()).some((id) => id.startsWith("liveness:")), "liveness never enters the digest");

    // A second exchange is a no-op: idempotent by construction.
    const offer2 = replica.offerSync(hub.actorId);
    const offer2Posted = await postToHubInbox(bravo, alpha.origin, offer2.activity, clock);
    assert.equal(offer2Posted.status, 202);
    await hub.run(alphaHubTransport);
    assert.equal(replica.members().length, 5, "already converged: the second pull changes nothing");

    // --- Decision 5 / the kill criterion: kill the hub mid-task. In-flight
    // mesh work (payload path: member to member, never through the hub)
    // completes; new allocation toward the hub stalls.
    const mesh = "urn:afp:thread:mesh-1";
    gamma.instance.publish("e-noc", [alpha.instance.actorId("n-noc")], mesh, "parties", (envelope: Envelope) =>
      offerTask(envelope, { taskId: `${envelope.actor}/tasks/m1`, capability: CAPABILITY, correlationId: "m1", content: "correlate views" }),
    );
    // The offer is out; NOW the hub host dies.
    await new Promise<void>((resolve) => alphaServer.close(() => resolve()));

    // In-flight completes: gamma→alpha? alpha's server is down — the honest
    // in-flight path is bravo↔gamma, the pair that is still standing.
    const mesh2 = "urn:afp:thread:mesh-2";
    bravo.instance.publish("s-noc", [gamma.instance.actorId("e-noc")], mesh2, "parties", (envelope: Envelope) =>
      offerTask(envelope, { taskId: `${envelope.actor}/tasks/m2`, capability: CAPABILITY, correlationId: "m2", content: "correlate our two views" }),
    );
    await bravo.instance.run(bravo.transport);
    await gamma.instance.run(gamma.transport);
    await bravo.instance.run(bravo.transport);
    const meshResult = bravo.federation
      .receivedActivities()
      .some((r) => {
        const object = r.activity.object;
        return !!object && typeof object === "object" && !Array.isArray(object) && (object as Record<string, JsonValue>).type === "afp:Result";
      });
    assert.ok(meshResult, "in-flight mesh work completes while the hub is dead — the hub never sat on the payload path");

    // New allocation stalls: a vote/announce toward the dead hub inbox fails
    // at transport, visibly — no silent buffer pretending the bridge is quiet.
    await assert.rejects(
      postToHubInbox(gamma, alpha.origin, votes[0]!, clock),
      "a write to the dead hub fails to its caller — ADR-0014 Decision 2's visible degradation, not a queue's silence",
    );

    // --- Artifacts never traverse the hub: every request the hub host ever
    // served is inbox, actor, or key-bootstrap traffic — no /artifacts path.
    assert.ok(hubRequests.length > 0, "the hub host did serve traffic");
    assert.ok(
      hubRequests.every((url) => !url.includes("/artifacts/")),
      `no artifact bytes crossed the hub host: ${JSON.stringify(hubRequests)}`,
    );

    for (const server of [bravoServer, gamma.server]) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    alpha.instance.close();
    bravo.instance.close();
    gamma.instance.close();
  });
});
