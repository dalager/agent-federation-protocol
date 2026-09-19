# ADR-0040 — The six that want mechanism: what the scenarios are still owed, costed

- **Status:** Proposed (2026-09-19) — a plan, not a design. Nothing is built *by* this
  ADR. It takes the six open findings that a sentence cannot close, groups them into the
  three decisions they actually are, and costs each one so the next build picks from a
  priced menu rather than re-deriving the problem; group: **Scenario coverage**
- **Date:** 2026-09-19
- **Applies to:** `ports/command.ts`'s grammar, `federation/visibility.ts`'s `parseCommand`,
  `hub/seats.ts` and `hub/hub.ts`'s OR-Sets, `inbox.ts`'s quarantine path, `ports/brain.ts`'s
  `afp:producedBy`, and the verifier checks each of those would gain
- **Builds on:** [ADR-0030](0030-scenario-re-walks-and-the-coverage-index.md) Decision 1
  (the coverage index, and the rule that a finding names what it is owed),
  [ADR-0029](0029-the-human-window-and-the-activitypub-premise.md) Decision 2 (the
  grammar, now four forms), [ADR-0017](0017-standards-conformance.md) Decision 4 (the
  seat, Follow/Undo as the door-knock class), [ADR-0027](0027-the-port-is-a-security-boundary.md)
  Decisions 2–3 (what a brain may be handed; quarantine and the pinned-action rule),
  [ADR-0033](0033-operator-obligations.md) Decision 3 (`afp:producedBy` held to the
  policy's declared brains)
- **Driven by:** the 2026-09-19 sweep of the coverage index. Twelve findings were open;
  six close with a sentence in an ADR or a spec chapter and were closed that way the same
  day. These are the other six — each one wants something built, and not one of them had
  an ADR home

## Context

[ADR-0023](0023-loose-ends-triaged.md) is this repository's precedent for a ledger that
plans rather than designs, and its reasoning applies again: *a blocker that quietly
disappears teaches a later reader nothing.* The inverse is also true and is the problem
here — a blocker that sits in a findings table for six weeks with the candidate "no ADR
home yet" teaches a later reader that nobody has thought about it, which in three of
these six cases is not so.

The six are not one theme. They are three, and they fell out of three different campaigns
against three different surfaces:

1. **A pause is not a state the record can read.** Findings 79 and 81, from
   [02](../scenarios/02-observability-fix-pipeline.md) and
   [06](../scenarios/06-issue-triage-loop.md). `pause` stops an agent and nothing says for
   how long, nothing resumes it, and the `Reject` a paused agent emits is the same shape
   on the wire as a capability decline. Two findings, one cause: pausing was built as an
   effect on a process, not as a fact about an agent.
2. **Leaving a hub is a mechanism with an unspecified edge and a silent one.** Findings 85
   and 88, both from [14](../scenarios/14-the-seat-migration.md). `Undo{Follow}` mass-unenrolls and
   says nothing about the work those agents were mid-way through; and seat churn itself is
   invisible in the admission log, which records only its downstream Enroll effects.
   [ADR-0039](0039-the-operator-takes-a-seat.md) sharpened the second by making churn two
   keystrokes away.
3. **The record does not say what a claim was reasoned over.** Findings 82's remainder and
   91, from [09](../scenarios/09-the-screening-sidecar.md) and
   [16](../scenarios/16-the-hostile-edge.md). `afp:producedBy` proves a template digest on
   exactly one wired path, and a Result produced while reading quarantined evidence is
   indistinguishable from one produced over clean evidence. Both are the same question at
   different distances: what may a reader conclude about how this claim came to be.

The costs below are honest estimates in the units this repository actually spends: wire
vocabulary (the expensive one — every term is forever), instance code, verifier checks,
and gate cases. **Nothing here is scheduled.** ADR-0024's program is closed but for its
first signed release, and none of these six is a claim of it.

## Decisions

Each decision below is *what to build if it is built*, at the level ADR-0023 calls "the
design already exists in the ADR it links to". None is a commitment to build it.

### 1. A pause is a fact with an expiry, and a `Reject` says which kind it is

Findings **79** and **81**. Today `pause` sets a flag; the grammar has no `resume`, no
duration, and scenario 02's own walkthrough wrote `@signal-agent mute checkout-latency 2h`
as if both existed.

- **`pause` gains an optional duration and a `resume` counterpart.** `@<name> pause [<duration>]`
  where the duration is an ISO-8601 period or omitted for indefinite, and `@<name> resume`.
  The grammar goes to six forms. The scheduler already ticks
  ([ADR-0031](0031-the-resident-process.md) Decision 1), so an expiring pause is a
  timestamp the tick compares against, not a timer to manage — this is the cheap half.
- **A paused agent's `Reject` carries `afp:declineReason`,** one of `paused` or
  `capability`, so replay can tell an operator-imposed silence from a brain's own
  judgement. This is the half that costs a wire term, and it is worth it for the reason
  finding 14 established in a different context: silence is not a record. An auditor
  reading a `Reject` today cannot tell whether the agent was asked and declined, or was
  never really asked.
- **What stays out:** a pause that survives restart as anything other than the stored
  flag it already is, and any notion of a pause someone *other* than a controller can
  impose. Both widen the blast radius past the finding.

**Cost:** one wire term (`afp:declineReason`), two grammar forms, ~40 lines in
`ports/command.ts` and `federation/visibility.ts`, one scheduler comparison, one verifier
check (a `Reject` carrying the term has a value from the closed set), ~4 gate cases.
No migration: an absent `afp:declineReason` reads as today's meaning.

### 2. Leaving a hub is an event, and in-flight work gets a terminal outcome

Findings **85** and **88**.

- **Seat changes are their own admission-log entry.** `Follow` admitted, `Undo{Follow}`
  admitted, and a `Follow` refused by name all get a log entry parallel to the existing
  Enroll admission entry. This is the whole of 88 and it is nearly free — the seat OR-Set
  is already CRDT-tracked ([ADR-0037](0037-the-served-hub.md) Decision 3), so the entry
  records a transition the hub already computes.
- **`Undo{Follow}` gives in-flight work a terminal outcome,** the discipline finding 28
  gave agreement expiry. The hub emits, for each open Offer held by an agent the mass
  unenroll removes, a terminal activity naming the seat revocation as its cause — so a
  replay of the thread ends in an outcome rather than in silence, and the counterparty
  who was waiting learns why from the record rather than from a timeout.
- **The hard question this ADR does not answer, and names instead:** whether that
  terminal outcome is a *new* activity type or a reuse of the existing decline shape with
  Decision 1's `afp:declineReason`. Reuse is cheaper and couples the two decisions; a new
  type is honest that "the seat went away" is not a decline by anybody. The argument for
  reuse is that a reader wants one place to look for "this offer ended without a result",
  and the argument against is that seat revocation is the hub's act while a decline is the
  agent's, and the record should not attribute the hub's act to the agent. **On balance a
  new type**, for the attribution reason — but this is exactly the kind of call that
  should be taken with the code open, not here.

**Cost:** the log entry is ~20 lines and one gate case. The terminal outcome is one wire
term or one activity type, ~80 lines across `hub/seats.ts` and `hub/hub.ts`, one verifier
check (no open Offer survives a seat revocation in the same bundle), ~6 gate cases, and
one scenario re-walk of [14](../scenarios/14-the-seat-migration.md).

### 3. A claim says what it was reasoned over

Finding **82**'s remainder and finding **91**. ADR-0033 Decision 3 closed the half that
holds every `afp:producedBy` to the policy's declared `afp:brains` list. What is left is
the half a statutory deployment actually needs.

- **A declared-regulated capability MUST carry a template digest.** The policy document
  already names the brains; it gains a way to mark a capability as operating under a
  statutory duty, and for those the verifier requires `afp:producedBy` to carry the
  template digest rather than merely a declared brain. The stub brain carries none today,
  which is correct for a stub and wrong for a regulated path — the check makes the
  difference explicit instead of leaving it to which code path happened to run.
- **A Result reasoned over quarantined evidence says so.** ADR-0027's quarantine bounds
  what a poisoned attachment can make an agent *do*; it does not bound what it can make an
  agent *argue for*, and the next reader does not re-quarantine a signed Result. So a
  Result whose inputs included quarantined material carries a marker, and the marker
  travels — a Result citing that Result inherits it. This is the expensive one, because
  inheritance across citation is a property the verifier must check transitively and the
  instance must propagate, and because a marker that everything eventually carries is a
  marker nobody reads.
- **The reason to take these together:** both answer "what may a reader conclude about
  how this claim came to be", and both land on `afp:producedBy`. Building them separately
  would touch the same object twice and risk two vocabularies for one idea.

**Cost:** two wire terms, a policy-schema field, ~120 lines across `ports/brain.ts`,
`inbox.ts` and the policy validator, three verifier checks including one transitive walk,
~10 gate cases, and a re-walk of [09](../scenarios/09-the-screening-sidecar.md) and
[16](../scenarios/16-the-hostile-edge.md). **This is the only one of the three whose
design is not settled by this ADR** — the inheritance rule needs a walk of its own before
anyone writes it, because "how far does contamination travel" has no obvious stopping
point and a wrong answer is worse than no marker.

## Options considered

| Option | Rejected because |
|---|---|
| One ADR per cluster, three ADRs now | Two of the three are settled enough to state in a paragraph and none is scheduled; three Proposed ADRs that might never build is three documents a later reader must reconcile. ADR-0023 set the precedent for one ledger over many stubs |
| Leave them in the findings table with "no ADR home yet" | That is the state this ADR exists to end. A table cell cannot hold a cost, an option weighed, or the reason a call went the way it did |
| Build Decision 1 now, since it is cheap | Cheap is not the same as wanted. The program's one remaining claim is the first signed release ([ADR-0034](0034-release-conformance-and-disclosure.md)), and a new wire term before a first release is a term shipped before anyone has run the release process once |
| Fold finding 91 into ADR-0027 as an amendment | Its inheritance rule is unsettled, and an amendment to a built ADR should state a decision, not open a question |

## Consequences

**Accepted.** Three of the six get a design here that a builder could follow without
re-deriving it (79, 81, 88), two get a design with one named open call (85, and the
attribution question in Decision 2), and one is explicitly *not* settled (91, the
inheritance rule) with the reason stated. That is an honest spread and it is the point of
costing rather than scheduling.

**The risk this ADR carries** is the one every plan carries: a costed menu nobody orders
from reads, in six months, as six findings that have now been open twice as long and have
a document arguing about them. The mitigation is the closing protocol below, not optimism.

**What it does not do.** It adds no wire vocabulary, changes no code, and moves no
coverage cell. Every one of the six findings stays open in the index, now pointing here
instead of at "no ADR home yet".

## Closing protocol

Per [ADR-0023](0023-loose-ends-triaged.md) Decision 3: a row closes when this ledger names
the ADR or commit that closed it. A decision that builds gets its own ADR at that point —
this one is the argument, not the record of the build.

| Finding | Decision | State |
|---|---|---|
| 79 | 1 | costed, unscheduled |
| 81 | 1 | costed, unscheduled |
| 85 | 2 | costed, one open call (new type vs. reuse) |
| 88 | 2 | costed, unscheduled |
| 82 · rem. | 3 | costed, unscheduled |
| 91 | 3 | **design not settled** — wants a walk before a build |

## References

- [ADR-0023 — The loose ends, triaged](0023-loose-ends-triaged.md) — the precedent for this shape
- [ADR-0030 — Scenario re-walks and the coverage index](0030-scenario-re-walks-and-the-coverage-index.md)
- [Scenarios — what is still owed](../scenarios/README.md#what-is-still-owed) — the table these six come from
