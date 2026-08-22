/**
 * Activity builders for the P3 allocation flow (ADR-0003):
 * `Announce{afp:Task}` → `afp:BidCommit` → `afp:BidReveal` → `afp:Award`
 * (→ `afp:Reauction`) → `Create{afp:Synthesis}` → `afp:Settlement`.
 *
 * Mirrors `ap/activities.ts` and `hub/activities.ts`: `visibility` is a
 * required envelope field, chaining lives in the envelope, and this file only
 * shapes activity bodies.
 *
 * The commitment (Decision 2) is `sha256(JCS(bid payload))` over the payload
 * built by `bidPayload()` — which includes a mandatory `nonce`, or a
 * low-entropy bid is recoverable from its commitment by enumeration.
 */

import type { JsonValue } from "../crypto/jcs.ts";
import { digestOf } from "../crypto/proof.ts";
import { AFP_CONTEXTS } from "../ap/documents.ts";
import type { Envelope } from "../ap/activities.ts";
import type { SelectionRule } from "./rules.ts";

export type { Envelope, Visibility } from "../ap/activities.ts";

function base(envelope: Envelope, type: string): { [key: string]: JsonValue } {
  const activity: { [key: string]: JsonValue } = {
    "@context": AFP_CONTEXTS,
    id: envelope.activityId,
    type,
    actor: envelope.actor,
    to: [...envelope.to],
    published: envelope.published,
    context: envelope.thread,
    "afp:visibility": envelope.visibility,
  };
  if (envelope.prevActivity !== null) activity["afp:prevActivity"] = envelope.prevActivity;
  return activity;
}

// -------------------------------------------------------------------- Announce

export interface AnnounceSpec {
  taskId: string;
  hub: string;
  capability: string;
  content: string;
  correlationId: string;
  bidWindow: { opens: string; closes: string };
  /** Published up front, never decided after the fact (03 § Bidding step 1). */
  selectionRule: SelectionRule;
  /** Answer sufficiency is not voting quorum (03) — stated in the announce. */
  answerSufficiency: { [key: string]: JsonValue };
  /** Estimator/bidder separation, recorded so a verifier can check it was applied (Decision 6). */
  estimatorPolicy: "exclude" | "permit-and-record";
  estimators: readonly string[];
  deadline?: string;
  /**
   * ADR-0004 Decision 3: opt-in reputation consumption. When a rule is pinned
   * the announce MUST also carry the settlement snapshot — the digests of
   * every afp:Settlement of this hub published before the announce.
   */
  reputationRule?: { name: string; params: { [key: string]: JsonValue } };
  settlementSnapshot?: readonly string[];
  /**
   * ADR-0006 Decision 1: what may be *done* about the answer — a closed map
   * `category → admissible action`, pinned before the answer exists. Opt-in;
   * an announce that pins none constrains no actions.
   */
  actionPolicy?: Readonly<Record<string, string>>;
  /**
   * ADR-0006 Decision 2: the estimator wall generalized — performers of these
   * prior tasks' Awards are excluded from this auction at admission.
   */
  excludePerformersOf?: readonly string[];
  /**
   * ADR-0010 Decision 2: names the one actor whose `Create{afp:Synthesis}` is
   * admissible for this thread. Where the coverage rule also derives one (via
   * the Award), the Award's value governs on disagreement — this pin is what
   * a ranking rule, which derives none, has to name instead.
   */
  synthesizer?: string;
  /**
   * ADR-0011 Decision 4: names the closed thread this announce continues, when
   * this task opens a new ask on new information rather than revising the
   * existing answer. NOT part of the pin set — see `ap/activities.ts` `TaskSpec`.
   */
  priorThread?: string;
}

