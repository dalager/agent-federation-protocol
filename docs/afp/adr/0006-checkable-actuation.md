# ADR-0006 — Checkable actuation: the action policy and the performer wall

- **Status:** Accepted, and **built** (see [Build status](#build-status))
- **Date:** 2026-08-20
- **Applies to:** the solo profile onward — both decisions are announce-pinned record
  extensions with no federation dependency
- **Builds on:** [ADR-0003](0003-p3-allocation-stack.md) Decisions 3 and 6 — the two
  patterns reapplied here — and [ADR-0004](0004-solo-foundation-hardening.md), whose
  requester write-path is what lets a port agent act at all
- **Driven by:** [scenario 06 / campaign 4](../scenarios/README.md#campaign-4--open),
  findings 20 and 23

## Context

Scenario 06 is the first workload where the swarm **acts** on a conclusion it reached —
comments on an external tracker, recategorizes an issue, opens a pull request — rather
than only recording the conclusion. That direction exposed a asymmetry in the record's
discipline:

- *How the answer was reached* is checkable end to end. Selection is a pinned named rule,
  recomputed at replay (ADR-0003 Decision 3). Reputation input is a pinned named
  derivation over a pinned snapshot (ADR-0004 Decision 3). Estimator separation is a
  pinned exclusion, enforced at admission (ADR-0003 Decision 6).
- *What was done about the answer* is checkable not at all. The branch — this category
  means open a fix task, that one means recategorize — lives in the acting agent's
  workflow code. A replay sees a Synthesis saying `not-a-bug` followed by a pull request,
  both validly signed, and no check anywhere says the second does not follow from the
  first. A port agent that obeys triage and one that ignores it are the same activities
  on the record.

That is the "enforcement that leaves no trace" ADR-0003 Decision 6 rejected, relocated
from admission to consequence. And finding 23 is the same lesson at smaller scale:
Decision 6 built a wall for exactly one pair — the agent that estimated a task may not
bid on it — when "the agent that performed a task may not review it" is the identical
shape with no mechanism. One wall, specified once, generalizes both.

Both fixes follow the two rules every prior registry obeyed: **pinned in the Announce
before anyone acts**, and **recomputable from the record alone**.

## Decisions

### 1. `afp:actionPolicy` — what may be done about an answer, pinned before the answer exists

An Announce MAY carry `afp:actionPolicy`: a map from **category** to **admissible
action**, both plain strings, published up front like the selection rule. Pinning it
commits three things downstream:

```json
"afp:actionPolicy": {
  "mechanical-fix": "announce-fix",
  "not-a-bug": "recategorize",
  "needs-elevation": "assign-team",
  "insufficient-information": "request-info"
}
```

- **The category set is closed.** A Synthesis answering a policy-bearing task MUST carry
  `afp:category`, and it MUST be one of the policy's keys. An answer outside the closed
  set is a named verifier failure — a policy over categories the answer can ignore
  constrains nothing.
- **An action names its justification.** An activity that acts on a conclusion carries
  `afp:actsOn` — the digest of the Synthesis activity it acts on — and `afp:action`, the
  action name it claims to be. This is the same evidence-binding move as
  `afp:countedVotes`: the consequence points at its cause by hash, so "why did this
  happen" is a lookup, not an inference.
- **Replay recomputes the branch.** For every activity carrying `afp:actsOn`: the digest
  must resolve to a present Synthesis (acting on a justification you cannot produce is
  the actuation-flavored counted-vote-you-cannot-produce); the governing Announce is
  found through the record's own chain (Synthesis → `afp:award` → Award → `afp:task` →
  Announce); and where that Announce pinned a policy, `afp:action` MUST equal
  `policy[category]`. A mismatch is a named failure.
  *(Amended by [ADR-0010](0010-pinning-without-an-auction.md): that chain now has a
  second root — a direct `Offer{Task}` may pin the policy, resolved through the thread —
  and `afp:actsOn` may name a DecisionRecord, resolved one hop to the Synthesis. This
  ADR's pin-it-up-front discipline is unchanged; only the set of carriers grew, because
  anchoring solely to the Announce disarmed all of it in the flow the spec recommends
  first.)*
- **Opt-in, like everything before it.** An Announce that pins no policy constrains no
  actions, and every existing record reads unchanged.

Deliberately a **literal map, not a registry of functions**. Selection and reputation are
*algorithms* — families of computation over bids and settlements, worth a named registry
with parameters. An action policy is a decision table: category in, action name out. A
pinned map is recomputable by definition, needs no second implementation of anything, and
cannot hide logic. The registry pattern is the right tool exactly when there is
computation to mirror; here there is none, and pretending otherwise would add surface for
divergence with no power in return.

What the record checks is the **binding** — this action, this justification, this pinned
admissibility. Whether the port agent then *performed* the external action faithfully is
03's existing reconciliation duty (the follow-up Result with the external reference), and
whether the action *name* honestly describes the external effect is at the port boundary
with everything else 06 already places there.

### 2. `afp:excludePerformersOf` — the estimator wall, generalized to any prior task

An Announce MAY carry `afp:excludePerformersOf`: a list of **prior task ids**. Any agent
named in `afp:performers` of a listed task's Award is excluded from this auction:

- **At admission** — its commit is rejected and audit-logged, the estimator wall's exact
  lane.
- **At replay** — the verifier resolves each listed task's Award from the record (a
  listed task with no resolvable Award is a named failure — an exclusion you cannot
  reconstruct excludes nobody), rebuilds the excluded set, drops those bidders from the
  admitted pool, and additionally checks the declared performers directly: an awarded
  performer who was excluded is the named failure, mirroring the estimator check.

Scenario 06's review step is the motivating instance: the review task announces with
`afp:excludePerformersOf: [fix-task]`, and the agent that wrote the diff cannot be the
agent that certifies it — enforced and checkable, not remembered by workflow code.

`afp:estimatorPolicy`/`afp:estimators` **stay as they are**. The estimator wall excludes
by *role in this task's own prehistory* (who scoped it — a fact not derivable from any
Award), the performer wall excludes by *outcome of a named prior task* (who did it — a
fact the record already holds). Folding the first into the second would require
estimation to become a recorded task before every auction, which is ceremony ADR-0003
declined once already.

