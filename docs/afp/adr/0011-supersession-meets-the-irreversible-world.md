# ADR-0011 — Supersession meets the irreversible world

- **Status:** Accepted, and **built** — gated by an irrevocable consequence disposed of
  by annotation, a superseding ratification that names the electorate it overturns, and a
  new ask that resolves the closed thread it continues
- **Date:** 2026-08-21
- **Applies to:** any deployment whose actions touch an external system that does not
  offer an undo — which is most external systems — and any record long-lived enough
  for its deciding quorum to change; acute wherever a statutory contestation right
  exists
- **Builds on:** [ADR-0007](0007-supersession.md) (the disposition duty this ADR gives
  an honest form for actions that cannot be undone), [ADR-0006](0006-checkable-actuation.md)
  (the pinned policy dispositions run under), [ADR-0010](0010-pinning-without-an-auction.md)
  (the pin point Decision 1 writes into — **built**, so this ADR extends a live mechanism
  rather than assuming a proposed one; Decision 3 also settles the synthesizer question
  ADR-0010 deferred here)
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

### 1. Irreversibility is declared where the policy is pinned — as a sibling pin, not inside the map

A task-bearing activity that pins an `afp:actionPolicy` MAY also pin
**`afp:irrevocableActions`**: a list of action names, drawn from the policy's own
values, whose external effect cannot be recalled.

```json
"afp:actionPolicy": { "afp:screen-ok": "advance", "afp:no-verdict": "hold" },
"afp:irrevocableActions": ["advance"]
```

Declared at pin time, before any answer exists, like everything else about the policy.
Irreversibility is a property of the action *as designed*, not a discovery made at
disposition time: a deployment that knows its writes cannot be unwound says so up front,
on the signed record, where the auditor reading the actuation already looks.

**Why a sibling list rather than a flag inside the entry.** The obvious shape —
`"advance": { "action": "advance", "afp:irrevocable": true }` — would turn the policy's
values from strings into objects, and that map is load-bearing prose in two prior
decisions. ADR-0006 chose "a literal map, not a registry of functions" precisely so a
policy *cannot hide logic*: category in, action name out, recomputable by definition.
ADR-0010 hardened the same map with `validateActionPolicy` and the `afp:no-verdict` MUST,
both of which read values as strings, as does `admissibleAction` and the verifier's
`policy[category]` comparison. Restructuring the map would break all of that to express
one boolean. A list of names costs nothing, says the same thing, and keeps the property
attached where it belongs: to the *action*, not to one of the categories that happen to
route to it — two categories mapping to one irrevocable action should not have to declare
it twice and cannot then disagree.

**It joins the pin set.** `afp:irrevocableActions` becomes a fourth member of ADR-0010's
pin set, digest-covered and thread-agreed with the rest. This is not bookkeeping: a
declaration that could vary between two Offers on one thread would let a publisher choose,
after the fact, which Offer's version governs the escape hatch — and the escape hatch is
the one thing on this record that must not be negotiable after the answers are in.

**Validation, both sides.** Every name in `afp:irrevocableActions` MUST appear as a value
of the pinned `afp:actionPolicy`. A name that matches no action declares the
irreversibility of nothing, which is the kind of dead clause an auditor reasonably reads
as a live one. The rule holds a fortiori when there is no policy pinned at all: a list
whose names are drawn from a policy that does not exist is that same dead clause in its
most complete form, and the check must not be scoped so that the emptiest case is the one
it never examines.

### 2. The `annotate` disposition — for consequences that can only be acknowledged

ADR-0007's disposition duty gains a second form. For an action whose name was declared
irrevocable, the disposition activity carries **`afp:disposition: "annotate"`** alongside
`afp:disposes` and `afp:actsOn`: it binds the withdrawn justification to the standing
consequence, states that the consequence stands because it cannot be recalled, and
commands nothing external. The existence check is unchanged — every acted-on superseded
Synthesis still demands its disposition — but the honest answer "we cannot undo this, and
here is the record saying so" now passes it, where today only a re-actuation can.

