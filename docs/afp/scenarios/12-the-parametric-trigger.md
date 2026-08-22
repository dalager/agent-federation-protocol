# Scenario 12 — The parametric trigger: five reinsurers, one storm, and a signature that voted twice

> Spec-test scenario. The P6 shakedown — the first workload at **n ≥ 4 operators**, where
> "Byzantine tolerance" stops being a table in 03 and has to survive contact with parties
> for whom misbehaving is *rational*, not hypothetical. It stresses every noun in P6's
> roadmap row — chained signed votes, `afp:EquivocationProof`, snapshot-pinned membership,
> the governance rollup — and then keeps walking past where the cryptography ends:
> a proof that punishes a key when the culprit is a person, an honest node that restores
> from backup into the exact shape of an equivocator, a view change that hands out the most
> powerful object ADR-0018 ever created, a merger the snapshot cannot see, and a sanction
> the accused gets to vote on. Verdict at the end.
>
> Deliberately *not* re-testing settled ground: hosting, membership proof, partition
> behaviour and the N-party case file ([scenario 10](10-the-incident-bridge.md), ADR-0014,
> ADR-0015) and the round-as-commitment apparatus ([scenario 11](11-the-snow-day.md),
> ADR-0018, ADR-0019) appear here only as regression checks — and several of them pass
> in ways worth recording, because this is the first scenario where they carry real weight.

