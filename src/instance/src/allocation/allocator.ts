/**
 * The allocation engine, living beside the hub — same process, same dispatch
 * port, same SQLite file (ADR-0003 Decision 1). The hub routes inbound
 * `afp:BidCommit` / `afp:BidReveal` / `Reject` / `Accept` activities here and
 * lends its outbox for everything outbound, so allocation records ride the
 * hub's signed chain like every round before them.
 */

import type { JsonValue } from "../crypto/jcs.ts";
import { digestOf } from "../crypto/proof.ts";
import type { Db } from "../store/db.ts";
import type { OutboxEntry } from "../store/outbox.ts";
import type { Envelope, Visibility } from "../ap/activities.ts";
import {
  announceTask,
  award,
  commitmentOf,
  reauction,
  settlement,
  type AnnounceSpec,
} from "./activities.ts";
import { validateActionPolicy } from "./actions.ts";
import { knownRule, latencySeconds, runRule, type RevealedBid, type Selection, type SelectionRule } from "./rules.ts";
import { knownReputationRule, runReputationRule, type PinnedSettlement } from "./reputation.ts";
import {
  admissionLog,
  auctionByThread,
  bidsFor,
  declinesFor,
  deletePendingAccept,
  ensureAllocSchema,
  hasSettlementRecord,
  loadAuction,
  logAdmission,
  pendingAccepts,
  saveAuction,
  saveCommit,
  saveDecline,
  savePendingAccept,
  saveReveal,
  saveSettlement,
  saveSettlementRecord,
  settlementRecordsBefore,
  settlementRecordsByDigest,
  type AuctionRow,
  type BidRow,
} from "./store.ts";

/** What the allocator needs from its hub — narrow on purpose. */
export interface AllocatorHub {
  hubId: string;
  actorId: string;
  db: Db;
  members(): string[];
  /** ADR-0004 Decision 1: an enrolled agent's role; `null` for the un-enrolled. */
  roleOf(agent: string): "member" | "requester" | "observer" | null;
  /** Role-aware broadcast list — members and observers; requesters get their own threads only. */
  broadcastTargets(): string[];
  now(): Date;
  emit(
    to: readonly string[],
    thread: string,
    visibility: Visibility,
    build: (envelope: Envelope) => { [key: string]: JsonValue },
  ): OutboxEntry;
}

export class Allocator {
  private readonly hub: AllocatorHub;

  constructor(hub: AllocatorHub) {
    this.hub = hub;
    ensureAllocSchema(hub.db);
  }

  auction(taskId: string): AuctionRow | null {
    return loadAuction(this.hub.db, taskId);
  }

  bids(taskId: string): BidRow[] {
    return bidsFor(this.hub.db, taskId);
  }

  declines(taskId: string): { actor: string; reason: string }[] {
    return declinesFor(this.hub.db, taskId);
  }

  admissions(taskId: string): { at: string; actor: string; outcome: string; reason: string }[] {
    return admissionLog(this.hub.db, taskId);
  }

  // ----------------------------------------------------------------- announce

  /** Fan-out for one auction: members and observers, plus the requester counterparty on its own thread (ADR-0004). */
  private recipients(auction: Pick<AuctionRow, "requester">): string[] {
    const targets = this.hub.broadcastTargets();
    if (auction.requester && !targets.includes(auction.requester)) targets.push(auction.requester);
    return targets;
  }

