/**
 * The P5 demo: one shared hub, three operators, and the transport that makes
 * it shared (ADR-0014, ADR-0016).
 *
 * Alpha hosts the `bridge` hub and serves it at a real inbox; Bravo and Gamma
 * enroll their agents across the boundary through `POST /hubs/bridge/inbox`.
 * A round runs with votes arriving over the socket; an unenrolled agent is
 * refused opaquely — and refused identically while waving a perfectly valid
 * membership proof, because the proof is a read credential and the hub can
 * always ask itself. An observer's vote crosses the door and dies in the
 * handler. An application-defined store takes an explicit signed
 * `Update{afp:CRDTDelta}`. Bravo stands up a bare replica of the bridge and
 * converges it from nothing by `Offer{afp:Digest}` / `Accept{afp:StateDeltas}`
 * — the carried payload is signed activities, never bare deltas. Then the
 * hub's host is killed mid-task: the in-flight mesh delegation completes
 * (the hub never sat on the payload path), and a new write toward the hub
 * fails to its caller instead of vanishing into a queue.
 *
 * Everything here is the machinery the adr0014-m6 and adr0016 gates exercise;
 * the demo's only job is to leave artifacts on disk you can poke at.
 */

import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:net";
import type { Server } from "node:http";

import { loadConfig } from "./config.ts";
import { AfpInstance, type AgentRegistration } from "./instance.ts";
import { CountingBrain } from "./brains/stub.ts";
import { createHttpServer } from "./ap/server.ts";
import type { Envelope } from "./ap/activities.ts";
import { offerTask, vouch } from "./ap/activities.ts";
import { fetchActorDocument } from "./federation/inbox.ts";
import { Federation, agreementObject, createAgreement, offerAgreement } from "./federation/federation.ts";
import { httpTransport } from "./federation/transport.ts";
import { signRequest } from "./federation/httpSig.ts";
import { loadOrCreateHubKeyPair } from "./crypto/keys.ts";
import { castVote, enroll } from "./hub/activities.ts";
import { Hub } from "./hub/hub.ts";
import { exportBundle, type ExportSummary } from "./export.ts";
import { jumpClock } from "./demoP3.ts";
import type { JsonValue } from "./crypto/jcs.ts";

const CAPABILITY = "afp:cap:assess";
const FED = "urn:afp:thread:fed";

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address && typeof address === "object") {
        const port = address.port;
        probe.close(() => resolvePort(port));
      } else {
        probe.close(() => reject(new Error("no port")));
      }
    });
  });
}

export interface Operator {
  name: string;
  instance: AfpInstance;
  federation: Federation;
  server: Server;
  port: number;
  origin: string;
  actorId: string;
  transport: ReturnType<typeof httpTransport>;
  config: ReturnType<typeof loadConfig>;
}

async function operator(
  name: string,
  agents: readonly string[],
  rootDir: string,
  exportRoot: string,
  clock: ReturnType<typeof jumpClock>,
): Promise<Operator> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const config = loadConfig({
    origin,
    dataDir: resolve(rootDir, name),
    exportDir: resolve(exportRoot, name),
    brain: "stub",
    operator: `${name[0].toUpperCase()}${name.slice(1)} Operator`,
    instanceName: `${name} instance`,
  });
  const registrations: AgentRegistration[] = agents.map((agent) => ({
    spec: { name: agent, capabilities: [CAPABILITY], keyCustody: "instance", since: "2026-08-17T00:00:00Z" },
    brain: new CountingBrain(agent, [CAPABILITY], () => ({ ok: true, content: `${name}: assessed, two risks noted` })),
  }));
  const instance = new AfpInstance(config, registrations, clock);
  const actorId = String(instance.instanceDocument().id);
  const federation = new Federation(instance.db, actorId, () => clock.now());
  const server = createHttpServer(instance, {
    inbox: { federation, receive: (activity) => instance.receiveAdmitted(activity), fetchDocument: fetchActorDocument },
  });
  await new Promise<void>((resolveListen) => server.listen(port, "127.0.0.1", resolveListen));
  const transport = httpTransport({
    keyId: instance.key("@instance").keyId,
    privateKey: instance.key("@instance").privateKey,
    now: () => clock.now(),
    isLocal: (target) => instance.nameOf(target) !== null || target === actorId,
    local: instance.localTransport(),
  });
  return { name, instance, federation, server, port, origin, actorId, transport, config };
}

/** POST one signed activity to the bridge inbox over a real socket, as `op`'s instance. */
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

