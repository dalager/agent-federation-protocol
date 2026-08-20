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
import { loadOrCreateKeyPair, publicKeyFromMultibase, type KeyPair } from "../crypto/keys.ts";
import { attachProof, digestOf, verifyProof } from "../crypto/proof.ts";
import { instantMillis } from "../crypto/time.ts";
import type { Db } from "../store/db.ts";
import { Outbox, type OutboxEntry } from "../store/outbox.ts";
import { DeliveryQueue, type Transport } from "../store/queue.ts";
import { hubActor, hubActorId } from "../ap/documents.ts";
import {
  archiveHub,
  decisionRecord,
  freezeHub,
  offerProposal,
  type Envelope,
  type HubRole,
  type Visibility,
} from "./activities.ts";
import { LWWRegister, ORMap, ORMapLWW, ORSet } from "./crdtAdapter.ts";
import { CRDTStore, type LWWState, type ORMapState, type ORSetState } from "../crdt/index.ts";
import { ensureHubSchema, loadRound, saveRound, saveVoteReceipt, voteReceiptsFor, type RoundRow } from "./store.ts";
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
}

interface LivenessValue {
  status: "live" | "suspected";
  load: number;
}

export class Hub {
  readonly hubId: string;
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
  private readonly now: () => Date;

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
    this.now = deps.now ?? (() => new Date());
    this.actorId = hubActorId(deps.origin, deps.hubId);

    ensureHubSchema(this.db);
    this.crdt = new CRDTStore(this.db);
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
    return hubActor(this.origin, this.hubId, this.key);
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
    if (type === "Reject") return this.allocation.onDecline(activity);
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
    const capabilities = Array.isArray(activity["afp:capabilities"])
      ? (activity["afp:capabilities"] as JsonValue[]).map(String)
      : [];

    this.membership.apply({ op: "add", value: agent, tag });
    this.crdt.apply(
      { hub: this.hubId, crdtId: "membership", crdtType: "OR_SET", delta: { adds: [{ element: agent, tag }], removes: [] } },
      origin,
      this.now(),
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
    );
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
    const weights: Record<string, number> = {};
    for (const voter of voters) weights[voter] = 1.0; // liveness-gated uniform weight

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
  closeRound(round: string): OutboxEntry {
    if (this.status === "archived") throw new Error("hub is archived — terminal, read-only (afp:Archive)");
    const row = loadRound(this.db, round);
    if (!row) throw new Error(`unknown round ${round}`);

    const votes = this.roundVotes(round);
    const tally = this.tally(row, votes);
    const outcome = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "abstain";
    const countedVotes = votes.map((vote) => vote.digest);

    const entry = this.emit(row.voters, row.thread, "hub", (envelope) =>
      decisionRecord(envelope, {
        recordId: `${this.actorId}/rounds/${round}/decision`,
        hub: this.actorId,
        round,
        outcome,
        quorumSnapshot: row.quorumSnapshot,
        countedVotes,
        weightTally: tally,
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
    const stateHashes: Record<string, string> = {
      membership: digestOf([...this.membership.getState()].sort()),
      capabilities: digestOf(
        [...this.capabilities.getState().entries()].map(([agent, caps]) => [agent, [...caps].sort()]),
      ),
    };
    return this.emit([], "urn:afp:thread:hub-lifecycle", "hub", (envelope) =>
      archiveHub(envelope, { hub: this.actorId, reason, stateHashes }),
    );
  }

  async run(transport: Transport): Promise<void> {
    for (let pass = 0; pass < 8; pass++) {
      const report = await this.queue.drain(transport, this.now());
      if (report.delivered === 0 && report.deadLettered.length === 0) break;
    }
  }
}
