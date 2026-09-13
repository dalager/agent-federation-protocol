/**
 * The delivery queue.
 *
 * ActivityPub delivery is fire-and-forget: a 2xx means "I accepted the bytes",
 * nothing more (04 § Reliability). Every activity leaves through this queue,
 * including in-process dispatch — so retry, backoff and dead-lettering are
 * exercised at P1 rather than discovered at P4, and the transport stays a
 * swappable adapter behind one interface.
 *
 * No broker: backoff is `next_attempt_at`, and dead-lettering is a state column.
 */

import type { Db } from "./db.ts";
import type { JsonValue } from "../crypto/jcs.ts";

/**
 * ADR-0031 Decision 6: a transport's typed refusal — a non-2xx answer from
 * the peer — so `flush` can tell "the peer asked us to wait" from an
 * ordinary failed hop. Defined here, beside the `Transport` port it belongs
 * to, so the store never depends on any one transport; `federation/transport.ts`
 * throws it and re-exports it for its own callers.
 */
export class DeliveryRefused extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(message: string, status: number, retryAfterMs: number | null) {
    super(message);
    this.name = "DeliveryRefused";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export type DeliveryState = "pending" | "delivered" | "dead";

export interface QueueItem {
  id: number;
  activityId: string;
  target: string;
  attempts: number;
  state: DeliveryState;
  lastError: string | null;
  activity: { [key: string]: JsonValue };
}

/** Where an activity goes. P1 ships a local transport; P4 adds a signed-HTTP one. */
export interface Transport {
  readonly name: string;
  deliver(target: string, activity: { [key: string]: JsonValue }): Promise<void>;
}

export interface DeliveryReport {
  delivered: number;
  retried: number;
  deadLettered: QueueItem[];
}

export class DeliveryQueue {
  private readonly db: Db;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  /** ADR-0031 Decision 6: the exponential schedule never waits longer than this. */
  private readonly backoffCeilingMs: number;

  constructor(db: Db, maxAttempts: number, backoffBaseMs: number, backoffCeilingMs = Infinity) {
    this.db = db;
    this.maxAttempts = maxAttempts;
    this.backoffBaseMs = backoffBaseMs;
    this.backoffCeilingMs = backoffCeilingMs;
  }

  enqueue(target: string, activity: { [key: string]: JsonValue }, now = new Date()): number {
    const info = this.db
      .prepare(
        `INSERT INTO delivery_queue
           (activity_id, target, attempts, next_attempt_at, state, created_at, activity_json)
         VALUES (?, ?, 0, ?, 'pending', ?, ?)`,
      )
      .run(
        String(activity.id ?? ""),
        target,
        now.getTime(),
        now.toISOString(),
        JSON.stringify(activity),
      );
    return Number(info.lastInsertRowid);
  }

