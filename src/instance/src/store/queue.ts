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

  constructor(db: Db, maxAttempts: number, backoffBaseMs: number) {
    this.db = db;
    this.maxAttempts = maxAttempts;
    this.backoffBaseMs = backoffBaseMs;
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
    return rows.map(toItem);
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
        if (attempts >= this.maxAttempts) {
          this.db
            .prepare("UPDATE delivery_queue SET state = 'dead', attempts = ?, last_error = ? WHERE id = ?")
            .run(attempts, message, item.id);
          report.deadLettered.push({ ...item, attempts, state: "dead", lastError: message });
        } else {
          const delay = this.backoffBaseMs * 2 ** (attempts - 1);
          this.db
            .prepare(
              `UPDATE delivery_queue
                  SET attempts = ?, next_attempt_at = ?, last_error = ?
                WHERE id = ?`,
            )
            .run(attempts, now.getTime() + delay, message, item.id);
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
      const pending = this.db
        .prepare("SELECT MIN(next_attempt_at) AS next FROM delivery_queue WHERE state = 'pending'")
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