/** `Announce{afp:Task}` — broadcast through the hub to enrolled members. */
export function announceTask(envelope: Envelope, spec: AnnounceSpec): { [key: string]: JsonValue } {
  const object: { [key: string]: JsonValue } = {
    id: spec.taskId,
    type: "afp:Task",
    "afp:hub": spec.hub,
    "afp:capability": spec.capability,
    "afp:correlationId": spec.correlationId,
    content: spec.content,
    "afp:bidWindow": { ...spec.bidWindow },
    "afp:selectionRule": { name: spec.selectionRule.name, params: { ...spec.selectionRule.params } },
    "afp:answerSufficiency": { ...spec.answerSufficiency },
    "afp:estimatorPolicy": spec.estimatorPolicy,
    "afp:estimators": [...spec.estimators],
  };
  if (spec.deadline) object["afp:deadline"] = spec.deadline;
  if (spec.reputationRule) {
    object["afp:reputationRule"] = { name: spec.reputationRule.name, params: { ...spec.reputationRule.params } };
    object["afp:settlementSnapshot"] = [...(spec.settlementSnapshot ?? [])];
  }
  if (spec.actionPolicy) object["afp:actionPolicy"] = { ...spec.actionPolicy };
  if (spec.excludePerformersOf?.length) object["afp:excludePerformersOf"] = [...spec.excludePerformersOf];
  if (spec.synthesizer) object["afp:synthesizer"] = spec.synthesizer;
  if (spec.priorThread) object["afp:priorThread"] = spec.priorThread;
  return { ...base(envelope, "Announce"), object };
}

// ---------------------------------------------------------------- Commit/Reveal

/** The committed bid payload — everything here is under the commitment hash. */
export interface BidFields {
  task: string;
  bidder: string;
  capabilityMatch: number;
  estimatedCost: { unit: string; value: number };
  estimatedLatency: string;
  coverage?: Readonly<Record<string, number>>;
  /**
   * ADR-0004 Decision 2: "my cost is low *because* I start from this" — an
   * asset reference (id + version) as a claim under the sealed commitment.
   */
  reuses?: { asset: string; version: string };
  /** Mandatory (Decision 2): without it a low-entropy bid is enumerable. */
  nonce: string;
}

/** The canonical committed payload. Deliberately free of ids, times, and proofs. */
export function bidPayload(fields: BidFields): { [key: string]: JsonValue } {
  const payload: { [key: string]: JsonValue } = {
    type: "afp:Bid",
    "afp:task": fields.task,
    "afp:bidder": fields.bidder,
    "afp:capabilityMatch": fields.capabilityMatch,
    "afp:estimatedCost": { ...fields.estimatedCost },
    "afp:estimatedLatency": fields.estimatedLatency,
    nonce: fields.nonce,
  };
  if (fields.coverage) payload["afp:coverage"] = { ...fields.coverage };
  if (fields.reuses) payload["afp:reuses"] = { asset: fields.reuses.asset, version: fields.reuses.version };
  return payload;
}

/** `afp:commitment = sha256(JCS(bid payload))` — the digest P1 already ships. */
export function commitmentOf(payload: { [key: string]: JsonValue }): string {
  return digestOf(payload);
}

/** `afp:BidCommit` — the sealed phase: only the commitment travels. */
export function bidCommit(
  envelope: Envelope,
  spec: { task: string; hub: string; commitment: string },
): { [key: string]: JsonValue } {
  return {
    ...base(envelope, "afp:BidCommit"),
    object: spec.task,
    "afp:hub": spec.hub,
    "afp:commitment": spec.commitment,
  };
}

/** `afp:BidReveal` — the full bid payload, verified by recomputing the digest. */
export function bidReveal(
  envelope: Envelope,
  spec: { hub: string; payload: { [key: string]: JsonValue } },
): { [key: string]: JsonValue } {
  return {
    ...base(envelope, "afp:BidReveal"),
    object: { ...spec.payload },
    "afp:hub": spec.hub,
  };
}

// ----------------------------------------------------------------------- Award

