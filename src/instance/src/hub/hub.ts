/**
 * The hub actor: `afp:Hub` running in-process, same stack as P1 (ADR-0002
 * Decision 1).
 *
 * Gate check 11, carried forward: `Hub` reaches agents only through
 * `store/queue.ts`'s `Transport` — the same port agents use to reach each
 * other and the instance. Its own outbox is `store/outbox.ts` bound to the
 * instance's SQLite file, its own delivery queue is `store/queue.ts`, and it
 * verifies every signature by fetching the signer's actor document rather
 * than reading any private key map — a hub running as a separate federated
 * service would do exactly this and nothing more.
 */

import type { KeyObject } from "node:crypto";
import type { JsonValue } from "../crypto/jcs.ts";
import { keyHistory, loadOrCreateKeyPair, loadOrCreateTransportKeyPair, publicKeyFromMultibase, type KeyHistoryEntry, type KeyPair } from "../crypto/keys.ts";
import { attachProof, digestOf, verifyProof } from "../crypto/proof.ts";
import { instantMillis } from "../crypto/time.ts";
import type { Db } from "../store/db.ts";
import { Outbox, type OutboxEntry } from "../store/outbox.ts";
import { DeliveryQueue, type Transport } from "../store/queue.ts";
import { hubActor, hubActorId } from "../ap/documents.ts";
import {
  acceptStateDeltas,
  archiveHub,
  decisionRecord,
  equivocationProof,
  freezeHub,
  offerDigest,
  offerProposal,
  NO_DECISION,
  type Envelope,
  type HubRole,
  type SuccessionRule,
  type Visibility,
} from "./activities.ts";
import { convicts, voteTupleOf, type VotePhase } from "./equivocation.ts";
import { validateIrrevocableActions, validateProposalActionPolicy, type TaskPins } from "../ap/pins.ts";
import { LWWRegister, ORMap, ORMapLWW, ORSet } from "./crdtAdapter.ts";
import { thresholdOf, type QuorumRule } from "./quorum.ts";
import { voterWeights } from "./weights.ts";
import { CRDTStore, type LWWState, type ORMapState, type ORSetState } from "../crdt/index.ts";
import {
  convictionsFor,
  ensureHubSchema,
  countedVoteTuple,
  hasSeat,
  isConvicted,
  liveSeats,
  loadRound,
  recordConviction,
  roundByProposal,
  roundDeclinesFor,
  saveDeparture,
  saveRound,
  saveRoundDecline,
  saveVoteReceipt,
  departuresFor,
  voteReceiptsFor,
  type RoundRow,
} from "./store.ts";
import { Allocator } from "../allocation/allocator.ts";
import { logAdmission } from "../allocation/store.ts";
import { onFollow, onUndoFollow, type SeatDeps } from "./seats.ts";

export { hubTransport } from "./transport.ts";

export type ReceiveOutcome =
  | { status: "dispatched" }
  | { status: "duplicate"; reason: string }
  | { status: "rejected"; reason: string };

type ActorDocument = { [key: string]: JsonValue };

export interface HubDeps {
  origin: string;
  hubId: string;
  db: Db;
  keyDir: string;
  instanceActorId: string;
  maxDeliveryAttempts: number;
  backoffBaseMs: number;
  /**
   * Actor document lookup. In P2's single-operator demo this reads the
   * instance's own agent/actor documents; a hub running remotely would fetch
   * the same document over HTTP. Either way, the hub learns a signer's key
   * only from the document it publishes — never from in-process state.
   */
  fetchActor: (actorId: string) => ActorDocument | null;
  now?: () => Date;
  /**
   * ADR-0016 Decision 4: resolve an activity id from the record — own outbox
   * or received bytes. The provenance table holds ids, never bytes; this is
   * the pointer dereference an `Accept{afp:StateDeltas}` needs to carry the
   * signed activities themselves. Absent on a hub that never syncs.
   */
  resolveActivity?: (activityId: string) => { [key: string]: JsonValue } | null;
  /**
   * ADR-0016 Decision 4/5: when set, this hub is a replica of the named hub
   * actor — 02's recovery story ("stand up a replacement hub actor, replay
   * CRDT deltas") given a switch. Sync traffic names the replicated identity
   * (`afp:hub`), and inbound activities addressed to it are applied here.
   * Transport-level only: whether a migrated host is the same hub remains
   * ADR-0014's open revisit trigger, deliberately untouched.
   */
  replicaOf?: string;
  /**
   * ADR-0017 Decision 4 (R2): `"follow-required"` gates `afp:Enroll` on a live
   * seat (this instance must have Followed this hub first); the default,
   * `"enroll-implies-seat"`, keeps every existing hub test's behavior
   * byte-identical — Enroll alone still fills `this.instances`.
   */
  seatPolicy?: "follow-required" | "enroll-implies-seat";
}

interface LivenessValue {
  status: "live" | "suspected";
  load: number;
}

/**
 * ADR-0020 W1: per-round L1 metadata, kept in the CRDT store rather than
 * `hub_rounds` (`store.ts` is WP-1's file, not this WP's to extend) — one LWW
 * register per round, restored in `hydrate()` like every other view. Absent
 * (no entry in `Hub.roundMeta`) means an L0 round.
 */
interface RoundMeta {
  level?: 1;
  successionRule?: SuccessionRule;
  /** Digest of the stalled proposal ACTIVITY this round supersedes, if any. */
  supersedesRound?: string;
  /**
   * The `actor` of this round's own `Offer{afp:Proposal}` ACTIVITY, as
   * recorded — "the stalled round's proposer" `successor()` rotates past.
   * Integration ruling: this MUST be read from the record (the signed
   * proposal's own `actor`), never from off-wire caller state, so a replay
   * recomputes the identical rotation start. Today every proposal is signed
   * by the hub itself (ADR-0014's sequencing authority), so this is
   * `this.actorId` for every round; a member-signed proposal path would
   * populate it from that activity's `actor` instead.
   */
  proposalActor: string;
}

/**
 * ADR-0020 W1: the L1 phases in their protocol order — a counted ballot never
 * moves backwards through them (`onVote`).
 */
const PHASE_ORDER: Record<VotePhase, number> = { prepare: 0, commit: 1 };

/**
 * Is `at` past a round's `afp:deadline` (ADR-0018 W4)? False when no deadline
 * was pinned, and false for a deadline nobody can parse — a round whose clock
 * is unreadable has no clock, which is the pre-ADR-0018 behaviour rather than
 * an every-vote-is-late trap. Instants, never strings: see `onVote`.
 */
function pastDeadline(at: Date, deadline: string | null | undefined): boolean {
  if (!deadline) return false;
  const limit = Date.parse(deadline);
  return Number.isFinite(limit) && at.getTime() > limit;
}

export class Hub {
  readonly hubId: string;
  private readonly keyDir: string;
  readonly actorId: string;
  readonly outbox: Outbox;
  readonly queue: DeliveryQueue;
  /** Allocation lives beside the hub — same process, same dispatch port (ADR-0003 Decision 1). */
  readonly allocation: Allocator;

  private readonly db: Db;
  private readonly origin: string;
  private readonly instanceActorId: string;
  private readonly key: KeyPair;
  private readonly transportKey: KeyPair;
  private readonly fetchActor: HubDeps["fetchActor"];
  private readonly resolveActivity: (activityId: string) => { [key: string]: JsonValue } | null;
  private readonly now: () => Date;
  /** The hub actor sync traffic names: `replicaOf` when set, else self. */
  private readonly hubIdentity: string;
  private readonly seatPolicy: "follow-required" | "enroll-implies-seat";

  /**
   * The persisted CRDT store (ADR-0002 Decision 5): every delta the hub folds
   * into its in-memory views below is also applied here, so merged state and
   * the per-actor version vector survive restart — and the P5 digest exchange
   * is a `SELECT` over `crdt_version_vector`, not a migration.
   */
  private readonly crdt: CRDTStore;

  private readonly membership = new ORSet<string>();
  private readonly capabilities = new ORMap<string, string>();
  private readonly liveness = new Map<string, LWWRegister<LivenessValue>>();
  /**
   * Participation role per agent (ADR-0004 Decision 1): per-agent LWW over the
   * Enroll trail — latest `published` wins, equal timestamps break by higher
   * activity digest (the register's nodeId). Re-enrolling with a new role is
   * the upgrade/downgrade path, on the record.
   */
  private readonly roles = new Map<string, LWWRegister<HubRole>>();
  /**
   * The instance that enrolled each agent (ADR-0005 Decision 2) — the operator
   * an agent counts for when votes are weighted per instance rather than per
   * agent. Folded from the Enroll's own actor, which Decision 2 binds to the
   * agent's `afp:operatedBy`, so the trail carries the mapping the weighting
   * rests on.
   */
  private readonly instances = new Map<string, LWWRegister<string>>();
  /**
   * Declared changes of control (ADR-0005 amendment, 2026-08-22): instance
   * actor id → the operator it currently declares itself operated by, folded
   * from the latest `Create{afp:ControlTransfer}` on that instance's own
   * chain. Absent means the instance is its own operator, exactly today's
   * behaviour — the weighting in `weights.ts` groups by whichever key this
   * map or the raw instance id resolves to, so an unused feature changes
   * nothing.
   */
  private readonly controlTransfers = new Map<string, LWWRegister<string>>();
  /**
   * The asset registry (ADR-0004 Decision 2): a hub-scoped OR-Map
   * `"assetId@version"` → asset record, fed by signed `Update{afp:Asset}`
   * activities. One (id, version) is immutable once registered — enforced
   * here at admission, before the CRDT ever sees a conflicting write.
   */
  private readonly assets = new ORMapLWW<string, { [key: string]: JsonValue }>();
  // Rounds and vote receipts hold no in-memory state: every read goes through
  // `loadRound`/`voteReceiptsFor` against SQLite, the same fully-stateless
  // style as the allocator's award sweep — so a restart mid-round needs no
  // rehydration step (ADR-0004, implementation parity note).
  private readonly seen = new Set<string>();
  /** ADR-0020 W1: `RoundMeta` per round, CRDT-backed (`roundmeta:{round}`). */
  private readonly roundMeta = new Map<string, LWWRegister<RoundMeta>>();
  /**
   * ADR-0020 W2: the last-seen full vote activity per (round, actor, phase)
   * — needed to build a legitimate `afp:EquivocationProof` (both votes
   * embedded verbatim, Decision 1), which `hub_vote_receipts` cannot supply
   * since it stores only a digest. Keyed by phase because phase is part of
   * the ballot-identity tuple Decision 2 convicts on: a per-voter key would
   * evict the earlier phase's vote when the round advances, and take that
   * phase's equivocation evidence with it. CRDT-backed
   * (`voteact:{round}:{actor}:{phase}`), restored on hydrate like every
   * other view. Populated only for a vote carrying L1 fields — an L0 vote is
   * never proof material.
   */
  private readonly voteActivities = new Map<string, LWWRegister<{ [key: string]: JsonValue }>>();

