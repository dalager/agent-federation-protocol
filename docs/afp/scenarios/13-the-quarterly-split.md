# Scenario 13 — The quarterly split: four support desks, one retainer, and a number nobody can check twice

> Spec-test scenario. The **P7 shakedown** — the first workload whose subject is not an
> event but a *set* of events. Every mechanism P1–P6 built makes one activity checkable:
> this signature, this tally, this proof, this expulsion. `afp:ContributionSummary` is the
> first object that claims something about a **period**, and it is the first claim in this
> protocol that cannot be checked by looking at any single thing in the record.
>
> It stresses P7's roadmap row — an independently recomputed, agreeing summary, and a
> dispute that resolves against the record rather than against a claim — using the most
> ordinary shared-work arrangement there is: four small companies covering one product's
> support line, paid from one pot, splitting it by who actually did the work.
>
> Deliberately *not* re-testing settled ground: allocation and awards
> ([scenario 04](04-federated-estimation.md), ADR-0003), the boundary
> ([scenario 08](08-the-subcontract.md), ADR-0008/0009), the shared hub
> ([scenario 10](10-the-incident-bridge.md)) and conviction-to-consequence
> ([scenario 12](12-the-parametric-trigger.md), ADR-0020/0021) appear here only where the
> quarter's arithmetic has to read them — and two of them turn out to have left an
> accounting question behind.

