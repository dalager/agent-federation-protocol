-- A pre-ADR-0032 `afp.db`: every table as all six modules' own
-- `CREATE TABLE IF NOT EXISTS` blocks produced them at commit 6bdd9c2
-- ("ADR-0031: the resident process"), the last commit before schema
-- creation was unified into store/migrations/. No `schema_version` table —
-- that is the point: this is the store WP-2's legacy-store gate proves 001
-- lands on cleanly. The three later-guarded columns (alloc_auctions'
-- reputation_json/snapshot_json/excluded_prior_json, hub_rounds'
-- deadline/quorum_rule/binding, hub_vote_receipts' phase/seq_no) are
-- deliberately omitted — the ALTER TABLE guards existed exactly because a
-- store this old lacks them.

-- store/db.ts
CREATE TABLE IF NOT EXISTS outbox (
  activity_id   TEXT PRIMARY KEY,
  actor         TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  thread        TEXT,
  digest        TEXT NOT NULL,
  prev_activity TEXT,
  visibility    TEXT NOT NULL,
  published     TEXT NOT NULL,
  activity_json TEXT NOT NULL,
  UNIQUE (actor, seq)
);

CREATE TABLE IF NOT EXISTS inbox_log (
  activity_id   TEXT NOT NULL,
  recipient     TEXT NOT NULL,
  activity_json TEXT NOT NULL,
  received_at   TEXT NOT NULL,
  PRIMARY KEY (activity_id, recipient)
);

CREATE TABLE IF NOT EXISTS seen_ids (
  activity_id TEXT PRIMARY KEY,
  seen_at     TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS seen_ids_expires ON seen_ids (expires_at);

CREATE TABLE IF NOT EXISTS pending_tasks (
  correlation_id TEXT PRIMARY KEY,
  thread         TEXT NOT NULL,
  delegator      TEXT NOT NULL,
  performer      TEXT NOT NULL,
  deadline       TEXT,
  state          TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_results (
  correlation_id TEXT PRIMARY KEY,
  performer      TEXT NOT NULL,
  activity_id    TEXT NOT NULL,
  activity_json  TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS delivery_queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id     TEXT NOT NULL,
  target          TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  state           TEXT NOT NULL,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  activity_json   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_queue_ready ON delivery_queue (state, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_outbox_actor ON outbox (actor, seq);
CREATE INDEX IF NOT EXISTS idx_outbox_thread ON outbox (thread);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  outcome     TEXT NOT NULL,
  activity_id TEXT,
  actor       TEXT,
  reason      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  digest     TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  size       INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  source_url TEXT,
  fetched_at TEXT
);

CREATE TABLE IF NOT EXISTS peer_backoff (
  target      TEXT PRIMARY KEY,
  not_before  INTEGER NOT NULL
);

-- store/dedupe.ts
CREATE TABLE IF NOT EXISTS seen_signatures (
  fingerprint TEXT PRIMARY KEY,
  seen_at     TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS seen_signatures_expires ON seen_signatures (expires_at);

-- federation/federation.ts
CREATE TABLE IF NOT EXISTS fed_agreements (
  digest            TEXT PRIMARY KEY,
  object_json       TEXT NOT NULL,
  counterparty      TEXT NOT NULL,
  own_create_json   TEXT,
  their_create_json TEXT,
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
  step         TEXT NOT NULL,
  reason       TEXT NOT NULL,
  activity_digest TEXT NOT NULL,
  entry_hash   TEXT NOT NULL
);

-- allocation/store.ts (pre-guard: no reputation_json/snapshot_json/excluded_prior_json)
CREATE TABLE IF NOT EXISTS alloc_auctions (
  task_id        TEXT PRIMARY KEY,
  hub_id         TEXT NOT NULL,
  thread         TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  rule_json      TEXT NOT NULL,
  window_opens   TEXT NOT NULL,
  window_closes  TEXT NOT NULL,
  estimator_policy TEXT NOT NULL,
  estimators_json  TEXT NOT NULL,
  sufficiency_json TEXT NOT NULL,
  status         TEXT NOT NULL,
  award_json     TEXT,
  requester      TEXT
);

CREATE TABLE IF NOT EXISTS alloc_pending_accepts (
  award_id     TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL,
  accept_by    TEXT NOT NULL,
  missing_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alloc_bids (
  task_id          TEXT NOT NULL,
  bidder           TEXT NOT NULL,
  commitment       TEXT NOT NULL,
  commit_published TEXT NOT NULL,
  reveal_json      TEXT,
  reveal_digest    TEXT,
  PRIMARY KEY (task_id, bidder)
);

CREATE TABLE IF NOT EXISTS alloc_declines (
  task_id TEXT NOT NULL,
  actor   TEXT NOT NULL,
  reason  TEXT NOT NULL,
  PRIMARY KEY (task_id, actor)
);

CREATE TABLE IF NOT EXISTS alloc_admissions (
  at      TEXT NOT NULL,
  task_id TEXT NOT NULL,
  actor   TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alloc_settlement_records (
  digest      TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  published   TEXT NOT NULL,
  object_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alloc_settlements (
  task_id     TEXT NOT NULL,
  actor       TEXT NOT NULL,
  bid_digest  TEXT NOT NULL,
  estimated_json TEXT NOT NULL,
  actual_json    TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (task_id, actor)
);

-- crdt/store.ts
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

CREATE TABLE IF NOT EXISTS crdt_provenance (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  hub_id      TEXT NOT NULL,
  crdt_id     TEXT NOT NULL,
  actor       TEXT NOT NULL,
  activity_id TEXT NOT NULL
);

-- hub/store.ts (pre-guard: no deadline/quorum_rule/binding, no phase/seq_no)
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
  status         TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hub_vote_receipts (
  round_id    TEXT NOT NULL,
  actor       TEXT NOT NULL,
  vote_digest TEXT NOT NULL,
  value       TEXT NOT NULL,
  PRIMARY KEY (round_id, actor)
);

CREATE TABLE IF NOT EXISTS hub_round_declines (
  round_id       TEXT NOT NULL,
  actor          TEXT NOT NULL,
  reject_digest  TEXT NOT NULL,
  PRIMARY KEY (round_id, actor)
);

CREATE TABLE IF NOT EXISTS hub_seats (
  instance_actor TEXT PRIMARY KEY,
  follow_activity TEXT NOT NULL,
  followed_at     TEXT NOT NULL,
  revoked_at      TEXT
);

CREATE TABLE IF NOT EXISTS hub_departures (
  round_id         TEXT NOT NULL,
  actor            TEXT NOT NULL,
  departure_digest TEXT NOT NULL,
  PRIMARY KEY (round_id, actor)
);

CREATE TABLE IF NOT EXISTS hub_convictions (
  round_id     TEXT NOT NULL,
  actor        TEXT NOT NULL,
  proof_digest TEXT NOT NULL,
  PRIMARY KEY (round_id, actor)
);

CREATE TABLE IF NOT EXISTS hub_restorations (
  actor          TEXT NOT NULL,
  decision_digest TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (actor, decision_digest)
);
