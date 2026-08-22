# Scenario 11 — The snow day: three parties, one decision, and a clock nobody controls

> Spec-test scenario. Exercises the axis every scenario so far has avoided: a hub whose
> job is not to *pool information* but to **bind action**. Three parties must reach one
> indivisible decision — all of them or none — before a deadline the world imposes rather
> than the hub; the evidence that decides it is held by the party that loses the vote and
> cannot be checked by anyone else; the only party able to carry the decision out is the
> one with no vote; and the next morning reveals whether the decision was right, with
> nowhere to record that. The first scenario with a **running counterpart** —
> `npm run demo:p5:llm` in the reference instance — so the numbers in the verdict below
> are copied from an actual run rather than imagined. Verdict at the end.
>
> Deliberately *not* re-testing [scenario 10](10-the-incident-bridge.md)'s ground: hosting,
> membership proof, partition and the case file at N parties are settled (ADR-0014,
> ADR-0015) and appear here only as a regression check.

| **Support status** | **Supported — all 8 findings closed** (2026-08-22) |
|---|---|
| Resolved by | [ADR-0018](../adr/0018-the-round-as-a-commitment.md) (50, 51, 52, 56, 57) · [ADR-0019](../adr/0019-acting-on-a-decision.md) (53, 54, 55) |
| See it run | `npm run demo:p5:llm` — this scenario, end to end, with real models deciding |
| Gated by | `test/adr0018.test.ts` (15 cases) · `test/adr0019.test.ts` (9 cases) |

**Read the walkthrough below as history.** It records what strained when this workload was
first walked, and it is deliberately left as written — that is what a scenario is for. Every
strain it names is now built: the round pins its bar and its deadline before a vote exists,
a round that misses the bar closes `afp:no-decision` instead of declaring a winner it did
not earn, the seat that sends the 06:00 message is an `actuator` that may publish nothing
else, and a member bound by a decision it voted against records an `afp:Departure`. Running
the demo shows the resolved world; beats 3, 5 and 6 are where the two diverge most, and
comparing them is the point.

## User story

**As** the head teacher of one of three schools that share a single bus company — where I
can see my own car park, my own roads and my own staff, and none of my neighbours' —
**I want** the three of us to reach one recorded decision before the message to parents
goes out at 06:00,
**so that** when a governor asks in March why the schools stayed open on the morning
Riverside's heating failed, the answer is a record anyone can recount rather than three
head teachers remembering a phone call differently.

## Cast

Three schools, one standing hub, `bus-bridge`. As in scenario 10 **the hub is hosted by
one of the parties** — that question is settled (ADR-0014); this scenario is about what
gets decided on it.

| Instance | Agents in play | Role in the hub |
|---|---|---|
| `hilltop.schools.example` (**Hilltop**) — **hosts the hub** | `head` (member), `caretaker` (member) | member + host |
| `riverside.schools.example` (**Riverside**) | `head` (member) | member |
| `central.schools.example` (**Central**) | `head` (member), `notify` (observer) | member |

`notify` is the district's parent-notification desk. It reads everything at `hub`
visibility because it writes the message that goes to every family, and it holds no vote.
`caretaker` holds a seat because the caretaker is the person who knows whether the yard is
passable — and on this particular morning he is outside gritting it, and never answers.

**The decision is indivisible.** The three schools share one bus fleet running one
timetable: if Riverside closes, its nine buses stop, and the drivers freed up cannot be
re-timetabled onto Hilltop's routes before morning. There is no per-school outcome. This
is the structural difference from every prior scenario — in [10](10-the-incident-bridge.md)
each operator filtered its own network, and a shared conclusion was a convenience. Here the
conclusion **is** the deliverable, and it binds parties who disagree with it.

## Walkthrough

**1. A standing hub, and a question with a deadline attached.** At 05:30 Hilltop's `head`
opens `urn:afp:thread:snow-2026-02-11` and proposes a round on `bus-bridge`: *close all
three schools today?*, options `yes` / `no`. Snapshot pinning works exactly as specified —
the four `member`-role agents are pinned into `afp:voters`, `notify` cannot be and is not
(ADR-0004), and the weights are pinned into the proposal so the tally never depends on live
state.

