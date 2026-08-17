/**
 * Layer 1 of AFP's two dedupe layers: transport dedupe on activity `id`.
 *
 * This absorbs retry storms and duplicate delivery of *the same activity*, and
 * it runs before dispatch. It is not the same thing as `correlationId` replay
 * (see `tasks.ts`), which absorbs the same *task* arriving as a genuinely new
 * activity. An implementation with only one of the two either executes work
 * twice or silently drops legitimate redeliveries — 03 § Correlation.
 */

import type { Db } from "./db.ts";

export class SeenIds {
  private readonly db: Db;
  private readonly ttlMs: number;

  constructor(db: Db, ttlMs: number) {
    this.db = db;
    this.ttlMs = ttlMs;
  }

  /**
   * Record `activityId` as seen.
   *
   * Returns true if this is the first sighting (caller should dispatch), false
   * if it is a redelivery (caller should drop).
   */
  markSeen(activityId: string, now = new Date()): boolean {
    this.purgeExpired(now);
    const existing = this.db
      .prepare("SELECT 1 FROM seen_ids WHERE activity_id = ?")
      .get(activityId);
    if (existing) return false;

    this.db
      .prepare("INSERT INTO seen_ids (activity_id, seen_at, expires_at) VALUES (?, ?, ?)")
      .run(
        activityId,
        now.toISOString(),
        new Date(now.getTime() + this.ttlMs).toISOString(),
      );
    return true;
  }

  has(activityId: string): boolean {
    return this.db.prepare("SELECT 1 FROM seen_ids WHERE activity_id = ?").get(activityId) != null;
  }

  private purgeExpired(now: Date): void {
    this.db.prepare("DELETE FROM seen_ids WHERE expires_at <= ?").run(now.toISOString());
  }
}