  /** Broadcast `Announce{afp:Task}` to members and observers and open the auction. */
  announce(spec: AnnounceSpec & { thread: string; requester?: string }): OutboxEntry {
    if (!knownRule(spec.selectionRule.name)) {
      throw new Error(`selection rule ${spec.selectionRule.name} is not in the registry`);
    }
    // ADR-0004 Decision 3: reputation consumption is opt-in and pinned whole.
    // A rule without its snapshot — or a reputation weight without a rule —
    // would be a live number inside a recomputable Award; both are refused.
    const weights = (spec.selectionRule.params.weights ?? {}) as Record<string, JsonValue>;
    if (!spec.reputationRule && typeof weights.reputation === "number" && weights.reputation !== 0) {
      throw new Error("weights.reputation without a pinned afp:reputationRule — no rule, no reputation input");
    }
    let snapshot: string[] | null = null;
    if (spec.reputationRule) {
      if (!knownReputationRule(spec.reputationRule.name)) {
        throw new Error(`reputation rule ${spec.reputationRule.name} is not in the registry`);
      }
      // The snapshot is exhaustive, not curated: every settlement of this hub
      // published before the announce, in (published, digest) order.
      snapshot = settlementRecordsBefore(this.hub.db, this.hub.now().toISOString()).map((r) => r.digest);
      spec = { ...spec, settlementSnapshot: snapshot };
    }
    // ADR-0006 Decision 2: the performer wall resolves through prior Awards,
    // so a listed task must already hold one — an exclusion that cannot be
    // reconstructed excludes nobody, and the verifier will say so anyway.
    for (const prior of spec.excludePerformersOf ?? []) {
      const priorAuction = loadAuction(this.hub.db, prior);
      if (!priorAuction?.award) {
        throw new Error(`afp:excludePerformersOf names ${prior}, which has no Award to exclude performers of`);
      }
    }
    // ADR-0010 Decision 4: a pinned policy that cannot state its no-verdict
    // action is not yet a policy — checked here, on the writer side, and
    // again by replay.
    if (spec.actionPolicy) validateActionPolicy(spec.actionPolicy);
    // One auction per thread (H9). The counterparty check that authorizes an
    // actuals report resolves the auction *by thread*, so two auctions sharing
    // one would let a report settle the wrong task.
    const onThread = auctionByThread(this.hub.db, spec.thread);
    if (onThread && onThread.taskId !== spec.taskId) {
      throw new Error(`thread ${spec.thread} already hosts auction ${onThread.taskId} — one auction per thread`);
    }
    const requester = spec.requester ?? null;
    const entry = this.hub.emit(this.recipients({ requester }), spec.thread, "hub", (envelope) =>
      announceTask(envelope, spec),
    );
    saveAuction(this.hub.db, {
      taskId: spec.taskId,
      hubId: this.hub.hubId,
      thread: spec.thread,
      correlationId: spec.correlationId,
      rule: spec.selectionRule,
      windowOpens: spec.bidWindow.opens,
      windowCloses: spec.bidWindow.closes,
      estimatorPolicy: spec.estimatorPolicy,
      estimators: [...spec.estimators],
      answerSufficiency: { ...spec.answerSufficiency },
      status: "bidding",
      award: null,
      requester,
      reputationRule: spec.reputationRule ?? null,
      settlementSnapshot: snapshot,
      excludePerformersOf: spec.excludePerformersOf?.length ? [...spec.excludePerformersOf] : null,
    });
    return entry;
  }

