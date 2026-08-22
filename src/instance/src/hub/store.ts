/**
 * Hub-scoped persistence: new tables in the instance's own SQLite file
 * (ADR-0002 Decision 1 — no second store, no broker).
 *
 * CRDT state itself lives in `src/instance/src/crdt/`'s `CRDTStore`
 * (`crdt_state` + `crdt_version_vector`, ADR-0002 Decision 5) — the hub feeds
 * every delta through it. Rounds get their own table here because a round's
 * pinned voter list and weights are the evidence a `DecisionRecord`
 * recomputation needs, not derivable state.
 */

import type { Db } from "../store/db.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS hub_rounds (
  round_id       TEXT PRIMARY KEY,
  hub_id         TEXT NOT NULL,
  proposal_id    TEXT NOT NULL,
  thread         TEXT NOT NULL,
  options_json   TEXT NOT NULL,
  voters_json    TEXT NOT NULL,
  weights_json   TEXT NOT NULL,
  quorum_snapshot TEXT NOT NULL,
  proposal_hash  TEXT NOT NULL,
  status         TEXT NOT NULL,          -- open | closed
  created_at     TEXT NOT NULL
);

-- The G-Set of counted vote receipts, one row per (round, voter) — evidence-set
-- completeness (ADR-0002 Decision 3 check 2) is "every hash here resolves to a
-- present, validly signed Vote in the outbox."
CREATE TABLE IF NOT EXISTS hub_vote_receipts (
  round_id    TEXT NOT NULL,
  actor       TEXT NOT NULL,
  vote_digest TEXT NOT NULL,
  value       TEXT NOT NULL,
  PRIMARY KEY (round_id, actor)
);

-- ADR-0014 Decision 4: a recorded Reject of a round's proposal — what lets a
-- DecisionRecord tell "declined" from "silent" when it lists the snapshot
-- members no vote was counted from. Kept apart from vote receipts on purpose:
-- a decline is participation without assent, never a ballot, and closeRound
-- must not count it as one.
CREATE TABLE IF NOT EXISTS hub_round_declines (
  round_id       TEXT NOT NULL,
  actor          TEXT NOT NULL,
  reject_digest  TEXT NOT NULL,
  PRIMARY KEY (round_id, actor)
);

