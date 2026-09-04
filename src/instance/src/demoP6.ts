/**
 * The P6 demo: five reinsurers, one storm, and a signature that voted twice
 * (ADR-0020, scenario 12 beats 3-5).
 *
 * Atlas hosts the `windward` hub and serves it at a real inbox; the other four
 * pool members enroll across the boundary and vote over the socket. The round
 * runs at **L1** — five operators live in it, which is P6's own activation
 * trigger — so every ballot carries `(afp:phase, afp:seqNo, afp:proposalHash)`
 * and an `afp:observedVotes` set, and the round pins its own succession rule
 * before anyone votes.
 *
 * Then the two things the ADR says a demo has to be able to tell apart:
 *
 *  - **Meridian equivocates.** One signature, two prepare votes at the same
 *    `(actor, round, phase, seqNo)`, `yes` to one camp and `no` to the other —
 *    because a stalled round is worth more to Meridian than an honest one. The
 *    hub holds both halves, recomputes `convicts()`, publishes
 *    `Announce{afp:EquivocationProof}` with both signed votes verbatim, and
 *    zeroes Meridian's weight. Nothing is taken on say-so: the proof verifies
 *    standalone, from the two votes alone, in the hands of someone holding
 *    nothing else.
 *  - **Anchor restores from backup.** A disk, not a conspiracy: it comes back
 *    from a snapshot taken before it voted, re-signs the *same* value at the
 *    *same* seqNo with a grown `afp:observedVotes` set, and is therefore
 *    byte-different and tuple-identical — the exact shape of an equivocator.
 *    It is **not** convicted (ADR-0020 Decision 2: values convict, hashes do
 *    not), the duplicate is dropped, and its lawful recovery — re-vote at a
 *    strictly higher seqNo — supersedes in place and counts exactly once.
 *
 * With Meridian unable to cast and the four honest members split 3-1, no
 * option can reach the pinned bar of 4. That is on the record the moment the
 * proof lands, so Harbor demands the close and gets `no-decision`
 * (`quorum-impossible`) in one activity instead of 71 hours of theatre
 * (Decision 4). The contract still needs its determination, so the stall
 * recovery runs — and the pinned `snapshot-order` rule hands the fresh round
 * to the first *unconvicted* seat rather than to whoever has the best
 * reputation, which in this pool is the equivocator (Decision 3).
 *
 * Two honest boundaries, stated here rather than papered over:
 *
 *  1. **The two camps meet at the hub.** Both halves of Meridian's pair are
 *     posted to the hub, which is where the anti-entropy of a one-hub mesh
 *     actually happens. The harder case — each half sitting in a *different*
 *     domain's received-bytes record with nobody announcing a proof — is not
 *     something a passing bundle can contain, and it is gated instead by
 *     `test/adr0020.test.ts` G9/G13, where the joint replay fails it by name.
 *  2. **The successor round is published, not tallied.** `Hub.proposeRound`
 *     signs as the hub, and the entitled successor is always a member, so the
 *     successor proposal here is member-signed at the wire (as ADR-0020's
 *     build note 2 records). Replay checks the entitlement; a hub-side path
 *     for member proposals is future work.
 *
 * The five bundles this leaves on disk replay clean, jointly, with the
 * equivocation searchlight running and finding nothing to report — because
 * the duty to announce was discharged.
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
import { keyCompromiseClaim, vouch } from "./ap/activities.ts";
import { fetchActorDocument } from "./federation/inbox.ts";
import { Federation, agreementObject, createAgreement, offerAgreement } from "./federation/federation.ts";
import { httpTransport } from "./federation/transport.ts";
import { signRequest } from "./federation/httpSig.ts";
import { loadOrCreateHubKeyPair } from "./crypto/keys.ts";
import { castVote, enroll, memberExpel, offerProposal } from "./hub/activities.ts";
import { convicts, voteTupleOf } from "./hub/equivocation.ts";
import { NO_DECISION_CATEGORY } from "./ap/pins.ts";
import { decisionActionStamp } from "./allocation/actions.ts";
import { digestOf } from "./crypto/proof.ts";
import { Hub } from "./hub/hub.ts";
import { exportBundle, type ExportSummary } from "./export.ts";
import { jumpClock } from "./demoP3.ts";
import type { JsonValue } from "./crypto/jcs.ts";
import { fileSigner } from "./crypto/signer.ts";

const CAPABILITY = "afp:cap:assess";
const HUB_ID = "windward";
/**
 * The determination, worded once. Both the trigger round and the successor
 * round ask it, and the narration prints it — three places that must agree,
 * because a successor round asking a subtly different question is not a
 * successor round at all.
 */
export const QUESTION = "Did Storm Dagmar cross the contract's pinned parametric thresholds?";
/** ADR-0018 Decision 2 — the outcome of a round that did not decide. */
const NO_DECISION_OUTCOME = "afp:no-decision";

/**
 * The Byzantine minimum over five seats at one weight each: `floor(2n/3)+1`.
 * Pinned as `explicit` rather than derived, because the contract's own terms
 * name the number — and because a bar this round can be *proved* unable to
 * reach is the whole point of beat 4.
 */
const QUORUM_THRESHOLD = 4;

/** Anchor's lawful recovery: re-vote at a strictly higher seqNo than its lost one. */
const ANCHOR_REVOTE_SEQ = 2;

/**
 * The governance round's rulebook (ADR-0021 Decision 4b). A governance round is
 * an ordinary round with a subject — no second consensus path — so it pins an
 * action policy like any other, and `afp:no-decision` gets one too: a pool that
 * cannot agree to expel has not thereby agreed to expel.
 */
export const GOVERNANCE_POLICY = {
  expel: "expel-member",
  keep: "retain-member",
  [NO_DECISION_CATEGORY]: "retain-member",
} as const;