  private status: "active" | "frozen" | "archived" = "active";

  constructor(deps: HubDeps) {
    this.hubId = deps.hubId;
    this.origin = deps.origin;
    this.db = deps.db;
    this.instanceActorId = deps.instanceActorId;
    this.fetchActor = deps.fetchActor;
    this.resolveActivity = deps.resolveActivity ?? (() => null);
    this.now = deps.now ?? (() => new Date());
    this.actorId = hubActorId(deps.origin, deps.hubId);
    this.hubIdentity = deps.replicaOf ?? this.actorId;
    this.seatPolicy = deps.seatPolicy ?? "enroll-implies-seat";

    ensureHubSchema(this.db);
    this.crdt = new CRDTStore(this.db);
    this.keyDir = deps.keyDir;
    this.key = loadOrCreateKeyPair(deps.keyDir, `hub-${deps.hubId}`, this.actorId);
    this.transportKey = loadOrCreateTransportKeyPair(deps.keyDir, `hub-${deps.hubId}`, this.actorId);
    this.outbox = new Outbox(this.db);
    this.queue = new DeliveryQueue(this.db, deps.maxDeliveryAttempts, deps.backoffBaseMs);
    this.allocation = new Allocator({
      hubId: this.hubId,
      actorId: this.actorId,
      db: this.db,
      members: () => this.members(),
      roleOf: (agent) => this.roleOf(agent),
      broadcastTargets: () => this.broadcastTargets(),
      now: () => this.now(),
      emit: (to, thread, visibility, build) => this.emit(to, thread, visibility, build),
    });

    this.hydrate();
  }

  /**
   * Come back from the store (ADR-0004's parity note: *the whole hub* comes
   * back, not only its rounds).
   *
   * Every view below is written through to `CRDTStore` on each delta, so
   * startup is a `SELECT` over persisted state, never a replay of the record.
   * Without this the hub wakes with empty membership — which is not merely an
   * availability problem: `onUpdateAsset` enforces `(id, version)`
   * immutability against `this.assets`, so an amnesiac hub would silently
   * admit a second, conflicting digest for an asset it had already
   * registered, defeating Decision 2 across any restart.
   */
  private hydrate(): void {
    for (const { crdtId, crdtType } of this.crdt.crdtIds(this.hubId)) {
      const state = this.crdt.getState(this.hubId, crdtId);
      if (!state) continue;

      if (crdtId === "membership" && crdtType === "OR_SET") {
        this.membership.restore(state as ORSetState);
      } else if (crdtId === "capabilities" && crdtType === "OR_MAP") {
        this.capabilities.restore(state as ORMapState);
      } else if (crdtId === "assets" && crdtType === "OR_MAP") {
        this.assets.restore(state as ORMapState);
      } else if (crdtId.startsWith("liveness:") && crdtType === "LWW_REGISTER") {
        const register = new LWWRegister<LivenessValue>();
        register.restore(state as LWWState<LivenessValue>);
        this.liveness.set(crdtId.slice("liveness:".length), register);
      } else if (crdtId.startsWith("role:") && crdtType === "LWW_REGISTER") {
        const register = new LWWRegister<HubRole>();
        register.restore(state as LWWState<HubRole>);
        this.roles.set(crdtId.slice("role:".length), register);
      } else if (crdtId.startsWith("instance:") && crdtType === "LWW_REGISTER") {
        const register = new LWWRegister<string>();
        register.restore(state as LWWState<string>);
        this.instances.set(crdtId.slice("instance:".length), register);
      } else if (crdtId.startsWith("controlTransfer:") && crdtType === "LWW_REGISTER") {
        const register = new LWWRegister<string>();
        register.restore(state as LWWState<string>);
        this.controlTransfers.set(crdtId.slice("controlTransfer:".length), register);
      } else if (crdtId.startsWith("roundmeta:") && crdtType === "LWW_REGISTER") {
        const register = new LWWRegister<RoundMeta>();
        register.restore(state as LWWState<RoundMeta>);
        this.roundMeta.set(crdtId.slice("roundmeta:".length), register);
      } else if (crdtId.startsWith("voteact:") && crdtType === "LWW_REGISTER") {
        const register = new LWWRegister<{ [key: string]: JsonValue }>();
        register.restore(state as LWWState<{ [key: string]: JsonValue }>);
        this.voteActivities.set(crdtId.slice("voteact:".length), register);
      }
    }

    // Lifecycle is recorded, not stored: the hub's own outbox already carries
    // its afp:Freeze/afp:Archive. Recovering it from there keeps `archived`
    // genuinely terminal — a restart must not reopen a hub that closed.
    for (const entry of this.outbox.byActor(this.actorId)) {
      const type = String(entry.activity.type ?? "");
      if (type === "afp:Freeze" && this.status === "active") this.status = "frozen";
      else if (type === "afp:Archive") this.status = "archived";
    }
  }

  actorDocument(): ActorDocument {
    return hubActor(this.origin, this.hubId, this.key, this.instanceActorId, this.transportKey);
  }

  /**
   * ADR-0012 Decision 1: a hub signs its own outbox, so its keys are among the
   * keys that signed things in an export — and a history that skipped them
   * would leave the hub's chain resolvable only against its current document,
   * which is the gap this ADR closes for everyone else.
   */
  keyHistory(): KeyHistoryEntry[] {
    return keyHistory(this.keyDir, `hub-${this.hubId}`, this.actorId);
  }

  /**
   * ADR-0014 Decision 1: the hub vouches for a member, portably.
   *
   * A signed, expiring statement naming one agent, this hub, and the agent's
   * role — what lets a member prove its enrollment to a peer that does not
   * host this hub, verified against the hub's published key the peer already
   * holds. Transport machinery, never an activity: reads leave no record
   * (ADR-0013 Decision 5), so neither does the credential that admits one.
   * The Enroll trail remains the authority; this is that authority made
   * portable for its TTL, not a second copy of it.
   *
   * Returns null for the un-enrolled — a hub does not sign statements about
   * strangers, not even negative ones.
   */
  /**
   * ADR-0014 Decision 4: a member's Reject of an open round's proposal —
   * recorded so the closing DecisionRecord can tell "declined" from "silent".
   * Returns false when the Reject names no open round, so the dispatch can
   * fall through to the bid-window decline path (03).
   */
  private onRoundDecline(activity: { [key: string]: JsonValue }): boolean {
    const proposalId = String(activity.object ?? "");
    const row = roundByProposal(this.db, proposalId);
    if (!row || row.status !== "open") return false;
    const actor = String(activity.actor ?? "");
    if (!row.voters.includes(actor)) return false; // outside the pinned electorate — not this round's to record
    saveRoundDecline(this.db, row.roundId, actor, digestOf(activity));
    return true;
  }

  /**
   * ADR-0014 Decision 3: the hub's chain head, exposed so a deployment can
   * anchor it on a cadence via ADR-0012's carrier (`afp:anchors`). The hub's
   * hash-chained outbox is the one cross-operator order no member's clock
   * controls; this is the digest that pins it.
   */
  chainHead(): string | null {
    return this.outbox.headDigest(this.actorId);
  }

  membershipProof(agent: string, ttlMs = 15 * 60 * 1000): { [key: string]: JsonValue } | null {
    const role = this.roleOf(agent);
    if (role === null) return null;
    const statement: { [key: string]: JsonValue } = {
      type: "afp:MembershipProof",
      "afp:hub": this.actorId,
      agent,
      "afp:role": role,
      "afp:expires": new Date(this.now().getTime() + ttlMs).toISOString(),
    };
    return attachProof(statement, {
      privateKey: this.key.privateKey,
      verificationMethod: this.key.keyId,
      created: this.now().toISOString(),
    });
  }

  members(): string[] {
    return [...this.membership.getState()];
  }

  capabilitiesOf(agent: string): string[] {
    return [...this.capabilities.setFor(agent).getState()];
  }

  isLive(agent: string): boolean {
    return this.liveness.get(agent)?.getState()?.value.status === "live";
  }