| **Support status** | **Partially supported — findings 58, 60, 61, 62, 63 closed; 59, 64, 65 open** (campaign 9, opened 2026-08-22) |
|---|---|
| Resolved by | [ADR-0020](../adr/0020-p6-hardened-round-stack.md) (58, 60, 61, 62 — built) · [ADR-0005 amendment](../adr/0005-operators-are-equal.md) (63 — built) · still to write: ADR-0021 (59, 64, 65) — [triage](README.md#campaign-9--open-scenario-12-the-p6-shakedown) |
| Gated by | `test/adr0020.test.ts` (14 cases — G2 is the backup-restore that must not convict) · `test/adr0005.test.ts` (the merger the snapshot can now see) |
| See it run | `npm run demo:p6` — beats 3-5, five instances over real HTTP: the equivocator convicted, the backup-restore acquitted, the doomed round closed early, the successor entitled. `npm run demo:p6:llm` runs the same pool with the underwriters' verdicts written by a local model |

## User story

**As** the claims director of a five-member parametric reinsurance pool — where a payout
is triggered not by loss adjusters but by a jointly ratified finding that a named storm
crossed the contract's thresholds, and where every member's exposure to that finding is
different and known —
**I want** the trigger decision to survive one member for whom a stalled or split decision
is worth more than an honest one,
**so that** the payout that reaches four thousand policyholders is one that no member can
later repudiate, split, or quietly have talked out of existence — and so that when a
member's signature *does* misbehave, what the record proves and what we do about it are
not the same confusion twice.

## Cast

Five reinsurers, one standing hub, `windward`, hosted by one of them (settled ground,
ADR-0014). The hub exists for exactly one kind of round: **trigger determinations** —
*did event E cross the pinned parametric thresholds, yes or no* — and its decisions are
wired to money. This is the first scenario where the hub runs **L1**: five operators live
in it, which is P6's own activation trigger fired with room to spare, and `floor(2n/3)+1 = 4`
of 5 gives actual tolerance of `f = 1`, not the n=2 accountability consolation prize
(03 — the guarantees table this scenario exists to pressure-test).

| Instance | Agents in play | Role | Exposure to this trigger |
|---|---|---|---|
| `atlas-re.example` (**Atlas**) — **hosts the hub** | `underwriter` (member), `pay` (**actuator**, ADR-0019) | member + host | pays out moderately on YES |
| `meridian-re.example` (**Meridian**) | `underwriter` (member) | member | **profits if the round fails to close** — its retrocession contract shifts the dispute to arbitration on a no-decision, on terms it wrote |
| `pelican-re.example` (**Pelican**) | `underwriter` (member) | member | pays out heavily on YES |
| `anchor-syndicate.example` (**Anchor**) | `underwriter` (member) | member | pays out lightly on YES |
| `harbor-mutual.example` (**Harbor**) | `underwriter` (member) | member | receives on YES |

The exposures are on the record — each member's position is pinned into the standing
contract asset (`afp:Asset`, ADR-0004) the proposal references. This matters: unlike
scenario 11, where nobody could verify anybody's evidence, here everyone can verify
everyone's *incentive*. The record knows exactly who benefits from every outcome,
including the outcome of no outcome.

**The adversary model, honestly.** Scenario 08's Mallory probed the gate from outside.
This scenario's threats are all *inside* the agreement, holding valid keys and pinned
weight — the threat model L1 was built for and no scenario has ever exercised: a member
who equivocates because the arithmetic pays, a key that equivocates because it was
stolen, and a node that equivocates because a restore-from-backup ate its memory of
having voted. The record will treat all three identically. Whether it *should* is most
of the verdict.

## Walkthrough

**1. The trigger round opens, and campaign 8's machinery earns its keep.** Storm
Dagmar's central pressure and landfall track are published by the met office; Atlas's
`underwriter` opens `urn:afp:thread:dagmar-trigger` and proposes on `windward`:
*Dagmar crossed the pinned thresholds — yes/no.* Everything ADR-0018 and ADR-0019 built
is load-bearing on the first activity: the proposal pins its deadline (the contract's
72-hour determination window), its quorum rule (the Byzantine minimum, `floor(2n/3)+1`
in weight — the first time the pinned rule and the L1 phase bar are the same number),
`afp:binding` (a trigger determination binds the pool jointly — there is no per-member
payout), an `afp:actionPolicy` whose only admissible action is the payment instruction,
and `afp:irrevocableActions` naming it (money sent is money sent, ADR-0011). Atlas's
`pay` sits in the `actuator` seat, reads everything, votes never. Five members are
snapshot-pinned, one weight each — ADR-0005 at its cleanest, five operators, one agent
apiece.

**Held, and worth saying plainly:** every finding scenario 11 raised is closed exactly
where this scenario needs it. A round about money has a clock, a bar, a binding, an
actuator and a policy before the first vote exists. Campaign 8 built the commitment;
this campaign tests who can break it.

**2. Prepare phase, all-to-all, and the chains do their job.** L1 votes are not
point-to-point confidences but chained, signed, broadcast objects: each carries
`afp:proposalHash`, a per-(voter, round) `afp:seqNo`, and `afp:observedVotes` — the
hashes of every signed vote the voter had seen when it cast its own (03 — signed vote
chains). Atlas, Pelican, Anchor and Harbor prepare `yes` — the met data is not
ambiguous. The votes cross-reference; the causal mesh thickens; nothing so far needs a
Byzantine anybody.

**3. Meridian equivocates, and the anti-entropy catches it.** Meridian's `underwriter`
signs **two** prepare votes for `(meridian, dagmar-round, seq 1)`: `yes` in the copy
delivered to Atlas and Harbor, `no` in the copy delivered to Pelican and Anchor. The
intent is arithmetic, not chaos: if the yes-camp and no-camp each believe a different
tally is forming, neither assembles `2f+1` *matching* commits before the pinned
deadline, the round expires `afp:no-decision` (ADR-0018 Decision 2 — the honest
non-answer, working exactly as designed), and Meridian's arbitration clause wakes up.
**A mechanism built so a round could fail honestly is, to the one party that profits
from failure, a target.**

It does not survive contact with `afp:observedVotes`. Pelican's commit references the
hash of the Meridian vote *it* saw; Atlas's references the one *it* saw; the hashes
differ for the same `(voter, round, seqNo)`; anti-entropy surfaces the pair. Atlas and
Pelican jointly hold two conflicting signed votes and publish
`Announce{afp:EquivocationProof}` — self-contained, third-party-verifiable, not an
accusation (03). Every receiver zeroes Meridian's weight immediately, agent-level,
automatic. The proof verifies standalone from the two votes alone. **This is P6's
signature moment and it works** — on the happy path of the unhappy path.

**4. The arithmetic after the proof, which nobody pinned.** Now count. The proposal
pinned its quorum rule over five members at one weight each: threshold 4 of 5. Meridian
is zeroed. Four honest members remain, holding 4 of a pinned 5 — the bar is still
*reachable*, exactly. Then Anchor's node crashes (beat 5), and the live honest weight
is 3 of a pinned 5, and the round is **mathematically unclosable**: the pinned rule's
denominator includes weight that no longer exists to be cast (**finding 60**). ADR-0018
gave an expired round an honest terminal — but this round is not expired, it is
*doomed*, provably, thirty seconds after the proof lands, and the record has no way to
say so before the deadline runs the clock out. For a trigger with a 72-hour window that
is 71 hours of theatre. The quorum rule was pinned against an electorate the protocol
itself just amputated, and no mechanism relates the two.

**5. Anchor restores from backup and becomes an equivocator.** Anchor's crash is
mundane — a disk, not a conspiracy. It restores from a snapshot taken *before* it cast
its prepare vote, has no memory of having voted, and honestly re-votes: same round,
same `seqNo 1`, same value `yes` — but a different `afp:observedVotes` set (the mesh
grew while it was down) and a different timestamp, therefore a **different hash**. Same
`(voter, round, seqNo)`, two signed votes. Harbor's anti-entropy flags it.

Is that equivocation? The spec answers twice, differently. The prose defines the proof
as same-tuple, **"different value"** — Anchor's value is identical, so no proof. The
sequence diagram's cross-check fires on **"different hash"** — so proof (**finding
58**). One reading lets a real equivocator escape by varying only its observed-set to
partition the mesh's *view* while keeping the value constant; the other convicts every
node that ever restores from backup, which at a five-year horizon (scenario 09's
lesson) is *all of them*. The boundary between lost state and malice is the boundary
between an incident and a sanction, and it is currently a discrepancy between a
paragraph and a picture.