**An annotate disposition carries no `afp:action`, and that is the whole point** — it
commands nothing, so there is nothing for the policy to admit. This needs saying because
ADR-0007's disposition runs "the actuation loop once more, under the same pinned
`afp:actionPolicy`", and ADR-0006's replay demands that any activity carrying `afp:actsOn`
name an `afp:action` equal to `policy[category]`. An annotate disposition would fail that
check by having nothing to compare. So the check **swaps rather than lapses**: where
`afp:disposition` is `annotate`, the verifier does not ask whether the action was
admissible; it asks whether the *disposed* action's name appears in the
`afp:irrevocableActions` pinned on the thread that action was taken on. One named check
replaces another. An exemption would have been an escape hatch; a substitution is still a
wall, just a different one.

Three consequences of that phrasing, each deliberate:

- **The governing declaration is the original action's, not the disposition's.** The
  irreversibility that matters was pinned on the thread where the irrevocable thing was
  done, before it was done. A disposition cannot import a more convenient declaration from
  its own thread — and since dispositions live on the superseding answer's thread, which
  is the same `context` by ADR-0007 Decision 1, in practice these coincide; the rule says
  which one governs when a future decision separates them.
- **`annotate` against an action never declared irrevocable is a named finding.** The
  escape hatch exists only where it was declared, in advance, by someone who did not yet
  know they would want it.
- **An irrevocable action may still be disposed of by re-actuation.** Declaring
  irreversibility permits annotation; it does not forbid a deployment that finds a
  compensating action from taking one and recording it the ordinary way.

### 3. A superseding ratification names its panel delta

A `DecisionRecord` ratifying a superseding Synthesis MUST carry
**`afp:priorQuorumSnapshot`**: the `afp:quorumSnapshot` of the DecisionRecord that
ratified the answer being superseded.

The comparison is exact and free, because `afp:quorumSnapshot` is already
`digest(sorted(voters))` — a hash of the electorate. Two snapshots are the same panel or
they are not; there is no fuzzy "materially different" judgement for a verifier to make.
And the check has teeth rather than merely asking for a field: the declared prior snapshot
MUST **equal the snapshot actually carried by the prior ratification** the record holds.
A superseding DecisionRecord that names some other round's electorate — or invents one —
fails by name. Presence alone would let a deployment declare continuity it never had.

The prior ratification is found **by outcome, not by hash**. The record already resolves
"which DecisionRecord ratified this Synthesis" by matching `afp:outcome` against the
Synthesis id — that is how `ratified()` works today — so the check reads the snapshot off
*that* record and compares. No reverse index from a snapshot digest back to a round is
needed, and none should be built: a hash lookup would invite a superseding record to name
any electorate that ever voted on anything, where the outcome path can only ever find the
one round that actually ratified the answer being withdrawn.

Same-membership re-decision and changed-panel re-decision become distinguishable on the
record, and *materially different panel* stops being invisible. What follows from the
difference is deliberately not decided here: whether a changed panel's reversal carries
less weight is governance, and governance belongs to hub policy, not protocol (ADR-0002
put vote weights there for the same reason). The protocol's job is that the difference
shows.

**And this is where the synthesizer pin meets the changed panel.** ADR-0010 Decision 2
pins one actor whose Synthesis is admissible for a thread, and ADR-0010 deferred to this
ADR the question its own rule raised: a superseding Synthesis arrives on the *same*
`context` — so does the original pin bind it forever, making a legitimate panel change
unable to correct its own record? The ruling:

> The pinned synthesizer binds every Synthesis on the thread **unless the superseding
> Synthesis is ratified**, in which case the ratifying quorum is the authority for the
> substitution, and `afp:priorQuorumSnapshot` is what makes the substitution legible.

The reasoning is the one ADR-0007 already used for parity. An unratified answer is cheap
to correct and its synthesizer was named up front, so the pin stands — otherwise anyone
could supersede by simply being someone else. A ratified answer costs a quorum to
overturn, and a quorum that has convened is a stronger authority over "who may answer
this thread now" than a pin written before the panel changed. What the record must never
lose is the fact that the answerer changed, and Decision 3's snapshot pair is exactly
that fact.

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

Three rules make the edge checkable without making it brittle:

- **`afp:priorThread` is not part of the pin set.** It sits on the `afp:Task` object
  beside the pins but outside them, because it identifies *this thread's* prehistory
  rather than governing anything about the answer. A fan-out's opening Offer may carry it
  while the rest do not, and that must not read as pin divergence (ADR-0010 Decision 1).
