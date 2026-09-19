/**
 * Migration 003 — seats become replicated state (ADR-0037 Decision 3).
 *
 * `hub_seats` was a plain table: one row per instance actor, a `revoked_at`
 * column for the tombstone, no `hub_id` and no provenance. That made it
 * per-database rather than per-hub, and made it invisible to the exchange —
 * nothing it held ever reached a peer, so two replicas of one hub answered
 * `GET /hubs/:id/followers` from whatever each had happened to see. This
 * migration moves what the table holds into `crdt_state` under
 * `(hub_id, "seats")` as an OR-Set — instance actor as element, the `Follow`
 * activity id as the tag, a revoked seat's tag tombstoned — which is the
 * shape membership has always used, and drops the table.
 *
 * Which hub the rows belong to: `crdt_state` already names every hub this
 * store holds state for, and before this ADR a store could hold at most one
 * (a hub was a library an embedding program constructed, one per program).
 * So the rows move when there is exactly one such hub, and when there is not
 * — no hub at all, or the store of a program that ran several — they are
 * dropped with the table rather than guessed at. A seat that does not
 * survive is re-established by a `Follow`, which is a live instance's
 * ordinary business and leaves the record honest; a seat moved to the wrong
 * hub would not be.
 */

import type { Db } from "../db.ts";
import type { Migration } from "./index.ts";

interface SeatRow {
  instance_actor: string;
  follow_activity: string;
  revoked_at: string | null;
}

/** `{ elementTags, tombstones }` — `crdt/orset.ts`'s `ORSetState`, built here without importing it. */
function seatState(rows: readonly SeatRow[]): { elementTags: Record<string, string[]>; tombstones: Record<string, string[]> } {
  const elementTags: Record<string, string[]> = {};
  const tombstones: Record<string, string[]> = {};
  for (const row of rows) {
    const actor = String(row.instance_actor);
    const tag = String(row.follow_activity);
    (elementTags[actor] ??= []).push(tag);
    if (row.revoked_at !== null) (tombstones[actor] ??= []).push(tag);
  }
  return { elementTags, tombstones };
}

export const MIGRATION_003: Migration = {
  version: 3,
  name: "seats-as-crdt",
  up(db: Db): void {
    const rows = db.all("SELECT instance_actor, follow_activity, revoked_at FROM hub_seats") as SeatRow[];
    const hubs = (db.all("SELECT DISTINCT hub_id FROM crdt_state") as { hub_id: string }[]).map((row) =>
      String(row.hub_id),
    );

    if (rows.length > 0 && hubs.length === 1) {
      db.run(
        `INSERT INTO crdt_state (hub_id, crdt_id, crdt_type, state_json, updated_at)
           VALUES (?, 'seats', 'OR_SET', ?, ?)
         ON CONFLICT (hub_id, crdt_id) DO UPDATE SET state_json = excluded.state_json,
           updated_at = excluded.updated_at`,
        hubs[0], JSON.stringify(seatState(rows)), new Date().toISOString());
      // No `crdt_provenance` rows: provenance names the signed activity a
      // delta was derived from, and this migration derives from a table, not
      // from the record. A migrated seat therefore does not itself sync —
      // the peer that never saw the Follow learns it when the Follow is
      // re-sent or re-issued, and the counts stay honest about what this
      // store can actually produce the bytes for (ADR-0016 Decision 4).
    }

    db.exec("DROP TABLE hub_seats;");
  },
};
