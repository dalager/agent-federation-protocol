# ADR-0002 — Technology stack for P2

- **Status:** Accepted, then **confirmed under implementation** — see
  [Revised under contact](#revised-under-contact). No decision was reversed;
  four precisions were forced, all recorded there.
- **Date:** 2026-08-18
- **Applies to:** [P2 — Local hub & L0 deliberation](../05-roadmap.md#p2p7)
- **Builds on:** [ADR-0001](0001-p1-stack.md) — P1's stack decisions are inherited
  unchanged; this ADR only covers what P2 adds

## Context

P2's deliverable is not federation — it's still one operator — but it introduces a new
kind of participant (`afp:Hub`), a new state class (hub-scoped CRDTs), and a new record
type (`afp:DecisionRecord` closing a weighted-quorum vote). Per [05](../05-roadmap.md),
P2 has **no federation dependency**: everything below runs on one operator's own fleet,
with the hub as a local route beside the agents rather than a remote service.

Working backwards from P2's gate ("any member recomputes the weight tally from the
recorded `countedVotes` and agrees; a vote missing from the tally is detectable from the
record alone"), the stack has to be good at:

| Requirement | Stack consequence |
|---|---|
| `afp:Hub` as an actor other actors address | Same signed-activity plumbing as P1 — no new transport |
| Two-level enrollment ([02](../02-hubs-and-state.md#enrollment-is-two-level-deliberately)) | `Follow`/`Accept` + `afp:Enroll` as ordinary signed activities; `afp:hubKey` touches the key store |
| Hub-scoped CRDT stores | A CRDT library or a small hand-rolled implementation — four types, enumerated below |
| L0 weighted-quorum voting, snapshot-pinned membership | No new crypto — reuses `eddsa-jcs-2022` object integrity proofs on `afp:Vote` and `afp:DecisionRecord` |
| "A vote missing from the tally is detectable from the record alone" | A replicated receipt set (`G-Set`) **and** a verifier extension — evidence-set completeness, not just arithmetic |
| Hub lifecycle (`Freeze`/`Archive`) | State-machine on the hub actor's own record, no new mechanism |
| Still no network | **No broker, no separate hub process, no containers** — same "P1 infra should be zero" argument, one phase later |

Note what remains absent: P2 has no `FederationAgreement`, no cross-operator gossip, no
authorized fetch. The hub is local. Everything here is additive to P1's record shape —
per P1 gate check 11, nothing about the hub's wiring may leak into the record.

## Decisions

### 1. Hub runtime: same process, same stack as P1 — no new runtime

P1 landed with **zero dependencies**: `node:sqlite`, `node:crypto`, hand-rolled AS2/AFP
plumbing (ADR-0001, "Revised under contact"). The hub actor is not a new service; it is
another actor dispatched in the same instance process, backed by the same SQLite file.
Introducing a second runtime (a broker, a separate hub server) for a phase whose own gate
explicitly has no federation dependency would be paying P4/P5's operational cost early
for no P2 benefit — the same argument ADR-0001 made against Postgres and message brokers
at P1, applied one phase later.

**We adopt:** the hub actor lives in-process, in the same Node/TypeScript codebase,
persisted in the same SQLite database as agent outboxes, with new tables for hub-scoped
CRDT state, membership, and vote records.

*Implementation constraint carried from P1 gate check 11:* the hub module reaches agents
only through the same dispatch port the agents use to reach each other. Nothing in a hub
activity, actor document, or CRDT delta may encode in-process addressing — a P2 record
must be indistinguishable in shape from one produced by a hub running as a separate
federated service.

### 2. CRDTs: hand-rolled, not a library — all four spec types

The per-hub state model ([02](../02-hubs-and-state.md#shared-state-as-crdts)) enumerates
**four** stores, all keyed `(hubId, crdtType)`:

| State | CRDT | Merge rule | P2 role |
|---|---|---|---|
| Capability registry | `OR-Map<agentId, OR-Set<capability>>` | add/remove-wins via unique tags + tombstones | Populated by `afp:Enroll` |
| Agent liveness / load | `LWW-Register` of `{status, load, lastSeen}` | highest timestamp wins, nodeId tiebreak | Feeds vote weight |
| Hub membership | `OR-Set<AgentRef>` (join-epoch tagged) | add/remove-wins | The set `afp:quorumSnapshot` pins |
| Vote receipts (L0) | `G-Set` of signed receipts | set union | **Gate-critical** — see Decision 3 |

The receipt `G-Set` is not optional bookkeeping: [04](../04-operations.md#audit--provenance)
requires the signed vote set preserved in the hub CRDT and *replicated to every
participant* — that replication is what makes "a vote missing from the tally" detectable
from the record alone, which is P2's gate verbatim. (The `G-Counter` tally variant in 02's
table is a derived convenience; the receipts are the evidence. P2 implements the `G-Set`
and computes tallies from it.)

A general-purpose CRDT library (Yjs, Automerge) brings a much larger surface — text
CRDTs, RGA sequences, a binary sync protocol — none of which P2 needs, and would
reintroduce exactly the "vendor's internal model becomes our model" problem ADR-0001
found with Fedify's vocabulary. These four types are the *simple* end of the CRDT
spectrum: `G-Set` is set union, `LWW-Register` is a timestamp comparison, and the
OR-Set/OR-Map pair is tag-and-tombstone bookkeeping — a couple hundred lines total, no
more novel than the JCS canonicalization P1 already hand-rolled, and each merge function
is independently property-testable (commutative, associative, idempotent — the three
properties [02](../02-hubs-and-state.md) names, which is the P2 test suite writing
itself).

**We adopt:** four hand-rolled CRDT merge functions operating on deltas carried in signed
`Update{afp:CRDTDelta}` activities (required `afp:hub` field, per 02) — no external CRDT
library.

*Revisit trigger:* if P5 or an application-defined store needs a CRDT type outside these
four (a sequence/text CRDT, for instance), reconsider a library for that type at that
point — not before there's a concrete need.

### 3. Voting and DecisionRecord: no new crypto — but a real verifier extension

L0 weighted-quorum voting produces `afp:Vote` activities and a closing
`afp:DecisionRecord` / `afp:GovernanceDecision`. All are signed AS2-shaped activities
like everything else in the record — `eddsa-jcs-2022` object integrity proofs, the same
per-actor `afp:prevActivity` chain, the same visibility and digest obligations from P1.
There is no case for a second signature suite, a voting-specific crypto library, or a
consensus protocol (Raft, PBFT): L0 is weighted-quorum tallying over signed votes pinned
to a membership snapshot, not Byzantine consensus — that's L1, deferred to P6 with its
own trigger ("≥2 operators live in a hub"), and [03](../03-coordination.md#consensus-hardening--level-1)
itself documents why Raft can't ride this transport.

**No new crypto does not mean no new verification logic.** [04](../04-operations.md#replay-procedure)
step 7 extends the replay procedure, and the independent Python verifier must implement
all of it:

1. **Tally recomputation** — recompute `afp:weightTally` from the referenced votes and
   match the `DecisionRecord`.
2. **Evidence-set completeness** — every hash in `afp:countedVotes` must resolve to a
   present, validly signed `Vote`; *"a counted vote you cannot produce is a failure."*
3. **Snapshot discipline** — every counted vote validates against the pinned
   `afp:quorumSnapshot`; a vote from an actor outside the pinned set is rejected even if
   validly signed (the mid-round-enrollment defense from
   [02](../02-hubs-and-state.md#membership--dynamic-quorum)).

This is set-membership checking and arithmetic, not cryptography — the *verifier stays
dependency-light* property ADR-0001 bought is preserved — but it is new logic in both
implementations, and P2's acceptance test should mutate a record all three ways
(mis-tallied weight, a counted-but-deleted vote, a vote from outside the snapshot),
mirroring P1's four-mutation gate.

**Vote weight at P2:** [02](../02-hubs-and-state.md#membership--dynamic-quorum) derives
weight from liveness plus hub-scoped reputation. Reputation machinery arrives with P3
(bidding/settlement). At P2, weight = liveness-gated uniform weight (live members weigh
1.0, others 0), read from the LWW liveness register at snapshot time and **recorded
explicitly in the proposal** so the tally recomputation never depends on state the
verifier can't see. The weight *formula* is hub policy; the record carries its *inputs
and outputs*.

**We adopt:** `afp:Vote` and `afp:DecisionRecord` as ordinary signed activities;
liveness-gated uniform weights at P2; the three-check verifier extension above in both
the TypeScript instance and the Python verifier.

### 4. Enrollment: existing activity plumbing, one addition to the key store

The roadmap's P2 scope includes enrollment, and [02](../02-hubs-and-state.md#enrollment-is-two-level-deliberately)
specifies it two-level: instance `Follow`/`Accept` for the governance seat, then a signed
`afp:Enroll` per agent carrying hub-scoped capabilities. Neither needs new machinery —
they are ordinary signed activities feeding the membership OR-Set and capability OR-Map.

The one stack-relevant field is **`afp:hubKey`**: a per-agent, per-hub verification
method. P1's key store holds one signing key per actor; P2 extends it to
`(actorId, hubId?) → key`, with hub-scoped keys published in the agent's actor document
alongside the P1 `assertionMethod` key. This is a schema change to the key table and a
loop in the actor-document builder — not a new mechanism — but it belongs in this ADR
because retrofitting key scoping after keys are published is exactly the kind of
cannot-backfill change the roadmap's "four obligations" logic warns about.

**We adopt:** enrollment as plain signed activities; the key store extended to optional
hub scope; `afp:Unenroll` and `Undo{Follow}` as the removal path, tombstoning through
the OR-Set like any other removal.

### 5. Gossip / anti-entropy: deferred until it's needed

[02](../02-hubs-and-state.md#gossip--anti-entropy) describes digest exchange
(Merkle root or version-vector) for converging CRDT state across *multiple instances*.
At P2, one operator, this degenerates: there is exactly one writer per agent and the hub
sees every delta directly, so a reconciliation loop has no P2 caller and could not be
meaningfully tested against real divergence.

What P2 **does** build is everything that makes the loop cheap later: deltas as discrete
signed activities (so replay *is* re-merge), idempotent merges (so duplicate delivery is
free), and a per-store version vector maintained on write (so the P5 digest is a `SELECT`,
not a migration). The `Offer{afp:Digest}` / `Accept{afp:StateDeltas}` exchange itself
waits for P5, where divergent replicas actually exist.

**We adopt:** direct delta delivery to the hub for P2; version vectors maintained from
the first delta; the reconciliation exchange deferred to P5.

## Options considered

| Option | Rejected because |
|---|---|
| Yjs / Automerge for CRDT state | General-purpose libraries built for collaborative text/structured editing; P2 needs four simple set/map/register types, and adopting either imports a much larger model (and a binary sync protocol P2 doesn't use) for no P2 benefit |
| Separate hub process/service now | No federation dependency exists yet per the P2 gate; a second process is P4/P5's cost paid early with no P2 benefit, mirroring ADR-0001's rejection of a message broker at P1 |
| Raft/PBFT for L0 voting | L0 is weighted-quorum tallying, not Byzantine fault tolerance; that machinery is explicitly L1/P6, gated on a multi-operator trigger that doesn't exist at P2 — and 03 already rejects Raft for this transport (no delivery acks) |
| Real reputation-weighted votes at P2 | Reputation inputs (bid-vs-actual, settlements) don't exist until P3; inventing a placeholder reputation now would put unverifiable numbers into DecisionRecords. Liveness-gated uniform weight is honest and recomputable |
| Full anti-entropy/gossip loop built now | Degenerates to a no-op with one writer per agent and a single local hub; real payoff arrives at P5 with actual cross-instance divergence to reconcile |
| Postgres for hub-scoped state | Same reasoning as ADR-0001 Decision 4 — no P2 benefit, breaks "the export is a file copy," and P2 is still one operator on one machine |

## Consequences

**Positive**

- P2 ships with the same "no dependencies, no build step, `npm run demo`" property P1
  landed with — the hub is additive code, not additive infrastructure.
- The record shape stays uniform: enrollment, votes, deltas and decisions are signed
  activities like everything else, so P1's replay procedure extends rather than forks.
- The CRDT merge properties (commutative/associative/idempotent) and the three verifier
  checks give P2 a gate as mechanical as P1's: property-test the merges, mutation-test
  the DecisionRecord three ways.
- Version vectors and delta-as-activity from day one make P5's anti-entropy an addition,
  not a migration.

**Negative / accepted risks**

- Hand-rolled CRDTs are a second hand-rolled primitive (after JCS canonicalization) this
  codebase now owns and must keep correct — mitigated by the four types being the simple
  end of the spectrum, with spec-defined merge rules and property tests.
- P2 votes carry uniform weights, so the demo ("30 agents agree on the best policy")
  exercises tally mechanics but not weight *differentiation*; the first
  reputation-weighted round happens at P3. The record format already carries explicit
  weights, so nothing changes shape when it does.
- Deferring the digest/anti-entropy exchange means P5 inherits the implementation — a
  real but bounded cost, and P5 inherits maintained version vectors rather than a cold
  start.
- The `(actorId, hubId?)` key-store extension is a P1 schema migration — small, but it
  touches the one store whose published outputs (actor documents) cannot be republished
  differently later without changing their shape.

**Revisit triggers**

| Trigger | Reconsider |
|---|---|
| A CRDT type outside G-Set/LWW/OR-Set/OR-Map is needed (e.g. by an application-defined store) | Decision 2 — adopt a library for that type only, keep the protocol's own four hand-rolled |
| P3 lands settlements/reputation | Decision 3's uniform weights — swap the weight formula, record shape unchanged |
| P5 shared hubs across operators | Decision 5 — build the digest/anti-entropy reconciliation exchange over the maintained version vectors |
| P6 L1 trigger fires (≥2 operators live in a hub) | Decision 3 — L1's chained-vote/equivocation machinery is additive, not a replacement for L0 |
| Hub becomes a genuine bottleneck for one operator's own fleet | Decision 1 — revisit in-process dispatch; P2's own gate gives no evidence this is needed yet |

## Revised under contact

P2 was implemented immediately after acceptance, by three parallel agents
(CRDT module, hub/voting, verifier extension) merged by a single integration
owner. Unlike ADR-0001, no decision reversed — but four precisions were
forced, and two of them were exactly the cross-implementation divergences the
two-implementation rule exists to catch.

### Proposal field names — standardized on `afp:voters` + `afp:voterWeights`

The hub and the Python verifier were built in parallel and disagreed on the
proposal's field names (`afp:weights` vs `afp:voterWeights`). Standardized per
02's snapshot-pinning language: the proposal carries the explicit voter list
as **`afp:voters`** and the per-voter weights as **`afp:voterWeights`**; a
verifier pins the voter set from `afp:voters`, falling back to the weight
map's keys.

### The verifier had two real algorithm gaps — found by the TS→Python end-to-end

The Python-built fixtures masked two divergences that replaying a *real*
TypeScript-produced export exposed:

- **Wrapped payloads.** 03 wraps payloads in standard AS2 activities
  (`Offer{afp:Proposal}`, `Create{afp:Vote}`, `Create{afp:DecisionRecord}`);
  the fixtures used bare `afp:*` activities and the verifier only matched
  those. It now unwraps both shapes.
- **Abstain by omission.** A pinned voter with no counted vote contributes
  its weight under `"abstain"` (04's own DecisionRecord example carries the
  key), and zero-filled options are not a mismatch. The tally recomputation
  now compares over the key union with default 0.

The acceptance suite therefore includes a genuine end-to-end check: the gate
exports a real hub round — hub outbox included — and shells out to the Python
verifier, which replays it clean and runs all three decision checks.

### The hub goes on the record like anyone else

Replay authority for the hub's `DecisionRecord` comes from the record, not
from a verifier special case: the instance **vouches the hub actor onto the
roster** (self-custody) through the same `afp:Vouch` trail as any agent. This
surfaced a latent P1 bug — the derived roster regenerated every vouched
actor's URL as `/agents/<name>` — fixed by carrying the exact URL the Vouch
named (`AgentSpec.url`).

### Enforcement details settled during implementation

- **Ballot binding:** a vote is dropped unless its `afp:proposalHash` *and*
  `afp:quorumSnapshot` both match the round it claims to answer — wrong
  question and wrong electorate are rejected like an out-of-snapshot voter.
- **Lifecycle:** `afp:Freeze` refuses new rounds and new enrollment but lets
  in-flight rounds close; `afp:Archive` is terminal and read-only.
- **Version vectors (Decision 5):** every hub delta flows through the keyed
  `CRDTStore`, so `crdt_state` + `crdt_version_vector` are maintained from
  the first delta; the hub keeps no separate CRDT persistence.

### What the gate says

All 39 checks pass: the 11 P1 gate checks unchanged, the CRDT property tests
(commutative/associative/idempotent under randomized delta order), and the
hub suite — enrollment, a full L0 round, snapshot rejection, ballot-binding
rejection, lifecycle, and the Python end-to-end replay. The P2 demo
(`npm run demo:p2`) runs the roadmap's own scenario: 30 agents, one policy
round, a signed DecisionRecord, and an export the independent verifier
accepts.

## References

- [02 — Hubs & state](../02-hubs-and-state.md) — CRDT table, enrollment, membership & quorum
- [03 — Coordination](../03-coordination.md) — vocabulary, L0/L1 boundary, Raft rejection
- [04 — Operations](../04-operations.md) — DecisionRecord shape, replay procedure step 7
- [05 — Roadmap, P2 row](../05-roadmap.md#p2p7)
- [ADR-0001 — Technology stack for P1](0001-p1-stack.md)