Harbor, reading the diagram, publishes the proof. Anchor's weight zeroes. An honest
member is now cryptographically indistinguishable from Meridian — **the record holds
two EquivocationProofs of identical shape, one of which everyone in the room knows to
be a disk failure**, and the record has no way to receive that knowledge.

**6. The morning after, Pelican's lawyers call.** Meridian does not confess. Its
operators claim the key was captured — a trader with access to the signing enclave,
they say; a police report exists, they say. And here the proof's honesty becomes its
limitation: an `afp:EquivocationProof` proves that *a key* signed two conflicting
votes. It says nothing about *who directed the key* (**finding 59**). Weight-zeroing
lands on the instance either way — correctly, as containment — but there the mechanism
ends. There is no recorded path by which a victim contests, no distinction between
"sanctioned" and "compromised" on the record, no defined interaction with ADR-0012's
rotation-vs-revocation machinery (revoking the key after the proof does not and should
not unwind the proof — but nothing says what it *does* do), and no way for a zeroed
agent's weight to ever return. Zeroing is described as automatic and instantaneous;
restoration is described nowhere. For Anchor — whose "equivocation" was a backup — that
silence is the whole injury.

**7. The view change, or: the proposal is now the crown jewels.** The doomed round
expires `afp:no-decision` at the deadline (the honest terminal, correctly). The
contract still needs its determination, so L1's stall recovery applies: *"the
highest-reputation live replica issues a fresh round referencing the stalled one"*
(03). Count again: reputation, under ADR-0004's recomputable consumption, is built from
settlements — and Meridian, a diligent underwriter for years, has the best settlement
record in the pool. **The recovery rule elects the arsonist to hold the matches.** Its
weight is zeroed for *this* round's tally; nothing says a zeroed voter cannot be the
*successor proposer*, because the view-change rule is a sentence of prose that no
proposal pins, no close references, and no replay recomputes (**finding 62**).

