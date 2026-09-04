/**
 * Layer 1 of AFP's two dedupe layers: transport dedupe on activity `id`.
 *
 * This absorbs retry storms and duplicate delivery of *the same activity*, and
 * it runs before dispatch. It is not the same thing as `correlationId` replay
 * (see `tasks.ts`), which absorbs the same *task* arriving as a genuinely new
 * activity. An implementation with only one of the two either executes work
 * twice or silently drops legitimate redeliveries — 03 § Correlation.
 */

import { createHash } from "node:crypto";
import type { Db } from "./db.ts";

/**
 * ADR-0025 Decision 7: a signed request cannot be replayed inside its own
 * skew window. Keyed by (keyId, created, signature bytes) — cheap, bounded
 * by the same TTL as the skew window itself, and closes the one hole the
 * method-derived covered set (ADR-0013 Decision 1) leaves open for GETs: a
 * signature that never touches a body can be replayed verbatim.
 */
export class SeenSignatures {
  private readonly db: Db;
  private readonly ttlMs: number;

  constructor(db: Db, ttlMs: number) {
    this.db = db;
    this.ttlMs = ttlMs;
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS seen_signatures (
         fingerprint TEXT PRIMARY KEY,
         seen_at     TEXT NOT NULL,
         expires_at  TEXT NOT NULL
       )`,
    );
  }

  private fingerprint(keyId: string, created: string, signature: string): string {
    return createHash("sha256").update(keyId).update("\0").update(created).update("\0").update(signature).digest("hex");
  }

  /** Returns true on first presentation (caller proceeds); false on replay (caller refuses). */
  markSeen(keyId: string, created: string, signature: string, now = new Date()): boolean {
    this.purgeExpired(now);
    const fp = this.fingerprint(keyId, created, signature);
    const existing = this.db.prepare("SELECT 1 FROM seen_signatures WHERE fingerprint = ?").get(fp);
    if (existing) return false;
    this.db
      .prepare("INSERT INTO seen_signatures (fingerprint, seen_at, expires_at) VALUES (?, ?, ?)")
      .run(fp, now.toISOString(), new Date(now.getTime() + this.ttlMs).toISOString());
    return true;
  }

  private purgeExpired(now: Date): void {
    this.db.prepare("DELETE FROM seen_signatures WHERE expires_at <= ?").run(now.toISOString());
  }
}

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
