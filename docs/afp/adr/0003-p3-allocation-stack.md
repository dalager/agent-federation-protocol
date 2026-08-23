# ADR-0003 — Technology stack for P3

- **Status:** Accepted
- **Date:** 2026-08-18 (accepted 2026-08-19)
- **Applies to:** [P3 — Local allocation](../05-roadmap.md#p2p7)
- **Builds on:** [ADR-0001](0001-p1-stack.md), [ADR-0002](0002-p2-hub-and-crdt-stack.md) —
  everything both decided is inherited unchanged; this ADR only covers what P3 adds

## Context

P3 adds **allocation**: `Announce{afp:Task}` to the hub, sealed commit-reveal bidding,
a published deterministic selection rule producing an `afp:Award` (one performer, or a
coalition plus a named synthesizer), `afp:Reauction`, `afp:Synthesis`, `afp:Settlement`,
and the estimator/bidder separation of duties ([03 § Bidding & allocation](../03-coordination.md#bidding--allocation)).
Still one operator — "local bidding is real load balancing" (05).

Working backwards from P3's gate ("any member recomputes the published selection rule
over the revealed bids and reaches the same performer set and synthesizer; every reveal
matches its commitment hash"):

| Requirement | Stack consequence |
|---|---|
| Sealed bids: `afp:BidCommit` → `afp:BidReveal` | A commitment is a digest over the canonicalized bid payload — JCS + SHA-256 already exist (P1); **no new crypto** |
| Published, deterministic selection rules, both families | Pure functions from the revealed bid set to a performer set, named + parameterized in the Announce; independently reimplemented in the verifier |
| Deterministic tie-break | `hash(taskId \|\| bidderId)` as a protocol constant — same digest primitive |
| Award timeout → Reauction | The P1 delivery queue's timeout sweep pattern, applied to awards |
| Synthesis / Settlement | Ordinary signed activities/objects (04), riding the existing outbox machinery |
| Bid-vs-actual divergence recorded | A new SQLite table; **reputation stays a recorded signal, not a number that feeds selection — see Decision 5** |

Everything again additive: no new runtime, no new store, no new signature suite. The
genuinely new artifact class is the **selection rule** — the first place the record's
verifiability depends on recomputing a *function*, not just a tally.

## Decisions

### 1. Allocation lives beside the hub, same process, same dispatch port

`Announce` broadcasts through the hub to enrolled members (03's fan-out note: senders
never track subscriber lists); bids, reveals, awards and results are point-to-point
signed activities like everything since P1. No new actor class: the *announcer* is an
agent or the hub, and the allocation bookkeeping (bid windows, commitments, award state)
is new tables in the same SQLite file, mirroring how P2 added rounds.

### 2. Commitments: digest over the canonicalized bid, nothing fancier

`afp:BidCommit` carries `afp:commitment = sha256(JCS(bid payload))` — the digest and
canonicalization P1 already ships. The reveal is the full signed `afp:Bid`; verification
is recomputing the digest and comparing. No threshold/blind-signature machinery —
commit-reveal deters sniping, not cryptanalysis (03 "Sniping and lying, honestly
bounded").

*Spec consequence, already applied in 03:* the committed payload includes a **`nonce`**
field — without one, a low-entropy bid (a handful of plausible cost values) is
recoverable from its commitment by enumeration, which defeats sealing exactly where it
matters most.

### 3. Selection rules: a small named registry of pure functions, mirrored in the verifier

A selection rule is data in the Announce (`afp:selectionRule` — name + parameters) and a
pure function in code. P3 ships the two spec families:

- **Ranking** — score each bid by a published expression over its declared fields
  (`afp:capabilityMatch`, `afp:estimatedCost`, `afp:estimatedLatency`), take the top one.
- **Set selection** — minimal bid set whose `afp:coverage` satisfies the announced
  predicate (e.g. every declared domain at confidence ≥ 0.6), ties broken by the
  protocol constant; the same rule deterministically names the **synthesizer**
  (scenario 04: broadest-coverage awardee).

Rules take the revealed bid set only — never hub state, clocks, or randomness — so the
Python verifier reimplements each rule from its spec description, sharing no code, and
the gate diffs the two implementations' outputs on the same bid sets. The tie-break
constant is part of both implementations and diffed the same way. An unknown rule name
in an Announce is a verification failure, not a skip. The announced task also states its
**answer-sufficiency threshold** (coverage, count, or both) — a separate thing from
voting quorum (03), recorded in the Announce, checkable at replay.

### 4. Award, Reauction, Synthesis, Settlement: ordinary signed activities

All four ride the existing envelope: proofs, `prevActivity` chains, explicit visibility,
context threading. `afp:Award` names the winning bid digests, the performer set, and the
synthesizer; the performer flow after an Award is exactly the P1 `Accept`/`Create{Result}`
flow keyed by `correlationId` (03 step 4 — "seeded by a Bid instead of a direct Offer").
Award timeout reuses the P1 deadline-sweep pattern: no `Accept` before the window closes
→ recorded `afp:Reauction` with the fast path (next-ranked from the same pool) preferred
over a full re-Announce.

Two reuses of machinery P3 already has:

- **Synthesis ratification rides P2's L0 voting.** Hub policy MAY require a
  multi-performer Synthesis to be ratified (04; scenario 04 step 7 — a synthesizer
  exercises real discretion). When it does, the round is an ordinary P2 L0 round whose
  closing `DecisionRecord` names the Synthesis as its outcome and records the split. At
  one operator this is L0 — the scenario's L1 variant arrives with P6's trigger. No new
  voting machinery.
- **Declining is a record.** On an announced task, enrolled agents that cannot
  contribute SHOULD `Reject` explicitly within the bid window with a reason (03) — P1's
  `Reject` activity, addressed to the announcer. This converts population coverage from
  an inference into a record, which is what an audit asking *"were the right agents
  consulted?"* needs (scenario 04, finding 6).

### 5. Reputation: record the inputs at P3, do not compute the number

03 and 04 make reputation *feedback* (bid-vs-actual divergence via `afp:Settlement`,
estimates entering an explicit **unsettled** state) but its consumption — selection odds,
P2+ vote weights — is a policy the spec leaves to hubs. P3 therefore **records** the
signals: a settlements table linking estimates to actuals, divergence visible to every
member, dissent-vindication noted (04 "a swarm that penalizes accurate minority
objections will stop producing them"). It does **not** fold them into a live reputation
score feeding selection — that would put an unverifiable number inside an otherwise
recomputable Award. Same reasoning as P2's uniform weights: honest and recomputable beats
sophisticated and opaque. Revisit when a concrete policy needs it.

### 6. Estimator/bidder separation: enforced at bid admission, as hub policy data

03 says hub policy MUST take a position. The hub carries a per-hub policy flag
(exclude | permit-and-record); under *exclude*, a bid on executing work its actor
estimated is rejected at admission and audit-logged; under *permit-and-record*, the
bid-vs-own-estimate divergence lands in the settlements table. Either way the position
itself is recorded in the hub's announce, so a verifier can check it was applied.

### 7. Verifier extension: recompute the auction

Mirroring P2's three checks, the P3 replay adds:

1. **Commitment integrity** — every revealed bid's digest matches its prior in-window
   `afp:BidCommit`. Failures, separately named: a reveal whose digest matches no commit;
   a reveal whose commit landed outside the bid window; and an Award naming a bid whose
   reveal is absent from the export — an unproducible winning bid is the auction's
   version of *"a counted vote you cannot produce."*
2. **Selection recomputation** — rerun the announced rule over the revealed bids; the
   recomputed performer set *and synthesizer* must equal the Award's.
3. **Synthesis binding** — a multi-performer Award's Synthesis references only
   contributing Results present in the export, and carries its declared method and
   dissent (04's shape).

Set-membership, digests, and one pure function per rule — still no new cryptography.

## Options considered

| Option | Rejected because |
|---|---|
| Free-form selection rules (arbitrary code/expressions in the Announce) | Unverifiable without an interpreter in both implementations; a small named registry keeps rules recomputable and the verifier honest |
| Live reputation score feeding selection at P3 | Puts an unverifiable number inside a recomputable Award; the spec makes consumption hub policy — record the inputs, defer the number (Decision 5) |
| VDF/threshold crypto for sealed bids | Commit-reveal's threat model is bid sniping, not cryptanalysis; hash commitments over JCS are already in the stack and independently checkable |
| A separate auctioneer service | Same argument as ADR-0002 Decision 1 — no new runtime for a single-operator phase |
| Payments/economics machinery | Out of scope by design: "no token economics" (README); `afp:estimatedCost` is bid metadata, not money |

## Consequences

**Positive**

- The auction is replayable end to end: commitments, reveals, rule, award, synthesis —
  each check is a digest comparison or a pure-function rerun.
- Two independent implementations of every selection rule exist before any cross-operator
  bidding (P5) depends on them — the P1/P2 verifier dividend, extended.
- Reputation inputs accumulate from P3 day one without blocking on a scoring policy.

**Negative / accepted risks**

- The rule registry is a coupling point: adding a rule means implementing it twice and
  diffing. Accepted — that *is* the verifiability guarantee, and the registry starts at
  two entries.
- Deferred reputation means P3 selection ignores past performance; a chronically
  over-promising bidder keeps winning until a human or policy reads the recorded
  divergence. Honest about where the guarantee actually is (03: "statistical, not hard").
- Commit-reveal adds a two-phase window to every allocated task — latency the direct
  `Offer` flow doesn't pay. Per 03, direct `Offer` remains the default when the target
  is known; `Bid` sits alongside, not instead.

**Revisit triggers**

| Trigger | Reconsider |
|---|---|
| A hub policy actually consumes reputation | Decision 5 — define the score, its inputs, and its place in the record |
| A rule the registry can't express | Decision 3 — extend the registry (twice), or accept a hub-local rule marked non-recomputable in the record |
| P5 cross-operator bidding | Decision 1 — the announce fan-out crosses instance boundaries; transport hardening arrives with P4's machinery |


## Amended 2026-08-23 (ADR-0022's P7 demo): the award recomputes across a boundary

Two corrections to `check_award`, both found by the first workload to run an auction
between operators rather than inside one:

- **The bid pool is the thread pool.** Reveals and commitments from a foreign bidder
  arrive as received bytes, so resolving them from the verifying bundle's own outbox made
  every cross-boundary award unrecomputable — no producible winning bid, no recomputed
  performer, no match. It reads the same pool `check_decision_record` already reads for
  counted votes (ADR-0015 N2's grain).
- **The member filter reads the trail as of the award.** Folding it as of *now* meant a
  bidder that won a ticket and later left the hub — resigned, or expelled by a ratified
  round (ADR-0021) — retroactively voided the award that gave it the work. An auction's
  arithmetic is signed history, and the cutoff is ADR-0021 Decision 1's, applied here.

Neither changes what an award *means*; both close the gap between what this ADR specified
and what it checked once the parties stopped sharing a process.

## References

- [03 — Bidding & allocation, selection rules, declining, estimator separation](../03-coordination.md#bidding--allocation)
- [04 — Synthesis, Settlement, audit table](../04-operations.md)
- [05 — Roadmap, P3 row](../05-roadmap.md#p2p7)
- [ADR-0001](0001-p1-stack.md) · [ADR-0002](0002-p2-hub-and-crdt-stack.md)