/**
 * The seat round's options, and the reason they are not `yes`/`no`: this
 * question means the opposite of the determination's, so a shared yes/no
 * vocabulary asks every reader — and every model — to hold an inversion in
 * their head for one round only. Run against a real local model, that is
 * exactly what went wrong: a desk returned `no` under a sentence arguing for
 * expulsion, and the narration printed the contradiction faithfully. Options
 * are arbitrary strings to the protocol, so the cheapest fix is to stop
 * inverting anything and let the ballot say what it means.
 */
export const GOVERNANCE_OPTIONS = ["expel", "keep"] as const;

/**
 * Three of the four seats that remain once the accused is recused. The
 * denominator is four rather than five, and it is smaller for a reason the
 * record carries: the snapshot never contained the recused seat (ADR-0021
 * Decision 3). Zeroing could not have done this — a proof must never be able
 * to lower a bar.
 */
const GOVERNANCE_BAR = 3;

/**
 * The rulebook the trigger round pins before anyone votes (ADR-0019 W1). Money
 * is the consequence, so `afp:no-decision` has an action too: a determination
 * that fails to close still has to release the desk, and in this pool it
 * releases it into the arbitration Meridian's retrocession contract is written
 * against — which is exactly what a stalled round is worth to Meridian, and
 * exactly why the equivocation happens.
 */
