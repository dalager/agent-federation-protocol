# ADR-0019 — Acting on a decision: the round gets the apparatus a task has

- **Status:** Accepted, and **built** (2026-08-22) — gated per decision with
  discriminating mutations, with the existing ADR-0006/0010/0011 actuation gates and every
  shipped bundle unchanged
- **Date:** 2026-08-22
- **Applies to:** every deployment where a governance round's outcome is carried out in
  the world — which scenario 11 shows is a different thing from a task's answer being
  acted on, because the party acting may be exactly the party that must not vote
- **Builds on:** [ADR-0004](0004-solo-foundation-hardening.md) (the role table this
  extends), [ADR-0006](0006-checkable-actuation.md) (the actuation apparatus this
  finishes anchoring), [ADR-0010](0010-pinning-without-an-auction.md) (whose Decision 1
  fallback this extends one activity further, and whose finding-35 hop already lands
  `afp:actsOn` on a `DecisionRecord`), [ADR-0011](0011-supersession-meets-the-irreversible-world.md)
  (`afp:irrevocableActions`, which needs a pin site to exist on)
- **Driven by:** [scenario 11 / campaign 8](../scenarios/README.md#campaign-8--built-scenario-11--adr-0018-adr-0019),
  findings 53, 54, 55 — the campaign's through-line

## Context

Campaign 6 found that the checkability machinery had anchored itself to the Announce/Award
pair, and that the direct flow — the one the spec prescribes whenever the target is known —
silently lost all of it. ADR-0010 fixed that by moving the pin site to *the task-bearing
activity*: the `Announce{Task}`, or the direct `Offer{afp:Task}`.

Scenario 11 walks the same defect one flow further out. A decision reached by a governance
round alone has **no task-bearing activity anywhere in its thread**: the round opens with
`Offer{afp:Proposal}`, which is not one. So the round inherits nothing —

- no **`afp:actionPolicy`**, so a consequence of the decision has no policy to be
  admissible under, and ADR-0006's replay branch has no root to resolve to (finding 53);
- no **`afp:irrevocableActions`**, so ADR-0011's `annotate` disposition — legitimate only
  because irreversibility was *declared at pin time* — has nowhere to rest;
- and the actuation activity itself may be unpublishable: ADR-0004's role table has five
  columns (announce, bid, vote, publish Results, read), and a party whose entire function
  is to carry out a decision it must not influence fits none of them. `observer` cannot
  publish; `member` hands it a vote the deployment is deliberately withholding
  (finding 54). Scenario 11's notification desk must send an unrecallable message to nine
  hundred families at 06:00, and the record cannot hold the act.

The complement closes the triangle: **nothing constrains who may act.** ADR-0006's replay
checks that `afp:actsOn` resolves, that the category is in the closed set, and that the
action is admissible under the pinned policy — and never looks at the actor. A rostered
agent with no relation to the round emits a well-formed action and passes replay
unremarked (finding 55).

Three findings, one decision wearing three faces: **a decision that binds the world needs
the same apparatus a task does** — a pin site, a publisher, and an accountable actor.

## Decisions

### 1. `Offer{afp:Proposal}` is a pin site — ADR-0010's fallback extends one activity further

A proposal MAY carry the pin set — `afp:actionPolicy` and `afp:irrevocableActions`
(`afp:answerSufficiency` and `afp:synthesizer` do not apply to a round and are not
admitted on one) — under ADR-0010 Decision 1's discipline for *when* a pin binds:
published before any vote exists, in the same signed record.

**But the scope is the round, not the thread** (see note A in the architecture section
below). ADR-0010 makes a thread's task-bearing activities agree on one pin set byte for
byte, because a task thread produces one answer; a thread may carry many rounds, each its
own question with its own admissible consequences, and the two vocabularies differ — a
task policy is keyed by `afp:category`, a proposal policy by the round's outcomes. So a
proposal's pins govern its own round and take no part in the thread-wide agreement.

The resolution chain gains its missing root. For an action whose `afp:actsOn` names a
`DecisionRecord`: the governing policy is looked up from **the proposal of the round that
produced it** — the `DecisionRecord` already names its round, the round its proposal, and
both edges are already digest-bound.

### 2. The role table gains an `actuator`

ADR-0004's table gains one row:

| | announce | bid / commit | vote / be pinned | publish | read at `hub` |
|---|---|---|---|---|---|
| **actuator** | no | no | no | **only `afp:actsOn`-bearing activities**, on hub threads | yes |

An actuator reads everything at `hub` visibility — it has to; it is carrying the decision
out — and can influence nothing: never pinned into a snapshot, never admitted at bid, and
its only write is the actuation record itself, which is precisely the activity ADR-0006
requires to exist. Role state merges by the same LWW-over-the-Enroll-trail rule every role
already uses, and a verifier proves an actuator never voted the same way it proves an
observer never did.

The rejected narrower shape — a write-path carve-out on `observer` — is rejected for the
reason ADR-0004 rejected grant-holders-as-requesters: it would make one role mean two
things, and "which observer may write" would become workflow code, the enforcement that
leaves no trace.

### 3. The actor of an action is checked, from the trail replay already rebuilds

For every activity carrying `afp:actsOn` whose target resolves (directly or by the one
hop) to a `DecisionRecord`: the actor MUST be enrolled — as `member` or `actuator` — in
the hub whose round produced it, at the activity's `published` instant, replayed from the
Enroll trail the verifier already reconstructs for snapshot and role checks. An action by
a stranger to the hub becomes a named replay failure instead of a well-formed unremarked
success.

For the direct flow — an action on a Synthesis with no hub in sight — the constraint is
the one that already exists implicitly and is now stated: the actor is a rostered agent of
a party to the thread. No new registry, no new trust root; both checks read facts the
record already carries.

## Options considered

- **Model the actuator as an external port agent (finding 36's shape) instead of a
  role:** rejected — finding 36's port agent answers *how an external system holds a
  pen*; this answers *what a pen-holder may do inside a hub*. The notification desk is
  both, and the two mechanisms compose rather than compete.
- **Require actions to be emitted by the hub itself:** rejected — the hub is somebody's
  server (ADR-0014), and making the host the sole actuator would hand one member the
  execution monopoly on every joint decision, which is worse than the gap.
- **A per-action authorization list pinned in the policy** (named agents rather than a
  role): deferred — a deployment can already narrow to it by enrolling exactly one
  actuator; pinning names would couple the policy to a roster that churns.

## Consequences

- The most consequential activities in a governance deployment — the ones that change the
  world — become governed, publishable, and attributable: a policy to be admissible
  under, a role that can publish them without corrupting the electorate, and an actor
  check with teeth.
- ADR-0011's machinery finally reaches the flow that needs it most: an unrecallable 06:00
  message can be declared irrevocable *in the proposal*, making the later `annotate`
  disposition legitimate rather than a waiver.
- The verifier grows two checks (pin resolution through the round edge; actor enrollment
  on decision-actuation) — both over edges and trails it already walks.
- One more role in the vocabulary is real cost; the alternative — deployments quietly
  granting `member` to parties that must not vote — is a corrupted electorate that no
  replay would ever flag, which is the expensive kind of cheap.

## Implementation architecture

Normative for the reference implementation, at the same grain as
[ADR-0018](0018-the-round-as-a-commitment.md)'s W-sections. Grounding the design in the
existing pin machinery changed two things this ADR's own Decisions section had assumed,
and both are stated here rather than discovered by an implementer:

**A. The proposal's pin set is round-scoped, not thread-scoped.** ADR-0010 Decision 1
makes a thread's task-bearing activities agree on their pin set byte for byte — one
thread, one rulebook, because a task thread produces one answer. A thread may carry *many
rounds*, and each round is its own question with its own admissible consequences, so
forcing a thread's proposals into that equality would be wrong. It would also collide
vocabularies: a task policy is keyed by `afp:category` values, a proposal policy by
outcomes. So proposals are pin-bearing for **resolution** and for ADR-0010 Decision 5's
disclosure duty, and are **not** part of `check_pins`'s thread-level agreement.

**B. ADR-0018's W6 actuation guard is superseded here, and it was wrong.** W6 said an
`afp:actsOn` resolving to an `afp:no-decision` record is a replay failure. That
contradicts ADR-0010 Decision 4's principle — *terminality always releases the actuator* —
which exists precisely so an application never parks forever. The corrected rule: a
`no-decision` record **is** actionable, but only through the policy's reserved
`afp:no-decision` key, exactly as a non-answer task releases through `afp:no-verdict`.
The rest of W6 stands: a `no-decision` record still ratifies no Synthesis and supersedes
nothing.

### W1. The governance actuation, on the wire

Today `afp:actsOn` resolves to a Synthesis, directly or through one hop from a
`DecisionRecord` that *ratifies* one (ADR-0010 Decision 3). Scenario 11's decision
ratifies nothing — it decided `"no"` — so a third resolution shape is admitted:

```jsonc
// The proposal pins the rulebook, before any vote exists.
{
  "type": "afp:Proposal",
  "afp:round": "https://hilltop.example/rounds/snow",
  "afp:options": ["yes", "no"],
  "afp:actionPolicy": {                      // NEW on a proposal
    "yes": "send-closure-message",
    "no": "send-open-message",
    "afp:no-decision": "send-undecided-message"
  },
  "afp:irrevocableActions": ["send-closure-message", "send-open-message"]
}

// The consequence, published by the notification desk.
{
  "type": "Create",
  "actor": "https://central.example/agents/notify",
  "afp:actsOn": "sha256:…",                  // digest of the DecisionRecord ACTIVITY
  "afp:action": "send-open-message",
  "object": { "type": "afp:Act", "content": "all three schools open as normal" }
}
```

**The category is the outcome.** For a governance actuation there is no Synthesis to carry
`afp:category`, and inventing one would be a second name for a fact the record already
states: `afp:action` MUST equal `policy[decision["afp:outcome"]]`. This is why the policy
is keyed by the round's own options — a policy that cannot say what to do if `"yes"` wins
is not a policy, and the writer refuses to pin one (W3).

### W2. Resolution — a third root, over edges that already exist

`action.py`'s `_governing_pins` has two roots today (the Award chain; the thread's
task-bearing activities). Governance actuation adds a third, tried when `afp:actsOn`
resolves to a `DecisionRecord` and no Synthesis is behind it:

```
action.afp:actsOn  →  DecisionRecord activity
                   →  decision["afp:round"]
                   →  the afp:Proposal with that afp:round
                   →  its pin set
```

Every edge is present and digest-bound already: `check_decision_record` resolves exactly
this proposal today via `find_proposal_for_round`, which ADR-0018's build factored out for
reuse. The root is tried **before** the thread fallback, so a governance action on a
thread that also carries tasks reads its own round's rulebook rather than the thread's.

### W3. Writer-side vocabulary and validation

```ts
// src/instance/src/ap/pins.ts
/** ADR-0019 W1: the reserved category releasing an actuator when a round did not decide. */
export const NO_DECISION_CATEGORY = "afp:no-decision";
/**
 * A proposal-pinned policy MUST name an admissible action for every option the
 * round offers AND for `afp:no-decision`. Refused at pin time, like
 * `validateActionPolicy`'s no-verdict rule — a round whose policy cannot answer
 * one of its own outcomes leaves the actuator parked on exactly the morning it
 * mattered.
 */
export function validateProposalActionPolicy(policy: ActionPolicy, options: readonly string[]): void;

// src/instance/src/allocation/actions.ts
/**
 * The two fields binding a consequence to a decision. `outcome` is the
 * category — the DecisionRecord's own afp:outcome — so a writer cannot claim an
 * action its own round never admitted.
 */
export function decisionActionStamp(
  action: string,
  decisionDigest: string,
  policyCheck?: { policy: ActionPolicy; outcome: string },
): { [key: string]: JsonValue };

// src/instance/src/hub/activities.ts
export type HubRole = "member" | "requester" | "observer" | "actuator";   // ADR-0019 Decision 2
export interface ProposalSpec { /* …existing… */ pins?: TaskPins; }        // actionPolicy + irrevocableActions only

// src/instance/src/hub/hub.ts
proposeRound(options: { /* …existing… */ pins?: TaskPins }): OutboxEntry;
```

`proposeRound` validates before it signs: `validateProposalActionPolicy(policy, options)`,
then ADR-0011's existing `validateIrrevocableActions(policy, names)` unchanged. A proposal
MUST NOT carry `afp:answerSufficiency` or `afp:synthesizer` — neither means anything for a
round — and the writer throws rather than emitting them.

### W4. The `actuator` role — what it changes, and what it already gets right

The role is mostly *declarative*, which is the argument for adding it rather than against:
every enforcement point in the codebase already tests `=== "member"`, so an actuator is
excluded from all of them the moment the value exists.

| Site | Today's test | Actuator's result |
|---|---|---|
| `proposeRound` voter pinning | `roleOf(a) === "member"` | never pinned — cannot vote, cannot appear in a snapshot |
| bid admission (`allocator`) | `!== "member"` → reject | cannot bid |
| asset registration | `!== "member"` → reject | cannot register assets |
| `broadcastTargets` | `!== "requester"` | **receives** proposals and decisions — it must, to act on them |
| the write door (`admits`) | `roleOf(a) !== null` | admitted, like any enrollee |
| the read gate's `hub` predicate | any role in the hub | reads at `hub` visibility |

So the code change is one union member plus one new restriction that has no existing
analogue — **an actuator may publish only `afp:actsOn`-bearing activities on a hub thread**
(V4 below). Enforcing that on the writer would be enforcement that leaves no trace
(ADR-0003 Decision 6's rule); it is a replay check, on the record, like the estimator wall.

### W5. Verifier checks

| # | Check name | Fails when |
|---|---|---|
| V1 | `action: {id} acts on a producible justification` (existing, widened) | `afp:actsOn` resolves to neither a Synthesis nor a `DecisionRecord` |
| V2 | `action: {id} action is admissible under the round's pinned policy` | the decision's round pins a policy and `afp:action != policy[outcome]` |
| V3 | `action: {id} actor is enrolled in the deciding hub` | the actor holds no `member`/`actuator` role in that hub **at the action's `published`** |
| V4 | `roles: {agent} actuator publishes only actuation activities` | an `actuator`-role agent authored a hub-visibility activity carrying no `afp:actsOn` |
| V5 | `pins: {round} proposal policy names an action for every outcome` | a proposal-pinned policy omits an option or `afp:no-decision` |
| V6 | ADR-0010 Decision 5, widened | a thread carrying an `afp:actsOn` activity and **no** task-bearing activity *and no proposal* — the carrier set gains proposals, or every governance thread fails a check meant for redaction |

V3 needs role-**at-an-instant**, which `enrolled_roles` does not provide (it is current-state
LWW over the whole trail). Add `enrolled_roles_at(hub_actor, activities, at_millis)` in
`decision.py` — the same fold, stopped at `at_millis` — and leave `enrolled_roles` as its
zero-argument-equivalent caller, so no existing check shifts.

V6 is the one that would otherwise bite silently: `check_disclosed_answers_keep_their_pins`
fails any thread that discloses an answer with no task-bearing activity, and scenario 11's
thread has a proposal, a decision and an action — no task at all. Without widening the
carrier set, every correct governance bundle fails a redaction check.

### W6. Work packages

| WP | Owns | Content |
|---|---|---|
| **WP-1 · vocabulary** | `src/instance/src/ap/pins.ts`, `src/instance/src/allocation/actions.ts`, `src/instance/src/hub/activities.ts` | W3's constants, validator, `decisionActionStamp`, the `actuator` union member, `ProposalSpec.pins` |
| **WP-2 · hub** | `src/instance/src/hub/hub.ts` | `proposeRound` pin acceptance + validation + refusal of task-only pins |
| **WP-3 · verifier** | `src/verifier/action.py`, `src/verifier/pins.py`, `src/verifier/decision.py` | W2's third root, V1–V6, `enrolled_roles_at`, and ADR-0018's W6 correction (a `no-decision` record is actionable through the reserved key) |
| **WP-4 · gate + spec** | `src/instance/test/adr0019.test.ts`, `docs/afp/02-hubs-and-state.md`, `docs/afp/adr/0018-…md` (W6 correction note) | W7's matrix, the role vocabulary in 02, the ADR-0018 amendment |

WP-1 and WP-3 are disjoint and go first; WP-2 against W3's fixed signatures; WP-4 last.

### W7. Gate matrix — `test/adr0019.test.ts`

| # | Case | Asserts |
|---|---|---|
| G1 | A round pins a policy over its options; the decided outcome's action is published by an `actuator` | replays clean; V1–V3 named in the output |
| G2 | Mutation: `afp:action` rewritten to the other option's action | fails **V2** |
| G3 | Mutation: the acting activity's actor swapped for a rostered agent enrolled in no hub | fails **V3** |
| G4 | An `actuator` publishes an ordinary `Create{afp:Result}` on a hub thread | fails **V4** |
| G5 | `proposeRound` with a policy missing one option, and one missing `afp:no-decision` | both throw at propose time (writer refuses); a mutated bundle fails **V5** |
| G6 | The `afp:no-decision` outcome from ADR-0018 G2, acted on through the reserved key | replays clean — the ADR-0018 W6 correction, demonstrated rather than asserted |
| G7 | An actuator's actor document and enrollment, with the round proposing | the actuator is never in `afp:voters`, and the ADR-0018 check "pinned voters are member-role agents" still passes |
| G8 | A governance thread with a proposal, a decision and an action, no task at all | ADR-0010 Decision 5's check passes (V6's widening) |
| G9 | Compatibility: every P1/P2/P3/P5 bundle and the ADR-0006/0010/0011 gates | unchanged check counts; no new check fires on a task-flow actuation |

## Build status

**Built** (2026-08-22) — all three decisions plus ADR-0018's amended actuation clause,
gated by `test/adr0019.test.ts` (9 cases, W7's matrix), whole suite green at 182, and
every shipped bundle replaying at unchanged check counts (P1 78, P2 652, P3 452, P5 393).

**A third correction came from bringing the P5 demo in sync**, and it is the one no unit
gate could have found: `check_actions` resolved `afp:actsOn` from the bundle's **own
outbox** only. Until this ADR an action and its Synthesis were always authored inside one
trust domain, so it never mattered. A governance actuation breaks that — the
`DecisionRecord` is written by a hub on one operator's server and acted on by an agent
enrolled from another — so for the actor's own bundle the justification is *received
bytes* or it is nowhere. Fixed to resolve from the thread pool, the same grain
`check_decision_record` already uses for counted votes (ADR-0015 N2). The proposal lookup
and the Enroll-trail role lookup inside the decision-actuation checks had the same defect
and the same fix. Single-instance gates all passed throughout; only a real three-operator
export exposed it.

Two things the build corrected in this ADR's own architecture, both found at integration:

1. **W2 under-specified which `DecisionRecord`s are governance justifications.** "Resolves
   to a DecisionRecord" admitted too much, and it broke ADR-0010's "two hops never
   resolve" case: a ratification round proposes `options: [<the id being ratified>,
   "reject"]`, so its outcome *is* one of its options, and an outcome-in-options test
   cannot tell a ratification from a decision. The discriminator is the **pinned
   `afp:actionPolicy`** — a proposer declaring that this question's outcomes have
   consequences — with outcome-in-options as the secondary condition. A ratification round
   pins none and keeps taking the Synthesis hop unchanged, which is what preserved
   ADR-0010's case 7 exactly.
2. **V1's rename is an observable interface change.** Widening the existing check meant
   renaming `action: … acts on a producible Synthesis` to `… a producible justification`,
   which is right — a name that says Synthesis while also admitting DecisionRecords is a
   name that lies — but three shipped gates (ADR-0006, ADR-0010, the ADR-0010 parity
   fixture list) assert on the old string and had to be updated. Recorded because the
   verifier's check names are effectively public: anything downstream matching on that
   phrase needs the same edit.

The seam with ADR-0018 closed in the direction that ADR did not expect, and G6 is the
case that proves it: a round that failed to decide still releases its actuator, through
the policy's reserved `afp:no-decision` key. ADR-0018's W6 clause is amended in place
with the reasoning kept, because "a guard that reads as prudence can be the parked
application wearing a safety hat" is the reusable lesson.

Not built, deliberately: **dispositions over governance actions.** ADR-0007's
`afp:disposes` and ADR-0011's `annotate` are specified over a superseded *Synthesis*; a
superseded *decision* has no supersession mechanism yet (scenario 11 finding 57's
`afp:Departure` records refusal, not retraction). Out of scope here, and a real gap the
next campaign should look at.

## References

- [Scenario 11 — The snow day](../scenarios/11-the-snow-day.md), findings 53, 54, 55
- [ADR-0004](0004-solo-foundation-hardening.md) Decision 1 (the role table)
- [ADR-0006](0006-checkable-actuation.md) (the actuation apparatus)
- [ADR-0010](0010-pinning-without-an-auction.md) Decisions 1 and 3 (the pin site and the hop)
- [ADR-0011](0011-supersession-meets-the-irreversible-world.md) (`afp:irrevocableActions`)
