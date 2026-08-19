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
  type Visibility,
} from "./activities.ts";
import { GSet, LWWRegister, ORMap, ORSet } from "./crdtAdapter.ts";
import { CRDTStore } from "../crdt/index.ts";
import { ensureHubSchema, saveRound, saveVoteReceipt, type RoundRow } from "./store.ts";
import { Allocator } from "../allocation/allocator.ts";

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

interface RoundState {
  row: RoundRow;
  votes: Map<string, { actor: string; value: string; digest: string }>;
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
  private readonly voteReceipts = new Map<string, GSet<string>>();
  private readonly rounds = new Map<string, RoundState>();
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
      now: () => this.now(),
      emit: (to, thread, visibility, build) => this.emit(to, thread, visibility, build),
    });
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
  }

  /**
   * Snapshot discipline (ADR-0002 Decision 3, check 3): a vote from an actor
   * outside the round's pinned `afp:quorumSnapshot` voter list is rejected
   * even if validly signed — it simply never joins the receipt `G-Set`.
   */
  private onVote(activity: { [key: string]: JsonValue }): void {
    const object = activity.object as Record<string, JsonValue>;
    const round = String(object["afp:round"] ?? "");
    const state = this.rounds.get(round);
    if (!state || state.row.status !== "open") return;

    const actor = String(activity.actor ?? "");
    if (!state.row.voters.includes(actor)) return; // outside the pinned snapshot — dropped, not tallied

    // A vote must commit to the exact proposal and pinned snapshot it answers:
    // a mismatched afp:proposalHash is a ballot for a different question, and a
    // mismatched afp:quorumSnapshot is a ballot under a different electorate.
    // Both are dropped, not tallied — same treatment as an out-of-snapshot voter.
    if (String(object["afp:proposalHash"] ?? "") !== state.row.proposalHash) return;
    if (String(object["afp:quorumSnapshot"] ?? "") !== state.row.quorumSnapshot) return;

    const digest = digestOf(activity);
    const value = String(object.value ?? "");
    state.votes.set(actor, { actor, value, digest });

    let receipts = this.voteReceipts.get(round);
    if (!receipts) {
      receipts = new GSet<string>();
      this.voteReceipts.set(round, receipts);
    }
    receipts.apply({ key: actor, value: digest });
    this.crdt.apply(
      { hub: this.hubId, crdtId: `receipts:${round}`, crdtType: "G_SET", delta: { adds: [{ key: actor, value: digest }] } },
      actor,
      this.now(),
    );
    saveVoteReceipt(this.db, round, actor, digest, value);
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
    const voters = [...(options.voters ?? this.members())].filter((agent) => this.isLive(agent));
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
    this.rounds.set(options.round, { row, votes: new Map() });
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
    const state = this.rounds.get(round);
    if (!state) throw new Error(`unknown round ${round}`);

    const tally = this.tally(state);
    const outcome = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "abstain";
    const countedVotes = [...state.votes.values()].map((vote) => vote.digest);

    const entry = this.emit(state.row.voters, state.row.thread, "hub", (envelope) =>
      decisionRecord(envelope, {
        recordId: `${this.actorId}/rounds/${round}/decision`,
        hub: this.actorId,
        round,
        outcome,
        quorumSnapshot: state.row.quorumSnapshot,
        countedVotes,
        weightTally: tally,
      }),
    );

    state.row.status = "closed";
    saveRound(this.db, state.row, this.now().toISOString());
    return entry;
  }

  /** Recompute the tally the way any third-party verifier must: from the counted votes alone. */
  tally(state: RoundState): Record<string, number> {
    const totals: Record<string, number> = {};
    for (const option of state.row.options) totals[option] = 0;
    totals.abstain = 0;

    for (const voter of state.row.voters) {
      const weight = state.row.weights[voter] ?? 0;
      const vote = state.votes.get(voter);
      const value = vote && state.row.options.includes(vote.value) ? vote.value : "abstain";
      totals[value] = (totals[value] ?? 0) + weight;
    }
    return totals;
  }

  /** Read-only view for tests/verifiers wanting to recompute independently. */
  roundVotes(round: string): { actor: string; value: string; digest: string }[] {
    return [...(this.rounds.get(round)?.votes.values() ?? [])];
  }

  roundVoters(round: string): string[] {
    return [...(this.rounds.get(round)?.row.voters ?? [])];
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