And the stakes of holding the proposal are not what they were when that sentence was
written. Since ADR-0018 and ADR-0019, the proposer pins the deadline, the quorum rule,
the binding, the electorate, the action policy and the irrevocability declaration — the
proposal is the single most consequential object in the protocol, and the view change
hands it out on an unpinned, unrecomputable popularity metric. Scenario 11 proved the
round is a commitment; nobody went back and asked what that made the right to open one.

**8. The merger the snapshot cannot see.** Fourteen days later, before the re-run
determination round, Meridian announces it has acquired Anchor — a distressed purchase;
the equivocation scandal cratered Anchor's price, a detail with its own aroma. Under
ADR-0005 the arithmetic of the pool has just silently broken: five pinned seats, four
beneficial owners, and the "honest majority" that `f = 1` tolerance assumes now
requires trusting that two seats under one roof vote independently (**finding 63**).
The Vouch/Disown trail can *carry* a declared change of control — `afp:operatedBy` is
exactly the predicate — but nothing *requires* the declaration, no snapshot machinery
reacts to one, and no round distinguishes "five operators" from "five seats." The
protocol cannot detect a concealed merger, any more than it can detect bid collusion —
that is consortium-terms territory, and the spec says so honestly. But a *declared*
merger has no mechanism either: the compliant acquirer who wants to state its new
control on the record and have the weights collapse accordingly has nowhere to put the
statement. The gap is not that lying works; it is that telling the truth doesn't do
anything.

**9. The sanction, judged by the sanctioned.** The pool moves to the instance-level
consequence, exactly as 03 prescribes: agent-level zeroing was automatic, but expelling
or suspending *Meridian the member* requires a ratified `afp:GovernanceDecision` — the
rollup, working as designed, keeping cryptography from imposing what only governance
may. Then the round is convened, and Meridian is *in it*: a pinned member of the very
electorate that votes on its expulsion, holding weight the moment a fresh snapshot is
cut for a new round (**finding 64**). The estimator wall solved precisely this shape
for allocation — the party with the conflict is excluded at admission, recomputably —
and governance, where the conflict is sharpest, has no recusal mechanism at all.
ADR-0019 built the actuator so that a party could act without influencing; nothing yet
lets a party be *judged* without voting.

**10. Pelican meets Meridian again.** Epilogue, and the reason "portable" needs
scare-quotes. The EquivocationProof is self-contained and third-party-verifiable —
03 calls it *"usable commercially and in governance"* — and six weeks later Meridian's
same agent enrolls in a different consortium's hub, clean (**finding 65**). Nothing
carries the proof there: enrollment checks roles and vouching, not history; the
reputation machinery consumes settlements, not proofs; no registry, no lookup duty, no
enrollment-time evidence slot exists. The proof is portable the way a paper document is
portable — it can be carried, by someone, to someone who has no obligation to read it.
For the one artifact in the protocol that is *specifically designed* to outlive its
hub, that is a thin afterlife.

**11. What the case file proves — including what nobody announced.** Five exports,
one command, ADR-0015's all-pairs join and census. The join catches something subtle
and good: Meridian's two conflicting prepare votes each appear in *somebody's*
received-bytes record, so the divergence is present in the case file **even before any
EquivocationProof is** — the all-pairs cross-check was built for two-story agreements
and it catches two-story votes for free. Which raises the finding: suppose Atlas and
Harbor, who received the `yes` copy and *benefit* from a yes, had quietly declined to
anti-entropy with the no-camp — no proof is ever assembled, the round closes on votes
someone knew to be equivocal, and nothing obliges a holder of half a proof to complete
it (**finding 61**). The evidence of concealment sits in the exports; the verifier,
which already resolves every received byte against its sender, does not currently
*look* for same-tuple-different-hash pairs across domains. It could. A concealed
equivocation should fail the joint replay by name, exactly as a two-story agreement
does — detection moved from the mesh's goodwill to the record's arithmetic.