export interface AwardSpec {
  awardId: string;
  task: string;
  hub: string;
  correlationId: string;
  selectionRule: SelectionRule;
  /** Digests of the winning revealed bid payloads — the recomputable evidence. */
  winningBids: readonly string[];
  performers: readonly string[];
  synthesizer: string | null;
  /** No `Accept` by this instant → recorded `afp:Reauction` (Decision 4). */
  acceptBy: string;
  /**
   * Reauction fast path only: the prior `afp:Award` this one supersedes and
   * the bidders excluded for failing it. Recorded so a verifier can rebuild
   * the exact bid pool the rule ran over — every excluded bidder must be a
   * performer of the named prior award, which is checkable from the record.
   */
  priorAward?: string;
  excludedBidders?: readonly string[];
}

/** `afp:Award` — the recomputable selection outcome. */
export function award(envelope: Envelope, spec: AwardSpec): { [key: string]: JsonValue } {
  const object: { [key: string]: JsonValue } = {
    id: spec.awardId,
    type: "afp:Award",
    "afp:task": spec.task,
    "afp:hub": spec.hub,
    "afp:correlationId": spec.correlationId,
    "afp:selectionRule": { name: spec.selectionRule.name, params: { ...spec.selectionRule.params } },
    "afp:winningBids": [...spec.winningBids],
    "afp:performers": [...spec.performers],
    "afp:acceptBy": spec.acceptBy,
  };
  if (spec.synthesizer) object["afp:synthesizer"] = spec.synthesizer;
  if (spec.priorAward) object["afp:priorAward"] = spec.priorAward;
  if (spec.excludedBidders?.length) object["afp:excludedBidders"] = [...spec.excludedBidders];
  return { ...base(envelope, "afp:Award"), object };
}

/** `afp:Reauction` — award timeout or failure, fast path preferred (03). */
export function reauction(
  envelope: Envelope,
  spec: { task: string; hub: string; priorAward: string; reason: string; path: "next-ranked" | "re-announce" },
): { [key: string]: JsonValue } {
  return {
    ...base(envelope, "afp:Reauction"),
    object: spec.task,
    "afp:hub": spec.hub,
    "afp:priorAward": spec.priorAward,
    "afp:reauctionPath": spec.path,
    summary: spec.reason,
  };
}

// ---------------------------------------------------- Synthesis and Settlement

/** ADR-0010 Decision 4: one leg of the thread that contributed no Result. */
export interface AbsentInput {
  correlationId: string;
  errorCode: string;
  /** The leg's terminal `Create{afp:Error}` digest, or null when it simply never terminated. */
  digest: string | null;
}

export interface SynthesisSpec {
  synthesisId: string;
  /**
   * ADR-0010 Decision 1: optional — a Synthesis on a direct-flow thread with
   * no Award resolves its governing pins from the thread's pin-bearing task
   * activities instead. Emitted only when supplied.
   */
  award?: string;
  method: string;
  answer: JsonValue;
  confidence: number;
  /** Hashes of every input Result — binds the answer to its exact evidence (04). */
  contributingResults: readonly string[];
  assumptions: readonly string[];
  /** First-class, never a footnote (04) — present even when empty. */
  dissent: readonly { [key: string]: JsonValue }[];
  supersededInputs?: readonly string[];
  /** ADR-0006: the answer's category — MUST be a key of the announce's pinned afp:actionPolicy when one exists. */
  category?: string;
  /**
   * ADR-0007: answer-level supersession — the digest of the Synthesis
   * *activity* this one retracts. Distinct from supersededInputs, which is
   * input-level revision during reconciliation.
   */
  supersedes?: string;
  /**
   * ADR-0010 Decision 4: one entry per leg of the thread that contributed no
   * Result — a partial Synthesis MUST declare what is missing rather than
   * silently dropping it, so the leg partition (`afp:contributingResults` +
   * `afp:absentInputs`) stays recomputable.
   */
  absentInputs?: readonly AbsentInput[];
}

