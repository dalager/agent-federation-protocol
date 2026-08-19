/**
 * Allocation persistence (ADR-0003 Decision 1): new tables in the instance's
 * own SQLite file, beside `hub_rounds` — no second store, no broker.
 *
 * `alloc_settlements` is Decision 5 made concrete: bid-vs-actual divergence is
 * a *recorded signal* visible to every member, never a live score feeding
 * selection. `alloc_admissions` is the audit log Decision 6 requires for
 * bids rejected at admission.
 */

import type { Db } from "../store/db.ts";
import type { JsonValue } from "../crypto/jcs.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS alloc_auctions (
  task_id        TEXT PRIMARY KEY,
  hub_id         TEXT NOT NULL,
  thread         TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  rule_json      TEXT NOT NULL,
  window_opens   TEXT NOT NULL,
  window_closes  TEXT NOT NULL,
  estimator_policy TEXT NOT NULL,       -- exclude | permit-and-record
  estimators_json  TEXT NOT NULL,
  sufficiency_json TEXT NOT NULL,
  status         TEXT NOT NULL,         -- bidding | awarded | reauctioned | failed
  award_json     TEXT
);

-- Outstanding Accepts per award — the P1 deadline-sweep pattern needs its
-- state in SQLite, or an award timeout would not survive a restart
-- (ADR-0003 Decision 4).
CREATE TABLE IF NOT EXISTS alloc_pending_accepts (
  award_id     TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL,
  accept_by    TEXT NOT NULL,
  missing_json TEXT NOT NULL
);

-- One row per (task, bidder): the commit lands first, the reveal joins it.
CREATE TABLE IF NOT EXISTS alloc_bids (
  task_id          TEXT NOT NULL,
  bidder           TEXT NOT NULL,
  commitment       TEXT NOT NULL,
  commit_published TEXT NOT NULL,
  reveal_json      TEXT,
  reveal_digest    TEXT,
  PRIMARY KEY (task_id, bidder)
);

-- Declining is a record; silence is not (03).
CREATE TABLE IF NOT EXISTS alloc_declines (
  task_id TEXT NOT NULL,
  actor   TEXT NOT NULL,
  reason  TEXT NOT NULL,
  PRIMARY KEY (task_id, actor)
);

-- Admission-time rejections, audit-logged (Decision 6).
CREATE TABLE IF NOT EXISTS alloc_admissions (
  at      TEXT NOT NULL,
  task_id TEXT NOT NULL,
  actor   TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason  TEXT NOT NULL
);

