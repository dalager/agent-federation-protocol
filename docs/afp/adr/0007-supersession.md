# ADR-0007 — Supersession: retracting an answer the world acted on

- **Status:** Accepted, and **built** (see [Build status](#build-status))
- **Date:** 2026-08-20
- **Applies to:** the solo profile onward — record extensions with no federation
  dependency
- **Builds on:** [ADR-0006](0006-checkable-actuation.md), whose `afp:actsOn` hash-binding
  is what makes Decision 3 expressible at all
- **Driven by:** [scenario 07](../scenarios/07-the-retraction.md), which sharpened
  [campaign 4](../scenarios/README.md#campaign-4--v312v314-adr-0006-adr-0007)'s finding 24 into the three
  decisions below

## Context

`afp:supersededInputs` covers revision at the *input* level — a Result updated during
reconciliation stays in the record (04). Nothing covers revision at the *answer* level:
a Synthesis whose conclusion was wrong, discovered after the record — and possibly the
world — moved on it. Scenario 06 met the case in passing (a review overturned its
triage); scenario 07 was built around it and found exactly three gaps: the revision
cannot name what it withdraws, a lone signature can un-decide a quorum, and actions
taken on the withdrawn answer are orphaned rather than dealt with.

The constraint all three answers inherit: **supersession is an edge, never an erasure.**
Outboxes are append-only; the wrong answer stays, and the record's job is to say — 
checkably — that it stopped being the answer, at what cost, and what became of its
consequences.

## Decisions

### 1. `afp:supersedes` — answer-level supersession is its own edge

A Synthesis MAY carry `afp:supersedes`: the digest of the Synthesis *activity* it
retracts. Distinct from `afp:supersededInputs` on purpose — conflating "an input was
updated" with "the conclusion was withdrawn" would make every reconciliation look like a
retraction. Verifier: the digest MUST resolve to a present Synthesis (the
counted-vote-you-cannot-produce pattern), and both Syntheses MUST share a `context` — a
revision that answers a different thread retracts nothing.

### 2. Ratification parity — overturning a decision costs what the decision cost

If a `DecisionRecord`'s `afp:outcome` names the superseded Synthesis (04's ratification
idiom), then a `DecisionRecord` naming the *superseding* Synthesis MUST exist. A quorum's
answer is retracted only by a quorum; an unratified answer stays cheap to correct.
Checkable entirely from DecisionRecords already on the record.

### 3. `afp:disposes` — actions on a withdrawn justification get a recorded disposition

For every activity whose `afp:actsOn` names a superseded Synthesis, an activity MUST
exist carrying `afp:disposes` — that action's digest — and `afp:actsOn` naming the
*superseding* Synthesis. The actuation loop runs once more, under the same pinned
`afp:actionPolicy` where one exists: the correction notice is itself an admissible
action for the new category. An acted-on retraction with no disposition is a named
failure — the half of finding 24 ADR-0006 could not reach.

*(Amended by [ADR-0011](0011-supersession-meets-the-irreversible-world.md): this decision
assumed the world would accept the disposition. Where the action's name was declared
irrevocable at pin time, the disposition MAY instead be `afp:disposition: "annotate"` —
which commands nothing and is checked against that declaration rather than against
`policy[category]`. The existence check above is unchanged; what changed is that an honest
deployment whose external system offers no undo can now satisfy it. ADR-0011 also requires
a superseding ratification to name the electorate it overturns, which is why this ADR's own
gate now carries `afp:priorQuorumSnapshot`.)*

## Options considered

| Option | Rejected because |
|---|---|
| Reuse `afp:supersededInputs` for answers | Input revision and answer retraction are different claims; one property for both makes routine reconciliation indistinguishable from "we were wrong" |
| Tombstone or `Delete` the superseded Synthesis | Outboxes are append-only and the chain is the guarantee; erasure is exactly what this record exists to make impossible |
| Parity by re-running the *original* round's snapshot | The membership has legitimately moved on; the revision is a new decision by the current quorum, not a replay of the old one |
| Require dispositions eagerly, at supersession time | The disposition may genuinely take time (a PR review, a recall). The check runs at replay over the export, which is when completeness claims are due — same as terminal outcomes |

## Consequences

**Positive** — the three questions scenario 07 poses (why did they act, is that still the
answer, was the action dealt with) each become one digest-walk. **Accepted risks** — 
parity makes retracting a ratified answer *slow* (a round), which is the point but will
chafe in an incident; a hub may pre-authorize an emergency disposition action in its
policy. Dispositions are checked for existence, not adequacy — "noted, no action" is a
valid disposition, and judging it is the reader's job, not the verifier's.

**Revisit triggers:** a chain of supersessions (S″ supersedes S′ supersedes S) wanting
transitive treatment; federation-era supersession of another operator's ratified answer.

## Build status

| ID | Task | Status | Where |
|---|---|---|---|
| **S1** | `afp:supersedes` on the Synthesis builder; `dispositionStamp` helper | **done** | `allocation/activities.ts`, `allocation/actions.ts` |
| **S2** | Verifier: resolution + shared context, ratification parity, disposition existence | **done** | `action.py` `check_supersession` |
| **S3** | Gate: retraction flow clean; mutations fail each named check | **done** | `test/adr0007.test.ts` |

## References

- [Scenario 07 — the retraction](../scenarios/07-the-retraction.md) ·
  [scenario 06](../scenarios/06-issue-triage-loop.md) finding 24
- [04 — Synthesis](../04-operations.md#synthesis-answers-that-are-not-decisions) ·
  [ADR-0006](0006-checkable-actuation.md) — the `afp:actsOn` binding this extends
