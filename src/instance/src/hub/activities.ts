/**
 * Activity builders for the P2 hub flow: two-level enrollment, L0
 * weighted-quorum voting (`Offer{afp:Proposal}` → `Create{afp:Vote}` →
 * `Create{afp:DecisionRecord}`), and hub lifecycle (`afp:Freeze`/`afp:Archive`).
 *
 * Mirrors `ap/activities.ts` exactly: `visibility` is a required envelope
 * field (gate check 5), and `afp:prevActivity` chaining happens in the
 * envelope the caller supplies — this file only shapes activity bodies.
 */

import type { JsonValue } from "../crypto/jcs.ts";
import { AFP_CONTEXTS } from "../ap/documents.ts";
import type { Envelope } from "../ap/activities.ts";

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

// ------------------------------------------------------------------- Enrollment

/** Participation role (02, ADR-0004 Decision 1): default `member` so every existing record reads unchanged. */
export type HubRole = "member" | "requester" | "observer";

export interface EnrollSpec {
  agent: string;
  hub: string;
  capabilities: readonly string[];
  /** `afp:hubKey` — the per-agent, per-hub verification method (02, ADR-0002 Decision 4). */
  hubKey: string;
  /** `afp:role` — member | requester | observer (ADR-0004 Decision 1). */
  role?: HubRole;
}

/** `afp:Enroll` — instance-issued, agent-level (02 § Enrollment is two-level). */
export function enroll(envelope: Envelope, spec: EnrollSpec): { [key: string]: JsonValue } {
  return {
    ...base(envelope, "afp:Enroll"),
    object: spec.agent,
    target: spec.hub,
    "afp:hub": spec.hub,
    "afp:capabilities": [...spec.capabilities],
    "afp:hubKey": spec.hubKey,
    "afp:role": spec.role ?? "member",
  };
}

export interface UnenrollSpec {
  agent: string;
  hub: string;
  reason: string;
}

/** `afp:Unenroll` — removes one agent from the hub's membership OR-Set. */
export function unenroll(envelope: Envelope, spec: UnenrollSpec): { [key: string]: JsonValue } {
  return {
    ...base(envelope, "afp:Unenroll"),
    object: spec.agent,
    target: spec.hub,
    "afp:hub": spec.hub,
    summary: spec.reason,
  };
}

// ------------------------------------------------------------------- Assets

/** A reusable component with identity, versions, and provenance (07, ADR-0004 Decision 2). */
export interface AssetSpec {
  assetId: string;
  hub: string;
  version: string;
  digest: string;
  sourceUrl?: string;
  originContext?: string;
  /** The steward — the registering activity's signature is the accountability. */
  attributedTo: string;
}

/** `Update{afp:Asset}` — registration is on the record, like enrollment, never a side channel. */
export function updateAsset(envelope: Envelope, spec: AssetSpec): { [key: string]: JsonValue } {
  const object: { [key: string]: JsonValue } = {
    id: spec.assetId,
    type: "afp:Asset",
    "afp:version": spec.version,
    "afp:digest": spec.digest,
    attributedTo: spec.attributedTo,
  };
  if (spec.sourceUrl) object["afp:sourceUrl"] = spec.sourceUrl;
  if (spec.originContext) object["afp:originContext"] = spec.originContext;
  return {
    ...base(envelope, "Update"),
    object,
    "afp:hub": spec.hub,
  };
}

// ------------------------------------------------------------------- L0 voting

export interface ProposalSpec {
  proposalId: string;
  round: string;
  hub: string;
  question: string;
  options: readonly string[];
  /** Digest of the merged membership CRDT at round start (snapshot-pinning, 02). */
  quorumSnapshot: string;
  /** Explicit voter list pinned to the snapshot — late-joiners are simply absent. */
  voters: readonly string[];
  /** Liveness-gated uniform weight per voter, recorded so recomputation needs no live state (ADR-0002 Decision 3). */
  weights: Readonly<Record<string, number>>;
}

