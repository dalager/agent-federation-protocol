/**
 * The P7 demo: four support desks, one retainer, and a number that has to
 * survive being recomputed by somebody who disagrees (ADR-0022, scenario 13).
 *
 * Northwind hosts the `nightdesk` hub and serves it at a real inbox; three
 * other desks enroll across the boundary and work the queue over the socket.
 * A quarter of out-of-hours support runs through the ordinary P3 auction —
 * announce, bid, award, answer, settle — and then the thing P7 exists for
 * happens: somebody adds it up, and somebody else adds it up differently.
 *
 * **Nobody in this demo misbehaves.** That is the whole point and it is what
 * separates this from every earlier phase's demo. P6 needed an equivocator; P5
 * needed a partition; here four honest desks recompute the same quarter and
 * reach two different answers, because one of them cannot read a fifth of the
 * work — 07's visibility classes and ADR-0013's read gate both behaving exactly
 * as designed. The disagreement is manufactured by the protocol's own silence,
 * and closing it is what ADR-0022 did.
 *
 * The five beats, and the finding each one is:
 *
 *  - **The period has an edge, and it is the hub's chain rather than a clock.**
 *    One ticket is settled before the quarter opens. Its wall-clock timestamp
 *    sits minutes from the boundary, and no honest desk can be talked into
 *    counting it, because the period is the half-open interval between two of
 *    the hub's own activity digests (finding 68).
 *  - **Co-authored work is credited to its authors, in integers.** The
 *    escalation — Dayshift triages, Kestrel fixes — carries an
 *    `afp:contributionSplit` of positive integer shares, because 03 required
 *    one from v3.4 and no implementation ever emitted it, and because the
 *    fractions 03 specified cannot be canonicalised at all (findings 66, 67).
 *  - **A seat ends inside the quarter, and its work keeps its credit.** Lantern
 *    is expelled by a ratified governance round — ADR-0021's machinery, reused
 *    unchanged — and the summary records the act inside the period rather than
 *    erasing six weeks of somebody's work retroactively (finding 72).
 *  - **Two honest computers, two honest numbers.** Lantern computes the quarter
 *    over what it may read and counts what it may not; Northwind disputes with
 *    evidence; Kestrel recomputes over the wider scope and supersedes. The
 *    difference resolves to a stated cause rather than to an accusation
 *    (findings 69, 70, 73).
 *  - **The dispute ends.** A round ratifies the corrected summary — 04's own
 *    ratification idiom, no second consensus path — and exactly one summary
 *    stands for the period.
 *
 * The four bundles this leaves on disk replay clean, jointly, with every
 * contribution check running: the entries recompute, the input hash matches the
 * set the frame declares, the unreadable census agrees, and no second ratified
 * summary competes with the one that stands.
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
import { createResult, vouch } from "./ap/activities.ts";
import { fetchActorDocument } from "./federation/inbox.ts";
import { Federation, agreementObject, createAgreement, offerAgreement } from "./federation/federation.ts";
import { httpTransport } from "./federation/transport.ts";
import { signRequest } from "./federation/httpSig.ts";
import { loadOrCreateHubKeyPair } from "./crypto/keys.ts";
import { castVote, enroll, memberExpel } from "./hub/activities.ts";
import { bidPayload, commitmentOf } from "./allocation/activities.ts";
import { digestOf } from "./crypto/proof.ts";
import { Hub } from "./hub/hub.ts";
import {
  computeContribution,
  contributionDispute,
  contributionSummary,
  type SummaryFrame,
} from "./hub/summary.ts";
import { GOVERNANCE_OPTIONS, GOVERNANCE_POLICY } from "./demoP6.ts";
import { exportBundle, type ExportSummary } from "./export.ts";
import { jumpClock } from "./demoP3.ts";
import type { JsonValue } from "./crypto/jcs.ts";
import { fileSigner } from "./crypto/signer.ts";

const CAPABILITY = "afp:cap:support";
const HUB_ID = "nightdesk";
/** The vocabulary a summary says it was computed under (ADR-0022 Decision 1, finding 74). */
const VOCABULARY = "v3.30";

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

export interface Desk {
  name: string;
  agents: string[];
  instance: AfpInstance;
  federation: Federation;
  server: Server;
  port: number;
  origin: string;
  actorId: string;
  transport: ReturnType<typeof httpTransport>;
  config: ReturnType<typeof loadConfig>;
}

