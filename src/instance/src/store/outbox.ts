/**
 * The outbox: an append-only, per-actor hash-chained log.
 *
 * Individually signed activities prove authorship but not completeness — an
 * omission is silent. Chaining each activity to the digest of the actor's
 * previous one makes a gap or a fork detectable from the log alone (04 §
 * Outbox integrity). The chain starts at activity #1 because it cannot be
 * started later: see ADR-0001 and P1's four obligations.
 */

import type { Db } from "./db.ts";
import type { JsonValue } from "../crypto/jcs.ts";
import { digestOf } from "../crypto/proof.ts";

export interface OutboxEntry {
  activityId: string;
  actor: string;
  seq: number;
  thread: string | null;
  digest: string;
  prevActivity: string | null;
  visibility: string;
  published: string;
  activity: { [key: string]: JsonValue };
}

export class Outbox {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** The digest of `actor`'s most recent activity, or null if it has none. */
  headDigest(actor: string): string | null {
    const row = this.db.get("SELECT digest FROM outbox WHERE actor = ? ORDER BY seq DESC LIMIT 1",
      actor
    ) as { digest?: string } | undefined;
    return row?.digest ?? null;
  }

  nextSeq(actor: string): number {
    const row = this.db.get("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM outbox WHERE actor = ?", actor) as { max_seq: number };
    return Number(row.max_seq) + 1;
  }

  /**
   * Append a fully-signed activity.
   *
   * The activity must already carry its proof: the digest recorded here — and
   * therefore the next link in the chain — covers the signature too, so the
   * chain binds signed bytes rather than a payload someone could re-sign.
   */
  append(activity: { [key: string]: JsonValue }): OutboxEntry {
    const activityId = String(activity.id ?? "");
    const actor = String(activity.actor ?? "");
    if (!activityId) throw new Error("activity has no id");
    if (!actor) throw new Error("activity has no actor");
    if (activity.proof === undefined) {
      throw new Error(`refusing to append unsigned activity ${activityId}`);
    }

    const visibility = activity["afp:visibility"];
    if (typeof visibility !== "string") {
      // Gate check 5: nothing reaches the record without a declared read class.
      throw new Error(`activity ${activityId} has no afp:visibility`);
    }

    const entry: OutboxEntry = {
      activityId,
      actor,
      seq: this.nextSeq(actor),
      thread: typeof activity.context === "string" ? activity.context : null,
      digest: digestOf(activity),
      prevActivity:
        typeof activity["afp:prevActivity"] === "string" ? activity["afp:prevActivity"] : null,
      visibility,
      published: String(activity.published ?? ""),
      activity,
    };

    this.db.run(
        `INSERT INTO outbox
           (activity_id, actor, seq, thread, digest, prev_activity, visibility, published, activity_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        entry.activityId,
        entry.actor,
        entry.seq,
        entry.thread,
        entry.digest,
        entry.prevActivity,
        entry.visibility,
        entry.published,
        JSON.stringify(activity),
        );

    return entry;
  }

  /** Every activity by one actor, in chain order. */
  byActor(actor: string): OutboxEntry[] {
    const rows = this.db.all("SELECT * FROM outbox WHERE actor = ? ORDER BY seq ASC", actor) as Record<string, unknown>[];
    return rows.map(toEntry);
  }

  /** Every activity in one thread, across actors — the audit replay selector. */
  byThread(thread: string): OutboxEntry[] {
    const rows = this.db.all("SELECT * FROM outbox WHERE thread = ? ORDER BY published ASC, actor ASC, seq ASC",
      thread
    ) as Record<string, unknown>[];
    return rows.map(toEntry);
  }

  actors(): string[] {
    const rows = this.db.all("SELECT DISTINCT actor FROM outbox ORDER BY actor") as { actor: string }[];
    return rows.map((row) => row.actor);
  }

  get(activityId: string): OutboxEntry | null {
    const row = this.db.get("SELECT * FROM outbox WHERE activity_id = ?", activityId) as Record<string, unknown> | undefined;
    return row ? toEntry(row) : null;
  }
}

function toEntry(row: Record<string, unknown>): OutboxEntry {
  return {
    activityId: String(row.activity_id),
    actor: String(row.actor),
    seq: Number(row.seq),
    thread: row.thread === null ? null : String(row.thread),
    digest: String(row.digest),
    prevActivity: row.prev_activity === null ? null : String(row.prev_activity),
    visibility: String(row.visibility),
    published: String(row.published),
    activity: JSON.parse(String(row.activity_json)),
  };
}
