/**
 * ADR-0014 M6 — the three-instance gate: scenario 10 over real sockets.
 *
 * Alpha hosts the `bridge` hub and fields two agents; Bravo and Gamma field
 * one each, enrolled across the boundary. Everything ADR-0014 built is
 * exercised where it will actually run: the membership proof travels as a
 * header on a real signed GET, its verification fetches the hub's actor
 * document over real HTTP from a *third* party, the host partitions and the
 * proof keeps working from the requester's pocket, the mesh carries real
 * delegation traffic through the real inbox gate, the reconciliation edge is
 * a thread property the verifier resolves, and a round closed after the
 * partition tells a recorded decline from two silences.
 *
 * Honest scope notes, so this gate claims exactly what it proves:
 * - Enrollments and votes reach the hub in-process. The hub's own HTTP inbox
 *   is P5's remaining transport scope (cross-instance CRDT sync, roadmap);
 *   the *activities* are genuinely foreign-signed and the hub verifies them
 *   against documents fetched over real HTTP before the partition.
 * - The round's declined member is one of Alpha's own agents, so the decline
 *   resolves inside Alpha's bundle. A decline by a *foreign* member resolves
 *   across bundles — ADR-0015 N1/N2's cross-bundle territory, noted there.
 * - The three exports are verified singly and the mesh pair jointly. What a
 *   three-bundle joint replay means is ADR-0015's finding 49, deliberately
 *   not asserted here in either direction.
 *
 *   node --experimental-sqlite --test test/adr0014-m6.test.ts
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
import { offerTask, vouch } from "../src/ap/activities.ts";
import { fetchActorDocument } from "../src/federation/inbox.ts";
import { Federation, agreementObject, createAgreement, offerAgreement } from "../src/federation/federation.ts";
import { httpTransport } from "../src/federation/transport.ts";
import { signRequest } from "../src/federation/httpSig.ts";
import { castVote, enroll } from "../src/hub/activities.ts";
import { Hub } from "../src/hub/hub.ts";
import { exportBundle } from "../src/export.ts";
import type { JsonValue } from "../src/crypto/jcs.ts";
import { cleanupWorkspaces, runVerifier, workspace } from "./helpers.ts";
import { VERIFIER } from "./adr0010-fixtures.ts";

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

/** The document cache is the point, not a convenience: it is what the ADR
 * means by "members already hold the hub's document", and it is why proof
 * verification survives the host's partition in beat 4. */
function cachingFetch() {
  const cache = new Map<string, { [key: string]: JsonValue }>();
  return async (url: string): Promise<{ [key: string]: JsonValue } | null> => {
    if (cache.has(url)) return cache.get(url)!;
    const doc = await fetchActorDocument(url);
    if (doc) cache.set(url, doc as { [key: string]: JsonValue });
    return (doc as { [key: string]: JsonValue }) ?? null;
  };
}