  /** ADR-0004 Decision 1: an enrolled agent's role; `null` for the un-enrolled. */
  roleOf(agent: string): HubRole | null {
    if (!this.membership.getState().has(agent)) return null;
    return this.roles.get(agent)?.getState()?.value ?? "member";
  }

  /**
   * ADR-0016 Decision 2: the write door. Admission only, never authority —
   * whether the sender may cross at all, decided from the hub's own record of
   * its own enrollment; what the write may *do* stays in the handlers, where
   * 02 puts it ("at bid admission and snapshot-pinning, never in workflow
   * code"). No membership proof is consulted: the proof exists for whoever
   * cannot ask the hub, and the hub can always ask itself.
   *
   * Enrollment-class and anti-entropy traffic crosses on the strength of the
   * boundary gate alone — the door-knock analog of the handshake bypass in
   * `handleInboxPost`: an `afp:Enroll` names an agent that is by definition
   * not yet enrolled (its own handler enforces ADR-0005's issuer binding),
   * and a digest exchange is transport-level traffic between replicas, the
   * class of thing 02 sanctions the hub key itself to sign.
   */
  writeAdmitted(actor: string, activity: { [key: string]: JsonValue }): boolean {
    const type = String(activity.type ?? "");
    if (type === "afp:Enroll" || type === "afp:Unenroll") return true;
    // ADR-0017 Decision 4 (R3): Follow/Undo join the door-knock class — a
    // seat is what admits future Enrolls, so establishing or revoking one
    // cannot itself require a seat.
    if (type === "Follow" || type === "Undo") return true;
    const object = activity.object;
    const objectType =
      object && typeof object === "object" && !Array.isArray(object)
        ? String((object as Record<string, JsonValue>).type ?? "")
        : "";
    if ((type === "Offer" && objectType === "afp:Digest") || (type === "Accept" && objectType === "afp:StateDeltas")) {
      return true;
    }
    return this.roleOf(actor) !== null;
  }

  /**
   * Role-aware broadcast list (ADR-0004): announces, awards and proposals go
   * to members and observers; a requester receives only activities on threads
   * it announced (the allocator adds the counterparty per auction).
   */
  broadcastTargets(): string[] {
    return this.members().filter((agent) => this.roleOf(agent) !== "requester");
  }

  // ------------------------------------------------------------------ inbound

  /**
   * Accept an inbound activity, addressed to this hub through the same
   * `Transport.deliver(target, activity)` call agents receive through.
   */
  async receive(activity: { [key: string]: JsonValue }): Promise<ReceiveOutcome> {
    const activityId = typeof activity.id === "string" ? activity.id : "";
    if (!activityId) return { status: "rejected", reason: "activity has no id" };
    if (this.status === "archived") {
      return { status: "rejected", reason: "hub is archived — terminal, read-only (afp:Archive)" };
    }

    const verification = this.verifySignature(activity);
    if (!verification.ok) return { status: "rejected", reason: verification.reason };

    if (this.seen.has(activityId)) {
      return { status: "duplicate", reason: `activity ${activityId} already delivered` };
    }
    this.seen.add(activityId);

    await this.dispatch(activity);
    return { status: "dispatched" };
  }

  /**
   * Resolve the signer's public key from the actor document the
   * `proof.verificationMethod` names — the same trust source an out-of-process
   * hub would use (no private key map read).
   */
  private verifySignature(activity: { [key: string]: JsonValue }): { ok: true } | { ok: false; reason: string } {
    const proof = activity.proof as { verificationMethod?: unknown } | undefined;
    const vm = typeof proof?.verificationMethod === "string" ? proof.verificationMethod : "";
    if (!vm) return { ok: false, reason: "no proof present" };

    const controller = vm.split("#")[0];
    const doc = this.fetchActor(controller);
    if (!doc) return { ok: false, reason: `no actor document for signer ${controller}` };

    const methods = Array.isArray(doc.assertionMethod) ? (doc.assertionMethod as JsonValue[]) : [];
    const entry = methods.find(
      (m) => m && typeof m === "object" && !Array.isArray(m) && (m as Record<string, JsonValue>).id === vm,
    ) as Record<string, JsonValue> | undefined;
    if (!entry || typeof entry.publicKeyMultibase !== "string") {
      return { ok: false, reason: `no verification method ${vm} on ${controller}'s actor document` };
    }

    let publicKey: KeyObject;
    try {
      publicKey = publicKeyFromMultibase(entry.publicKeyMultibase);
    } catch (error) {
      return { ok: false, reason: `undecodable key: ${(error as Error).message}` };
    }

    const result = verifyProof(activity, publicKey);
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  }

  private async dispatch(activity: { [key: string]: JsonValue }): Promise<void> {
    const type = String(activity.type ?? "");
    const object = activity.object;
    const objectType =
      object && typeof object === "object" && !Array.isArray(object)
        ? String((object as Record<string, JsonValue>).type ?? "")
        : "";

    // ADR-0017 Decision 4 (R3): Follow/Undo, dispatched before the allocator's
    // own Accept fallthrough — the same class as Enroll/Unenroll above.
    if (type === "Follow") return this.onFollow(activity);
    if (type === "Undo") return this.onUndoFollow(activity);
    if (type === "afp:Enroll") return this.onEnroll(activity);
    if (type === "afp:Unenroll") return this.onUnenroll(activity);
    // ADR-0005 amendment (2026-08-22): a declared change of control, on the
    // transferring instance's own chain — same class as Enroll/Unenroll.
    if (type === "Create" && objectType === "afp:ControlTransfer") return this.onControlTransfer(activity);
    if (type === "Create" && objectType === "afp:Vote") return this.onVote(activity);
    // ADR-0018 Decision 3: a departure from a binding decision, published on
    // the round's own thread by a pinned voter — shaped like afp:Settlement,
    // a bare afp:-typed activity rather than a Create wrapper.
    if (type === "afp:Departure") return this.onDeparture(activity);
    // ADR-0016 Decision 4: the anti-entropy exchange, activity-shaped like
    // everything else. Both branch on objectType before the allocation
    // fallthroughs below, because an Accept is also the award path's verb.
    if (type === "Offer" && objectType === "afp:Digest") return this.onDigestOffer(activity);
    if (type === "Accept" && objectType === "afp:StateDeltas") return this.onStateDeltas(activity);
    // ADR-0016 Decision 3, the second population: an application-defined
    // store's mutation is an explicit signed Update{afp:CRDTDelta} (02),
    // applied here with the activity itself as provenance.
    if (type === "Update" && objectType === "afp:CRDTDelta") return this.onCrdtDelta(activity);
    // ADR-0004 Decision 1: inbound Announce{afp:Task} is a first-class dispatch
    // path — a requester's (or member's) signed Announce is admitted by role,
    // re-fanned out by the hub, and the announcing actor becomes the
    // settlement's counterparty. An observer cannot announce.
    if (type === "Announce" && objectType === "afp:Task") return this.allocation.onAnnounce(activity);
    // ADR-0020 Decision 5 (C): a member's own assembled proof, announced —
    // the concealment duty's other half of the searchlight (V8 is the joint
    // layer's; this is the hub's own receive-time check).
    if (type === "Announce" && objectType === "afp:EquivocationProof") return this.onEquivocationProofAnnounce(activity);
    // A requester reporting observed actuals onto its own thread — the write
    // that settlement on requester-reported actuals depends on (scenario 05).
    if (type === "Create" && objectType === "afp:Result") return this.allocation.onActualsReport(activity);
    // ADR-0004 Decision 2: asset registration rides an ordinary signed
    // Update{afp:Asset} — on the record, like enrollment, never a side channel.
    if (type === "Update" && objectType === "afp:Asset") return this.onUpdateAsset(activity);
    // Allocation (ADR-0003 Decision 1): commits, reveals, declines and award
    // Accepts route to the allocator beside the hub. Each handler ignores
    // activities that reference no open auction of ours.
    if (type === "afp:BidCommit") return this.allocation.onCommit(activity);
    if (type === "afp:BidReveal") return this.allocation.onReveal(activity);
    if (type === "Reject") {
      // A Reject may decline a round's proposal (ADR-0014 Decision 4) or an
      // announced task's bid window (03) — the object decides, and the round
      // path answers first because a proposal id is never a task id.
      if (this.onRoundDecline(activity)) return;
      return this.allocation.onDecline(activity);
    }
    if (type === "Accept") return this.allocation.onAccept(activity);
    // Other inbound types are recorded by delivery alone — an inbox is a hint,
    // never an instruction.
  }