## Options considered

| Option | Rejected because |
|---|---|
| Leave actuation to workflow code | The finding itself: a compliant actor and a rogue one are indistinguishable at replay, in the first scenario class where the swarm changes the outside world |
| An action-policy *registry* of named functions, like selection rules | There is no computation to name: category → action is a table. A registry adds a second implementation, a divergence surface, and an unknown-name failure mode, all for a lookup a literal map does for free |
| Bind actions to the DecisionRecord instead of the Synthesis | Not every acted-on answer is ratified by a round (04 grants MAY-ratify latitude); the Synthesis is the answer itself, and where a round exists it names the Synthesis anyway |
| Hub-side enforcement of the action policy | The hub never performs external actions — port agents do, often on their own threads. The hub cannot see a tracker comment happen; the record can see whether it was admissible. Enforcement lives where the evidence is |
| Extend `afp:estimators` to cover reviewers ad hoc | A second bespoke wall today, a third next scenario. The general form — exclusion bound to a named prior task's performers — makes the estimator case one instance of a pattern instead of the only one |
| Exclude by capability instead of by prior performers | "No agent with `afp:cap:fix` may review" excludes the wrong set: the conflict is having written *this* diff, not being able to write diffs |

## Consequences

**Positive**

- The question scenario 06 could not answer — *did the action follow from the answer?* —
  becomes a replay check, with the same shape as every check before it: pinned up front,
  recomputed from the record, named on failure.
- Author/reviewer separation costs one announce field, and the next separation-of-duties
  pair (deployer/approver, whatever a scenario surfaces) costs zero new mechanism.
- `afp:actsOn` gives every external side effect a hash-bound justification, which is the
  half of finding 24 that could be had now: when an answer is later superseded, the
  actions that cited it are findable by digest, not by narrative.

**Negative / accepted risks**

- An action policy is only as honest as its action names — `afp:action: "recategorize"`
  on an activity whose port actually closed the issue is a lie the record cannot see.
  Accepted: that gap is the port boundary (06), where every other external-truth question
  already lives, and 03's reconciliation duty is the existing mitigation.
- The performer wall resolves exclusions through prior Awards, so it excludes performers,
  not colluders — an agent that *influenced* a fix without being awarded it is not
  caught. Accepted: the record can only enforce distinctions it contains.
- Categories and action names are uncontrolled vocabulary between hubs. Accepted at solo
  scale, same as selection-rule params; a shared vocabulary is a federation-era question.

**Revisit triggers**

| Trigger | Reconsider |
|---|---|
| A policy wants conditions, not categories ("fix only if severity ≥ X") | Whether the map becomes a named guarded-rule registry — the computation that justifies one would then exist |
| Supersession lands (finding 24) | Whether an action whose `afp:actsOn` target is superseded needs a recorded disposition of its own |
| A second separation pair appears | It should cost zero mechanism; if it does not, Decision 2 missed its generalization |

## Build status

| ID | Task | Status | Where |
|---|---|---|---|
| **C1** | `afp:actionPolicy` + `afp:category` on the announce/synthesis builders; `afp:actsOn`/`afp:action` action builder with writer-side admissibility check | **done** | `allocation/activities.ts`, `allocation/actions.ts` |
| **C2** | Verifier: category in the closed set; `afp:actsOn` resolves; action admissible under the pinned policy | **done** | `action.py` |
| **C3** | `afp:excludePerformersOf` at bid admission, audit-logged | **done** | `allocation/allocator.ts`, `allocation/store.ts` |
| **C4** | Verifier: excluded set rebuilt from prior Awards, pool filtered, declared performers checked | **done** | `allocation.py` |
| **C5** | Gate: clean flow passes; mutations fail each named check | **done** | `test/adr0006.test.ts` |

## References

- [Scenario 06 — the issue triage loop](../scenarios/06-issue-triage-loop.md), findings 20 and 23
- [03 — Bidding & allocation](../03-coordination.md#bidding--allocation) ·
  [04 — Synthesis](../04-operations.md#synthesis-answers-that-are-not-decisions)
- [ADR-0003](0003-p3-allocation-stack.md) Decisions 3 and 6 — the pinning and separation
  patterns reapplied
