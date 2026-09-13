/**
 * Migration 001 — the baseline schema (ADR-0032 Decision 4).
 *
 * This is every table six separate `CREATE TABLE IF NOT EXISTS` blocks used
 * to create on their own schedule — `store/db.ts`'s core tables, federation's
 * `fed_*`, allocation's `alloc_*`, the hub's `hub_*`, dedupe's
 * `seen_signatures`, and the CRDT store's `crdt_*` — moved here verbatim,
 * plus `peer_backoff`. One door, one schema (ADR-0027): a sixth site
 * creating tables of its own is exactly the drift this ADR closes, so
 * `crdt/store.ts` joins the rest here rather than staying the exception.
 * `IF NOT EXISTS` is kept here, and only here: a store written before this ADR has
 * every one of these tables already and no `schema_version` row, so this
 * migration must land on it without error — that is the legacy-store case
 * the ADR-0032 gate proves. Every migration after this one is plain DDL,
 * with no `IF NOT EXISTS` guard, because there is no pre-schema-version store
 * left to be compatible with.
 *
 * The columns three `ALTER TABLE ... ADD COLUMN` guards used to add in place
 * (`alloc_auctions`: ADR-0004 H13; `hub_rounds` and `hub_vote_receipts`:
 * ADR-0018 W7 / ADR-0020 W1-2) are folded straight into the `CREATE TABLE`
 * below, so a fresh store gets them from the start. For a legacy store whose
 * tables already exist without them, `up()` below re-runs the same
 * column-by-column checks the guards used to run, so a database from any
 * shipped revision ends this migration with the full column set.
 */

import type { Db } from "../db.ts";
import type { Migration } from "./index.ts";

