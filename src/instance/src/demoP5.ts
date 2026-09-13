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
import type { Brain } from "./brains/port.ts";
import { createHttpServer } from "./ap/server.ts";
import type { Envelope } from "./ap/activities.ts";
import { offerTask, vouch } from "./ap/activities.ts";
import { fetchActorDocument } from "./federation/inbox.ts";
import { Federation, agreementObject, createAgreement, offerAgreement } from "./federation/federation.ts";
import { httpTransport } from "./federation/transport.ts";
import { signRequest } from "./federation/httpSig.ts";
import { loadOrCreateHubKeyPair } from "./crypto/keys.ts";
import { castVote, departure, enroll } from "./hub/activities.ts";
import { NO_DECISION_CATEGORY } from "./ap/pins.ts";
import { decisionActionStamp } from "./allocation/actions.ts";
import { Hub } from "./hub/hub.ts";
import { exportBundle, type ExportSummary } from "./export.ts";
import { jumpClock } from "./demoP3.ts";
import type { JsonValue } from "./crypto/jcs.ts";
import { fileSigner } from "./crypto/signer.ts";

const CAPABILITY = "afp:cap:assess";
/** ADR-0018 Decision 2 — the outcome of a round that did not decide. */
const NO_DECISION_OUTCOME = "afp:no-decision";

/**
 * The rulebook the round pins before anyone votes (ADR-0019 W1): one admissible
 * action per way the question can go, including ADR-0018's reserved
 * `afp:no-decision` — because a bridge that cannot agree by the deadline still
 * has to tell the field something, and terminality always releases the actuator
 * (ADR-0010 Decision 4).
 */
const ACTION_POLICY = {
  yes: "declare-sev-1",
  no: "hold-at-sev-2",
  [NO_DECISION_CATEGORY]: "escalate-to-duty-directors",
} as const;

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

/**
 * What an agent concluded about the incident, and what produced the conclusion.
 * In the default demo this is deterministic stub text; in the Lemonade
 * experiment (`experimentP5.ts`) it is a real model reading real telemetry.
 * Either way the vote that lands on the record is `verdict`, and nothing about
 * the hub, the transport, or the DecisionRecord changes shape.
 */
export interface P5Assessment {
  /** One of the round's options — the value the agent's `afp:Vote` carries. */
  verdict: string;
  /** One line a human can read next to the vote. Narration, not record. */
  rationale: string;
  /** Model id or `"stub"` — copied onto `afp:producedBy` where it is recorded. */
  producedBy: string;
  /** Full assessment text, if the producer wrote one. */
  content?: string;
}

/** Injection points for content, so the mechanics stay one implementation. */
export interface P5Content {
  /** Called once per voting agent, before the round is voted. */
  assess(operator: string, agent: string, role: "member" | "observer"): Promise<P5Assessment>;
  /** A brain for `agent` on `operator`, replacing the deterministic stub. */
  brainFor?(operator: string, agent: string): Brain | null;
  /** The brief s-noc delegates to e-noc after the hub's host is killed. */
  meshBrief?(assessments: Readonly<Record<string, P5Assessment>>): string;
  /** The bulletin the actuator sends once the round closes (ADR-0019). */
  notice?(outcome: string, action: string): string;
}

const STUB_ASSESSMENT: P5Assessment = { verdict: "yes", rationale: "", producedBy: "stub" };