## Acceptance criteria → mechanisms

| Criterion | Spec mechanism |
|---|---|
| A member who tells two camps two stories is caught | `afp:observedVotes` anti-entropy → `afp:EquivocationProof` (03) — **held** |
| The proof convinces a stranger, not just the victims | Self-contained proof over two signed votes; verifies standalone — **held** |
| Weight-zeroing needs no coordination round | Automatic agent-level zeroing on proof receipt (03) — **held** |
| Instance-level punishment is governed, not automatic | Rollup to ratified `afp:GovernanceDecision` (03) — **held**, but see finding 64 |
| The trigger round has a clock, a bar, a binding, a policy, an actuator | ADR-0018 + ADR-0019, regression — **held** |
| A round that cannot close says so honestly | `afp:no-decision` at expiry — **held at expiry; strains before it** — finding 60 |
| Losing your state is not the same as lying | **Strains** — finding 58 |
| The sanction lands on the culprit, not merely the key | **Strains** — finding 59 |
| A doomed round is distinguishable from a pending one | **Strains** — finding 60 |
| Concealing a known equivocation is detectable from the record | **Strains** — finding 61 |
| The right to open a round is as governed as the round | **Strains** — finding 62 |
| Five seats and four owners are different electorates | **Strains** — finding 63 |
| The accused does not vote on its own expulsion | **Strains** — finding 64 |
| A proof of misbehaviour outlives the hub it was born in | **Strains** — finding 65 |

## Spec verdict

**Held: the cryptography, end to end.** The chained votes, the anti-entropy, the proof
that assembles from two signed objects and convinces anyone, the automatic zeroing, the
safety property (no two conflicting quorum certificates ever both validated), the honest
degradation of liveness, and the rollup's insistence that instance-level consequences go
through governance. Also held, and tested here under real load for the first time:
everything campaign 8 built. The round-as-commitment apparatus was designed against a
snowstorm and survives a hostile reinsurer without modification. And ADR-0015's
all-pairs join turns out to contain the seed of equivocation detection at replay time —
machinery built for one purpose quietly covering another, the *inverse* of this
repository's recurring defect, and worth naming as such.

**Strained: everything after the proof.** L1's threat model ends at the moment of
cryptographic conviction, and this scenario spent seven of its eleven beats in the
territory after that moment: what the proof means, whom it punishes, what it does to the
round's pinned arithmetic, who must publish it, who inherits the stalled round's crown,
what the electorate even *is* when ownership moves, who judges the judged, and where the
proof goes when everyone would rather forget it. **The through-line: the proof is about
a key; every consequence is about a party.** The distance between those two nouns is
where all eight findings live — and it is the same distance, one layer down, that
campaign 8 found between *recording* a decision and *being bound* by it.

