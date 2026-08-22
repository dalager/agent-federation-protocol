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
import type { QuorumRule } from "./quorum.ts";
import { buildPinSet } from "../ap/pins.ts";
import type { TaskPins } from "../ap/pins.ts";

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
export type HubRole = "member" | "requester" | "observer" | "actuator";

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
  /** ADR-0018 W1: an RFC 3339 instant, milliseconds + `Z`. Absent means no deadline — today's behaviour. */
  deadline?: string;
  /** ADR-0018 W1: closed registry of forms (see `quorum.ts`). Absent means no bar — `argmax` decides as today. */
  quorumRule?: QuorumRule;
  /** ADR-0018 W1: closed set, currently just `"joint"`. Absent means advisory. */
  binding?: "joint";
  /**
   * ADR-0019 Decisions 1 and W1: the round's own pin set — `actionPolicy`
   * (keyed by outcome, not category) and `irrevocableActions` only;
   * `answerSufficiency` and `afp:synthesizer` mean nothing for a round and are
   * refused by the caller before this is built (`proposeRound`'s job, not
   * this builder's). Absent means unpinned — today's behaviour, byte-identical.
   */
  pins?: TaskPins;
}

/** `Offer{afp:Proposal}` — opens an L0 round (03 § 8c). */
export function offerProposal(envelope: Envelope, spec: ProposalSpec): { [key: string]: JsonValue } {
  const object: { [key: string]: JsonValue } = {
    id: spec.proposalId,
    type: "afp:Proposal",
    "afp:hub": spec.hub,
    "afp:round": spec.round,
    content: spec.question,
    "afp:options": [...spec.options],
    "afp:quorumSnapshot": spec.quorumSnapshot,
    "afp:voters": [...spec.voters],
    "afp:voterWeights": { ...spec.weights },
  };
  // Emitted only when supplied — an unchanged caller must produce
  // byte-identical output (ADR-0018 W1, the G12 compatibility gate).
  if (spec.deadline) object["afp:deadline"] = spec.deadline;
  if (spec.quorumRule) object["afp:quorumRule"] = { ...spec.quorumRule };
  if (spec.binding) object["afp:binding"] = spec.binding;
  // ADR-0019 Decision 1/W1: emitted only when supplied — an unchanged caller
  // must produce byte-identical output.
  if (spec.pins) Object.assign(object, buildPinSet(spec.pins));
  return { ...base(envelope, "Offer"), object };
}

export interface VoteSpec {
  voteId: string;
  round: string;
  proposalHash: string;
  quorumSnapshot: string;
  value: string;
  /**
   * ADR-0016: the hub the vote is cast into. Optional for in-process votes
   * (the round already knows its hub), required in practice for a vote that
   * crosses a boundary — the gate's `hub` grant matches on `afp:hub`, and a
   * vote that does not say which hub it belongs to is not admissible under a
   * grant that names one.
   */
  hub?: string;
}

/** `Create{afp:Vote}` — a point-to-point L0 vote (03 § 8c). */
export function castVote(envelope: Envelope, spec: VoteSpec): { [key: string]: JsonValue } {
  return {
    ...base(envelope, "Create"),
    object: {
      id: spec.voteId,
      type: "afp:Vote",
      ...(spec.hub ? { "afp:hub": spec.hub } : {}),
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
  /**
   * ADR-0018 W1: REQUIRED iff `outcome` is `afp:no-decision` — `"expired"` or
   * `"threshold-not-met"`. Emitted only when supplied, so a pre-ADR-0018
   * record is byte-identical.
   */
  noDecisionReason?: "expired" | "threshold-not-met";
}

/** ADR-0018 W1: the reserved `afp:outcome` value a pinned quorum rule can produce. */
export const NO_DECISION = "afp:no-decision";

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
  if (spec.noDecisionReason) object["afp:noDecisionReason"] = spec.noDecisionReason;
  return { ...base(envelope, "Create"), object };
}

// ------------------------------------------------------------------- Departure (ADR-0018 W1)

export interface DepartureSpec {
  departureId: string;
  hub: string;
  round: string;
  /** Digest of the DecisionRecord *activity* being departed — the same grain `afp:countedVotes` uses. */
  decision: string;
  reason: string;
}

/**
 * `afp:Departure` — a top-level activity, shaped like `afp:Settlement`: a
 * bare `afp:`-typed activity carrying an object, published by a pinned voter
 * on its own chain, on the round's thread, when it dissents from a binding
 * (`afp:binding: "joint"`) decision.
 */
export function departure(envelope: Envelope, spec: DepartureSpec): { [key: string]: JsonValue } {
  return {
    ...base(envelope, "afp:Departure"),
    object: {
      id: spec.departureId,
      type: "afp:Departure",
      "afp:hub": spec.hub,
      "afp:round": spec.round,
      "afp:decision": spec.decision,
      content: spec.reason,
    },
  };
}

// ------------------------------------------------------------------- Anti-entropy (ADR-0016)

export interface DigestSpec {
  hub: string;
  /** Per-store, per-origin provenance counts — `crdtId → actor → count`. */
  versionVectors: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

/** `Offer{afp:Digest}` — "here is what I hold" (02 § Gossip & anti-entropy, ADR-0016 Decision 4). */
export function offerDigest(envelope: Envelope, spec: DigestSpec): { [key: string]: JsonValue } {
  return {
    ...base(envelope, "Offer"),
    object: {
      type: "afp:Digest",
      "afp:hub": spec.hub,
      "afp:versionVector": Object.fromEntries(
        Object.entries(spec.versionVectors).map(([crdtId, vv]) => [crdtId, { ...vv }]),
      ),
    },
  };
}

export interface StateDeltasSpec {
  hub: string;
  /** The Offer{afp:Digest} this answers. */
  inReplyTo: string;
  /**
   * ADR-0016 Decision 3: the signed activities that moved the stores — never
   * bare deltas. Empty if already converged.
   */
  activities: readonly { [key: string]: JsonValue }[];
}

/** `Accept{afp:StateDeltas}` — the pull's answer: what the digest showed missing. */
export function acceptStateDeltas(envelope: Envelope, spec: StateDeltasSpec): { [key: string]: JsonValue } {
  return {
    ...base(envelope, "Accept"),
    inReplyTo: spec.inReplyTo,
    object: {
      type: "afp:StateDeltas",
      "afp:hub": spec.hub,
      "afp:activities": spec.activities.map((activity) => ({ ...activity })),
    },
  };
}

// ------------------------------------------------------------------- Seats (ADR-0017 D4)

/** `Accept{Follow}` — the hub's reply to a Follow, `object` names the Follow activity itself. */
export function acceptFollow(envelope: Envelope, followActivityId: string, follower: string): { [key: string]: JsonValue } {
  return { ...base(envelope, "Accept"), object: followActivityId, to: [follower] };
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
  /** ADR-0015 Decision 3: the converged state those hashes are hashes of. */
  state?: Record<string, JsonValue>;
}

/** `afp:Archive` — terminal, read-only close (03/07). */
export function archiveHub(envelope: Envelope, spec: ArchiveSpec): { [key: string]: JsonValue } {
  return {
    ...base(envelope, "afp:Archive"),
    object: spec.hub,
    summary: spec.reason,
    "afp:stateHashes": { ...spec.stateHashes },
    // ADR-0015 Decision 3: the state enters the record beside its canon.
    ...(spec.state !== undefined ? { "afp:state": { ...spec.state } } : {}),
  };
}
