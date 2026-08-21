# ADR-0011 — Supersession meets the irreversible world

- **Status:** Proposed
- **Date:** 2026-08-21
- **Applies to:** any deployment whose actions touch an external system that does not
  offer an undo — which is most external systems — and any record long-lived enough
  for its deciding quorum to change; acute wherever a statutory contestation right
  exists
- **Builds on:** [ADR-0007](0007-supersession.md) (the disposition duty this ADR gives
  an honest form for actions that cannot be undone), [ADR-0006](0006-checkable-actuation.md)
  (the pinned policy dispositions run under), [ADR-0010](0010-pinning-without-an-auction.md)
  (the pin point — proposed alongside; Decision 1 assumes it)
- **Driven by:** [scenario 09 / campaign 6](../scenarios/README.md#campaign-6--open),
  findings 38 and 39

## Context

ADR-0007 made revision an edge, never an erasure, and Decision 3 closed the actuation
loop: for every action justified by a superseded Synthesis, a disposition MUST exist —
"the actuation loop runs once more, under the same pinned `afp:actionPolicy`."
Scenario 09 found the two conditions that sentence quietly assumes.

**The world may refuse the disposition.** The screening sidecar's rights are two
transitions on applications *in the screening state*. Two years after actuation the
application is in a terminal workflow state the sidecar cannot touch; the caseworker
API will refuse, and no future grant of rights is coming. The spec has no notion of an
irrevocable action, no way to declare irreversibility when the policy is pinned, and
no disposition form for "cannot be undone, only annotated" — so the honest deployment
fails the existence check ADR-0007 imposed, for doing exactly what it said it could do.

**The quorum may have stopped being a successor.** Ratification parity ("a new
DecisionRecord by the current quorum") reads naturally in a standing consortium.
Re-ratifying a screening two years on, the "current quorum" may be four different
model/prompt-pack versions or a decommissioned panel — a re-vote by a materially
different panel is a *different screening*, not a correction, and nothing on the
record marks the difference.

And one cheap, sharp contradiction (finding 39): 03 closes an unanswerable thread
with *"a new ask with the closed thread as its recorded prehistory"* — a narrative
idiom with **no property**, unverifiable — while ADR-0007 Decision 1 requires a
superseding Synthesis to share `context` with what it retracts. An applicant
contestation is plausibly both a challenge to the verdict *and* new information; the
spec never says which fork governs, and choosing the new-thread fork silently makes
the retraction machinery inapplicable.

## Decisions

### 1. Irreversibility is declared where the policy is pinned

An action entry in `afp:actionPolicy` MAY carry **`afp:irrevocable: true`** —
declared at pin time, before any answer exists, like everything else about the
policy. Irreversibility is a property of the action *as designed*, not a discovery
made at disposition time: a deployment that knows its writes cannot be unwound says
so up front, on the signed record, where the auditor reading the actuation already
looks.

### 2. The `annotate` disposition — for consequences that can only be acknowledged

ADR-0007's disposition duty gains a second form. For an action whose policy entry is
irrevocable, the disposition activity carries **`afp:disposition: "annotate"`**
alongside `afp:disposes`: it binds the withdrawn justification to the standing
consequence, states that the consequence stands because it cannot be recalled, and
commands nothing external. The existence check is unchanged — every acted-on
superseded Synthesis still demands its disposition — but the honest answer "we cannot
undo this, and here is the record saying so" now passes it, where today only a
re-actuation can. A disposition of `annotate` against an action *not* declared
irrevocable is a named finding: the escape hatch is only where it was declared.

### 3. A superseding ratification names its panel delta

A `DecisionRecord` ratifying a superseding Synthesis MUST carry the original
decision's quorum snapshot hash alongside its own. Same-membership re-decision and
changed-panel re-decision become distinguishable on the record — the verifier checks
presence and resolvability of both snapshots, and *materially different panel* stops
being invisible. What follows from the difference is deliberately not decided here:
whether a changed panel's reversal carries less weight is governance, and governance
belongs to hub policy, not protocol. The protocol's job is that the difference shows.

### 4. `afp:priorThread`, and the fork ruled

A thread-opening task activity MAY carry **`afp:priorThread`** naming the closed
thread it continues — the property finding 39 found missing, making 03's "recorded
prehistory" a followable edge instead of a story. And the fork is ruled in one
sentence each way:

- **Revising the answer** — the claim is that the existing verdict was wrong on what
  it saw — happens on the original thread, per ADR-0007's same-`context` rule,
  ratification parity and dispositions included.
- **A new ask on new information** — the claim is that the world changed or the
  record was incomplete — opens a new thread carrying `afp:priorThread`; the old
  thread's terminal outcome stands unretracted.

A contestation is triaged into one of the two *on the record*: the choice of fork is
itself visible, because the activities it produces are distinguishable. A new-thread
ask that in substance re-answers the old question retracts nothing — exactly
ADR-0007's rule, now with the edge that lets a replay see the relationship instead of
inferring it.

## Options considered

| Option | Rejected because |
|---|---|
| Re-actuate always; let the external refusal be the record | The refusal lives in the external system's logs, not the record; ADR-0007's existence check fails and the deployment is marked dishonest for being honest |
| Discover irreversibility at disposition time (annotate allowed anywhere) | An escape hatch available everywhere is a duty available nowhere — declaring it at pin time keeps the auditor's question answerable before the fact |
| Forbid supersession of acted-on irrevocable actions | Erases the revision instead of the action — the record must show the justification was withdrawn even when the world keeps the consequence |
| Weight or invalidate changed-panel reversals in protocol | Governance decided in protocol; ADR-0002 put weights in hub policy and this is the same shape — the protocol makes the delta visible, the hub decides what it means |
| Overload `afp:supersedes` for the new-ask edge | The two claims are opposites — one retracts, one explicitly does not — and sharing a property would re-blur the line ADR-0007 drew |

## Consequences

**Positive**

- The contestation path — the premise of any statutory deployment — composes:
  challenge → same thread, parity, dispositions (annotate where the world refuses);
  new information → new thread, followable prehistory, old outcome standing.
- The disposition duty becomes satisfiable by every honest deployment, which is what
  an existence check is for.
- Panel drift across time is on the record, priced by governance rather than hidden.

**Negative / accepted risks**

- `annotate` is a weaker promise than re-actuation, deliberately available. The
  containment is Decision 1: only where irreversibility was declared before any
  answer existed.
- The fork ruling asks the contesting deployment to classify the contestation, and
  the classification can be self-serving (call every challenge "new information",
  never retract). Accepted with eyes open: the choice is visible on the record, and
  a pattern of new-ask-only responses to challenges is itself auditable evidence.
- Two snapshot hashes on superseding DecisionRecords is a small format change to a
  built artifact.

**Revisit triggers**

| Trigger | Reconsider |
|---|---|
| A deployment needs partial reversal (undo one of several consequences) | Whether dispositions need per-action granularity below the Synthesis level |
| Chains of supersession (ADR-0007's own trigger fires) | Whether `priorThread` and `supersedes` edges need a combined ancestry check |
| A regulator rejects `annotate` as insufficient remedy | Whether the protocol needs a compensating-action form distinct from annotation |

## Build status

Nothing is built.

| ID | Task | Stage |
|---|---|---|
| **Y1** | `afp:irrevocable` in policy entries; validation at pin time | 1 |
| **Y2** | `annotate` disposition: emission path + verifier check (allowed only where declared) | 1 |
| **Y3** | Dual snapshot hashes on superseding DecisionRecords; verifier resolvability check | 2 |
| **Y4** | `afp:priorThread`: property, emission on new-ask flows, verifier edge resolution | 2 |
| **Y5** | Gate: a supersession against an irrevocable action passes with `annotate` and fails without a disposition; an undeclared-irrevocable `annotate` fails by name; a new-ask thread resolves its prehistory; a same-thread revision without parity fails per ADR-0007 | 3 |

## References

- [Scenario 09 — the screening sidecar](../scenarios/09-the-screening-sidecar.md),
  findings 38, 39
- [ADR-0007](0007-supersession.md) — the disposition duty and same-`context` rule
  this ADR completes for the irreversible case
- [ADR-0010](0010-pinning-without-an-auction.md) — the pin point Decision 1 writes
  into
