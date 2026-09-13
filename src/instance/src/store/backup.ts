/**
 * ADR-0032 Decision 5: backup and restore, as commands.
 *
 * `backupStore` uses `node:sqlite`'s online backup API against the live
 * WAL-mode store — a consistent snapshot copied while `serve` still holds
 * the write lock, unlike `cp`'s torn-file risk on a live database (the
 * operator's-Tuesday wart this ADR closes). `restoreStore` refuses to
 * overwrite a live store or clobber an existing one without `--force`,
 * verifies the backup opens and migrates on a scratch copy before touching
 * anything, and then records a `restore_points` row — ADR-0020 Decision 2's
 * restore point, so a same-value duplicate vote observed after this instant
 * is explained by the log rather than mistaken for equivocation.
 *
 * Keys are never touched here (ADR-0026 Decision 6): `keyDir` is backed up,
 * if at all, by a separate runbook — this module only ever reads `dbPath`
 * and `artifactDir`.
 */

import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { logger } from "../runtime/log.ts";
import { openDb, lockHolder, BINARY_SCHEMA_VERSION, schemaVersion } from "./db.ts";

const log = logger("store/backup");

export class RestoreRefused extends Error {}

export interface BackupManifest {
  readonly takenAt: string;
  readonly origin: string;
  readonly schemaVersion: number;
  readonly artifacts: number;
}

export interface BackupOptions {
  readonly dbPath: string;
  readonly artifactDir: string;
  readonly origin: string;
}

function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) walk(path);
      else count += 1;
    }
  };
  walk(dir);
  return count;
}

/**
 * Writes `<dir>/afp.db` (a consistent online-backup snapshot), `<dir>/artifacts`
 * (a plain recursive copy — the artifact store is content-addressed and
 * write-once, so a live copy race is not the torn-file risk the database
 * backup exists to avoid), and `<dir>/BACKUP.json`. Refuses if `<dir>` exists
 * and is non-empty.
 */
export async function backupStore(dir: string, options: BackupOptions): Promise<BackupManifest> {
  const target = resolve(dir);
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new RestoreRefused(`backup target ${target} already exists and is not empty`);
  }
  mkdirSync(target, { recursive: true });

  // Opened read-side against the live store: `backup()` reads a consistent
  // snapshot straight off the WAL-mode source without needing exclusive
  // access, so this runs fine alongside a `serve` holding the store's lock.
  const source = new DatabaseSync(options.dbPath, { readOnly: true });
  try {
    await sqliteBackup(source, join(target, "afp.db"));
  } finally {
    source.close();
  }

  const artifactsOut = join(target, "artifacts");
  if (existsSync(options.artifactDir)) {
    cpSync(options.artifactDir, artifactsOut, { recursive: true });
  } else {
    mkdirSync(artifactsOut, { recursive: true });
  }

  // The restored copy's own version, read without holding any lock beyond
  // this brief open — the point of the manifest is "what version was this",
  // not "what version is the live store right now".
  const check = new DatabaseSync(join(target, "afp.db"), { readOnly: true });
  const version = schemaVersion(check);
  check.close();

  const manifest: BackupManifest = {
    takenAt: new Date().toISOString(),
    origin: options.origin,
    schemaVersion: version,
    artifacts: countFiles(artifactsOut),
  };
  writeFileSync(join(target, "BACKUP.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  log.info("backup complete", { dir: target, ...manifest });
  // ADR-0026 Decision 6: keys are a separate runbook, on purpose.
  log.info("reminder: keys were not backed up — see the Key custody runbook (ADR-0026 Decision 6)");
  return manifest;
}

export interface RestoreOptions {
  readonly dbPath: string;
  readonly artifactDir: string;
  readonly origin: string;
  readonly force?: boolean;
}

/**
 * The pid holding `dbPath`, or undefined. Read from the lock, never by
 * opening the store: an open would run the target's pending migrations as
 * a side effect of asking whether it is live — before the `--force`
 * decision has even been made.
 */
function isLive(dbPath: string): number | undefined {
  return lockHolder(resolve(dbPath)) ?? undefined;
}

/**
 * Restores `<dir>` (a `backupStore` output) into `dbPath`/`artifactDir`.
 * Refuses a live target (named pid) unconditionally, and an existing target
 * unless `force` is set. Verifies the backup opens and migrates on a scratch
 * copy first, so a corrupt backup is refused before anything real is
 * touched. Records a `restore_points` row after the swap.
 */
export function restoreStore(dir: string, options: RestoreOptions): { restoredAt: string; manifest: BackupManifest } {
  const source = resolve(dir);
  const backupDbPath = join(source, "afp.db");
  if (!existsSync(backupDbPath)) {
    throw new RestoreRefused(`${source} does not look like an afp backup — no afp.db`);
  }
  const manifest = JSON.parse(readFileSync(join(source, "BACKUP.json"), "utf8")) as BackupManifest;

  const livePid = isLive(options.dbPath);
  if (livePid !== undefined) {
    throw new RestoreRefused(`refusing to restore over a live store — held by pid ${livePid} (ADR-0031 Decision 4)`);
  }
  if (existsSync(options.dbPath) && !options.force) {
    throw new RestoreRefused(`${options.dbPath} already exists — pass --force to overwrite`);
  }

  // Verify on a scratch copy: a corrupt or unmigratable backup must be
  // refused before the real store is replaced, not discovered after.
  const scratchDir = mkdtempSync(join(tmpdir(), "afp-restore-verify-"));
  try {
    const scratchDb = join(scratchDir, "afp.db");
    cpSync(backupDbPath, scratchDb);
    try {
      const db = openDb(scratchDb);
      db.close();
    } catch (error) {
      throw new RestoreRefused(`backup at ${source} does not open/migrate cleanly: ${(error as Error).message}`);
    }
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }

  mkdirSync(resolve(options.dbPath, ".."), { recursive: true });
  // A backup-API file carries no -wal/-shm sidecars, so a plain copy is the
  // whole store — clear any stale sidecars from a previous store first.
  for (const suffix of ["", "-wal", "-shm", ".lock"]) {
    rmSync(`${options.dbPath}${suffix}`, { force: true });
  }
  cpSync(backupDbPath, options.dbPath);

  rmSync(options.artifactDir, { recursive: true, force: true });
  const backupArtifacts = join(source, "artifacts");
  if (existsSync(backupArtifacts)) {
    cpSync(backupArtifacts, options.artifactDir, { recursive: true });
  } else {
    mkdirSync(options.artifactDir, { recursive: true });
  }

  // ADR-0020 Decision 2: the restore point. A same-value duplicate vote
  // observed after this instant is a state-loss event this row explains,
  // not equivocation to accuse.
  const restoredAt = new Date().toISOString();
  const db = openDb(options.dbPath);
  try {
    if (schemaVersion(db) < BINARY_SCHEMA_VERSION) {
      throw new RestoreRefused(
        `restored store is at schema version ${schemaVersion(db)}, expected ${BINARY_SCHEMA_VERSION} — this should not happen after openDb's own migration`,
      );
    }
    db.prepare(
      "INSERT INTO restore_points (restored_at, backup_taken_at, origin, note) VALUES (?, ?, ?, ?)",
    ).run(restoredAt, manifest.takenAt, options.origin, `restored from ${source}`);
  } finally {
    db.close();
  }

  log.info("restore complete", { dir: source, restoredAt });
  log.info(
    "reminder: exports under exportDir are not restored — where they go is the operator's retention duty (ADR-0012)",
  );
  return { restoredAt, manifest };
}