const SCHEMA = `
-- store/db.ts: the outbox, both dedupe layers, the pending-task table and
-- the delivery queue.

-- Append-only activity log, one hash chain per actor.
CREATE TABLE IF NOT EXISTS outbox (
  activity_id   TEXT PRIMARY KEY,
  actor         TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  thread        TEXT,
  digest        TEXT NOT NULL,          -- sha256:<hex> over the canonical activity
  prev_activity TEXT,                   -- NULL only for an actor's first activity
  visibility    TEXT NOT NULL,
  published     TEXT NOT NULL,
  activity_json TEXT NOT NULL,
  UNIQUE (actor, seq)
);

-- Received deliveries, by recipient inbox path (ADR-0017 Decision 3): what a
-- GET on an inbox serves to its owner. Admission already happened at the gate;
-- this is the record of it, not a second judgment.
CREATE TABLE IF NOT EXISTS inbox_log (
  activity_id   TEXT NOT NULL,
  recipient     TEXT NOT NULL,          -- the inbox path the delivery hit
  activity_json TEXT NOT NULL,
  received_at   TEXT NOT NULL,
  PRIMARY KEY (activity_id, recipient)
);

-- Layer 1 of 2: transport dedupe. A redelivered activity id never reaches dispatch.
CREATE TABLE IF NOT EXISTS seen_ids (
  activity_id TEXT PRIMARY KEY,
  seen_at     TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS seen_ids_expires ON seen_ids (expires_at);

-- Layer 2 of 2: task-level replay, keyed by correlationId rather than activity id.
CREATE TABLE IF NOT EXISTS pending_tasks (
  correlation_id TEXT PRIMARY KEY,
  thread         TEXT NOT NULL,
  delegator      TEXT NOT NULL,
  performer      TEXT NOT NULL,
  deadline       TEXT,
  state          TEXT NOT NULL,         -- offered | accepted | completed | failed
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- Cached outcomes so a repeated correlationId replays instead of re-executing.
CREATE TABLE IF NOT EXISTS task_results (
  correlation_id TEXT PRIMARY KEY,
  performer      TEXT NOT NULL,
  activity_id    TEXT NOT NULL,
  activity_json  TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

-- Delivery queue. Backoff and dead-lettering are a query, not a broker.
CREATE TABLE IF NOT EXISTS delivery_queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id     TEXT NOT NULL,
  target          TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  state           TEXT NOT NULL,        -- pending | delivered | dead
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  activity_json   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_queue_ready ON delivery_queue (state, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_outbox_actor ON outbox (actor, seq);
CREATE INDEX IF NOT EXISTS idx_outbox_thread ON outbox (thread);

-- Rejected and duplicate deliveries. An activity that fails the pipeline is
-- audit-logged and dropped, never silently discarded (04 § Security).
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  outcome     TEXT NOT NULL,          -- rejected | duplicate
  activity_id TEXT,
  actor       TEXT,
  reason      TEXT NOT NULL
);

-- Artifact index. The bytes live on disk under their own digest.
CREATE TABLE IF NOT EXISTS artifacts (
  digest     TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  size       INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  -- Provenance for evidence that entered from outside AFP (07 § Artifacts).
  source_url TEXT,
  fetched_at TEXT
);

-- ADR-0031 Decision 6: a per-peer minimum next-attempt time, set from a
-- peer's own Retry-After — independent of any one queue item's backoff, so
-- a 429 from one peer never touches the schedule for any other.
CREATE TABLE IF NOT EXISTS peer_backoff (
  target      TEXT PRIMARY KEY,
  not_before  INTEGER NOT NULL
);

-- store/dedupe.ts: ADR-0025 Decision 7's signed-request replay cache.
CREATE TABLE IF NOT EXISTS seen_signatures (
  fingerprint TEXT PRIMARY KEY,
  seen_at     TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS seen_signatures_expires ON seen_signatures (expires_at);

-- federation/federation.ts (ADR-0008): agreements, admitted cross-boundary
-- activity/correlation records, the deny-list, and the boundary log.
CREATE TABLE IF NOT EXISTS fed_agreements (
  digest            TEXT PRIMARY KEY,   -- digest of the agreement OBJECT: its identity
  object_json       TEXT NOT NULL,
  counterparty      TEXT NOT NULL,      -- the other instance actor
  own_create_json   TEXT,               -- our signed Create, once published
  their_create_json TEXT,               -- theirs, once received through the inbox
  expires           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fed_received (
  digest        TEXT PRIMARY KEY,
  from_instance TEXT NOT NULL,
  at            TEXT NOT NULL,
  activity_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fed_accepts (
  correlation_id TEXT PRIMARY KEY,
  counterparty   TEXT NOT NULL,
  published      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fed_denylist (
  instance TEXT PRIMARY KEY,
  at       TEXT NOT NULL,
  reason   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fed_boundary_log (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  actor        TEXT NOT NULL,
  claimed_type TEXT NOT NULL,
  step         TEXT NOT NULL,           -- signature | agreement | denylist | operated-by
  reason       TEXT NOT NULL,
  activity_digest TEXT NOT NULL,
  entry_hash   TEXT NOT NULL            -- sha256(JCS(entry sans hash) + prev entry_hash)
);

-- allocation/store.ts (ADR-0003 Decision 1): the auction, bidding and
-- settlement tables. reputation_json, snapshot_json and excluded_prior_json
-- are the columns the ADR-0004 H13 ALTER TABLE guard used to add in place;
-- folded into the CREATE here for a fresh store, and added below for a
-- legacy one.
CREATE TABLE IF NOT EXISTS alloc_auctions (
  task_id        TEXT PRIMARY KEY,
  hub_id         TEXT NOT NULL,
  thread         TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  rule_json      TEXT NOT NULL,
  window_opens   TEXT NOT NULL,
  window_closes  TEXT NOT NULL,
  estimator_policy TEXT NOT NULL,       -- exclude | permit-and-record
  estimators_json  TEXT NOT NULL,
  sufficiency_json TEXT NOT NULL,
  status         TEXT NOT NULL,         -- bidding | awarded | reauctioned | failed
  award_json     TEXT,
  requester      TEXT,                   -- ADR-0004: the announcing actor when a requester/member announced; the settlement's counterparty
  reputation_json      TEXT,            -- ADR-0004 Decision 3: the pinned reputation derivation, or NULL when opted out
  snapshot_json         TEXT,           -- the settlement digests pinned at announce time
  excluded_prior_json   TEXT            -- ADR-0006: prior task ids whose Award performers are excluded from this auction
);

-- Outstanding Accepts per award — the P1 deadline-sweep pattern needs its
-- state in SQLite, or an award timeout would not survive a restart
-- (ADR-0003 Decision 4).
CREATE TABLE IF NOT EXISTS alloc_pending_accepts (
  award_id     TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL,
  accept_by    TEXT NOT NULL,
  missing_json TEXT NOT NULL
);

-- One row per (task, bidder): the commit lands first, the reveal joins it.
CREATE TABLE IF NOT EXISTS alloc_bids (
  task_id          TEXT NOT NULL,
  bidder           TEXT NOT NULL,
  commitment       TEXT NOT NULL,
  commit_published TEXT NOT NULL,
  reveal_json      TEXT,
  reveal_digest    TEXT,
  PRIMARY KEY (task_id, bidder)
);

-- Declining is a record; silence is not (03).
CREATE TABLE IF NOT EXISTS alloc_declines (
  task_id TEXT NOT NULL,
  actor   TEXT NOT NULL,
  reason  TEXT NOT NULL,
  PRIMARY KEY (task_id, actor)
);

-- Admission-time rejections, audit-logged (Decision 6).
CREATE TABLE IF NOT EXISTS alloc_admissions (
  at      TEXT NOT NULL,
  task_id TEXT NOT NULL,
  actor   TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason  TEXT NOT NULL
);

-- One row per emitted afp:Settlement activity: its digest, published time and
-- full object — what an announce's afp:settlementSnapshot pins and what the
-- divergence-decay derivation resolves at award time (ADR-0004 Decision 3).
CREATE TABLE IF NOT EXISTS alloc_settlement_records (
  digest      TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  published   TEXT NOT NULL,
  object_json TEXT NOT NULL
);

-- Estimates linked to actuals; divergence visible, consumption deferred (Decision 5).
CREATE TABLE IF NOT EXISTS alloc_settlements (
  task_id     TEXT NOT NULL,
  actor       TEXT NOT NULL,
  bid_digest  TEXT NOT NULL,
  estimated_json TEXT NOT NULL,
  actual_json    TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (task_id, actor)
);

-- crdt/store.ts (ADR-0002 Decision 5): per-(hub, crdtId) state, the
-- version vector maintained on every write, and the ADR-0016 Decision 4
-- provenance table a digest shortfall resolves against.
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

-- ADR-0016 Decision 4: which activity moved which store, per origin. Ids,
-- never bytes — one copy of every state change, living where it always did
-- (the author's signed record); this table only points into it, so a
-- version-vector shortfall resolves to the activities that produced it.
-- Derivable by construction: it can be rebuilt from the record it points into.
CREATE TABLE IF NOT EXISTS crdt_provenance (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  hub_id      TEXT NOT NULL,
  crdt_id     TEXT NOT NULL,
  actor       TEXT NOT NULL,
  activity_id TEXT NOT NULL
);

-- hub/store.ts (ADR-0002 Decision 1): rounds and the hub's own membership
-- and accountability tables. deadline, quorum_rule and binding on
-- hub_rounds (ADR-0018 W7), and phase/seq_no on hub_vote_receipts
-- (ADR-0020 W1-2), are the columns the two PRAGMA table_info / ALTER TABLE
-- guards used to add in place; folded into the CREATE here, and added below
-- for a legacy store.
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
  created_at     TEXT NOT NULL,
  deadline       TEXT,                   -- ADR-0018 W7: ISO instant, nullable
  quorum_rule    TEXT,                   -- ADR-0018 W7: JSON QuorumRule, nullable
  binding        TEXT                    -- ADR-0018 W7: 'joint', nullable
);

-- The G-Set of counted vote receipts, one row per (round, voter) — evidence-set
-- completeness (ADR-0002 Decision 3 check 2) is "every hash here resolves to a
-- present, validly signed Vote in the outbox."
CREATE TABLE IF NOT EXISTS hub_vote_receipts (
  round_id    TEXT NOT NULL,
  actor       TEXT NOT NULL,
  vote_digest TEXT NOT NULL,
  value       TEXT NOT NULL,
  phase       TEXT,                      -- ADR-0020 W1-2: nullable, L1-only
  seq_no      INTEGER,                   -- ADR-0020 W1-2: nullable, L1-only
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

-- ADR-0018 W1/W7: one row per pinned voter who publishes an afp:Departure
-- from a binding decision -- mirrors hub_round_declines exactly.
CREATE TABLE IF NOT EXISTS hub_departures (
  round_id         TEXT NOT NULL,
  actor            TEXT NOT NULL,
  departure_digest TEXT NOT NULL,
  PRIMARY KEY (round_id, actor)
);

-- ADR-0020 W1/W4: one row per voter convicted in a round -- the zeroing
-- table. A conviction zeroes that voter's weight for the round's own doom
-- arithmetic (Decision 4) and blocks it from successor() (Decision 3); it
-- never shrinks the pinned electorate itself (Decision 4's denominator
-- ruling).
CREATE TABLE IF NOT EXISTS hub_convictions (
  round_id     TEXT NOT NULL,
  actor        TEXT NOT NULL,
  proof_digest TEXT NOT NULL,
  PRIMARY KEY (round_id, actor)
);

-- ADR-0021 Decision 4c: a restoration is a membership act like any other, and
-- it is forward-scoped. A ratified governance round whose outcome actuates
-- an afp:MemberAdmit restores the named agent's weight for rounds pinned AFTER
-- the decision landed — never retroactively, and never by re-tallying a closed
-- round, whose DecisionRecord is signed history. ADR-0020's forward-scoping
-- rule run in the other direction: neither conviction nor forgiveness reaches
-- backwards into a signed record.
CREATE TABLE IF NOT EXISTS hub_restorations (
  actor          TEXT NOT NULL,
  decision_digest TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (actor, decision_digest)
);
`;