  /**
   * Inbound `Announce{afp:Task}` (ADR-0004 Decision 1): a requester's (or
   * member's) signed Announce is admitted by role, re-fanned out by the hub,
   * and the announcing actor becomes the settlement's counterparty. An
   * observer (or non-enrolled actor) cannot announce — rejected, audit-logged.
   */
  onAnnounce(activity: { [key: string]: JsonValue }): void {
    const object = activity.object as { [key: string]: JsonValue } | undefined;
    if (!object || typeof object !== "object") return;
    const taskId = String(object.id ?? "");
    const actor = String(activity.actor ?? "");
    const reject = (reason: string) =>
      logAdmission(this.hub.db, this.hub.now().toISOString(), taskId, actor, "rejected", reason);

    const role = this.hub.roleOf(actor);
    if (role !== "member" && role !== "requester") {
      return reject(`announce from role ${role ?? "non-enrolled"} — only member or requester may announce (afp:role)`);
    }
    if (loadAuction(this.hub.db, taskId)) return reject("announce names an already-open auction");
    const thread = String(activity.context ?? "");
    const onThread = auctionByThread(this.hub.db, thread);
    if (onThread) {
      return reject(`thread ${thread} already hosts auction ${onThread.taskId} — one auction per thread`);
    }

    const rule = object["afp:selectionRule"] as { name?: string; params?: { [key: string]: JsonValue } } | undefined;
    const repRule = object["afp:reputationRule"] as { name?: string; params?: { [key: string]: JsonValue } } | undefined;
    const window = object["afp:bidWindow"] as { opens?: string; closes?: string } | undefined;
    if (!rule?.name || !knownRule(String(rule.name))) {
      return reject(`announce names no registered selection rule (${String(rule?.name ?? "none")})`);
    }
    if (!window?.opens || !window?.closes) return reject("announce carries no afp:bidWindow");
    // A window must be able to admit a bid: inverted or already-closed, no
    // commit can ever land inside it and the auction is dead on arrival (H12).
    if (String(window.opens) >= String(window.closes)) {
      return reject(`afp:bidWindow opens ${window.opens} at or after it closes ${window.closes}`);
    }
    if (String(window.closes) <= this.hub.now().toISOString()) {
      return reject(`afp:bidWindow closed at ${window.closes}, before the announce was admitted`);
    }

    this.announce({
      taskId,
      hub: this.hub.actorId,
      capability: String(object["afp:capability"] ?? ""),
      content: String(object.content ?? ""),
      correlationId: String(object["afp:correlationId"] ?? ""),
      bidWindow: { opens: String(window.opens), closes: String(window.closes) },
      selectionRule: { name: String(rule.name), params: { ...(rule.params ?? {}) } },
      answerSufficiency: { ...((object["afp:answerSufficiency"] as { [key: string]: JsonValue }) ?? {}) },
      estimatorPolicy: object["afp:estimatorPolicy"] === "permit-and-record" ? "permit-and-record" : "exclude",
      estimators: Array.isArray(object["afp:estimators"]) ? (object["afp:estimators"] as JsonValue[]).map(String) : [],
      thread,
      requester: actor,
      // The hub re-pins its own exhaustive snapshot at re-announce time.
      reputationRule: repRule?.name ? { name: String(repRule.name), params: { ...(repRule.params ?? {}) } } : undefined,
      // ADR-0006 pins travel with the requester's ask into the re-fan-out.
      actionPolicy:
        object["afp:actionPolicy"] && typeof object["afp:actionPolicy"] === "object" && !Array.isArray(object["afp:actionPolicy"])
          ? Object.fromEntries(Object.entries(object["afp:actionPolicy"] as Record<string, JsonValue>).map(([k, v]) => [k, String(v)]))
          : undefined,
      excludePerformersOf: Array.isArray(object["afp:excludePerformersOf"])
        ? (object["afp:excludePerformersOf"] as JsonValue[]).map(String)
        : undefined,
      // ADR-0010 Decision 2: the pinned synthesizer travels with the rest of
      // the pin set into the re-fan-out. Dropped here, the hub's re-Announce
      // and the requester's Announce would carry different pin digests and
      // every re-fanned thread would fail the pin-equality check.
      synthesizer: typeof object["afp:synthesizer"] === "string" ? object["afp:synthesizer"] : undefined,
    });
  }

