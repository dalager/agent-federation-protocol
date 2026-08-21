# ADR-0015 — The case file at N parties: what an export proves when there are three of them

- **Status:** Accepted, and **built** (2026-08-21) — gated by the first asserted N=3
  joint replay in this repository, by a sender's two stories surfacing only to the holder
  of the set, by a foreign decline resolving as received evidence and failing when it is
  stripped, and by an archived state that fails when tampered while its hashes stand
- **Date:** 2026-08-21
- **Applies to:** any audit spanning more than two trust domains — which is every P5
  engagement, and any P4 engagement whose auditor holds a third party's bundle
- **Builds on:** [ADR-0009](0009-federated-replay.md) (the joint replay this generalizes
  past a pair), [ADR-0012](0012-the-long-horizon.md) (the manifest, the content inventory,
  and the CRDT-state exclusion whose consequence lands here),
  [ADR-0010](0010-pinning-without-an-auction.md) (whose open question is now closed at
  source by its Decision 5 — what remains here is the general shape of that defect)
- **Driven by:** [scenario 10 / campaign 7](../scenarios/README.md#campaign-7--v324v327-adr-0014-adr-0015),
  findings 47, 49, and the second half of 48

## Context

ADR-0009 built federated replay as **N single-export replays plus a cross-check** and said
so in those terms — but it was written for P4, where N is two, and its cross-check is
pairwise in every particular: a received activity resolves against *the* sender, an
agreement is digest-equal across *two* copies, a hole is attributed to *the* other domain.

Scenario 10 put three operators on one hub and the pairwise assumptions stopped holding
quietly. A received activity in one bundle now has more than one candidate counterpart. A
divergence between two domains is visible to a third that was never party to it. And the
per-domain structure that made phase one clean — each bundle answering for its own actors —
turns out to hide something: a bundle whose checks all *no-opped* is indistinguishable from
one whose checks all passed.

Two further things arrive with the third party rather than being caused by it. ADR-0012
excludes hub CRDT state from an export, correctly and for good reasons — and at P5 that
state *is* the coordinated timeline the operators actually worked from, so the case file
handed to a regulator contains everyone's activities and not the thing they agreed on.
And ADR-0010's open question — a redacted pin-bearing `Offer` leaving a thread whose pins
resolve to nothing — was materially harder to notice with three bundles, because the
vacuous pass is in only one of them. That defect is now **closed at source** (ADR-0010
Decision 5, built): the rule and its check live where the rule was decided. What remains
here is the general form, which outlives that one instance — *any* check that becomes
conditional and then never fires reads as a pass, and only a census can tell the
difference.

The inherited constraint, from the ADR this extends: **one implementation, one meaning, run
N times plus a join.** Nothing below forks the verifier; the join gets bigger and more
honest, and the bundle gains one thing it was missing.

## Decisions

### 1. The join is per-sender at any N — and it gains the two checks only N≥3 can need

Grounding this decision against the code corrected its own context: **the implementation
had already generalized past the pair; only the prose had not.** `check_joint` iterates
every bundle in the set, resolves each received activity against *the sender's* bundle
found by `afp:from`, and checks each agreement's digest against *the parties it names* —
none of that is pairwise-limited, and at N=3 it runs correctly as written. The
"all-pairs" this ADR's draft called for turns out to mostly exist; what does not exist
is narrower and sharper, and it is the actual decision:

- **A received activity resolves against its sender, and only its sender** — ratified as
  the rule, now stated rather than incidental. With three bundles the temptation is to
  search for matching bytes anywhere; that would let a forged activity be "confirmed" by
  a domain that merely also holds a copy. The sender's bundle is the only authority
  (ADR-0009 Decision 2, with somewhere else to look).
- **Cross-receiver consistency — the check only the auditor can run.** When two domains
  each hold a received copy of *the same activity id* from the same sender, those copies
  MUST be byte-equal **to each other**, checked directly — not only each-against-sender.
  The case that makes this load-bearing: the sender's bundle is absent from the set, or
  the sender lawfully redacted the activity to a stub. Each receiver's copy then has
  nothing authoritative to fail against individually — but two receivers holding
  *different* bytes under one id is evidence the sender told two stories, visible only to
  whoever holds both bundles, and it must surface as a finding attributed to the sender
  rather than dissolve into two independent passes.
- **A foreign member's decline resolves as received evidence, not by a new lookup.**
  M6 parked this: a DecisionRecord in the hub host's bundle declares a foreign member
  `declined`, and the member's `Reject` lives in *its* operator's outbox. The ruling
  follows ADR-0009's grain instead of inventing a cross-bundle search: the hub host
  holds that `Reject` as **received bytes** (it crossed the boundary to reach the hub),
  so the phase-one declined-check searches the thread pool — own plus received — and the
  existing phase-two received-check then verifies those bytes against the sender's
  bundle. The decline crosses the boundary the way everything cross-boundary does, and
  no verifier check learns a second way to resolve anything.

### 2. The replay reports what it checked, per domain — a census, not just failures

Phase one currently reports failures per domain. It gains a **census**: how many checks of
each named family ran for each domain, so a reader can see that a bundle was actually
examined rather than merely not-failing.

The shape of the problem is the one ADR-0010 hit and closed at source: a thread whose
governing pins resolved to nothing ran no pin checks, no synthesizer check and no
sufficiency check, and reported nothing at all. Under one bundle that is a silence someone
might notice. Under three it is invisible, because two clean bundles' checks fill the
report.

That *particular* silence is now impossible — ADR-0010 Decision 5 names it. What this
decision addresses is the class: every conditional check in the verifier has the same
property, that failing to run and passing produce identical output, and the set of
conditional checks has grown with every ADR since 0006. A census does not need to know
which condition failed to make the absence legible.

A census does not decide whether a zero is acceptable — some bundles legitimately contain
no actuation at all. It makes the zero *visible*, which is the difference between a
question an auditor can ask and one they never think to.

**The census is output, never checks.** This repository already criticized three
`report.record` sites that cannot fail for inflating a passing count; a census implemented
as more of them would repeat the mistake at scale. It is a distinct section of the
verifier's report — per domain, per check family, a count — printed always, so a zero is
something a reader sees rather than something absence implies.

### 3. `afp:Archive` carries the converged state into the record, once

ADR-0012 Decision 4 keeps hub CRDT state out of the export: state is a projection, and
anything that must be disclosed, redacted, retained or replayed has to live in activities.
That rule is right and this ADR does not weaken it. It completes it.

At the moment a hub is archived — frozen, closed, read-only — its converged state stops
changing, and that is exactly when it can become an activity without becoming a second
source of truth. So `afp:Archive` SHOULD carry the final converged state: inline where
small, or as a hash-addressed artifact where not, alongside the canonical state hashes 07
already specifies.

Once, and only at the end, is the whole design:

- State that changes lives in the CRDT, where it converges and is nobody's authority.
- State that has stopped changing becomes one signed activity, which replays like any
  other, redacts like any other, and is retained like any other.
- ADR-0012's revisit trigger anticipated exactly this and named `afp:Archive` as the
  sanctioned carrier. This is that trigger firing, on schedule, for the reason it predicted.

A hub that is never archived never emits this, and its members' case files remain what they
are today — which is the honest consequence of leaving a hub open forever, not a gap in
this decision.

**The state is checkable because the hashes already are.** `archive()` today computes
canonical hashes of the converged membership and capabilities and emits them as
`afp:stateHashes`; this decision adds `afp:state` — the state those hashes are hashes
*of* — beside them, and a verifier check that recomputes each declared hash from the
carried state. A bundle whose archive carries state that does not hash to its own
declared canon fails by name, which is what distinguishes "state entered the record" from
"a blob rode along". Inline is the built form; the hash-addressed-artifact form for large
state is specified and deferred until a deployment needs it, which is the same honest
deferral `afp:MembershipProof` once had — with the difference that this one is written
down as deferred.

## Options considered

| Option | Rejected because |
|---|---|
| Keep the join pairwise and run it on chosen pairs | Someone chooses, and the pair nobody ran is where the divergence lives |
| Resolve received bytes against any bundle that holds a matching copy | Lets a forged activity be corroborated by a domain that merely received the same forgery; the sender's own bundle is the only authority ADR-0009 ever granted |
| Report a two-domain divergence only to those two domains | The third party is the only one who can see it; suppressing it protects the party that re-signed history |
| Export CRDT state continuously, with its own redaction rules | Builds a second disclosure machinery for a store designed not to need one — ADR-0012 rejected this, and nothing here has changed |
| Fail a bundle whose checks all no-opped | A bundle can legitimately contain no actuation; failing it would make "nothing to check" indistinguishable from "checked and wrong", which is the error this ADR is fixing in the other direction |
| Solve ADR-0010's redaction question here | It is a live defect at N=1 and predates this ADR entirely; folding it in would let a P5 decision carry a P1 correctness fix, and it should be amended where it was decided |

## Consequences

**Positive**

- A three-party engagement gets the same guarantee a two-party one has, rather than a
  guarantee that quietly weakens as parties are added.
- The census closes a class of silent failure — not only ADR-0010's, but any future check
  that becomes conditional and then never fires.
- The case file finally contains what the operators worked from, at the one moment when
  writing it down is safe.

**Negative / accepted risks**

- All-pairs is quadratic in the number of bundles. At the scale this protocol targets — a
  consortium, not a network — that is a handful of pairs, and the alternative is choosing
  which pair to skip.
- The census adds output an auditor must read, and more output is not automatically more
  clarity. Kept to counts per named family for that reason.
- An archived state artifact can be large. It is hash-addressed like any other artifact,
  and ADR-0012's retention rules apply to it unchanged.

**Revisit triggers**

| Trigger | Reconsider |
|---|---|
| A consortium large enough for all-pairs to be a real cost | Whether the join can be spanning rather than complete, and what a spanning join stops proving |
| A hub archived while a member is partitioned and cannot countersign | Whether the archived state needs a quorum or merely the hub's signature |
| The census makes a legitimately-empty bundle look suspicious | Whether "no actuation in scope" should be a declared fact in the manifest rather than an inferred zero |

## Build status

Depends on ADR-0014, now built: M6's three-operator gate is the flow this replays three
ways.

| ID | Task | Where | Stage |
|---|---|---|---|
| **N1** ✅ | Cross-receiver consistency in phase two: received copies sharing one activity id from one sender are byte-equal across receivers, checked directly — the finding that survives the sender's absence or lawful redaction. Check name: `joint: received copies of {id} agree across receivers` | `federation.py` `check_joint` | 1 |
| **N2** ✅ | The declined-check reads the thread pool (own + received), so a foreign member's `Reject` held as received bytes resolves in the hub host's own bundle — and phase two's existing received-check verifies those bytes against the sender. No new resolution path | `decision.py`, `afp_verify.py` (pool plumbing) | 1 |
| **N3** ✅ | The census: per-domain, per-family check counts as a distinct printed section of the report — output, never `report.record` entries, for the reason the three vacuous transparency records were criticized | `afp_verify.py` `Report`/`main` | 2 |
| **N4** ✅ | `afp:Archive` gains `afp:state` beside `afp:stateHashes` (inline form); verifier recomputes each declared hash from the carried state. Check name: `archive: {label} state matches its canonical hashes` | `hub/hub.ts` `archive()`, `hub/activities.ts`, verifier | 2 |
| **N5** ✅ | Gate: M6's three-operator shape exported and joint-verified at N=3 clean; two receivers holding divergent copies of one stubbed sender activity fails by name; a foreign decline resolves through received bytes and fails when they are stripped; an archived hub's carried state fails when tampered while its hashes stand; a bundle whose conditional checks all skipped shows zero-count census lines rather than nothing | `test/adr0015.test.ts` | 3 |

## References

- [Scenario 10 — the incident bridge](../scenarios/10-the-incident-bridge.md), findings
  47, 48, 49
- [ADR-0009](0009-federated-replay.md) — the join this quantifies, and the partition rule
  Decision 1 leans on
- [ADR-0012](0012-the-long-horizon.md) — the CRDT-state exclusion this completes, and the
  revisit trigger that predicted Decision 3