async function desk(
  name: string,
  agents: readonly string[],
  rootDir: string,
  exportRoot: string,
  clock: ReturnType<typeof jumpClock>,
): Promise<Desk> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const config = loadConfig({
    origin,
    dataDir: resolve(rootDir, name),
    exportDir: resolve(exportRoot, name),
    brain: "stub",
    operator: `${name[0].toUpperCase()}${name.slice(1)} Support`,
    instanceName: `${name} instance`,
  });
  const registrations: AgentRegistration[] = agents.map((agent) => ({
    spec: { name: agent, capabilities: [CAPABILITY], keyCustody: "instance", since: "2026-08-17T00:00:00Z" },
    brain: new CountingBrain(agent, [CAPABILITY], () => ({ ok: true, content: `${name}: handled` })),
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
  return { name, agents: [...agents], instance, federation, server, port, origin, actorId, transport, config };
}

/**
 * What a desk did with a ticket, and what produced the account of it. In the
 * default demo this is scripted determinism; in the Lemonade experiment
 * (`experimentP7.ts`) it is a real model reading the ticket and its own desk's
 * part in it. Either way the value that lands on the record is the same shape,
 * and — this is the part that matters for P7 — **the arithmetic is untouched
 * by it.** A model may argue about how a collaboration divides; it may not
 * compute the quarter, because a summary anybody has to take on trust is the
 * one thing this phase exists to abolish.
 */
export interface P7Judgement {
  /** Free text the record carries — the answer, or the reason for a vote. */
  content: string;
  /** One line a human reads next to it. Narration, not record. */
  rationale: string;
  /** Model id, or `"stub"`. */
  producedBy: string;
}

/** Injection points for content, so the mechanics stay one implementation. */
export interface P7Content {
  /** What the closing desk wrote when it resolved the ticket. */
  resolve(ticket: string, desk: string): Promise<P7Judgement>;
  /**
   * How a co-authored ticket divides: **positive integer shares**, keyed by
   * agent. The one genuinely contestable judgement in a contribution ledger —
   * two desks worked it, and how much of it is whose is not a fact the record
   * can derive. What the record does instead is make the claim explicit,
   * signed, and checkable against the authors it names.
   */
  split(ticket: string, authors: readonly string[]): Promise<P7Judgement & { shares: Record<string, number> }>;
  /** Whether this desk votes to let the corrected summary stand. */
  ratify(desk: string, view: string): Promise<P7Judgement & { stand: boolean }>;
}

/** One ticket, as it moves through the queue. */
export interface Ticket {
  slug: string;
  content: string;
  /** Local agent name of the desk that fixes it, and the desk it belongs to. */
  performer: { desk: string; agent: string };
  /** A second author, where the ticket was triaged by one desk and fixed by another. */
  triagedBy?: { desk: string; agent: string };
  /** `hub` for ordinary work; `parties` where the ticket carries customer data. */
  visibility: "hub" | "parties";
  /** Integer shares, when two desks authored it (ADR-0022 Decision 2). */
  split?: Record<string, number>;
}

export interface P7DemoResult {
  desks: Record<string, Desk>;
  hub: Hub;
  /** The quarter's boundary, as the hub's own chain digests (ADR-0022 Decision 1). */
  period: { from: string; to: string; opensAfter: string; closesAt: string };
  /** Every ticket the quarter settled, and the one it did not. */
  tickets: { slug: string; performer: string; authors: string[]; visibility: string; inPeriod: boolean }[];
  /** The seat that ended inside the quarter, and the round that ended it. */
  expulsion: { agent: string; round: string; outcome: string; membersBefore: number; membersAfter: number };
  /** The first summary, computed over what its author was entitled to read. */
  draft: {
    id: string;
    computedBy: string;
    scope: string[];
    denominator: number;
    credited: Record<string, number>;
    unreadable: Record<string, number>;
  };
  /** What each desk wrote, and what produced it — narration only. */
  judgements: {
    resolved: Record<string, P7Judgement>;
    split?: P7Judgement & { shares: Record<string, number> };
    ratify: Record<string, P7Judgement & { stand: boolean }>;
  };
  /** Whether the correction was ratified, and by what tally. */
  terminal: { ratified: boolean; outcome: string; tally: Record<string, number> };
  /** The dispute, with the evidence it rests on. */
  dispute: { id: string; by: string; ground: string; evidence: string[] };
  /** The correction, computed over the wider scope, and the round that ratified it. */
  ratified: {
    id: string;
    computedBy: string;
    scope: string[];
    denominator: number;
    credited: Record<string, number>;
    unreadable: Record<string, number>;
    qualified: Record<string, number>;
    membership: { agent: string; act: string }[];
    supersedes: string;
    round: string;
  };
  exports: Record<string, ExportSummary>;
  thread: string;
  exportRoot: string;
  close(): Promise<void>;
}

export async function runP7Demo(
  options: { rootDir?: string; exportRoot?: string; content?: P7Content } = {},
): Promise<P7DemoResult> {
  const content = options.content;
  const rootDir = options.rootDir ?? "./data-p7";
  const exportRoot = options.exportRoot ?? "./export-p7";
  rmSync(rootDir, { recursive: true, force: true });
  rmSync(exportRoot, { recursive: true, force: true });

  const clock = jumpClock();
  const northwind = await desk("northwind", ["triage", "fixer"], rootDir, exportRoot, clock);
  const dayshift = await desk("dayshift", ["triage"], rootDir, exportRoot, clock);
  const kestrel = await desk("kestrel", ["fixer"], rootDir, exportRoot, clock);
  const lantern = await desk("lantern", ["fixer"], rootDir, exportRoot, clock);
  const pool = [northwind, dayshift, kestrel, lantern];
  const foreign = [dayshift, kestrel, lantern];
  const byName: Record<string, Desk> = Object.fromEntries(pool.map((d) => [d.name, d]));

  const FED = `${northwind.origin}/threads/fed`;
  // One auction per thread, which is the right shape rather than a constraint
  // to work around: a support ticket *is* a thread, and the summary's own join
  // reads it — settlement → task → the task's Announce → the thread → the
  // Results on it. The quarter's governance (the seat round, the ratification,
  // the summaries themselves) rides one thread of its own.
  const thread = `${northwind.origin}/threads/nightdesk-q3`;
  const threadFor = (slug: string): string => `${northwind.origin}/threads/${slug}`;

  // --- Northwind hosts the queue, served at a real inbox (ADR-0016 Decision 1).
  const docCache = new Map<string, { [key: string]: JsonValue }>();
  const cacheDoc = async (url: string): Promise<void> => {
    const doc = await fetchActorDocument(url);
    if (doc) docCache.set(url, doc as { [key: string]: JsonValue });
  };
  const hub = new Hub({
    origin: northwind.origin,
    hubId: HUB_ID,
    db: northwind.instance.db,
    keyDir: northwind.config.keyDir,
    instanceActorId: northwind.actorId,
    maxDeliveryAttempts: northwind.config.maxDeliveryAttempts,
    backoffBaseMs: northwind.config.backoffBaseMs,
    fetchActor: (actorId) => docCache.get(actorId) ?? null,
    now: () => clock.now(),
    resolveActivity: (activityId) =>
      northwind.instance.outbox.get(activityId)?.activity ??
      northwind.federation.receivedActivities().find((r) => String(r.activity.id) === activityId)?.activity ??
      null,
  });
  northwind.server.close();
  const hostServer = createHttpServer(northwind.instance, {
    inbox: {
      federation: northwind.federation,
      receive: (a) => northwind.instance.receiveAdmitted(a),
      fetchDocument: fetchActorDocument,
    },
    hubs: [hub],
  });
  await new Promise<void>((resolveListen) => hostServer.listen(northwind.port, "127.0.0.1", resolveListen));

  const expires = new Date(clock.now().getTime() + 200 * 24 * 3600_000).toISOString();
  const handshake = async (a: Desk, b: Desk): Promise<void> => {
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
  // Every pair, not just each desk with the host: the answers circulate among
  // the desks themselves, and an agreement is what admits them. Without the
  // pairwise grant a delivery is refused, retried, dead-lettered and surfaces
  // as a local `afp:Error` — P1's reliability obligation working exactly as
  // designed, and a good way to discover you modelled the pool wrong.
  for (let i = 0; i < pool.length; i += 1) {
    for (let j = i + 1; j < pool.length; j += 1) await handshake(pool[i], pool[j]);
  }

  // --- Enrollment: the host's seats in-process, the three foreign desks through
  // the socket.
  const enrollThread = `${northwind.origin}/threads/enroll`;
  const postToHub = async (op: Desk, activity: { [key: string]: JsonValue }) => {
    const path = `/hubs/${HUB_ID}/inbox`;
    const body = JSON.stringify(activity);
    const key = op.instance.transportKey("@instance");
    const signed = signRequest("POST", path, new URL(northwind.origin).host, body, fileSigner(key), clock.now());
    return fetch(`${northwind.origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/activity+json", ...signed },
      body,
    });
  };
  const deliver = async (op: Desk, activity: { [key: string]: JsonValue }): Promise<void> => {
    if (op === northwind) await hub.receive(activity);
    else await postToHub(op, activity);
  };

  // ADR-0032 Decision 6: the hub's default seatPolicy is now
  // "follow-required" — every desk Follows the hub before its seats Enroll.
  for (const op of pool) {
    await cacheDoc(op.actorId);
    await deliver(op, op.instance.followHub(hub.actorId).activity);
  }

  for (const op of pool) {
    for (const agent of op.agents) {
      for (const url of [op.actorId, op.instance.actorId(agent)]) await cacheDoc(url);
      const hubKey = loadOrCreateHubKeyPair(op.config.keyDir, agent, op.instance.actorId(agent), HUB_ID);
      const entry = op.instance.publishAsInstance([hub.actorId], enrollThread, "hub", (envelope: Envelope) =>
        enroll(envelope, {
          agent: op.instance.actorId(agent),
          hub: hub.actorId,
          capabilities: [CAPABILITY],
          hubKey: hubKey.keyId,
        }),
      );
      await deliver(op, entry.activity);
    }
  }

  const resolvedBy: Record<string, P7Judgement> = {};
  let splitJudgement: (P7Judgement & { shares: Record<string, number> }) | undefined;

  /** Run one ticket end to end: announce, bid, award, answer, settle. */
  const runTicket = async (ticket: Ticket): Promise<{ settlement: string }> => {
    const taskId = `${hub.actorId}/tasks/${ticket.slug}`;
    const ticketThread = threadFor(ticket.slug);
    const performer = byName[ticket.performer.desk];
    const performerId = performer.instance.actorId(ticket.performer.agent);
    const opens = clock.now().toISOString();
    const closes = new Date(clock.now().getTime() + 3600_000).toISOString();

    hub.allocation.announce({
      taskId,
      thread: ticketThread,
      hub: hub.actorId,
      capability: CAPABILITY,
      content: ticket.content,
      correlationId: ticket.slug,
      bidWindow: { opens, closes },
      selectionRule: { name: "ranking", params: { weights: { capabilityMatch: 1 } } as never },
      answerSufficiency: { count: 1 } as never,
      estimatorPolicy: "exclude",
      estimators: [],
    });

    const payload = bidPayload({
      task: taskId,
      bidder: performerId,
      capabilityMatch: 90,
      estimatedCost: { unit: "EUR", value: 100 },
      estimatedLatency: "PT1H",
      nonce: `nonce-${ticket.slug}`,
    });
    const raw = (op: Desk, agent: string, body: { [key: string]: unknown }) =>
      op.instance.publish(agent, [hub.actorId], ticketThread, "hub", (envelope: Envelope) => ({
        "@context": ["https://www.w3.org/ns/activitystreams", "https://dalager.github.io/agent-federation-protocol/ns/v3.jsonld"],
        id: envelope.activityId,
        actor: envelope.actor,
        to: [...envelope.to],
        published: envelope.published,
        context: envelope.thread,
        "afp:visibility": envelope.visibility,
        ...(envelope.prevActivity !== null ? { "afp:prevActivity": envelope.prevActivity } : {}),
        ...body,
      })).activity as { [key: string]: JsonValue };

    await deliver(
      performer,
      raw(performer, ticket.performer.agent, {
        type: "afp:BidCommit",
        object: taskId,
        "afp:hub": hub.actorId,
        "afp:commitment": commitmentOf(payload),
      }),
    );
    clock.jumpTo(new Date(new Date(closes).getTime() + 1000).toISOString());
    await deliver(
      performer,
      raw(performer, ticket.performer.agent, {
        type: "afp:BidReveal",
        object: { ...payload },
        "afp:hub": hub.actorId,
      }),
    );
    hub.allocation.closeAuction(taskId, new Date(clock.now().getTime() + 3600_000).toISOString());

    // The answer. Where two desks worked it, both are named and the shares say
    // how much of it is whose — integers over their sum, never fractions
    // (ADR-0022 Decision 2; the JCS profile cannot canonicalise a fraction).
    const authors = ticket.triagedBy
      ? [byName[ticket.triagedBy.desk].instance.actorId(ticket.triagedBy.agent), performerId]
      : undefined;
    const resolved = content
      ? await content.resolve(ticket.slug, ticket.performer.desk)
      : { content: `${ticket.slug}: resolved`, rationale: "", producedBy: "stub" };
    resolvedBy[ticket.slug] = resolved;
    // The split is the one judgement in this workload that a model can
    // genuinely make and the record genuinely cannot derive: two desks worked
    // it, and how much of it is whose is a claim, not a fact. So the claim is
    // signed, names exactly its authors, and is checkable — which is all the
    // protocol ever promised about it.
    let shares = ticket.split;
    if (authors && content) {
      const judged = await content.split(ticket.slug, authors);
      shares = judged.shares;
      splitJudgement = judged;
    }
    // Addressed to the queue's members for ordinary work, and to the hub alone
    // where the ticket carries the customer's own data — 07's classes and
    // ADR-0013's gate, doing exactly what they are for.
    // The hub gets its copy through `deliver` below, in-process for the host
    // and over the socket for everyone else; addressing it here as well would
    // hand the host a second copy of its own agent's answer through its own
    // inbox, and one thread would then carry two outcomes for one
    // correlationId.
    // The hub gets its copy through `deliver` below — in-process for the host,
    // over the socket for everyone else — so addressing it here as well would
    // hand the host a second copy of its own agent's answer through its own
    // inbox, and one thread would carry two outcomes for one correlationId.
    //
    // Ordinary work circulates to every desk, which is what a shared queue is.
    // The ticket carrying the customer's own filing circulates to nobody: 07's
    // classes and ADR-0013's gate, doing exactly what they are for, and the one
    // asymmetry this quarter's two computers will disagree about.
    const audience =
      ticket.visibility === "parties" ? [] : pool.filter((d) => d !== performer).map((d) => d.actorId);
    const answer = performer.instance.publish(
      ticket.performer.agent,
      audience,
      ticketThread,
      ticket.visibility,
      (envelope: Envelope) =>
        createResult(envelope, {
          resultId: `${envelope.actor}/results/${ticket.slug}`,
          correlationId: ticket.slug,
          content: resolved.content,
          ...(authors ? { attributedTo: authors, contributionSplit: shares! } : {}),
        }),
    );
    // Delivered, not merely published: the ticket's thread has to reach its
    // terminal outcome in the host's own view of it too, and the host is the
    // one desk that folds every ticket.
    await deliver(performer, answer.activity);
    await performer.instance.run(performer.transport);

    const settlement = hub.allocation.settle(taskId, { [performerId]: { unit: "EUR", value: 110 } } as never);
    clock.jumpTo(new Date(clock.now().getTime() + 24 * 3600_000).toISOString());
    return { settlement: settlement.digest };
  };

  // --- Beat 1: the quarter has an edge. This ticket is settled before it opens,
  // and no honest desk can be talked into counting it — the boundary is the
  // hub's own chain, not a wall-clock window over self-asserted `published`
  // values (finding 68; campaign 7's finding 45 ruled those cannot carry a
  // cross-operator ordering claim).
  const beforeQuarter = await runTicket({
    slug: "ticket-4390-late-september",
    content: "session timeout after the maintenance window",
    performer: { desk: "kestrel", agent: "fixer" },
    visibility: "hub",
  });
  const periodOpensAfter = beforeQuarter.settlement;

  const dayshiftTriage = dayshift.instance.actorId("triage");
  const kestrelFixer = kestrel.instance.actorId("fixer");

  const tickets: Ticket[] = [
    {
      // The escalation, and the shape 03 required a split for since v3.4:
      // Dayshift narrows it, Kestrel closes it, one Result, two authors.
      slug: "ticket-4471-payment-sync",
      content: "payment sync failing for one customer",
      performer: { desk: "kestrel", agent: "fixer" },
      triagedBy: { desk: "dayshift", agent: "triage" },
      visibility: "hub",
      split: { [dayshiftTriage]: 1, [kestrelFixer]: 3 },
    },
    {
      slug: "ticket-4517-webhook-retries",
      content: "webhook retries exhausted for two accounts",
      performer: { desk: "lantern", agent: "fixer" },
      visibility: "hub",
    },
    {
      // Customer data. Published `parties`, so ADR-0013's read gate serves it
      // to nobody unentitled — correctly, and including three competitor desks
      // in the same pool. This is the ticket the quarter's two computers will
      // disagree about (finding 70).
      slug: "ticket-4502-tax-export",
      content: "tax filing export rejected — contains the customer's own filing",
      performer: { desk: "northwind", agent: "fixer" },
      visibility: "parties",
    },
    {
      slug: "ticket-4488-login-loop",
      content: "login loop on the mobile client",
      performer: { desk: "northwind", agent: "fixer" },
      visibility: "hub",
    },
  ];
  const settled: Record<string, string> = {};
  // The first half of the quarter, including the ticket Lantern worked before
  // its seat ended — which is the whole of finding 72: the work is accepted,
  // and then the seat is not.
  for (const ticket of tickets.slice(0, 2)) settled[ticket.slug] = (await runTicket(ticket)).settlement;

  // --- Beat 3: a seat ends inside the quarter. ADR-0021's machinery, reused
  // without modification: the round names its subject and recuses it by a cause
  // anyone can recompute, and a member — never the hub — publishes the act.
  const lanternFixer = lantern.instance.actorId("fixer");
  const govRound = `${northwind.origin}/rounds/lantern-seat`;
  const govProposal = hub.proposeRound({
    round: govRound,
    thread,
    question: `Does ${lanternFixer} keep its seat on the nightdesk?`,
    options: [...GOVERNANCE_OPTIONS],
    governanceSubject: lanternFixer,
    recused: [{ agent: lanternFixer, cause: { "afp:form": "governance-subject" } }],
    pins: { actionPolicy: { ...GOVERNANCE_POLICY } },
  });
  const govSnapshot = String((govProposal.activity.object as Record<string, JsonValue>)["afp:quorumSnapshot"]);
  for (const op of pool) {
    for (const agent of op.agents) {
      const agentId = op.instance.actorId(agent);
      if (!(govProposal.activity.object as Record<string, JsonValue>)["afp:voters"]!.toString().includes(agentId)) continue;
      await deliver(
        op,
        op.instance.publish(agent, [hub.actorId], thread, "hub", (envelope: Envelope) =>
          castVote(envelope, {
            voteId: `${envelope.actor}/votes/lantern-seat`,
            round: govRound,
            hub: hub.actorId,
            proposalHash: govProposal.digest,
            quorumSnapshot: govSnapshot,
            value: "expel",
          }),
        ).activity,
      );
    }
  }
  const membersBefore = hub.members().filter((a) => hub.roleOf(a) === "member").length;
  const govDecision = hub.closeRound(govRound);
  const govOutcome = String((govDecision.activity.object as Record<string, JsonValue>)["afp:outcome"]);
  // Addressed to the whole pool, not just the hub: a membership act is what
  // every later summary's period has to record, and a desk that never received
  // it computes a quarter that disagrees with the case file about who was in
  // the room. 02 makes governance visible to members for exactly this reason.
  // Addressed to the seats that remain, and to the hub. Not to Lantern: it was
  // recused from its own round and never received the pin-bearing proposal, so
  // handing it the actuation alone would leave its case file disclosing an act
  // whose governing pins it cannot resolve (ADR-0010 Decision 5). That the
  // subject of a round is not told about the round is a seam worth noticing —
  // it is out of this ADR's scope, and it is on the record here rather than
  // designed around.
  await deliver(
    northwind,
    northwind.instance.publish("triage", [hub.actorId, dayshift.actorId, kestrel.actorId], thread, "hub", (envelope: Envelope) =>
      memberExpel(envelope, {
        agent: lanternFixer,
        hub: hub.actorId,
        decisionDigest: govDecision.digest,
        action: GOVERNANCE_POLICY.expel,
      }),
    ).activity,
  );
  await northwind.instance.run(northwind.transport);
  const membersAfter = hub.members().filter((a) => hub.roleOf(a) === "member").length;

  // ...and the second half runs with four seats instead of five.
  for (const ticket of tickets.slice(2)) settled[ticket.slug] = (await runTicket(ticket)).settlement;

  // The quarter closes on the hub's own chain head — one digest, observed
  // identically by every member and moveable by none.
  const periodClosesAt = hub.outbox.headDigest(hub.actorId)!;

  // Everything the hub sequenced reaches the desks before anyone adds it up.
  const hubTransportOut = httpTransport({
    signer: fileSigner(northwind.instance.transportKey("@instance")),
    now: () => clock.now(),
    isLocal: (target) => northwind.instance.nameOf(target) !== null || target === northwind.actorId,
    local: northwind.instance.localTransport(),
  });
  await hub.run(hubTransportOut);
  for (const op of pool) await op.instance.run(op.transport);

  // --- Beat 4: two honest computers. The pool every desk folds is the same
  // shape — its own record plus what it received — and the difference between
  // them is entitlement, declared rather than inferred.
  //
  // Every desk folds the same three things: its own record, what it received,
  // and **the hub's own chain**. The last one is not a shortcut — a member
  // cannot resolve the period's interval from its own bundle alone, because it
  // only ever received the hub activities addressed to it and the walk from one
  // digest to another needs them contiguous. The hub's outbox is a published
  // collection every advertised URL answers (ADR-0017 Decision 3), so reading
  // it is exactly what a desk computing a quarter does. What differs between
  // desks is not the chain — it is which *work* they may read, which is the
  // whole disagreement.
  const poolFor = (op: Desk): { [key: string]: JsonValue }[] => [
    ...op.instance.outbox.actors().flatMap((actor) => op.instance.outbox.byActor(actor).map((e) => e.activity)),
    ...op.federation.receivedActivities().map((r) => r.activity),
    ...hub.outbox.byActor(hub.actorId).map((e) => e.activity),
  ];
  const frameFor = (scope: SummaryFrame["inputScope"]["visibility"]): SummaryFrame => ({
    periodRule: { form: "hub-observed", hub: hub.actorId, from: periodOpensAfter, to: periodClosesAt },
    inputScope: { visibility: scope },
    splitRule: { form: "declared-shares" },
    vocabulary: VOCABULARY,
  });
  const operatorOf = (agent: string): string => hub.instanceOf(agent) ?? agent;

  // Dayshift adds up the quarter. It may: computing a summary needs no
  // permission at all — `afp:computedBy` is a field, not a privileged role, and
  // that is the entire reason the object is worth having. What Dayshift does
  // not have is entitlement to one ticket's contents, because it was never a
  // party to it, and ADR-0013's gate is right to keep it that way.
  const draftScope: SummaryFrame["inputScope"]["visibility"] = ["public", "hub"];
  const draftFrame = frameFor(draftScope);
  const draftTotals = computeContribution(poolFor(dayshift), draftFrame, operatorOf)!;
  const draftEntry = dayshift.instance.publish("triage", [], thread, "public", (envelope: Envelope) =>
    contributionSummary(envelope, {
      summaryId: `${envelope.actor}/summaries/2026-q3`,
      hub: hub.actorId,
      computedBy: dayshift.actorId,
      frame: draftFrame,
      totals: draftTotals,
      period: { start: "2026-07-01T00:00:00.000Z", end: "2026-10-01T00:00:00.000Z" },
    }),
  );
  const draftId = String((draftEntry.activity.object as Record<string, JsonValue>).id);
  await dayshift.instance.run(dayshift.transport);

  // Northwind, which holds the ticket Lantern could not read, disputes — with
  // evidence, because a dispute that cites nothing checkable is a claim, and
  // this object exists so that a challenge resolves against the record.
  const disputeEntry = northwind.instance.publish("triage", [], thread, "public", (envelope: Envelope) =>
    contributionDispute(envelope, {
      disputeId: `${envelope.actor}/disputes/2026-q3-1`,
      hub: hub.actorId,
      summary: draftId,
      ground: "omitted-input",
      evidence: [settled["ticket-4502-tax-export"]],
      content: "ticket-4502 settled inside the period and is counted unreadable rather than credited to us",
    }),
  );
  await northwind.instance.run(northwind.transport);

  // Northwind is the party to that ticket, and the only desk entitled to read
  // it, so its recomputation is the one that can credit it. The correction 04
  // invites — made *resolvable* rather than merely assertable by the frame both
  // summaries declare.
  const ratifiedScope: SummaryFrame["inputScope"]["visibility"] = ["public", "hub", "parties"];
  const ratifiedFrame = frameFor(ratifiedScope);
  const ratifiedTotals = computeContribution(poolFor(northwind), ratifiedFrame, operatorOf)!;
  const correctionEntry = northwind.instance.publish("fixer", [], thread, "public", (envelope: Envelope) =>
    contributionSummary(envelope, {
      summaryId: `${envelope.actor}/summaries/2026-q3-corrected`,
      hub: hub.actorId,
      computedBy: northwind.actorId,
      frame: ratifiedFrame,
      totals: ratifiedTotals,
      period: { start: "2026-07-01T00:00:00.000Z", end: "2026-10-01T00:00:00.000Z" },
      supersedes: draftId,
    }),
  );
  const correctionId = String((correctionEntry.activity.object as Record<string, JsonValue>).id);
  await northwind.instance.run(northwind.transport);

  // --- Beat 5: the dispute ends. An ordinary round whose outcome names the
  // summary — 04's own ratification idiom, the same one ADR-0007 reads to tell
  // a ratified Synthesis from a cheap one. No second consensus path, and no
  // privileged computer.
  const ratifyRound = `${northwind.origin}/rounds/ratify-2026-q3`;
  const ratifyProposal = hub.proposeRound({
    round: ratifyRound,
    thread,
    question: "Does this summary stand for the quarter?",
    options: [correctionId, "reject"],
  });
  const ratifySnapshot = String((ratifyProposal.activity.object as Record<string, JsonValue>)["afp:quorumSnapshot"]);
  const voters = (ratifyProposal.activity.object as Record<string, JsonValue>)["afp:voters"] as string[];
  // What each voter is looking at when it decides. The numbers are already
  // recomputable by every one of them — that is the phase's whole claim — so
  // the question a desk actually answers is whether the *frame* is the right
  // one, not whether the arithmetic is right.
  const view = [
    `Period: the hub's chain from ${periodOpensAfter.slice(0, 20)}… to ${periodClosesAt.slice(0, 20)}….`,
    `Scope summed: ${ratifiedScope.join(", ")}.`,
    "Credit, in quarters of a ticket:",
    ...Object.entries(ratifiedTotals.credited)
      .sort()
      .map(([operator, credited]) => `  ${operator}: ${credited}/${ratifiedTotals.denominator}`),
    ratifiedTotals.membership.length
      ? `Membership inside the period: ${ratifiedTotals.membership.map((m) => `${m.agent} ${m.act}`).join(", ")}.`
      : "No membership change inside the period.",
    `It supersedes ${draftId}, which summed only ${draftScope.join(", ")} and counted ${Object.values(draftTotals.unreadable).reduce((a, b) => a + b, 0)} settled task(s) it could not read.`,
  ].join("\n");
  const ratifyJudgements: Record<string, P7Judgement & { stand: boolean }> = {};
  for (const op of pool) {
    for (const agent of op.agents) {
      const agentId = op.instance.actorId(agent);
      if (!voters.includes(agentId)) continue;
      const judged = content
        ? await content.ratify(op.name, view)
        : { stand: true, content: "", rationale: "the frame is the one we agreed", producedBy: "stub" };
      ratifyJudgements[`${op.name}/${agent}`] = judged;
      await deliver(
        op,
        op.instance.publish(agent, [hub.actorId], thread, "hub", (envelope: Envelope) =>
          castVote(envelope, {
            voteId: `${envelope.actor}/votes/ratify-q3`,
            round: ratifyRound,
            hub: hub.actorId,
            proposalHash: ratifyProposal.digest,
            quorumSnapshot: ratifySnapshot,
            value: judged.stand ? correctionId : "reject",
          }),
        ).activity,
      );
    }
  }
  const ratifyDecision = hub.closeRound(ratifyRound);
  const ratifyObject = ratifyDecision.activity.object as Record<string, JsonValue>;
  const ratifyOutcome = String(ratifyObject["afp:outcome"]);
  await hub.run(hubTransportOut);
  for (const op of pool) await op.instance.run(op.transport);

  // --- Exports: four case files, the host's carrying the hub.
  northwind.instance.publishAsInstance([], `${northwind.origin}/threads/roster`, "public", (envelope: Envelope) =>
    vouch(envelope, { agent: hub.actorId, capabilities: ["afp:cap:hub"], keyCustody: "self" }),
  );
  const exports: Record<string, ExportSummary> = {
    northwind: exportBundle(northwind.instance, northwind.config.exportDir, [hub], undefined, northwind.federation),
  };
  for (const op of foreign) {
    exports[op.name] = exportBundle(op.instance, op.config.exportDir, [], undefined, op.federation);
  }

  return {
    desks: byName,
    hub,
    period: {
      from: periodOpensAfter,
      to: periodClosesAt,
      opensAfter: "ticket-4390-late-september",
      closesAt: "the hub's chain head after the seat round",
    },
    tickets: [
      {
        slug: "ticket-4390-late-september",
        performer: kestrelFixer,
        authors: [kestrelFixer],
        visibility: "hub",
        inPeriod: false,
      },
      ...tickets.map((ticket) => ({
        slug: ticket.slug,
        performer: byName[ticket.performer.desk].instance.actorId(ticket.performer.agent),
        authors: ticket.split ? Object.keys(ticket.split) : [byName[ticket.performer.desk].instance.actorId(ticket.performer.agent)],
        visibility: ticket.visibility,
        inPeriod: true,
      })),
    ],
    expulsion: { agent: lanternFixer, round: govRound, outcome: govOutcome, membersBefore, membersAfter },
    draft: {
      id: draftId,
      computedBy: dayshift.actorId,
      scope: [...draftScope],
      denominator: draftTotals.denominator,
      credited: draftTotals.credited,
      unreadable: draftTotals.unreadable,
    },
    judgements: { resolved: resolvedBy, split: splitJudgement, ratify: ratifyJudgements },
    terminal: {
      ratified: ratifyOutcome === correctionId,
      outcome: ratifyOutcome,
      tally: ratifyObject["afp:weightTally"] as Record<string, number>,
    },
    dispute: {
      id: String((disputeEntry.activity.object as Record<string, JsonValue>).id),
      by: northwind.actorId,
      ground: "omitted-input",
      evidence: [settled["ticket-4502-tax-export"]],
    },
    ratified: {
      id: correctionId,
      computedBy: northwind.actorId,
      scope: [...ratifiedScope],
      denominator: ratifiedTotals.denominator,
      credited: ratifiedTotals.credited,
      unreadable: ratifiedTotals.unreadable,
      qualified: ratifiedTotals.qualified,
      membership: ratifiedTotals.membership,
      supersedes: draftId,
      round: ratifyRound,
    },
    exports,
    thread,
    exportRoot,
    async close() {
      await Promise.all(
        [hostServer, ...foreign.map((op) => op.server)].map(
          (server) => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
        ),
      );
      for (const op of pool) op.instance.close();
    },
  };
}