export interface P5DemoResult {
  alpha: Operator;
  bravo: Operator;
  gamma: Operator;
  hub: Hub;
  replica: Hub;
  /** Seats on the bridge, and who holds the observer one. */
  members: string[];
  observer: string;
  /** The write door's answers: rogue write, and the same write with a valid proof presented. */
  rogueStatus: number;
  provenRogueStatus: number;
  /** The observer's vote: door status, and whether the handler tallied it. */
  observerVoteStatus: number;
  talliedVotes: number;
  /** The closing DecisionRecord's afp:uncounted, agent → status. */
  uncounted: Record<string, string>;
  /** Replica convergence: members before, after first pull, after second (idempotent) pull. */
  replicaSeats: { before: number; afterPull: number; afterSecondPull: number };
  syncStores: string[];
  /** The kill: did the in-flight mesh task complete, and what did a new hub write get? */
  meshCompleted: boolean;
  deadHubWriteError: string;
  exports: { alpha: ExportSummary; bravo: ExportSummary; gamma: ExportSummary };
  incidentThread: string;
  close(): Promise<void>;
}

export async function runP5Demo(options: { rootDir?: string; exportRoot?: string } = {}): Promise<P5DemoResult> {
  const rootDir = options.rootDir ?? "./data-p5";
  const exportRoot = options.exportRoot ?? "./export-p5";
  rmSync(rootDir, { recursive: true, force: true });
  rmSync(exportRoot, { recursive: true, force: true });

  const clock = jumpClock();
  const alpha = await operator("alpha", ["n-noc", "n-telemetry"], rootDir, exportRoot, clock);
  const bravo = await operator("bravo", ["s-noc"], rootDir, exportRoot, clock);
  const gamma = await operator("gamma", ["e-noc", "e-watcher"], rootDir, exportRoot, clock);

  // --- Alpha hosts the bridge, served at a real inbox (ADR-0016 Decision 1).
  const docCache = new Map<string, { [key: string]: JsonValue }>();
  const cacheDoc = async (url: string): Promise<void> => {
    const doc = await fetchActorDocument(url);
    if (doc) docCache.set(url, doc as { [key: string]: JsonValue });
  };
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
  await new Promise<void>((resolveListen) => alphaServer.listen(alpha.port, "127.0.0.1", resolveListen));

  // --- Three pairwise agreements: delegation for the mesh, the hub grant for the bridge.
  const expires = new Date(clock.now().getTime() + 6 * 3600_000).toISOString();
  const handshake = async (a: Operator, b: Operator): Promise<void> => {
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

  // --- Enrollment. The host's agents enroll in-process (local traffic never
  // crosses its own boundary); every foreign seat arrives through the socket.
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
    if (op === alpha) await hub.receive(entry.activity);
    else await postToHubInbox(op, alpha.origin, entry.activity, clock);
  }

  // --- A round, voted across the boundary.
  const incident = "urn:afp:thread:incident-9";
  const proposal = hub.proposeRound({ round: "urn:afp:round:sev", thread: incident, question: "declare sev-1?", options: ["yes", "no"] });
  const snapshot = String((proposal.activity.object as Record<string, unknown>)["afp:quorumSnapshot"]);
  const vote = (op: Operator, agent: string) =>
    op.instance.publish(agent, [hub.actorId], incident, "hub", (envelope) =>
      castVote(envelope, {
        voteId: `${envelope.actor}/votes/sev`,
        round: "urn:afp:round:sev",
        hub: hub.actorId,
        proposalHash: proposal.digest,
        quorumSnapshot: snapshot,
        value: "yes",
      }),
    ).activity;

  // The write door, three ways (ADR-0016 Decision 2):
  // 1. an unenrolled agent under a valid operator — refused opaquely;
  const rogue = bravo.instance.publishAsInstance([hub.actorId], incident, "hub", (envelope: Envelope) =>
    castVote(envelope, { voteId: `${envelope.actor}/votes/rogue`, round: "urn:afp:round:sev", hub: hub.actorId, proposalHash: proposal.digest, quorumSnapshot: snapshot, value: "yes" }),
  );
  const rogueStatus = (await postToHubInbox(bravo, alpha.origin, rogue.activity, clock)).status;
  // 2. the same write waving s-noc's valid membership proof — refused just the same;
  const proof = hub.membershipProof(bravo.instance.actorId("s-noc"), 60 * 60 * 1000)!;
  const provenRogueStatus = (
    await postToHubInbox(bravo, alpha.origin, rogue.activity, clock, {
      "afp-membership-proof": Buffer.from(JSON.stringify(proof)).toString("base64url"),
    })
  ).status;
  // 3. the enrolled observer — admitted at the door, dead in the handler.
  const observerVoteStatus = (await postToHubInbox(gamma, alpha.origin, vote(gamma, "e-watcher"), clock)).status;

  await hub.receive(vote(alpha, "n-noc"));
  await postToHubInbox(bravo, alpha.origin, vote(bravo, "s-noc"), clock);
  await postToHubInbox(gamma, alpha.origin, vote(gamma, "e-noc"), clock);
  const talliedVotes = hub.roundVotes("urn:afp:round:sev").length;
  const decision = hub.closeRound("urn:afp:round:sev");
  const uncountedRaw = ((decision.activity.object as Record<string, unknown>)["afp:uncounted"] ?? []) as {
    agent: string;
    "afp:status": string;
  }[];
  const uncounted = Object.fromEntries(uncountedRaw.map((u) => [u.agent, u["afp:status"]]));

  // --- An application-defined store, moved by its own signed activity (Decision 3).
  const backlog = bravo.instance.publish("s-noc", [hub.actorId], incident, "hub", (envelope) =>
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
        "afp:delta": { adds: [{ element: "triage-9", tag: "s-noc-1" }], removes: [] },
      },
    }) as never,
  );
  await postToHubInbox(bravo, alpha.origin, backlog.activity, clock);

  // --- The replica: Bravo stands up a bare bridge and converges it from the
  // record, over real sockets (Decision 4 — 02's recovery story, running).
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
  await new Promise<void>((resolveListen) => bravoServer.listen(bravo.port, "127.0.0.1", resolveListen));
  docCache.set(hub.actorId, hub.actorDocument());
  docCache.set(replica.actorId, replica.actorDocument());

  const seatsBefore = replica.members().length;
  const alphaHubTransport = httpTransport({
    keyId: alpha.instance.key("@instance").keyId,
    privateKey: alpha.instance.key("@instance").privateKey,
    now: () => clock.now(),
    isLocal: () => false,
    local: { name: "none", deliver: async () => {} },
  });
  const pull = async (): Promise<void> => {
    const offer = replica.offerSync(hub.actorId);
    await postToHubInbox(bravo, alpha.origin, offer.activity, clock);
    await hub.run(alphaHubTransport); // the Accept{afp:StateDeltas} rides back to the replica's inbox
  };
  await pull();
  const seatsAfterPull = replica.members().length;
  await pull(); // idempotent: duplicates are free, convergence is a no-op
  const seatsAfterSecondPull = replica.members().length;

  // --- Kill the hub mid-task (the roadmap's P5 kill criterion).
  const mesh = "urn:afp:thread:mesh-9";
  bravo.instance.publish("s-noc", [gamma.instance.actorId("e-noc")], mesh, "parties", (envelope: Envelope) =>
    offerTask(envelope, { taskId: `${envelope.actor}/tasks/m9`, capability: CAPABILITY, correlationId: "m9", content: "correlate our two views" }),
  );
  await new Promise<void>((resolveClose) => alphaServer.close(() => resolveClose()));

  // In-flight completes — the payload path is member to member, never the hub.
  await bravo.instance.run(bravo.transport);
  await gamma.instance.run(gamma.transport);
  await bravo.instance.run(bravo.transport);
  const meshCompleted = bravo.federation.receivedActivities().some((r) => {
    const object = r.activity.object;
    return !!object && typeof object === "object" && !Array.isArray(object) && (object as Record<string, JsonValue>).type === "afp:Result";
  });

  // A new write toward the dead hub fails to its caller — visible degradation
  // (ADR-0014 Decision 2), never a queue's silence.
  let deadHubWriteError = "";
  try {
    await postToHubInbox(gamma, alpha.origin, vote(gamma, "e-noc"), clock);
  } catch (error) {
    deadHubWriteError = String((error as Error).cause ?? (error as Error).message);
  }

  // --- Exports: three case files, the hub host's including the bridge.
  alpha.instance.publishAsInstance([], "urn:afp:thread:roster", "public", (envelope: Envelope) =>
    vouch(envelope, { agent: hub.actorId, capabilities: ["afp:cap:hub"], keyCustody: "self" }),
  );
  const exports = {
    // The hub host's bundle carries its received store: the foreign votes its
    // DecisionRecord counts crossed the boundary to reach it, and evidence
    // that crossed is received bytes (ADR-0009) — without them the record's
    // own evidence-set is unanswerable.
    alpha: exportBundle(alpha.instance, alpha.config.exportDir, [hub], undefined, alpha.federation),
    // Bravo's bundle carries the replica: its digest Offers are activities in
    // the replica hub's own outbox, and Alpha holds them as received bytes —
    // a received entry must resolve against its sender's bundle (ADR-0009).
    bravo: exportBundle(bravo.instance, bravo.config.exportDir, [replica], undefined, bravo.federation),
    gamma: exportBundle(gamma.instance, gamma.config.exportDir, [], undefined, gamma.federation),
  };

  return {
    alpha,
    bravo,
    gamma,
    hub,
    replica,
    members: hub.members(),
    observer: gamma.instance.actorId("e-watcher"),
    rogueStatus,
    provenRogueStatus,
    observerVoteStatus,
    talliedVotes,
    uncounted,
    replicaSeats: { before: seatsBefore, afterPull: seatsAfterPull, afterSecondPull: seatsAfterSecondPull },
    syncStores: Object.keys(hub.syncVector()).sort(),
    meshCompleted,
    deadHubWriteError,
    exports,
    incidentThread: incident,
    async close() {
      await Promise.all(
        [bravoServer, gamma.server].map((server) => new Promise<void>((resolveClose) => server.close(() => resolveClose()))),
      );
      alpha.instance.close();
      bravo.instance.close();
      gamma.instance.close();
    },
  };
}