  /**
   * A requester's `Create{afp:Result}` carrying `afp:actuals` onto its own
   * thread (ADR-0004, scenario 05 step 5): settlement on requester-reported
   * actuals. Only the auction's recorded counterparty may report.
   */
  onActualsReport(activity: { [key: string]: JsonValue }): void {
    const object = activity.object as { [key: string]: JsonValue } | undefined;
    if (!object || typeof object !== "object") return;
    const actuals = object["afp:actuals"] as { [key: string]: JsonValue } | undefined;
    if (!actuals || typeof actuals !== "object") return; // an ordinary Result, not an actuals report

    const actor = String(activity.actor ?? "");
    const thread = String(activity.context ?? "");
    const auction = auctionByThread(this.hub.db, thread);
    const reject = (reason: string) =>
      logAdmission(this.hub.db, this.hub.now().toISOString(), auction?.taskId ?? thread, actor, "rejected", reason);

    if (!auction) return reject("actuals report on a thread with no auction");
    if (auction.requester !== actor) {
      return reject("actuals report from an actor that is not this auction's announcing counterparty");
    }
    // Actuals settle an award. Reporting before one exists would put a
    // settlement on the record for work nobody was awarded, and reporting
    // twice would let the counterparty publish several conflicting "what
    // actually happened" claims — each a fresh signed Settlement that
    // `settlementRecordsBefore` then sweeps, exhaustively, into every later
    // announce's reputation snapshot (ADR-0004 Decision 3).
    if (auction.status !== "awarded") {
      return reject(`actuals report for an auction in status '${auction.status}' — settlement follows an award`);
    }
    if (hasSettlementRecord(this.hub.db, auction.taskId)) {
      return reject("actuals already reported for this task — settlement is once per task");
    }
    const dissent = Array.isArray(object["afp:dissentVindicated"])
      ? (object["afp:dissentVindicated"] as JsonValue[]).map(String)
      : [];
    this.settle(auction.taskId, actuals, dissent);
  }

  // ---------------------------------------------------------------- admission

  /**
   * `afp:BidCommit` admission (Decisions 2 and 6): enrolled bidder, inside the
   * window, not an excluded estimator, first commit per bidder wins. Every
   * rejection is audit-logged — enforcement that leaves no trace is policy
   * nobody can verify was applied.
   */
  onCommit(activity: { [key: string]: JsonValue }): void {
    const taskId = String(activity.object ?? "");
    const actor = String(activity.actor ?? "");
    const published = String(activity.published ?? "");
    const commitment = String(activity["afp:commitment"] ?? "");
    const auction = loadAuction(this.hub.db, taskId);
    const reject = (reason: string) =>
      logAdmission(this.hub.db, this.hub.now().toISOString(), taskId, actor, "rejected", reason);

    if (!auction || auction.status !== "bidding") return reject("no open auction for this task");
    if (!this.hub.members().includes(actor)) return reject("bidder is not enrolled in this hub");
    // ADR-0004 Decision 1: a commit from a non-member role is rejected and
    // audit-logged, same lane as the estimator wall.
    if (this.hub.roleOf(actor) !== "member") {
      return reject(`bidder role is ${this.hub.roleOf(actor)} — only member-role agents may bid (afp:role)`);
    }
    if (published < auction.windowOpens || published >= auction.windowCloses) {
      return reject(`commit published ${published} outside bid window [${auction.windowOpens}, ${auction.windowCloses})`);
    }
    if (auction.estimatorPolicy === "exclude" && auction.estimators.includes(actor)) {
      return reject("estimator excluded from bidding on execution of work it estimated (afp:estimatorPolicy=exclude)");
    }
    // ADR-0006 Decision 2: the estimator wall generalized — a performer of a
    // task this announce lists is excluded the same way, same audit lane.
    for (const prior of auction.excludePerformersOf ?? []) {
      const performers = (loadAuction(this.hub.db, prior)?.award?.["afp:performers"] as JsonValue[] | undefined) ?? [];
      if (performers.includes(actor)) {
        return reject(`performer of ${prior} excluded from this auction (afp:excludePerformersOf)`);
      }
    }
    if (!commitment) return reject("commit carries no afp:commitment");
    // One sealed commitment per bidder. A second, *different* commitment is a
    // free option — commit several bids, reveal whichever looks best after the
    // window — and is rejected on the record; an identical re-send is a retry.
    const existing = bidsFor(this.hub.db, taskId).find((bid) => bid.bidder === actor);
    if (existing && existing.commitment !== commitment) {
      return reject(`second differing commitment (already committed ${existing.commitment})`);
    }
    saveCommit(this.hub.db, taskId, actor, commitment, published);
  }

