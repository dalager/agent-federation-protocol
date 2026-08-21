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
import { keyHistory, loadOrCreateKeyPair, publicKeyFromMultibase, type KeyHistoryEntry, type KeyPair } from "../crypto/keys.ts";
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
  freezeHub,
  offerDigest,
  offerProposal,
  type Envelope,
  type HubRole,
  type Visibility,
} from "./activities.ts";
import { LWWRegister, ORMap, ORMapLWW, ORSet } from "./crdtAdapter.ts";
import { voterWeights } from "./weights.ts";
import { CRDTStore, type LWWState, type ORMapState, type ORSetState } from "../crdt/index.ts";
import { ensureHubSchema, loadRound, roundByProposal, roundDeclinesFor, saveRound, saveRoundDecline, saveVoteReceipt, voteReceiptsFor, type RoundRow } from "./store.ts";
import { Allocator } from "../allocation/allocator.ts";
import { logAdmission } from "../allocation/store.ts";

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
}

interface LivenessValue {
  status: "live" | "suspected";
  load: number;
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
  private readonly fetchActor: HubDeps["fetchActor"];
  private readonly resolveActivity: (activityId: string) => { [key: string]: JsonValue } | null;
  private readonly now: () => Date;
  /** The hub actor sync traffic names: `replicaOf` when set, else self. */
  private readonly hubIdentity: string;

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

    ensureHubSchema(this.db);
    this.crdt = new CRDTStore(this.db);
    this.keyDir = deps.keyDir;
    this.key = loadOrCreateKeyPair(deps.keyDir, `hub-${deps.hubId}`, this.actorId);
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
    return hubActor(this.origin, this.hubId, this.key, this.instanceActorId);
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

    if (type === "afp:Enroll") return this.onEnroll(activity);
    if (type === "afp:Unenroll") return this.onUnenroll(activity);
    if (type === "Create" && objectType === "afp:Vote") return this.onVote(activity);
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
    // A requester reporting observed actuals onto its own thread — the write
    // that settlement on requester-reported actuals depends on (scenario 05).
    if (type === "Create" && objectType === "afp:Result") return this.allocation.onActualsReport(activity);
    // ADR-0004 Decision 2: asset registration rides an ordinary signed
    // Update{afp:Asset} — on the record, like enrollment, never a side channel.
    if (type === "Update" && objectType === "afp:Asset") return this.onUpdateAsset(activity);
    // Allocation (ADR-0003 Decision 1): commits, reveals, declines and award
    // Accepts route to the allocator beside the hub. Each handler ignores
    // activities that reference no open auction of ours.
    if (type === "afp:bidCommit") return this.allocation.onCommit(activity);
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

  private onUnenroll(activity: { [key: string]: JsonValue }): void {
    if (this.status !== "active") return;
    const agent = String(activity.object ?? "");
    if (!agent) return;
    const tags = this.membership.tagsFor(agent);
    for (const tag of tags) this.membership.apply({ op: "remove", value: agent, tag });
    this.crdt.apply(
      {
        hub: this.hubId,
        crdtId: "membership",
        crdtType: "OR_SET",
        delta: { adds: [], removes: [{ element: agent, tombstoneTags: tags }] },
      },
      String(activity.actor ?? ""),
      this.now(),
      String(activity.id),
    );
    this.liveness.delete(agent);
    this.roles.delete(agent);
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

    const digest = digestOf(activity);
    const value = String(object.value ?? "");

    this.crdt.apply(
      { hub: this.hubId, crdtId: `receipts:${round}`, crdtType: "G_SET", delta: { adds: [{ key: actor, value: digest }] } },
      actor,
      this.now(),
      String(activity.id),
    );
    saveVoteReceipt(this.db, round, actor, digest, value);
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
    this.emit([String(activity.actor ?? "")], String(activity.context ?? "urn:afp:thread:anti-entropy"), "hub", (envelope) =>
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
  offerSync(target: string, thread = "urn:afp:thread:anti-entropy"): OutboxEntry {
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
  }): OutboxEntry {
    if (this.status !== "active") {
      throw new Error(`hub is ${this.status} — no new rounds (afp:${this.status === "frozen" ? "Freeze" : "Archive"})`);
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
    // ADR-0002 Decision 3 pinned, so the solo profile is unchanged.
    const weights = voterWeights(voters.map((agent) => ({ agent, instance: this.instanceOf(agent) ?? agent })));

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
    };
    saveRound(this.db, row, this.now().toISOString());

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
    if (this.status === "archived") throw new Error("hub is archived — terminal, read-only (afp:Archive)");
    const row = loadRound(this.db, round);
    if (!row) throw new Error(`unknown round ${round}`);

    const votes = this.roundVotes(round);
    const tally = this.tally(row, votes);
    const outcome = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "abstain";
    const countedVotes = votes.map((vote) => vote.digest);

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
        priorQuorumSnapshot: options?.priorQuorumSnapshot,
        uncounted,
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

  /** `afp:Freeze` — suspend new work; existing rounds may still close. */
  freeze(reason: string): OutboxEntry {
    this.status = "frozen";
    return this.emit([], "urn:afp:thread:hub-lifecycle", "hub", (envelope) => freezeHub(envelope, this.actorId, reason));
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
    return this.emit([], "urn:afp:thread:hub-lifecycle", "hub", (envelope) =>
      archiveHub(envelope, { hub: this.actorId, reason, stateHashes, state }),
    );
  }

  async run(transport: Transport): Promise<void> {
    for (let pass = 0; pass < 8; pass++) {
      const report = await this.queue.drain(transport, this.now());
      if (report.delivered === 0 && report.deadLettered.length === 0) break;
    }
  }
}
