# ADR-0015 — The case file at N parties: what an export proves when there are three of them

- **Status:** Proposed
- **Date:** 2026-08-21
- **Applies to:** any audit spanning more than two trust domains — which is every P5
  engagement, and any P4 engagement whose auditor holds a third party's bundle
- **Builds on:** [ADR-0009](0009-federated-replay.md) (the joint replay this generalizes
  past a pair), [ADR-0012](0012-the-long-horizon.md) (the manifest, the content inventory,
  and the CRDT-state exclusion whose consequence lands here),
  [ADR-0010](0010-pinning-without-an-auction.md) (whose open question this makes visible
  rather than solves)
- **Driven by:** [scenario 10 / campaign 7](../scenarios/README.md#campaign-7--open),
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
resolve to nothing — becomes materially harder to notice when there are three bundles and
the vacuous pass is in only one of them.

The inherited constraint, from the ADR this extends: **one implementation, one meaning, run
N times plus a join.** Nothing below forks the verifier; the join gets bigger and more
honest, and the bundle gains one thing it was missing.

## Decisions

### 1. The join is all-pairs, and stated as such

For an export set of size N, phase two runs the existing cross-checks over **every ordered
pair** of domains. At N=2 that is exactly today's behaviour, which is the compatibility
argument and also the design argument: the pairwise check was never wrong, it was
under-quantified.

Two consequences the pair case could not raise:

- **A received activity resolves against its sender, and only its sender.** With three
  bundles the temptation is to search for matching bytes anywhere; that would let a
  forged activity be "confirmed" by a domain that merely also holds a copy. The sender is
  named by `afp:operatedBy` on the actor that signed it, and that is the only bundle whose
  copy is authority (ADR-0009 Decision 2, now with somewhere else to look).
- **A divergence between two domains is reported to the auditor, not to a party.** When
  Alpha's and Gamma's copies of the same activity disagree, Bravo — holding all three
  bundles — learns something neither Alpha nor Gamma can prove to the other. That is a
  real finding and it belongs in the report, attributed to both domains, with the
  observation that the third party is the only one positioned to see it.

### 2. The replay reports what it checked, per domain — a census, not just failures

Phase one currently reports failures per domain. It gains a **census**: how many checks of
each named family ran for each domain, so a reader can see that a bundle was actually
examined rather than merely not-failing.

This is the answer to the shape of hole ADR-0010 documented and campaign 7 found again: a
thread whose governing pins resolve to nothing runs no pin checks, no synthesizer check and
no sufficiency check, and reports nothing at all. Under one bundle that is a silence
someone might notice. Under three it is invisible, because two clean bundles' checks fill
the report.

A census does not decide whether a zero is acceptable — some bundles legitimately contain
no actuation at all. It makes the zero *visible*, which is the difference between a
question an auditor can ask and one they never think to.

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

Nothing is built. Depends on ADR-0014: a three-party flow has to exist before there is
anything to replay three ways.

| ID | Task | Stage |
|---|---|---|
| **N1** | All-pairs phase two; received-bytes resolution bound to the sender's own bundle | 1 |
| **N2** | Divergence between two domains reported to the holder of the set, attributed to both | 1 |
| **N3** | Per-domain check census in the report; counts per named family | 2 |
| **N4** | `afp:Archive` carries the converged state (inline or artifact) beside its canonical hashes | 2 |
| **N5** | Gate: three exports joint-verify clean; a forged activity corroborated by a non-sender bundle still fails; a divergence between two domains is reported to the third; a bundle whose pin checks no-op shows a zero census rather than a clean bill | 3 |

## References

- [Scenario 10 — the incident bridge](../scenarios/10-the-incident-bridge.md), findings
  47, 48, 49
- [ADR-0009](0009-federated-replay.md) — the join this quantifies, and the partition rule
  Decision 1 leans on
- [ADR-0012](0012-the-long-horizon.md) — the CRDT-state exclusion this completes, and the
  revisit trigger that predicted Decision 3
