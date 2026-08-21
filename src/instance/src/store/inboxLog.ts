/**
 * The received-delivery log (ADR-0017 Decision 3): every activity the inbox
 * admitted, keyed by the inbox path it was delivered to. This is what a GET
 * on an inbox serves to its owner — AP §5.2's collection view, which AFP had
 * no way to answer while received activities left no record beyond dedupe ids.
 *
 * Admission already happened at the gate; recording is not a second judgment,
 * and a refused delivery never lands here.
 */

import type { DatabaseSync } from "node:sqlite";
import type { JsonValue } from "../crypto/jcs.ts";

export class InboxLog {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  record(recipient: string, activity: { [key: string]: JsonValue }, at: Date): void {
    const id = typeof activity.id === "string" ? activity.id : null;
    if (!id) return; // transient activities carry no id and leave no inbox record
    this.db
      .prepare("INSERT OR IGNORE INTO inbox_log (activity_id, recipient, activity_json, received_at) VALUES (?, ?, ?, ?)")
      .run(id, recipient, JSON.stringify(activity), at.toISOString());
  }

  byRecipient(recipient: string): { [key: string]: JsonValue }[] {
    const rows = this.db
      .prepare("SELECT activity_json FROM inbox_log WHERE recipient = ? ORDER BY received_at, activity_id")
      .all(recipient) as { activity_json: string }[];
    return rows.map((row) => JSON.parse(row.activity_json));
  }
}