-- ADR-0017 Decision 4: a live seat is an instance's active Follow of this hub
-- -- the gate seatPolicy "follow-required" checks before admitting an Enroll.
-- revoked_at NULL means live; re-Following after Undo revives the same row
-- rather than inserting a second one, so a seat's history is one row with
-- two timestamps, not a trail to replay.
CREATE TABLE IF NOT EXISTS hub_seats (
  instance_actor TEXT PRIMARY KEY,
  follow_activity TEXT NOT NULL,
  followed_at     TEXT NOT NULL,
  revoked_at      TEXT
);
`;

export function ensureHubSchema(db: Db): void {
  db.exec(SCHEMA);
}

export interface RoundRow {
  roundId: string;
  hubId: string;
  proposalId: string;
  thread: string;
  options: string[];
  voters: string[];
  weights: Record<string, number>;
  quorumSnapshot: string;
  proposalHash: string;
  status: "open" | "closed";
}

export function saveRound(db: Db, row: RoundRow, now: string): void {
  db.prepare(
    `INSERT INTO hub_rounds
       (round_id, hub_id, proposal_id, thread, options_json, voters_json, weights_json, quorum_snapshot, proposal_hash, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (round_id) DO UPDATE SET status = excluded.status`,
  ).run(
    row.roundId,
    row.hubId,
    row.proposalId,
    row.thread,
    JSON.stringify(row.options),
    JSON.stringify(row.voters),
    JSON.stringify(row.weights),
    row.quorumSnapshot,
    row.proposalHash,
    row.status,
    now,
  );
}

export function loadRound(db: Db, roundId: string): RoundRow | null {
  const row = db.prepare("SELECT * FROM hub_rounds WHERE round_id = ?").get(roundId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return {
    roundId: String(row.round_id),
    hubId: String(row.hub_id),
    proposalId: String(row.proposal_id),
    thread: String(row.thread),
    options: JSON.parse(String(row.options_json)),
    voters: JSON.parse(String(row.voters_json)),
    weights: JSON.parse(String(row.weights_json)),
    quorumSnapshot: String(row.quorum_snapshot),
    proposalHash: String(row.proposal_hash),
    status: String(row.status) as "open" | "closed",
  };
}

export function saveVoteReceipt(db: Db, roundId: string, actor: string, voteDigest: string, value: string): void {
  db.prepare(
    `INSERT INTO hub_vote_receipts (round_id, actor, vote_digest, value)
       VALUES (?, ?, ?, ?)
     ON CONFLICT (round_id, actor) DO UPDATE SET vote_digest = excluded.vote_digest, value = excluded.value`,
  ).run(roundId, actor, voteDigest, value);
}

export function voteReceiptsFor(db: Db, roundId: string): { actor: string; voteDigest: string; value: string }[] {
  const rows = db
    // Ordered: `closeRound` publishes these digests as `afp:countedVotes`, and
    // an unordered scan would let the same round sign different bytes on a
    // different run or a different SQLite build (H11).
    .prepare("SELECT actor, vote_digest, value FROM hub_vote_receipts WHERE round_id = ? ORDER BY actor")
    .all(roundId) as Record<string, unknown>[];
  return rows.map((row) => ({
    actor: String(row.actor),
    voteDigest: String(row.vote_digest),
    value: String(row.value),
  }));
}

/** The open round a proposal belongs to — how a `Reject{proposal}` finds its round. */
export function roundByProposal(db: Db, proposalId: string): RoundRow | null {
  const row = db.prepare("SELECT round_id FROM hub_rounds WHERE proposal_id = ?").get(proposalId) as
    | Record<string, unknown>
    | undefined;
  return row ? loadRound(db, String(row.round_id)) : null;
}

/** ADR-0014 Decision 4: record a member's Reject of a round's proposal. */
export function saveRoundDecline(db: Db, roundId: string, actor: string, rejectDigest: string): void {
  db.prepare(
    `INSERT INTO hub_round_declines (round_id, actor, reject_digest)
       VALUES (?, ?, ?)
       ON CONFLICT (round_id, actor) DO NOTHING`,
  ).run(roundId, actor, rejectDigest);
}

/** Actors who declined a round, for closeRound's afp:uncounted partition. */
export function roundDeclinesFor(db: Db, roundId: string): string[] {
  return (db.prepare("SELECT actor FROM hub_round_declines WHERE round_id = ?").all(roundId) as { actor: string }[]).map(
    (row) => String(row.actor),
  );
}

// ------------------------------------------------------------------ hub seats (ADR-0017 D4)

/** Record a live seat for `actor` (its own Follow's activity id). Revives a revoked row on re-Follow. */
export function saveSeat(db: Db, actor: string, followActivityId: string, at: string): void {
  db.prepare(
    `INSERT INTO hub_seats (instance_actor, follow_activity, followed_at, revoked_at)
       VALUES (?, ?, ?, NULL)
     ON CONFLICT (instance_actor) DO UPDATE SET
       follow_activity = excluded.follow_activity,
       followed_at = excluded.followed_at,
       revoked_at = NULL`,
  ).run(actor, followActivityId, at);
}

/** Mark `actor`'s seat revoked (Undo{Follow}). No-op if it holds no seat. */
export function revokeSeat(db: Db, actor: string, at: string): void {
  db.prepare("UPDATE hub_seats SET revoked_at = ? WHERE instance_actor = ?").run(at, actor);
}

/** Instance actor ids with a live (unrevoked) seat. */
export function liveSeats(db: Db): string[] {
  return (
    db.prepare("SELECT instance_actor FROM hub_seats WHERE revoked_at IS NULL").all() as { instance_actor: string }[]
  ).map((row) => String(row.instance_actor));
}

/** Whether `actor` currently holds a live seat. */
export function hasSeat(db: Db, actor: string): boolean {
  const row = db.prepare("SELECT revoked_at FROM hub_seats WHERE instance_actor = ?").get(actor) as
    | { revoked_at: string | null }
    | undefined;
  return !!row && row.revoked_at === null;
}

/** The Follow activity id backing `actor`'s seat row (live or revoked), or null. */
export function seatFollowActivity(db: Db, actor: string): string | null {
  const row = db.prepare("SELECT follow_activity FROM hub_seats WHERE instance_actor = ?").get(actor) as
    | { follow_activity: string }
    | undefined;
  return row ? String(row.follow_activity) : null;
}

/** The instance actor whose live seat's Follow carries this activity id, or null. */
export function seatByFollowActivity(db: Db, followActivityId: string): string | null {
  const row = db
    .prepare("SELECT instance_actor FROM hub_seats WHERE follow_activity = ? AND revoked_at IS NULL")
    .get(followActivityId) as { instance_actor: string } | undefined;
  return row ? String(row.instance_actor) : null;
}