  ready(now = new Date()): QueueItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM delivery_queue
          WHERE state = 'pending' AND next_attempt_at <= ?
          ORDER BY id ASC`,
      )
      .all(now.getTime()) as Record<string, unknown>[];
    const items = rows.map(toItem);
    if (items.length === 0) return items;

    // ADR-0031 Decision 6: a peer's own minimum, independent of any one
    // item's schedule — other peers' items are unaffected.
    const targets = [...new Set(items.map((item) => item.target))];
    const placeholders = targets.map(() => "?").join(",");
    const blocked = new Map(
      (
        this.db
          .prepare(`SELECT target, not_before FROM peer_backoff WHERE target IN (${placeholders})`)
          .all(...targets) as { target: string; not_before: number }[]
      ).map((row) => [row.target, row.not_before]),
    );
    return items.filter((item) => (blocked.get(item.target) ?? -Infinity) <= now.getTime());
  }

  /** The per-peer minimum next-attempt time set by a `Retry-After` (ADR-0031 D6), or null. */
  peerNotBefore(target: string): number | null {
    const row = this.db.prepare("SELECT not_before FROM peer_backoff WHERE target = ?").get(target) as
      | { not_before: number }
      | undefined;
    return row ? Number(row.not_before) : null;
  }

  private setPeerBackoff(target: string, notBefore: number): void {
    this.db
      .prepare(
        `INSERT INTO peer_backoff (target, not_before) VALUES (?, ?)
           ON CONFLICT(target) DO UPDATE SET not_before = MAX(not_before, excluded.not_before)`,
      )
      .run(target, notBefore);
  }

  /**
   * Attempt every due delivery once.
   *
   * A failure is rescheduled with exponential backoff until `maxAttempts`, after
   * which the item is dead-lettered — and dead-lettering is *not* silent: the
   * caller surfaces each one as a local `afp:Error` (gate check 4).
   */
  async flush(transport: Transport, now = new Date()): Promise<DeliveryReport> {
    const report: DeliveryReport = { delivered: 0, retried: 0, deadLettered: [] };

    for (const item of this.ready(now)) {
      const attempts = item.attempts + 1;
      try {
        await transport.deliver(item.target, item.activity);
        this.db
          .prepare("UPDATE delivery_queue SET state = 'delivered', attempts = ? WHERE id = ?")
          .run(attempts, item.id);
        report.delivered++;
      } catch (error) {
        const message = (error as Error).message ?? String(error);
        // ADR-0031 Decision 6: a peer's own `Retry-After` sets a floor under
        // this item's schedule AND a minimum for every other item to that
        // same peer — other peers are untouched (`setPeerBackoff` keys on
        // `item.target` alone).
        const retryAfterMs = error instanceof DeliveryRefused ? error.retryAfterMs : null;
        if (retryAfterMs !== null) this.setPeerBackoff(item.target, now.getTime() + retryAfterMs);

        if (attempts >= this.maxAttempts) {
          this.db
            .prepare("UPDATE delivery_queue SET state = 'dead', attempts = ?, last_error = ? WHERE id = ?")
            .run(attempts, message, item.id);
          report.deadLettered.push({ ...item, attempts, state: "dead", lastError: message });
        } else {
          const backoff = Math.min(this.backoffBaseMs * 2 ** (attempts - 1), this.backoffCeilingMs);
          const nextAttemptAt = Math.max(now.getTime() + backoff, retryAfterMs !== null ? now.getTime() + retryAfterMs : 0);
          this.db
            .prepare(
              `UPDATE delivery_queue
                  SET attempts = ?, next_attempt_at = ?, last_error = ?
                WHERE id = ?`,
            )
            .run(attempts, nextAttemptAt, message, item.id);
          report.retried++;
        }
      }
    }

    return report;
  }

  /**
   * Run `flush` until nothing is left pending.
   *
   * Backoff is honoured by advancing a virtual clock rather than sleeping, so
   * the demo and the acceptance gate stay fast and deterministic while still
   * exercising the real retry path.
   */
  async drain(transport: Transport, start = new Date()): Promise<DeliveryReport> {
    const total: DeliveryReport = { delivered: 0, retried: 0, deadLettered: [] };
    let clock = start;

    for (let pass = 0; pass < this.maxAttempts + 2; pass++) {
      // ADR-0031 Decision 6: the earliest instant anything is attemptable is
      // the item's own schedule or its peer's `Retry-After` floor, whichever
      // is later — otherwise a 429'd item would read as due, be skipped by
      // `ready()`, and spin this loop to its pass limit without advancing.
      const pending = this.db
        .prepare(
          `SELECT MIN(MAX(q.next_attempt_at, COALESCE(p.not_before, 0))) AS next
             FROM delivery_queue q LEFT JOIN peer_backoff p ON p.target = q.target
            WHERE q.state = 'pending'`,
        )
        .get() as { next: number | null };
      if (pending.next === null) break;

      clock = new Date(Math.max(clock.getTime(), Number(pending.next)));
      const report = await this.flush(transport, clock);
      total.delivered += report.delivered;
      total.retried += report.retried;
      total.deadLettered.push(...report.deadLettered);
    }

    return total;
  }

  /**
   * ADR-0025 Decision 6: a served instance's queue flush runs on real
   * intervals against the real clock — `flush()` alone, never `drain()`'s
   * virtual-clock loop, which exists for the demos and the gate. Backoff
   * (`next_attempt_at`, already stored in real milliseconds) is honoured for
   * free by ticking on a real timer instead of jumping a fake one; a peer's
   * `429`/`503` is folded in by the caller widening `lastError`-driven
   * `next_attempt_at` before the next tick — this loop just keeps ticking.
   *
   * Returns a stop function. `intervalMs` should be well under
   * `config.backoffBaseMs` so the schedule the backoff math promises is the
   * schedule that actually happens.
   */
  startRealTimeFlush(transport: Transport, intervalMs: number, onReport?: (report: DeliveryReport) => void): () => void {
    const timer = setInterval(() => {
      this.flush(transport, new Date())
        .then((report) => onReport?.(report))
        .catch(() => {
          /* a transport-level throw here is a bug in the transport, not a delivery failure — flush() already caught those */
        });
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  stats(): Record<DeliveryState, number> {
    const rows = this.db
      .prepare("SELECT state, COUNT(*) AS n FROM delivery_queue GROUP BY state")
      .all() as { state: string; n: number }[];
    const out: Record<DeliveryState, number> = { pending: 0, delivered: 0, dead: 0 };
    for (const row of rows) out[row.state as DeliveryState] = Number(row.n);
    return out;
  }
}

function toItem(row: Record<string, unknown>): QueueItem {
  return {
    id: Number(row.id),
    activityId: String(row.activity_id),
    target: String(row.target),
    attempts: Number(row.attempts),
    state: String(row.state) as DeliveryState,
    lastError: row.last_error === null ? null : String(row.last_error),
    activity: JSON.parse(String(row.activity_json)),
  };
}
