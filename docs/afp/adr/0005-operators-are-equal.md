# ADR-0005 — Operators are equal against a hub

- **Status:** Accepted — not yet built (see [Build status](#build-status))
- **Date:** 2026-08-20
- **Applies to:** L0 deliberation from P2 onward, and the federation handshake it precedes
  ([P4](../05-roadmap.md#p2p7))
- **Builds on:** [ADR-0002](0002-p2-hub-and-crdt-stack.md) (the hub, its CRDT state, and
  liveness-gated uniform weights), [ADR-0004](0004-solo-foundation-hardening.md) (roles on
  the Enroll trail) — both inherited, one of them generalized
- **Driven by:** [ADR-0004 H14](0004-solo-foundation-hardening.md#build-status) and its
  revisit trigger "whether foreign-instance agents enroll with non-member roles by
  default"

## Context

Two questions turned out to be one.

**Who may enroll an agent?** The hub's membership — and, since ADR-0004, every agent's
*role* — is replayed from the `afp:Enroll` trail, and a replay admits any validly signed
`afp:Enroll` targeting the hub without asking whether its **actor** was entitled to issue
one. Signature verification does not close this: `check_authority` establishes that a
signing key may speak for its activity's actor, never that the actor may enroll anyone.
So a rostered agent can publish `Enroll{object: self, afp:role: member}` and appear, to
both implementations equally, as a member the hub admitted.

**What is a vote worth?** ADR-0002 Decision 3 gave every live voter a uniform weight of
1, which at one operator is simply "one agent, one vote." Across operators it becomes
"one *agent*, one vote" in the load-bearing sense: an instance's say scales with how many
agents it runs. Spinning up a hundred agents is cheap, requires no reasoning, and buys a
hundred votes.

The first question only looked urgent because of the second. Guarding *who becomes a
member* is a way of rationing votes — necessary only while votes are minted per agent.
Fix the weighting and the enrollment rules stop carrying governance weight; they go back
to being what 02 always described them as, hygiene about who speaks for whom.

Two things already in the spec point the same way, and both are *stated but unenforced*:

1. **The seat is the instance's.** 02's level 1 — `Follow`/`Accept` — "establishes the
   instance's seat in hub governance (**voting eligibility**, visibility)." Voting
   eligibility was located at the instance from the start; the per-agent tally drifted
   from it.
2. **The instance issues the Enroll.** 02's level 2 — "the instance issues a signed
   `afp:Enroll` per agent." The issuer is named in the design. Nothing checks it.

## Decisions

### 1. One operator, one weight — the tally counts instances, not agents

Every live `member`-role agent still votes. What changes is the arithmetic: **each
seated instance contributes the same total weight**, divided among whichever of its
agents are pinned into the round.

Weights cannot be fractional. The AFP JCS numeric profile forbids non-integer numbers,
and `afp:voterWeights` is pinned inside the signed proposal — `1/3` is not merely
awkward, it is unrepresentable in a signed AFP document. So the division uses a common
denominator: with `n_I` the count of instance `I`'s pinned voters and `L` the least
common multiple of every `n_I` in the round, each of `I`'s voters carries `L / n_I`.
Every instance sums to exactly `L`, and every weight is an integer.

| Instance | pinned voters | weight each | instance total |
|---|---|---|---|
| Alpha | 3 | 2 | 6 |
| Beta | 2 | 3 | 6 |
| Gamma | 1 | 6 | 6 |

`L` is a pure function of a sorted integer list, so both implementations reach it
identically — no rationals in the record, no float anywhere near a tally.

**This generalizes ADR-0002 Decision 3 rather than replacing it.** With one instance,
`L = n` and every voter carries `L / n = 1` — exactly today's uniform weight. Every
existing P2/P3 export recomputes unchanged, and the solo profile sees no difference at
all. The rule only becomes visible when a second operator is present, which is the only
situation it exists for.

**The weights are recomputed, not trusted.** A verifier rebuilds `afp:voterWeights` from
the pinned voter list and the roster and compares; a mismatch is a named failure. A hub
that writes its own numbers into a proposal is caught the same way a hub that mistallies
is caught — the discipline every recomputable field in this record already carries.

Quorum stays what 02 says it is, a weight-sum threshold; expressed over these weights it
reads naturally in instances (a majority of seated instances is `> (k/2)·L` for `k`
seated). Liveness gating is unchanged: an instance with no live pinned voter contributes
nothing, because it is not in the snapshot.

### 2. An Enroll is issued by the enrolled agent's own instance, and by nobody else

The `actor` of an `afp:Enroll` MUST be the instance whose signed roster vouches the agent
in `object`. An agent enrolling itself is refused; an instance enrolling another
operator's agent is refused. Enforced at hub admission and mirrored as a named verifier
failure.

This is checkable from data a replay already loads — the roster binds agent → instance,
and `build_authority` reads it before any activity is walked — and it is **retroactively
satisfied**: the instance is the only thing that has ever called the builder, so every
existing export passes unchanged.

It is also what makes Decision 1 computable. Per-instance weighting needs agent → instance
resolvable *from the record*, and once the Enroll's actor is guaranteed to be the agent's
instance, the Enroll trail carries that mapping already. The issuer rule is not merely
hygiene; it is the evidence the weighting rests on.

### 3. The instance's seat is published, not assumed — enforced from P4

An `afp:Enroll` into hub H is admissible only where H has published an `Accept{Follow}`
seating that instance, resolvable in the export. This is 02's level 1, made evidence.

**Specified now, enforced from P4.** At solo scale the check is vacuous — one instance,
one hub, one operator — and demanding it retroactively would invalidate every P2/P3
export to prove something nobody doubts. It becomes load-bearing the moment a second
operator can address the hub, and it is what Decision 1 counts: `k` seated instances
means `k` published seats, not `k` instances that happen to have agents in the snapshot.

### 4. All three roles are instance-granted; vote-weight reputation stays deferred

An instance grants `member`, `requester` and `observer` to its own agents on its own
signature, at every phase. With Decision 1 in place there is nothing to ration: an
operator's hundredth agent adds no governance power, so routing membership through a
quorum round would buy nothing and would make onboarding hostage to hub liveness.

And **vote weight stays flat per operator — no reputation term.** ADR-0004's reasoning
carries forward unchanged (nothing consumes it, and specifying policy ahead of evidence
is how the pre-v3.6 roadmap rotted), with two further reasons that apply to votes and
not to selection odds:

- `divergence-decay` measures **estimate accuracy**, which is not judgement. An operator
  reliably good at costing work is not thereby a better judge of policy, and a score
  built for one question should not quietly answer another.
- Weighting governance by past standing **entrenches**: early winners weigh more, which
  makes them likelier to keep winning, and it raises the payoff for gaming the reputation
  inputs from "better selection odds" to "control of outcomes."

Quality of reasoning is already surfaced where it does not concentrate power: `afp:dissent`
is first-class in a Synthesis, and `afp:dissentVindicated` raises standing when a minority
objection proves correct (04). Those record good judgement without converting it into
votes.

## Options considered

| Option | Rejected because |
|---|---|
| Keep per-agent uniform weight | An operator's say scales with headcount — the cheapest possible attack on a consortium, requiring no reasoning and no reputation, and invisible in the record as anything but enthusiastic participation |
| Ration votes by gating who becomes a `member` (quorum-conferred membership) | Treats the symptom. It leaves headcount→power intact and merely licenses it, costs a governance round per voting agent, couples onboarding to hub liveness, and has no answer at `t=0` when a fresh hub has no members to convene |
| One designated voting agent per instance | Achieves equality by discarding participation: the hub hears one voice per operator instead of several, losing exactly the diversity of reasoning a deliberation is for |
| Fractional weights (`1/n` per voter) | Unrepresentable — the JCS numeric profile forbids non-integer numbers in a signed document, and `afp:voterWeights` is signed |
| Weight votes by hub-scoped reputation now | No consumer has fired; accuracy is not judgement; and it entrenches early winners while making reputation-gaming worth far more than it is under ADR-0004's selection-odds-only scope |
| The hub key admits members | Contradicts 02's standing rule that the hub key signs only transport-level things — it would hand the server operator the unilateral power 02 exists to deny |
| An enrollment capability token issued by the hub | A bearer credential is state outside the record; the roster already binds agent to instance, and a rule over evidence beats a rule over secrets |
| Defer all of it to P4 | Decision 2 is free today and retroactively satisfied; deferring it means migrating a membership CRDT two operators already share — the exact trap ADR-0004 was written to avoid |

## Consequences

**Positive**

- The cheapest attack on a federated hub — mint agents, own the vote — stops paying,
  and stops needing to be policed. Equality is a property of the arithmetic rather than a
  rule someone must enforce at admission.
- Enrollment goes back to being about *who speaks for whom*: self-promotion is no longer
  replayable-as-legitimate, and the fix costs a comparison against a roster the verifier
  already loads.
- 02's two-level enrollment becomes checkable rather than aspirational, and its "the
  instance's seat" framing finally matches how a vote is counted.
- P4 inherits a settled answer to what a foreign operator's arrival means: a seat, one
  seat's worth of weight, and whatever roles it grants its own agents.

**Negative / accepted risks**

- `L` grows with the least common multiple of per-instance voter counts — coprime counts
  (7, 11, 13) give `L = 1001`. Accepted at consortium scale, where the value stays small
  and integer arithmetic is exact regardless; a revisit trigger covers it if it is ever
  felt.
- Within one operator, an agent's individual weight now depends on how many of its
  siblings are live in the round. Accepted: the alternative is letting that same count
  change the operator's total say, which is the thing being fixed.
- A consequence of that: **agent-level sanctions no longer reduce an operator's weight.**
  Zeroing an equivocator's vote (10) removes that agent from the division, and its
  siblings absorb the share — the operator's total stays one seat's worth. Accepted, and
  arguably the honest reading: scenario 03's drill already held that the instance-level
  consequence is *not* automatic, and that forced or voluntary action against the
  *operator* is the real lever. Per-instance weight makes that separation exact rather
  than incidental.
- Decision 3 adds an obligation instances must satisfy before P4 — publishing a seat they
  currently hold implicitly. Accepted, and cheaper now than as a retrofit.
- A hub cannot distinguish a thoughtful operator from a careless one by weight alone.
  Accepted deliberately: that discrimination is what dissent, settlement and standing are
  for, and putting it in the tally is a different ADR with a much heavier burden of proof.

**Revisit triggers**

| Trigger | Reconsider |
|---|---|
| A hub policy genuinely needs to weight operators unequally | Vote-weight reputation, with the pinning discipline ADR-0004 used for selection odds — and an explicit answer to entrenchment |
| `L` grows large enough to be felt in a proposal | A fixed scale factor with a stated rounding rule, or per-instance tallying that never divides at all |
| P4 federation handshake design | Whether `Accept{Follow}` is the right seat evidence, or `afp:FederationAgreement` subsumes it |
| One operator runs agents on behalf of several real parties | Whether the instance is still the right unit of equality, or the seat needs to name a party |

## Build status

Nothing here is built. The decisions are recorded so P4 does not have to discover them
during handshake design, and because Decision 2 is free to land now.

| ID | Task | Where |
|---|---|---|
| **E1** | Per-instance weighting in `proposeRound`, with `L` from the pinned voters' instances | `hub/hub.ts` |
| **E2** | Verifier recomputes `afp:voterWeights` from the pinned voters and the roster; a mismatch is a named failure | `decision.py` |
| **E3** | Enroll issuer must be the agent's own instance — hub admission and a mirrored verifier check | `hub/hub.ts`, `decision.py` |
| **E4** | Seat evidence (`Accept{Follow}`) required for enrollment, gated to P4 | with the P4 handshake |
| **E5** | Parity cases for `L` and the per-instance division, in the raw-JSON harness ADR-0004 established | `test/parity/cases.json` |

## References

- [02 — Enrollment is two-level](../02-hubs-and-state.md#enrollment-is-two-level-deliberately) ·
  [02 — Governance concentration, kept accountable](../02-hubs-and-state.md#governance-concentration-kept-accountable) ·
  [02 — Membership & dynamic quorum](../02-hubs-and-state.md#membership--dynamic-quorum)
- [ADR-0002](0002-p2-hub-and-crdt-stack.md) Decision 3 — liveness-gated uniform weights,
  generalized here
- [ADR-0004](0004-solo-foundation-hardening.md) — Decision 1 (roles), Decision 3's
  deferral of vote-weight reputation, and H14
