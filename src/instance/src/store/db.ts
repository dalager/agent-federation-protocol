/**
 * The state store: one SQLite file holding the outbox, both dedupe layers, the
 * pending-task table and the delivery queue.
 *
 * One file is a deliberate choice, not a convenience — "export the outbox" has
 * to stay a file copy for the sneakernet property in 06.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "../runtime/log.ts";

const log = logger("store/db");

export type Db = DatabaseSync;

/**
 * ADR-0031 Decision 4: one writer, enforced. `openDb` and this set together
 * hold the property "at most one live `Db` per path, in this process or any
 * other" — the in-process half so a second `openDb` of the same path in the
 * same process is refused too, not only a second process.
 */
const openPaths = new Set<string>();

export class StoreLocked extends Error {
  constructor(path: string, pid: number) {
    super(`store at ${path} is locked by pid ${pid} — a resident process already holds it (ADR-0031 Decision 4)`);
    this.name = "StoreLocked";
  }
}

function lockPathFor(dbPath: string): string {
  return `${dbPath}.lock`;
}

function pidIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM is "alive, owned by someone else" — the one case a takeover
    // would be exactly the second writer this lock exists to refuse.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Take the lock file beside `dbPath`, or throw `StoreLocked`. A lock naming a
 * dead pid is stale — taken over with a warn line rather than refused, since
 * a crashed process's lock must not brick the data directory forever.
 */
function acquireLock(dbPath: string): void {
  const lockPath = lockPathFor(dbPath);
  if (existsSync(lockPath)) {
    const held = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number; openedAt: string };
    if (pidIsAlive(held.pid) && held.pid !== process.pid) {
      throw new StoreLocked(dbPath, held.pid);
    }
    if (held.pid !== process.pid) {
      log.warn("taking over stale lock", { path: lockPath, deadPid: held.pid });
    }
  }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, openedAt: new Date().toISOString() }));
}

function releaseLock(dbPath: string): void {
  try {
    rmSync(lockPathFor(dbPath), { force: true });
  } catch {
    /* best-effort: a missing lock file at close time is not an error */
  }
}

const SCHEMA = `
-- Append-only activity log, one hash chain per actor.
CREATE TABLE IF NOT EXISTS outbox (
  activity_id   TEXT PRIMARY KEY,
  actor         TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  thread        TEXT,
  digest        TEXT NOT NULL,          -- sha256:<hex> over the canonical activity
  prev_activity TEXT,                   -- NULL only for an actor's first activity
  visibility    TEXT NOT NULL,
  published     TEXT NOT NULL,
  activity_json TEXT NOT NULL,
  UNIQUE (actor, seq)
);

-- Received deliveries, by recipient inbox path (ADR-0017 Decision 3): what a
-- GET on an inbox serves to its owner. Admission already happened at the gate;
-- this is the record of it, not a second judgment.
CREATE TABLE IF NOT EXISTS inbox_log (
  activity_id   TEXT NOT NULL,
  recipient     TEXT NOT NULL,          -- the inbox path the delivery hit
  activity_json TEXT NOT NULL,
  received_at   TEXT NOT NULL,
  PRIMARY KEY (activity_id, recipient)
);

-- Layer 1 of 2: transport dedupe. A redelivered activity id never reaches dispatch.
CREATE TABLE IF NOT EXISTS seen_ids (
  activity_id TEXT PRIMARY KEY,
  seen_at     TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS seen_ids_expires ON seen_ids (expires_at);

-- Layer 2 of 2: task-level replay, keyed by correlationId rather than activity id.
CREATE TABLE IF NOT EXISTS pending_tasks (
  correlation_id TEXT PRIMARY KEY,
  thread         TEXT NOT NULL,
  delegator      TEXT NOT NULL,
  performer      TEXT NOT NULL,
  deadline       TEXT,
  state          TEXT NOT NULL,         -- offered | accepted | completed | failed
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- Cached outcomes so a repeated correlationId replays instead of re-executing.
CREATE TABLE IF NOT EXISTS task_results (
  correlation_id TEXT PRIMARY KEY,
  performer      TEXT NOT NULL,
  activity_id    TEXT NOT NULL,
  activity_json  TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

-- Delivery queue. Backoff and dead-lettering are a query, not a broker.
CREATE TABLE IF NOT EXISTS delivery_queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id     TEXT NOT NULL,
  target          TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  state           TEXT NOT NULL,        -- pending | delivered | dead
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  activity_json   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_queue_ready ON delivery_queue (state, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_outbox_actor ON outbox (actor, seq);
CREATE INDEX IF NOT EXISTS idx_outbox_thread ON outbox (thread);

-- Rejected and duplicate deliveries. An activity that fails the pipeline is
-- audit-logged and dropped, never silently discarded (04 § Security).
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  outcome     TEXT NOT NULL,          -- rejected | duplicate
  activity_id TEXT,
  actor       TEXT,
  reason      TEXT NOT NULL
);

-- Artifact index. The bytes live on disk under their own digest.
CREATE TABLE IF NOT EXISTS artifacts (
  digest     TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  size       INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  -- Provenance for evidence that entered from outside AFP (07 § Artifacts).
  source_url TEXT,
  fetched_at TEXT
);

-- ADR-0031 Decision 6: a per-peer minimum next-attempt time, set from a
-- peer's own Retry-After — independent of any one queue item's backoff, so
-- a 429 from one peer never touches the schedule for any other.
CREATE TABLE IF NOT EXISTS peer_backoff (
  target      TEXT PRIMARY KEY,
  not_before  INTEGER NOT NULL
);
`;

/**
 * ADR-0031 Decision 4: one writer, enforced. A file path is opened at most
 * once live at a time — in this process (the `openPaths` set) or any other
 * (the `<path>.lock` file, holding the owning pid). `:memory:` needs no lock:
 * it is never shared across a restart or a second process by construction.
 */
export function openDb(path: string): Db {
  if (path === ":memory:") {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(SCHEMA);
    return db;
  }

  if (openPaths.has(path)) {
    throw new StoreLocked(path, process.pid);
  }
  mkdirSync(dirname(path), { recursive: true });
  acquireLock(path);
  openPaths.add(path);

  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);

  const nativeClose = db.close.bind(db);
  db.close = () => {
    nativeClose();
    openPaths.delete(path);
    releaseLock(path);
  };
  return db;
}