What the proposal cannot carry is the only fact that governs the morning: **the answer is
worthless after 06:00.** `afp:Proposal` pins round, options, snapshot, voters and weights.
There is no deadline, no voting window, and no statement of what happens if the round is
still open when the buses leave the depot (**finding 50**). The spec is not silent so much
as of two minds: 03's round sequence diagram carries an `else timeout without quorum` branch
whose content is *"Undo{Vote} / abandon round"*, and the prose four lines below it reads
**"Every round — either level — closes with an `afp:DecisionRecord`"**. Under a real
deadline those are different mornings. One leaves a signed record that a decision was due
and not reached; the other leaves nothing, which is indistinguishable from nobody having
asked.

**2. Three views, and no way to check any of them.** Each `head` posts what it can see at
`hub` visibility: Hilltop's street ploughed at 05:05, four staff stuck in their villages;
Central's main road wet and clear, six staff already on the way; Riverside's only road
blocked by a fallen tree, 210 of 400 pupils behind it, the building at 12°C with about four
hours of oil left.

Nobody can verify anybody. There is no shared sensor, no third party, and no time. This
turns out to be **held**, and precisely: 04's replay procedure states its own boundary —
replay recomputes signatures, chains, digests, tallies and rules, and never a `Result`'s
`content` (finding 42). The record proves Riverside *said* four hours of oil, signed, at
05:34, before the vote rather than after it. That is the honest claim, it is the one the
governors will need in March, and the protocol makes exactly it and no more.

**3. The vote, and an arithmetic nobody declared.** Three heads vote; the caretaker is in
the yard. From an actual run of the demo:

```
  Hilltop  head       NO   "Our grounds are cleared and staff can travel…"
  Riverside head      YES  "The valley road is blocked, heating is failing…"
  Central  head       NO   "Roads are clear, staff are arriving, and closing would
                            unnecessarily cost parents work…"

  no       ███ 3      yes ██ 2      abstain █ 1
  outcome: no
```

Two things in those six lines are not in any specification.

The first is the split. ADR-0005 Decision 1 gives every seated instance the same total and
divides it among its pinned voters — `lcm(2,1,1) = 2`, so Hilltop's two agents carry 1 each
while Riverside's and Central's single agents carry 2. The per-operator total is preserved
exactly as designed. What is not designed is the consequence: **Hilltop's head teacher votes
at half the strength of Riverside's, because Hilltop also seats a caretaker who is outside**
(**finding 52**). The weight is not redistributed and not withheld; it lands in `abstain`.
ADR-0014's `afp:uncounted` records that the caretaker was `silent` — which is the fix
scenario 10 asked for, working — but silence and *what silence cost his own school* are
different facts, and only the first is on the record. Liveness gating is the nearest
mechanism and does not reach: the caretaker's instance is up, he is simply outdoors.

The second is the threshold. 02 states flatly that *"Quorum is a weight-sum threshold"* and
gives two minimums to compute it with; ADR-0005 restates it in instances. Yet no threshold
is pinned in the proposal, `closeRound` takes the highest tally, and the verifier recomputes
the tally without ever asking what it had to clear. The outcome above carries **3 of 6** —
a plurality at exactly half the electorate — and the `DecisionRecord` asserts it as *the*
outcome with nothing recording what it needed to beat (**finding 51**). This is finding 43's
shape one layer up: a threshold that exists everywhere in the prose and nowhere in the
record.

**4. The outcome binds the party that voted against it.** The schools stay open. Riverside
must open a building at 12°C, on a road its pupils cannot use, because two schools that
cannot see its road outvoted it.

Nothing in the record says so. A `DecisionRecord` records an outcome and obliges nobody;
across 02, 03, 04 and the ADRs there is no notion of a decision that *binds*, and no way to
record that a member acted contrary to one it was pinned into (**finding 57**). That silence
was harmless while outcomes were divisible — scenario 10's operators each filtered their own
network, and a dissenter simply did its own thing. Here defection is the interesting event:
if Riverside sends its own families home at 07:00, the record shows a decision, and separately
shows nothing at all.

**5. The message goes out at 06:00, and the desk that sends it may not speak.** The
notification desk reads the `DecisionRecord`, writes *"all three schools open as normal"*,
and sends it to nine hundred families. It cannot be recalled at 06:40.

