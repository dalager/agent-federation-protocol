/**
 * Versioned, forward-only schema migrations (ADR-0032 Decision 4).
 *
 * A `schema_version` table replaces the `ALTER TABLE` guard ADR-0004 H13
 * named as a stand-in for real migrations. Migrations are numbered files
 * under this directory, applied in order at startup inside one transaction
 * each, and never edited once shipped — the ADR-0027 "one door" property
 * applied to the store's own shape, not just its writers. A store whose
 * recorded version exceeds what this binary knows refuses to open, named,
 * rather than guessing at a schema it has never seen.
 */

import type { Db } from "../db.ts";
import { MIGRATION_001 } from "./001-baseline.ts";
import { MIGRATION_002 } from "./002-restore-points.ts";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: (db: Db) => void;
}

/** The binary's known migrations, in shipping order. Never reorder or edit a shipped entry — add a new one. */
export const MIGRATIONS: readonly Migration[] = [MIGRATION_001, MIGRATION_002];

export class StoreNewerThanBinary extends Error {
  constructor(storeVersion: number, binaryVersion: number) {
    super(
      `store is at schema version ${storeVersion}, but this binary only knows migrations up to version ` +
        `${binaryVersion} (ADR-0032 Decision 4) — refusing to open a store written by a newer version`,
    );
    this.name = "StoreNewerThanBinary";
  }
}

function ensureVersionTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL,
      name       TEXT NOT NULL
    );
  `);
}

/** The highest version recorded in `schema_version`, or 0 for a store that has never migrated. */
function currentVersion(db: Db): number {
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null };
  return row.v ?? 0;
}

/**
 * Apply every migration in `migrations` newer than the store's recorded
 * version, each inside its own transaction (rolled back whole on a throw),
 * in ascending version order, recording each as it commits. Exposed
 * separately from `migrate` so a test can pass its own migration list.
 */
export function migrateWith(db: Db, migrations: readonly Migration[]): { from: number; to: number } {
  ensureVersionTable(db);
  const from = currentVersion(db);
  const binaryVersion = migrations.reduce((max, m) => Math.max(max, m.version), 0);
  if (from > binaryVersion) {
    throw new StoreNewerThanBinary(from, binaryVersion);
  }

  const pending = migrations.filter((m) => m.version > from).sort((a, b) => a.version - b.version);
  let to = from;
  for (const migration of pending) {
    db.exec("BEGIN");
    try {
      migration.up(db);
      db.prepare("INSERT INTO schema_version (version, applied_at, name) VALUES (?, ?, ?)").run(
        migration.version,
        new Date().toISOString(),
        migration.name,
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    to = migration.version;
  }
  return { from, to };
}

/** Apply every migration this binary knows about that the store hasn't seen yet. */
export function migrate(db: Db): { from: number; to: number } {
  return migrateWith(db, MIGRATIONS);
}