  /** `afp:BidReveal` — verification is recomputing the digest and comparing. */
  onReveal(activity: { [key: string]: JsonValue }): void {
    const payload = activity.object as { [key: string]: JsonValue } | undefined;
    if (!payload || typeof payload !== "object") return;
    const taskId = String(payload["afp:task"] ?? "");
    const actor = String(activity.actor ?? "");
    const reject = (reason: string) =>
      logAdmission(this.hub.db, this.hub.now().toISOString(), taskId, actor, "rejected", reason);

    const auction = loadAuction(this.hub.db, taskId);
    if (!auction) return reject("reveal for unknown auction");
    if (String(activity.published ?? "") < auction.windowCloses) return reject("reveal inside the sealed bid window");
    if (String(payload["afp:bidder"] ?? "") !== actor) return reject("afp:bidder does not match the signing actor");

    const bid = bidsFor(this.hub.db, taskId).find((b) => b.bidder === actor);
    if (!bid) return reject("reveal without a prior in-window commit");
    const digest = commitmentOf(payload);
    if (digest !== bid.commitment) {
      return reject(`reveal digest ${digest} does not match commitment ${bid.commitment}`);
    }
    saveReveal(this.hub.db, taskId, actor, payload, digest);
  }

  /** An in-window `Reject` on an announced task — declining is a record (03). */
  onDecline(activity: { [key: string]: JsonValue }): void {
    const taskId = String(activity.object ?? "");
    const auction = loadAuction(this.hub.db, taskId);
    if (!auction) return;
    const actor = String(activity.actor ?? "");
    // 03: agents SHOULD Reject within the bid window. A late decline is not
    // the coverage record the audit wants — logged, not counted.
    if (String(activity.published ?? "") >= auction.windowCloses) {
      return logAdmission(this.hub.db, this.hub.now().toISOString(), taskId, actor, "rejected", "decline after the bid window closed");
    }
    saveDecline(this.hub.db, taskId, actor, String(activity.summary ?? ""));
  }

  /** An `Accept` answering an Award clears that performer's timeout. */
  onAccept(activity: { [key: string]: JsonValue }): void {
    const awardId = String(activity.object ?? "");
    const pending = pendingAccepts(this.hub.db).find((p) => p.awardId === awardId);
    if (!pending) return;
    const missing = pending.missing.filter((actor) => actor !== String(activity.actor ?? ""));
    savePendingAccept(this.hub.db, { ...pending, missing });
  }

  // -------------------------------------------------------------------- award

  /** The revealed bid set a rule runs over — reveals whose digest matched their commit. */
  private revealedBids(taskId: string): RevealedBid[] {
    return bidsFor(this.hub.db, taskId)
      .filter((bid) => bid.reveal !== null)
      .map((bid) => {
        const reveal = bid.reveal!;
        const cost = reveal["afp:estimatedCost"] as { value?: number } | undefined;
        return {
          bidder: bid.bidder,
          digest: bid.revealDigest!,
          capabilityMatch: Number(reveal["afp:capabilityMatch"] ?? 0),
          estimatedCostValue: Number(cost?.value ?? 0),
          estimatedLatencySeconds: latencySeconds(String(reveal["afp:estimatedLatency"] ?? "")),
          coverage: (reveal["afp:coverage"] as Record<string, number> | undefined) ?? {},
        };
      });
  }

  /**
   * The announced answer-sufficiency threshold (03: "state it in the announce,
   * not after") — `count` bounds the performer set size, `coverage` demands
   * the winning bids span the named domains at the rule's confidence floor.
   */
  private meetsSufficiency(auction: AuctionRow, selection: Selection, bids: RevealedBid[]): string | null {
    const sufficiency = auction.answerSufficiency;
    const count = typeof sufficiency.count === "number" ? sufficiency.count : null;
    if (count !== null && selection.performers.length < count) {
      return `selection yields ${selection.performers.length} performer(s), afp:answerSufficiency requires ${count}`;
    }
    const domains = Array.isArray(sufficiency.coverage) ? (sufficiency.coverage as string[]) : null;
    if (domains) {
      const min = typeof auction.rule.params.minConfidence === "number" ? auction.rule.params.minConfidence : 60;
      const winners = bids.filter((bid) => selection.winningBids.includes(bid.digest));
      const covered = new Set(winners.flatMap((bid) => domains.filter((d) => (bid.coverage[d] ?? 0) >= min)));
      const gaps = domains.filter((d) => !covered.has(d));
      if (gaps.length) return `awarded coverage misses domain(s): ${gaps.join(", ")}`;
    }
    return null;
  }