  private onEnroll(activity: { [key: string]: JsonValue }): void {
    if (this.status !== "active") return; // afp:Freeze suspends new work; enrollment is new work
    const agent = String(activity.object ?? "");
    if (!agent) return;
    const tag = String(activity.id);
    const origin = String(activity.actor ?? "");

    // ADR-0005 Decision 2: an Enroll is issued by the enrolled agent's own
    // instance and by nobody else. Without this an agent publishes
    // Enroll{object: self, afp:role: member} and self-promotes — and since the
    // trail is also what says which operator an agent counts for, a forged
    // issuer would forge a seat as well as a role. The agent's own actor
    // document names its operator, so the hub resolves this the same way it
    // resolves a signing key: from the document the actor publishes.
    const operatedBy = String(this.fetchActor(agent)?.["afp:operatedBy"] ?? "");
    if (!operatedBy || origin !== operatedBy) {
      logAdmission(
        this.db,
        this.now().toISOString(),
        agent,
        origin,
        "rejected",
        operatedBy
          ? `enroll issued by ${origin}, but ${agent} is operated by ${operatedBy} (ADR-0005)`
          : `enroll for ${agent}, whose actor document names no afp:operatedBy`,
      );
      return;
    }

    // ADR-0017 Decision 4 (R2): under `follow-required`, an Enroll from an
    // instance holding no live seat is refused — the seat, not the Enroll
    // alone, is what admits new membership.
    if (this.seatPolicy === "follow-required" && !hasSeat(this.db, origin)) {
      logAdmission(
        this.db,
        this.now().toISOString(),
        agent,
        origin,
        "rejected",
        `no seat: instance ${origin} has not Followed this hub (ADR-0017 D4)`,
      );
      return;
    }
    const capabilities = Array.isArray(activity["afp:capabilities"])
      ? (activity["afp:capabilities"] as JsonValue[]).map(String)
      : [];

    this.membership.apply({ op: "add", value: agent, tag });
    this.crdt.apply(
      { hub: this.hubId, crdtId: "membership", crdtType: "OR_SET", delta: { adds: [{ element: agent, tag }], removes: [] } },
      origin,
      this.now(),
      String(activity.id),
    );
    for (const capability of capabilities) {
      this.capabilities.apply({ key: agent, set: { op: "add", value: capability, tag } });
      this.crdt.apply(
        {
          hub: this.hubId,
          crdtId: "capabilities",
          crdtType: "OR_MAP",
          delta: { key: agent, fieldType: "OR_SET", adds: [{ element: capability, tag }], removes: [] },
        },
        origin,
        this.now(),
        String(activity.id),
      );
    }
    const liveness = { value: { status: "live", load: 0 }, timestamp: this.now().getTime(), nodeId: this.actorId };
    const register = new LWWRegister<LivenessValue>();
    register.apply(liveness as { value: LivenessValue; timestamp: number; nodeId: string });
    this.liveness.set(agent, register);
    this.crdt.apply(
      { hub: this.hubId, crdtId: `liveness:${agent}`, crdtType: "LWW_REGISTER", delta: liveness },
      this.actorId,
      this.now(),
    );

    // Role (ADR-0004 Decision 1): LWW over the Enroll trail — timestamp is the
    // activity's own `published`, tie-break by higher activity digest.
    const roleValue = String(activity["afp:role"] ?? "member") as HubRole;
    const role = { value: roleValue, timestamp: instantMillis(activity.published), nodeId: digestOf(activity) };
    const roleRegister = this.roles.get(agent) ?? new LWWRegister<HubRole>();
    roleRegister.apply(role);
    this.roles.set(agent, roleRegister);
    this.crdt.apply(
      { hub: this.hubId, crdtId: `role:${agent}`, crdtType: "LWW_REGISTER", delta: role },
      origin,
      this.now(),
      String(activity.id),
    );

    // The operator this agent counts for when a round is weighted (ADR-0005).
    const seat = { value: origin, timestamp: role.timestamp, nodeId: role.nodeId };
    const seatRegister = this.instances.get(agent) ?? new LWWRegister<string>();
    seatRegister.apply(seat);
    this.instances.set(agent, seatRegister);
    this.crdt.apply(
      { hub: this.hubId, crdtId: `instance:${agent}`, crdtType: "LWW_REGISTER", delta: seat },
      origin,
      this.now(),
      String(activity.id),
    );
  }

  /** The instance that enrolled `agent` — the operator it counts for (ADR-0005). */
  instanceOf(agent: string): string | null {
    return this.instances.get(agent)?.getState()?.value ?? null;
  }

  /**
   * A declared change of control (ADR-0005 amendment): `Create{afp:ControlTransfer}`
   * on the transferring instance's own chain, folded the same way as an
   * Enroll — by its own actor, into an LWW register keyed by that instance.
   *
   * No authority check beyond signature: the activity is self-referential (an
   * instance declares its own new operator), so a valid signature from the
   * transferring instance's own key is exactly the entitlement the record
   * needs — the same standard a Vouch/Disown is held to.
   */
  private onControlTransfer(activity: { [key: string]: JsonValue }): void {
    const instanceActor = String(activity.actor ?? "");
    const object = activity.object;
    const operatedBy =
      object && typeof object === "object" && !Array.isArray(object)
        ? String((object as Record<string, JsonValue>)["afp:operatedBy"] ?? "")
        : "";
    if (!instanceActor || !operatedBy) return;

    const published = String(activity.published ?? this.now().toISOString());
    const delta = { value: operatedBy, timestamp: published, nodeId: instanceActor };
    const register = this.controlTransfers.get(instanceActor) ?? new LWWRegister<string>();
    register.apply(delta);
    this.controlTransfers.set(instanceActor, register);
    this.crdt.apply(
      { hub: this.hubId, crdtId: `controlTransfer:${instanceActor}`, crdtType: "LWW_REGISTER", delta },
      instanceActor,
      this.now(),
      String(activity.id),
    );
  }

  /**
   * The operator instance `instanceActor` currently counts as, for weighting
   * (ADR-0005 amendment): the latest declared `Create{afp:ControlTransfer}`
   * on its own chain, else itself unchanged. Grouping voters by this instead
   * of by raw instance id is what lets a declared merger fold two seats into
   * one operator's weight — and, absent any transfer, is the identity
   * function `voterWeights` has always seen.
   */
  effectiveOperatorOf(instanceActor: string): string {
    return this.controlTransfers.get(instanceActor)?.getState()?.value ?? instanceActor;
  }

  private onUnenroll(activity: { [key: string]: JsonValue }): void {
    if (this.status !== "active") return;
    const agent = String(activity.object ?? "");
    if (!agent) return;
    this.removeAgent(agent, String(activity.actor ?? ""), String(activity.id));
  }

  /** The shared body of `onUnenroll` and the seat revocation's mass-unenroll (ADR-0017 D4). */
  private removeAgent(agent: string, byActor: string, activityId: string): void {
    const tags = this.membership.tagsFor(agent);
    for (const tag of tags) this.membership.apply({ op: "remove", value: agent, tag });
    this.crdt.apply(
      {
        hub: this.hubId,
        crdtId: "membership",
        crdtType: "OR_SET",
        delta: { adds: [], removes: [{ element: agent, tombstoneTags: tags }] },
      },
      byActor,
      this.now(),
      activityId,
    );
    this.liveness.delete(agent);
    this.roles.delete(agent);
  }

  /** ADR-0017 Decision 4 (R3): the slice of `Hub` `hub/seats.ts`'s handlers need. */
  private seatDeps(): SeatDeps {
    return {
      db: this.db,
      actorId: this.actorId,
      fetchActor: this.fetchActor,
      now: this.now,
      emit: (to, thread, visibility, build) => this.emit(to, thread, visibility, build),
      members: () => this.members(),
      instanceOf: (agent) => this.instanceOf(agent),
      removeAgent: (agent, byActor, activityId) => this.removeAgent(agent, byActor, activityId),
    };
  }

  /** `Follow{object: this hub}` (ADR-0017 Decision 4, R3) — see `hub/seats.ts`. */
  private onFollow(activity: { [key: string]: JsonValue }): void {
    onFollow(this.seatDeps(), activity);
  }

  /** `Undo{Follow}` (ADR-0017 Decision 4, R3) — see `hub/seats.ts`. */
  private onUndoFollow(activity: { [key: string]: JsonValue }): void {
    onUndoFollow(this.seatDeps(), activity);
  }