/** `Offer{afp:Proposal}` — opens an L0 round (03 § 8c). */
export function offerProposal(envelope: Envelope, spec: ProposalSpec): { [key: string]: JsonValue } {
  return {
    ...base(envelope, "Offer"),
    object: {
      id: spec.proposalId,
      type: "afp:Proposal",
      "afp:hub": spec.hub,
      "afp:round": spec.round,
      content: spec.question,
      "afp:options": [...spec.options],
      "afp:quorumSnapshot": spec.quorumSnapshot,
      "afp:voters": [...spec.voters],
      "afp:voterWeights": { ...spec.weights },
    },
  };
}

export interface VoteSpec {
  voteId: string;
  round: string;
  proposalHash: string;
  quorumSnapshot: string;
  value: string;
}

/** `Create{afp:Vote}` — a point-to-point L0 vote (03 § 8c). */
export function castVote(envelope: Envelope, spec: VoteSpec): { [key: string]: JsonValue } {
  return {
    ...base(envelope, "Create"),
    object: {
      id: spec.voteId,
      type: "afp:Vote",
      "afp:round": spec.round,
      "afp:proposalHash": spec.proposalHash,
      "afp:quorumSnapshot": spec.quorumSnapshot,
      value: spec.value,
    },
  };
}

export interface DecisionRecordSpec {
  recordId: string;
  hub: string;
  round: string;
  outcome: string;
  quorumSnapshot: string;
  countedVotes: readonly string[];
  weightTally: Readonly<Record<string, number>>;
  /**
   * ADR-0011 Decision 3: MUST when this record ratifies a *superseding*
   * Synthesis — the `afp:quorumSnapshot` of the DecisionRecord that ratified
   * the answer being superseded. Names the electorate, not just its size, so
   * same-membership re-decision and changed-panel re-decision stop being
   * indistinguishable on the record.
   */
  priorQuorumSnapshot?: string;
  /**
   * ADR-0014 Decision 4: the snapshot members from whom no vote was counted —
   * `declined` where a recorded Reject of the proposal exists, `silent`
   * otherwise. Emitted whenever supplied, an empty list included, so a full
   * turnout is distinguishable from a record that never accounted for anyone.
   */
  uncounted?: readonly { agent: string; status: "declined" | "silent" }[];
}

/** `Create{afp:DecisionRecord}` — closes every round, L0 or L1 (04 § Decision records). */
export function decisionRecord(envelope: Envelope, spec: DecisionRecordSpec): { [key: string]: JsonValue } {
  const object: { [key: string]: JsonValue } = {
    id: spec.recordId,
    type: "afp:DecisionRecord",
    "afp:hub": spec.hub,
    "afp:round": spec.round,
    "afp:outcome": spec.outcome,
    "afp:quorumSnapshot": spec.quorumSnapshot,
    "afp:countedVotes": [...spec.countedVotes],
    "afp:weightTally": { ...spec.weightTally },
    attributedTo: envelope.actor,
  };
  if (spec.priorQuorumSnapshot) object["afp:priorQuorumSnapshot"] = spec.priorQuorumSnapshot;
  if (spec.uncounted !== undefined) {
    object["afp:uncounted"] = spec.uncounted.map((u) => ({ agent: u.agent, "afp:status": u.status }));
  }
  return { ...base(envelope, "Create"), object };
}

// ------------------------------------------------------------------- Lifecycle

/** `afp:Freeze` — suspends new work on the hub (03/07). */
export function freezeHub(envelope: Envelope, hub: string, reason: string): { [key: string]: JsonValue } {
  return {
    ...base(envelope, "afp:Freeze"),
    object: hub,
    summary: reason,
  };
}

export interface ArchiveSpec {
  hub: string;
  reason: string;
  /** Canonical state hashes at close (07) — one per CRDT store. */
  stateHashes: Readonly<Record<string, string>>;
}

/** `afp:Archive` — terminal, read-only close (03/07). */
export function archiveHub(envelope: Envelope, spec: ArchiveSpec): { [key: string]: JsonValue } {
  return {
    ...base(envelope, "afp:Archive"),
    object: spec.hub,
    summary: spec.reason,
    "afp:stateHashes": { ...spec.stateHashes },
  };
}
