# ADR-0010 — Pinning without an auction: checkability in the direct flow

- **Status:** Proposed
- **Date:** 2026-08-21
- **Applies to:** every deployment using direct delegation — which the spec itself
  prescribes whenever the target is known, and which the solo profile uses almost
  exclusively; load-bearing from P1
- **Builds on:** [ADR-0003](0003-p3-allocation-stack.md) (the Award-derived synthesizer
  this generalizes), [ADR-0006](0006-checkable-actuation.md) (the action policy whose
  pin point this moves), [ADR-0007](0007-supersession.md) (dispositions run "under the
  same pinned policy" — so the pin must exist to run under)
- **Driven by:** [scenario 09 / campaign 6](../scenarios/README.md#campaign-6--open),
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
`Offer{afp:Task}`. The pin discipline is unchanged from ADR-0006 — published before
any answer exists, in the same signed record.

A thread may carry several task-bearing activities (scenario 09's four fan-out
Offers). The rule that keeps one thread one story: **all pin-bearing activities on a
thread MUST carry byte-identical pins** (JCS-digest-equal). The verifier resolves the
thread's governing pins as that agreed set; two activities on one thread pinning
different policies is a named finding, not a tie to break.

Replay resolution gains a fallback, it does not change shape: the existing chain
(`Synthesis → afp:award → Award → afp:task → Announce`) runs first; when the Synthesis
carries no `afp:award`, the governing pins are resolved from the Synthesis's `context`
— the thread's pin-bearing task activities. One lookup, two roots, same checks.

### 2. The synthesizer is named on the record in both flows — and the Award wins where both exist

A pinned `afp:synthesizer` on the governing activity names the actor whose
`Create{afp:Synthesis}` is admissible for the thread. Where an Award exists, the
Award's deterministically-derived synthesizer governs (ADR-0003 is untouched — it is
the *derived* form of the same pin); a pinned `afp:synthesizer` on an Announce that
also produces an Award is a finding if they disagree. A Synthesis emitted by any other
actor fails replay by name — the check ADR-0003 gave auctions, now available to the
flow the spec recommends first.

### 3. `afp:actsOn` MAY name a DecisionRecord — the verifier follows one hop

Where ratification occurred, the action's `afp:actsOn` SHOULD name the
`DecisionRecord` whose `afp:outcome` names the Synthesis; the verifier resolves the
one hop and applies every existing check (category admissible under the pinned policy,
digest resolution) against the Synthesis it lands on. Binding to the ratified artifact
is the point of ratifying; the unratified binding remains valid for flows that do not
ratify. Two hops or more never resolve — this is an edge, not a path.

### 4. Every action policy carries a non-answer key — terminality always releases the actuator

An `afp:actionPolicy` MUST include the reserved category **`afp:no-verdict`**, mapping
to a declared action like any other key. A thread reaches the non-answer terminal in
two recorded ways:

- the pinned `afp:answerSufficiency` is met by fewer than all legs, and the Synthesis
  says so (a Synthesis MAY cover a partial input set; the missing legs' terminal
  `Error`s are listed in `afp:dissent`-adjacent form as absent inputs, not silently
  dropped), or
- sufficiency cannot be met, and the synthesizer closes the thread with a Synthesis of
  category `afp:no-verdict` binding whatever partial Results exist.

Either way the category resolves to an admissible action, the actuation loop runs, and
the external state machine is **always released** — "the panel could not screen" is a
verdict with a consequence, never a parked application. A policy that cannot state its
no-verdict action is not yet a policy.

## Options considered

| Option | Rejected because |
|---|---|
| Keep pins Announce-only; require a degenerate one-bidder auction for direct flows | Ceremony the spec explicitly tells deployments to skip; an auction with one admissible bidder records no decision, only overhead |
| Pin in configuration / deployment manifest | The claim-without-a-record scenario 09's beat 1 refused for membership; config drifts and leaves no signed trail |
| A dedicated thread-opening pin activity (new type) | A new activity type where an existing one already opens every thread; the task-bearing activity *is* the thread's opening act in both flows |
| Implicit default policy when none is pinned | "An Announce that pins no policy constrains no actions" stays true — but silently defaulting would convert unconstrained flows into differently-unconstrained ones; absence must stay visible |
| `actsOn` re-targeted to DecisionRecord only | Breaks every unratified flow ADR-0006 already governs; the one-hop MAY is additive |
| A free-form "unanswerable" outcome outside the policy | Reopens the closed category set ADR-0006 fought for; the non-answer belongs *inside* the pinned key space, with a declared action like any other |

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

**Revisit triggers**

| Trigger | Reconsider |
|---|---|
| P5 cross-operator direct delegation | Whether the counterparty must countersign pins that bind *its* actuator |
| A policy wants per-leg (per-capability) actions, not per-thread | Whether pins compose per-correlation rather than per-thread |
| Chained syntheses (a Synthesis over Syntheses) | Whether the one-hop `actsOn` rule needs a bounded path instead of an edge |

## Build status

Nothing is built.

| ID | Task | Stage |
|---|---|---|
| **X1** | Pins accepted on direct `Offer{Task}`; thread-level pin-equality check in the instance | 1 |
| **X2** | Verifier: governing-pin fallback via `context`; pin-divergence finding | 1 |
| **X3** | `afp:synthesizer` pin + admissibility check (instance and verifier); Award-precedence rule | 2 |
| **X4** | `actsOn` one-hop resolution through a DecisionRecord (verifier) | 2 |
| **X5** | `afp:no-verdict` reserved category: policy validation, partial-set Synthesis, release actuation | 3 |
| **X6** | Gate: a P1-shaped direct-fan-out flow with pinned policy/sufficiency/synthesizer, replayed clean; mutations — divergent pins across Offers, Synthesis from an unnamed actor, action on an unadmitted category, a partial panel closing `afp:no-verdict` | 3 |

## References

- [Scenario 09 — the screening sidecar](../scenarios/09-the-screening-sidecar.md),
  findings 34, 35, 37
- [ADR-0006](0006-checkable-actuation.md) — the policy machinery this ADR gives a
  second root
- [ADR-0003](0003-p3-allocation-stack.md) — the Award-derived synthesizer, untouched,
  now the derived form of a general pin