A second pattern, familiar from campaigns 6 and 8, fires again and should be expected
to keep firing: **machinery gains power faster than the rules governing access to it.**
ADR-0018 made the proposal the most consequential object in the protocol; nobody
re-examined the view-change sentence that hands proposals out. The roadmap predicted
this class of defect for P5 ("a mechanism attached to the wrong thing, invisible until
something was built on top of it") and it is alive and well at P6.

**Strained — eight findings:**

58. **"Different value" and "different hash" convict different worlds.** 03's prose
    defines equivocation as same `(voter, round, seqNo)`, different *value*; its
    diagram's cross-check fires on different *hash*. A node that restores from backup
    and honestly re-votes the same value with a grown `observedVotes` set is an
    equivocator under one reading and innocent under the other — and a sophisticated
    equivocator who varies *only* the observed-set (partitioning the mesh's causal view
    while keeping the value constant) is the reverse. Candidate: rule it precisely —
    a proof requires differing *values* (or differing `proposalHash`); a same-value
    hash mismatch is a defined lesser event (state-loss disclosure, re-vote at
    `seqNo+1` superseding the orphan), so restoring from backup has a compliant path
    that is not silence.

59. **The proof punishes the key, not the culprit — and nothing comes after.** Zeroing
    on proof receipt is right as containment and specified as permanent: no contest
    path, no record-level distinction between a malicious operator and a captured key,
    no defined interplay with ADR-0012's rotation/revocation (what does revoking the
    convicted key do to the proof? to the same key's other votes in the round?), and no
    restoration mechanism at all. Candidate: a recorded contest — `afp:KeyCompromiseClaim`
    or similar, referencing the proof, feeding the *instance-level* governance round
    that already exists; zeroing stays automatic, but "zeroed pending governance" and
    "zeroed by ratified decision" become different record states, and restoration is a
    GovernanceDecision like any other membership act.

60. **A doomed round is indistinguishable from a pending one.** The pinned quorum rule's
    denominator is fixed at snapshot time; proof-triggered zeroing (and plain node
    death) can push the *reachable* weight below the pinned bar with the deadline still
    days away. ADR-0018 handles expiry; nothing handles provable impossibility.
    Candidate: a defined early close — when zeroed-plus-unreachable weight makes the
    pinned rule unsatisfiable *from the record alone*, any member MAY close
    `afp:no-decision` citing the arithmetic, and replay recomputes the impossibility
    exactly as it recomputes the tally. The 71 hours of theatre become one activity.

61. **Nothing obliges completing a proof, and the verifier does not look for
    unannounced ones.** Each half of an equivocation pair may sit in a different
    domain's received-bytes record, held by a party the equivocation favours; assembling
    the proof is voluntary, and a round can close on votes a member privately knew to be
    equivocal. The evidence of the divergence is *already in the joint case file* —
    ADR-0015's all-pairs join carries both copies. Candidate: the joint replay scans
    received votes across domains for same-tuple conflicting signatures and fails by
    name on any pair lacking a corresponding on-record proof — concealment becomes
    detectable exactly the way two-story agreements already are; a MUST-announce duty on
    proof-holders then has teeth.

62. **The view change is an unpinned power grab waiting for a taker.** "Highest-
    reputation live replica issues a fresh round" — computed from what, pinned where,
    checked by whom? Nothing excludes a zeroed equivocator from being the successor;
    nothing lets replay verify the successor was entitled; and post-ADR-0018/0019 the
    proposal carries the deadline, bar, binding, electorate, policy and irrevocability —
    the throne, not a chore. A member can *manufacture* stalls (withhold votes, at the
    price finding 52 already names) to farm view changes toward itself. Candidate: the
    proposal pins its own succession — a recomputable successor rule (deterministic
    order over the pinned snapshot, zeroed voters excluded) named at open, exactly as
    the quorum rule now is; a fresh round from anyone else on a live stall is a replay
    failure, not a fact.

63. **A declared change of control has no mechanism, so the electorate is seats, not
    owners.** ADR-0005's one-operator-one-weight is enforced from the Enroll/Vouch
    trail at snapshot time and cannot see ownership move afterwards; `f = 1` tolerance
    at n=5 silently assumes seat-independence the record cannot state. Concealed
    control is consortium-terms territory (as cross-instance bid collusion already,
    honestly, is) — but *declared* control should do something. Candidate: a recorded
    `afp:operatedBy` transfer act (the Vouch/Disown grammar extended one noun), which
    a snapshot MUST consult — seats under common declared control merge to one
    operator-weight per ADR-0005 — plus one honest sentence in 02 that undeclared
    common control is exactly as invisible as collusion, and governed the same way.

64. **The accused votes on its own sanction.** The rollup routes instance-level
    consequences to a ratified GovernanceDecision in a hub where the accused holds
    pinned weight; no recusal mechanism exists anywhere in the governance path. The
    estimator wall solved this shape for allocation at admission time, recomputably;
    finding 23 solved it for review; governance — where the conflict is a party voting
    on its own expulsion — has nothing. Candidate: a proposal MAY declare a recused
    set with recorded cause (the EquivocationProof is the obvious citable cause), the
    snapshot excludes the recused from *this* round's electorate with per-operator
    totals recomputed over the remainder, and replay checks the exclusion as it
    already checks the estimator wall.

65. **The proof does not travel, so the sanction is hub-local by default.** 03 calls
    the EquivocationProof portable and commercially usable; no mechanism gives it a
    destination — enrollment weighs vouches, not history; `afp:reputationRule`
    consumes settlement snapshots, not proofs; there is no registry, no lookup duty,
    no evidence slot on an Enroll. A convicted equivocator re-enrolls elsewhere clean.
    Candidate: modest and honest — an Enroll decision MAY cite proofs as evidence and
    a hub's terms MAY require a self-declaration (falsifiable against any surfacing
    proof, which is the enforceable part); plus a named registry entry so a
    reputation derivation MAY consume proofs recomputably. Blacklist federation is
    *not* proposed: it imports every governance problem this scenario just
    catalogued, at consortium scale, and the spec should say why it declines.