| **Support status** | **Supported — all nine findings closed** (campaign 10, opened and closed 2026-08-23) |
|---|---|
| Resolved by | [ADR-0022](../adr/0022-the-summary-declares-its-frame.md) — all five decisions **built** (66-73) · its [ADR-0017](../adr/0017-standards-conformance.md) amendment **built** (74) — [triage](README.md#campaign-10--built-scenario-13-the-p7-shakedown) |
| Gated by | `test/adr0022.test.ts` (24 cases — G6 is the fraction that cannot be canonicalised, G15 the partial view that claims to have read everything) |
| See it run | `npm run demo:p7` — four desks over real HTTP through a quarter of the shared queue: a ticket settled before the period opens and excluded by the hub's own chain, an escalation credited 1:3 between the desk that triaged it and the desk that fixed it, a seat expelled mid-quarter whose earlier work keeps its credit, and two honest computers reaching two different numbers because one of them may not read a ticket carrying customer data — settled by a dispute with evidence, a correction, and a round that ratifies it. `npm run demo:p7:llm` runs the same quarter with the three judgements the record cannot derive — what each desk did, how the shared ticket divides, whether the frame is right — written by a local model |

## User story

**As** the operations lead of a four-company out-of-hours support pool — four small
support desks in four time zones, covering one software vendor's customers between 18:00
and 08:00, paid from one quarterly retainer that is split by how much work each desk
actually did —
**I want** the quarterly split to be a number every desk can recompute from the same
evidence and agree with,
**so that** the retainer is divided by the record rather than by whoever argues hardest on
the call — and so that when a desk *does* dispute the split, we are arguing about a
number, not about whose spreadsheet to believe.

## Cast

Four independent companies, one standing hub, `nightdesk`, hosted by one of them (settled
ground, ADR-0014). The vendor is a customer, not a member: it files nothing and signs
nothing, it just pays the retainer and reads the summary. Its ticket system sits behind
Northwind's port in the scenario-06 pattern — an external initiator, kept outside the
record — so each ticket enters as an `Announce{afp:Task}` on the hub, allocated by the
ordinary P3 auction, answered with a signed `Create{afp:Result}`, and settled against
observed actuals (`afp:Settlement`, ADR-0004's recomputable reputation path).

| Instance | Agents in play | Role | Position on the split |
|---|---|---|---|
| `northwind.example` (**Northwind**) — **hosts the hub** | `triage`, `fixer` (members) | member + host | largest desk; handles most of the volume, and most of the confidential tickets |
| `dayshift.example` (**Dayshift**) | `triage` (member) | member | triages heavily, resolves rarely — its work is the first half of other desks' tickets |
| `kestrel.example` (**Kestrel**) | `fixer` (member) | member | small, senior, takes the escalations nobody else can close |
| `lantern.example` (**Lantern**) | `fixer` (member) | member | mid-sized; **expelled six weeks into the quarter** after an unrelated incident (ADR-0021) |

Nothing here is adversarial. That is the point, and it is the difference between this
scenario and the last one. Scenario 12's threats held valid keys and bad intentions;
**every party in this scenario is honest, and they still cannot agree on the number.**
The disagreements below are all produced by the protocol's own silences: two desks
recompute the same period from the same rules and get different answers, and neither of
them has done anything wrong.

## Walkthrough

**1. The quarter runs, and the ledger builds itself.** Ninety-one nights, roughly four
thousand tickets. Each one is announced to `nightdesk`, bid on, awarded, answered and
accepted — every step already checkable, and none of it new. By the end of September the
record holds exactly what 04 says the ledger is: signed `Result` activities in four
operators' outboxes, plus the acceptance evidence proving each Result was taken rather
than merely claimed.

**Held, and worth stating before anything strains:** the raw material of contribution
accounting exists and is sound. Nobody has to be trusted about what they did. Every
Result is signed by its author, hash-chained into an outbox nobody can quietly edit, and
bound to the task it answers by `afp:correlationId`. That is P1's four obligations still
doing their job at four thousand activities, and it is why P7 was scheduled last: it
consumes what the earlier phases already made true.

**2. Kestrel computes the summary, and the protocol is careful to say it has no right
to.** On 1 October, Kestrel publishes `afp:ContributionSummary` for 2026-Q3.
`afp:computedBy` names Kestrel, and 04 is explicit that this is "a field, not a
privileged role" — anyone may compute one, precisely so that nobody's arithmetic has to
be trusted. The summary carries per-operator ticket counts, a breakdown by capability, a
list of evidence pointers, and an `afp:inputHash`.

This is the design working as intended, and the rest of the scenario is what happens when
three other desks take the invitation seriously and recompute it.

**3. Lantern recomputes and gets a smaller number for Northwind — because it cannot see
Northwind's tickets.** Around a fifth of the vendor's tickets carry customer data:
account details, failed payment records, in one case a customer's own tax filing. Those
threads are published at `parties` visibility, and ADR-0013's read gate returns **404 to
everyone unentitled** — which, correctly, includes three competitor desks in the same
pool.

So Lantern recomputes honestly over everything it can read and arrives at a Northwind
figure roughly 20% lower than Kestrel's. Kestrel, who was entitled to more of it, gets a
different answer. Both are right. **04 says any member can recompute the summary because
it is "fully derived from public signed data" — and 07 guarantees that a substantial part
of the work is not public signed data** (**finding 70**). The two sentences have never
been read next to each other. The result is not a disagreement the record can adjudicate:
it is two honest computations over two different input sets, and nothing in the summary
says which set was used, or that a set was missing at all.

The shape of the fix is already in this repository, one layer down: ADR-0015's check
census exists precisely so that a check which could not be evaluated never reads as one
that passed. A summary computed over a partial view is exactly that, in accounting form.

**4. The escalations belong to two desks, and the field for saying so is unimplemented.**
The pool's normal working pattern is a handoff: Dayshift triages, reproduces, narrows,
and hands to Kestrel or Northwind, who fixes. Roughly 900 of the quarter's tickets end in
a Result whose `attributedTo` names two agents from two operators.

03 anticipated this exactly and requires `afp:contributionSplit` — "a map of actor →
fraction summing to 1" — whenever `attributedTo` names several actors, and states the
consequence of omitting it with unusual bluntness: verifiers "count such a Result for no
one rather than double-counting."

`afp:contributionSplit` appears in 03's vocabulary table and **nowhere in any
implementation** — no builder emits it, no check reads it (**finding 66**). So the
protocol's rule is in force and its mechanism is absent, and 900 tickets — nearly a
quarter of the quarter, and precisely the *collaborative* quarter — count for nobody. Not
for Dayshift, whose entire business model is the first half of somebody else's ticket.
The desk that does the most co-work is the desk the ledger can see least of.

Worse when someone does implement it: **a map of fractions summing to 1 cannot be
written down** (**finding 67**). The AFP JCS numeric profile forbids non-integer numbers,
which is not an inconvenience but the reason `afp:voterWeights` exists in the shape it
does — ADR-0005 hit this identical wall for vote weights and solved it with integer
shares over a least-common-multiple denominator, so that every weight is a whole number
and every implementation computes the same one. 03's contribution split was written
before that solution existed and never inherited it.

**5. The quarter has an edge, and the clock that decides who is inside it is
self-asserted.** A ticket arrives at 23:52 on 30 September and is resolved at 00:41 on 1
October. Which quarter pays for it?

`afp:period` names a `start` and an `end`, and the only instants available to select
activities are the `published` values on the activities themselves — which are
**self-asserted**, as campaign 7's finding 45 established — and ADR-0014 resolved by ruling
that "who knew what when" cannot rest on them (**finding 68**). At four thousand tickets, a desk that rounds
its own timestamps generously across a boundary moves real money, and no other desk can
tell: the record has no ordering that spans operators except the hub's own chain, which
is exactly the answer ADR-0014 already reached for a different question and nobody
carried into accounting.

Nobody in this pool does that. The finding is that nothing would show it if they did.

**6. `afp:inputHash` is a digest of nothing in particular.** Kestrel's summary carries
`"afp:inputHash": "sha256-…"`, and Lantern would like to compare it against its own
recomputation, which is the entire purpose of the field. It cannot: **no document defines
what the preimage is** (**finding 69**) — which activities, in which order, canonicalised
how, over which period boundary, including or excluding the unreadable ones from finding
70.

This is a shape the repository has met and closed before, twice. `afp:quorumSnapshot` was
"a digest nothing recomputes, decorative since P2" until ADR-0021 Decision 2a made it
arithmetic over the list it travels with; ADR-0006 made actuation checkable by pinning
what an action must hash against. A digest whose preimage is unspecified is not a
weaker check than a specified one — it is not a check, and it reads to a casual auditor
exactly like one.

**7. A fix that did not hold, and three vocabularies for saying so — none of which
counts.** In August, Kestrel resolved a payment-sync ticket; the Result was accepted and
the task settled. The customer came back in September with the same fault.

The record can say "it did not hold" in two ways, and in the commonest case, neither
applies. Where the August task was settled on estimates, the September re-open lands as
observed actuals in an `afp:Settlement` — reputation moves, by ADR-0004's recomputable
rule. Where an answer was *ratified*, ADR-0007's `afp:supersedes` retracts it with
ratification parity and disposes of what acted on it. But `afp:supersedes` is a property
of a **Synthesis**, and a routine support ticket awarded to one desk produces a bare
Result — so the September ticket is simply a *new* task, related to the old one by
nothing the record checks.

Does the August night still count as work done? Kestrel says yes — the fix was accepted
at the time, and a pool that pays only for fixes that turn out permanent is a pool where
nobody touches a hard ticket. Dayshift says no — the pool was paid for an outcome the
customer did not get. **The protocol says nothing at all** (**finding 71**): reputation
has a rule for a fix that did not hold, and contribution has none — and for the direct
Result there is not even a marker to hang the rule on.

**8. Lantern's six weeks.** Lantern was expelled from `nightdesk` in mid-August by a
ratified governance round — the machinery ADR-0021 built, working exactly as designed:
subject pinned, the accused recused from its own sanction by a cause anyone can
recompute, the expulsion published by a member and bound to the decision.

Then the quarter ends, and somebody has to decide what happens to the 600 tickets Lantern
resolved and had accepted before any of that. ADR-0021 was careful and explicit that
conviction and restoration are **forward-scoped** — a closed round's arithmetic never
moves — and said nothing whatever about whether an expulsion is forward-scoped for
*accounting* (**finding 72**). The two candidate readings are both defensible and they
differ by six weeks of one company's revenue: either the work was done and accepted and
therefore counts, with the expulsion recorded as a fact about the period, or a summary
sums only over current members and the expelled desk vanishes from a quarter it worked
two-thirds of.

**9. The dispute has no terminal.** Lantern files `afp:ContributionDispute` against
Kestrel's summary — the mechanical kind 04 anticipates, "you omitted this outbox entry" —
and, following 04's own instruction, resolves it by **republishing a corrected summary**.

There are now two `afp:ContributionSummary` objects for 2026-Q3, signed by different
members, differing in three of four operators' numbers. Neither is privileged, because 04
deliberately removed the privilege: `afp:computedBy` is a field, not a role. Nothing links
the second to the first — no `afp:supersedes`, no ratification, no terminal state
(**finding 73**). The protocol has an object that says what a quarter was worth, a
mechanism for challenging it, and no mechanism whatever for the challenge to *end*.

The escalation path for the genuinely contested cases — "was that ticket actually
resolved" — is in better shape, and this is the scenario's one piece of good news that is
newer than the phase itself: 04 routes those to an `afp:GovernanceDecision`, and since
ADR-0021 that is a real, recomputable, recusal-aware round rather than a noun. What is
missing is only the binding: nothing makes a summary the *output* of such a round, so
even a pool that votes cannot say which number the vote made true.

**10. Eighteen months later, the vendor's auditor asks for Q1.** The retainer contract
allows a look-back. In early 2028 the vendor's auditor asks the pool to re-derive the
2026-Q1 split from the archived bundles.

They do not replay. The Q1 bundles were written before `afp:bidCommit` was renamed
`afp:BidCommit`, and the verifier matches the new spelling exactly, so every bid
commitment in the archive is invisible and every award over it fails — reporting, to an
auditor, that the record contains reveals with no commitments (**finding 74**). The
record is intact; the reader has changed. **A summary is the first object in this
protocol whose inputs are historical by definition**, which makes it the first place
where a wire-vocabulary change stops being a migration detail and starts being an
accounting error. The repository already knows the answer here too: ADR-0017 Decision 2
kept draft-cavage as a read-side shim when it made RFC 9421 native, for exactly this
reason, and the rename that broke Q1 shipped without one.

*(Measured, not imagined: this is what a 2026-08-19 export bundle does against today's
verifier — ten failures, one cause.)*

## Acceptance criteria → mechanisms

| Criterion | Spec mechanism |
|---|---|
| The work itself is signed, chained and attributable | P1's four obligations, at 4,000 activities — **held** |
| A Result is evidence of acceptance, not just of claiming | Award → Result → `afp:Settlement` (P3); ratification via `afp:countedVotes` where a round decided — **held** |
| No one's arithmetic has to be trusted | `afp:computedBy` is a field, not a role (04) — **held in design** |
| Contested quality escalates to a governed decision | `afp:GovernanceDecision`, real since ADR-0021 — **held** |
| Two members recompute the same period and agree | **Strains** — findings 69, 70, 71, 72 |
| Co-authored work is credited to its authors | **Strains** — findings 66, 67 |
| The period has an edge no one can move | **Strains** — finding 68 |
| The summary states what it summed | **Strains** — finding 69 |
| A dispute ends | **Strains** — finding 73 |
| A quarter can still be recomputed years later | **Strains** — finding 74 |

## Spec verdict

**Held: the ledger.** Everything P7 is supposed to consume exists, is signed, and is
already checkable — Results in outboxes, acceptance bound to them, roles and reputation
recomputable, and, since ADR-0021, a governance round fit to adjudicate the cases
arithmetic cannot. Scheduling contribution accounting last was right: it inherits a
genuine ledger rather than inventing one, and nothing in this scenario suggests the
ledger is the problem.

**Strained: the frame.** Every finding here is the same defect wearing a different hat.
**A sum is only as recomputable as its input set is agreed, and the protocol does not
name sets.** P1 through P6 made each *event* checkable — this signature, this tally, this
proof, this expulsion — and every one of those mechanisms answers a question about a
thing you can point at. `afp:ContributionSummary` is the first object whose subject is a
*boundary*: which events, over which window, seen by whom, counted at what weight, still
valid under which vocabulary. Nine findings, and each one is a different edge of that
boundary left undrawn — the period edge (68), the visibility edge (70), the authorship
edge (66, 67), the validity edge (71, 72), the vocabulary edge (74), the statement of the
set itself (69), and the question of whose set wins (73).

That framing predicts the shape of the fix, which is why it is worth stating before any
ADR is written: **the summary must declare its own frame and be checked against it**,
exactly as ADR-0018 made a round declare its deadline, bar, binding and policy before
anyone voted. A summary that pins its period rule, its input scope, its split
arithmetic, its treatment of superseded and expelled work, and the vocabulary it was
computed under is recomputable by construction — and one that declares none of those is
a number in a signed envelope, which is what this pool has today.

**A pattern this campaign confirms for the fourth time:** machinery gains power faster
than the rules governing access to it, and *fields outlive the mechanisms they were
written for.* `afp:contributionSplit` has been normative since v3 and implemented never;
`afp:inputHash` has been in 04's example since the same revision with no preimage ever
defined. Both are the `afp:hubKey` shape ADR-0021's W0.8 named — a field nobody checks is
documentation pretending to be a mechanism — and both sit directly under the arithmetic
P7 exists to make checkable.

**One thing this scenario deliberately does not conclude.** Whether the vendor's money
should follow the summary at all is outside the protocol boundary and stays there: 04 is
explicit that pricing, payment and any transferable credit are out of scope, and nothing
above asks for that to change. The finding is not that the protocol should pay people. It
is that a number the protocol *does* publish, and that four honest companies cannot
recompute the same way twice, is worse than no number — because it looks like agreement.

**Strained — nine findings:**

66. **`afp:contributionSplit` is required and implemented nowhere.** 03 makes it a MUST
    when `attributedTo` names several actors and rules that a Result lacking it counts
    for no one; no builder emits it and no check reads it. It has been normative since
    v3.4, where campaign 1's finding 7 introduced it as co-work's escape hatch — three
    years of spec-time with nothing behind it. The pool's most common working pattern — one desk triages, another fixes — therefore credits neither.
    Candidate: implement it on both sides, and make "counts for no one" a *visible*
    outcome in the summary rather than a silent subtraction.

67. **A fraction map summing to 1 is unrepresentable.** The AFP JCS numeric profile
    forbids non-integer numbers, which is why `afp:voterWeights` carries integer shares
    over an LCM denominator (ADR-0005). 03's split was specified as fractions and never
    inherited that solution. Candidate: integer shares plus a declared denominator,
    the same arithmetic, unforked.

68. **The period is drawn on self-asserted clocks.** `afp:period` selects on `published`,
    which campaign 7's finding 45 (resolved by ADR-0014) already established cannot carry
    cross-operator ordering claims. A ticket that straddles a quarter boundary belongs to whichever quarter its
    author says. Candidate: define the period over hub-observed order — ADR-0014's own
    answer, applied to the one question it did not anticipate.

69. **`afp:inputHash` has no defined preimage.** The field exists to let a second party
    confirm it summed the same things, and nothing states what "the same things" are.
    Same shape as `afp:quorumSnapshot` before ADR-0021 Decision 2a. Candidate: define the
    canonical input set and ordering, recompute it at replay, and fail a summary whose
    advertised hash does not match the set it declares.

70. **"Anyone can recompute it" collides with visibility.** 04 calls the inputs "public
    signed data"; 07 and ADR-0013 guarantee that non-`public` work is served to nobody
    unentitled — 404, by design. Two members recompute honestly and disagree, with no way
    to tell an entitlement gap from an error. Candidate: the summary declares its input
    scope and counts what the computer could not read, so a difference is *visible* and
    attributable rather than an accusation — ADR-0015's census, in accounting form.

71. **Work that did not hold has no accounting rule — and often no marker.** The record
    already says "it did not hold" two ways — `afp:Settlement` actuals move *reputation*
    (ADR-0004), and `afp:supersedes` retracts a *ratified Synthesis* (ADR-0007) — but
    neither states a contribution consequence, and the commonest case, a bare Result on
    a direct award, has no vocabulary at all: the re-opened ticket is just a new task.
    Candidate: rule it explicitly — contribution is credited at acceptance, and a
    settlement or supersession is recorded as its own fact inside the period rather than
    un-counting the night — and check it, so both readings stop being available.

72. **An expulsion's accounting scope is unstated.** ADR-0021 ruled conviction and
    restoration forward-scoped for *weight* and said nothing about contribution. A
    summary spanning an expulsion either counts the expelled member's accepted work or
    erases six weeks of it. Candidate: state the parallel — accounting is forward-scoped
    too, work accepted before the act counts, and the summary records the membership
    change inside its own period.

73. **A dispute has no terminal.** 04 resolves the mechanical case by "republishing a
    corrected summary", which produces two unranked summaries for one period with no
    supersession edge, no ratification and no rule for which stands. Candidate: a summary
    becomes authoritative by ratification in an ADR-0018 round (the machinery exists and
    ADR-0021 made it recusal-aware); corrections supersede under ADR-0007's grammar;
    everything else is a draft and says so.

74. **A summary's inputs are historical, and the vocabulary moves.** Renaming
    `afp:bidCommit` to `afp:BidCommit` (ADR-0017 Decision 5) shipped with no read-side
    compatibility, so bundles written before it fail replay today — and fail *misleadingly*,
    reporting reveals with no commitments rather than a retired type name. For every
    other object that is a migration nuisance; for the first object whose inputs are
    historical by definition it is an accounting error with a signature on it.
    Candidate: read-side aliases for renamed types (the draft-cavage precedent, ADR-0017
    Decision 2), a named failure when a bundle uses a retired spelling, and a summary
    that pins the vocabulary version it was computed under.

## Running it

`npm run demo:p7` runs this scenario end to end — four desks, real sockets, one quarter,
and the four case files replay together clean at 977 checks. `demo:p7:llm` runs it with a
local model making the three calls the record genuinely cannot derive, and on the run that
built it the model divided the escalation **3:1 toward the desk that triaged** — the
inverse of the scripted split, moving the quarter's numbers while every check still passed.
That is the property worth seeing: the desks argue about a judgement, and the arithmetic
does not move. What follows is what was true when the
scenario was *walked*, which is the record this directory keeps: P7 was unbuilt, and this
scenario was written before its stack ADR on purpose — the third time (after [scenario 10](10-the-incident-bridge.md) for P5
and [scenario 12](12-the-parametric-trigger.md) for P6), and for the reason the roadmap
now states as a standing pattern. Both earlier walks produced defects that reading the
spec alone had not, and both were cheaper to fix before the phase existed than after.

What *can* be run is the evidence a summary would sum: `npm run demo:p3` produces awards,
Results and settlements over a real auction, and `npm run demo:p6` produces the
acceptance and governance record around them, including the expulsion finding 72 asks
about. Replaying either bundle shows the ledger; nothing yet shows the roll-up.

## Coverage as of 2026-09-13

Per ADR-0030 Decision 1, this section classes each acceptance criterion by how it is
covered rather than only whether its finding closed. Scenario 13's own criteria table
predates ADR-0022; against today's build the strong majority run as workload in
`npm run demo:p7` (four instances, real sockets, one quarter of tickets) with
`test/adr0022.test.ts` gating the resulting bundles, and the remainder are gated
mechanism checks the non-`:llm` demo does not narrate as workload.

| Criterion | Class | Evidence |
|---|---|---|
| The work itself is signed, chained and attributable | workload demonstrated | `npm run demo:p7` · `test/adr0022.test.ts` G2 — co-authored Results chain and verify |
| A Result is evidence of acceptance, not just of claiming | workload demonstrated | `npm run demo:p7` · `test/adr0022.test.ts` G2 — awarded, accepted, credited |
| No one's arithmetic has to be trusted | workload demonstrated | `npm run demo:p7` · `test/adr0022.test.ts` G18 — a second party's arithmetic checked, not the computer's identity |
| Contested quality escalates to a governed decision | workload demonstrated | `npm run demo:p7` · `test/adr0022.test.ts` G25 — mechanical dispute with evidence replays clean |
| Two members recompute the same period and agree | workload demonstrated | `npm run demo:p7` · `test/adr0022.test.ts` G10/G14 — hub-observed period, declared scope |
| Co-authored work is credited to its authors | workload demonstrated | `npm run demo:p7` · `test/adr0022.test.ts` G2/G4 — integer-share split replays clean |
| The period has an edge no one can move | workload demonstrated | `npm run demo:p7` · `test/adr0022.test.ts` G10/G17 — hub-observed chain, not self-asserted time |
| The summary states what it summed | mechanism gated | `test/adr0022.test.ts` G11/G13 — frameless or mismatched hash fails by name |
| A dispute ends | workload demonstrated | `npm run demo:p7` · `test/adr0022.test.ts` G22/G24 — ratification resolves two standing summaries |
| A quarter can still be recomputed years later | mechanism gated | `test/adr0022.test.ts` G9 — a retired-vocabulary bundle is read and the fact is named |

**Counts:** 8 demonstrated · 2 gated · 0 narrowed · 0 not built.