/** `Create{afp:Synthesis}` — emitted by the synthesizer the Award (or pin) names. */
export function createSynthesis(envelope: Envelope, spec: SynthesisSpec): { [key: string]: JsonValue } {
  const object: { [key: string]: JsonValue } = {
    id: spec.synthesisId,
    type: "afp:Synthesis",
    "afp:method": spec.method,
    "afp:answer": spec.answer,
    "afp:confidence": spec.confidence,
    "afp:contributingResults": [...spec.contributingResults],
    "afp:assumptions": [...spec.assumptions],
    "afp:dissent": spec.dissent.map((d) => ({ ...d })),
    attributedTo: envelope.actor,
  };
  if (spec.award) object["afp:award"] = spec.award;
  if (spec.supersededInputs?.length) object["afp:supersededInputs"] = [...spec.supersededInputs];
  if (spec.category) object["afp:category"] = spec.category;
  if (spec.supersedes) object["afp:supersedes"] = spec.supersedes;
  if (spec.absentInputs?.length) {
    object["afp:absentInputs"] = spec.absentInputs.map((input) => ({
      "afp:correlationId": input.correlationId,
      "afp:errorCode": input.errorCode,
      "afp:digest": input.digest,
    }));
  }
  return { ...base(envelope, "Create"), object };
}

export interface SettlementSpec {
  settlementId: string;
  task: string;
  hub: string;
  /** The Synthesis this settles, when the answer was a coalition's (04). */
  synthesis?: string;
  /** One entry per settled estimate: the bid it came from and what was observed. */
  entries: readonly {
    actor: string;
    bid: string;
    estimated: JsonValue;
    actual: JsonValue;
  }[];
  /** Accurate minority objections raise standing, never sink it (04, Decision 5). */
  dissentVindicated?: readonly string[];
}

/** `afp:Settlement` — links estimates to actuals; a recorded signal, not a score. */
export function settlement(envelope: Envelope, spec: SettlementSpec): { [key: string]: JsonValue } {
  const activity: { [key: string]: JsonValue } = {
    ...base(envelope, "afp:Settlement"),
    object: {
      id: spec.settlementId,
      type: "afp:Settlement",
      "afp:task": spec.task,
      "afp:hub": spec.hub,
      ...(spec.synthesis ? { "afp:synthesis": spec.synthesis } : {}),
      "afp:settles": spec.entries.map((e) => ({
        actor: e.actor,
        "afp:bid": e.bid,
        "afp:estimated": e.estimated,
        "afp:actual": e.actual,
      })),
    },
  };
  if (spec.dissentVindicated?.length) {
    (activity.object as { [key: string]: JsonValue })["afp:dissentVindicated"] = [...spec.dissentVindicated];
  }
  return activity;
}

// --------------------------------------------------------- Decision settlement (ADR-0018 W1)

/**
 * A second, mutually exclusive `afp:Settlement` subject: settles an
 * `afp:DecisionRecord` rather than an `afp:Task`. `settlement()` above is
 * untouched to the byte — the allocation settlement does not change.
 */
export interface DecisionSettlementSpec {
  settlementId: string;
  hub: string;
  /** Digest of the DecisionRecord *activity* this settles. */
  decision: string;
  round: string;
  /** MUST be one of the proposal's `afp:options`. */
  observedOutcome: string;
  /** 07's artifact shape, hash-addressed. */
  evidence?: readonly { [key: string]: JsonValue }[];
  /** Accurate minority objections raise standing, never sink it (04, Decision 5). */
  dissentVindicated?: readonly string[];
}

/** `afp:Settlement` on a decision — links the recorded outcome to what the world showed. */
export function settleDecision(envelope: Envelope, spec: DecisionSettlementSpec): { [key: string]: JsonValue } {
  const object: { [key: string]: JsonValue } = {
    id: spec.settlementId,
    type: "afp:Settlement",
    "afp:hub": spec.hub,
    "afp:decision": spec.decision,
    "afp:round": spec.round,
    "afp:observedOutcome": spec.observedOutcome,
  };
  if (spec.evidence?.length) object["afp:evidence"] = spec.evidence.map((e) => ({ ...e }));
  if (spec.dissentVindicated?.length) object["afp:dissentVindicated"] = [...spec.dissentVindicated];
  return { ...base(envelope, "afp:Settlement"), object };
}