  /**
   * Close the auction: run the announced rule over the revealed bids and
   * publish the `afp:Award` — the recomputable outcome any member can check.
   * On the reauction fast path, the excluded failed winners and the prior
   * award ride the new Award, so a verifier can rebuild the same pool.
   */
  closeAuction(
    taskId: string,
    acceptBy: string,
    exclude: readonly string[] = [],
    priorAward?: string,
  ): OutboxEntry | null {
    const auction = loadAuction(this.hub.db, taskId);
    if (!auction) throw new Error(`unknown auction ${taskId}`);
    let bids = this.revealedBids(taskId).filter((bid) => !exclude.includes(bid.bidder));
    // ADR-0004 Decision 3: when the announce pinned a reputation rule, resolve
    // its settlement snapshot (every digest must resolve — an unresolvable
    // pinned settlement is a hard error, not a skip) and feed each bidder's
    // recomputed score into the selection rule.
    if (auction.reputationRule) {
      const resolved = settlementRecordsByDigest(this.hub.db, auction.settlementSnapshot ?? []);
      const missing = (auction.settlementSnapshot ?? []).filter((_, i) => resolved[i] === null);
      if (missing.length) {
        throw new Error(`pinned settlement snapshot digests do not resolve: ${missing.join(", ")}`);
      }
      const settlements: PinnedSettlement[] = resolved.map((r) => ({
        object: r!.object,
        published: r!.published,
        digest: r!.digest,
      }));
      bids = bids.map((bid) => ({
        ...bid,
        reputation: runReputationRule(auction.reputationRule!, settlements, bid.bidder),
      }));
    }
    const selection = runRule(auction.rule, taskId, bids);
    const insufficient = selection && this.meetsSufficiency(auction, selection, bids);
    if (!selection || insufficient) {
      logAdmission(this.hub.db, this.hub.now().toISOString(), taskId, this.hub.actorId, "no-award",
        insufficient ?? "selection rule produced no performer set");
      auction.status = "failed";
      saveAuction(this.hub.db, auction);
      return null;
    }
    return this.publishAward(auction, selection, acceptBy, exclude, priorAward);
  }

  private publishAward(
    auction: AuctionRow,
    selection: Selection,
    acceptBy: string,
    excludedBidders: readonly string[],
    priorAward?: string,
  ): OutboxEntry {
    const awardId = `${this.hub.actorId}/awards/${auction.correlationId}${priorAward ? "-reauction" : ""}`;
    const entry = this.hub.emit(this.recipients(auction), auction.thread, "hub", (envelope) =>
      award(envelope, {
        awardId,
        task: auction.taskId,
        hub: this.hub.actorId,
        correlationId: auction.correlationId,
        selectionRule: auction.rule as SelectionRule,
        winningBids: selection.winningBids,
        performers: selection.performers,
        synthesizer: selection.synthesizer,
        acceptBy,
        priorAward,
        excludedBidders: priorAward ? excludedBidders : [],
      }),
    );
    auction.status = "awarded";
    auction.award = entry.activity.object as { [key: string]: JsonValue };
    saveAuction(this.hub.db, auction);
    savePendingAccept(this.hub.db, { awardId, taskId: auction.taskId, acceptBy, missing: [...selection.performers] });
    return entry;
  }

