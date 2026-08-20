# ADR-0004 — Solo-foundation hardening before federation

- **Status:** Proposed
- **Date:** 2026-08-19
- **Applies to:** the solo profile (P1–P3), as prerequisites hardened before any
  [P4](../05-roadmap.md#p2p7) federation work begins
- **Builds on:** [ADR-0001](0001-p1-stack.md), [ADR-0002](0002-p2-hub-and-crdt-stack.md),
  [ADR-0003](0003-p3-allocation-stack.md) — everything all three decided is inherited
  unchanged; this ADR only covers what the hardening adds
- **Driven by:** the three open findings of
  [scenario 05 / campaign 3](../scenarios/README.md#campaign-3--open) (16–18), plus the
  scenario's minor precision on the port boundary

## Context

P1–P3 are built and gated: the solo profile is complete *as specified*. Scenario 05 (a
team-operated instance serving other teams with domain intelligence) then stressed that
profile as a product rather than a demo, and strained it at exactly three seams — each of
which becomes **harder, not easier, to fix once federation multiplies the participants**:

1. Membership is binary, but real hubs have askers, deciders, and watchers. Fixing roles
   after P4 means migrating a membership CRDT that two operators already share.
2. Reusable components have identity, versions and provenance, but the record can only
   carry bytes-with-a-digest. Fixing asset identity after P5 means reconciling registries
   that grew ad hoc on separate instances.
3. ADR-0003 Decision 5 deferred reputation *computation* until "a hub policy actually
   consumes reputation." Scenario 05's staffing policy is that consumer — the trigger has
   fired. Fixing it after P4 means the first cross-operator auctions run either without
   the signal or with an unverifiable one.

The rule this ADR applies is the same one that put signing and visibility in P1: **what
cannot be retrofitted goes in before the participants multiply.** All three decisions are
recomputable-record extensions in the established mold — new data pinned in the record,
enforced at admission, mirrored independently in the verifier. No new runtime, no new
store, no new cryptography.

## Decisions

### 1. Enrollment carries a role: `member | requester | observer`

`afp:Enroll` gains an `afp:role` property (default `member`, so every existing record
reads unchanged). The role is folded into the hub's membership state alongside
capabilities and enforced wherever participation is scoped:

| | announce | bid / commit | vote / be pinned in `afp:quorumSnapshot` | publish Results on own threads | read at `hub` visibility |
|---|---|---|---|---|---|
| **member** | yes | yes | yes | yes | yes |
| **requester** | yes | no | no | yes (the ask, and later its actuals) | own threads + what policy publishes |
| **observer** | no | no | no | no | yes |

Concretely:

- **Snapshot-pinning** (02): `proposeRound` pins only `member`-role agents into
  `afp:voters`; a requester or observer can never appear in a quorum snapshot, and a
  verifier can prove it — the roles are replayed from the Enroll trail exactly as
  membership already is.
- **Bid admission** (03): a commit from a non-member role is rejected and audit-logged,
  same lane as the estimator wall; the verifier's pool reconstruction excludes non-member
  reveals.
- **The requester write-path is deliberately narrow but real**: announcing a task and
  later reporting observed actuals onto the same thread (scenario 05 step 5 — settlement
  on requester-reported actuals depends on that write). This makes inbound
  `Announce{Task}` a first-class hub dispatch path — until now only the hub itself
  announced; a requester's (or member's) signed Announce is admitted by role, re-fanned
  out by the hub, and the announcing actor is the settlement's counterparty.
- **Role state merges deterministically**: role is per-agent last-writer-wins over the
  Enroll trail — latest `published` wins; equal timestamps break by higher activity
  digest. Re-enrolling with a new role is the upgrade/downgrade path, on the record.
- **Fan-out is role-aware**: broadcasts (announces, awards, proposals) go to members and
  observers; a requester receives only activities on threads it announced. Who was
  addressed is already in every activity's `to` — so the scoping is itself replayable.

*Rejected framing:* modelling requesters as `afp:AuditGrant` holders. A grant is
read-only, audit-flavored, and expiring; a requester initiates work and closes feedback
loops. Conversely, full membership with workflow-code exclusions is exactly the
"enforcement that leaves no trace" Decision 6 of ADR-0003 exists to prevent.

### 2. `afp:Asset`: identity for reusable components

A third thing between agents and artifacts: an **asset** — a reusable component with
identity, versions, and provenance across hubs. New object type:

```json
{
  "id": "urn:afp:asset:mitid-broker-adapter",
  "type": "afp:Asset",
  "afp:version": "3.1",
  "afp:digest": "sha256:…",
  "afp:sourceUrl": "https://git.example/integrations/mitid-broker-adapter",
  "afp:originContext": "urn:afp:thread:proj-x-build",
  "attributedTo": "https://alpha.operator.local/agents/i-identity"
}
```

- **Registry as recorded state**: a hub-scoped OR-Map `assetId → asset record`, fed by
  ordinary signed `Update{afp:Asset}` activities — registration is on the record, like
  enrollment, never a side channel. Any `member` may register; `attributedTo` names the
  steward, and the registering activity's signature is the accountability. One
  (id, version) is immutable once registered: a second `Update` naming the same
  (id, version) with a different digest is rejected at the hub **and** is a named
  verifier failure — an asset that mutated under its own version is a claim nothing can
  resolve. A new version is a new entry, and the digest is what makes the claim checkable.
- **Referenceable from allocation**: a Bid MAY carry `afp:reuses` (asset id + version) —
  "my cost is low *because* I start from this" as a claim under the sealed commitment —
  and a Result MAY carry `afp:reused` (asset ref + the delivered adaptation's own
  digest), closing the loop.
- **Verifier check**: every `afp:reuses`/`afp:reused` reference resolves to a registered
  `afp:Asset` in the export whose (id, version, digest) triple is consistent. A reuse
  claim that resolves to nothing is the asset-flavored "counted vote you cannot produce."

Cross-operator asset reference (P5) inherits this shape unchanged: the registry rides the
same CRDT sync everything else does, and the digest makes a foreign asset claim exactly
as checkable as a local one.

### 3. Reputation: a named, published, recomputable derivation — consumed only when pinned

ADR-0003 Decision 5's revisit trigger has fired, and its reasoning still binds: **no live
number inside a recomputable Award.** So reputation consumption takes the same form as
selection itself — a small named registry of pure functions, pinned in the Announce:

- The Announce MAY carry `afp:reputationRule` (`{name, params}`) **and, with it, MUST
  carry `afp:settlementSnapshot`** — the digests of every `afp:Settlement` the derivation
  is computed over, pinned at announce time exactly as `afp:quorumSnapshot` pins voters.
  No snapshot, no reputation input: the rule runs over evidence the record can produce,
  never over "whatever the hub knew."
- **The snapshot is exhaustive, not curated**: it MUST name every `afp:Settlement` of
  this hub published before the announce. A hub that omits one — cherry-picking away a
  favored bidder's bad history — produces a named verifier failure, because completeness
  is checkable against the hub's own outbox, not taken on trust.
- One derivation ships first: **`divergence-decay`** — per bidder, a score from
  estimate-vs-actual divergence over the pinned settlements, with a decay favoring
  recent evidence, a neutral prior for bidders with no history (new entrants are not
  punished for being new), and a bonus term for `afp:dissentVindicated` entries (04: a
  swarm that penalizes accurate minority objections stops producing them). Two
  determinism rules keep it identically computable in two implementations: divergence is
  **relative** (integer percent of the estimate, unit-free; an entry whose estimated and
  actual units differ, or whose values are non-numeric, is skipped — never guessed at),
  and decay is **exact rational arithmetic over the recency ordering** (settlements
  ordered by `published`, ties by digest; per-step decay a ratio of small integers,
  accumulated in arbitrary-precision integers) — never a wall-clock float exponential,
  which is exactly the cross-implementation disagreement the numeric profile forbids.
- The `ranking` selection rule gains an optional `reputation` weight; the score term is
  the pinned derivation's output. `coverage` stays reputation-free at this phase —
  coalition composition is about domain coverage, and folding standing into it needs
  evidence pressure this record doesn't have yet.
- **Verifier extension**: when an Announce names a reputation rule, replay resolves every
  settlement digest in the snapshot (missing ⇒ failure), recomputes the derivation with
  its own independent implementation, and feeds it into selection recomputation. An
  unknown derivation name is a verification failure, not a skip — Decision 3 of ADR-0003,
  applied again.

Hubs that don't pin a reputation rule behave exactly as today. Uniform weights remain the
L0 voting default; this decision touches *selection odds*, not vote weight — vote-weight
reputation stays deferred (02 mentions it; nothing consumes it yet, so nothing is
specified yet).

### 4. The port boundary carries the confidentiality residue — stated, not implied

Scenario 05's minor precision, promoted to spec text in 06: visibility classes scope
**the record**; what a brain may *say* about what it read is operator policy at the port
boundary. An archivist's brain that reads rate cards to ground an estimate has seen them,
whatever the published Result cites. One paragraph, no machinery — the honest statement
of where the guarantee ends, in the document whose job is honest deployment guidance.

## Options considered

| Option | Rejected because |
|---|---|
| Requesters as `afp:AuditGrant` holders | Grants are read-only and expiring; a requester initiates work and reports actuals — a participation role, not an audit window |
| Roles as hub-local convention (workflow code excludes non-members) | Unverifiable — indistinguishable in the record from a hub that lets requesters vote; the exact "policy nobody can check was applied" ADR-0003 Decision 6 rejected |
| Assets as artifacts-plus-convention (a well-known JSON blob) | An artifact is bytes; version lineage and cross-hub identity need an object the vocabulary names, or every instance invents its own shape and P5 reconciliation becomes archaeology |
| A live reputation score maintained as hub state | The exact "unverifiable number inside a recomputable Award" ADR-0003 Decision 5 rejected — pinning a snapshot and a named pure function is what keeps the Award recomputable |
| Reputation in vote weights too, while we're here | No consumer has fired for it; specifying policy ahead of evidence is how the pre-v3.6 roadmap rotted |
| Deferring all three to "during P4, as needed" | Each becomes a migration instead of an addition: shared membership CRDTs, divergent registries, and cross-operator auctions with an unverifiable signal |

## Consequences

**Positive**

- P4 starts on a record whose participation, reuse, and standing semantics are already
  pinned, enforced, and independently verifiable — federation multiplies participants,
  not open questions.
- Scenario 05's use (b) — serving other teams — becomes fully buildable: requester-scoped
  asks, recorded cross-team reuse, settlement on requester-reported actuals.
- The reputation loop closes end to end for the first time — settlements stop being
  write-only — while the Award stays a pure function of the record.

**Implementation parity note.** The build of this ADR also closes the one remaining
restart-safety gap in the hub: open voting rounds live in process memory today (their
rows and vote receipts persist, but the hub does not rehydrate them), while P3's award
sweep already survives restart in SQLite. Foundation-hardening means the whole hub comes
back from its store — rounds included — before federation makes "the hub restarted"
somebody else's problem.

**Negative / accepted risks**

- Three more things mirrored in two implementations (role filtering, asset resolution,
  the divergence-decay derivation). Accepted — that *is* the verifiability guarantee,
  same trade as every registry before it.
- `afp:settlementSnapshot` grows with history; a long-lived hub's announces carry a
  growing digest list. Accepted at solo scale; revisit with a rollup (a signed settlement
  summary object) when a snapshot's size is felt, not before.
- `divergence-decay` is one opinionated derivation. Deliberate: one honest, recomputable
  score beats a configurable framework nobody can audit; the registry pattern makes the
  second derivation cheap when a policy needs it.

**Revisit triggers**

| Trigger | Reconsider |
|---|---|
| P4 federation handshake design (ADR-0005) | Whether foreign-instance agents enroll with non-member roles by default |
| A hub policy weights *votes* by reputation | Extend Decision 3's registry to vote weights — same pinning discipline |
| Settlement snapshots grow past comfortable announce size | The rollup object noted above |
| Cross-hub asset reference at P5 | Whether the registry needs a resolution protocol beyond digest equality |

## Build status

The three decisions are built and gated; what follows tracks the work to completion,
including the defects the build's own review surfaced. Task IDs are stable — cite them in
commits and follow-up ADRs.

**Done**

| ID | Task | Where |
|---|---|---|
| **H1** | Decision 1 — roles on enrollment, enforced at snapshot-pinning, bid admission and fan-out; inbound `Announce{afp:Task}` and requester actuals as first-class dispatch paths | `hub/hub.ts`, `allocation/allocator.ts`; verifier `decision.py`, `allocation.py` |
| **H2** | Decision 2 — `afp:Asset` registry: OR-Map with LWW-valued fields, `(id, version)` immutability at admission, member-only registration, `afp:reuses`/`afp:reused` resolution | `crdt/ormap.ts`, `hub/crdtAdapter.ts`, `hub/hub.ts`; verifier `asset.py` |
| **H3** | Decision 3 — `divergence-decay`, pinned `afp:reputationRule` + exhaustive `afp:settlementSnapshot`, optional `reputation` weight on `ranking` | `allocation/reputation.ts`; verifier `reputation.py` |
| **H4** | Decision 4 — the port-boundary paragraph | [06](../06-deployment-profiles.md#where-visibility-ends-the-port-boundary) |
| **H5** | Parity note — the whole hub comes back from its store: rounds read through SQLite, and membership, capabilities, liveness, roles, assets and lifecycle rehydrate on construction | `hub/hub.ts` `hydrate()`, `crdt/store.ts` `crdtIds()` |
| **H6** | Settlement follows an award, once per task — the inbound path and the programmatic one both refuse otherwise | `allocation/allocator.ts` |
| **H7** | Writer/verifier parity restored on wire-value interpretation: integer-valued floats, `published` instants, `afp:dissentVindicated` typing, malformed `afp:settles` entries | `crypto/time.ts` ↔ `decision.py` `instant_millis`; `test/parity.test.ts` |
| **H8** | The governing Announce must be hub-authored, and exactly one — a replay no longer falls back to whichever candidate came first, nor proceeds when two sets of terms exist | `allocation.py` `check_award` |
| **H9** | One auction per thread, enforced at announce; the by-thread lookup refuses to guess when a thread is ambiguous rather than settling an arbitrary row | `allocation/allocator.ts`, `allocation/store.ts` |
| **H10** | One immutability verdict per asset key — the passing record no longer derives from the same first-write-wins data as the failing one | `asset.py` |
| **H11** | Vote receipts come back ordered, so `afp:countedVotes` is stable across runs and stores | `hub/store.ts` |
| **H12** | An announced bid window must be able to admit a bid: `opens < closes`, and not already closed | `allocation/allocator.ts` `onAnnounce` |
| **H13** | The `ALTER TABLE` guard swallows only the already-applied case | `allocation/store.ts` |

**Deferred to its own ADR**

| ID | Task | Why separate |
|---|---|---|
| **H14** | Constrain who may issue an `afp:Enroll` for a hub | The trail is trusted by issuer today, so a rostered agent can self-promote. The hole predates this ADR — `enrolled_members` had the identical model — but Decisions 1–3 now hang bid admission, announce authority, asset registration and quorum pinning off it, so the blast radius is materially larger. Fixing it is an authority decision, not a hardening detail |

**A note on the parity work (H7).** Four of the defects this build's review found were the
same shape, and none were algorithmic: the two implementations disagreed about how to
*read a value off the wire*. `100.0` is a legal JSON number that the JCS profile accepts
and canonicalizes to `100` — usable to one side, skipped by the other. `published`
compared as a string orders a negative UTC offset before a `Z` that it actually follows,
and makes two spellings of one instant untie. A membership test against a string is a
substring search in one language and a type error in the other. A malformed entry that
one side steps over crashes the other, and a crash is a divergence too.

The lesson is about method, not any one bug: a parity check whose cases are *generated*
in one language cannot find these, because serialization erases the distinctions that
break parity — a JS-authored `100.0` reaches the verifier as `100`. The cases therefore
live as raw JSON that both implementations read
([`test/parity/cases.json`](../../../src/verifier/test/parity/cases.json)), and the
harness additionally asserts that each case is *discriminating*: an estimate of 100
against an actual of 150 scores 50 when the entry is usable and 50 as the neutral prior,
a coincidence that hid one of these defects through a first round of testing. A parity
harness whose cases cannot tell the two behaviours apart reports agreement forever.

## References

- [Scenario 05 — the integration practice](../scenarios/05-integration-practice.md), findings 16–18
- [03 — Bidding & allocation](../03-coordination.md#bidding--allocation) ·
  [02 — Membership & quorum](../02-hubs-and-state.md#membership--dynamic-quorum) ·
  [04 — Settlement](../04-operations.md#settlement-scoring-answers-that-cannot-be-verified-yet) ·
  [07 — Artifacts](../07-visibility-and-artifacts.md#artifacts--attachments)
- [ADR-0003](0003-p3-allocation-stack.md) Decisions 3, 5, 6 — the patterns reapplied here
