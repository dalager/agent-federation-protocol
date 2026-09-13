/**
 * Migration 002 — `restore_points` (ADR-0032 Decision 5).
 *
 * The first real forward migration this binary ships: `BINARY_SCHEMA_VERSION`
 * becomes 2. `afp restore` records one row here after a restore completes —
 * the point ADR-0020 Decision 2 ruled on: a restored instance can receive a
 * same-value duplicate vote after this instant, and that is a state-loss
 * event to explain, not equivocation to accuse. No `IF NOT EXISTS` — this
 * migration lands only on a store that has already run 001, so the table
 * cannot already exist.
 */

import type { Db } from "../db.ts";
import type { Migration } from "./index.ts";

const SCHEMA = `
CREATE TABLE restore_points (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  restored_at    TEXT NOT NULL,
  backup_taken_at TEXT NOT NULL,
  origin         TEXT NOT NULL,
  note           TEXT
);
`;

export const MIGRATION_002: Migration = {
  version: 2,
  name: "restore-points",
  up(db: Db): void {
    db.exec(SCHEMA);
  },
};
