/**
 * The state store: one SQLite file holding the outbox, both dedupe layers, the
 * pending-task table and the delivery queue.
 *
 * One file is a deliberate choice, not a convenience — "export the outbox" has
 * to stay a file copy for the sneakernet property in 06.
 *
 * ADR-0032 Decision 4: every table any module needs comes through this one
 * door — `openDb` runs `migrate()` after the lock and the PRAGMAs, and no
 * other module `CREATE TABLE`s or `ALTER TABLE`s its own tables into
 * existence any more. One door, one schema, mirroring the ADR-0027 "one
 * door" property for the store's shape itself.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "../runtime/log.ts";
import { migrate, MIGRATIONS } from "./migrations/index.ts";

export { StoreNewerThanBinary } from "./migrations/index.ts";

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

/**
 * Who holds `dbPath` right now, without opening it: this process (the
 * in-process set), a live foreign process (its lock file), or nobody
 * (`null`). A stale lock naming a dead pid reads as nobody. `restoreStore`
 * asks this instead of `openDb`, because opening the target would run its
 * migrations as a side effect of merely checking whether it is live.
 */
export function lockHolder(dbPath: string): number | null {
  if (openPaths.has(dbPath)) return process.pid;
  const lockPath = lockPathFor(dbPath);
  if (!existsSync(lockPath)) return null;
  try {
    const held = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number };
    return pidIsAlive(held.pid) ? held.pid : null;
  } catch {
    return null;
  }
}

function releaseLock(dbPath: string): void {
  try {
    rmSync(lockPathFor(dbPath), { force: true });
  } catch {
    /* best-effort: a missing lock file at close time is not an error */
  }
}

/** The highest schema version this binary knows how to migrate to. */
export const BINARY_SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

/** The schema version a store is currently at (0 for one that has never migrated). */
export function schemaVersion(db: Db): number {
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null } | undefined;
  return row?.v ?? 0;
}

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
    migrate(db);
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
  try {
    migrate(db);
  } catch (error) {
    // A refused open (StoreNewerThanBinary, or a failed migration) must not
    // leave the lock behind for the pid that never got to hold it.
    db.close();
    openPaths.delete(path);
    releaseLock(path);
    throw error;
  }

  const nativeClose = db.close.bind(db);
  db.close = () => {
    nativeClose();
    openPaths.delete(path);
    releaseLock(path);
  };
  return db;
}