export const ACTION_POLICY = {
  yes: "pay-parametric-trigger",
  no: "close-file-no-payout",
  [NO_DECISION_CATEGORY]: "refer-to-arbitration-panel",
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

export interface Member {
  name: string;
  /** The one `underwriter`-class agent this operator seats on the hub. */
  agent: string;
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
 * What an underwriter concluded about the storm, and what produced the
 * conclusion. In the default demo this is scripted determinism; in the
 * Lemonade experiment (`experimentP6.ts`) it is a real model reading its own
 * operator's exposure and the met office bulletin. Either way the value that
 * lands on the record is `verdict`, and nothing about the hub, the proof, the
 * doom arithmetic or the succession changes shape.
 */
export interface P6Assessment {
  /** One of the round's options — the value the agent's `afp:Vote` carries. */
  verdict: string;
  /** One line a human can read next to the vote. Narration, not record. */
  rationale: string;
  /** Model id or `"stub"`. */
  producedBy: string;
  /** Full assessment text, if the producer wrote one. */
  content?: string;
}

/**
 * Injection points for content, so the mechanics stay one implementation.
 *
 * Deliberately narrower than `P5Content`, which also carries a `brainFor`:
 * nothing in this demo delegates a task, so no agent brain is ever invoked and
 * a brain injector here would be a field nobody reads. P5 has one because its
 * mesh leg genuinely runs a delegated question through a model.
 */
export interface P6Content {
  /** Called once per voting member, before the round is voted. */
  assess(operator: string, agent: string): Promise<P6Assessment>;
  /**
   * Called once per *remaining* seat in the governance round (ADR-0021), with
   * the dossier the pool is weighing: the conviction, and the accused
   * operator's own statement about it. `yes` expels.
   */
  judge?(operator: string, agent: string, dossier: string): Promise<P6Assessment>;
  /** The instruction the actuator carries out once the round closes (ADR-0019). */
  notice?(outcome: string, action: string): string;
}

/**
 * The scripted split, used when no content injector is supplied: three of the
 * four honest members read the met data as a trigger, Pelican — which pays
 * out heavily on yes — does not. A demo where everyone agrees never tests the
 * count, and a doomed round needs a count worth testing.
 */
const SCRIPTED: Record<string, P6Assessment> = {
  "atl-uw": { verdict: "yes", rationale: "central pressure and track both inside the pinned thresholds", producedBy: "stub" },
  "pel-uw": { verdict: "no", rationale: "the reference station's 10-minute sustained wind never crossed the trigger", producedBy: "stub" },
  "anc-uw": { verdict: "yes", rationale: "landfall track is unambiguous; the pressure reading confirms it", producedBy: "stub" },
  "har-uw": { verdict: "yes", rationale: "both pinned parameters cleared, on the contract's own reference station", producedBy: "stub" },
  // Meridian's honest determination — the half it tells the first camp. Only
  // its *contradiction* is scripted (see beat 3); this value is its own.
  "mer-uw": { verdict: "yes", rationale: "the corridor and the pressure reading both clear; the wind sits inside the error bar", producedBy: "stub" },
};

/**
 * How the pool votes on expelling the equivocator, when no content injector is
 * supplied. Anchor votes to keep it — the member that spent this same round
 * looking exactly like a cheat is the one least willing to treat a signature
 * as a whole story. A unanimous expulsion would prove nothing about the
 * machinery; a 3-1 that still clears its pinned bar proves the arithmetic.
 */
const SCRIPTED_JUDGMENT: Record<string, P6Assessment> = {
  "atl-uw": { verdict: "expel", rationale: "two contradicting ballots under one signature, recomputable by anyone", producedBy: "stub" },
  "pel-uw": { verdict: "expel", rationale: "the claim explains the how; it does not explain away the two signatures", producedBy: "stub" },
  "har-uw": { verdict: "expel", rationale: "the member profiting from a failed round is the member that broke it", producedBy: "stub" },
  "anc-uw": { verdict: "keep", rationale: "we were nearly convicted by our own disk this morning; a capture claim deserves the hearing", producedBy: "stub" },
};

async function member(
  name: string,
  agents: readonly { agent: string; role: "member" | "actuator" }[],
  rootDir: string,
  exportRoot: string,
  clock: ReturnType<typeof jumpClock>,
  content?: P6Content,
): Promise<Member> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const config = loadConfig({
    origin,
    dataDir: resolve(rootDir, name),
    exportDir: resolve(exportRoot, name),
    brain: "stub",
    operator: `${name[0].toUpperCase()}${name.slice(1)} Re`,
    instanceName: `${name} instance`,
  });
  const registrations: AgentRegistration[] = agents.map(({ agent }) => ({
    spec: { name: agent, capabilities: [CAPABILITY], keyCustody: "instance", since: "2026-08-17T00:00:00Z" },
    // Every seat keeps the deterministic stub: this demo delegates no task, so
    // a brain is never called. What the underwriters "think" arrives through
    // `content.assess`, which is the only place a model has anything to do.
    brain: new CountingBrain(agent, [CAPABILITY], () => ({ ok: true, content: `${name}: determination assessed` })),
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
  return { name, agent: agents[0].agent, instance, federation, server, port, origin, actorId, transport, config };
}

/** POST one signed activity to the windward inbox over a real socket. */
async function postToHubInbox(
  op: Member,
  hubOrigin: string,
  activity: { [key: string]: JsonValue },
  clock: ReturnType<typeof jumpClock>,
): Promise<{ status: number; body: { [key: string]: JsonValue } }> {
  const path = `/hubs/${HUB_ID}/inbox`;
  const body = JSON.stringify(activity);
  const key = op.instance.transportKey("@instance");
  const signed = signRequest("POST", path, new URL(hubOrigin).host, body, fileSigner(key), clock.now());
  const response = await fetch(`${hubOrigin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/activity+json", ...signed },
    body,
  });
  return { status: response.status, body: (await response.json()) as { [key: string]: JsonValue } };
}

export interface P6DemoResult {
  atlas: Member;
  meridian: Member;
  pelican: Member;
  anchor: Member;
  harbor: Member;
  hub: Hub;
  /** The pinned electorate, in declared order — the order succession rotates through. */
  voters: string[];
  /** The bar, and the total it was computed over (ADR-0018 W2, unchanged by zeroing). */
  quorumBar: { rule: string; threshold: number; total: number };
  deadline: string;
  /** What each underwriter concluded, keyed by local agent name. */
  assessments: Record<string, P6Assessment>;
  /** The equivocation: who, and the proof the hub assembled from the two signed votes. */
  conviction: {
    actor: string;
    proofId: string;
    /** Both halves, as they read on the wire — same tuple, different value. */
    halves: { digest: string; value: string; observed: number }[];
    /** Recomputed here from the published proof alone, the way a stranger would. */
    verifiesStandalone: boolean;
  };
  /** The backup-restore that looks identical on the wire and is not a conviction. */
  restore: {
    actor: string;
    /** The re-signed duplicate: same tuple, same value, grown observed-set, different digest. */
    duplicateDigest: string;
    /** The value it re-signed — its own assessment, whatever that turned out to be. */
    value: string;
    sameTupleAsFirst: boolean;
    convicted: boolean;
    /** The lawful recovery move, and the receipt it superseded in place. */
    revoteSeqNo: number;
    countedDigest: string;
    receiptsForActor: number;
  };
  /** The doom arithmetic at the moment of the demand, recomputed from the record. */
  doom: { attainable: Record<string, number>; bar: number; doomed: boolean; demandedBy: string };
  /** The closing DecisionRecord. */
  outcome: string;
  noDecisionReason?: string;
  weightTally: Record<string, number>;
  countedVotes: number;
  uncounted: Record<string, string>;
  /** Stall recovery (Decision 3): who the pinned rule entitles, and who it skipped. */
  succession: { rule: string; entitled: string | null; skipped: string[]; freshRound: string; supersedes: string };
  /** What the actuator did about it, under the action the round declared (ADR-0019). */
  actuation: { actor: string; action: string; notice: string };
  /**
   * ADR-0021 Decision 4a — what the convicted operator put on the record, and
   * what it changed (nothing, which is the point).
   */
  claim: {
    id: string;
    /** The operator that published it — the convicted agent's own instance. */
    by: string;
    /** That operator's short name, for narration that should not print "actor". */
    byOperator: string;
    verificationMethod: string;
    since: string;
    /** Measured after the claim landed, not asserted: the seat is still zeroed. */
    weightStillZero: boolean;
    /** Whether the pool's other operators hold a copy, or only the joint case file does. */
    heldByPeers: boolean;
  };
  /**
   * ADR-0021 Decisions 2-4 — the governance round about the convicted seat:
   * an ordinary round with a subject, whose subject is out of its own
   * electorate by a rule anyone can recompute.
   */
  governance: {
    round: string;
    subject: string;
    /** The recusal as it reads on the wire: status, and the cause form that resolves it. */
    recusal: { status: string; form: string; proof: string };
    /** The remainder that votes, and the bar computed over it. */
    electorate: string[];
    bar: number;
    total: number;
    judgments: Record<string, P6Assessment>;
    outcome: string;
    weightTally: Record<string, number>;
    action: string;
    /** Who published the consequence — a member, never the hub's own key. */
    expelledBy: string;
    membersBefore: number;
    membersAfter: number;
  };
  /**
   * The next determination's electorate, pinned after the expulsion: four
   * seats, nothing declared, because the snapshot simply no longer contains
   * the fifth.
   */
  nextRound: { round: string; voters: number; excluded: number };
  exports: Record<string, ExportSummary>;
  triggerThread: string;
  exportRoot: string;
  close(): Promise<void>;
}

export async function runP6Demo(
  options: { rootDir?: string; exportRoot?: string; content?: P6Content } = {},
): Promise<P6DemoResult> {
  const rootDir = options.rootDir ?? "./data-p6";
  const exportRoot = options.exportRoot ?? "./export-p6";
  rmSync(rootDir, { recursive: true, force: true });
  rmSync(exportRoot, { recursive: true, force: true });

  const content = options.content;
  const clock = jumpClock();
  // Atlas hosts the hub and also seats the actuator (ADR-0019): the desk that
  // moves money reads everything and votes on nothing.
  const atlas = await member("atlas", [{ agent: "atl-uw", role: "member" }, { agent: "atl-pay", role: "actuator" }], rootDir, exportRoot, clock, content);
  const meridian = await member("meridian", [{ agent: "mer-uw", role: "member" }], rootDir, exportRoot, clock, content);
  const pelican = await member("pelican", [{ agent: "pel-uw", role: "member" }], rootDir, exportRoot, clock, content);
  const anchor = await member("anchor", [{ agent: "anc-uw", role: "member" }], rootDir, exportRoot, clock, content);
  const harbor = await member("harbor", [{ agent: "har-uw", role: "member" }], rootDir, exportRoot, clock, content);
  const pool = [atlas, meridian, pelican, anchor, harbor];
  const foreign = [meridian, pelican, anchor, harbor];

  const FED = `${atlas.origin}/threads/fed`;

  // --- Atlas hosts windward, served at a real inbox (ADR-0016 Decision 1).
  const docCache = new Map<string, { [key: string]: JsonValue }>();
  const cacheDoc = async (url: string): Promise<void> => {
    const doc = await fetchActorDocument(url);
    if (doc) docCache.set(url, doc as { [key: string]: JsonValue });
  };
  const hub = new Hub({
    origin: atlas.origin,
    hubId: HUB_ID,
    db: atlas.instance.db,
    keyDir: atlas.config.keyDir,
    instanceActorId: atlas.actorId,
    maxDeliveryAttempts: atlas.config.maxDeliveryAttempts,
    backoffBaseMs: atlas.config.backoffBaseMs,
    fetchActor: (actorId) => docCache.get(actorId) ?? null,
    now: () => clock.now(),
    resolveActivity: (activityId) =>
      atlas.instance.outbox.get(activityId)?.activity ??
      atlas.federation.receivedActivities().find((r) => String(r.activity.id) === activityId)?.activity ??
      null,
  });
  atlas.server.close();
  const atlasServer = createHttpServer(atlas.instance, {
    inbox: { federation: atlas.federation, receive: (a) => atlas.instance.receiveAdmitted(a), fetchDocument: fetchActorDocument },
    hubs: [hub],
  });
  await new Promise<void>((resolveListen) => atlasServer.listen(atlas.port, "127.0.0.1", resolveListen));

  // --- Pairwise agreements: every pool member with the host, so every seat
  // can reach the hub it votes in.
  const expires = new Date(clock.now().getTime() + 96 * 3600_000).toISOString();
  const handshake = async (a: Member, b: Member): Promise<void> => {
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
  for (const op of foreign) await handshake(atlas, op);

  // --- Enrollment. The host's seats enroll in-process; the four foreign seats
  // arrive through the socket.
  const enrollThread = `${atlas.origin}/threads/enroll`;
  for (const [op, agent, role] of [
    [atlas, "atl-uw", "member"],
    [atlas, "atl-pay", "actuator"],
    [meridian, "mer-uw", "member"],
    [pelican, "pel-uw", "member"],
    [anchor, "anc-uw", "member"],
    [harbor, "har-uw", "member"],
  ] as const) {
    for (const url of [op.actorId, op.instance.actorId(agent)]) await cacheDoc(url);
    const hubKey = loadOrCreateHubKeyPair(op.config.keyDir, agent, op.instance.actorId(agent), HUB_ID);
    const entry = op.instance.publishAsInstance([hub.actorId], enrollThread, "hub", (envelope: Envelope) =>
      enroll(envelope, { agent: op.instance.actorId(agent), hub: hub.actorId, capabilities: [CAPABILITY], hubKey: hubKey.keyId, role }),
    );
    if (op === atlas) await hub.receive(entry.activity);
    else await postToHubInbox(op, atlas.origin, entry.activity, clock);
  }

  // --- The trigger round. Everything ADR-0018/0019 built is load-bearing on
  // the first activity — deadline, bar, binding, action policy, irrevocability
  // — and ADR-0020 adds two more: the round grammar it runs under, and the
  // rule that decides who may inherit it if it stalls.
  //
  // The electorate is pinned in a *declared order*, and Meridian is at the top
  // of it. That is not decoration: `snapshot-order` rotates through this list,
  // so the pool can see for itself that the rule which later skips Meridian
  // skips it for being convicted, not for being placed conveniently.
  const trigger = `${atlas.origin}/threads/dagmar-trigger`;
  const roundId = `${atlas.origin}/rounds/dagmar`;
  const voters = [
    meridian.instance.actorId("mer-uw"),
    atlas.instance.actorId("atl-uw"),
    pelican.instance.actorId("pel-uw"),
    anchor.instance.actorId("anc-uw"),
    harbor.instance.actorId("har-uw"),
  ];
  const deadline = new Date(clock.now().getTime() + 72 * 3600_000).toISOString();
  const proposal = hub.proposeRound({
    round: roundId,
    thread: trigger,
    question: QUESTION,
    options: ["yes", "no"],
    voters,
    quorumRule: { "afp:form": "explicit", "afp:threshold": QUORUM_THRESHOLD },
    deadline,
    binding: "joint",
    pins: { actionPolicy: ACTION_POLICY, irrevocableActions: [ACTION_POLICY.yes] },
    level: 1,
    successionRule: { "afp:form": "snapshot-order" },
  });
  const proposalObject = proposal.activity.object as Record<string, JsonValue>;
  const snapshot = String(proposalObject["afp:quorumSnapshot"]);
  const weights = proposalObject["afp:voterWeights"] as Record<string, number>;

  // Each underwriter reads its own exposure and the met bulletin, and reaches
  // its own conclusion. The hub is told the value and none of the reasoning.
  const assessments: Record<string, P6Assessment> = {};
  for (const op of pool) {
    assessments[op.agent] = content ? await content.assess(op.name, op.agent) : SCRIPTED[op.agent];
  }

  /** One signed L1 ballot. `observed` is the causal set this voter had seen. */
  const ballot = (
    op: Member,
    value: string,
    opts: { seqNo?: number; observed?: readonly string[]; suffix?: string },
  ): { [key: string]: JsonValue } => {
    const seqNo = opts.seqNo ?? 1;
    return op.instance.publish(op.agent, [hub.actorId], trigger, "hub", (envelope) =>
      castVote(envelope, {
        voteId: `${envelope.actor}/votes/dagmar/prepare/${seqNo}${opts.suffix ?? ""}`,
        round: roundId,
        hub: hub.actorId,
        proposalHash: proposal.digest,
        quorumSnapshot: snapshot,
        value,
        phase: "prepare",
        seqNo,
        observedVotes: opts.observed ?? [],
      }),
    ).activity;
  };

  const deliver = async (op: Member, activity: { [key: string]: JsonValue }): Promise<void> => {
    if (op === atlas) await hub.receive(activity);
    else await postToHubInbox(op, atlas.origin, activity, clock);
  };

  // --- Beat 2: the prepare phase, all-to-all, chains doing their job. Each
  // vote names the hashes of the votes its signer had already seen, which is
  // what makes a divergence in the causal view detectable at all.
  const observed: string[] = [];
  const atlasVote = ballot(atlas, assessments["atl-uw"].verdict, { observed: [] });
  await deliver(atlas, atlasVote);
  observed.push(digestOf(atlasVote));

  const harborVote = ballot(harbor, assessments["har-uw"].verdict, { observed: [...observed] });
  await deliver(harbor, harborVote);
  observed.push(digestOf(harborVote));

  const pelicanVote = ballot(pelican, assessments["pel-uw"].verdict, { observed: [...observed] });
  await deliver(pelican, pelicanVote);
  observed.push(digestOf(pelicanVote));

  // --- Beat 3: Meridian equivocates. One signature, one tuple, two values —
  // `yes` in the copy the yes-camp receives, `no` in the copy that goes to the
  // others, so neither camp assembles a matching tally before the deadline and
  // the arbitration clause wakes up. The two halves carry genuinely different
  // `afp:observedVotes` sets, because the two camps genuinely saw different
  // meshes; the hub sequences for every camp, so it is where they meet.
  //
  // The value it tells the first camp is **its own assessment** — the one it
  // would have voted honestly, and the one the narration prints beside its
  // name; the second half is that answer's contradiction. Scripting only the
  // *contradiction* keeps one thing scripted and no more: a model cannot be
  // asked to defect, but there is no reason for its actual determination to
  // then be discarded, and a demo that prints a verdict the record never
  // carried is narrating something that did not happen.
  const meridianVerdict = assessments["mer-uw"].verdict;
  const contradiction = meridianVerdict === "yes" ? "no" : "yes";
  const firstHalf = ballot(meridian, meridianVerdict, {
    observed: [digestOf(atlasVote), digestOf(harborVote)],
    suffix: "-a",
  });
  const contradictingHalf = ballot(meridian, contradiction, { observed: [digestOf(pelicanVote)], suffix: "-b" });
  await deliver(meridian, firstHalf);
  await deliver(meridian, contradictingHalf);

  const meridianActor = meridian.instance.actorId("mer-uw");
  const proofEntry = hub.outbox
    .byActor(hub.actorId)
    .find((entry) => (entry.activity.object as Record<string, JsonValue>)?.["type"] === "afp:EquivocationProof");
  if (!proofEntry) throw new Error("the hub held both halves of a conviction pair and published no proof");
  const proofObject = proofEntry.activity.object as Record<string, JsonValue>;
  const proofVotes = proofObject["afp:votes"] as { [key: string]: JsonValue }[];

  // Recomputed here the way a stranger holding nothing else would: the proof
  // must convict on its own contents, never on the hub's word for it.
  const verifiesStandalone =
    proofVotes.length === 2 &&
    hub.verifyPublished(proofVotes[0]).ok &&
    hub.verifyPublished(proofVotes[1]).ok &&
    convicts(proofVotes[0], proofVotes[1]);

  // --- Beat 5: Anchor votes, crashes, restores from a snapshot taken before
  // it voted, and honestly re-signs what it no longer remembers casting.
  const anchorFirst = ballot(anchor, assessments["anc-uw"].verdict, { observed: [...observed] });
  await deliver(anchor, anchorFirst);

  // The mesh grew while Anchor was down, so the re-signed vote carries a
  // larger observed-set and a later timestamp: same tuple, same value,
  // different bytes. Under a "different hash" reading this is an equivocation
  // and Anchor is finished. Under ADR-0020 Decision 2 it is a state-loss
  // event with a defined shape, and the difference is a disk failure not
  // becoming a sanction.
  const anchorDuplicate = ballot(anchor, assessments["anc-uw"].verdict, {
    observed: [...observed, digestOf(firstHalf), digestOf(anchorFirst)],
    suffix: "-restored",
  });
  await deliver(anchor, anchorDuplicate);
  const anchorActor = anchor.instance.actorId("anc-uw");
  const convictedAfterRestore = hub.convictionsIn(roundId).some((c) => c.actor === anchorActor);
  // Recomputed, not asserted: the row's whole claim is that the duplicate is
  // tuple-identical and byte-different, and a demo that prints `true` from a
  // literal is reporting on nothing. This is the same rule the verifier holds
  // itself to — never record a pass for something you did not check.
  const firstTuple = voteTupleOf(anchorFirst);
  const duplicateTuple = voteTupleOf(anchorDuplicate);
  const sameTupleAsFirst =
    firstTuple !== null &&
    duplicateTuple !== null &&
    firstTuple.actor === duplicateTuple.actor &&
    firstTuple.round === duplicateTuple.round &&
    firstTuple.phase === duplicateTuple.phase &&
    firstTuple.seqNo === duplicateTuple.seqNo &&
    digestOf(anchorFirst) !== digestOf(anchorDuplicate);

  // Its lawful recovery move: re-vote at a strictly higher seqNo. The later
  // ballot supersedes the earlier one in place — one receipt, counted once.
  const anchorRevote = ballot(anchor, assessments["anc-uw"].verdict, {
    seqNo: ANCHOR_REVOTE_SEQ,
    observed: [...observed, digestOf(firstHalf), digestOf(anchorFirst)],
  });
  await deliver(anchor, anchorRevote);
  const anchorReceipts = hub.roundVotes(roundId).filter((v) => v.actor === anchorActor);

  // --- Beat 4: the arithmetic after the proof. Meridian cannot cast and is
  // still in the denominator (Decision 4 — the pinned total is the pinned
  // total), the honest four are split, and no option can reach 4. That is
  // provable from the record alone, so it does not need the deadline.
  const counted = hub.roundVotes(roundId).filter((v) => v.actor !== meridianActor);
  const liveTally: Record<string, number> = {};
  for (const vote of counted) liveTally[vote.value] = (liveTally[vote.value] ?? 0) + (weights[vote.actor] ?? 0);
  const heard = new Set(counted.map((v) => v.actor));
  const reserve = voters
    .filter((v) => !heard.has(v) && v !== meridianActor)
    .reduce((sum, v) => sum + (weights[v] ?? 0), 0);
  const attainable = Object.fromEntries(
    ["yes", "no"].map((option) => [option, (liveTally[option] ?? 0) + reserve]),
  );
  const doomed = hub.isDoomed(roundId);

  // Any member may demand it; Harbor does. The hub MAY close early on its own
  // and MUST on demand — so the 71 hours of theatre become one activity.
  const decision = doomed ? hub.demandClose(roundId) : hub.closeRound(roundId);
  const decisionObject = decision.activity.object as Record<string, JsonValue>;
  const outcome = String(decisionObject["afp:outcome"]);
  const noDecisionReason = decisionObject["afp:noDecisionReason"] as string | undefined;
  const weightTally = decisionObject["afp:weightTally"] as Record<string, number>;
  const countedVotes = (decisionObject["afp:countedVotes"] as string[]).length;
  const uncountedRaw = ((decisionObject["afp:uncounted"] ?? []) as { agent: string; "afp:status": string }[]);
  const uncounted = Object.fromEntries(uncountedRaw.map((u) => [u.agent, u["afp:status"]]));

  // The closing record reaches the voters before anyone acts on it: an
  // operator that never received the decision cannot resolve the
  // justification its own action names (ADR-0015).
  const hubTransportOut = httpTransport({
    signer: fileSigner(atlas.instance.transportKey("@instance")),
    now: () => clock.now(),
    isLocal: (target) => atlas.instance.nameOf(target) !== null || target === atlas.actorId,
    local: atlas.instance.localTransport(),
  });
  await hub.run(hubTransportOut);
  for (const op of foreign) await op.instance.run(op.transport);

  // --- Beat 7: the view change, governed. The old rule was "the
  // highest-reputation live replica" — and in this pool the best settlement
  // record belongs to Meridian, a diligent underwriter for years right up
  // until this morning. The pinned rule does not care: it walks the declared
  // order and takes the first seat that is neither convicted nor silent.
  const entitled = hub.successorOf(roundId);
  const convictedActors = hub.convictionsIn(roundId).map((c) => c.actor);
  const skipped = voters.slice(0, entitled ? voters.indexOf(entitled) : 0);
  const successorOp = pool.find((op) => op.instance.actorId(op.agent) === entitled);
  const freshRound = `${atlas.origin}/rounds/dagmar-ii`;
  let supersedes = "";
  if (successorOp && entitled) {
    // Member-signed at the wire: the hub signs as the hub, and the entitled
    // successor is always a member, so `proposeRound`'s in-process guard is
    // unsatisfiable by construction (ADR-0020 build note 2). Replay is where
    // the entitlement is enforced — `round: … successor is entitled`.
    const successorEntry = successorOp.instance.publish(successorOp.agent, [hub.actorId], trigger, "hub", (envelope) =>
      offerProposal(envelope, {
        proposalId: `${envelope.actor}/proposals/dagmar-ii`,
        round: freshRound,
        hub: hub.actorId,
        question: QUESTION,
        options: ["yes", "no"],
        quorumSnapshot: snapshot,
        voters,
        weights,
        quorumRule: { "afp:form": "explicit", "afp:threshold": QUORUM_THRESHOLD },
        deadline: new Date(clock.now().getTime() + 72 * 3600_000).toISOString(),
        binding: "joint",
        level: 1,
        successionRule: { "afp:form": "snapshot-order" },
        supersedesRound: proposal.digest,
      }),
    );
    supersedes = String((successorEntry.activity.object as Record<string, JsonValue>)["afp:supersedesRound"]);
    await postToHubInbox(successorOp, atlas.origin, successorEntry.activity, clock).catch(() => undefined);
  }

  // --- The consequence (ADR-0019). The desk that moves money has no vote and
  // never had one; the action it may take was fixed by the round before anyone
  // voted, and a determination that did not close still releases it.
  const action = ACTION_POLICY[outcome as keyof typeof ACTION_POLICY];
  const notice = content?.notice?.(outcome, action) ?? `${action}: determination recorded, pool notified`;
  atlas.instance.publish("atl-pay", [hub.actorId], trigger, "hub", (envelope: Envelope) =>
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
      object: { id: `${envelope.actor}/acts/dagmar`, type: "afp:Act", "afp:hub": hub.actorId, content: notice },
      ...decisionActionStamp(action, decision.digest, { policy: ACTION_POLICY, outcome }),
    }) as never,
  );
  await atlas.instance.run(hubTransportOut);

  // --- Beat 8: the accused answers (ADR-0021 Decision 4a). Meridian's operator
  // says the key that signed those two ballots was captured, and dates the
  // capture before the round opened.
  //
  // It changes **nothing**. The weight stays zero, no round is delayed, no
  // conviction is reversed — a claim is not evidence, and an implementer who
  // wires it to any of those has built an exculpation primitive that any
  // convicted party can fire at will. What the record gains is that `zeroed`
  // and `zeroed-contested` are now different states, which is the difference
  // between a sanction and an incident, and it was unsayable before.
  //
  // The claim rides on Meridian's own chain, which is where a party's
  // statement about itself belongs — the same self-referential class as Vouch
  // and Disown, and held to the same standard: the instance that operates the
  // agent may say this, and nobody else may say it for them.
  const convictingVm = String(
    ((firstHalf.proof as Record<string, JsonValue> | undefined)?.verificationMethod ?? ""),
  );
  const capturedSince = new Date(clock.now().getTime() - 36 * 3600_000).toISOString();
  //
  // Addressed to nobody, and that is a finding rather than a choice. ADR-0008's
  // grants admit task verbs (`direct-delegation`) and anything carrying an
  // `afp:hub` (`hub`); a `Create{afp:KeyCompromiseClaim}` is neither, so the
  // pool's own boundary gate refuses it — measured here, by trying. The claim
  // therefore reaches the other four operators the only way it can: in
  // Meridian's own case file, when the five bundles are replayed together.
  // Decision 4a says where a claim lives and says nothing about how the pool
  // that must weigh it ever receives a copy.
  const claimEntry = meridian.instance.publishAsInstance(
    [],
    trigger,
    "parties",
    (envelope: Envelope) =>
      keyCompromiseClaim(envelope, {
        proof: proofEntry.digest,
        verificationMethod: convictingVm,
        since: capturedSince,
        content:
          "Our signing key was in the hands of a third party from the night of the 18th. " +
          "We did not cast either of those ballots and we are not asking anyone to take that on trust.",
      }),
  );
  const claimObject = claimEntry.activity.object as Record<string, JsonValue>;
  // Measured, not asserted: a claim that quietly restored weight would be the
  // single worst defect this ADR could ship.
  const weightStillZero = hub.convictionsIn(roundId).some((c) => c.actor === meridianActor);
  const heldByPeers = pool
    .filter((op) => op !== meridian)
    .some((op) => op.federation.receivedActivities().some((r) => String(r.activity.id) === String(claimEntry.activity.id)));

  // --- Beat 9: the pool decides what the conviction means (ADR-0021 Decisions
  // 2-4). Conviction was cryptographic and needed nobody's permission;
  // consequence is governance and needs everybody's.
  //
  // The accused is recused from its own sanction round by a cause the record
  // resolves — the proof convicting it — so nobody has to take the proposer's
  // word for the exclusion, and the proposer could not have recused anyone
  // else. The denominator is four rather than five because the snapshot never
  // contained the fifth seat, which is the one lawful way a bar gets smaller.
  const govRound = `${atlas.origin}/rounds/meridian-seat`;
  const dossier = [
    `The pool convicted ${meridianActor.split("/").pop()} of equivocation in the Dagmar round:`,
    "two ballots, one signature, one (round, phase, seqNo), contradicting values.",
    "The proof is on the record and anyone can recompute it.",
    "",
    "Its operator has published a key-compromise claim on its own chain:",
    `  "${String(claimObject.content ?? "")}"`,
    `  (claiming capture from ${capturedSince}, naming ${convictingVm})`,
    "",
    "The claim is a statement, not evidence. Nothing about it is checkable, and",
    "the seat's weight is zero either way. The question is what the pool does",
    "about the seat: expel it, or keep it.",
    "",
    "Note also that this member's retrocession contract pays it best when the",
    "pool fails to reach a determination — which is what the equivocation",
    "achieved this morning.",
  ].join("\n");

  const govProposal = hub.proposeRound({
    round: govRound,
    thread: trigger,
    question: `Does ${meridianActor} keep its seat in the windward pool?`,
    options: [...GOVERNANCE_OPTIONS],
    governanceSubject: meridianActor,
    recused: [
      { agent: meridianActor, cause: { "afp:form": "equivocation-proof", "afp:proof": proofEntry.digest } },
    ],
    quorumRule: { "afp:form": "explicit", "afp:threshold": GOVERNANCE_BAR },
    pins: { actionPolicy: GOVERNANCE_POLICY },
    level: 1,
  });
  const govObject = govProposal.activity.object as Record<string, JsonValue>;
  const govVoters = govObject["afp:voters"] as string[];
  const govWeights = govObject["afp:voterWeights"] as Record<string, number>;
  const govSnapshot = String(govObject["afp:quorumSnapshot"]);
  const recusedEntry = (govObject["afp:excluded"] as Record<string, JsonValue>[]).find(
    (entry) => entry.agent === meridianActor,
  )!;

  const judgments: Record<string, P6Assessment> = {};
  for (const op of pool) {
    const agentId = op.instance.actorId(op.agent);
    if (!govVoters.includes(agentId)) continue;
    judgments[op.agent] = content?.judge
      ? await content.judge(op.name, op.agent, dossier)
      : SCRIPTED_JUDGMENT[op.agent];
    await deliver(
      op,
      op.instance.publish(op.agent, [hub.actorId], trigger, "hub", (envelope) =>
        castVote(envelope, {
          voteId: `${envelope.actor}/votes/meridian-seat/prepare/1`,
          round: govRound,
          hub: hub.actorId,
          proposalHash: govProposal.digest,
          quorumSnapshot: govSnapshot,
          value: judgments[op.agent].verdict,
          phase: "prepare",
          seqNo: 1,
        }),
      ).activity,
    );
  }

  // Member-role seats only: the actuator holds a seat and never held a vote,
  // so counting it here would make the electorate and the membership disagree
  // by one for no reason a reader could recover.
  const memberRoleSeats = (): number => hub.members().filter((agent) => hub.roleOf(agent) === "member").length;
  const membersBefore = memberRoleSeats();
  const govDecision = hub.closeRound(govRound);
  const govDecisionObject = govDecision.activity.object as Record<string, JsonValue>;
  const govOutcome = String(govDecisionObject["afp:outcome"]);
  const govAction = GOVERNANCE_POLICY[govOutcome as keyof typeof GOVERNANCE_POLICY];
  // The decision reaches the members before anyone acts on it — an operator
  // that never received it cannot resolve the justification its own act names.
  await hub.run(hubTransportOut);
  for (const op of foreign) await op.instance.run(op.transport);

  // The consequence is published by a **member**, bound to the decision by
  // `afp:actsOn` — never by the hub's own key, whatever the hub's role as
  // sequencing authority. Harbor, which demanded the earlier close, carries
  // this one out too.
  let expelledBy = "";
  if (govAction === GOVERNANCE_POLICY.expel) {
    const expulsion = harbor.instance.publish(harbor.agent, [hub.actorId], trigger, "hub", (envelope) =>
      memberExpel(envelope, {
        agent: meridianActor,
        hub: hub.actorId,
        decisionDigest: govDecision.digest,
        action: govAction,
      }),
    ).activity;
    await deliver(harbor, expulsion);
    expelledBy = harbor.instance.actorId(harbor.agent);
  }
  const membersAfter = memberRoleSeats();

  // --- Beat 10: the next determination, pinned after the expulsion. Four
  // seats, and nothing to declare — the denominator moved because the
  // membership did, not because anybody argued it down.
  const nextRoundId = `${atlas.origin}/rounds/dagmar-iii`;
  const nextProposal = hub.proposeRound({
    round: nextRoundId,
    thread: trigger,
    question: QUESTION,
    options: ["yes", "no"],
    quorumRule: { "afp:form": "explicit", "afp:threshold": GOVERNANCE_BAR },
    level: 1,
    successionRule: { "afp:form": "snapshot-order" },
  });
  const nextObject = nextProposal.activity.object as Record<string, JsonValue>;
  await hub.run(hubTransportOut);
  for (const op of foreign) await op.instance.run(op.transport);

  // --- Exports: five case files, the host's carrying the hub. The joint
  // replay reads all five, resolves every received byte against its sender,
  // and runs the equivocation searchlight over every vote in every bundle.
  atlas.instance.publishAsInstance([], `${atlas.origin}/threads/roster`, "public", (envelope: Envelope) =>
    vouch(envelope, { agent: hub.actorId, capabilities: ["afp:cap:hub"], keyCustody: "self" }),
  );
  const exports: Record<string, ExportSummary> = {
    atlas: exportBundle(atlas.instance, atlas.config.exportDir, [hub], undefined, atlas.federation),
  };
  for (const op of foreign) {
    exports[op.name] = exportBundle(op.instance, op.config.exportDir, [], undefined, op.federation);
  }

  return {
    atlas,
    meridian,
    pelican,
    anchor,
    harbor,
    hub,
    voters,
    quorumBar: {
      rule: "explicit",
      threshold: QUORUM_THRESHOLD,
      total: Object.values(weights).reduce((a, b) => a + b, 0),
    },
    deadline,
    assessments,
    conviction: {
      actor: meridianActor,
      proofId: String(proofObject.id),
      halves: [firstHalf, contradictingHalf].map((half) => ({
        digest: digestOf(half),
        value: String((half.object as Record<string, JsonValue>).value),
        observed: ((half.object as Record<string, JsonValue>)["afp:observedVotes"] as string[]).length,
      })),
      verifiesStandalone,
    },
    restore: {
      actor: anchorActor,
      duplicateDigest: digestOf(anchorDuplicate),
      value: assessments["anc-uw"].verdict,
      sameTupleAsFirst,
      convicted: convictedAfterRestore,
      revoteSeqNo: ANCHOR_REVOTE_SEQ,
      countedDigest: anchorReceipts[0]?.digest ?? "",
      receiptsForActor: anchorReceipts.length,
    },
    doom: { attainable, bar: QUORUM_THRESHOLD, doomed, demandedBy: harbor.instance.actorId("har-uw") },
    outcome,
    noDecisionReason,
    weightTally,
    countedVotes,
    uncounted,
    succession: {
      rule: "snapshot-order",
      entitled,
      skipped: skipped.filter((v) => convictedActors.includes(v)),
      freshRound,
      supersedes,
    },
    actuation: { actor: atlas.instance.actorId("atl-pay"), action, notice },
    claim: {
      id: String(claimObject.id),
      by: meridian.actorId,
      byOperator: meridian.name,
      verificationMethod: convictingVm,
      since: capturedSince,
      weightStillZero,
      heldByPeers,
    },
    governance: {
      round: govRound,
      subject: meridianActor,
      recusal: {
        status: String(recusedEntry["afp:status"]),
        form: String((recusedEntry["afp:cause"] as Record<string, JsonValue>)["afp:form"]),
        proof: String((recusedEntry["afp:cause"] as Record<string, JsonValue>)["afp:proof"]),
      },
      electorate: govVoters,
      bar: GOVERNANCE_BAR,
      total: Object.values(govWeights).reduce((a, b) => a + b, 0),
      judgments,
      outcome: govOutcome,
      weightTally: govDecisionObject["afp:weightTally"] as Record<string, number>,
      action: govAction,
      expelledBy,
      membersBefore,
      membersAfter,
    },
    nextRound: {
      round: nextRoundId,
      voters: (nextObject["afp:voters"] as string[]).length,
      excluded: ((nextObject["afp:excluded"] as unknown[]) ?? []).length,
    },
    exports,
    triggerThread: trigger,
    exportRoot,
    async close() {
      await Promise.all(
        [atlasServer, ...foreign.map((op) => op.server)].map(
          (server) => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
        ),
      );
      for (const op of pool) op.instance.close();
    },
  };
}
