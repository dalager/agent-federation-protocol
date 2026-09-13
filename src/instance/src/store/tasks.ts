/**
 * Layer 2 of AFP's two dedupe layers: the pending-task table and cached results,
 * keyed by `afp:correlationId`.
 *
 * The delegator side keeps a pending-task row with a deadline — the HTTP
 * response to an Offer only ever means "delivered", never "accepted" (03 § 8a).
 * The performer side caches its outcome so that a task it has already answered
 * replays instead of running the brain a second time.
 */

import type { Db } from "./db.ts";
import type { JsonValue } from "../crypto/jcs.ts";

export type TaskState = "offered" | "accepted" | "completed" | "failed";

export interface PendingTask {
  correlationId: string;
  thread: string;
  delegator: string;
  performer: string;
  deadline: string | null;
  state: TaskState;
}

export class Tasks {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  open(task: Omit<PendingTask, "state">, now = new Date()): void {
    this.db
      .prepare(
        `INSERT INTO pending_tasks
           (correlation_id, thread, delegator, performer, deadline, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'offered', ?, ?)
         ON CONFLICT (correlation_id) DO NOTHING`,
      )
      .run(
        task.correlationId,
        task.thread,
        task.delegator,
        task.performer,
        task.deadline,
        now.toISOString(),
        now.toISOString(),
      );
  }

  setState(correlationId: string, state: TaskState, now = new Date()): void {
    this.db
      .prepare("UPDATE pending_tasks SET state = ?, updated_at = ? WHERE correlation_id = ?")
      .run(state, now.toISOString(), correlationId);
  }

  get(correlationId: string): PendingTask | null {
    const row = this.db
      .prepare("SELECT * FROM pending_tasks WHERE correlation_id = ?")
      .get(correlationId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      correlationId: String(row.correlation_id),
      thread: String(row.thread),
      delegator: String(row.delegator),
      performer: String(row.performer),
      deadline: row.deadline === null ? null : String(row.deadline),
      state: String(row.state) as TaskState,
    };
  }

  /** Tasks still awaiting an outcome past their deadline. */
  overdue(now = new Date()): PendingTask[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pending_tasks
          WHERE state IN ('offered', 'accepted') AND deadline IS NOT NULL AND deadline < ?`,
      )
      .all(now.toISOString()) as Record<string, unknown>[];
    return rows.map((row) => ({
      correlationId: String(row.correlation_id),
      thread: String(row.thread),
      delegator: String(row.delegator),
      performer: String(row.performer),
      deadline: row.deadline === null ? null : String(row.deadline),
      state: String(row.state) as TaskState,
    }));
  }

  /** ADR-0029 Decision 2 ("Command"): how many tasks `performer` still has open — the `status` command's `pending` count. */
  openCountForPerformer(performer: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM pending_tasks WHERE performer = ? AND state IN ('offered', 'accepted')")
      .get(performer) as { n: number };
    return Number(row.n);
  }

  /** Cache the outcome a performer produced for a correlationId. */
  cacheResult(
    correlationId: string,
    performer: string,
    activity: { [key: string]: JsonValue },
    now = new Date(),
  ): void {
    this.db
      .prepare(
        `INSERT INTO task_results (correlation_id, performer, activity_id, activity_json, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (correlation_id) DO NOTHING`,
      )
      .run(
        correlationId,
        performer,
        String(activity.id ?? ""),
        JSON.stringify(activity),
        now.toISOString(),
      );
  }

  /**
   * The cached outcome for a correlationId, if this performer already answered it.
   *
   * A hit here is what makes a repeated task a *replay* rather than a second
   * execution — gate check 1.
   */
  cachedResult(
    correlationId: string,
    performer: string,
  ): { [key: string]: JsonValue } | null {
    const row = this.db
      .prepare("SELECT activity_json FROM task_results WHERE correlation_id = ? AND performer = ?")
      .get(correlationId, performer) as { activity_json?: string } | undefined;
    return row?.activity_json ? JSON.parse(row.activity_json) : null;
  }
}