async function operator(
  name: string,
  agents: readonly string[],
  rootDir: string,
  exportRoot: string,
  clock: ReturnType<typeof jumpClock>,
  content?: P5Content,
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
    brain:
      content?.brainFor?.(name, agent) ??
      new CountingBrain(agent, [CAPABILITY], () => ({ ok: true, content: `${name}: assessed, two risks noted` })),
  }));
  const instance = new AfpInstance(config, registrations, clock);
  const actorId = String(instance.instanceDocument().id);
  const federation = new Federation(instance.db, actorId, () => clock.now());
  const server = createHttpServer(instance, {
    inbox: { federation, receive: (activity) => instance.receiveAdmitted(activity), fetchDocument: fetchActorDocument },
  });
  await new Promise<void>((resolveListen) => server.listen(port, "127.0.0.1", resolveListen));
  const transport = httpTransport({
    signer: fileSigner(instance.transportKey("@instance")),
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
  const key = op.instance.transportKey("@instance");
  const signed = signRequest("POST", path, new URL(hubOrigin).host, body, fileSigner(key), clock.now());
  const response = await fetch(`${hubOrigin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/activity+json",
      ...signed,
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
  /** The closing DecisionRecord's outcome and the tally it was read from. */
  outcome: string;
  weightTally: Record<string, number>;
  /** `expired` | `threshold-not-met` when the round reached no decision (ADR-0018). */
  noDecisionReason?: string;
  /** The bar the outcome had to clear, and the clock it had to beat. */
  quorumBar: { rule: string; total: number };
  deadline: string;
  /** What the actuator did about it, and under which declared action (ADR-0019). */
  actuation: { actor: string; action: string; notice: string };
  /** Members that recorded a departure from a binding outcome (ADR-0018 Decision 3). */
  departed: string[];
  /** Replica convergence: members before, after first pull, after second (idempotent) pull. */
  replicaSeats: { before: number; afterPull: number; afterSecondPull: number };
  syncStores: string[];
  /** The kill: did the in-flight mesh task complete, and what did a new hub write get? */
  meshCompleted: boolean;
  deadHubWriteError: string;
  exports: { alpha: ExportSummary; bravo: ExportSummary; gamma: ExportSummary };
  incidentThread: string;
  /** What each voting agent concluded, keyed by local agent name. */
  assessments: Record<string, P5Assessment>;
  /** The mesh Result that survived the hub's death, as it reads on the record. */
  meshResult: { content: string; producedBy: string } | null;
  close(): Promise<void>;
}

export async function runP5Demo(
  options: { rootDir?: string; exportRoot?: string; content?: P5Content } = {},
): Promise<P5DemoResult> {
  const rootDir = options.rootDir ?? "./data-p5";
  const exportRoot = options.exportRoot ?? "./export-p5";
  rmSync(rootDir, { recursive: true, force: true });
  rmSync(exportRoot, { recursive: true, force: true });

  const content = options.content;
  const clock = jumpClock();
  const alpha = await operator("alpha", ["n-noc", "n-telemetry"], rootDir, exportRoot, clock, content);
  const bravo = await operator("bravo", ["s-noc"], rootDir, exportRoot, clock, content);
  const gamma = await operator("gamma", ["e-noc", "e-watcher", "e-notify"], rootDir, exportRoot, clock, content);

  const FED = `${alpha.origin}/threads/fed`;

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

  // --- ADR-0032 Decision 6: the hub's default seatPolicy is now
  // "follow-required" — each operator Follows the bridge before its agents
  // Enroll, in-process for the host and over the socket for every other.
  for (const op of [alpha, bravo, gamma]) {
    await cacheDoc(op.actorId);
    const followEntry = op.instance.followHub(hub.actorId);
    if (op === alpha) await hub.receive(followEntry.activity);
    else await postToHubInbox(op, alpha.origin, followEntry.activity, clock);
  }

  // --- Enrollment. The host's agents enroll in-process (local traffic never
  // crosses its own boundary); every foreign seat arrives through the socket.
  for (const [op, agent, role] of [
    [alpha, "n-noc", "member"],
    [alpha, "n-telemetry", "member"],
    [bravo, "s-noc", "member"],
    [gamma, "e-noc", "member"],
    [gamma, "e-watcher", "observer"],
    // ADR-0019 Decision 2: the seat that carries a decision out. Separate from
    // the observer on purpose — an actuator's hub-visibility activities must
    // ALL carry `afp:actsOn`, so a seat that also casts a (refused) vote could
    // never hold this role. Two seats, two different things.
    [gamma, "e-notify", "actuator"],
  ] as const) {
    for (const url of [op.actorId, op.instance.actorId(agent)]) await cacheDoc(url);
    const hubKey = loadOrCreateHubKeyPair(op.config.keyDir, agent, op.instance.actorId(agent), "bridge");
    const entry = op.instance.publishAsInstance([hub.actorId], `${alpha.origin}/threads/enroll`, "hub", (envelope: Envelope) =>
      enroll(envelope, { agent: op.instance.actorId(agent), hub: hub.actorId, capabilities: [CAPABILITY], hubKey: hubKey.keyId, role }),
    );
    if (op === alpha) await hub.receive(entry.activity);
    else await postToHubInbox(op, alpha.origin, entry.activity, clock);
  }

  // --- A round, voted across the boundary.
  const incident = `${alpha.origin}/threads/incident-9`;
  // The round declares its own terms before a single vote exists (ADR-0018
  // Decision 1, ADR-0019 Decision 1): the bar the outcome must clear, the clock
  // the world imposed rather than the hub, that the outcome binds all three
  // operators jointly, and the one action admissible for each way it can go.
  const deadline = new Date(clock.now().getTime() + 30 * 60_000).toISOString();
  const proposal = hub.proposeRound({
    round: `${alpha.origin}/rounds/sev`,
    thread: incident,
    question: "declare sev-1?",
    options: ["yes", "no"],
    quorumRule: { "afp:form": "majority-of-total" },
    deadline,
    binding: "joint",
    pins: { actionPolicy: ACTION_POLICY, irrevocableActions: Object.values(ACTION_POLICY) },
  });
  const snapshot = String((proposal.activity.object as Record<string, unknown>)["afp:quorumSnapshot"]);

  // Each agent that will vote reads its own operator's evidence and reaches
  // its own conclusion first. The hub never sees the reasoning — only the
  // value — which is the whole reason the DecisionRecord is checkable.
  const assessments: Record<string, P5Assessment> = {};
  for (const [op, agent, role] of [
    [alpha, "n-noc", "member"],
    [bravo, "s-noc", "member"],
    [gamma, "e-noc", "member"],
    [gamma, "e-watcher", "observer"],
  ] as const) {
    assessments[agent] = content ? await content.assess(op.name, agent, role) : STUB_ASSESSMENT;
  }

  const vote = (op: Operator, agent: string) =>
    op.instance.publish(agent, [hub.actorId], incident, "hub", (envelope) =>
      castVote(envelope, {
        voteId: `${envelope.actor}/votes/sev`,
        round: `${alpha.origin}/rounds/sev`,
        hub: hub.actorId,
        proposalHash: proposal.digest,
        quorumSnapshot: snapshot,
        value: assessments[agent]?.verdict ?? "yes",
      }),
    ).activity;

  // The write door, three ways (ADR-0016 Decision 2):
  // 1. an unenrolled agent under a valid operator — refused opaquely;
  const rogue = bravo.instance.publishAsInstance([hub.actorId], incident, "hub", (envelope: Envelope) =>
    castVote(envelope, { voteId: `${envelope.actor}/votes/rogue`, round: `${alpha.origin}/rounds/sev`, hub: hub.actorId, proposalHash: proposal.digest, quorumSnapshot: snapshot, value: "yes" }),
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
  const talliedVotes = hub.roundVotes(`${alpha.origin}/rounds/sev`).length;
  const decision = hub.closeRound(`${alpha.origin}/rounds/sev`);
  const uncountedRaw = ((decision.activity.object as Record<string, unknown>)["afp:uncounted"] ?? []) as {
    agent: string;
    "afp:status": string;
  }[];
  const uncounted = Object.fromEntries(uncountedRaw.map((u) => [u.agent, u["afp:status"]]));
  // The closing record is delivered to the voters before anyone acts on it —
  // an operator that never received the decision cannot resolve the
  // justification an action of its own would name (ADR-0015's per-domain
  // replay: evidence that crossed a boundary is received bytes, or it is
  // nowhere).
  const hubTransportOut = httpTransport({
    signer: fileSigner(alpha.instance.transportKey("@instance")),
    now: () => clock.now(),
    isLocal: (target) => alpha.instance.nameOf(target) !== null || target === alpha.actorId,
    local: alpha.instance.localTransport(),
  });
  await hub.run(hubTransportOut);
  for (const op of [bravo, gamma]) await op.instance.run(op.transport);

  const decisionObject = decision.activity.object as Record<string, unknown>;
  const outcome = String(decisionObject["afp:outcome"]);
  const weightTally = decisionObject["afp:weightTally"] as Record<string, number>;
  const noDecisionReason = decisionObject["afp:noDecisionReason"] as string | undefined;

  // --- The consequence (ADR-0019). The desk that sends the field bulletin has
  // no vote and never had one; what it has is the one seat whose whole warrant
  // is carrying a decision out, and an action the round itself declared
  // admissible for exactly this outcome. Note the reserved key doing its job
  // when the bridge failed to reach its bar: nobody is left waiting.
  const action = ACTION_POLICY[outcome as keyof typeof ACTION_POLICY];
  const notice = content?.notice?.(outcome, action) ?? `${action}: bridge outcome recorded, field notified`;
  const actuation = gamma.instance.publish("e-notify", [hub.actorId], incident, "hub", (envelope: Envelope) =>
    ({
      "@context": ["https://www.w3.org/ns/activitystreams", "https://dalager.github.io/agent-federation-protocol/ns/v3.jsonld"],
      id: envelope.activityId,
      type: "Create",
      actor: envelope.actor,
      to: [...envelope.to],
      published: envelope.published,
      context: envelope.thread,
      "afp:visibility": envelope.visibility,
      ...(envelope.prevActivity !== null ? { "afp:prevActivity": envelope.prevActivity } : {}),
      object: { id: `${envelope.actor}/acts/sev`, type: "afp:Act", "afp:hub": hub.actorId, content: notice },
      ...decisionActionStamp(action, decision.digest, { policy: ACTION_POLICY, outcome }),
    }) as never,
  );
  await postToHubInbox(gamma, alpha.origin, actuation.activity, clock);

  // --- And the counterpart to a binding outcome (ADR-0018 Decision 3): an
  // operator that lost a vote it is bound by says so on its own chain, or the
  // record shows nothing at all. Only where something actually bound it — a
  // round that reached no decision bound nobody.
  const dissenters = hub
    .roundVotes(`${alpha.origin}/rounds/sev`)
    .filter((v) => v.value !== outcome && outcome !== NO_DECISION_OUTCOME);
  const departed: string[] = [];
  for (const { actor } of dissenters.slice(0, 1)) {
    const op = [alpha, bravo, gamma].find((o) => o.instance.nameOf(actor) !== null);
    const name = op?.instance.nameOf(actor);
    if (!op || !name) continue;
    const leaving = op.instance.publish(name, [hub.actorId], incident, "hub", (envelope: Envelope) =>
      departure(envelope, {
        departureId: `${envelope.actor}/departures/sev`,
        hub: hub.actorId,
        round: `${alpha.origin}/rounds/sev`,
        decision: decision.digest,
        reason: "our own telemetry does not support this outcome; we are filtering locally regardless",
      }),
    );
    if (op === alpha) await hub.receive(leaving.activity);
    else await postToHubInbox(op, alpha.origin, leaving.activity, clock);
    departed.push(actor);
  }

  // --- An application-defined store, moved by its own signed activity (Decision 3).
  const backlog = bravo.instance.publish("s-noc", [hub.actorId], incident, "hub", (envelope) =>
    ({
      "@context": ["https://www.w3.org/ns/activitystreams", "https://dalager.github.io/agent-federation-protocol/ns/v3.jsonld"],
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
  const replicaPullTransport = httpTransport({
    signer: fileSigner(alpha.instance.transportKey("@instance")),
    now: () => clock.now(),
    isLocal: () => false,
    local: { name: "none", deliver: async () => {} },
  });
  const pull = async (): Promise<void> => {
    const offer = replica.offerSync(hub.actorId);
    await postToHubInbox(bravo, alpha.origin, offer.activity, clock);
    await hub.run(replicaPullTransport); // the Accept{afp:StateDeltas} rides back to the replica's inbox
  };
  await pull();
  const seatsAfterPull = replica.members().length;
  await pull(); // idempotent: duplicates are free, convergence is a no-op
  const seatsAfterSecondPull = replica.members().length;

  // --- Kill the hub mid-task (the roadmap's P5 kill criterion).
  const mesh = `${bravo.origin}/threads/mesh-9`;
  const brief = content?.meshBrief?.(assessments) ?? "correlate our two views";
  bravo.instance.publish("s-noc", [gamma.instance.actorId("e-noc")], mesh, "parties", (envelope: Envelope) =>
    offerTask(envelope, { taskId: `${envelope.actor}/tasks/m9`, capability: CAPABILITY, correlationId: "m9", content: brief }),
  );
  await new Promise<void>((resolveClose) => alphaServer.close(() => resolveClose()));

  // In-flight completes — the payload path is member to member, never the hub.
  await bravo.instance.run(bravo.transport);
  await gamma.instance.run(gamma.transport);
  await bravo.instance.run(bravo.transport);
  const meshObject = bravo.federation
    .receivedActivities()
    .map((r) => r.activity.object)
    .find(
      (object): object is Record<string, JsonValue> =>
        !!object && typeof object === "object" && !Array.isArray(object) && (object as Record<string, JsonValue>).type === "afp:Result",
    );
  const meshCompleted = meshObject !== undefined;
  const meshResult = meshObject
    ? { content: String(meshObject.content ?? ""), producedBy: String(meshObject["afp:producedBy"] ?? "stub") }
    : null;

  // A new write toward the dead hub fails to its caller — visible degradation
  // (ADR-0014 Decision 2), never a queue's silence.
  let deadHubWriteError = "";
  try {
    await postToHubInbox(gamma, alpha.origin, vote(gamma, "e-noc"), clock);
  } catch (error) {
    deadHubWriteError = String((error as Error).cause ?? (error as Error).message);
  }

  // --- Exports: three case files, the hub host's including the bridge.
  alpha.instance.publishAsInstance([], `${alpha.origin}/threads/roster`, "public", (envelope: Envelope) =>
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
    outcome,
    weightTally,
    noDecisionReason,
    quorumBar: {
      rule: "majority-of-total",
      total: Object.values((proposal.activity.object as Record<string, unknown>)["afp:voterWeights"] as Record<string, number>).reduce((a, b) => a + b, 0),
    },
    deadline,
    actuation: { actor: gamma.instance.actorId("e-notify"), action, notice },
    departed,
    replicaSeats: { before: seatsBefore, afterPull: seatsAfterPull, afterSecondPull: seatsAfterSecondPull },
    syncStores: Object.keys(hub.syncVector()).sort(),
    meshCompleted,
    deadHubWriteError,
    exports,
    incidentThread: incident,
    assessments,
    meshResult,
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