ADR-0006 requires exactly this consequence to be recorded — an activity carrying `afp:actsOn`
(the digest of what justified it, resolved one hop through a `DecisionRecord` under
ADR-0010's finding 35) and `afp:action`. The desk cannot publish it. ADR-0004's role table
has five columns — announce, bid, vote, publish Results, read — and an `observer` is `no` on
every one but the last (**finding 54**). The vocabulary has no **actuator**: a party whose
whole function is to carry out a decision it must not influence. The deployment's choice is
to give the desk a vote it should not have, or to let the most irreversible act in the
scenario go unrecorded.

Reaching for the other end of the same gap: nothing says who *may* act. ADR-0006's replay
checks that the digest resolves, that the category is in the closed set, and that the action
is admissible under the pinned policy — never who the actor was (**finding 55**). A rostered
agent with no relation to this round emits a well-formed action on this `DecisionRecord` and
passes replay unremarked.

**6. And there is no policy to be admissible under.** Follow the pins. ADR-0010 Decision 1
put `afp:actionPolicy`, `afp:answerSufficiency` and `afp:synthesizer` on **the task-bearing
activity — an `Announce{Task}` or a direct `Offer{afp:Task}`**. This morning has neither.
The decision was reached by a governance round, opened with `Offer{afp:Proposal}`, which is
not a task-bearing activity and carries no pin set (**finding 53**).

So `afp:action` has no policy to be checked against, and `afp:irrevocableActions` —
ADR-0011's declaration that makes the `annotate` disposition legitimate rather than a waiver
— has nowhere to be declared. This is finding 34 exactly, one flow over: ADR-0010 extended
pinning from the Announce to the direct `Offer{Task}` because the degenerate flow silently
lost the machinery, and stopped one activity type short. The most consequential and least
reversible act in this scenario is the one the actuation machinery cannot govern.

**7. The morning after.** By 09:00 the valley road is still shut, Riverside's oil ran out at
08:40, and 210 children never arrived. The decision was wrong, and the dissenter was right.

There is no way to record that. `afp:Settlement` references *"the original estimate(s) or
Synthesis"*, **follows an award**, and is published **once per task** — a governance
`DecisionRecord` is none of those things (**finding 56**). The consequence is sharper than a
missing feature, because 04 states the reason this matters in its own words: settlement
SHOULD raise a correct dissenter's standing, since *"a swarm that penalizes accurate minority
objections will stop producing them"*. The one mechanism that credits accurate dissent is
unreachable from the one place where dissent is most expensive to voice — the party bearing
the whole downside, arguing against parties who cannot see its evidence.

**8. Regression check: the host loses power.** At 06:05 Hilltop's server goes down. Scenario
10's ground, and it holds: a vote sent to the dead hub fails to its caller rather than
vanishing (ADR-0014 Decision 2), and a question Riverside had already put directly to
Central — *why did we disagree?* — is answered anyway, because the hub was never on the
payload path. In the demo both are observable, the second complete with the answer on the
record and `afp:producedBy` naming the model that wrote it.

**9. What the case file proves.** Three exports, one command, ADR-0015's all-pairs join and
per-domain census. The bundle replays clean: every signature, every chain, every digest, and
the tally recomputed from `afp:countedVotes` alone. In March the governors can establish who
said what, when, and what was decided — and, exactly as beat 2 promised, not whether
Riverside really had four hours of oil.

## Acceptance criteria → mechanisms

| Criterion | Spec mechanism |
|---|---|
| One recorded decision, not three recollections of a phone call | Shared `afp:Hub`, L0 round, `Create{afp:DecisionRecord}` |
| A party with no vote cannot influence the outcome | `afp:role` observer, never pinned into `afp:quorumSnapshot` (ADR-0004) |
| Weight does not follow headcount | One operator, one weight (ADR-0005 Decision 1) — total preserved |
| Absence is distinguishable from refusal | `afp:uncounted`, `silent` vs `declined` (ADR-0014 Decision 4) |
| Nobody has to take another school's word for the outcome | Tally recomputed from `afp:countedVotes`; the hub never sees a reason |
| Unverifiable local claims are recorded as claims | Replay guarantee's stated boundary (04, finding 42) |
| The decision survives the host dying | ADR-0014 Decision 2; payload path is member-to-member |
| The decision is reached before the buses leave | **Strains** — finding 50 |
| The outcome cleared a stated bar | **Strains** — finding 51 |
| Seating an extra agent does not weaken your school | **Strains** — finding 52 |
| The consequence is recorded and governed | **Strains** — findings 53, 54, 55 |
| Being right, as the outvoted minority, counts for something | **Strains** — finding 56 |
| A party bound by a decision it opposed is visibly bound | **Strains** — finding 57 |

## Spec verdict

**Held: everything about establishing what was decided.** Snapshot pinning, per-operator
weighting, role-scoped voting, `afp:uncounted`, the recomputable tally, the replay
guarantee's honest boundary, and — freshly, from campaign 7 — the host's death being a
visible failure rather than a silence. A stranger with three folders can reconstruct the
decision exactly. Campaigns 1–7 built that, and this scenario did not dent it.

**Strained: everything about the decision being *acted on*.** The record is excellent at
proving what a group concluded and has almost nothing to say about the group being bound by
it, the clock it was bound by, the bar it had to clear, who carried it out, or whether it
turned out to be right. Six of the eight findings below are one sentence wearing different
clothes: **the machinery treats a decision as the end of the story, and for a decision that
binds parties jointly it is the beginning.**

Note the pattern with campaign 6's through-line. There, the machinery had anchored itself to
the Announce/Award pair and the degenerate direct flow lost all of it. Here it is the same
anchor failing one flow further out: **the governance round has no task-bearing activity at
all**, so it inherits none of the pinning, sufficiency, policy or irrevocability apparatus —
and unlike the direct flow, nobody has noticed, because until this scenario every recorded
decision was about work rather than about the world.

**Strained — eight findings:**

50. **A round has no clock, and the deadline that matters is not the hub's.** `afp:Proposal`
    pins no deadline or voting window, and the spec gives two incompatible answers for a
    round that does not converge in time: 03's sequence diagram abandons it
    (`Undo{Vote} / abandon round`), while the prose immediately below states that every
    round closes with an `afp:DecisionRecord`. Candidate: pin an optional deadline in the
    proposal, and rule the contradiction in favour of the prose — a round that expires
    closes with a `DecisionRecord` carrying a non-answer outcome, so "we were asked and did
    not manage to answer" is a recorded fact rather than an absence. The shape already
    exists: ADR-0010's `afp:no-verdict` release does exactly this for a partial panel.

51. **The quorum threshold is specified everywhere and pinned nowhere.** 02 defines quorum
    as a weight-sum threshold with two named minimums; the proposal carries no threshold,
    `closeRound` returns the largest tally, and replay recomputes the tally without checking
    it against anything. The demo closes a decision on 3 of 6 weight and the record cannot
    say whether that was enough. Candidate: pin `afp:quorumRule` (or a plain threshold)
    beside the weights it is computed over — recomputable at replay exactly as the weights
    already are — and make failing to clear it a defined outcome rather than an
    unrepresentable one.

52. **A silent seat spends its own operator's weight.** ADR-0005 preserves the per-operator
    total and divides it among pinned voters, so an operator that seats an agent which never
    votes halves the voice of the agent that does. ADR-0014's `afp:uncounted` names the
    silence and not its price; liveness gating does not reach an agent that is reachable and
    simply not voting. Candidate: at minimum state the deployment consequence plainly in 02
    (seating a non-voting agent dilutes your own vote — the cure is not to seat it); better,
    let a snapshot exclude by declared participation, so a hub can seat a caretaker for his
    reads without spending a school's vote on his silence.

53. **`Offer{afp:Proposal}` is not a task-bearing activity, so a decision reached by a round
    alone can pin nothing.** ADR-0010 Decision 1 put the pin set on the Announce or the
    direct `Offer{Task}`; a governance round has neither, and therefore has no
    `afp:actionPolicy` for its consequences to be admissible under and no
    `afp:irrevocableActions` for ADR-0011's `annotate` disposition to rest on. Candidate:
    extend ADR-0010's fallback one activity further — a proposal MAY carry the pin set,
    with the same whole-object equality rule — closing the flow that campaign 6's
    through-line predicted and did not check.

54. **The role vocabulary has no actuator.** ADR-0004's five columns are announce, bid,
    vote, publish, read. A party whose function is to *carry out* a decision it must not
    influence has no seat: `observer` is read-only, and `member` hands it a vote the
    deployment is deliberately withholding. ADR-0006 requires the consequence to be recorded
    as an activity, so today the choice is an unrecorded action or a corrupted electorate.
    Candidate: an `actuator` role — reads at `hub`, publishes actuation activities on hub
    threads, never pinned into a snapshot — or, more conservatively, a narrow write-path for
    `observer` restricted to `afp:actsOn`-bearing activities, mirroring the requester's
    deliberately narrow write-path.

55. **Nothing constrains who may act.** The complement of 54: replay checks that `afp:actsOn`
    resolves, that the category is in the closed set, and that the action is admissible under
    the pinned policy, and never checks the actor. Any rostered agent can emit a well-formed
    action on any `DecisionRecord`. Candidate: require the actor to be enrolled in the hub
    whose round produced the outcome (in whatever role 54 settles on), checked at replay
    from the Enroll trail the verifier already reconstructs.

56. **A decision cannot be settled, so a correct dissenter cannot be credited.**
    `afp:Settlement` binds to estimates or a Synthesis, follows an award, and is published
    once per task; a `DecisionRecord` is none of those. 04 states the stake in its own words
    — a swarm that penalizes accurate minority objections stops producing them — and a
    governance round is where objecting is most expensive. Candidate: let a settlement take a
    `DecisionRecord` as its subject, with the observed outcome and its evidence, keeping the
    award-follows precondition for the allocation case rather than generalizing it away.

57. **An outcome that binds jointly has no expression, and defection has no record.** Nothing
    states what a `DecisionRecord` obliges of the members pinned into it, which was harmless
    while outcomes were divisible and is not once a decision is indivisible by construction.
    A member acting against a decision it lost is currently invisible. Candidate: a declared
    property on the proposal that the outcome is jointly binding, and — since a protocol
    cannot enforce what happens in a car park — a recorded `afp:departs`-style act by which
    a member states on the record that it is not following the outcome it was pinned into.
    Visible non-compliance is worth more here than unenforceable compliance.

**The through-line, for whoever triages this:** findings 53, 54 and 55 are one decision
wearing three faces — *a decision that binds the world needs the same apparatus a task does*
— and 50, 51 and 57 are a second — *a round is specified as an event and used as a
commitment*. 52 and 56 stand alone. None of the eight needs a new subsystem; six of them are
existing machinery that stops one activity type, one role, or one subject short.

## Running it

The reference instance ships this scenario as a demo with real model brains behind the agent
port (`src/instance`):

```bash
npm run demo:p5:llm
python3 ../verifier/afp_verify.py export-p5-llm/alpha export-p5-llm/bravo export-p5-llm/gamma
# PASSED — 418 checks, no gaps   (the exact count moves with how the schools voted:
#                                  a departure is only recorded when someone was outvoted)
```

**Since campaign 8 built [ADR-0018](../adr/0018-the-round-as-a-commitment.md) and
[ADR-0019](../adr/0019-acting-on-a-decision.md), the demo runs the *resolved* world rather
than the strained one this scenario found.** The findings above are left exactly as they
were written — a scenario is a record of what was true when it was walked — but the
command now shows the other side of each one: the round pins its bar and its deadline
before a vote exists, a round that misses the bar closes `afp:no-decision` instead of
declaring a winner it did not earn, the seat that sends the 06:00 message is an `actuator`
that may publish nothing else, and an operator bound by a decision it voted against
records an `afp:Departure` rather than quietly doing otherwise. Beats 3, 5 and 6 are the
ones to compare against the output.

Each head teacher is given only its own school's morning and reaches its own conclusion, so
the disagreement in beat 3 is produced rather than scripted — including its instability: a
small local model does not always vote the way the evidence points, which is its own quiet
argument for why the record carries the vote and not the reasoning. The tally, the
`afp:uncounted` entry, the discarded observer vote, the two `403`s at the write door and the
post-mortem delegation surviving the host's death are all printed from the run.
