# Scenario 04 — A question pushed to the hub: federated estimation

> Spec-test scenario. Exercises: question-shaped tasks, **self-organizing allocation with
> unknown arity** ("maybe more than one — it depends"), partial answers, reconciliation of
> divergent estimates, and returning one agreed answer to the hub. This is the first
> scenario where the *deliverable is an estimate* — nothing at answer-time can verify it.
> Verdict at the end.

| **Support status** | **Supported — all findings closed** |
|---|---|
| Findings raised | 6 |
| Resolved by | spec v3.5 — coalition allocation, `afp:Synthesis`, `afp:Settlement` ([03](../03-coordination.md), [04](../04-operations.md)) |
| See it run | `npm run demo:p3` · `npm run demo:p3:llm` |
| Gated by | `allocation.test.ts` |

**Read the walkthrough below as history.** It records what strained when this workload was
first walked, and is deliberately left as written — that is what makes a scenario evidence
rather than a brochure. Every strain it names is now built; the
[support index](README.md#is-this-workload-supported) is the current-status view, and the
ledger there names the decision that closed each finding.


## User story

**As** a partner who has just been asked by a client "what would this cost, given these
constraints?",
**I want** to push the question to the hub and have the connected agents work out among
themselves who is competent to answer — one of them, or several, depending on what the
question touches — and return a single agreed answer,
**so that** I get a defensible number with its assumptions, its uncertainty, and any
dissent intact — not a confident-sounding figure nobody can stand behind.

## The question

> *What is the cost of migrating the client's on-prem billing platform to a managed cloud
> runtime, given: (a) no downtime window may exceed 15 minutes; (b) PCI-DSS scope must not
> expand; (c) completion before the Q3 regulatory deadline; (d) existing Oracle licenses
> are non-transferable?*

Four constraint domains — infrastructure, data, compliance, licensing — and **no single
agent covers them all**. That is what makes the arity data-dependent: how many estimators
are needed is a property of the question, discovered from the bid pool, not declared by
the asker.

## Cast

Hub `hub-nordbook`, two instances enrolled (following scenario 03's world).

| Firm | Agent | Capability |
|---|---|---|
| Alpha | `a-infra` | `estimate.cost` — cloud runtime, cutover |
| Alpha | `a-data` | `estimate.cost` — data migration |
| Alpha | `a-frontend` | `impl.frontend` (no estimating capability here) |
| Bravo | `b-compliance` | `estimate.cost` — PCI/regulatory scope |
| Bravo | `b-licensing` | `estimate.cost` — vendor licensing |
| Bravo | `b-spec-1` | `spec.upstream` |

## Walkthrough

**1. The question enters the hub.**
`afp:Announce{Task}`: capability `estimate.cost`, the four constraints as structured
attachments (each hash-addressed, §17), deadline 48h, `context: "urn:afp:question:q-88"`.
The announcer does **not** state how many estimators it wants — it can't know.

**2. Allocation by coverage, not by winner.**
The published award rule (§09 requires it up front) is a *set-selection* function, not a
ranking: **select the minimal set of bidders whose declared domain coverage spans all four
constraint domains at confidence ≥ 0.6; break ties deterministically; name the
broadest-coverage awardee as synthesizer.**

Sealed bids (commit-reveal — these are competing firms, and the answer frames a budget
both may later bid to execute) reveal partial coverage:

| Bidder | Claims coverage of | Confidence |
|---|---|---|
| `a-infra` | runtime, cutover | 0.8 |
| `a-data` | data migration | 0.75 |
| `b-compliance` | PCI scope, regulatory deadline | 0.8 |
| `b-licensing` | Oracle licensing | 0.9 |

`a-frontend` and `b-spec-1` **explicitly decline** with reasons — not silence. That
matters: the record now shows the question was seen by all six enrolled agents and
consciously declined by two, so an auditor can later establish that the right people were
asked (see verdict, finding 6).

`afp:Award` names **four performers** and the synthesizer (`b-compliance`, broadest
coverage). Anyone can recompute the coverage function over the revealed bids and verify
the selection — including the fact that arity 4 was forced by the bid pool, not chosen.

**3. Parallel partial estimates.**
Each awardee returns `Create{afp:Result}` on the shared `context`, carrying a **range, not
a point**, plus confidence, explicit assumptions, and rationale:

| Estimator | Range (MDKK) | Confidence | Key assumption |
|---|---|---|---|
| `a-infra` | 3.2 – 4.1 | 0.75 | Lift-and-shift, single cutover |
| `a-data` | 1.4 – 1.9 | 0.7 | **Dual-run parallel period required** |
| `b-compliance` | 0.9 – 1.4 | 0.8 | Scope containment achievable via network segmentation |
| `b-licensing` | 2.1 – 2.6 | 0.9 | Replacement licensing at list, vendor quote attached |

**4. Reconciliation — where it gets interesting.**
The estimates are not simply additive: `a-infra` assumed a single cutover, `a-data`
assumed a dual-run parallel period. **Those assumptions contradict each other**, so
summing them would produce a number resting on incoherent premises.

The synthesizer opens a ping-pong thread (§7.2 co-work pattern) between the two: `a-data`
argues the 15-minute downtime constraint makes single cutover infeasible for a billing
dataset of this size; `a-infra` concedes and revises to **4.6 – 5.8** on a dual-run
premise. Every step is a signed Result on the same `context` — the disagreement and its
resolution are part of the record, not a private chat.

**5. Dissent that must not be averaged away.**
`b-licensing` files a `Result` asserting that the Q3 deadline is **not achievable at any
cost**, because the vendor's replacement licensing has a 14-week procurement lead time.
This is not a cost disagreement — it is a feasibility objection, and no amount of numeric
aggregation can express it.

A synthesized point estimate would erase exactly the thing the partner most needs to know.

**6. The synthesis.**
The synthesizer emits `Create{afp:Synthesis}` binding the answer to its inputs:

```json
{
  "type": "afp:Synthesis",
  "context": "urn:afp:question:q-88",
  "afp:method": "sum-of-disjoint-ranges",
  "afp:answer": { "unit": "MDKK", "low": 9.0, "high": 11.7 },
  "afp:confidence": 0.72,
  "afp:contributingResults": ["sha256:res-a-infra-rev2...", "sha256:res-a-data...",
                              "sha256:res-b-compliance...", "sha256:res-b-licensing..."],
  "afp:assumptions": ["dual-run parallel period", "network segmentation contains PCI scope",
                      "replacement licensing at list price"],
  "afp:dissent": [{ "actor": "https://bravo.example/agents/b-licensing",
                    "summary": "Q3 deadline unachievable at any cost: 14-week licensing lead time",
                    "result": "sha256:res-b-licensing-feasibility..." }],
  "afp:supersededInputs": ["sha256:res-a-infra-rev1..."]
}
```

Note what the object preserves: the method (so the arithmetic is checkable), every
contributing Result by hash, the assumption set the number rests on, the superseded first
estimate, and **the dissent as a first-class field** rather than a footnote.

**7. Ratification, because a synthesizer has discretion.**
The synthesizer chose a method and adjudicated an assumption conflict — real discretion,
exercised by one firm's agent over a number that frames both firms' commercial exposure.
Hub policy therefore requires ratification: an L1 round (§10) across the four estimators
ratifies the Synthesis. It passes 3–1, `b-licensing` voting against on feasibility
grounds. The `afp:DecisionRecord` references the Synthesis and records the split.

**Precision from §10's guarantee table:** with two operators this L1 round buys
*accountability*, not tolerance — nobody can later claim they didn't sign off, but there
is no honest majority to overrule a dishonest firm. That is the correct expectation here.

**8. The hub gets its answer.**
`Create{afp:Result}` on `context: q-88`, addressed to the asker and the hub, referencing
the Synthesis and the DecisionRecord. `afp:visibility: parties` — this number is a client
quote input, not hub-public (§17).

What the partner sees in Mastodon: *"q-88 answered: 9.0–11.7 MDKK (confidence 0.72), 3–1,
with a recorded feasibility objection to the Q3 deadline."* The dissent travels with the
answer all the way to the human.

**9. Settlement, months later.**
If the migration is actually commissioned and completes at 10.4 MDKK, an `afp:Settlement`
links the original estimates to observed actuals: `a-infra` ran 8% under, `b-licensing`
was exact, and the feasibility objection proved correct (the deadline slipped). Only now
can estimate accuracy feed reputation — and the dissenter's standing should *rise*.
If the work is never commissioned, the estimates simply stay unsettled forever.

## Acceptance criteria → spec mapping

| Criterion | Spec mechanism |
|---|---|
| A question can be pushed to a hub like any task | §07 `afp:Task` + §09 Announce |
| Agents decide among themselves who answers | §09 bidding with a published selection rule |
| One answerer or several, depending on the question | Coverage-based multi-award (finding 1) |
| Non-answerers are on the record as having declined | Explicit decline in the bid window (finding 6) |
| Divergent partial answers get reconciled openly | §7.2 ping-pong thread on shared `context` |
| One agreed answer reaches the hub | `afp:Synthesis` + closing Result (finding 2) |
| Uncertainty and dissent survive to the human | Synthesis range/confidence/dissent fields |
| The synthesizer's discretion is checked | §10 L1 ratification + §16 DecisionRecord |
| Answer confidentiality respected | §17 `parties` visibility |
| Estimators are eventually scored on accuracy | `afp:Settlement` (finding 3) |

## Spec verdict

**Held.** Announce/bid/award, threading, the ping-pong reconciliation pattern, L1
ratification, DecisionRecord, visibility classes, and hash-addressed evidence all carried
this scenario without strain. The v3.4 additions earned their keep immediately: `context`
threading held a seven-hop conversation together, and `parties` visibility was exactly
right for a client quote.

**Strained — six findings:**

1. **`afp:Award` is single-winner.** The spec's allocation assumes one performer chosen by
   ranking. "Maybe more than one — it depends" requires awarding to a **set**, selected by
   a coverage function over declared partial competencies, with arity emergent from the
   bid pool. Needs: multi-performer Award, a `afp:coverage` claim on Bids, and the
   selection rule generalized from "highest score" to "any published deterministic
   set-selection function." The synthesizer role must be named by that same rule, since
   whoever synthesizes holds real discretion.
2. **No synthesis primitive.** `DecisionRecord` answers *"what did we decide"* — discrete,
   from votes. An estimate needs *"what do we know, and how sure are we"*: an
   `afp:Synthesis` binding a possibly-continuous answer to its contributing Results by
   hash, with method, range, confidence, assumption set, superseded inputs, and
   **dissent as a first-class field**. Collapsing a spread into a point number destroys
   the information the requester most needs. The two objects are complementary, not
   alternatives — here the DecisionRecord ratifies the Synthesis.
3. **Reputation settlement is deferred and may never come.** §09 scores bidders on
   estimate-vs-actual, which silently assumes actuals arrive promptly. For pure estimation
   the feedback loop closes months later or never. Needs an explicit `afp:Settlement`
   activity linking prior estimates to observed actuals, plus an *unsettled* state so
   reputation isn't quietly credited or penalized on evidence that doesn't exist yet.
4. **Estimator/bidder conflict of interest is unaddressed.** Whoever answers "what does
   this cost" frames the budget for work they may later bid to perform — an incentive to
   shade, in either direction. Commit-reveal protects against bid sniping, not against
   this. Needs a stated separation-of-duties convention: hub policy either excludes
   estimators from bidding on the estimated work, or records bid-vs-own-estimate
   divergence as a reputation signal.
5. **Answer sufficiency ≠ voting quorum.** §13's quorum math governs *voting*
   participation. "How many independent estimates constitute an acceptable answer" is a
   different sufficiency threshold — and here it was satisfied by *coverage* (all domains
   spanned) rather than by count. Worth distinguishing explicitly; a hub may want either,
   or both.
6. **Silence is ambiguous on announced tasks.** Non-bidding could mean "not my domain,"
   "offline," or "never saw it." For audit ("were the right people asked?"), agents that
   cannot contribute SHOULD decline explicitly within the window, making coverage of the
   enrolled population provable rather than inferred.

**Minor precision:** `afp:Bid.estimatedCost` means *what performing this task costs me* —
which in an estimation task collides conceptually with the cost figure being asked about.
The two must not be confused; worth a note in the vocabulary.

## Coverage as of 2026-09-13

This is ADR-0030 Decision 1's coverage section. Scenario 04 is one of the review's
close-behind scenarios: `demo:p3` runs almost the entire walkthrough end to end — coverage
award, decline, the estimator wall, dissent, ratification and settlement — so most rows
are workload demonstrated rather than only mechanism gated.

| Criterion | Class | Evidence |
|---|---|---|
| A question can be pushed to a hub like any task | workload demonstrated | `npm run demo:p3` · `test/demos.test.ts` (bundle replays) · `test/allocation.test.ts` "the panel covers every announced domain, and a gap fails at build time" — Announce over the estimation panel |
| Agents decide among themselves who answers | workload demonstrated | `npm run demo:p3` · `test/demos.test.ts` (bundle replays) · `test/allocation.test.ts` "coverage picks the minimal covering set and names the broadest awardee synthesizer" |
| One answerer or several, depending on the question | workload demonstrated | `npm run demo:p3` · `test/demos.test.ts` (bundle replays) · `test/allocation.test.ts` "coverage picks the minimal covering set and names the broadest awardee synthesizer" — arity 4 emergent |
| Non-answerers are on the record as having declined | workload demonstrated | `npm run demo:p3` · `test/demos.test.ts` (bundle replays) · `test/allocation.test.ts` "the demo export passes the independent verifier, and targeted mutations fail it" — declines recorded, not inferred |
| Divergent partial answers get reconciled openly | mechanism gated | `test/hub.test.ts` "enrolls agents, tallies a round, and rejects an out-of-snapshot vote" — shared-`context` threading, no dedicated ping-pong reconciliation demo step |
| One agreed answer reaches the hub | workload demonstrated | `npm run demo:p3` · `test/demos.test.ts` (bundle replays) · `test/allocation.test.ts` "the demo export passes the independent verifier, and targeted mutations fail it" — Synthesis + closing Result |
| Uncertainty and dissent survive to the human | workload demonstrated | `npm run demo:p3` · `test/demos.test.ts` (bundle replays) · `test/allocation.test.ts` "credits vindicated dissent with full accuracy" — dissent as a first-class Synthesis field |
| The synthesizer's discretion is checked | workload demonstrated | `npm run demo:p3` · `test/demos.test.ts` (bundle replays) · `test/allocation.test.ts` "the demo export passes the independent verifier, and targeted mutations fail it" — L0 ratification, DecisionRecord |
| Answer confidentiality respected | mechanism gated | `test/hub.test.ts` "enforces roles: requester/observer never pinned or bidding; requester announces and settles" — `afp:visibility` scoping, not scenario-specific |
| Estimators are eventually scored on accuracy | workload demonstrated | `npm run demo:p3` · `test/demos.test.ts` (bundle replays) · `test/allocation.test.ts` "gives a neutral prior of exactly 50 to a bidder with no history" — `afp:Settlement` against actuals |

**Counts:** 8 demonstrated · 2 gated · 0 narrowed · 0 not built.