**The through-line, for whoever triages this:** findings 59, 64 and 65 are one decision
wearing three faces — *conviction is cryptographic, consequence is governance, and the
seam between them is unbuilt* — and 58, 60 and 61 are a second: *the proof machinery
specifies the moment of detection and nothing on either side of it*. 62 is campaign 8's
own success biting back and should probably be triaged first — it is the only finding
that makes an attack *cheaper* as the spec currently stands. 63 stands alone, and its
honest half (declared control) is small. As ever: none of the eight needs a new
subsystem; the raw material — the governance round, the Vouch grammar, the all-pairs
join, the pinning discipline — already exists, each stopping one noun short of where
this scenario needed it.

## Running it

```bash
cd src/instance
npm run demo:p6        # scripted verdicts, deterministic
npm run demo:p6:llm    # the same pool, verdicts written by a local model
python3 ../verifier/afp_verify.py export-p6/{atlas,meridian,pelican,anchor,harbor} --verbose
```

Beats 3-5 verbatim, and the demo this scenario asked for: five instances over real
HTTP, one scripted equivocator, one scripted backup-restore, and a replay that tells
them apart. Meridian signs two prepare votes at one `(actor, round, phase, seqNo)`; the
hub recomputes the predicate, publishes a proof carrying both signed ballots, and zeroes
the seat. Anchor restores from a backup taken before it voted and re-signs the *same*
value at the *same* seqNo with a grown `afp:observedVotes` set — the identical shape on
the wire, and **not** a conviction. If the demo could not tell those two apart, finding
58 would still be open no matter what ADR-0020 says; it can, and the five bundles replay
clean jointly with the equivocation searchlight running over every ballot in every one
of them.

Two beats are deliberately *not* in the demo, and both are gated instead. Concealment
(beat 11, finding 61) cannot live in a bundle that passes — a case file containing an
unannounced conviction pair is exactly what the joint replay must *fail* — so it is
`test/adr0020.test.ts` G9/G13. And the successor round is published and replay-checked
but not tallied: the hub signs proposals as the hub, and the entitled successor is
always a member (ADR-0020's build note 2).

Beat 4 departs from the walkthrough in one honest way. The scenario has the round
doomed by Anchor's *crash*, but a crash is not something the record can see — only a
conviction is. So the demo reaches the same terminal by arithmetic the record actually
carries: Meridian zeroed, the four honest members split, and no option able to reach the
pinned bar of 4. The early close is justified from the bundle alone, which is the
property finding 60 asked for.

The LLM variant is where the split stops being scripted. Each underwriter reads the
shared met bulletin, its own book, and its own calibrated secondary record under the
contract's clause 7(c) — and the pool divides on the evidence rather than on the demo's
say-so. The equivocation and the disk failure stay scripted for the obvious reason: a
model cannot be asked to defect, and the point is that the record does not need to know
which is which.