/**
 * The ADR-0004 H13 guard, reproduced for a legacy `alloc_auctions` that
 * predates it: only the already-applied case is swallowed, exactly as the
 * guard's own comment required — a bare catch here would equally hide a
 * locked or corrupt store behind a silently missing column.
 */
function legacyAllocColumns(db: Db): void {
  for (const column of ["requester TEXT", "reputation_json TEXT", "snapshot_json TEXT", "excluded_prior_json TEXT"]) {
    try {
      db.exec(`ALTER TABLE alloc_auctions ADD COLUMN ${column}`);
    } catch (error) {
      if (!/duplicate column name/i.test((error as Error).message)) throw error;
    }
  }
}

/** The ADR-0018 W7 / ADR-0020 W1-2 guards, reproduced for a legacy `hub_rounds` / `hub_vote_receipts`. */
function legacyHubColumns(db: Db): void {
  const existingRoundCols = new Set(
    (db.prepare("PRAGMA table_info(hub_rounds)").all() as { name: string }[]).map((col) => col.name),
  );
  for (const [column, ddl] of [
    ["deadline", "deadline TEXT"],
    ["quorum_rule", "quorum_rule TEXT"],
    ["binding", "binding TEXT"],
  ] as const) {
    if (!existingRoundCols.has(column)) db.exec(`ALTER TABLE hub_rounds ADD COLUMN ${ddl}`);
  }

  const existingVoteReceiptCols = new Set(
    (db.prepare("PRAGMA table_info(hub_vote_receipts)").all() as { name: string }[]).map((col) => col.name),
  );
  for (const [column, ddl] of [
    ["phase", "phase TEXT"],
    ["seq_no", "seq_no INTEGER"],
  ] as const) {
    if (!existingVoteReceiptCols.has(column)) db.exec(`ALTER TABLE hub_vote_receipts ADD COLUMN ${ddl}`);
  }
}

export const MIGRATION_001: Migration = {
  version: 1,
  name: "001-baseline",
  up(db: Db): void {
    db.exec(SCHEMA);
    legacyAllocColumns(db);
    legacyHubColumns(db);
  },
};