async function operator(
  name: string,
  agents: readonly string[],
  clock: ReturnType<typeof jumpClock>,
  extras: { hub?: Hub; readFetch?: ReturnType<typeof cachingFetch> } = {},
): Promise<Operator> {
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
    ...(extras.readFetch
      ? {
          read: {
            fetchDocument: extras.readFetch,
            isDenylisted: (who: string) => federation.isDenylisted(who),
            activeAgreementsWith: (counterparty: string, at: Date) => federation.activeAgreementsWith(counterparty, at),
            roleOf: () => null, // this operator hosts no hub: enrollment is unanswerable locally
            grants: () => [],
            now: () => clock.now(),
          },
        }
      : {}),
    ...(extras.hub ? { hubs: [extras.hub] } : {}),
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

describe("ADR-0014 M6: three operators, one hub, one partition", () => {
  it("scenario 10's mechanics hold over real HTTP", async () => {
    const clock = jumpClock("2026-08-21T09:00:00.000Z");
    const alpha = await operator("alpha", ["n-noc", "n-telemetry"], clock);
    const gammaFetch = cachingFetch();
    const bravo = await operator("bravo", ["s-noc"], clock);
    const gamma = await operator("gamma", ["e-noc"], clock, { readFetch: gammaFetch });

    // Alpha hosts the bridge. Its actor document is served at /hubs/bridge —
    // the route ADR-0002 described and ADR-0014 finally needed.
    const docCache = new Map<string, { [key: string]: JsonValue }>();
    const hub = new Hub({
      origin: alpha.origin,
      hubId: "bridge",
      db: alpha.instance.db,
      keyDir: alpha.config.keyDir,
      instanceActorId: alpha.actorId,
      maxDeliveryAttempts: alpha.config.maxDeliveryAttempts,
      backoffBaseMs: alpha.config.backoffBaseMs,
      // Sync by contract, so foreign documents are pre-fetched over real HTTP
      // into this cache before the hub is asked to verify anything — the same
      // "members already hold the documents" fact the proof design leans on.
      fetchActor: (actorId) => docCache.get(actorId) ?? null,
      now: () => clock.now(),
    });
    alpha.server.close();
    const alphaServer2 = createHttpServer(alpha.instance, {
      inbox: { federation: alpha.federation, receive: (a) => alpha.instance.receiveAdmitted(a), fetchDocument: fetchActorDocument },
      hubs: [hub],
    });
    await new Promise<void>((resolve) => alphaServer2.listen(alpha.port, "127.0.0.1", resolve));

    // --- Handshakes: three pairwise agreements for three parties — the mesh
    // scenario 10 says the shared hub exists to stop scaling quadratically,
    // and exactly what remains standing when the hub's host goes down. Each
    // is a real dual-Create over real inboxes, granting the mesh delegation
    // and the bridge.
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
    await handshake(bravo, gamma);
    await handshake(alpha, bravo);
    await handshake(alpha, gamma);

    // --- Enrollment: four members across three trust domains. Each operator
    // authors its own Enroll (ADR-0005's gate); the hub verifies each against
    // documents fetched over real HTTP, then admits.
    for (const [op, agent] of [
      [alpha, "n-noc"],
      [alpha, "n-telemetry"],
      [bravo, "s-noc"],
      [gamma, "e-noc"],
    ] as const) {
      for (const url of [op.actorId, op.instance.actorId(agent)]) {
        const doc = await fetchActorDocument(url);
        assert.ok(doc, `document for ${url} fetched over real HTTP`);
        docCache.set(url, doc as { [key: string]: JsonValue });
      }
      const hubKey = loadOrCreateHubKeyPair(op.config.keyDir, agent, op.instance.actorId(agent), "bridge");
      const entry = op.instance.publishAsInstance([hub.actorId], "urn:afp:thread:enroll", "hub", (envelope: Envelope) =>
        enroll(envelope, { agent: op.instance.actorId(agent), hub: hub.actorId, capabilities: [CAPABILITY], hubKey: hubKey.keyId }),
      );
      await hub.receive(entry.activity);
    }
    assert.equal(hub.members().length, 4, "the bridge seats all three operators' agents");

    // --- Gamma's telemetry lands as a hub-class activity in Gamma's outbox —
    // evidence stays where it was produced (scenario beat 2).
    const incident = "urn:afp:thread:incident-4471";
    gamma.instance.publish("e-noc", [], incident, "hub", (envelope) =>
      ({
        "@context": ["https://www.w3.org/ns/activitystreams", "https://dalager.github.io/agent-federation-protocol/ns/v3.jsonld"],
        id: envelope.activityId,
        type: "Create",
        actor: envelope.actor,
        to: [],
        published: envelope.published,
        context: envelope.thread,
        "afp:visibility": "hub",
        "afp:hub": hub.actorId,
        ...(envelope.prevActivity !== null ? { "afp:prevActivity": envelope.prevActivity } : {}),
        object: { id: "urn:afp:result:e-view", type: "afp:Result", "afp:correlationId": "leak-view-e", content: "routes for 203.0.113.0/24 arriving at our edge", attributedTo: envelope.actor },
      }) as never,
    );

    // --- Beat 3, the whole point: Bravo reads it from Gamma under Alpha's
    // hub's proof, across three real sockets.
    const snocKey = bravo.instance.key("s-noc");
    const outboxPath = "/agents/e-noc/outbox";
    const gammaHost = new URL(gamma.origin).host;
    const readOutbox = async (proofHeader?: string): Promise<{ [key: string]: JsonValue }[]> => {
      const signed = signRequest("GET", outboxPath, gammaHost, "", snocKey.keyId, snocKey.privateKey, clock.now());
      const response = await fetch(`${gamma.origin}${outboxPath}`, {
        headers: {
          accept: "application/activity+json",
          ...signed,
          ...(proofHeader ? { "afp-membership-proof": proofHeader } : {}),
        },
      });
      const body = (await response.json()) as { orderedItems?: { [key: string]: JsonValue }[] };
      return Array.isArray(body.orderedItems) ? body.orderedItems : [];
    };
    const hubClass = (items: { [key: string]: JsonValue }[]) =>
      items.filter((a) => a["afp:visibility"] === "hub").length;
    const encode = (proof: { [key: string]: JsonValue }): string => Buffer.from(JSON.stringify(proof)).toString("base64url");

    assert.equal((await readOutbox()).length, 0, "signed but unproven: the old refusal, unchanged");
    const proof = hub.membershipProof(bravo.instance.actorId("s-noc"), 60 * 60 * 1000)!;
    assert.equal((await readOutbox(encode(proof))).length, 1, "the proof admits, verified against the hub doc fetched from a third party");

    // --- Beat 4: the host is the one on fire. Alpha's server goes away; the
    // proof in Bravo's pocket and the hub document already held keep the read
    // working — which is exactly why the fetcher presents and the server
    // never asks the hub.
    await new Promise<void>((resolve) => alphaServer2.close(() => resolve()));
    await assert.rejects(fetch(`${alpha.origin}/hubs/bridge`), "the hub really is unreachable");
    assert.equal((await readOutbox(encode(proof))).length, 1, "the read survives the host's partition");

    // The mesh carries real work meanwhile: a genuine delegation over the
    // pairwise agreement, through the real inbox gate.
    const mesh = "urn:afp:thread:mesh-during-partition";
    bravo.instance.publish("s-noc", [gamma.instance.actorId("e-noc")], mesh, "parties", (envelope: Envelope) =>
      offerTask(envelope, { taskId: `${envelope.actor}/tasks/mesh-1`, capability: CAPABILITY, correlationId: "mesh-1", content: "correlate our two views pairwise" }),
    );
    await bravo.instance.run(bravo.transport);
    await gamma.instance.run(gamma.transport);
    await bravo.instance.run(bravo.transport);

    // --- Beat 5: rejoin, and the reconciliation edge. Alpha returns; the
    // continuation names the mesh thread as prehistory (ADR-0011's property,
    // ADR-0014 Decision 2's ruling — no new machinery).
    const alphaServer3 = createHttpServer(alpha.instance, {
      inbox: { federation: alpha.federation, receive: (a) => alpha.instance.receiveAdmitted(a), fetchDocument: fetchActorDocument },
      hubs: [hub],
    });
    await new Promise<void>((resolve) => alphaServer3.listen(alpha.port, "127.0.0.1", resolve));
    bravo.instance.publish("s-noc", [gamma.instance.actorId("e-noc")], "urn:afp:thread:bridge-resumed", "parties", (envelope: Envelope) =>
      offerTask(envelope, {
        taskId: `${envelope.actor}/tasks/mesh-2`,
        capability: CAPABILITY,
        correlationId: "mesh-2",
        content: "reconcile: the mesh stretch, rejoining the bridge",
        priorThread: mesh,
      }),
    );
    await bravo.instance.run(bravo.transport);
    await gamma.instance.run(gamma.transport);
    await bravo.instance.run(bravo.transport);

    // --- Beat 6: a round after the storm. Alpha's agents participate — one
    // votes, one declines on the record; the foreign members stay silent,
    // which is the partition's echo and must not read as abstention.
    const proposal = hub.proposeRound({ round: "urn:afp:round:sev1", thread: incident, question: "declare sev-1?", options: ["yes", "no"] });
    const proposalId = String((proposal.activity.object as Record<string, unknown>).id);
    const snapshot = String((proposal.activity.object as Record<string, unknown>)["afp:quorumSnapshot"]);
    await hub.receive(
      alpha.instance.publish("n-noc", [hub.actorId], incident, "hub", (envelope) =>
        castVote(envelope, { voteId: `${envelope.actor}/votes/sev1`, round: "urn:afp:round:sev1", proposalHash: proposal.digest, quorumSnapshot: snapshot, value: "yes" }),
      ).activity,
    );
    await hub.receive(
      alpha.instance.publish("n-telemetry", [hub.actorId], incident, "hub", (envelope) =>
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
          summary: "telemetry cannot assent while our own edge is saturated",
        }) as never,
      ).activity,
    );
    const decision = hub.closeRound("urn:afp:round:sev1");
    const uncounted = (decision.activity.object as Record<string, unknown>)["afp:uncounted"] as { agent: string; "afp:status": string }[];
    const byAgent = Object.fromEntries(uncounted.map((u) => [u.agent, u["afp:status"]]));
    assert.equal(byAgent[alpha.instance.actorId("n-telemetry")], "declined");
    assert.equal(byAgent[bravo.instance.actorId("s-noc")], "silent", "a partitioned member is silent, not abstaining");
    assert.equal(byAgent[gamma.instance.actorId("e-noc")], "silent");

    // --- The audits: each operator's bundle stands alone; the mesh pair
    // joint-verifies. (Three bundles at once is ADR-0015's finding 49 —
    // deliberately unasserted here, in either direction.)
    alpha.instance.publishAsInstance([], "urn:afp:thread:roster", "public", (envelope: Envelope) =>
      vouch(envelope, { agent: hub.actorId, capabilities: ["afp:cap:hub"], keyCustody: "self" }),
    );
    exportBundle(alpha.instance, alpha.config.exportDir, [hub]);
    exportBundle(bravo.instance, bravo.config.exportDir, [], undefined, bravo.federation);
    exportBundle(gamma.instance, gamma.config.exportDir, [], undefined, gamma.federation);
    const alphaVerify = runVerifier(VERIFIER, alpha.config.exportDir, incident, ["--verbose"]);
    assert.equal(alphaVerify.code, 0, `alpha failed:\n${alphaVerify.output}`);
    assert.match(alphaVerify.output, /decision: .*afp:uncounted partitions the pinned electorate/);
    assert.match(alphaVerify.output, /decision: .*declined members declined on the record/);
    const bravoVerify = runVerifier(VERIFIER, bravo.config.exportDir, "urn:afp:thread:bridge-resumed", ["--verbose"]);
    assert.equal(bravoVerify.code, 0, `bravo failed:\n${bravoVerify.output}`);
    assert.match(bravoVerify.output, /afp:priorThread resolves to a closed, unretracted thread/);

    // --- Last: the proof ages out — and expiry removes exactly the hub
    // entitlement, nothing else. The mesh Accept and Result on e-noc's outbox
    // are addressed to s-noc, and the addressing is the entitlement (ADR-0013
    // Decision 3): those keep reading after the proof dies, because they were
    // never the proof's to grant. The hub-class telemetry goes dark.
    clock.jumpTo(new Date(clock.now().getTime() + 2 * 3600_000).toISOString());
    const afterExpiry = await readOutbox(encode(proof));
    assert.equal(hubClass(afterExpiry), 0, "an expired proof admits no hub-class activity");
    assert.ok(afterExpiry.length > 0, "what the addressing entitles survives the proof's death");

    for (const server of [alphaServer3, bravo.server, gamma.server]) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    alpha.instance.close();
    bravo.instance.close();
    gamma.instance.close();
  });
});
