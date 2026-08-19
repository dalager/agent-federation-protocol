/**
 * Activity builders for the P3 allocation flow (ADR-0003):
 * `Announce{afp:Task}` → `afp:bidCommit` → `afp:BidReveal` → `afp:Award`
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
  return payload;
}

/** `afp:commitment = sha256(JCS(bid payload))` — the digest P1 already ships. */
export function commitmentOf(payload: { [key: string]: JsonValue }): string {
  return digestOf(payload);
}

/** `afp:bidCommit` — the sealed phase: only the commitment travels. */
export function bidCommit(
  envelope: Envelope,
  spec: { task: string; hub: string; commitment: string },
): { [key: string]: JsonValue } {
  return {
    ...base(envelope, "afp:bidCommit"),
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

export interface SynthesisSpec {
  synthesisId: string;
  award: string;
  method: string;
  answer: JsonValue;
  confidence: number;
  /** Hashes of every input Result — binds the answer to its exact evidence (04). */
  contributingResults: readonly string[];
  assumptions: readonly string[];
  /** First-class, never a footnote (04) — present even when empty. */
  dissent: readonly { [key: string]: JsonValue }[];
  supersededInputs?: readonly string[];
}

/** `Create{afp:Synthesis}` — emitted by the synthesizer the Award names. */
export function createSynthesis(envelope: Envelope, spec: SynthesisSpec): { [key: string]: JsonValue } {
  const object: { [key: string]: JsonValue } = {
    id: spec.synthesisId,
    type: "afp:Synthesis",
    "afp:award": spec.award,
    "afp:method": spec.method,
    "afp:answer": spec.answer,
    "afp:confidence": spec.confidence,
    "afp:contributingResults": [...spec.contributingResults],
    "afp:assumptions": [...spec.assumptions],
    "afp:dissent": spec.dissent.map((d) => ({ ...d })),
    attributedTo: envelope.actor,
  };
  if (spec.supersededInputs?.length) object["afp:supersededInputs"] = [...spec.supersededInputs];
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
