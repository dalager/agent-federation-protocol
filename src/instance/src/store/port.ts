/**
 * ADR-0036 Decision 2 — the store port.
 *
 * `store/db.ts` was already the one door (ADR-0027/ADR-0032 D4). This makes
 * it a *port*: bound parameters and plain SQL in, rows out, and no cursor,
 * statement or pragma type from either runtime crossing it. Two adapters
 * implement it — `adapters/node.ts` over `node:sqlite` (the behaviour this
 * codebase already had, byte for byte) and, when the hosted profile lands,
 * one over a platform actor's SQL API.
 *
 * The shape is deliberately four verbs and a transaction rather than a
 * statement object. A `prepare()` that handed back a statement would put the
 * runtime's own statement type on the port's surface, which is the leak the
 * signer port (ADR-0026) spent 158 sites learning to avoid. Adapters are free
 * to cache prepared statements behind `sql` — the node one does — because
 * that is an implementation of the port, not a term in it.
 *
 * **A row is a property bag, and its prototype is unspecified.** The node
 * adapter hands back `node:sqlite`'s own null-prototype objects, and it does
 * so deliberately: normalising every row through a spread would cost one
 * allocation per row on every read to buy a property no consumer in this
 * codebase uses. A consumer reads columns off a row and MUST NOT call a
 * prototype method on it, compare it with `deepStrictEqual` against a plain
 * object literal, or pass it somewhere that will. A second adapter is free
 * to return plain objects; neither choice is a difference a consumer may
 * observe, which is exactly what makes it safe to leave unspecified.
 */

/** What may cross the port as a bound parameter. Anything else is the caller's bug. */
export type SqlValue = string | number | bigint | boolean | null | Uint8Array;

export interface RunResult {
  readonly changes: number | bigint;
  readonly lastInsertRowid: number | bigint;
}

export interface Store {
  /** DDL and pragmas — no parameters, no rows. Migrations run through this. */
  exec(sql: string): void;
  /** One statement, no rows read back. */
  run(sql: string, ...params: SqlValue[]): RunResult;
  /** The first row, or `undefined` — never `null`. */
  get<T = unknown>(sql: string, ...params: SqlValue[]): T | undefined;
  /** Every row, in the statement's own order. */
  all<T = unknown>(sql: string, ...params: SqlValue[]): T[];
  /**
   * Run `fn` inside one transaction, committing on return and rolling back on
   * throw. Nesting reuses the outer transaction rather than opening a second:
   * an adapter over a platform that has no nested-transaction primitive must
   * still honour the call, and a savepoint is not the same guarantee.
   */
  transaction<T>(fn: () => T): T;
  close(): void;
}
