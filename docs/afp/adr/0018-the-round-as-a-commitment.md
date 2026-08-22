# ADR-0018 — The round as a commitment: a clock, a bar, a binding, and a grade

- **Status:** Accepted, and **built** (2026-08-22) — gated per decision with
  discriminating mutations, and by a compatibility case proving a round that pins nothing
  still signs the bytes it signed before this ADR existed
- **Date:** 2026-08-22
- **Applies to:** every deliberation round whose outcome the world will act on — which
  scenario 11 argues is the interesting kind: a round that merely records a shared
  conclusion loses nothing here, and a round that commits its members to something gains
  everything
- **Builds on:** [ADR-0002](0002-p2-hub-and-crdt-stack.md) (the L0 round and the
  snapshot-pinning this extends), [ADR-0005](0005-operators-are-equal.md) (the weights the
  new pinned rule is computed over), [ADR-0010](0010-pinning-without-an-auction.md)
  (whose `afp:no-verdict` release is the shape Decision 2 reuses),
  [ADR-0014](0014-p5-shared-hub-stack.md) (`afp:uncounted` — which names a silence this
  ADR prices)
- **Driven by:** [scenario 11 / campaign 8](../scenarios/README.md#campaign-8--built-scenario-11--adr-0018-adr-0019),
  findings 50, 51, 56, 57 — with finding 52 resolved alongside as spec precision

## Context

Every round machinery decision since ADR-0002 answered the question *"what did the group
conclude?"* — and answered it so well that a stranger with three folders can recompute a
tally nobody can quietly edit. Scenario 11 asked four questions of the same machinery and
found none of them representable:

- **When must it conclude by?** `afp:Proposal` pins round, options, snapshot, voters and
  weights — and no deadline. 03 gives two incompatible accounts of a round that runs out
  of time: the sequence diagram's `else` branch abandons it (`Undo{Vote} / abandon
  round`), while the prose four lines below states *"Every round — either level — closes
  with an `afp:DecisionRecord`"* (finding 50).
- **What did the outcome have to clear?** 02 states flatly that *"Quorum is a weight-sum
  threshold"* and names two minimums to compute one — and no proposal carries a threshold,
  `closeRound` returns the largest tally, and the verifier recomputes the tally without
  asking what it needed to beat. The reference demo closes a decision at exactly half the
  pinned weight, and the record cannot say whether that sufficed (finding 51).
- **Whom does it bind?** Nothing states what a `DecisionRecord` obliges of the members
  pinned into it. Harmless while outcomes were divisible — scenario 10's operators each
  filtered their own network — and load-bearing the moment an outcome is indivisible by
  construction, where the interesting event is a member acting *against* a decision it
  was pinned into, invisibly (finding 57).
- **Was it right?** `afp:Settlement` binds to estimates or a Synthesis, **follows an
  award**, and is published once per task; a governance `DecisionRecord` is none of those.
  04 states the stake in its own words — settlement SHOULD raise a correct dissenter's
  standing, because *"a swarm that penalizes accurate minority objections will stop
  producing them"* — and a governance round is precisely where dissent is most expensive
  to voice (finding 56).

Alongside, one pricing fact nobody declared (finding 52): ADR-0005 preserves the
per-operator total by dividing it among that operator's *pinned* voters, so an operator
that seats an agent which never votes halves the voice of the agent that does.
`afp:uncounted` names the silence; nothing names its cost, and liveness gating cannot
reach an agent that is reachable and simply outdoors.

The through-line: **a round is specified as an event and used as a commitment.** The fix
is not new machinery — every decision below pins one more fact into the proposal the
machinery already signs, or extends one subject an existing record already takes.

## Decisions

### 1. The proposal declares its own terms: `afp:deadline` and `afp:quorumRule`

`afp:Proposal` gains two optional properties, pinned at propose time exactly as voters and
weights already are:

- **`afp:deadline`** — an instant after which no vote is counted. Votes published after it
  (by the hub's observation, which ADR-0014 already made the ordering authority) land in
  the record as received and uncounted, the same lane as an out-of-snapshot vote.
- **`afp:quorumRule`** — the weight-sum the winning option must clear, stated as a named
  form over the pinned weights (`majority-of-total`, `two-thirds-of-total`, or an explicit
  integer), so it is **recomputable from the proposal alone** exactly as the weights are.
  A proposer that writes its own convenient number fails replay the same way one that
  writes its own weights does.

Both are optional because both have honest defaults that preserve every existing record:
no deadline means the round closes when the closer closes it (today's behaviour), and no
rule means plurality-of-counted (today's behaviour) — but a verifier now reports which of
the two kinds of round it replayed, so "no bar was declared" is a visible property of a
record rather than an unaskable question.

### 2. Every round closes with a `DecisionRecord` — the diagram loses, the prose wins

The 03 contradiction is ruled in favour of the prose. The `Undo{Vote} / abandon round`
branch is deleted from the sequence diagram, and a round that expires or fails its pinned
rule closes with a `DecisionRecord` whose outcome is the reserved non-answer
**`afp:no-decision`**, carrying a machine-readable reason (`expired`,
`threshold-not-met`) beside the same tally, `afp:countedVotes` and `afp:uncounted` any
close carries.

This is ADR-0010 Decision 4 arriving at the round: terminality always releases whoever is
waiting, and *"we were asked and did not manage to decide"* becomes a signed, dated,
replayable fact instead of an absence indistinguishable from nobody having asked. A
`no-decision` record ratifies nothing, actuates nothing, and supersedes nothing — it is a
terminal state, not an outcome with a policy row.

### 3. A binding outcome is declared, and departure from it is a recorded act

`afp:Proposal` gains an optional **`afp:binding: "joint"`** declaration. It changes no
tally arithmetic and grants the hub no enforcement power — a protocol cannot reach into a
car park. What it does is name the stakes in the same signed object that pins the
electorate deciding them, so a voter cannot later claim it thought the round was advisory.

Its counterpart is **`afp:Departure`**: an activity by which a pinned voter states, on its
own chain, that it is not following an outcome it was pinned into — naming the
`DecisionRecord` by digest and carrying a reason. Publishing one is costly and honest;
*not* publishing one while defecting is the thing the record then shows: a joint-binding
decision, a member's subsequent activities inconsistent with it, and no departure. Visible
non-compliance is the whole mechanism, and it is worth more than unenforceable compliance.

### 4. A `DecisionRecord` is a settleable subject

`afp:Settlement` may take a `DecisionRecord` as its subject: the observed outcome, its
evidence, published once per round. The allocation preconditions stay scoped to
allocation — *follows an award* remains true where there is an award, and is not
generalized away; a decision-settlement instead **follows the round it settles**, and a
second settlement for the same round competes with the first exactly as 04 already rules
for tasks.

The dissent credit is mechanical rather than aspirational here: `afp:countedVotes`
resolves every counted ballot, so the members who voted against a decided outcome are
recomputable from the record — and where the settlement shows the outcome wrong, 04's
SHOULD (the correct minority's standing rises) finally has the input it needs in the one
arena where objecting costs the most.

### 5. Spec precision, not machinery: a silent seat's price is stated, and the electorate is declared

Two sentences land in 02 rather than in code (finding 52):

- **The dilution consequence, stated plainly:** seating an agent that does not vote
  spends its own operator's weight — the per-operator total is conserved and split across
  pinned voters, so the cure for a caretaker who reads but never votes is not to pin him,
  not to hope.
- **The electorate is proposer-declared and visible.** `proposeRound` already accepts an
  explicit voter list; the spec states what the implementation already does — the pinned
  `afp:voters` is a *declaration*, every seated member can see whether it was included,
  and a proposer that pins a convenient subset has signed exactly that. A hub policy MAY
  constrain admissible electorates; the record makes cherry-picking attributable either
  way.

No new role, no participation registry: the existing explicit-voters parameter plus the
existing visibility of the pinned list already carry the fix.

## Options considered

- **A liveness-style participation register that auto-excludes non-voters** (for 52):
  rejected — it recreates the liveness register's failure mode (state living on the hub,
  gone when the hub is) and turns a deliberate human judgement (*should the caretaker's
  seat count?*) into a heuristic.
- **Making `afp:deadline` mandatory:** rejected — the solo profile's rounds close in
  milliseconds and a mandatory deadline would be ceremony; optional-with-visible-absence
  preserves every existing record byte-for-byte.
- **An enforcement semantics for `afp:binding`** (voiding a defector's future votes,
  weight penalties): rejected — enforcement is a hub-policy and reputation question, and
  wiring it into the tally would let a majority punish dissent structurally, which is the
  exact failure 04's dissent-credit language exists to prevent.
- **Folding decision-settlement into a new record type:** rejected — settlement already
  has the shape (subject, observed actuals, evidence, once-per), and a second
  "outcome-grading" record would be a place claim.

## Consequences

- A round's record now answers four questions it could not: what the clock was, what the
  bar was, whom the outcome bound, and — later — whether it was right. Each answer is a
  pinned or published fact, recomputable, never an inference.
- `closeRound` grows two checks (deadline passed → `no-decision(expired)`; rule not
  cleared → `no-decision(threshold-not-met)`) and the verifier grows their recomputation;
  both mirror machinery that exists (ADR-0010 Decision 4's release, the weight
  recomputation).
- The `no-decision` outcome joins the supersession and actuation surfaces as a terminal
  that explicitly does not participate — three one-line guards (cannot be ratified,
  cannot be acted on, cannot supersede).
- Existing exports replay unchanged: every new property is optional, and its absence is
  reported rather than failed.

## Implementation architecture

Everything below is normative for the reference implementation, and specific enough that
the wire bytes are decided here rather than in the code. Two properties govern every
choice: **integer arithmetic only** (the JCS numeric profile forbids non-integer numbers,
so no ratio, percentage or float appears in a signed object), and **recomputable from the
record alone** (a verifier holding one bundle must reach the same answer as the hub, with
no live state and no clock of its own).

### W1. Wire schemas

**`afp:Proposal` — three new optional properties**, on the object, beside the pinned
weights they are computed over:

```jsonc
{
  "id": "https://hilltop.example/hubs/bus-bridge/proposals/snow",
  "type": "afp:Proposal",
  "afp:hub": "https://hilltop.example/hubs/bus-bridge",
  "afp:round": "https://hilltop.example/rounds/snow",
  "content": "Close all three schools today?",
  "afp:options": ["yes", "no"],
  "afp:quorumSnapshot": "sha256:…",
  "afp:voters": ["…/head", "…/caretaker", "…/s-head", "…/e-head"],
  "afp:voterWeights": { "…/head": 1, "…/caretaker": 1, "…/s-head": 2, "…/e-head": 2 },

  "afp:deadline": "2026-02-11T06:00:00.000Z",        // NEW — optional
  "afp:quorumRule": { "afp:form": "majority-of-total" }, // NEW — optional
  "afp:binding": "joint"                              // NEW — optional
}
```

- **`afp:deadline`** — an RFC 3339 instant, always written with millisecond precision and
  a `Z` offset (the writer's existing `toISOString()` shape). Absent means "no deadline",
  which is today's behaviour.
- **`afp:quorumRule`** — an object, never a bare string, so a form can gain parameters
  without a breaking shape change. Closed registry of forms, exactly like the tie-break
  constant and the selection rules:

  | `afp:form` | Threshold over `T` = Σ pinned weights | Extra property |
  |---|---|---|
  | `majority-of-total` | `floor(T / 2) + 1` | — |
  | `two-thirds-of-total` | `floor(2T / 3) + 1` | — |
  | `explicit` | the stated integer | `afp:threshold` (integer ≥ 1) |

  An unknown form is a **replay failure**, never a silently ignored field — a rule a
  verifier cannot compute is worse than no rule, because it reads like a bar was set.
- **`afp:binding`** — closed set, currently the single value `"joint"`. Absent means
  advisory.

**`afp:DecisionRecord` — one new optional property**, and one reserved outcome value:

```jsonc
{
  "type": "afp:DecisionRecord",
  "afp:outcome": "afp:no-decision",              // reserved value
  "afp:noDecisionReason": "threshold-not-met",   // NEW — REQUIRED iff outcome is afp:no-decision
  "afp:weightTally": { "yes": 2, "no": 3, "abstain": 1 },
  "afp:countedVotes": ["sha256:…"],
  "afp:uncounted": [{ "agent": "…/caretaker", "afp:status": "silent" }]
}
```

`afp:noDecisionReason` is one of `expired` | `threshold-not-met`. `afp:no-decision` MUST
NOT appear in any proposal's `afp:options`; a proposal that lists it is rejected at
propose time and fails replay.

**`afp:Departure` — a new top-level activity type**, shaped like `afp:Settlement`
(a bare `afp:`-typed activity carrying an object), published by a pinned voter on its own
chain, `hub` visibility, on the round's thread:

```jsonc
{
  "type": "afp:Departure",
  "actor": "https://riverside.example/agents/head",
  "context": "urn:afp:thread:snow-2026-02-11",
  "object": {
    "id": "https://riverside.example/departures/snow",
    "type": "afp:Departure",
    "afp:hub": "https://hilltop.example/hubs/bus-bridge",
    "afp:round": "https://hilltop.example/rounds/snow",
    "afp:decision": "sha256:…",     // digest of the DecisionRecord ACTIVITY
    "content": "Our building is at 12°C; we are sending our families home."
  }
}
```

`afp:decision` is an activity **digest**, not an id — the same grain `afp:countedVotes`
and `afp:actsOn` already use, so it binds to exact bytes rather than to a name someone
could reissue.

**`afp:Settlement` — a second, mutually exclusive subject.** The allocation settlement is
untouched to the byte. A decision-settlement replaces `afp:task`/`afp:settles` with:

```jsonc
{
  "type": "afp:Settlement",
  "object": {
    "id": "https://hilltop.example/settlements/snow",
    "type": "afp:Settlement",
    "afp:hub": "https://hilltop.example/hubs/bus-bridge",
    "afp:decision": "sha256:…",        // digest of the DecisionRecord activity
    "afp:round": "https://hilltop.example/rounds/snow",
    "afp:observedOutcome": "yes",      // MUST be one of the proposal's afp:options
    "afp:evidence": [                  // 07's artifact shape, hash-addressed
      { "type": "Document", "afp:digest": "sha256:…", "mediaType": "text/markdown",
        "url": "https://hilltop.example/artifacts/sha256-…" }
    ],
    "afp:dissentVindicated": ["https://riverside.example/agents/head"]
  }
}
```

Exactly one of `afp:task` and `afp:decision` MUST be present. A settlement carrying both,
or neither, fails replay.

### W2. Threshold arithmetic — one function, mirrored

Both implementations compute the bar identically, in integers, from the proposal alone:

```
thresholdOf(rule, weights) -> int | UNKNOWN_FORM
    T = sum(weights.values())            # pinned total, not counted total
    majority-of-total   -> T // 2 + 1
    two-thirds-of-total -> (2 * T) // 3 + 1
    explicit            -> rule["afp:threshold"]     (integer >= 1, else UNKNOWN_FORM)
    otherwise           -> UNKNOWN_FORM
```

`T` is the **pinned** total — every seat in `afp:voterWeights`, including seats that never
voted. This is the decision finding 52 makes visible rather than hides: a silent seat's
weight still counts toward the bar its own operator's vote must clear, which is exactly
why the spec text in Decision 5 tells deployments not to pin a seat that will not vote.

TypeScript: `src/instance/src/hub/quorum.ts`, exported as
`thresholdOf(rule: QuorumRule, weights: Record<string, number>): number | null` (`null` =
unknown form). Python: `src/verifier/decision.py`, `threshold_of(rule, weights)` returning
`int | None`. The two are a parity pair in the sense `voter_weights` already is — the
existing `parity.test.ts` case list gains the same inputs on both sides.

### W3. `closeRound` — the decision algorithm, in order

```
close(round, at):                                  # `at` = hub clock, ISO instant
  row      = loadRound(round)
  votes    = countedVotesFor(row)                  # unchanged
  tally    = tallyOf(row, votes)                   # unchanged, incl. the abstain residual
  best     = argmax(tally)                         # unchanged: options in declared
                                                   # order, then abstain; first wins ties
  outcome  = best
  reason   = null

  if row.quorumRule is present:
      bar = thresholdOf(row.quorumRule, row.weights)
      if bar is null:  throw                       # never sign an uncomputable rule
      if best == "abstain" or tally[best] < bar:
          outcome = "afp:no-decision"
          reason  = (row.deadline is present and at > row.deadline)
                        ? "expired" : "threshold-not-met"

  emit DecisionRecord{ outcome, reason?, tally, countedVotes, uncounted, … }
```

Three properties this fixes deliberately:

- **`abstain` can never be an outcome under a rule.** It is a residual bucket, not an
  option; a round where absence outweighs every option has not decided anything.
- **A round with no rule behaves exactly as today** — `argmax`, no reason, no new
  properties in the signed bytes. Every existing export replays unchanged, byte for byte.
- **`expired` versus `threshold-not-met` is decided by the close instant**, not by
  guesswork, and the verifier recomputes the distinction from the `DecisionRecord`'s own
  `published` (W5).

### W4. The deadline is enforced twice, in two currencies

| Where | Against what | Failure mode it closes |
|---|---|---|
| `onVote` (hub, at receive) | the **hub's own clock** — ADR-0014 Decision 3 already makes the hub the sequencing authority | a vote that genuinely arrives late is never counted, whatever it claims |
| `check_decision_record` (verifier) | the vote's own **`published`** — the only instant in the record | a hub that counts a late vote, or a voter that backdates one, fails replay |

Neither check alone is sufficient and together they are tight: arriving late is refused by
the hub, and *claiming* to be early while arriving late leaves a counted vote whose
`published` the sender signed — which is a signed lie, on the record, attributable. Late
votes are dropped exactly as out-of-snapshot votes are dropped today: no receipt, no
tally, and the voter appears in `afp:uncounted` as `silent`.

### W5. Verifier checks — names, conditions, and messages

All in `src/verifier/decision.py`, all inside the existing `check_decision_record` except
where noted. Check names follow the `decision: {label} …` convention so the ADR-0015
census counts them per domain.

| # | Check name | Fails when |
|---|---|---|
| V1 | `{label} quorum rule is a known form` | `afp:quorumRule` present and `threshold_of` returns `None` |
| V2 | `{label} outcome cleared the pinned quorum rule` | outcome is a real option, a rule is pinned, and `tally[outcome] < bar` — **the check finding 51 exists for** |
| V3 | `{label} no-decision carries a reason` | outcome is `afp:no-decision` and `afp:noDecisionReason` is absent or outside the closed set |
| V4 | `{label} no-decision reason is justified` | reason `threshold-not-met` but the winning option in fact cleared the bar; or reason `expired` while the record's `published` is at or before the deadline |
| V5 | `{label} counted votes respect the deadline` | a counted vote's `published` is after the proposal's `afp:deadline` |
| V6 | `{label} afp:no-decision is not an option` | the proposal's `afp:options` contains the reserved value |
| V7 (new fn) | `departure: {id} names a producible DecisionRecord` | `afp:decision` resolves to no present `afp:DecisionRecord` activity in the pool |
| V8 (new fn) | `departure: {id} is by a pinned voter of that round` | the departing actor is outside the decision's pinned `afp:voters` |
| V9 (new fn) | `departure: {id} departs a binding decision` | the round's proposal did not declare `afp:binding: "joint"` |
| V10 (new fn) | `settlement: {id} names one subject` | both or neither of `afp:task` / `afp:decision` present |
| V11 (new fn) | `settlement: {id} names a producible DecisionRecord` | `afp:decision` resolves to nothing, or `afp:round` disagrees with it |
| V12 (new fn) | `settlement: {id} observed outcome is an option of the round` | `afp:observedOutcome` is outside the proposal's `afp:options` |
| V13 (new fn) | `settlement: {id} vindicated dissenters voted the observed outcome` | an actor in `afp:dissentVindicated` has no counted vote in that round, or its vote's `value` is not the observed outcome, or its vote equalled the decided outcome (it was not a dissenter) |
| V14 (new fn) | `settlement: {id} settles its round once` | two settlements in the bundle name the same round |

V13 is the one worth reading twice. It makes the credit mechanical: *dissent* is
"voted something other than what the record decided", *vindicated* is "voted what the
world turned out to be", and both are recomputed from `afp:countedVotes` — so a hub
cannot hand standing to a friend who voted with the majority, and cannot withhold it
silently either, because the settlement's own list is checked against the ballots.

Backward compatibility is uniform: every check is **conditional on the new property being
present**. A pre-ADR-0018 record triggers V1–V6 not at all, exactly as ADR-0014's
`afp:uncounted` checks are opt-in today.

### W6. Terminality guards

`afp:no-decision` is a terminal that participates in nothing:

- **Ratification** (ADR-0007/0011): a `DecisionRecord` whose outcome is `afp:no-decision`
  ratifies no Synthesis — the existing "outcome names a producible Synthesis" branch in
  `check_decision_record` skips it explicitly rather than trying to resolve the reserved
  value as an id.
- **Actuation** (ADR-0006/0010 Decision 3): ~~an `afp:actsOn` resolving one hop to a
  `no-decision` record is a replay failure — nothing was decided to act on.~~
  **Amended by [ADR-0019](0019-acting-on-a-decision.md) (2026-08-22), which is
  normative here.** This clause was wrong, and grounding ADR-0019 in ADR-0010 Decision 4
  is what exposed it: *terminality always releases the actuator* is the principle that
  exists so an application never parks forever, and refusing to act on a round that
  failed to decide parks exactly the actuator whose morning depended on an answer. The
  corrected rule: a `no-decision` record **is** actionable, through the pinned policy's
  reserved `afp:no-decision` key — the governance twin of `afp:no-verdict`. Recorded as
  an amendment rather than an edit because the reasoning is the useful part: a guard that
  reads as prudence can be the parked-application failure wearing a safety hat.
- **Supersession**: a `no-decision` record supersedes nothing, and nothing supersedes it —
  a round that failed is re-run as a new round, not retracted.

### W7. Storage and API surface (TypeScript)

`RoundRow` gains three nullable columns, migrated the way the hub schema already
migrates — `CREATE TABLE IF NOT EXISTS` plus additive `ALTER TABLE` guarded by a
`PRAGMA table_info` probe, so an existing `afp.db` opens unchanged:

```sql
ALTER TABLE hub_rounds ADD COLUMN deadline    TEXT;    -- ISO instant, nullable
ALTER TABLE hub_rounds ADD COLUMN quorum_rule TEXT;    -- JSON, nullable
ALTER TABLE hub_rounds ADD COLUMN binding     TEXT;    -- 'joint', nullable

CREATE TABLE IF NOT EXISTS hub_departures (
  round_id         TEXT NOT NULL,
  actor            TEXT NOT NULL,
  departure_digest TEXT NOT NULL,
  PRIMARY KEY (round_id, actor)
);
```

Signatures, exactly as the implementers must write them:

```ts
// src/instance/src/hub/quorum.ts                                            NEW FILE
export type QuorumRule =
  | { "afp:form": "majority-of-total" }
  | { "afp:form": "two-thirds-of-total" }
  | { "afp:form": "explicit"; "afp:threshold": number };
export function thresholdOf(rule: QuorumRule, weights: Readonly<Record<string, number>>): number | null;

// src/instance/src/hub/activities.ts
export interface ProposalSpec { /* …existing… */
  deadline?: string;          // -> afp:deadline
  quorumRule?: QuorumRule;    // -> afp:quorumRule
  binding?: "joint";          // -> afp:binding
}
export interface DecisionRecordSpec { /* …existing… */
  noDecisionReason?: "expired" | "threshold-not-met";
}
export const NO_DECISION = "afp:no-decision";
export interface DepartureSpec {
  departureId: string; hub: string; round: string; decision: string; reason: string;
}
export function departure(envelope: Envelope, spec: DepartureSpec): { [key: string]: JsonValue };

// src/instance/src/hub/hub.ts
proposeRound(options: { /* …existing… */
  deadline?: string; quorumRule?: QuorumRule; binding?: "joint";
}): OutboxEntry;
roundDepartures(round: string): { actor: string; digest: string }[];

// src/instance/src/allocation/activities.ts
export interface DecisionSettlementSpec {
  settlementId: string; hub: string; decision: string; round: string;
  observedOutcome: string;
  evidence?: readonly { [key: string]: JsonValue }[];
  dissentVindicated?: readonly string[];
}
export function settleDecision(envelope: Envelope, spec: DecisionSettlementSpec): { [key: string]: JsonValue };
```

### W8. Work packages, with file ownership

Disjoint ownership, so the packages can be built concurrently without two writers ever
meeting in one file. Each lists the files it — and only it — may modify.

| WP | Owns | Depends on | Content |
|---|---|---|---|
| **WP-1 · builders + store** | `src/instance/src/hub/quorum.ts` (new), `src/instance/src/hub/activities.ts`, `src/instance/src/hub/store.ts`, `src/instance/src/allocation/activities.ts` | — | W1 builders, W2 `thresholdOf`, W7 schema and the departures table |
| **WP-2 · hub logic** | `src/instance/src/hub/hub.ts` | WP-1's signatures (fixed above, so it may be written in parallel) | `proposeRound` pinning + `afp:no-decision`-in-options rejection, `onVote` deadline gate (W4), `closeRound` algorithm (W3), `onDeparture` receive + `roundDepartures` |
| **WP-3 · verifier** | `src/verifier/decision.py`, `src/verifier/afp_verify.py` | the W1 wire schema only | `threshold_of`, checks V1–V14, dispatch for `afp:Departure` and the settlement variant, W6 guard on the ratification branch |
| **WP-4 · gate + spec text** | `src/instance/test/adr0018.test.ts` (new), `docs/afp/02-hubs-and-state.md`, `docs/afp/03-coordination.md` | WP-1..3 | W9's gate matrix, Decision 5's two sentences in 02, and replacing 03's `Undo{Vote} / abandon round` branch per Decision 2 |

**The namespace needs no change**, which is worth stating rather than discovering twice:
`afp:deadline` is already in `docs/ns/v3.jsonld` as an `xsd:dateTime` (minted for
`afp:Task`, reused here unchanged), and every other property this ADR adds is a plain
literal or object that the `afp` prefix already covers — the context enumerates only the
terms needing type coercion. `afp:decision` in particular MUST NOT gain an `@id`
coercion: it carries an activity **digest**, exactly as `afp:actsOn` and
`afp:countedVotes` do, and neither of those is coerced either.

WP-1 and WP-3 have no overlap at all and go first, concurrently; WP-2 joins them (its
imports are fixed by W7); WP-4 lands last because it runs everything.

### W9. Gate matrix — `test/adr0018.test.ts`

Every row is a discriminating case: it must fail before the change and pass after, and the
mutation rows must fail *for the named reason*, following `adr0014.test.ts`'s shape
(`testInstance` + `testHub`, export, `runVerifier`, then `mutateBundle` for each negative).

| # | Case | Asserts |
|---|---|---|
| G1 | Round with `majority-of-total`, an option clears it | outcome is the option; `afp:quorumRule` present in the proposal; bundle replays clean |
| G2 | Same electorate, the winning option below the bar (the snow-day 3-of-6) | outcome is `afp:no-decision`, reason `threshold-not-met`; replays clean |
| G3 | Mutation: rewrite G2's outcome to `"no"`, leaving the tally | verifier fails **V2** by name |
| G4 | Mutation: `afp:form` set to `"whatever-we-like"` | verifier fails **V1** |
| G5 | Deadline set; a vote published after it is offered to the hub | not counted; the voter appears in `afp:uncounted` as `silent`; the close is `expired` when past the deadline |
| G6 | Mutation: splice a late vote's digest into `afp:countedVotes` | verifier fails **V5** |
| G7 | `afp:binding: "joint"`, an outvoted member publishes `afp:Departure` | it resolves at replay (V7–V9), and `roundDepartures` lists it |
| G8 | Mutation: a departure by an agent outside the pinned voters | verifier fails **V8** |
| G9 | Settlement on the decision, one vindicated dissenter who voted the observed outcome | replays clean (V10–V14) |
| G10 | Mutation: `afp:dissentVindicated` names a majority voter | verifier fails **V13** |
| G11 | Two settlements naming one round | verifier fails **V14** |
| G12 | A pre-ADR-0018 round (no rule, no deadline) | byte-identical proposal to today; every new check silently absent; `hub.test.ts` and the P2/P3/P5 demos unchanged |

G12 is the compatibility gate and is not optional: the existing `export/` reference bundle
and the `demo:p2` / `demo:p3` / `demo:p5` outputs must replay with the same check counts
as before, or the change has broken a shipped record.

## Build status

**Built** (2026-08-22) — all five decisions, gated by `test/adr0018.test.ts` (15 cases,
W9's matrix plus one the build itself forced), and the whole suite green at 173.

WP-1 and WP-3 built concurrently against the fixed schemas above, WP-2 alongside them
against W7's signatures, WP-4 last. Three defects surfaced only at integration, and each
is worth recording because none was visible inside a single work package:

1. **`afp_object` returns the wrapper for a double-typed activity.** `afp:Departure` types
   both its activity and its payload (as `afp:Settlement` and `afp:Award` already do), so
   the verifier read an empty payload and V7 "passed on nothing" until the check failed
   loudly on a clean bundle. Fixed by generalizing the settlement-specific reader into
   `wrapped_payload(activity, afp_type)` — every double-typed activity now reads through
   one function, which is where the next one will be caught.
2. **V4 read `published` off the payload rather than the activity.** The instant lives on
   the activity; the object never carries it. `expired` was therefore never justifiable.
3. **Both deadline comparisons were ISO string compares.** The deadline is
   caller-supplied, and `2026-02-11T06:00:00Z` versus `…06:00:00.000Z` is the same moment
   that string comparison orders differently — exactly the hazard `instant_millis`'s
   docstring was written for, reintroduced on the writer's side where it would have made
   the hub disagree with its own replay. Fixed with a `pastDeadline` helper comparing
   instants, and pinned by its own gate case.

Since the P5 demo was brought in sync (2026-08-22) there is also a **runnable**
demonstration, not just unit gates: `npm run demo:p5` and `npm run demo:p5:llm` pin a
`majority-of-total` bar, a deadline, `binding: "joint"` and a per-outcome action policy on
the bridge's round. The snow-day run routinely closes `afp:no-decision` on a 3-of-6 split —
finding 51's exact arithmetic, now producing a recorded non-answer instead of an unearned
winner — and the three-bundle export replays clean.

The compatibility claim (G12) is checked two ways rather than asserted: the gate proves no
new check fires on a round that pinned nothing, and a `git worktree` at the pre-change
commit produced a P2 bundle whose `afp:Proposal` and `afp:DecisionRecord` key sets are
identical to the new writer's, replaying at the same 652 checks under the new verifier.
Every shipped bundle still passes — P1 78, P2 652, P3 452, P5 393.

Not done here, deliberately: **W6's actuation guard** (an `afp:actsOn` resolving to a
`no-decision` record must fail) is the single seam with
[ADR-0019](0019-acting-on-a-decision.md) and lands with it, since nothing today can bind
an action to a `DecisionRecord` reached by a round that pinned no policy.

## References

- [Scenario 11 — The snow day](../scenarios/11-the-snow-day.md), findings 50, 51, 52, 56, 57
- [02 — Hubs and state](../02-hubs-and-state.md) § weighting and quorum
- [03 — Coordination](../03-coordination.md) § round sequence (the contradicted diagram)
- [04 — Operations](../04-operations.md) § Settlement
- [ADR-0010](0010-pinning-without-an-auction.md) Decision 4 (`afp:no-verdict` — the shape Decision 2 reuses)
