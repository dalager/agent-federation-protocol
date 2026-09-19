/**
 * ADR-0036 Decision 2 — the `node` store adapter.
 *
 * The behaviour `store/db.ts` had before the port existed, byte for byte:
 * the same `node:sqlite` `DatabaseSync`, the same WAL and foreign-key
 * pragmas, the same one-writer lock. Nothing here is new; it moved.
 *
 * Statements are cached by their SQL text. The port takes SQL on every call
 * (so no statement type crosses it), and this adapter makes that free — the
 * same string prepares once and is reused, which is what the call sites were
 * doing by hand before, one `const stmt = db.prepare(...)` at a time.
 */

import { DatabaseSync, type StatementSync } from "node:sqlite";

import type { RunResult, SqlValue, Store } from "../port.ts";

/**
 * A store over `path`, with no lock taken and no migration run.
 *
 * `openDb` is the owning open — it takes the one-writer lock, sets the
 * pragmas and migrates. This is the other kind: a handle for a caller that
 * must read a store it does not own (the backup manifest's schema version)
 * or build one deliberately behind the migrations (a fixture at an older
 * version). Those callers used to reach for `new DatabaseSync` directly,
 * which put the runtime's handle type back on the far side of the port one
 * call site at a time.
 */
export function openNodeStore(path: string, options: { readOnly?: boolean; onClose?: () => void } = {}): Store {
  const db = options.readOnly ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path);
  return new NodeStore(db, options.onClose);
}

export class NodeStore implements Store {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private inTransaction = false;
  private readonly onClose: (() => void) | undefined;

  constructor(db: DatabaseSync, onClose?: () => void) {
    this.db = db;
    this.onClose = onClose;
  }

  /**
   * How many distinct SQL texts this adapter is holding prepared.
   *
   * Diagnostic, and the thing a gate can assert on: the cache is keyed by
   * SQL text and never evicts, which is correct only while the set of SQL
   * texts is finite. A call site that builds SQL from a variable-length
   * placeholder list breaks that quietly, and the count is how a test sees
   * it happening.
   */
  get preparedCount(): number {
    return this.statements.size;
  }

  private stmt(sql: string): StatementSync {
    let cached = this.statements.get(sql);
    if (!cached) {
      cached = this.db.prepare(sql);
      this.statements.set(sql, cached);
    }
    return cached;
  }

  exec(sql: string): void {
    // DDL invalidates cached statements: a prepared SELECT over a table an
    // ALTER just reshaped is a stale plan, and migrations run through here.
    this.statements.clear();
    this.db.exec(sql);
  }

  run(sql: string, ...params: SqlValue[]): RunResult {
    return this.stmt(sql).run(...(params as never[])) as RunResult;
  }

  get<T = unknown>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.stmt(sql).get(...(params as never[])) as T | undefined;
  }

  all<T = unknown>(sql: string, ...params: SqlValue[]): T[] {
    return this.stmt(sql).all(...(params as never[])) as T[];
  }

  transaction<T>(fn: () => T): T {
    // Nesting reuses the outer transaction (port contract): SQLite has no
    // nested BEGIN, and a savepoint would promise a partial rollback the
    // port does not offer.
    if (this.inTransaction) return fn();
    this.db.exec("BEGIN");
    this.inTransaction = true;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* a rollback that fails must not mask the error that caused it */
      }
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  close(): void {
    this.statements.clear();
    this.db.close();
    this.onClose?.();
  }
}