- **A named prior thread that is present must be closed and unretracted.** If the export
  contains the named thread, it MUST carry a terminal outcome, and that outcome MUST NOT
  have been superseded — a "new ask continuing a closed thread" pointing at a live thread,
  or at one whose answer was withdrawn, is telling a story the record contradicts.
- **A named prior thread that is absent is not a failure.** Under ADR-0009 a lawfully
  scoped export routinely omits threads that belong to other subjects, and the whole point
  of the applicant's subject-scoped bundle is that other applications are not in it. An
  unresolvable `afp:priorThread` is reported as an out-of-scope reference, not tampering —
  the same discipline redaction stubs earn elsewhere: absence that is *declared by the
  scope* is discretion, and only undeclared absence is deletion. A thread naming itself as
  its own prehistory is, however, always a finding.

## Options considered

| Option | Rejected because |
|---|---|
| Re-actuate always; let the external refusal be the record | The refusal lives in the external system's logs, not the record; ADR-0007's existence check fails and the deployment is marked dishonest for being honest |
| Discover irreversibility at disposition time (annotate allowed anywhere) | An escape hatch available everywhere is a duty available nowhere — declaring it at pin time keeps the auditor's question answerable before the fact |
| Forbid supersession of acted-on irrevocable actions | Erases the revision instead of the action — the record must show the justification was withdrawn even when the world keeps the consequence |
| Weight or invalidate changed-panel reversals in protocol | Governance decided in protocol; ADR-0002 put weights in hub policy and this is the same shape — the protocol makes the delta visible, the hub decides what it means |
| Overload `afp:supersedes` for the new-ask edge | The two claims are opposites — one retracts, one explicitly does not — and sharing a property would re-blur the line ADR-0007 drew |
| `afp:irrevocable: true` inside each policy entry (values become objects) | Breaks the literal `category → action` map ADR-0006 chose so a policy cannot hide logic, and every reader built on it: `admissibleAction`, `validateActionPolicy`, the `afp:no-verdict` check and the verifier's `policy[category]` string comparison. A restructured map is a large cost for one boolean, and it attaches irreversibility to a category when it is a property of the action |
| `afp:irrevocableActions` outside the pin set | A declaration that could differ between two Offers on one thread would let the publisher pick, after the answers are in, which version governs the escape hatch |
| Exempt `annotate` dispositions from the action check entirely | An exemption is a hole; the substitution — check the declaration instead of the admissibility — keeps a wall in the same place, facing a different way |
| Let the pinned synthesizer bind superseding Syntheses unconditionally | A legitimate panel change could then never correct its own record; the ratified case is exactly where a quorum's authority already exceeds a pin's |
| Let any actor supersede once the pin is "stale" | Then anyone supersedes by being somebody else. Ratification is what distinguishes a panel that changed from a stranger who showed up |
| Fail replay when `afp:priorThread` does not resolve | Would make ADR-0009's lawful subject-scoped export — the deliverable this whole scenario exists to produce — fail for being correctly scoped |

## Compatibility and migration

- **The pin set grows to four keys.** `PIN_KEYS` in `pins.py` and `TaskPins` in
  `ap/pins.ts` gain `afp:irrevocableActions`. Existing records pin none of it, so every
  pin digest is unchanged and nothing already exported re-reads differently — the key is
  absent, the set restricts to what is present, the digest is the same bytes.
- **`afp:priorQuorumSnapshot` is a MUST only where it applies.** It binds a DecisionRecord
  that ratifies a *superseding* Synthesis. An ordinary ratification carries nothing new,
  which is every DecisionRecord on the record today — with exactly one exception, and it
  is the interesting one: **ADR-0007's own gate goes red**, because scenario 07's whole
  point is a ratified answer retracted by a ratified answer, which is precisely the shape
  this MUST binds. That fixture is updated with the build (the superseding round now names
  the electorate of the first), and the failure is the requirement working rather than a
  regression: the one existing record that should have declared a panel delta is the one
  that now has to.
