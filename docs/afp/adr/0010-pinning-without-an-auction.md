# ADR-0010 — Pinning without an auction: checkability in the direct flow

- **Status:** Accepted, and **built** — gated by a direct fan-out replayed clean and
  broken one named check at a time, and by the root-parity case that holds the two
  resolution roots to one meaning
- **Date:** 2026-08-21
- **Applies to:** every deployment using direct delegation — which the spec itself
  prescribes whenever the target is known, and which the solo profile uses almost
  exclusively; load-bearing from P1
- **Builds on:** [ADR-0003](0003-p3-allocation-stack.md) (the Award-derived synthesizer
  this generalizes), [ADR-0006](0006-checkable-actuation.md) (the action policy whose
  pin point this moves), [ADR-0007](0007-supersession.md) (dispositions run "under the
  same pinned policy" — so the pin must exist to run under)
- **Driven by:** [scenario 09 / campaign 6](../scenarios/README.md#campaign-6--v318v320-adr-0010-adr-0011-adr-0012),
  findings 34, 35, 37 — the campaign's through-line

## Context

Campaigns 2–5 added the machinery that makes an answer *checkable*: a pinned
`afp:actionPolicy` (ADR-0006), a pinned `afp:answerSufficiency`, a synthesizer "named
in the Award" (ADR-0003), and a replay procedure that resolves the governing policy by
walking `Synthesis → afp:award → Award → afp:task → Announce`. Every anchor in that
list is the Announce/Award pair.

But the spec's own routing rule — stated twice in 03 — is *"when the target is known,
skip all of this and use the direct `Offer` flow."* Scenario 09 followed that rule with
a fixed four-agent screening panel and watched three checks disarm at once: the policy
had no carrier, sufficiency had no home, and the synthesizer was appointed by
configuration — the exact claim-without-a-record the roster machinery exists to
prevent. 06 promises the solo profile is "a degenerate case, never a fork"; for
checkable actuation, the promise is not kept.

Two adjacent cracks ride the same root. **Finding 35:** `afp:actsOn` must resolve to a
Synthesis — written before ADR-0003 made ratification first-class — so a deployment
that ratifies must bind its action to the *unratified* artifact. **Finding 37:**
ADR-0006's category set is closed over the policy's keys, and no key means "no
verdict"; a partial panel (three Results, one Error) reaches per-task terminality on
every leg while the external state machine waits forever. An unscreened citizen
application parked indefinitely is an availability failure that reads as a rights
failure.

## Decisions

### 1. Pins live on the task-bearing activity — the Announce when there is one, the direct `Offer{Task}` when there is not

`afp:actionPolicy`, `afp:answerSufficiency`, and (new, Decision 2) `afp:synthesizer`
MAY be carried by **any task-bearing activity**: an `Announce{Task}` or a direct
`Offer{afp:Task}`. They are carried **on the `afp:Task` object**, exactly where the
announce carries them today — the existing announce shape is unchanged to the byte, and
the direct `Offer` gains the same three optional properties on the object it already
publishes. The pin discipline is unchanged from ADR-0006: published before any answer
exists, in the same signed record.

Four rules make the fallback as tight as the chain it stands in for.

**The pin set is one object, and equality is over the whole of it.** A thread may carry
several task-bearing activities (scenario 09's four fan-out Offers). Define a task
activity's **pin set** as the object `{afp:actionPolicy, afp:answerSufficiency,
afp:synthesizer}` restricted to the keys actually present, and its **pin digest** as
`sha256(JCS(pin set))` — the digest the record already computes everywhere else. All
task-bearing activities on one thread MUST carry an equal pin digest. Partial agreement
is not agreement: an Offer pinning two of the three diverges from an Offer pinning
three, and the empty pin set is a value like any other — **an unpinned Offer added to a
pinned thread is divergence, not abstention.** Without that last clause the policy is
escapable by publishing one more Offer, which is the whole check undone by an omission.

**The thread is `context`.** The verifier groups task-bearing activities by their
envelope `context` — the same key `check_thread` already uses — and resolves the
thread's governing pins as the agreed set. Two activities on one thread pinning
different policies is a named finding, not a tie to break; the verifier resolves no
governing pins for that thread and says why, rather than picking a winner. The grouping
runs over the **thread pool** — the export's own activities *and* its received foreign
bytes, the pool `check_thread` already uses — because a delegated thread's opening
`Offer` is authored by the counterparty and would otherwise be invisible to the very
deployment it binds.

**Pins precede answers, checkably — by `published`, and only at the thread's opening.**
Where a thread's pin set is non-empty, the **earliest** task-bearing activity on it MUST
be published before the thread's earliest `Create{afp:Result}` or `Create{afp:Error}`.
The check deliberately binds the thread's opening act and nothing after it: threads run
sequentially all the time — offer, answer, follow-up offer, answer — and a rule that
forbade a task activity after the first answer would outlaw ordinary sequential
delegation, which the reference implementation's own P1 flow has done since the
beginning. Later task activities need no ordering rule because pin-equality already
governs them: carrying the identical set, they introduce no constraint that was not
fixed when the thread opened. What remains to catch is the real abuse — a thread pinned
*wholly* after its answers were visible — and the opening act catches it exactly. There
is no stronger comparator available than `published`, and the
ADR should not pretend otherwise: chains are per-actor, so a thread whose Offers come
from the port and whose answers come from four screeners has no global order at all —
only instants from separate clocks, compared the way `instant_millis` compares them
everywhere else. Cross-actor skew therefore bounds this check's precision, and that is
acceptable because the act it prevents — pinning a policy once the answers are visible
— is a same-operator act, where the clocks are the same clock. A federated variant
would need the boundary log, and does not exist yet.

**Sub-delegation inherits the pin set.** An agent that receives a pinned task and
sub-delegates part of it on the same thread MUST copy the thread's pin set
byte-identically onto its own `Offer`. This falls out of pin-equality rather than
excepting it: the sub-task's Result feeds the same answer, so it is governed by the same
policy, and the alternative readings are both worse — exempting non-opener actors
restores the escape hatch the previous rule just closed, and forcing a child thread
would fragment one answer across two threads before ADR-0011 has settled what a
thread-to-thread edge means.

**Replay resolution gains a fallback, it does not change shape.** The existing chain
(`Synthesis → afp:award → Award → afp:task → Announce`, `_governing_policy` in
`action.py`) runs first; when the Synthesis carries no `afp:award`, the governing pins
are resolved from the Synthesis activity's own `context` — the thread's pin-bearing task
activities. One lookup, two roots, same checks. `afp:award` therefore becomes optional
on `afp:Synthesis` (it is required in the builder today), and a Synthesis with neither a
resolvable Award nor a pinned thread resolves no policy and constrains nothing — ADR-0006's
opt-in reading, preserved verbatim.

Authority to pin is authority to open the thread: in the auction flow the hub authors
the Announce and the existing hub-authorship check stands; in the direct flow the
delegating agent authors the Offer. No new authority rule is needed, because pin-equality
already denies any single actor a private policy — a divergent pin fails the thread
rather than governing part of it.

### 2. The synthesizer is named on the record in both flows — and the Award wins where both exist

A pinned `afp:synthesizer` on the governing task object names **one actor** — a single
agent id, not a list — whose `Create{afp:Synthesis}` is admissible for the thread. The
check is the obvious one: for every Synthesis on a thread with a pinned synthesizer, the
activity's `actor` (and the object's `attributedTo`) MUST equal the pinned id. A
Synthesis emitted by any other actor fails replay by name — the check ADR-0003 gave
auctions, now available to the flow the spec recommends first.

One id, not a set, because a thread has one answer: a deployment wanting two candidate
syntheses wants two threads, and a set-valued pin would quietly re-admit the
"whoever got there first" ambiguity the pin exists to close.

Where an Award exists, the Award's deterministically-derived synthesizer governs
(ADR-0003 is untouched — it is the *derived* form of the same pin); a pinned
`afp:synthesizer` on an Announce that also produces an Award is a named finding if the
two disagree, and the Award's value is what the admissibility check uses.

**Absent is not unequal.** Only the coverage rule derives a synthesizer; the ranking
rule derives none, and returns nothing rather than a competing name. So precedence reads:
where both a pin and a derived value are *present* and differ, that is the disagreement
finding and the derived value governs; where the rule derived none, the pin governs
alone and nothing is in conflict. An Announce pinning a synthesizer under a ranking rule
is the ordinary case of a deployment naming what its rule does not — which is the whole
reason the pin exists.

### 3. `afp:actsOn` MAY name a DecisionRecord — the verifier follows one hop

Where ratification occurred, the action's `afp:actsOn` SHOULD name the
`Create{afp:DecisionRecord}` activity whose `afp:outcome` names the Synthesis; the
verifier resolves the one hop and applies every existing check (category admissible
under the pinned policy, digest resolution) against the Synthesis it lands on. Binding
to the ratified artifact is the point of ratifying; the unratified binding remains valid
for flows that do not ratify. Two hops never resolve — a DecisionRecord whose
`afp:outcome` names another DecisionRecord is a named failure. This is an edge, not a
path.

Two seams an implementer meets immediately, decided here:

- **The hop crosses a digest/id boundary.** `afp:actsOn` is a *digest of an activity*;
  `afp:outcome` names a Synthesis *by id* (`decision.py` matches it that way today). The
  resolution is therefore: digest → DecisionRecord activity → `afp:outcome` id → the
  `Create{afp:Synthesis}` activity carrying that object id, which MUST be present. An
  outcome naming an absent Synthesis is the same "justification you cannot produce"
  failure ADR-0006 already names, one hop out. Today `afp:outcome` is validated
  *nowhere* — it is read only by the ratification test in `action.py`, where an outcome
  pointing at nothing simply reads as "not ratified." The hop makes it load-bearing, so
  it acquires its own named check in `decision.py`: a DecisionRecord's outcome resolves
  to a present Synthesis.

  **That check fires only in the hop role**, and the distinction is not pedantry. A
  DecisionRecord is also how ADR-0002 records a plain governance vote, whose
  `afp:outcome` is the chosen option itself — a string like `"signed-commits"`, naming
  no artifact and pointing at nothing. Requiring every outcome to resolve to a Synthesis
  would fail every governance round ever recorded, for the offence of not being a
  ratification. So the obligation attaches where the hop does: a DecisionRecord whose
  digest is named by some activity's `afp:actsOn` is being used as an action's
  justification, and *that* record must produce the Synthesis it claims. Before the hop
  existed, `afp:outcome` genuinely constrained nothing; the hop is what gives it
  something to answer for, and it answers only for the role it is being used in.
- **Supersession follows the hop too.** ADR-0007's orphan scan currently matches
  `afp:actsOn == <digest of the superseded Synthesis activity>` literally. With the hop
  admitted, an action bound through a DecisionRecord to a superseded Synthesis is
  orphaned in exactly the same way and MUST be found by the same check — so the scan
  resolves `actsOn` through zero-or-one hop before comparing. A disposition MAY bind
  either form; what it must do is act on the superseding answer, unchanged.

The hop imports no quorum semantics: whether the round was valid is
`check_decision_record`'s business and stays there. The action check asks only *which
answer this action claims*, and now gets a truthful answer from a deployment that
ratifies.

### 4. Every action policy carries a non-answer key — terminality always releases the actuator

An `afp:actionPolicy` MUST include the reserved category **`afp:no-verdict`**, mapping
to a declared, non-empty action like any other key. A policy that cannot state its
no-verdict action is not yet a policy. This is checked twice, in the two places every
other pin is: the writer refuses to build a policy without it, and replay names a pinned
policy that lacks it.

A thread reaches the non-answer terminal in two recorded ways:

- the pinned `afp:answerSufficiency` is met by fewer than all legs, and the Synthesis
  says so; or
- sufficiency cannot be met, and the synthesizer closes the thread with a Synthesis of
  category `afp:no-verdict` binding whatever partial Results exist.

Either way the category resolves to an admissible action, the actuation loop runs
unchanged, and the external state machine is **always released** — "the panel could not
screen" is a verdict with a consequence, never a parked application.

Two supporting specifics, both required for the check to be recomputable:

**A partial Synthesis names what is missing.** A Synthesis MAY cover a partial input
set, and when it does it MUST carry `afp:absentInputs` — one entry per leg of the thread
that contributed no Result:

```json
"afp:absentInputs": [
  { "afp:correlationId": "…schedule", "afp:errorCode": "afp:err:brain-failed",
    "afp:digest": "sha256:…" }
]
```

`afp:digest` names the leg's terminal `Create{afp:Error}` activity where one exists and
is `null` where the leg simply never terminated (a lapsed deadline with no recorded
close), in which case `afp:errorCode` states the deployment's reason. The verifier checks
the partition: every leg of the thread appears either in `afp:contributingResults` (by
the Result it produced) or in `afp:absentInputs`. Missing legs are *declared*, never
silently dropped — ADR-0009's "discretion is declared, deletion is detected" applied to
inputs instead of disclosure.

**A leg is one distinct `afp:correlationId` among the thread's task-bearing
activities, and the partition check governs the fallback root only.** The scoping is
forced by what a leg *is* in each flow. In the direct flow a leg is an Offer, and its
Result carries that Offer's `afp:correlationId` back — the partition is exact. Under an
Award, one Announce fans out to several performers who derive per-performer correlation
ids beneath the task's own (`q-88` becomes `q-88--b-licensing`), so counting task
activities counts *one* leg where the answer has several: legs there are performers, not
task activities, and that shape already has its checks — the Award-scoped performer
count and coverage in `allocation.py`, untouched by this ADR. Applying the partition to
both roots would not tighten the Award flow, it would simply mis-describe it. Three cases the
definition has to answer, answered here: a `Reject`ed Offer is a leg, and an absent one
(the rejection is its terminal, named in `afp:errorCode`) — a panel seat that declined
is exactly the kind of hole this field exists to show; a retried task collapses to the
single cached Result the dedupe rule already makes single-valued, so one leg, one entry;
and a leg revised during reconciliation is present, with `afp:supersededInputs` carrying
the revision as it does today.

**Sufficiency gets its second reading, stated — and it is `count`-only.** Today
`afp:answerSufficiency` is checked at award time against the *performers* the selection
rule picked (`allocation.py`). The direct flow has no Award and no selection, so the
same pin reads over answers: `count` is the number of Results the Synthesis binds in
`afp:contributingResults`, and for a thread with a pinned sufficiency and a Synthesis,
replay checks `met(count) OR afp:category == "afp:no-verdict"`. The two readings do not
compete — one governs a selection, the other an answer — but the spec must say both, or
an implementer will pick one and silently ship the other's gap.

The `coverage` form does **not** carry over, and a `coverage` key pinned on a direct
`Offer` is a named finding rather than a silently-skipped check. Coverage is scored
against each *bid's* `afp:coverage` map at a `minConfidence` read from the selection
rule's own params — in a flow with neither bids nor a rule, both the claim and the
threshold have no source, and a check with no inputs that quietly passes is the exact
failure mode this ADR was written to end. Making coverage work here means moving the
claim onto the `Result` and pinning the threshold beside the sufficiency; that is a
real design with a real cost, and it belongs to the scenario that needs it (revisit
trigger below), not to this one.

## Open questions this ADR does not close

Two questions surfaced in review that this ADR is the wrong place to answer — each is
co-owned with another ADR, and deciding it here would decide it twice. Named rather than
left implicit, because both are load-bearing for the deployment that drove the campaign.

**A pin can be redacted out from under the answers it governs.** Under ADR-0009 a scoped
export replaces withheld activities with digest-only stubs. A pin-bearing `Offer`
published at a lower visibility than the Synthesis it governs therefore yields, in a
lawful audit export, a thread with **no resolvable governing pins** — and every check
this ADR adds silently no-ops, in precisely scenario 09's audit deliverable. The
candidate rule is one line — *a pin-bearing task activity MUST be at least as visible as
the answers it governs*, enforced at export — but it is a constraint on ADR-0009's
export-time transform, not on this ADR's pin, and it wants deciding alongside the
content-inventory question ADR-0012 already has open. Until it is decided, X6 should
carry a case that fails loudly rather than passing vacuously, so the hole is visible in
the gate rather than in an audit.

**A pinned synthesizer and a changed panel.** Decision 2 pins one synthesizer for the
thread; ADR-0007 puts a superseding Synthesis on that same `context`, and ADR-0011's
panel-delta work contemplates the ratifying membership having materially changed in the
meantime. Read strictly, a legitimate panel change makes every superseding Synthesis
inadmissible under the original pin. The plausible resolutions — the pin binds only the
original answer, or a superseding answer may re-pin as part of the supersession record —
are both really answers about *what a supersession may change*, which is ADR-0011's
subject. Decided there, cross-referenced here.

## Options considered

| Option | Rejected because |
|---|---|
| Keep pins Announce-only; require a degenerate one-bidder auction for direct flows | Ceremony the spec explicitly tells deployments to skip; an auction with one admissible bidder records no decision, only overhead |
| Pin in configuration / deployment manifest | The claim-without-a-record scenario 09's beat 1 refused for membership; config drifts and leaves no signed trail |
| A dedicated thread-opening pin activity (new type) | A new activity type where an existing one already opens every thread; the task-bearing activity *is* the thread's opening act in both flows |
| Implicit default policy when none is pinned | "An Announce that pins no policy constrains no actions" stays true — but silently defaulting would convert unconstrained flows into differently-unconstrained ones; absence must stay visible |
| Treat an unpinned Offer on a pinned thread as abstention | Makes the whole check escapable by publishing one more Offer — the policy would bind only the publisher who chose to be bound |
| First pin on the thread wins; later divergent pins are ignored | A precedence rule is a tie-break, and a thread with two policies has no tie to break — it has two stories, which is what the finding should say |
| Sub-delegation opens a child thread instead of inheriting the pin set | Fragments one answer across two threads before ADR-0011 has settled what a thread-to-thread edge means; the sub-task's Result feeds the same answer, so the same policy should govern it |
| Carry `coverage`-shaped sufficiency into the direct flow on a best-effort reading | Neither the claim (`afp:coverage` lives on a bid) nor the threshold (`minConfidence` lives in the selection rule's params) exists there; a check with no inputs that quietly passes is the failure mode this whole ADR exists to end |
| `afp:synthesizer` as a list of admissible actors | Re-admits "whoever synthesized first" as an unrecorded choice; a thread has one answer, and two candidate answers are two threads |
| `actsOn` re-targeted to DecisionRecord only | Breaks every unratified flow ADR-0006 already governs; the one-hop MAY is additive |
| A free-form "unanswerable" outcome outside the policy | Reopens the closed category set ADR-0006 fought for; the non-answer belongs *inside* the pinned key space, with a declared action like any other |
| `afp:no-verdict` required only when a thread actually goes partial | The requirement's value is that the failure path is decided *before* the failure; a MUST that activates on the bad day is a MUST nobody has satisfied on the bad day |
| Forbid `afp:no-verdict` when sufficiency *was* met | A synthesizer may honestly fail to answer over sufficient inputs (four Results that contradict irreconcilably); the record should carry that, and `afp:absentInputs` plus the method text already say which case it is |

## Compatibility and migration

- **`afp:award` becomes optional** on `afp:Synthesis` (builder and verifier). Every
  existing record carries it; nothing re-reads differently.
- **The `afp:no-verdict` MUST is retroactive by construction** — it is a property of a
  pinned policy, so exports carrying pre-ADR policies fail the new named check. Accepted
  deliberately rather than version-gated: nothing is deployed outside this repository,
  the fixtures and gate tests that pin policies are updated with the build (X5), and a
  version-gated MUST would leave the parked-application hole open in exactly the records
  that predate the discovery of it.
- **`check_supersession`'s orphan scan changes shape** (Decision 3) — actions bound
  through a DecisionRecord were invisible to it before and are found now. No existing
  record contains such an action, so the change is additive in effect and load-bearing in
  intent.
- **Two prose statements go stale on the day X2 lands** and are part of it, not of the
  sweep: `action.py`'s module docstring ("found through the record's own chain … never
  through a side channel" — the second root is not a side channel and must be named as
  the first root's equal), and ADR-0006's Decision 1 bullet describing the chain.
- **Spec sweep** once built: 03's task table gains the three pin properties on the direct
  `Offer` and the `afp:absentInputs` row; 04's synthesis section states the synthesizer
  pin, the two readings of sufficiency, and the `afp:no-verdict` reserved category;
  ADR-0006's Decision 1 gains a pointer to the second root.

## Consequences

**Positive**

- The degenerate flow keeps its checks: policy, sufficiency, and synthesizer are
  pinned, resolvable, and replayed in the flow shape most deployments actually use.
  06's "degenerate case, never a fork" becomes true for actuation.
- Scenario 09's headline claim — *the transition was the one the verdict permitted,
  recomputably* — acquires its mechanism.
- The parked-application failure mode is closed by construction: terminality implies
  an admissible action.

**Negative / accepted risks**

- Pin-equality across fan-out Offers is a new obligation on publishers; a sloppy
  multi-Offer thread now fails replay where it previously passed vacuously. Accepted:
  it passed by checking nothing.
- `afp:no-verdict` forces every policy author to decide the failure path up front.
  That is a feature wearing a cost's clothing.
- The Award-wins rule adds one precedence rule to learn. Kept to one line by making
  the Award the derived form of the same pin, not a competitor.
- Direct-flow sufficiency is `count`-only, which is a genuine reduction: a deployment
  whose panel is defined by *which domains were covered* rather than *how many answered*
  cannot express that here, and must run an auction to get it. Accepted as the honest
  smaller thing, with the design that would fix it named in the revisit triggers rather
  than half-built.
- `afp:absentInputs` gives the synthesizer a place to declare a leg absent that a lazy
  implementation could use to declare an *inconvenient* leg absent. The record catches
  the crude form — a leg with a present Result cannot be listed absent — and the subtle
  form (declaring a leg absent whose Result arrives later) is the same
  answered-too-early question the deadline machinery already owns.

**Revisit triggers**

| Trigger | Reconsider |
|---|---|
| P5 cross-operator direct delegation | Whether the counterparty must countersign pins that bind *its* actuator |
| A policy wants per-leg (per-capability) actions, not per-thread | Whether pins compose per-correlation rather than per-thread |
| Chained syntheses (a Synthesis over Syntheses) | Whether the one-hop `actsOn` rule needs a bounded path instead of an edge |
| A deployment wants a pin changed mid-thread for a legitimate reason | Whether pin *revision* needs the supersession treatment (an edge, never an overwrite) rather than the divergence finding it gets today |
| A direct-flow deployment needs coverage-shaped sufficiency, not a count | Whether `afp:coverage` moves onto the `Result` and `minConfidence` is pinned beside the sufficiency — the design Decision 4 declines to build unbidden |
| Cross-actor clock skew produces a false pins-precede-answers failure | Whether that ordering check needs the boundary log rather than `published` |

## Build status

Built. Staging followed the dependency: the carrier first (nothing else has a home
without it), then the two independent extensions, then the release path that needs both.
Three of this ADR's rulings were corrected by the build — the sequential-thread ordering
rule, the unconditional outcome check, and the leg partition's scope — each caught by a
clean export failing rather than by review, and each folded back into the decisions
above.

| ID | Task | Where | Stage |
|---|---|---|---|
| **X1** ✅ | `TaskSpec` (`ap/activities.ts:45`) gains `actionPolicy` / `answerSufficiency` / `synthesizer`; `offerTask` (`:56`) writes them onto the `afp:Task` object; `AfpInstance.delegate` (`instance.ts:367`) passes them through, building the pin set once and reusing it across a fan-out — the direct-flow counterpart of the allocator's "one auction per thread" invariant (`allocator.ts:135`). The pin set needs a home on the writer side: neither the auction row (`allocation/store.ts` persists sufficiency, not the policy) nor `store/tasks.ts` holds one today | `ap/activities.ts`, `instance.ts`, `store/tasks.ts` | 1 |
| **X2** ✅ | Verifier: pin resolution by `context` over the thread pool — pin digest per task activity, equality across the thread, divergence finding, pins-precede-answers ordering; `_governing_policy` (`action.py:43`) generalized to `_governing_pins(activity, all_activities)` returning the whole governing task object (it takes the Synthesis *payload* today, and `context` lives on the outer activity), with `allocation.py`'s sufficiency read rebased on it; `afp:award` made optional in `SynthesisSpec` (`allocation/activities.ts:225`) and in the award-rooted Synthesis lookup (`allocation.py:590`, `demoP3.ts`) | `action.py`, `afp_verify.py`, `allocation/activities.ts` | 1 |
| **X3** ✅ | `afp:synthesizer` on `AnnounceSpec`/`announceTask` and on the pinned `Offer`; admissibility check (`actor`/`attributedTo` equals the pin); Award-precedence rule and the disagreement finding beside the recomputed-synthesizer check (`allocation.py:535`); the pin added to the requester re-fan-out passthrough (`allocator.ts:220`) or it is silently dropped | `allocation/activities.ts`, `allocator.ts`, `action.py`, `allocation.py` | 2 |
| **X4** ✅ | `actsOn` zero-or-one-hop resolution through a `Create{afp:DecisionRecord}` (digest → outcome id → Synthesis) at `action.py:115`, reusing the id-lookup already in `ratified()`; two-hop failure; `afp:outcome`-resolves finding in `check_decision_record`; `check_supersession`'s orphan scan resolved through the same hop | `action.py`, `decision.py` | 2 |
| **X5** ✅ | `afp:no-verdict`: a `validateActionPolicy` beside `admissibleAction` (`allocation/actions.ts:25`), called from both pin paths, and a verifier check naming a pinned policy that lacks it; `afp:absentInputs` on `SynthesisSpec` + the leg-partition check; sufficiency's answer-side `count` reading with the `afp:no-verdict` escape, kept distinct from the Award-scoped count check (`allocation.py:562`) and `meetsSufficiency` (`allocator.ts:389`), plus the named finding for a `coverage` key pinned on a direct `Offer`; the leg partition per Decision 4's definition (distinct `afp:correlationId`, `Reject` counted absent, dedupe collapsed). Fixture sweep for the retroactive MUST — `adr0006.test.ts`'s `POLICY`, `adr0007.test.ts`, `hub.test.ts`, and the P3 demo paths all pin policies and go red on the day this lands | `allocation/actions.ts`, `allocation/activities.ts`, `action.py` | 3 |
| **X6** ✅ | Gate: a P1-shaped direct fan-out (four Offers, one thread, pinned policy/sufficiency/synthesizer) replayed clean; then the mutations — divergent pins across Offers, an unpinned fifth Offer, a pin published after the first Result, a Synthesis from an unnamed actor, an action on an unadmitted category, an `actsOn` through a DecisionRecord (passes) and through two (fails), a partial panel closing `afp:no-verdict` with `afp:absentInputs` (passes) and without (fails), a sub-delegating Offer inheriting the pin set (passes) and omitting it (fails), and — for the redaction open question — a scoped export whose pin-bearing Offer is stubbed, asserted to *fail* rather than pass vacuously | `test/adr0010.test.ts` | 3 |
| **X7** ✅ | Parity: the same thread run through the auction flow — Award-derived synthesizer and Announce-pinned policy — must produce identical action-check verdicts, so the fallback is a second root and not a second meaning | `test/parity.test.ts` | 3 |

Named checks follow the existing `report.record(name, ok, detail)` convention, prefixed
by their subject: `pins: <thread> …` for Decision 1, `action: <label> …` for Decisions
3–4 (extending ADR-0006's family), `synthesis: <label> …` for Decisions 2 and 4's
partition; details close with `(ADR-0010)` like every check before them. The assertion
phrase is the public API — the gate tests match `FAIL ] <domain>: .*<phrase>` — so
phrases are chosen once and not reworded afterwards. `X6` follows `adr0006.test.ts`'s
shape: one `describe`/`it`, the raw-body `publish` escape hatch for shapes the builders
do not yet emit, `exportBundle` + `runVerifier` for the clean pass, then the
copy-the-bundle-and-edit-one-outbox `mutate` harness, asserting each mutation's own
named FAIL line rather than a failure count.

## References

- [Scenario 09 — the screening sidecar](../scenarios/09-the-screening-sidecar.md),
  findings 34, 35, 37
- [ADR-0006](0006-checkable-actuation.md) — the policy machinery this ADR gives a
  second root
- [ADR-0003](0003-p3-allocation-stack.md) — the Award-derived synthesizer, untouched,
  now the derived form of a general pin
- [ADR-0011](0011-supersession-meets-the-irreversible-world.md) — proposed alongside;
  its Decision 1 pins irreversibility at the pin point this ADR establishes