-- Estimates linked to actuals; divergence visible, consumption deferred (Decision 5).
CREATE TABLE IF NOT EXISTS alloc_settlements (
  task_id     TEXT NOT NULL,
  actor       TEXT NOT NULL,
  bid_digest  TEXT NOT NULL,
  estimated_json TEXT NOT NULL,
  actual_json    TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (task_id, actor)
);
`;

export function ensureAllocSchema(db: Db): void {
  db.exec(SCHEMA);
}

export interface AuctionRow {
  taskId: string;
  hubId: string;
  thread: string;
  correlationId: string;
  rule: { name: string; params: { [key: string]: JsonValue } };
  windowOpens: string;
  windowCloses: string;
  estimatorPolicy: "exclude" | "permit-and-record";
  estimators: string[];
  answerSufficiency: { [key: string]: JsonValue };
  status: "bidding" | "awarded" | "reauctioned" | "failed";
  award: { [key: string]: JsonValue } | null;
}

export function saveAuction(db: Db, row: AuctionRow): void {
  db.prepare(
    `INSERT INTO alloc_auctions
       (task_id, hub_id, thread, correlation_id, rule_json, window_opens, window_closes,
        estimator_policy, estimators_json, sufficiency_json, status, award_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (task_id) DO UPDATE SET status = excluded.status, award_json = excluded.award_json`,
  ).run(
    row.taskId,
    row.hubId,
    row.thread,
    row.correlationId,
    JSON.stringify(row.rule),
    row.windowOpens,
    row.windowCloses,
    row.estimatorPolicy,
    JSON.stringify(row.estimators),
    JSON.stringify(row.answerSufficiency),
    row.status,
    row.award === null ? null : JSON.stringify(row.award),
  );
}

export function loadAuction(db: Db, taskId: string): AuctionRow | null {
  const row = db.prepare("SELECT * FROM alloc_auctions WHERE task_id = ?").get(taskId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return {
    taskId: String(row.task_id),
    hubId: String(row.hub_id),
    thread: String(row.thread),
    correlationId: String(row.correlation_id),
    rule: JSON.parse(String(row.rule_json)),
    windowOpens: String(row.window_opens),
    windowCloses: String(row.window_closes),
    estimatorPolicy: String(row.estimator_policy) as AuctionRow["estimatorPolicy"],
    estimators: JSON.parse(String(row.estimators_json)),
    answerSufficiency: JSON.parse(String(row.sufficiency_json)),
    status: String(row.status) as AuctionRow["status"],
    award: row.award_json === null ? null : JSON.parse(String(row.award_json)),
  };
}

export function saveCommit(db: Db, taskId: string, bidder: string, commitment: string, published: string): void {
  db.prepare(
    `INSERT INTO alloc_bids (task_id, bidder, commitment, commit_published)
       VALUES (?, ?, ?, ?)
     ON CONFLICT (task_id, bidder) DO NOTHING`,
  ).run(taskId, bidder, commitment, published);
}

export function saveReveal(db: Db, taskId: string, bidder: string, payload: JsonValue, digest: string): void {
  db.prepare("UPDATE alloc_bids SET reveal_json = ?, reveal_digest = ? WHERE task_id = ? AND bidder = ?").run(
    JSON.stringify(payload),
    digest,
    taskId,
    bidder,
  );
}

export interface BidRow {
  bidder: string;
  commitment: string;
  commitPublished: string;
  reveal: { [key: string]: JsonValue } | null;
  revealDigest: string | null;
}

export function bidsFor(db: Db, taskId: string): BidRow[] {
  const rows = db.prepare("SELECT * FROM alloc_bids WHERE task_id = ? ORDER BY bidder").all(taskId) as Record<
    string,
    unknown
  >[];
  return rows.map((row) => ({
    bidder: String(row.bidder),
    commitment: String(row.commitment),
    commitPublished: String(row.commit_published),
    reveal: row.reveal_json === null ? null : JSON.parse(String(row.reveal_json)),
    revealDigest: row.reveal_digest === null ? null : String(row.reveal_digest),
  }));
}

export function saveDecline(db: Db, taskId: string, actor: string, reason: string): void {
  db.prepare(
    "INSERT INTO alloc_declines (task_id, actor, reason) VALUES (?, ?, ?) ON CONFLICT (task_id, actor) DO NOTHING",
  ).run(taskId, actor, reason);
}

export function declinesFor(db: Db, taskId: string): { actor: string; reason: string }[] {
  const rows = db.prepare("SELECT actor, reason FROM alloc_declines WHERE task_id = ? ORDER BY actor").all(taskId) as Record<string, unknown>[];
  return rows.map((row) => ({ actor: String(row.actor), reason: String(row.reason) }));
}

export function logAdmission(db: Db, at: string, taskId: string, actor: string, outcome: string, reason: string): void {
  db.prepare("INSERT INTO alloc_admissions (at, task_id, actor, outcome, reason) VALUES (?, ?, ?, ?, ?)").run(
    at,
    taskId,
    actor,
    outcome,
    reason,
  );
}

export function admissionLog(db: Db, taskId: string): { at: string; actor: string; outcome: string; reason: string }[] {
  const rows = db
    .prepare("SELECT at, actor, outcome, reason FROM alloc_admissions WHERE task_id = ? ORDER BY at")
    .all(taskId) as Record<string, unknown>[];
  return rows.map((row) => ({
    at: String(row.at),
    actor: String(row.actor),
    outcome: String(row.outcome),
    reason: String(row.reason),
  }));
}

export interface PendingAcceptRow {
  awardId: string;
  taskId: string;
  acceptBy: string;
  missing: string[];
}

export function savePendingAccept(db: Db, row: PendingAcceptRow): void {
  db.prepare(
    `INSERT INTO alloc_pending_accepts (award_id, task_id, accept_by, missing_json)
       VALUES (?, ?, ?, ?)
     ON CONFLICT (award_id) DO UPDATE SET missing_json = excluded.missing_json`,
  ).run(row.awardId, row.taskId, row.acceptBy, JSON.stringify(row.missing));
}

export function deletePendingAccept(db: Db, awardId: string): void {
  db.prepare("DELETE FROM alloc_pending_accepts WHERE award_id = ?").run(awardId);
}

export function pendingAccepts(db: Db): PendingAcceptRow[] {
  const rows = db.prepare("SELECT * FROM alloc_pending_accepts ORDER BY award_id").all() as Record<string, unknown>[];
  return rows.map((row) => ({
    awardId: String(row.award_id),
    taskId: String(row.task_id),
    acceptBy: String(row.accept_by),
    missing: JSON.parse(String(row.missing_json)),
  }));
}

export function saveSettlement(
  db: Db,
  taskId: string,
  actor: string,
  bidDigest: string,
  estimated: JsonValue,
  actual: JsonValue,
  at: string,
): void {
  db.prepare(
    `INSERT INTO alloc_settlements (task_id, actor, bid_digest, estimated_json, actual_json, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (task_id, actor) DO NOTHING`,
  ).run(taskId, actor, bidDigest, JSON.stringify(estimated), JSON.stringify(actual), at);
}