  /**
   * Snapshot discipline (ADR-0002 Decision 3, check 3): a vote from an actor
   * outside the round's pinned `afp:quorumSnapshot` voter list is rejected
   * even if validly signed — it simply never joins the receipt `G-Set`.
   */
  private onVote(activity: { [key: string]: JsonValue }): void {
    const object = activity.object as Record<string, JsonValue>;
    const round = String(object["afp:round"] ?? "");
    const row = loadRound(this.db, round);
    if (!row || row.status !== "open") return;

    const actor = String(activity.actor ?? "");
    if (!row.voters.includes(actor)) return; // outside the pinned snapshot — dropped, not tallied

    // A vote must commit to the exact proposal and pinned snapshot it answers:
    // a mismatched afp:proposalHash is a ballot for a different question, and a
    // mismatched afp:quorumSnapshot is a ballot under a different electorate.
    // Both are dropped, not tallied — same treatment as an out-of-snapshot voter.
    if (String(object["afp:proposalHash"] ?? "") !== row.proposalHash) return;
    if (String(object["afp:quorumSnapshot"] ?? "") !== row.quorumSnapshot) return;

    // ADR-0018 W4: the deadline is enforced twice, in two currencies — this is
    // the hub's own-clock half. A vote arriving after `afp:deadline`, judged
    // by `this.now()` rather than the vote's claimed `published`, is dropped
    // exactly as an out-of-snapshot vote is: no receipt, no tally. The
    // verifier's half (V5) catches the complementary lie — a vote that
    // arrived late but claims an early `published`.
    //
    // Compared as instants, never as strings: the deadline is caller-supplied
    // and `2026-02-11T06:00:00Z` and `…06:00:00.000Z` are the same moment that
    // string comparison orders differently ('.' < 'Z'), while a negative UTC
    // offset sorts before 'Z' and is chronologically later. The verifier reads
    // this same field through `instant_millis` for exactly that reason, and a
    // writer that ordered it differently would disagree with its own replay.
    if (pastDeadline(this.now(), row.deadline)) return;

    // ADR-0020 W1/V1: a vote carrying every L1 field is a tuple, in any
    // round; an `afp:level: 1` round REQUIRES one — a vote missing
    // phase/seqNo there is malformed and dropped, same lane as every other
    // rejection above (no receipt, no tally).
    const meta = this.roundMetaOf(round);
    const tuple = voteTupleOf(activity);
    if (meta?.level === 1 && !tuple) return;

    const digest = digestOf(activity);
    const value = String(object.value ?? "");
    // Keyed by phase, not just by voter: `(actor, round, phase, seqNo)` is the
    // ballot identity ADR-0020 Decision 2 convicts on, so the prior vote a
    // duplicate is judged against must be the prior vote *of that phase*. A
    // per-voter key would let a phase change evict the only copy of the
    // earlier phase's vote and take its equivocation with it.
    const voteActKey = tuple ? `${round}:${actor}:${tuple.phase}` : `${round}:${actor}`;

    if (tuple) {
      // Tuple-grain dedupe (Decision 2, W2), beside the existing id-grain
      // dedupe in `receive()`: an exact tuple already seen decides between a
      // benign state-loss duplicate and a conviction.
      const priorActivity = this.voteActivities.get(voteActKey)?.getState()?.value;
      const priorTuple = priorActivity ? voteTupleOf(priorActivity) : null;
      if (priorTuple && priorTuple.seqNo === tuple.seqNo) {
        if (digestOf(priorActivity!) === digest) return; // identical redelivery
        if (convicts(priorActivity!, activity)) {
          this.publishEquivocationAndZero(row, round, actor, priorActivity!, activity);
        }
        // Otherwise a state-loss duplicate agreeing in value and
        // afp:proposalHash — first-seen wins, dropped without a trace beyond
        // what is already on record.
        return;
      }

      // Supersede-by-higher-seqNo: a later seqNo from the same (actor, phase)
      // replaces the counted ballot; a same-or-lower one is dropped.
      if (priorTuple && tuple.seqNo < priorTuple.seqNo) return;

      // One counted ballot per voter (`hub_vote_receipts`' own primary key),
      // so a vote from an earlier phase must never displace a later one: a
      // stale or replayed `prepare` arriving after a `commit` is dropped
      // rather than overwriting the ballot that supersedes it. Its tuple
      // still lands in the per-phase register above, so an equivocation on
      // the earlier phase is still convictable.
      const counted = countedVoteTuple(this.db, round, actor);
      if (counted && PHASE_ORDER[tuple.phase] < PHASE_ORDER[counted.phase]) {
        this.rememberVoteActivity(voteActKey, actor, activity);
        return;
      }
    }

    this.crdt.apply(
      { hub: this.hubId, crdtId: `receipts:${round}`, crdtType: "G_SET", delta: { adds: [{ key: actor, value: digest }] } },
      actor,
      this.now(),
      String(activity.id),
    );
    saveVoteReceipt(this.db, round, actor, digest, value, tuple?.phase, tuple?.seqNo);

    if (tuple) this.rememberVoteActivity(voteActKey, actor, activity);
  }

  /**
   * ADR-0020 W2: keep the full signed vote activity for `(round, actor,
   * phase)` — the proof material `hub_vote_receipts` cannot supply, since it
   * stores only a digest. Applied to the register already held for the key
   * rather than replacing it, so an out-of-order delivery resolves by LWW
   * like every other register in this hub.
   */
  private rememberVoteActivity(
    voteActKey: string,
    actor: string,
    activity: { [key: string]: JsonValue },
  ): void {
    const delta = { value: activity, timestamp: this.now().getTime(), nodeId: this.actorId };
    const register = this.voteActivities.get(voteActKey) ?? new LWWRegister<{ [key: string]: JsonValue }>();
    register.apply(delta);
    this.voteActivities.set(voteActKey, register);
    this.crdt.apply(
      { hub: this.hubId, crdtId: `voteact:${voteActKey}`, crdtType: "LWW_REGISTER", delta },
      actor,
      this.now(),
      String(activity.id),
    );
  }

  /** `roundMeta.get(round)`'s current value, or `null` for an L0/unknown round. */
  private roundMetaOf(round: string): RoundMeta | null {
    return this.roundMeta.get(round)?.getState()?.value ?? null;
  }

  /**
   * ADR-0020 Decision 1: the receiver-side half of zeroing — record a
   * conviction against `actor` in `round` and stop here; the tally exclusion
   * (`closeRound`/`doomed`) and `successor()` both read `isZeroedFor`
   * forward from whatever round a conviction first lands in.
   */
  private convictActor(round: string, actor: string, proofDigest: string): void {
    recordConviction(this.db, round, actor, proofDigest);
  }

  /**
   * ADR-0020 Decision 5: this hub itself discovered a conviction pair (the
   * vote-receive path, B) — assemble and publish the `afp:EquivocationProof`
   * (both full signed votes verbatim, Decision 1) before recording it, since
   * nobody else has announced this pair yet.
   */
  private publishEquivocationAndZero(
    row: RoundRow,
    round: string,
    actor: string,
    voteA: { [key: string]: JsonValue },
    voteB: { [key: string]: JsonValue },
  ): void {
    if (isConvicted(this.db, round, actor)) return; // already on record
    const proofId = `${this.actorId}/proofs/${round}/${actor}`;
    const entry = this.emit(row.voters, row.thread, "hub", (envelope) =>
      equivocationProof(envelope, { proofId, hub: this.actorId, round, votes: [voteA, voteB] }),
    );
    this.convictActor(round, actor, digestOf(entry.activity));
  }

  /**
   * `Announce{afp:EquivocationProof}` (ADR-0020 Decision 5, deliverable C): a
   * member may assemble and announce a proof itself. Both embedded votes are
   * verified here exactly as any inbound activity would be — a proof is
   * trusted for nothing on say-so alone — and `convicts()` is recomputed,
   * never taken on faith. A proof failing any leg is rejected and logged; a
   * valid one is recorded without a second announcement (this one already is
   * the record).
   */
  private onEquivocationProofAnnounce(activity: { [key: string]: JsonValue }): void {
    const object = activity.object as Record<string, JsonValue>;
    const round = String(object["afp:round"] ?? "");
    const votes = object["afp:votes"];
    const reject = (reason: string) =>
      logAdmission(this.db, this.now().toISOString(), round, String(activity.actor ?? ""), "rejected", reason);

    if (!Array.isArray(votes) || votes.length !== 2) {
      return reject("afp:EquivocationProof without exactly two afp:votes");
    }
    const [a, b] = votes as [{ [key: string]: JsonValue }, { [key: string]: JsonValue }];

    const va = this.verifySignature(a);
    if (!va.ok) return reject(`embedded vote fails signature verification: ${va.reason}`);
    const vb = this.verifySignature(b);
    if (!vb.ok) return reject(`embedded vote fails signature verification: ${vb.reason}`);

    if (!convicts(a, b)) return reject("embedded votes do not convict (ADR-0020 W2)");

    // The proof's own `afp:round` must be the round the pair was cast in: a
    // genuine pair from one round, announced under another round's name,
    // would otherwise record a conviction — and, being forward-scoped, a
    // zeroing — in a round the voter never equivocated in.
    const voteRound = String((a.object as Record<string, JsonValue>)["afp:round"] ?? "");
    if (voteRound !== round) {
      return reject(`afp:EquivocationProof names round ${round}, but its votes were cast in ${voteRound}`);
    }

    const actor = String(a.actor ?? "");
    const row = loadRound(this.db, round);
    if (!row || !row.voters.includes(actor)) {
      return reject(`round ${round} unknown, or ${actor} is outside its pinned snapshot`);
    }

    if (isConvicted(this.db, round, actor)) return; // already on record — nothing new
    this.convictActor(round, actor, digestOf(activity));
  }

