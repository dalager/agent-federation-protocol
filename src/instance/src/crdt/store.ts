/**
 * SQLite-backed CRDT store, keyed (hubId, crdtId), plus a per-store version
 * vector maintained on every write (ADR-0002 Decision 5) — so the P5 digest
 * exchange is a `SELECT`, not a migration.
 *
 * Module surface a consumer (the hub/voting layer) needs: `apply`, `getState`,
 * `versionVector`. Nothing else here is part of the contract.
 */

import type { Db } from "../store/db.ts";
import { mergeGSet } from "./gset.ts";
import { mergeLWW } from "./lww.ts";
import { mergeORSet } from "./orset.ts";
import { mergeORMap } from "./ormap.ts";
import { emptyGSet } from "./gset.ts";
import { emptyORSet } from "./orset.ts";
import { emptyORMap } from "./ormap.ts";
import type {
  AnyDelta,
  AnyState,
  CRDTDeltaEnvelope,
  CRDTType,
  GSetDelta,
  LWWDelta,
  ORMapDelta,
  ORSetDelta,
} from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS crdt_state (
  hub_id     TEXT NOT NULL,
  crdt_id    TEXT NOT NULL,
  crdt_type  TEXT NOT NULL,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (hub_id, crdt_id)
);

CREATE TABLE IF NOT EXISTS crdt_version_vector (
  hub_id  TEXT NOT NULL,
  crdt_id TEXT NOT NULL,
  actor   TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hub_id, crdt_id, actor)
);
`;

export function ensureCrdtSchema(db: Db): void {
  db.exec(SCHEMA);
}

function mergeFor(crdtType: CRDTType, state: AnyState | null, delta: AnyDelta): AnyState {
  switch (crdtType) {
    case "G_SET":
      return mergeGSet(
        (state as ReturnType<typeof emptyGSet>) ?? emptyGSet(),
        delta as GSetDelta<unknown>,
      );
    case "LWW_REGISTER":
      return mergeLWW(state as any, delta as LWWDelta<unknown>);
    case "OR_SET":
      return mergeORSet((state as any) ?? emptyORSet(), delta as ORSetDelta);
    case "OR_MAP":
      return mergeORMap((state as any) ?? emptyORMap(), delta as ORMapDelta);
  }
}

export class CRDTStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
    ensureCrdtSchema(db);
  }

  /** Merge one delta into persisted state and bump the (hub, crdtId, actor) version vector. */
  apply(envelope: CRDTDeltaEnvelope, originActor: string, now = new Date()): AnyState {
    const { hub, crdtId, crdtType, delta } = envelope;
    const before = this.getState(hub, crdtId);
    const after = mergeFor(crdtType, before, delta as AnyDelta);

    this.db
      .prepare(
        `INSERT INTO crdt_state (hub_id, crdt_id, crdt_type, state_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (hub_id, crdt_id) DO UPDATE SET state_json = excluded.state_json,
           updated_at = excluded.updated_at`,
      )
      .run(hub, crdtId, crdtType, JSON.stringify(after), now.toISOString());

    this.db
      .prepare(
        `INSERT INTO crdt_version_vector (hub_id, crdt_id, actor, count)
         VALUES (?, ?, ?, 1)
         ON CONFLICT (hub_id, crdt_id, actor) DO UPDATE SET count = count + 1`,
      )
      .run(hub, crdtId, originActor);

    return after;
  }

  getState(hubId: string, crdtId: string): AnyState | null {
    const row = this.db
      .prepare("SELECT state_json FROM crdt_state WHERE hub_id = ? AND crdt_id = ?")
      .get(hubId, crdtId) as { state_json?: string } | undefined;
    return row?.state_json ? (JSON.parse(row.state_json) as AnyState) : null;
  }

  /**
   * Every persisted store for one hub. A consumer holding in-memory views
   * rebuilds them from here on startup — the state was written on every
   * `apply`, so coming back is a `SELECT`, never a replay of the record.
   */
  crdtIds(hubId: string): { crdtId: string; crdtType: CRDTType }[] {
    const rows = this.db
      .prepare("SELECT crdt_id, crdt_type FROM crdt_state WHERE hub_id = ? ORDER BY crdt_id")
      .all(hubId) as { crdt_id: string; crdt_type: string }[];
    return rows.map((row) => ({ crdtId: String(row.crdt_id), crdtType: String(row.crdt_type) as CRDTType }));
  }

  getCrdtType(hubId: string, crdtId: string): CRDTType | null {
    const row = this.db
      .prepare("SELECT crdt_type FROM crdt_state WHERE hub_id = ? AND crdt_id = ?")
      .get(hubId, crdtId) as { crdt_type?: string } | undefined;
    return (row?.crdt_type as CRDTType | undefined) ?? null;
  }

  /** Per-actor delta counts for (hub, crdtId) — the P5 digest is a SELECT over this. */
  versionVector(hubId: string, crdtId: string): Record<string, number> {
    const rows = this.db
      .prepare("SELECT actor, count FROM crdt_version_vector WHERE hub_id = ? AND crdt_id = ?")
      .all(hubId, crdtId) as { actor: string; count: number }[];
    const out: Record<string, number> = {};
    for (const row of rows) out[row.actor] = row.count;
    return out;
  }
}
