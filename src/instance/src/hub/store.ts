/**
 * Hub-scoped persistence: tables in the instance's own SQLite file
 * (ADR-0002 Decision 1 — no second store, no broker).
 *
 * CRDT state itself lives in `src/instance/src/crdt/`'s `CRDTStore`
 * (`crdt_state` + `crdt_version_vector`, ADR-0002 Decision 5) — the hub feeds
 * every delta through it. Rounds get their own table here because a round's
 * pinned voter list and weights are the evidence a `DecisionRecord`
 * recomputation needs, not derivable state.
 *
 * The tables themselves, and the two `PRAGMA table_info`/`ALTER TABLE`
 * guards that used to backfill `hub_rounds` and `hub_vote_receipts`' later
 * columns, now live in `store/migrations/001-baseline.ts` (ADR-0032
 * Decision 4) — `openDb` runs them once, before this module ever sees the
 * database.
 */

import type { Db } from "../store/db.ts";
import type { QuorumRule } from "./quorum.ts";
import type { VotePhase } from "./equivocation.ts";

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
  /** ADR-0018 W7: ISO instant, or null/absent for "no deadline" — today's behaviour. */
  deadline?: string | null;
  /** ADR-0018 W7: the pinned bar, or null/absent for "no rule" — argmax decides as today. */
  quorumRule?: QuorumRule | null;
  /** ADR-0018 W7: 'joint', or null/absent for advisory. */
  binding?: "joint" | null;
}

export function saveRound(db: Db, row: RoundRow, now: string): void {
  db.run(
    `INSERT INTO hub_rounds
       (round_id, hub_id, proposal_id, thread, options_json, voters_json, weights_json, quorum_snapshot, proposal_hash, status, created_at, deadline, quorum_rule, binding)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (round_id) DO UPDATE SET status = excluded.status`,
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
    row.deadline ?? null,
    row.quorumRule ? JSON.stringify(row.quorumRule) : null,
    row.binding ?? null,
    );
}

export function loadRound(db: Db, roundId: string): RoundRow | null {
  const row = db.get("SELECT * FROM hub_rounds WHERE round_id = ?", roundId) as
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
    deadline: row.deadline === null || row.deadline === undefined ? null : String(row.deadline),
    quorumRule: row.quorum_rule === null || row.quorum_rule === undefined ? null : JSON.parse(String(row.quorum_rule)),
    binding: row.binding === null || row.binding === undefined ? null : (String(row.binding) as "joint"),
  };
}

/**
 * ADR-0020 W1/W2: `phase`/`seqNo` are the L1 ballot-identity tuple, absent
 * for an L0 vote -- today's behaviour, byte-identical when omitted.
 */
export function saveVoteReceipt(
  db: Db,
  roundId: string,
  actor: string,
  voteDigest: string,
  value: string,
  phase?: VotePhase,
  seqNo?: number,
): void {
  db.run(
    `INSERT INTO hub_vote_receipts (round_id, actor, vote_digest, value, phase, seq_no)
       VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (round_id, actor) DO UPDATE SET
       vote_digest = excluded.vote_digest, value = excluded.value, phase = excluded.phase, seq_no = excluded.seq_no`,
    roundId, actor, voteDigest, value, phase ?? null, seqNo ?? null);
}

export function voteReceiptsFor(db: Db, roundId: string): { actor: string; voteDigest: string; value: string }[] {
  const rows = db
    // Ordered: `closeRound` publishes these digests as `afp:countedVotes`, and
    // an unordered scan would let the same round sign different bytes on a
    // different run or a different SQLite build (H11).
    .all("SELECT actor, vote_digest, value FROM hub_vote_receipts WHERE round_id = ? ORDER BY actor", roundId) as Record<string, unknown>[];
  return rows.map((row) => ({
    actor: String(row.actor),
    voteDigest: String(row.vote_digest),
    value: String(row.value),
  }));
}

/**
 * ADR-0020 W2: the L1 tuple of the ballot currently counted for `(round,
 * actor)` -- `null` for an L0 round, whose receipts carry no phase/seqNo.
 * The counted ballot is one per voter (this table's own primary key), so a
 * vote from an *earlier* phase must never displace a later one; `onVote`
 * reads this to enforce that, while cross-phase tuple history lives in the
 * per-phase `voteact:` registers.
 */
export function countedVoteTuple(
  db: Db,
  roundId: string,
  actor: string,
): { phase: VotePhase; seqNo: number } | null {
  const row = db.get("SELECT phase, seq_no FROM hub_vote_receipts WHERE round_id = ? AND actor = ?",
    roundId, actor
  ) as { phase: string | null; seq_no: number | null } | undefined;
  if (!row || (row.phase !== "prepare" && row.phase !== "commit") || typeof row.seq_no !== "number") return null;
  return { phase: row.phase, seqNo: row.seq_no };
}

/** The open round a proposal belongs to — how a `Reject{proposal}` finds its round. */
export function roundByProposal(db: Db, proposalId: string): RoundRow | null {
  const row = db.get("SELECT round_id FROM hub_rounds WHERE proposal_id = ?", proposalId) as
    | Record<string, unknown>
    | undefined;
  return row ? loadRound(db, String(row.round_id)) : null;
}