- **`dispositionStamp` splits in two.** It composes `actionStamp` today, so every
  disposition is necessarily a re-actuation validated against the policy. The annotate
  form needs its own path that deliberately does not call `admissibleAction` — the writer
  must be able to express "this commands nothing", which the current helper cannot.
- **ADR-0007's Decision 3 gains a second satisfying form** and is amended in place with a
  pointer, as ADR-0006's Decision 1 was for ADR-0010. Its existing check keeps its name
  and its meaning; what changes is what may satisfy it.
- **Spec sweep** once built: 03's vocabulary table gains `afp:irrevocableActions`,
  `afp:disposition` and `afp:priorThread`; 04's supersession prose states the annotate
  form and the ratified-substitution rule for the synthesizer pin; 03's Task and
  DecisionRecord diagram blocks gain the new properties.

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

Built. Y1 first because Y2's check reads the declaration it creates; Y3 and Y4 were
independent of both and of each other. The requirement that proved itself was Y3's:
ADR-0007's own gate went red, because scenario 07 is a ratified answer retracted by a
ratified answer — the one existing record that should always have declared a panel delta
was the one that had to.

| ID | Task | Where | Stage |
|---|---|---|---|
| **Y1** ✅ | `afp:irrevocableActions` as the fourth pin: `TaskPins` (`ap/pins.ts:29`) and `buildPinSet` (`:56`); `PIN_KEYS` (`pins.py:25`) — the digest and equality paths need no change, they iterate the tuple; a `check_pins` block validating every declared name is a value of the pinned policy, beside the existing `afp:no-verdict` block (`pins.py:156`) | `ap/pins.ts`, `pins.py` | 1 |
| **Y2** ✅ | The annotate disposition: a writer path that does *not* compose `actionStamp` (`allocation/actions.ts:64` composes it today, so every disposition is currently a re-actuation); verifier — `check_supersession`'s orphan scan (`action.py:380`) accepts a disposition carrying `afp:disposition: "annotate"`, and a new named check that the disposed action's name was declared irrevocable on its own thread's governing pins | `allocation/actions.ts`, `action.py` | 1 |
| **Y3** ✅ | `afp:priorQuorumSnapshot` on `DecisionRecordSpec`/`decisionRecord` (`hub/activities.ts:171`) and through `closeRound` (`hub/hub.ts:618`); verifier — extend the parity check at `action.py:369` to require it on a superseding ratification and to equal the snapshot on the DecisionRecord found by `afp:outcome` (the `ratified()` path at `:325`), no hash index; the synthesizer-substitution rule keyed off the same fact | `hub/activities.ts`, `hub/hub.ts`, `action.py` | 2 |
| **Y4** ✅ | `afp:priorThread` on the task object (`ap/activities.ts` `TaskSpec`, and the announce path), explicitly *not* in `PIN_KEYS`; verifier — resolution when present (closed, unretracted), out-of-scope tolerance when absent, self-reference finding | `ap/activities.ts`, `allocation/activities.ts`, `pins.py` or a new check | 2 |
| **Y5** ✅ | Gate `test/adr0011.test.ts`, composing with (never replacing) `adr0007.test.ts`'s mutation set, and reusing `testInstance`/`testHub`/`publishRaw`/`mutateBundle` from `helpers.ts`: an irrevocable action disposed by `annotate` passes; the same with no disposition at all fails ADR-0007's existing orphan check; `annotate` against an action never declared irrevocable fails by name; a superseding ratification with no `afp:priorQuorumSnapshot`, and one naming the wrong electorate, each fail; a ratified substitution by a non-pinned synthesizer passes while an unratified one fails; a new-ask thread resolves its prehistory, and a self-referencing one fails | `test/adr0011.test.ts` | 3 |
| **Y6** ✅ | Regression: ADR-0007's gate and every existing export still pass unchanged — the pin-set growth must be a no-op on records that pin none of it | `test/adr0007.test.ts`, `export*/` | 3 |

## References

- [Scenario 09 — the screening sidecar](../scenarios/09-the-screening-sidecar.md),
  findings 38, 39
- [ADR-0007](0007-supersession.md) — the disposition duty and same-`context` rule
  this ADR completes for the irreversible case
- [ADR-0010](0010-pinning-without-an-auction.md) — the pin point Decision 1 writes
  into