  /**
   * The P1 deadline-sweep pattern applied to awards (Decision 4): an award with
   * no `Accept` by its window close is a recorded `afp:Reauction`, fast path —
   * rerun the same rule over the same pool minus the failed winner(s). Pending
   * state lives in SQLite, so the sweep survives a restart like P1's does.
   */
  sweepAwards(): OutboxEntry[] {
    const now = this.hub.now().toISOString();
    const emitted: OutboxEntry[] = [];
    for (const pending of pendingAccepts(this.hub.db)) {
      if (pending.missing.length === 0) {
        deletePendingAccept(this.hub.db, pending.awardId);
        continue;
      }
      if (now < pending.acceptBy) continue;

      const failed = [...pending.missing];
      deletePendingAccept(this.hub.db, pending.awardId);
      const auction = loadAuction(this.hub.db, pending.taskId)!;

      emitted.push(
        this.hub.emit(this.recipients(auction), auction.thread, "hub", (envelope) =>
          reauction(envelope, {
            task: pending.taskId,
            hub: this.hub.actorId,
            priorAward: pending.awardId,
            reason: `no Accept from ${failed.join(", ")} by ${pending.acceptBy}`,
            path: "next-ranked",
          }),
        ),
      );
      const next = this.closeAuction(pending.taskId, this.nextAcceptWindow(), failed, pending.awardId);
      if (next) emitted.push(next);
    }
    return emitted;
  }

  private nextAcceptWindow(): string {
    return new Date(this.hub.now().getTime() + 60_000).toISOString();
  }

  // --------------------------------------------------------------- settlement

  /**
   * `afp:Settlement` — link each winning bid's estimates to observed actuals
   * (Decision 5). The divergence lands in the settlements table and on the
   * record; no score is computed from it here.
   */
  settle(
    taskId: string,
    actuals: Readonly<Record<string, JsonValue>>,
    dissentVindicated: readonly string[] = [],
    synthesis?: string,
  ): OutboxEntry {
    const auction = loadAuction(this.hub.db, taskId);
    if (!auction) throw new Error(`unknown auction ${taskId}`);
    // The same two invariants the inbound path enforces, held here too: a
    // programmatic caller must not be able to publish a settlement the
    // record cannot justify, or a second one that competes with the first.
    if (auction.status !== "awarded") {
      throw new Error(`cannot settle auction ${taskId} in status '${auction.status}' — settlement follows an award`);
    }
    if (hasSettlementRecord(this.hub.db, taskId)) {
      throw new Error(`auction ${taskId} is already settled — settlement is once per task`);
    }
    const now = this.hub.now().toISOString();

    const entries = bidsFor(this.hub.db, taskId)
      .filter((bid) => bid.reveal !== null && bid.bidder in actuals)
      .map((bid) => {
        const estimated: JsonValue = {
          "afp:estimatedCost": bid.reveal!["afp:estimatedCost"] ?? null,
          "afp:estimatedLatency": bid.reveal!["afp:estimatedLatency"] ?? null,
        };
        saveSettlement(this.hub.db, taskId, bid.bidder, bid.revealDigest!, estimated, actuals[bid.bidder], now);
        return { actor: bid.bidder, bid: bid.revealDigest!, estimated, actual: actuals[bid.bidder] };
      });

    const entry = this.hub.emit(this.recipients(auction), auction.thread, "hub", (envelope) =>
      settlement(envelope, {
        settlementId: `${this.hub.actorId}/settlements/${auction.correlationId}`,
        task: taskId,
        hub: this.hub.actorId,
        synthesis,
        entries,
        dissentVindicated,
      }),
    );
    // ADR-0004 Decision 3: record the emitted Settlement by its digest so a
    // later announce can pin it (exhaustively) and an award can resolve it.
    saveSettlementRecord(this.hub.db, {
      digest: digestOf(entry.activity),
      taskId,
      published: String(entry.activity.published ?? now),
      object: entry.activity.object as { [key: string]: JsonValue },
    });
    return entry;
  }

  /** Digest helper for callers binding Results into a Synthesis. */
  static digest(activity: { [key: string]: JsonValue }): string {
    return digestOf(activity);
  }
}