/** ADR-0014 Decision 4: record a member's Reject of a round's proposal. */
export function saveRoundDecline(db: Db, roundId: string, actor: string, rejectDigest: string): void {
  db.run(
    `INSERT INTO hub_round_declines (round_id, actor, reject_digest)
       VALUES (?, ?, ?)
       ON CONFLICT (round_id, actor) DO NOTHING`,
    roundId, actor, rejectDigest);
}

/** Actors who declined a round, for closeRound's afp:uncounted partition. */
export function roundDeclinesFor(db: Db, roundId: string): string[] {
  return (db.all("SELECT actor FROM hub_round_declines WHERE round_id = ?", roundId) as { actor: string }[]).map(
    (row) => String(row.actor),
  );
}

// ------------------------------------------------------------------ departures (ADR-0018 W1)

/** Record a pinned voter's `afp:Departure` from a binding decision. */
export function saveDeparture(db: Db, roundId: string, actor: string, digest: string): void {
  db.run(
    `INSERT INTO hub_departures (round_id, actor, departure_digest)
       VALUES (?, ?, ?)
       ON CONFLICT (round_id, actor) DO NOTHING`,
    roundId, actor, digest);
}

/** Departures recorded for a round, for `roundDepartures`. */
export function departuresFor(db: Db, roundId: string): { actor: string; digest: string }[] {
  return (
    db.all("SELECT actor, departure_digest FROM hub_departures WHERE round_id = ?", roundId) as {
      actor: string;
      departure_digest: string;
    }[]
  ).map((row) => ({ actor: String(row.actor), digest: String(row.departure_digest) }));
}

// ------------------------------------------------------------------ hub seats (ADR-0017 D4, ADR-0037 D3)

/**
 * Seats are CRDT state (ADR-0037 Decision 3), not a table: an OR-Set keyed by
 * instance actor with the `Follow` activity id as the tag, living in
 * `crdt_state` under `(hub_id, "seats")` like every other replicated store.
 * `Hub` owns the in-memory view and the deltas; nothing here reads
 * `hub_seats` any more.
 *
 * What that buys, and why the table could not: `hub_seats` had no `hub_id`
 * column and no provenance, so it was per-database rather than per-hub, and
 * no seat it held ever reached a peer. Two replicas of one hub answered
 * `GET /hubs/:id/followers` from whatever each had happened to see, and a
 * round's electorate pinned on one could name an instance the other did not
 * know held a seat (ADR-0032's recorded follow-up; scenario 15 finding 97).
 *
 * The functions that read the old table are gone rather than kept as
 * shims — `migrations/003-seats-as-crdt.ts` moves the rows, and a shim
 * would have left a second reader of state that now has exactly one.
 */

// ------------------------------------------------------------------ convictions (ADR-0020 W1/W4)

/** Record a round-scoped conviction (an on-record `afp:EquivocationProof`) against `actor`. */
export function recordConviction(db: Db, roundId: string, actor: string, proofDigest: string): void {
  db.run(
    `INSERT INTO hub_convictions (round_id, actor, proof_digest)
       VALUES (?, ?, ?)
     ON CONFLICT (round_id, actor) DO NOTHING`,
    roundId, actor, proofDigest);
}

/** Convictions on record for a round -- the doom arithmetic's and `successor`'s zeroing set. */
export function convictionsFor(db: Db, roundId: string): { actor: string; proofDigest: string }[] {
  return (
    db.all("SELECT actor, proof_digest FROM hub_convictions WHERE round_id = ?", roundId) as {
      actor: string;
      proof_digest: string;
    }[]
  ).map((row) => ({ actor: String(row.actor), proofDigest: String(row.proof_digest) }));
}

/**
 * ADR-0021 Decision 4c: record a ratified restoration for `actor`. `now` is
 * the instant it lands, and it is compared against `hub_rounds.created_at` —
 * the same ordering `isZeroedFor` already uses, which is the only stable order
 * two round ids carry relative to each other.
 */
export function recordRestoration(db: Db, actor: string, decisionDigest: string, now: string): void {
  db.run(
    `INSERT INTO hub_restorations (actor, decision_digest, created_at)
       VALUES (?, ?, ?)
     ON CONFLICT (actor, decision_digest) DO NOTHING`,
    actor, decisionDigest, now);
}

/**
 * ADR-0021 Decision 3: does the hub hold a verified conviction of `actor`
 * carried by exactly this proof digest? The hub records a conviction only
 * after recomputing `convicts` and verifying both embedded signatures, so this
 * is a stronger question than "is a matching activity somewhere in the pool" —
 * and it is the one a proposer's declared recusal must answer before the hub
 * will sign it.
 */
export function convictionByProof(db: Db, actor: string, proofDigest: string): boolean {
  const row = db.get("SELECT 1 FROM hub_convictions WHERE actor = ? AND proof_digest = ? LIMIT 1", actor, proofDigest) as unknown;
  return row !== undefined;
}

/** Whether `actor` is convicted in `roundId`. */
export function isConvicted(db: Db, roundId: string, actor: string): boolean {
  const row = db.get("SELECT 1 FROM hub_convictions WHERE round_id = ? AND actor = ?", roundId, actor) as unknown;
  return row !== undefined;
}
