/**
 * Layer 1 of AFP's two dedupe layers: transport dedupe on activity `id`.
 *
 * This absorbs retry storms and duplicate delivery of *the same activity*, and
 * it runs before dispatch. It is not the same thing as `correlationId` replay
 * (see `tasks.ts`), which absorbs the same *task* arriving as a genuinely new
 * activity. An implementation with only one of the two either executes work
 * twice or silently drops legitimate redeliveries — 03 § Correlation.
 *
 * Two layers of the same shape live here — activity ids, and (ADR-0025
 * Decision 7) request signatures — over one `TtlSeenTable`: a first-sighting
 * test against a TTL. **Expiry is decided by the query, never by the sweep.**
 * A row past its `expires_at` reads as absent whether or not it has been
 * deleted yet, so the sweep is space reclamation and nothing more, and can be
 * amortized instead of run on every call.
 */

import { createHash } from "node:crypto";
import type { Db } from "./db.ts";

/** How often expired rows are actually deleted. Bounds the table; never decides expiry. */
const PURGE_INTERVAL_MS = 60_000;

/**
 * A TTL-scoped "have I seen this key" table. `table` and `keyColumn` are
 * module constants below, never caller input.
 */
class TtlSeenTable {
  private readonly db: Db;
  private readonly table: string;
  private readonly keyColumn: string;
  private readonly ttlMs: number;
  private lastPurgeMs = 0;

  constructor(db: Db, table: string, keyColumn: string, ttlMs: number) {
    this.db = db;
    this.table = table;
    this.keyColumn = keyColumn;
    this.ttlMs = ttlMs;
  }

  /** True on the first sighting within the TTL (caller proceeds); false on a repeat (caller drops). */
  markSeen(key: string, now: Date): boolean {
    this.purgeIfDue(now);
    if (this.has(key, now)) return false;
    // An expired row for this key may still be sitting here — it read as
    // absent above, and this replaces it with a fresh window.
    this.db
      .prepare(
        `INSERT INTO ${this.table} (${this.keyColumn}, seen_at, expires_at) VALUES (?, ?, ?)
           ON CONFLICT (${this.keyColumn}) DO UPDATE SET seen_at = excluded.seen_at, expires_at = excluded.expires_at`,
      )
      .run(key, now.toISOString(), new Date(now.getTime() + this.ttlMs).toISOString());
    return true;
  }

  /** Unexpired-only by construction: an expired row is indistinguishable from no row. */
  has(key: string, now: Date): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM ${this.table} WHERE ${this.keyColumn} = ? AND expires_at > ?`)
        .get(key, now.toISOString()) != null
    );
  }

  private purgeIfDue(now: Date): void {
    if (now.getTime() - this.lastPurgeMs < PURGE_INTERVAL_MS) return;
    this.lastPurgeMs = now.getTime();
    this.db.prepare(`DELETE FROM ${this.table} WHERE expires_at <= ?`).run(now.toISOString());
  }
}

/**
 * ADR-0025 Decision 7: a signed request cannot be replayed inside its own
 * skew window. Keyed by (keyId, created, signature bytes) — cheap, bounded
 * by the same TTL as the skew window itself, and closes the one hole the
 * method-derived covered set (ADR-0013 Decision 1) leaves open for GETs: a
 * signature that never touches a body can be replayed verbatim.
 */
export class SeenSignatures {
  private readonly table: TtlSeenTable;

  constructor(db: Db, ttlMs: number) {
    // ADR-0032 Decision 4: seen_signatures comes from openDb's migration now
    // — see store/migrations/001-baseline.ts.
    this.table = new TtlSeenTable(db, "seen_signatures", "fingerprint", ttlMs);
  }

  private fingerprint(keyId: string, created: string, signature: string): string {
    return createHash("sha256").update(keyId).update("\0").update(created).update("\0").update(signature).digest("hex");
  }

  /** Returns true on first presentation (caller proceeds); false on replay (caller refuses). */
  markSeen(keyId: string, created: string, signature: string, now = new Date()): boolean {
    return this.table.markSeen(this.fingerprint(keyId, created, signature), now);
  }
}

export class SeenIds {
  private readonly table: TtlSeenTable;

  constructor(db: Db, ttlMs: number) {
    this.table = new TtlSeenTable(db, "seen_ids", "activity_id", ttlMs);
  }

  /**
   * Record `activityId` as seen.
   *
   * Returns true if this is the first sighting (caller should dispatch), false
   * if it is a redelivery (caller should drop).
   */
  markSeen(activityId: string, now = new Date()): boolean {
    return this.table.markSeen(activityId, now);
  }

  has(activityId: string, now = new Date()): boolean {
    return this.table.has(activityId, now);
  }
}
