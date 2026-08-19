/**
 * The allocation engine, living beside the hub — same process, same dispatch
 * port, same SQLite file (ADR-0003 Decision 1). The hub routes inbound
 * `afp:bidCommit` / `afp:BidReveal` / `Reject` / `Accept` activities here and
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
import { knownRule, latencySeconds, runRule, type RevealedBid, type Selection, type SelectionRule } from "./rules.ts";
import {
  admissionLog,
  bidsFor,
  declinesFor,
  deletePendingAccept,
  ensureAllocSchema,
  loadAuction,
  logAdmission,
  pendingAccepts,
  saveAuction,
  saveCommit,
  saveDecline,
  savePendingAccept,
  saveReveal,
  saveSettlement,
  type AuctionRow,
  type BidRow,
} from "./store.ts";

/** What the allocator needs from its hub — narrow on purpose. */
export interface AllocatorHub {
  hubId: string;
  actorId: string;
  db: Db;
  members(): string[];
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

  /** Broadcast `Announce{afp:Task}` to every enrolled member and open the auction. */
  announce(spec: AnnounceSpec & { thread: string }): OutboxEntry {
    if (!knownRule(spec.selectionRule.name)) {
      throw new Error(`selection rule ${spec.selectionRule.name} is not in the registry`);
    }
    const entry = this.hub.emit(this.hub.members(), spec.thread, "hub", (envelope) => announceTask(envelope, spec));
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
    });
    return entry;
  }

  // ---------------------------------------------------------------- admission

  /**
   * `afp:bidCommit` admission (Decisions 2 and 6): enrolled bidder, inside the
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
    if (published < auction.windowOpens || published >= auction.windowCloses) {
      return reject(`commit published ${published} outside bid window [${auction.windowOpens}, ${auction.windowCloses})`);
    }
    if (auction.estimatorPolicy === "exclude" && auction.estimators.includes(actor)) {
      return reject("estimator excluded from bidding on execution of work it estimated (afp:estimatorPolicy=exclude)");
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
    const bids = this.revealedBids(taskId).filter((bid) => !exclude.includes(bid.bidder));
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
    const entry = this.hub.emit(this.hub.members(), auction.thread, "hub", (envelope) =>
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
        this.hub.emit(this.hub.members(), auction.thread, "hub", (envelope) =>
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

    return this.hub.emit(this.hub.members(), auction.thread, "hub", (envelope) =>
      settlement(envelope, {
        settlementId: `${this.hub.actorId}/settlements/${auction.correlationId}`,
        task: taskId,
        hub: this.hub.actorId,
        synthesis,
        entries,
        dissentVindicated,
      }),
    );
  }

  /** Digest helper for callers binding Results into a Synthesis. */
  static digest(activity: { [key: string]: JsonValue }): string {
    return digestOf(activity);
  }
}