  /**
   * ADR-0020 Decision 1/4: has a conviction landed in `round` or any round
   * created no later than it, in this hub? Zeroing is forward-scoped only —
   * a closed round's DecisionRecord is signed history, never re-tallied — so
   * this is ordered by `hub_rounds.created_at`, the only stable order two
   * round ids carry relative to each other.
   */
  private isZeroedFor(round: string, actor: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM hub_convictions c
           JOIN hub_rounds cr ON cr.round_id = c.round_id
           JOIN hub_rounds tr ON tr.round_id = ?
          WHERE c.actor = ? AND cr.hub_id = tr.hub_id AND cr.created_at <= tr.created_at
          LIMIT 1`,
      )
      .get(round, actor) as unknown;
    return row !== undefined;
  }

  /**
   * ADR-0020 Decision 4: `attainable(option) = tally[option] + Σ weight(v)`
   * over pinned voters with no counted vote and no conviction; `doomed` holds
   * when every option's attainable weight is under the bar. `false` when the
   * round pins no `afp:quorumRule` — doom is meaningless without a bar.
   */
  private doomed(row: RoundRow, votes: readonly { actor: string; value: string; digest: string }[]): boolean {
    if (!row.quorumRule || row.options.length === 0) return false;
    const bar = thresholdOf(row.quorumRule, row.weights);
    if (bar === null) return false;
    const tally = this.tally(row, votes);
    const heard = new Set(votes.map((vote) => vote.actor));
    let reachable = 0;
    for (const voter of row.voters) {
      if (heard.has(voter)) continue;
      if (this.isZeroedFor(row.roundId, voter)) continue;
      reachable += row.weights[voter] ?? 0;
    }
    return row.options.every((option) => (tally[option] ?? 0) + reachable < bar);
  }

  /** Recompute `doomed` for an open round exactly as `demandClose` gates on it — WP-4's G5/G6 hook. */
  isDoomed(round: string): boolean {
    const row = loadRound(this.db, round);
    if (!row || row.status !== "open") return false;
    const votes = this.roundVotes(round).filter((vote) => !this.isZeroedFor(round, vote.actor));
    return this.doomed(row, votes);
  }

  /**
   * ADR-0020 Decision 3, W2: the pinned, recomputable successor — the first
   * survivor of `stalled.voters`, rotated to start after the stalled round's
   * proposer, skipping a voter convicted in that round or recorded silent in
   * its DecisionRecord. `null` when no sanctioned succession remains.
   */
  private successor(stalledRoundId: string, stalledRow: RoundRow, stalledMeta: RoundMeta): string | null {
    const order = stalledRow.voters;
    if (order.length === 0) return null;
    const proposerIdx = order.indexOf(stalledMeta.proposalActor);
    const start = proposerIdx === -1 ? 0 : proposerIdx + 1;
    const convicted = new Set(convictionsFor(this.db, stalledRoundId).map((c) => c.actor));
    // "Recorded silent" is derived exactly as `finishClose` derives the
    // DecisionRecord's `afp:uncounted` — heard minus declines over the pinned
    // voters — which is what the verifier's `successor()` reads back off that
    // record. The two must agree: a closed round takes no further votes
    // (`onVote` gates on `status === "open"`), so this live view and the
    // signed one are the same set.
    const heard = new Set(this.roundVotes(stalledRoundId).map((vote) => vote.actor));
    const declined = new Set(roundDeclinesFor(this.db, stalledRoundId));
    for (let i = 0; i < order.length; i++) {
      const candidate = order[(start + i) % order.length];
      if (convicted.has(candidate)) continue;
      const silent = !heard.has(candidate) && !declined.has(candidate);
      if (silent) continue;
      return candidate;
    }
    return null;
  }

  /** Public wrapper over `successor()` — the round-open validation, and WP-4's G7/G8 hook. */
  successorOf(stalledRoundId: string): string | null {
    const stalledRow = loadRound(this.db, stalledRoundId);
    const meta = this.roundMetaOf(stalledRoundId);
    if (!stalledRow || !meta?.successionRule) return null;
    return this.successor(stalledRoundId, stalledRow, meta);
  }

  /**
   * ADR-0018 Decision 3: a departure from a binding decision — the recorded
   * act of an operator that lost the vote and refuses to be bound. Restricted
   * exactly as V8/V9 (W5) check it on replay: only a voter this round itself
   * pinned may depart it, and only a round whose proposal declared
   * `afp:binding: "joint"` has anything to depart from — an advisory round's
   * dissent needs no such record, because nothing bound the loser in the
   * first place.
   */
  private onDeparture(activity: { [key: string]: JsonValue }): void {
    const object = activity.object as Record<string, JsonValue>;
    const round = String(object["afp:round"] ?? "");
    const row = loadRound(this.db, round);
    if (!row || row.binding !== "joint") return;

    const actor = String(activity.actor ?? "");
    if (!row.voters.includes(actor)) return; // outside this round's pinned electorate

    saveDeparture(this.db, round, actor, digestOf(activity));
  }

  /**
   * `Update{afp:Asset}` (ADR-0004 Decision 2): any member may register;
   * `attributedTo` names the steward and the activity's signature is the
   * accountability. A second Update naming the same (id, version) with a
   * different digest is rejected — an asset that mutated under its own
   * version is a claim nothing can resolve. A new version is a new entry.
   */
  private onUpdateAsset(activity: { [key: string]: JsonValue }): void {
    if (this.status !== "active") return;
    const object = activity.object as { [key: string]: JsonValue };
    const assetId = String(object.id ?? "");
    const version = String(object["afp:version"] ?? "");
    const digest = String(object["afp:digest"] ?? "");
    const actor = String(activity.actor ?? "");
    const reject = (reason: string) =>
      logAdmission(this.db, this.now().toISOString(), assetId, actor, "rejected", reason);

    if (!assetId || !version || !digest) return reject("afp:Asset without id, afp:version or afp:digest");
    if (this.roleOf(actor) !== "member") {
      return reject(`asset registration from role ${this.roleOf(actor) ?? "non-enrolled"} — only members register assets (ADR-0004)`);
    }

    const key = `${assetId}@${version}`;
    const existing = this.assets.get(key);
    if (existing && String(existing["afp:digest"]) !== digest) {
      return reject(
        `asset ${assetId} version ${version} is immutable once registered (held digest ${String(existing["afp:digest"])}, offered ${digest})`,
      );
    }

    const delta = {
      key,
      value: { ...object },
      timestamp: instantMillis(activity.published),
      nodeId: digestOf(activity),
    };
    this.assets.apply(delta);
    this.crdt.apply(
      {
        hub: this.hubId,
        crdtId: "assets",
        crdtType: "OR_MAP",
        delta: { key, fieldType: "LWW_REGISTER", value: delta.value, timestamp: delta.timestamp, nodeId: delta.nodeId },
      },
      actor,
      this.now(),
      String(activity.id),
    );
  }

  /**
   * `Update{afp:CRDTDelta}` (ADR-0016 Decision 3, second population): an
   * application-defined store mutated by its own explicit signed activity,
   * exactly as 02's worked example shows. Protocol stores are refused —
   * they are moved only by their governing activities, or membership would
   * gain a second writer beside `afp:Enroll`. The `app:` prefix is 02's own
   * collision rule, enforced rather than advised.
   */
  private onCrdtDelta(activity: { [key: string]: JsonValue }): void {
    if (this.status !== "active") return;
    const object = activity.object as { [key: string]: JsonValue };
    if (String(object["afp:hub"] ?? "") !== this.hubIdentity) return;
    const crdtId = String(object["afp:crdtId"] ?? "");
    if (!crdtId.startsWith("app:")) return; // protocol stores have exactly one writer each
    const crdtType = String(object["afp:crdtType"] ?? "");
    if (!["G_SET", "LWW_REGISTER", "OR_SET", "OR_MAP"].includes(crdtType)) return;
    const actor = String(activity.actor ?? "");
    // Authority, in the handler where it belongs (Decision 2): an observer
    // reads at hub visibility and never writes shared state.
    const role = this.roleOf(actor);
    if (role === null || role === "observer") return;
    this.crdt.apply(
      { hub: this.hubId, crdtId, crdtType: crdtType as never, delta: object["afp:delta"] as never },
      actor,
      this.now(),
      String(activity.id),
    );
  }

  /**
   * `Offer{afp:Digest}` (ADR-0016 Decision 4): a replica says what it holds;
   * this side answers with the signed activities past its counts. The reply
   * is an ordinary emitted activity — signed by the hub key, which 02
   * sanctions for exactly this (message forwarding, state attestation) and
   * nothing more. An id the record cannot resolve is skipped, never invented:
   * the pointer table is derivable from the record, not the other way round.
   */
  private onDigestOffer(activity: { [key: string]: JsonValue }): void {
    const object = activity.object as { [key: string]: JsonValue };
    if (String(object["afp:hub"] ?? "") !== this.hubIdentity) return;
    const remote = (object["afp:versionVector"] ?? {}) as Record<string, Record<string, number>>;
    const missing = this.crdt
      .activitiesBehind(this.hubId, remote)
      .map((id) => this.resolveActivity(id))
      .filter((a): a is { [key: string]: JsonValue } => a !== null);
    this.emit([String(activity.actor ?? "")], String(activity.context ?? `${this.origin}/threads/anti-entropy`), "hub", (envelope) =>
      acceptStateDeltas(envelope, { hub: this.hubIdentity, inReplyTo: String(activity.id), activities: missing }),
    );
  }

  /**
   * `Accept{afp:StateDeltas}`: the pulled activities, dispatched through the
   * same `receive` everything crosses — each one signature-verified against
   * its author's document and re-derived into local state. Replay is
   * re-merge (ADR-0002's phrase, in the built sense): convergence never
   * learns a second way to change state.
   */
  private async onStateDeltas(activity: { [key: string]: JsonValue }): Promise<void> {
    const object = activity.object as { [key: string]: JsonValue };
    if (String(object["afp:hub"] ?? "") !== this.hubIdentity) return;
    const carried = Array.isArray(object["afp:activities"]) ? (object["afp:activities"] as JsonValue[]) : [];
    for (const entry of carried) {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        await this.receive(entry as { [key: string]: JsonValue });
      }
    }
  }

  /** Per-store, per-origin provenance counts — the digest's payload (ADR-0016 Decision 4). */
  syncVector(): Record<string, Record<string, number>> {
    return this.crdt.syncVector(this.hubId);
  }

  /** Open one anti-entropy round toward `target`: an emitted `Offer{afp:Digest}` over this replica's counts. */
  offerSync(target: string, thread = `${this.origin}/threads/anti-entropy`): OutboxEntry {
    return this.emit([target], thread, "hub", (envelope) =>
      offerDigest(envelope, { hub: this.hubIdentity, versionVectors: this.syncVector() }),
    );
  }

  /** The registered record for one (assetId, version), or null. */
  assetOf(assetId: string, version: string): { [key: string]: JsonValue } | null {
    return this.assets.get(`${assetId}@${version}`);
  }

  /** The whole registry — "assetId@version" → asset record. */
  assetRegistry(): Map<string, { [key: string]: JsonValue }> {
    return this.assets.getState();
  }

  /** Per-actor delta counts for one hub-scoped store — ADR-0002 Decision 5's P5 seam. */
  versionVector(crdtId: string): Record<string, number> {
    return this.crdt.versionVector(this.hubId, crdtId);
  }

  // ----------------------------------------------------------------- outbound

  emit(to: readonly string[], thread: string, visibility: Visibility, build: (envelope: Envelope) => { [key: string]: JsonValue }): OutboxEntry {
    const now = this.now().toISOString();
    const seq = this.outbox.nextSeq(this.actorId);
    const envelope: Envelope = {
      activityId: `${this.actorId}/activities/${String(seq).padStart(4, "0")}`,
      actor: this.actorId,
      to,
      thread,
      visibility,
      published: now,
      prevActivity: this.outbox.headDigest(this.actorId),
    };

    const activity = build(envelope);
    const signed = attachProof(activity, {
      privateKey: this.key.privateKey,
      verificationMethod: this.key.keyId,
      created: now,
    }) as unknown as { [key: string]: JsonValue };

    const entry = this.outbox.append(signed);
    for (const target of to) this.queue.enqueue(target, signed, this.now());
    return entry;
  }

  /**
   * Open an L0 round: pin the membership snapshot, the explicit voter list,
   * and liveness-gated uniform weights (ADR-0002 Decision 3) into the
   * proposal itself so tally recomputation never depends on live state.
   */
  proposeRound(options: {
    round: string;
    thread: string;
    question: string;
    options: readonly string[];
    voters?: readonly string[];
    /** ADR-0018 Decision 1: an RFC 3339 instant after which a vote is dropped, not tallied. */
    deadline?: string;
    /** ADR-0018 Decision 1: the bar the outcome must clear — absent means today's plain argmax. */
    quorumRule?: QuorumRule;
    /** ADR-0018 Decision 3: `"joint"` opens the round to `afp:Departure`; absent means advisory. */
    binding?: "joint";
    /**
     * ADR-0019 W3: the round's own rulebook — `afp:actionPolicy` keyed by
     * outcome (including `afp:no-decision`) and `afp:irrevocableActions`.
     * `afp:answerSufficiency`/`afp:synthesizer` mean nothing for a round (W3)
     * and are refused below rather than emitted.
     */
    pins?: TaskPins;
    /** ADR-0020 Decision 1/W1: pins the round grammar. Absent means L0 — today's behaviour, byte-identical. */
    level?: 1;
    /** ADR-0020 Decision 3/W1: optional, recomputable succession rule. Absent means no sanctioned succession. */
    successionRule?: SuccessionRule;
    /**
     * ADR-0020 Decision 3: this round's own id, as a successor claiming a
     * stalled predecessor — not the digest 03/W1 pins (`afp:supersedesRound`
     * is derived here, from the stalled round's own `proposalHash`). The
     * stalled round must be closed and must have pinned a `successionRule`,
     * and the actor this round's `Offer` will be signed by must be its
     * entitled `successor()`.
     */
    supersedesRoundId?: string;
  }): OutboxEntry {
    if (this.status !== "active") {
      throw new Error(`hub is ${this.status} — no new rounds (afp:${this.status === "frozen" ? "Freeze" : "Archive"})`);
    }
    // ADR-0018 W1: the reserved outcome names no proposal's option — a
    // proposal that lists it is rejected at propose time, not merely at replay.
    if (options.options.includes(NO_DECISION)) {
      throw new Error(`afp:options may not contain the reserved value ${NO_DECISION} (ADR-0018)`);
    }
    // ADR-0019 W3: validated before signing, refusing rather than emitting a
    // pin nothing will ever read or a policy silent on one of the round's own
    // outcomes.
    if (options.pins?.answerSufficiency || options.pins?.synthesizer) {
      throw new Error("afp:answerSufficiency and afp:synthesizer pin nothing for a round (ADR-0019)");
    }
    if (options.pins?.actionPolicy) {
      validateProposalActionPolicy(options.pins.actionPolicy, options.options);
    }
    if (options.pins?.irrevocableActions) {
      if (!options.pins.actionPolicy) {
        throw new Error("afp:irrevocableActions requires a pinned afp:actionPolicy (ADR-0011)");
      }
      validateIrrevocableActions(options.pins.actionPolicy, options.pins.irrevocableActions);
    }
    // Snapshot-pinning (ADR-0004 Decision 1): only member-role agents are ever
    // pinned into afp:voters — a requester or observer can never appear in a
    // quorum snapshot, and a verifier can prove it from the Enroll trail.
    const voters = [...(options.voters ?? this.members())].filter(
      (agent) => this.isLive(agent) && this.roleOf(agent) === "member",
    );
    // One operator, one weight (ADR-0005 Decision 1): each seated instance
    // carries the same total, divided among its pinned voters. At a single
    // instance this reduces to the liveness-gated uniform weight of 1 that
    // ADR-0002 Decision 3 pinned, so the solo profile is unchanged. The
    // grouping key is the *effective* operator (ADR-0005 amendment): a
    // declared change of control folds two instances' seats into one weight
    // bucket at the moment a snapshot is pinned — never retroactively, since
    // this is resolved fresh on every proposeRound call.
    const weights = voterWeights(
      voters.map((agent) => ({ agent, instance: this.effectiveOperatorOf(this.instanceOf(agent) ?? agent) })),
    );

    // ADR-0018 W2: never sign a rule nobody can recompute — an unknown form
    // fails here, at propose time, rather than surfacing only when the round
    // closes or a verifier tries to recompute the bar it cannot resolve.
    if (options.quorumRule && thresholdOf(options.quorumRule, weights) === null) {
      throw new Error(`afp:quorumRule names an unknown form (ADR-0018): ${JSON.stringify(options.quorumRule)}`);
    }

    // ADR-0020 Decision 3: a successor round is validated before it is ever
    // signed — `afp:supersedesRound` pins the stalled proposal's digest, and
    // replay must be able to recompute the same successor from the stalled
    // round's own record alone (successor() mirrors this exactly). "The
    // proposing actor" is checked against the actor this round's own `Offer`
    // is about to be signed by — today that is always `this.actorId` (the
    // hub is ADR-0014's sequencing authority; no member-signed proposal path
    // exists yet), which makes this trivially satisfiable in-process, but the
    // comparison is kept so a future member-signed path is checked here
    // rather than only by the verifier reading the wire.
    let supersedesRound: string | undefined;
    if (options.supersedesRoundId) {
      const stalledRow = loadRound(this.db, options.supersedesRoundId);
      if (!stalledRow || stalledRow.status !== "closed") {
        throw new Error(
          `afp:supersedesRound names round ${options.supersedesRoundId}, which is not closed/stalled (ADR-0020)`,
        );
      }
      const stalledMeta = this.roundMetaOf(options.supersedesRoundId);
      if (!stalledMeta?.successionRule) {
        throw new Error(
          `afp:supersedesRound requires the stalled round to have pinned afp:successionRule (ADR-0020 W1)`,
        );
      }
      const entitled = this.successor(options.supersedesRoundId, stalledRow, stalledMeta);
      if (!entitled || entitled !== this.actorId) {
        throw new Error(
          `afp:supersedesRound: ${this.actorId} is not the entitled successor of ${options.supersedesRoundId} (ADR-0020 W2)`,
        );
      }
      supersedesRound = stalledRow.proposalHash;
    }

    const quorumSnapshot = digestOf([...voters].sort());
    const proposalId = `${this.actorId}/proposals/${options.round}`;

    const entry = this.emit(voters, options.thread, "hub", (envelope) =>
      offerProposal(envelope, {
        proposalId,
        round: options.round,
        hub: this.actorId,
        question: options.question,
        options: options.options,
        quorumSnapshot,
        voters,
        weights,
        deadline: options.deadline,
        quorumRule: options.quorumRule,
        binding: options.binding,
        pins: options.pins,
        level: options.level,
        successionRule: options.successionRule,
        supersedesRound,
      }),
    );

    const row: RoundRow = {
      roundId: options.round,
      hubId: this.hubId,
      proposalId,
      thread: options.thread,
      options: [...options.options],
      voters,
      weights,
      quorumSnapshot,
      proposalHash: digestOf(entry.activity),
      status: "open",
      deadline: options.deadline ?? null,
      quorumRule: options.quorumRule ?? null,
      binding: options.binding ?? null,
    };
    saveRound(this.db, row, this.now().toISOString());

    // ADR-0020 W1: recorded only for an L1 round — an L0 caller supplies none
    // of `level`/`successionRule`/`supersedesRoundId`, so nothing is written
    // and `roundMetaOf` reads back `null`, exactly as before this decision.
    if (options.level || options.successionRule || supersedesRound) {
      const meta: RoundMeta = {
        level: options.level,
        successionRule: options.successionRule,
        supersedesRound,
        proposalActor: String(entry.activity.actor ?? this.actorId),
      };
      const delta = { value: meta, timestamp: this.now().getTime(), nodeId: this.actorId };
      const register = new LWWRegister<RoundMeta>();
      register.apply(delta);
      this.roundMeta.set(options.round, register);
      this.crdt.apply(
        { hub: this.hubId, crdtId: `roundmeta:${options.round}`, crdtType: "LWW_REGISTER", delta },
        this.actorId,
        this.now(),
        String(entry.activity.id),
      );
    }

    return entry;
  }

  /**
   * Recompute the weight tally from the round's counted votes, publish the
   * closing `Create{afp:DecisionRecord}`, and mark the round closed.
   *
   * `afp:countedVotes` binds the outcome to its exact evidence set (04 §
   * Decision records) — every hash here resolves to a `Vote` in some voter's
   * outbox, and a voter absent from `afp:countedVotes` never had its ballot
   * counted, which is checkable from this record alone.
   */
  /**
   * `priorQuorumSnapshot` (ADR-0011 Decision 3): pass the ratifying
   * DecisionRecord's `afp:quorumSnapshot` when this round ratifies a Synthesis
   * that supersedes one this hub already ratified. The hub never discovers
   * this on its own — the caller, who knows which answer is being superseded,
   * supplies it; not persisted in `hub_rounds`, since it is an input to this
   * one closing call rather than state the round needs to survive a restart.
   */
  closeRound(round: string, options?: { priorQuorumSnapshot?: string }): OutboxEntry {
    return this.finishClose(round, { priorQuorumSnapshot: options?.priorQuorumSnapshot });
  }

  /**
   * ADR-0020 Decision 4: an early close, right on demand — `no-decision`
   * with reason `quorum-impossible`, granted only when `doomed()` holds at
   * the moment of the call. The normal deadline close (`expired`) is
   * untouched and remains valid even when `doomed` also held: early close is
   * a right, never a duty, until this is called.
   */
  demandClose(round: string): OutboxEntry {
    if (this.status === "archived") throw new Error("hub is archived — terminal, read-only (afp:Archive)");
    const row = loadRound(this.db, round);
    if (!row) throw new Error(`unknown round ${round}`);
    if (row.status !== "open") throw new Error(`round ${round} is not open`);
    const votes = this.roundVotes(round).filter((vote) => !this.isZeroedFor(round, vote.actor));
    if (!this.doomed(row, votes)) {
      throw new Error(`round ${round} is not provably doomed — demandClose refused (ADR-0020 Decision 4)`);
    }
    return this.finishClose(round, { forcedNoDecisionReason: "quorum-impossible" });
  }

  /** The shared close body behind `closeRound` and `demandClose`. */
  private finishClose(
    round: string,
    options: { priorQuorumSnapshot?: string; forcedNoDecisionReason?: "quorum-impossible" },
  ): OutboxEntry {
    if (this.status === "archived") throw new Error("hub is archived — terminal, read-only (afp:Archive)");
    const row = loadRound(this.db, round);
    if (!row) throw new Error(`unknown round ${round}`);

    // ADR-0020 W2/V3: a convicted voter's ballot never reaches the tally or
    // `afp:countedVotes`, though its pinned weight still counts toward the
    // bar's denominator (row.weights, untouched by zeroing — Decision 4).
    const votes = this.roundVotes(round).filter((vote) => !this.isZeroedFor(round, vote.actor));
    const tally = this.tally(row, votes);
    // Options in declared order, then abstain; first wins ties — Array#sort is
    // stable, and `tally`'s own keys are built in that order (this.tally),
    // so the plain argmax already reads the entries in the ADR-0018 order.
    let outcome = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "abstain";
    const countedVotes = votes.map((vote) => vote.digest);

    let noDecisionReason: "expired" | "threshold-not-met" | "quorum-impossible" | undefined;
    if (options.forcedNoDecisionReason) {
      // ADR-0020 Decision 4: `demandClose` already recomputed `doomed` before
      // calling this — trusted here, not re-derived, so the check lives in
      // exactly one place.
      outcome = NO_DECISION;
      noDecisionReason = options.forcedNoDecisionReason;
    } else if (row.quorumRule) {
      // ADR-0018 W3: with a quorum rule pinned, the plain argmax is not yet the
      // outcome — it must also clear the bar, and `abstain` can never win under
      // a rule (it is a residual bucket, not an option). A round with no rule
      // takes none of this branch, so its signed bytes are unchanged to the byte.
      const bar = thresholdOf(row.quorumRule, row.weights);
      if (bar === null) throw new Error(`round ${round} pins an unresolvable afp:quorumRule (ADR-0018)`);
      if (outcome === "abstain" || (tally[outcome] ?? 0) < bar) {
        // Which kind of failure this was is decided by the close instant, not
        // by guesswork — and compared as instants for the reason `onVote`'s
        // deadline gate spells out.
        noDecisionReason = pastDeadline(this.now(), row.deadline) ? "expired" : "threshold-not-met";
        outcome = NO_DECISION;
      }
    }

    // ADR-0014 Decision 4: account for every pinned voter the tally did not
    // hear from, and say which kind of not-hearing it was. A recorded Reject
    // of the proposal is "declined" — participation without assent; nothing
    // at all is "silent", which during a partition is not an abstention and
    // must not read as one.
    const heard = new Set(votes.map((vote) => vote.actor));
    const declined = new Set(roundDeclinesFor(this.db, round));
    const uncounted = row.voters
      .filter((voter) => !heard.has(voter))
      .map((agent) => ({ agent, status: (declined.has(agent) ? "declined" : "silent") as "declined" | "silent" }));

    const entry = this.emit(row.voters, row.thread, "hub", (envelope) =>
      decisionRecord(envelope, {
        recordId: `${this.actorId}/rounds/${round}/decision`,
        hub: this.actorId,
        round,
        outcome,
        quorumSnapshot: row.quorumSnapshot,
        countedVotes,
        weightTally: tally,
        priorQuorumSnapshot: options.priorQuorumSnapshot,
        uncounted,
        noDecisionReason,
      }),
    );

    row.status = "closed";
    saveRound(this.db, row, this.now().toISOString());
    return entry;
  }

  /** Recompute the tally the way any third-party verifier must: from the counted votes alone. */
  tally(row: RoundRow, votes: readonly { actor: string; value: string; digest: string }[]): Record<string, number> {
    const totals: Record<string, number> = {};
    for (const option of row.options) totals[option] = 0;
    totals.abstain = 0;

    const byActor = new Map(votes.map((vote) => [vote.actor, vote]));
    for (const voter of row.voters) {
      const weight = row.weights[voter] ?? 0;
      const vote = byActor.get(voter);
      const value = vote && row.options.includes(vote.value) ? vote.value : "abstain";
      totals[value] = (totals[value] ?? 0) + weight;
    }
    return totals;
  }

  /** Read-only view for tests/verifiers wanting to recompute independently. */
  roundVotes(round: string): { actor: string; value: string; digest: string }[] {
    return voteReceiptsFor(this.db, round).map(({ actor, voteDigest, value }) => ({ actor, value, digest: voteDigest }));
  }

  roundVoters(round: string): string[] {
    return loadRound(this.db, round)?.voters ?? [];
  }

  /** Read-only view mirroring `roundVotes` — every recorded departure from this round's binding decision. */
  roundDepartures(round: string): { actor: string; digest: string }[] {
    return departuresFor(this.db, round);
  }

  /**
   * Read-only view in the same family — every conviction on record for a
   * round (ADR-0020 Decision 1's zeroing table), with the proof that carries
   * it. What `closeRound` excludes from the tally and `successor()` skips.
   */
  convictionsIn(round: string): { actor: string; proofDigest: string }[] {
    return convictionsFor(this.db, round);
  }

  /**
   * Verify one published activity's own integrity proof the way any receiver
   * does — exposed so a caller holding an `afp:EquivocationProof` can check
   * its two embedded votes standalone, from the proof's contents alone,
   * without being handed a verdict by the hub that assembled it (ADR-0020
   * Decision 1: the proof's defining property is that it convinces someone
   * holding nothing else).
   */
  verifyPublished(activity: { [key: string]: JsonValue }): { ok: true } | { ok: false; reason: string } {
    return this.verifySignature(activity);
  }

  /** `afp:Freeze` — suspend new work; existing rounds may still close. */
  freeze(reason: string): OutboxEntry {
    this.status = "frozen";
    return this.emit([], `${this.origin}/threads/hub-lifecycle`, "hub", (envelope) => freezeHub(envelope, this.actorId, reason));
  }

  /** `afp:Archive` — terminal, read-only close with canonical CRDT state hashes (07). */
  archive(reason: string): OutboxEntry {
    this.status = "archived";
    // ADR-0015 Decision 3: the converged state enters the record here, once,
    // at the moment it stops changing — beside the canonical hashes computed
    // from the very same values, so replay can recompute one from the other.
    // Before this, the case file held every operator's activities and not the
    // thing they had converged on; state that changes stays a projection, and
    // state that has stopped changing becomes one signed activity.
    const state: Record<string, JsonValue> = {
      membership: [...this.membership.getState()].sort(),
      capabilities: [...this.capabilities.getState().entries()].map(([agent, caps]) => [agent, [...caps].sort()]) as JsonValue,
    };
    const stateHashes: Record<string, string> = Object.fromEntries(
      Object.entries(state).map(([key, value]) => [key, digestOf(value as never)]),
    );
    return this.emit([], `${this.origin}/threads/hub-lifecycle`, "hub", (envelope) =>
      archiveHub(envelope, { hub: this.actorId, reason, stateHashes, state }),
    );
  }

  /** Instance actors with a live seat (ADR-0017 Decision 4, R5) — this hub's public `followers`. */
  followers(): string[] {
    return liveSeats(this.db);
  }

  async run(transport: Transport): Promise<void> {
    for (let pass = 0; pass < 8; pass++) {
      const report = await this.queue.drain(transport, this.now());
      if (report.delivered === 0 && report.deadLettered.length === 0) break;
    }
  }
}
