# ADR-0021 — After the proof: a recomputable electorate, a caused recusal, a governed consequence, and a proof with somewhere to go

- **Status:** Accepted, and **built** (Decisions 1 and 2 on 2026-08-22; Decisions 3, 4
  and 5 on 2026-08-23), gated by `test/adr0021.test.ts`, full suite green, every shipped
  bundle replaying with unchanged pass status and higher check counts
- **Date:** 2026-08-22
- **Applies to:** every hub running L1 (ADR-0020's trigger: ≥2 operators live in it), and
  — for Decisions 1 and 2 — **every hub at any level**, because the defect it closes is
  older than L1 and exists in every round this repository has ever signed
- **Builds on:** [ADR-0004](0004-solo-foundation-hardening.md) (the estimator wall, whose
  shape Decision 3 copies), [ADR-0005](0005-operators-are-equal.md) and its amendment
  (per-operator weight, and the recompute-over-a-remainder machinery recusal needs),
  [ADR-0012](0012-the-long-horizon.md) (rotation vs revocation, which Decision 4 must not
  contradict), [ADR-0014](0014-p5-shared-hub-stack.md) (`afp:uncounted` — the
  declare-the-absence move Decision 2 applies one layer up), [ADR-0018](0018-the-round-as-a-commitment.md)
  (the pinning discipline), [ADR-0019](0019-acting-on-a-decision.md) (the action policy
  and actuator Decision 4 reuses wholesale), [ADR-0020](0020-p6-hardened-round-stack.md)
  (the conviction this ADR is about, and the denominator contract it must honour)
- **Driven by:** [scenario 12 / campaign 9](../scenarios/README.md#campaign-9--built-scenario-12-the-p6-shakedown),
  findings **59, 64, 65** — and **two defects found while decomposing them**, both older
  than the campaign and both promoted ahead of the findings that exposed them, which is
  why this ADR has five decisions instead of three

## Context

Campaign 9's through-line is that **the proof is about a key and every consequence is
about a party**, and ADR-0020 stopped exactly at the moment of conviction: it rules what
convicts, who inherits a stalled round, when a doomed round may close, and how silence
fails. Everything on the far side of that moment — what the conviction *means*, whom it
punishes, whether it can ever be undone, who judges the judged, and where the proof goes
when everyone would rather forget it — was left here on purpose.

Three findings arrived with candidate shapes, and they are good ones:

- **59 — the proof punishes the key, not the culprit, and nothing comes after.** Zeroing
  is right as containment and specified as permanent. There is no contest path, no
  record-level distinction between a malicious operator and a captured key, no defined
  interplay with ADR-0012's rotation and revocation, and no restoration mechanism at all.
  Scenario 12's Anchor — whose "equivocation" was a disk — has no way back, and the
  record has no way to receive what everyone in the room knows.
- **64 — the accused votes on its own sanction.** The rollup routes instance-level
  consequences to a ratified governance decision in a hub where the accused holds pinned
  weight. The estimator wall solved this shape for allocation at admission time,
  recomputably; governance, where the conflict is sharpest, has nothing.
- **65 — the proof does not travel.** 03 calls the `afp:EquivocationProof` portable and
  commercially usable; nothing gives it a destination. Enrollment weighs vouches, not
  history.

### Two defects found while decomposing them

Finding 64's candidate is "let a proposal declare a recused set, and check the exclusion
at replay as the estimator wall already is." Decomposing that into a verifier check
turned up two things worse than the finding, both older. The second was found only
because the first forced the question *"what is the Enroll trail actually worth?"* — and
the answer is: today, nothing.

#### Defect A — anyone can unenroll anyone

`Hub.onUnenroll` (`src/instance/src/hub/hub.ts:749`) checks that the hub is active and
that the activity names an object. It performs **no authority check of any kind** before
calling `removeAgent`. It does not compare `activity.actor` against the agent's
`afp:operatedBy`, against `instanceOf(agent)`, or against anything else. Its sibling
`onEnroll` does enforce exactly that binding (ADR-0005 Decision 2), and `writeAdmitted`
(`hub.ts:447`) waves the pair through the door together, with a comment justifying the
exemption on the grounds that "its own handler enforces ADR-0005's issuer binding" — a
property only one of the two has.

The verifier does not close it either: `check_enroll_authority` filters on
`type != "afp:Enroll"` and returns, so no check anywhere examines who signed an
`afp:Unenroll`. `enrolled_roles_at` and `enrolled_instances` then consume Unenroll at
face value regardless of signer.

Measured, not inferred — a probe run against the real hub, with an *agent* (not even an
operating instance) signing an Unenroll naming a peer:

```
members after attacker's Unenroll: 1
victim still a member?            false
roleOf(victim):                   null
```

So: **any party holding any key that verifies can remove any agent from any hub, and the
resulting bundle replays clean.** No seat is required, no membership, no relationship to
the victim.

This defeats the whole of Decision 2 as originally drafted. An attacker who wants a
member out of an electorate does not need to omit them from `afp:voters` and hope nobody
checks — it unenrolls them first, and then the Enroll-trail fold that Decision 2 relies
on *agrees* that the victim was never a member. A completeness check over a trail anyone
may edit is theatre. Hence Decision 1, which comes first because everything else in this
ADR reads that trail.

#### Defect B — the pinned electorate is never checked, and one half of it cannot be

Two separate holes, both confirmed in the code as it stands:

1. **`afp:quorumSnapshot` is a digest nothing recomputes.** The hub computes it as
   `digestOf([...voters].sort())` (`src/instance/src/hub/hub.ts`), every vote echoes it,
   and the hub compares the echo against its own stored row. The verifier never
   recomputes the digest from `afp:voters` — grep `afp:quorumSnapshot` in
   `src/verifier/` and the only use is check 3's set-membership test, "is this voter in
   the pinned list." A proposal may therefore pin voter list V and advertise a snapshot
   digest of some entirely different set, and every downstream check — weights, tally,
   bar, `afp:uncounted` partition — recomputes consistently over V and passes.
2. **Omission from `afp:voters` is unlimited and invisible.** Every check in
   `check_decision_record` is relative to the *declared* list: `voter_weights` recomputes
   over `proposal["afp:voters"]`, the partition check asserts
   `counted ∪ uncounted == pinned`, and the bar is `threshold_of` over the declared
   weights. Nothing compares the declared electorate against the Enroll trail. A hub that
   simply leaves a member out of `afp:voters` produces a bundle that replays clean.

The second hole is the one that matters, and it has a reason: `proposeRound` filters on
`this.isLive(agent)`, and liveness is hub-local CRDT state that is **deliberately not
exported** ("liveness is absent by design — hub-generated, re-observed per replica", the
P5 demo's own words). So the verifier cannot recompute the electorate even in principle:
a member missing from the snapshot is either an honestly-unreachable node or a silently
disenfranchised one, and **the record does not distinguish them**.

Which makes finding 64 not quite what it looked like. The gap is not that a hub has no
way to recuse; it is that **a hub already has an unlimited, undeclared, undetectable way
to recuse — and adding a declared one on top of that would only bind the honest.** An
attacker who wanted the accused out of its own sanction round never needed a recusal
mechanism; it needed to not type a URL. Decision 2 closes that, and Decisions 3–5 stand on it.

This is the same pattern the campaign already named twice — *machinery gains power faster
than the rules governing access to it*. ADR-0018 made the proposal carry the deadline,
the bar, the binding and the policy; ADR-0019 added the action policy; ADR-0020 added the
succession rule and the round grammar. Nobody went back and asked whether the proposal's
oldest field — the list of who votes — was checked at all. It is not.

## Decisions

### 1. A membership change is authorized, or the trail is worthless

**An `afp:Unenroll` MUST be issued by the agent's own operating instance** — the same
binding ADR-0005 Decision 2 already imposes on `afp:Enroll`, and for the identical
reason: a valid signature proves only that somebody wrote these bytes, never that they
were entitled to say this about *that* agent. Enforced in both implementations, and
neither is optional:

- **The hub** (`onUnenroll`) resolves the agent's `afp:operatedBy` from its actor
  document and drops any Unenroll whose `actor` is not that instance, logging the refusal
  through `logAdmission` exactly as `onEnroll`'s rejections already do. This is a
  five-line change to a handler that currently checks nothing.
- **The verifier** gains the check `check_enroll_authority` was always missing — it
  already resolves `authority.operated_by` for every agent, so the evidence is loaded and
  the same comparison applies. An Unenroll from anyone else is a named replay failure.

Two corollaries the same defect implies, both cheap and both required for the trail to
mean what Decision 2 assumes:

- **`writeAdmitted`'s door-knock exemption is narrowed to `afp:Enroll`.** The comment
  justifying the exemption cites a handler binding that only Enroll has; once the hub
  checks Unenroll's issuer, the exemption is still safe, but the *reasoning* must be
  written down correctly rather than left as a false generalisation about a pair.
- **`enrolled_instances` gains the time cutoff `enrolled_roles_at` already has.** It
  folds the whole trail with no `at_millis` bound (`src/verifier/decision.py:198`), so an
  Unenroll published *after* a round closed still changes the operator bucket that
  round's weights are recomputed against — a closed round's arithmetic moving because of
  a later membership act. That is the same class as ADR-0020's forward-scoping rule and
  is fixed the same way: read the trail as of the proposal's own instant.

**Self-preemption stays open, deliberately.** 01 § "instance-level consequence" already
says an instance may preempt governance by self-issuing `afp:Disown`, and that remains
true — an instance withdrawing *its own* agent is precisely the case this rule permits,
because the issuer and the operator are the same party.

### 2. The electorate is recomputable, or exclusion is free

Two halves, and the second is the load-bearing one.

**2a. The snapshot digest is recomputed, not echoed.** `afp:quorumSnapshot` MUST equal
`digest_of(sorted(afp:voters))`. The verifier recomputes it and fails a proposal whose
advertised snapshot does not match the list it pins. This is one line of arithmetic
closing a field that has been decorative since P2, and it is a prerequisite for anything
else: a snapshot that names one set and lists another cannot anchor a rule about
exclusion.

**2b. Every enrolled member is accounted for, or the round fails replay.** A proposal
MUST partition the hub's member-role electorate at snapshot time:

```
enrolled_member_role_agents(at = proposal.published)  ==  afp:voters  ∪  afp:excluded
```

with the two sides disjoint. `afp:excluded` is a list of `{agent, afp:status}` entries in
a closed registry of statuses:

| `afp:status` | Meaning | Recomputable? |
|---|---|---|
| `not-live` | The hub could not reach this seat when it pinned the snapshot | **No** — a signed claim |
| `not-pinned` | Live, member-role, and deliberately outside this round's electorate | **No** — a signed claim, and 02's "has signed exactly that", made explicit |
| `recused` | Excluded by declared cause (Decision 3), which MUST also carry `afp:cause` | **Yes** — the cause resolves on the record |

`not-pinned` was added during implementation, not design, and the reason is worth
recording: ADR-0018's own gate has a case that pins three of four live enrolled members
and cites 02's proposer-declared electorate as its justification. With only `not-live`
and `recused` in the registry, the hub's choices there were to lie (the seat is live), to
refuse a call 02 permits, or to emit a bundle its own verifier fails. A registry that
cannot express a case the repository already exercises is an incomplete registry. It
carries no cause because there is nothing to resolve — which is precisely what
distinguishes it from `recused`, and why a governance round may not use it to drop the
seat it is about.

**This amends 02, and says so.** 02 § snapshot-pinning currently rules the other way:
"The pinned voter list is a **declaration**, not a discovery… a proposer that pins a
convenient subset has signed exactly that." That stance is defensible — accountability by
signature rather than by prevention — and it is the stance this decision keeps. What it
does not currently deliver is the *accountability* half: a reader cannot tell a
convenient subset from a complete one, because the comparison needs the Enroll trail and
nothing performs it. So the amendment is narrow. The proposer may still exclude; it must
now say so, and the saying is checkable. 02's sentence is edited to add the clause it was
always missing — "and must account for whom it left out."

This is exactly the move ADR-0014 Decision 4 made one layer down, and it is made for the
same reason. `afp:uncounted` did not make silence *verifiable*; it made silence
*declared*, so that "we never heard from them" became a signed statement a counterparty
can dispute rather than an absence nobody can see. `afp:excluded` does the same for the
electorate: `not-live` is still unfalsifiable, and the ADR says so plainly rather than
dressing it up. What changes is that a hub which disenfranchises a member must now
**sign a claim that the member was unreachable**, on the record, in the proposal, before
any vote exists — and a member who was demonstrably up (its own bundle shows it
publishing at that instant) has something to point at.

Undeclared omission stops being invisible and becomes a named replay failure.

**Scope note, deliberate:** 1a and 1b apply at **every level, L0 included** — the defect
is not L1's. W6 surveyed every shipped export against both halves before this ADR was
finished: all pass, so `afp:excluded` is required at L1 and optional at L0, and nothing
already written has to be regenerated.

### 3. Recusal: declared, caused, and the denominator moves because the snapshot moved

`afp:excluded` entries with status `recused` MUST carry `afp:cause`, an object in a
closed registry of forms. v1 defines two, and both resolve from the record alone:

```jsonc
{ "afp:form": "equivocation-proof", "afp:proof": "sha256:…" }  // a proof on record convicting this agent
{ "afp:form": "governance-subject" }                            // this round's own afp:governanceSubject
```

A recusal whose cause does not resolve — a proof digest that is not on the record, a
proof that convicts somebody else, a `governance-subject` form on a round that pins no
subject — **fails replay by name**. That is the whole security property, and it is the
estimator wall's, transplanted: the excluded set is recomputed from prior signed
evidence rather than trusted, so the proposer cannot recuse its opponents by declaring
them recused. It can only recuse the convicted and the accused.

**The denominator.** ADR-0020 Decision 4 ruled that zeroed weight still counts in the
bar's total — "the denominator moves only when the snapshot does" — and refused to fork
the weight arithmetic. Recusal honours that ruling exactly, and the reason it *looks*
different is worth stating so nobody later reads a contradiction:

| | Zeroing (ADR-0020) | Recusal (this ADR) |
|---|---|---|
| When | Mid-round, on a proof landing | At propose time, before any vote |
| What it removes | The ability to **cast** | Membership of the **electorate** |
| The pinned total `T` | Unchanged — the seat is still in it | Smaller — the seat was never in it |
| Why that is safe | A proof must not be able to lower the bar | The bar was computed over the remainder, in the open, before anyone voted |

Per-operator weights are recomputed over the remainder by passing the non-recused voters
to the existing `voterWeights`/`voter_weights` — an operator with two seats, one recused,
carries its whole operator-weight on the seat that remains. This is what the ADR-0005
amendment's machinery was for, and no new weight rule is introduced. **An implementer who
finds themselves writing a second weight function has taken a wrong turn.**

**What v1 does not do:** self-recusal by the agent's own act, and recusal for causes the
record cannot resolve (a conflict of interest nobody has signed anything about). Both are
real; both need a signed act from the recusing party rather than a claim by the proposer,
and that is a different object. Deferred, named, not pretended.

### 4. Conviction is cryptographic, consequence is governed — and both are on the record

Three parts, in the order the record needs them.

**4a. A compromise claim is a record state, never an exculpation.** `afp:KeyCompromiseClaim`
is published by the convicted agent's **own instance** on its own chain — the same
self-referential class as `afp:Vouch`, `afp:Disown` and the amendment's
`afp:ControlTransfer`, and held to the same standard: a valid signature from the
instance that operates the agent is exactly the entitlement the record needs. It names
the proof it answers, the verification method it says was captured, and the instant from
which it claims the capture ran.

It changes **nothing** automatically. Zeroing stays automatic and stays where ADR-0020
put it. What the claim buys is that the record can now tell three states apart where it
previously had one:

| State | Recomputed from |
|---|---|
| `zeroed` | a proof on record, no claim, no governance decision |
| `zeroed-contested` | a proof, plus a claim from the agent's own instance |
| `zeroed-by-decision` / `restored` | a ratified governance decision naming this agent |

An implementer must resist the obvious wrong turn here: **a claim is not evidence and
must never gate, delay or reverse zeroing.** It is a party saying something on a record
that will outlive it, which is precisely as much as the protocol can offer, and it is
what makes the difference between a sanction and an incident sayable at all.

**4b. A governance round is an ordinary round with a subject.** No new consensus
machinery, no second quorum path. 02 already constrains this, and the constraint is
adopted verbatim rather than reinvented: hub governance activities "require a **weighted
quorum vote among current instance members**, reusing the L1 machinery — *never* a
signature from the hub's own key." That last clause has teeth for the implementation,
because ADR-0014 made the hub the sequencing authority that signs proposals, and
ADR-0020's build note 2 already found that the hub-signs-everything habit collides with
member-entitled acts. **A `MemberExpel` or `MemberAdmit` signed by the hub actor is
invalid**, and the gate has a row that says so. A governance round is an ADR-0018 round whose proposal
pins `afp:governanceSubject` (the agent the round is about) and whose `afp:actionPolicy`
(ADR-0019) names membership actions for its outcomes. The vocabulary it actuates already
exists in 03's table and has since v1: `afp:MemberExpel` (dual-typed `["Remove",
"afp:MemberExpel"]`, `target` = the hub's members collection) and `afp:MemberAdmit`
(`["Add", "afp:MemberAdmit"]`). The actuation binds to the DecisionRecord through
`afp:actsOn` exactly as every other consequence has since ADR-0006.

The recusal in Decision 3 is what makes this honest: the subject of a governance round is
recusable by the `governance-subject` cause form, so the accused is out of its own
electorate by a rule anyone can recompute — and out of the *denominator* too, because the
snapshot moved.

**4c. Restoration is a membership act like any other, and it is forward-scoped.** A
governance round whose outcome actuates `afp:MemberAdmit` naming a zeroed agent restores
its weight **for rounds whose snapshot is pinned after that decision** — never
retroactively, and it never re-tallies a closed round, whose DecisionRecord is signed
history. This is ADR-0020's forward-scoping rule applied in the other direction, and the
symmetry is deliberate: neither conviction nor forgiveness reaches backwards into a
signed record.

**4d. Revocation must not become an eraser — the interaction ADR-0012 leaves open.**
Rotation is easy: ADR-0012 Decision 2 says a rotated key "keeps its validity interval and
everything it signed in-interval verifies forever", so a rotation cannot touch a proof.
Revocation is not easy, and the seam is sharp enough to be worth its own decision.

Revocation *cuts*: the compromised key's interval is terminated at the compromise
instant, and `check_key_intervals` fails any activity that key signed **after** the cut.
Now read that from the equivocator's side. Meridian is convicted by two votes signed at
T. Meridian's own instance then publishes a key history revoking that verification method
with a cut at `T − 1 hour`, claiming the capture began earlier. The two embedded votes
now sit *after* the cut, `check_key_intervals` fails them, ADR-0020's V4 requires both
embedded votes to verify — and **the proof that convicted Meridian fails replay.** The
sanctioned party rewrites the key history and the evidence against it evaporates.

ADR-0012 names the adjacent hazard (a holder can date an *activity* before a cut) but not
this one, which runs the other way: backdating the *cut* to invalidate someone else's
evidence. The rule, therefore:

> A revocation cut MUST NOT precede the `published` of any vote embedded in an
> `afp:EquivocationProof` on record against that key's actor. A key history that does so
> is a named replay failure (V14), not a successful revocation.

This does not stop anyone from revoking a genuinely compromised key, and it does not stop
anyone from claiming the compromise predated the equivocation — that claim is exactly
what `afp:KeyCompromiseClaim` is for, and what a governance round then weighs. What it
stops is the claim being self-executing against the record. **Say it in a claim, argue it
in a round; do not write it into the key history and call the evidence invalid.**

Nor does rotation restore weight — a new key is not a new party. Restoration is a
governance act and only a governance act.

### 5. The proof gets a destination, and the limits get written down

Modest on purpose. 03 already calls the proof portable; this makes "portable" mean
something small and true rather than something large and aspirational.

**5a. An Enroll MAY cite evidence, and it must ride inline.** `afp:evidence` is an array
of entries carrying a proof **verbatim** as well as by digest — the proof is
self-contained by construction (ADR-0020 Decision 1 embeds both signed votes for exactly
this reason), so a bundle that cites one can carry one.

Inline is not a preference; it is the only path available, and an implementer who reaches
for the obvious alternative will lose a day. The bundle *does* have a third-party
evidence channel — `artifacts/`, hash-named raw bytes — but the verifier fails any
artifact not referenced by some activity's `object.attachment[].afp:digest` ("unbound
evidence"), and an `afp:Enroll`'s `object` is a **bare agent-URL string** with no object
to hang an `attachment` array on. Routing evidence through `artifacts/` would mean
restructuring `afp:Enroll`'s object *and* widening the artifact-reference check. Inline
avoids both, and costs nothing the proof was not already carrying.

**5b. What the verifier does with a citation, including the case it cannot decide.** A
cited proof is recomputed, never trusted: it must satisfy every leg of `convicts` and it
must convict the agent being enrolled. And then the case that the P6 demo taught us to
expect — **the convicted actor's verification key may not be in the case file at all.**
An enrollment at a new hub is exactly the situation where the accused's own bundle is
absent by definition.

So the outcome of an evidence check is three-valued, and the third value is recorded
rather than swallowed:

| Outcome | When | Replay |
|---|---|---|
| holds | the pair convicts and both votes verify | passes |
| fails | the pair does not convict, or a vote fails against a key the replay *has* | **fails by name** |
| unresolvable | the signer's key is not published anywhere in this replay | **passes, and is counted in the census** |

An unresolvable citation must never read as a passing check — that is the vacuous-record
shape this repository has criticised since ADR-0015's census, and finding 48's rule
exists to make exactly this visible. It gets its own family so a reader sees
`evidence:0 unresolvable:1` and knows to ask for the other bundle.

**5c. A falsifiable self-declaration.** A hub's terms MAY require an enrolling agent to
declare `afp:priorProofs` (possibly the empty list). The declaration is worth exactly one
thing, and it is the thing that is enforceable: if a proof convicting that agent surfaces
in the same case file, the declaration is **falsified by name**. This is the same
enforcement shape as ADR-0020 Decision 5's searchlight — nobody is obliged to volunteer
history, but a signed denial contradicted by the record is a finding.

**5d. Blacklist federation is declined, and the reason is recorded.** A shared registry
of convicted agents would import every governance problem this campaign catalogued — who
may write to it, who may correct it, what a contested entry means, how a restoration
propagates, what a captured key does to a permanent public record — at consortium scale
and with no round to ratify any of it. The protocol declines to build one. Proofs travel
the way documents travel: someone carries them to someone who has a reason to read them,
and the reading is checkable. That is a smaller claim than 03's current wording and it is
the true one; 03 is edited to say so.

## Options considered

- **Adding a declared recused set without fixing the electorate** (64 as literally
  filed): rejected, and this is the ADR's central judgement. Declared recusal on top of
  free undeclared omission binds only the party that declares. The honest hub writes down
  its exclusions and is audited on them; the dishonest hub omits a URL and replays clean.
- **Recomputing the electorate fully, including liveness**: impossible as the system is
  built, and undesirable as a target — liveness is hub-local, re-observed per replica,
  and exporting it would make a replay depend on one hub's view of the network at one
  moment. Declaring the absence is the available honesty, exactly as with `afp:uncounted`.
- **Making a compromise claim gate or delay zeroing**: rejected. It hands every
  equivocator a free suspension of the containment mechanism for the price of one signed
  lie, and containment is the one thing L1 currently gets right.
- **A distinct governance consensus protocol**: rejected. A governance round is a round;
  building a second quorum path would fork the arithmetic that ADR-0018 and ADR-0020
  spent two campaigns making single.
- **Automatic restoration after a fixed period, or on key rotation**: rejected. Time is
  not a judgement and a new key is not a new party. Restoration is a membership act, and
  membership acts are governed.
- **Shrinking the denominator when a voter is zeroed** (to make zeroing and recusal
  symmetric): rejected again, as ADR-0020 Decision 4 rejected it. The asymmetry is the
  security property: a proof must never be able to lower a bar.
- **A shared blacklist / proof registry with federation**: declined — see Decision 4d.

## Consequences

- The oldest unchecked field in the protocol becomes checked, and — per W6's survey,
  which was run rather than deferred — **no shipped bundle has to change**: every
  proposal already computes its snapshot digest correctly, and every hub-host bundle
  already pins its full electorate. The risk moved from the data to the check's scope,
  which is a much better place for it.
- `afp:excluded` gives a hub somewhere to be honest and somewhere to be caught. The
  `not-live` status is unfalsifiable and stays that way; what changes is that it must be
  said.
- The accused stops voting on its own sanction, by a rule that resolves from prior signed
  evidence rather than from anybody's judgement.
- The record gains three states where it had one, and can finally distinguish a sanction
  from an incident — without pretending to know which is true.
- The proof gets a destination and an honest description of how far it travels. 03's
  "usable commercially and in governance" is narrowed to what is built.
- The seam left open on purpose: self-recusal, recusal for unsigned conflicts, a
  reputation derivation that consumes proofs, and threshold-signature commit certificates
  (03's optional L1 aggregation) are all still unbuilt, and none of them is load-bearing
  for anything above.

## Implementation architecture

Governing properties, unchanged from ADR-0018 and ADR-0020 and repeated because they are
the two rules a hurried implementer breaks first: **integer arithmetic only**, and
**recomputable from the record alone**.

### W0. Invariants — read this before writing code

Seven rules. Every one of them is a wrong turn this design has already considered and
rejected; breaking one produces code that passes its own tests and is wrong.

1. **Never fork the weight arithmetic.** There is one `voterWeights` / `voter_weights`.
   Recusal changes *which voters are passed to it*, never how it computes. If you are
   writing a second weight function, stop.
2. **A proof must never be able to lower a bar.** Zeroing leaves the pinned total alone.
   Only a snapshot that never contained a seat has a smaller total.
3. **A claim is not evidence.** `afp:KeyCompromiseClaim` gates nothing, delays nothing,
   reverses nothing.
4. **Nothing reaches backwards into a closed round.** Not conviction, not restoration,
   not recusal. A `DecisionRecord` is signed history.
5. **Unresolvable is not passing.** A check that could not be evaluated is recorded as
   unresolvable and shows in the census. Never `report.record(name, True)` for something
   you did not actually check.
6. **Every new property is emitted only when supplied.** An unchanged caller must produce
   byte-identical output — the compatibility rule every ADR since 0018 has carried.
7. **Closed registries stay closed.** An unrecognised `afp:status`, `afp:form` or cause
   form fails; it never falls through to a default. Precedent for the shape:
   `REPUTATION_RULES` — an unknown rule name is a verification *failure*, not a skip.
8. **No dead fields.** Every property this ADR adds must be read by a named check in the
   same work package that emits it. The cautionary precedent is `afp:hubKey`: emitted on
   every `afp:Enroll` since P2, read by nothing, zero occurrences in `src/verifier/`. A
   field nobody checks is documentation pretending to be a mechanism.

### W1. Wire schemas

Every field below is **optional unless marked required**, and every one is emitted only
when supplied (W0.6).

**`afp:Proposal` — two new properties (Decisions 1 and 2):**

```jsonc
{
  "afp:quorumSnapshot": "sha256:…",     // EXISTING — now required to equal digest(sorted(afp:voters))
  "afp:excluded": [                      // NEW — required at L1; optional at L0 only while W6's survey runs
    { "agent": "https://…/agents/x", "afp:status": "not-live" },
    { "agent": "https://…/agents/y", "afp:status": "recused",
      "afp:cause": { "afp:form": "equivocation-proof", "afp:proof": "sha256:…" } }
  ],
  "afp:governanceSubject": "https://…/agents/y"   // NEW — present iff this round is about a member
}
```

`afp:status` closed set: `not-live | recused`. `afp:cause.afp:form` closed set:
`equivocation-proof | governance-subject`. `afp:cause` is **required** when
`afp:status == "recused"` and **forbidden** otherwise.

**`afp:KeyCompromiseClaim` (Decision 4a)** — `Create`-carried, on the instance's own chain:

```jsonc
{
  "type": "Create",
  "object": {
    "id": "https://meridian.example/claims/dagmar-1",
    "type": "afp:KeyCompromiseClaim",
    "afp:proof": "sha256:…",                                   // required — the proof it answers
    "afp:verificationMethod": "https://…/actor#ed25519-key",   // required — the key it says was captured
    "afp:since": "2026-08-19T00:00:00.000Z",                   // required — RFC 3339, ms + Z
    "content": "free text, narration only"
  }
}
```

**`afp:Enroll` — one new property (Decision 5):**

```jsonc
{
  "afp:evidence": [
    { "afp:digest": "sha256:…", "afp:object": { /* the full Announce{afp:EquivocationProof} */ } }
  ],
  "afp:priorProofs": []            // the falsifiable self-declaration (4c); [] is a meaningful value
}
```

**Membership actuation (Decision 4b)** — 03's existing vocabulary, built for the first
time, carried as the ADR-0019 actuation of a governance round:

```jsonc
{
  "type": ["Remove", "afp:MemberExpel"],       // or ["Add", "afp:MemberAdmit"]
  "target": "https://…/hubs/windward/members",
  "object": "https://…/agents/y",
  "afp:hub": "https://…/hubs/windward",
  "afp:actsOn": "sha256:…",                    // the DecisionRecord — ADR-0006, unchanged
  "afp:action": "expel-member"                 // must be the policy's action for that outcome
}
```

### W2. Algorithms

Both implementations mirror these. Function names are a parity pair like
`thresholdOf`/`threshold_of` — TypeScript in `src/instance/src/hub/electorate.ts` (new),
Python in `src/verifier/electorate.py` (new).

**Electorate (Decision 1b):**

```python
electorate_of(hub_actor, all_activities, at_millis):
    # the member-role agents enrolled at that instant — the SAME fold the verifier
    # already uses for roles; do not write a second one
    roles = enrolled_roles_at(hub_actor, all_activities, at_millis)   # -> dict agent -> role
    return { agent for agent, role in roles.items() if role == "member" }
    #                                        ^^^^^^^ .items(), not bare iteration:
    #   `for a, r in some_dict` iterates KEYS and raises. This footgun is called out
    #   because the first draft of this ADR contained it.

partition_holds(proposal_activity, all_activities):
    proposal  = afp_object(proposal_activity, "afp:Proposal")
    hub_actor = proposal.get("afp:hub") or proposal_activity.get("actor")
    # `published` lives on the ACTIVITY, not on the afp:Proposal payload — the builder
    # (`offerProposal`) puts it in the envelope. `check_decision_record` reads
    # `proposal.get("published") or decision_activity.get("published")`, which works
    # only because the first half is reliably absent. Read the activity.
    at        = instant_millis(proposal_activity.get("published"))
    enrolled  = electorate_of(hub_actor, all_activities, at)
    voters    = set(proposal.get("afp:voters") or [])
    excluded  = { e["agent"] for e in (proposal.get("afp:excluded") or []) }
    return voters.isdisjoint(excluded) and (voters | excluded) == enrolled
```

**Cause resolution (Decision 3):**

```
causeResolves(cause, agent, proposal, allActivities):
    match cause["afp:form"]:
        case "equivocation-proof":
            proofActivity = activity in allActivities with digest_of(a) == cause["afp:proof"]
            if proofActivity is None: return False
            votes = equivocation_proof_votes(proofActivity)          # ADR-0020's helper, reused
            return votes is not None and votes[0]["actor"] == agent and convicts(*votes)
        case "governance-subject":
            return proposal.get("afp:governanceSubject") == agent
        case _:
            return False                                              # closed registry (W0.7)
```

Note the deliberate asymmetry: the cited proof must **convict** (`convicts` recomputed),
but its signatures are *not* re-verified here — that is V4's job in ADR-0020's
replay-wide layer (`check_equivocation_proofs`), and duplicating it would give two
answers to one question.

**Zeroing state (Decision 4):**

```
zeroState(agent, hubActor, allActivities):
    proofs    = any on-record EquivocationProof convicting agent in this hub
    claim     = any Create{afp:KeyCompromiseClaim} by agent's own instance naming one of those proofs
    decided   = latest ratified governance DecisionRecord whose round pins
                afp:governanceSubject == agent AND whose outcome actuated
                MemberExpel / MemberAdmit
    if decided is MemberAdmit:  return "restored"      # forward-scoped from decided.published
    if decided is MemberExpel:  return "zeroed-by-decision"
    if proofs and claim:        return "zeroed-contested"
    if proofs:                  return "zeroed"
    return "clear"
```

**Restoration scope (Decision 4c):** a round is affected by a restoration iff
`instant_millis(proposal_activity["published"]) > instant_millis(restoring_decision_activity["published"])`
— both read off the **activities**, per the note above. Strictly greater: a round already
pinned when the decision landed keeps its snapshot.

### W3. Verifier checks

Every check name below is the **exact string to record**, and the leading word is its
census family. New families: `electorate`, `recusal`, `claim`, `evidence`, `membership`.
All must be added to `Report.census`'s `conditional` tuple in
`src/verifier/afp_verify.py` (finding 48's rule — a family that can run zero times must
print its zero).

| # | Check name | Fails when |
|---|---|---|
| V1 | `unenroll: {agent} unenrolled by its own instance` | an `afp:Unenroll` whose `actor` is not the agent's `afp:operatedBy` — the check `check_enroll_authority` never had (Decision 1). **Per domain**: the agent's own document carries `afp:operatedBy`, and `Authority.operated_by` already resolves it |
| V2 | `enroll: {agent} membership trail is read as of the round` | `enrolled_instances` folding an Enroll/Unenroll published *after* the proposal it is being used to weigh — the missing `at_millis` cutoff (Decision 1's second corollary) |
| V3 | `round: {id} quorum snapshot matches its voter list` | `afp:quorumSnapshot != digest_of(sorted(afp:voters))` — **per domain**, since a proposal carries its own voter list wherever it sits |
| V4 | `electorate: {id} accounts for every enrolled member` | `afp:voters ∪ afp:excluded != enrolled member-role set at `published``, or the two overlap — **replay-wide, three-valued** (see below) |
| V5 | `electorate: {id} exclusion statuses are known forms` | an `afp:status` outside `not-live \| recused`, or `recused` without `afp:cause`, or a non-recused entry carrying one — **per domain** (pure shape) |
| V6 | `recusal: {agent} in {id} has a resolvable cause` | `causeResolves` is false — the proof is absent, convicts someone else, or the round pins no subject — **replay-wide**, for the same reason as V4 |
| V7 | `weights: {label} pinned weights honor declared control` | **EXISTING, extended** — recomputed over `afp:voters` only, which is already what it does; the extension is that V4 now guarantees that list is the whole story |
| V8 | `claim: {id} is published by the agent's own instance` | a `KeyCompromiseClaim` whose actor is not the operator of the convicted agent, or naming a proof not on record, or a proof that does not convict its own subject |
| V9 | `membership: {id} actuates its round's declared action` | a `MemberAdmit`/`MemberExpel` whose `afp:actsOn` does not resolve to a DecisionRecord, or whose `afp:action` is not that round's policy action for that outcome, or whose round pins no `afp:governanceSubject` |
| V10 | `membership: {id} names the subject its round decided` | the actuation's `object` is not the round's `afp:governanceSubject` |
| V11 | `evidence: {id} cited proof convicts the enrolling agent` | a cited proof that fails `convicts`, or convicts an agent other than the Enroll's subject |
| V12 | `evidence: {id} cited proof resolves to a key` | **never fails** — records `unresolvable` when the signer's key is absent from the replay's merged key table (Decision 5b), so the census shows it |
| V13 | `evidence: {id} prior-proof declaration is not contradicted` | `afp:priorProofs` omits a proof that is on record in this replay and convicts the declaring agent |
| V14 | `claim: {vm} revocation does not predate a proof against it` | a key-history entry with `afp:retiredBy: "revocation"` whose `validUntil` cut precedes the `published` of any vote embedded in an on-record proof convicting that key's actor (Decision 4d) — **replay-wide**, since the proof and the key history routinely sit in different bundles |

V11–V13 run in the **replay-wide layer** beside ADR-0020's `check_equivocation_proofs`,
for the reason that ADR learned the hard way: a cited proof convicts a foreign actor whose
key lives in a different bundle.

#### V4's scoping, which the survey found the hard way

**A hub's membership is the hub's fact, and a member's bundle holds only its own half.**
The Enroll trail that `electorateOf` folds lives on the hub host's chain plus each
member's own; a peer's bundle carries its own Enroll and the proposal it received, and
nothing else. Running V4 per domain therefore fails every non-host bundle in the
repository — this was measured, not predicted (W6 below has the numbers, and the first
draft of this ADR got it wrong).

So V4 and V6 are **replay-wide and three-valued**, exactly like Decision 5b's evidence
check:

| Outcome | When | Replay |
|---|---|---|
| holds | the merged pool resolves the hub's Enroll trail and the partition is exact | passes |
| fails | the trail resolves and a member is neither pinned nor declared | **fails by name**, attributed to the domain holding the proposal |
| unresolvable | the replay contains no Enroll trail for this hub at all | **passes, counted in the census** |

This is the second time in two ADRs that a check about a fact owned by *another* domain
was first written as if one bundle could answer it. Worth naming as a rule rather than
fixing twice more: **a check whose evidence is owned by a different party belongs in the
replay-wide layer.** ADR-0020's V4 (a proof's foreign signing key) and this ADR's V4 (a
hub's foreign Enroll trail) are the same shape, and an implementer meeting a third one
should recognise it on sight.

### W4. Work packages

Disjoint file ownership, the standing convention. **A package may not edit a file it does
not own** — if you believe you must, stop and record it as a seam instead, because that
belief has been wrong three times in this repository and right zero times.

| WP | Owns (may edit) | Must NOT touch | Content | Depends on |
|---|---|---|---|---|
| **WP-1 · builders** | `src/instance/src/hub/activities.ts`, `src/instance/src/ap/activities.ts` | anything in `hub/hub.ts`, any verifier file | W1's schemas as builder functions + TS types; no logic, no I/O | — |
| **WP-2 · electorate** | `src/instance/src/hub/electorate.ts` (new), `src/instance/src/hub/store.ts` | `hub.ts` | `electorateOf`, `causeResolves`, the conviction-state table; pure functions | WP-1's types |
| **WP-3 · hub** | `src/instance/src/hub/hub.ts` | everything else in `src/instance/src` | `proposeRound` emits `afp:excluded` and validates causes before signing; claim receive path; governance-subject rounds | WP-1, WP-2 |
| **WP-4 · verifier core** | `src/verifier/electorate.py` (new), `src/verifier/decision.py` | `afp_verify.py` | `electorate_of`, `cause_resolves`, `zero_state`; V3–V10 | — (mirrors W2 from the ADR text, **never from the TypeScript**) |
| **WP-5 · verifier replay-wide** | `src/verifier/afp_verify.py` | `decision.py`, `keys.py` | V4/V6 three-valued, V11–V14 beside `check_equivocation_proofs`; the new census families | WP-4 |
| **WP-6 · gate + spec** | `src/instance/test/adr0021.test.ts` (new), `docs/afp/02-hubs-and-state.md`, `docs/afp/03-coordination.md` | all source | W5's matrix; 03's portability narrowing (4d) and the governance-round text | all |

WP-4 mirroring **from the ADR rather than from the TypeScript** is not a style
preference: the two implementations exist to disagree, and a Python port of a TypeScript
bug is a replay that confirms its own writer's mistakes.

**Build order, and how to run it.** WP-1 and WP-4 have no dependencies and may start
together; WP-2 needs WP-1's types; WP-3 needs both; WP-5 needs WP-4; WP-6 needs
everything.

**Land it in two slices, and land the first one on its own.** Slice one is
**Decision 1** (V1, V2) — the Unenroll authority binding and the timed fold. It is a
handful of lines in `hub.ts` and `decision.py`, it needs no new wire property at all, and
it closes an unauthenticated membership-removal primitive that exists in the shipped code
today. Nothing else in this ADR is sound without it, and it is worth landing even if
nothing else here is ever built. Slice two is **Decision 2** (V3, V4, V5 +
`afp:excluded`), which has a measured compatibility baseline (W6). Decisions 3–5 follow
and may be sequenced freely.

**Per-package working rules, for an implementer picking up one package cold:**

- Read this ADR and the files your package *owns*. Read other packages' files only to
  call them; never edit them. If a change seems to require editing someone else's file,
  that is a seam to report, not a change to make.
- Every new property is emitted only when supplied (W0.6). Verify this by running the
  existing gate *before* your change and diffing one produced bundle after it: an
  unchanged caller must produce byte-identical output.
- Add your check names to `Report.census`'s `conditional` tuple in the same commit that
  adds the checks; a family that never prints its zero is invisible (finding 48).
- When you finish, run W7's definition of done in full. "Tests pass" is not it — the
  mutation rows must fail *for your named check*.

### W5. Gate matrix — `test/adr0021.test.ts`

Every row discriminating: the mutation must fail **for the named check**, not merely fail.

| # | Case | Asserts |
|---|---|---|
| G0a | An agent (not an instance) signs an `afp:Unenroll` naming a peer | the hub **drops it**, membership is unchanged, and the refusal is in the admission log — *the probe in Context Defect A, turned into a gate* |
| G0b | Mutation: that same Unenroll spliced into a bundle | fails **V1** |
| G0c | An instance unenrolls its own agent | admitted; membership shrinks; replays clean (self-preemption stays lawful) |
| G0d | An Unenroll published after a round closed | that round's recomputed weights are unchanged — fails **V2** if the untimed fold is used |
| G1 | A round pinning every enrolled member, no exclusions | replays clean; `electorate:` family runs non-zero |
| G2 | Mutation: drop one member from `afp:voters`, declare nothing | fails **V4** — *the defect this ADR was written for* |
| G3 | Mutation: advertise a snapshot digest of a different set | fails **V3** |
| G4 | A member excluded `not-live`, declared | replays clean — the honest, unfalsifiable case |
| G5 | An equivocator recused with its proof as cause | replays clean; the bar is recomputed over the remainder |
| G6 | Mutation: recuse a member citing a proof that convicts somebody else | fails **V6** |
| G7 | Mutation: recuse with `governance-subject` on a round pinning no subject | fails **V6** |
| G8 | Two seats under one operator, one recused | the remaining seat carries the whole operator weight (ADR-0005, unforked) |
| G9 | A governance round expelling its subject, subject recused | replays clean; `membership:` runs |
| G10 | Mutation: `MemberExpel` naming an agent that is not the round's subject | fails **V10** |
| G10b | Mutation: `MemberExpel` signed by the **hub actor** rather than carried as a member-ratified actuation | fails **V9** — 02's "never a signature from the hub's own key" |
| G11 | A compromise claim by the convicted agent's own instance | replays clean; state reads `zeroed-contested`; **weight is still zero** |
| G12 | Mutation: a claim published by a different instance | fails **V8** |
| G13 | Restoration by `MemberAdmit`, then a later round | the restored seat votes in the later round and **not** in the earlier closed one |
| G14 | An Enroll citing a genuine proof against the enrolling agent | replays clean; `evidence:` runs |
| G15 | An Enroll citing a proof whose signer's key is absent | **passes**, and the census shows the unresolvable count (W0.5) |
| G16 | `afp:priorProofs: []` contradicted by a proof in the same case file | fails **V13** |
| G16b | Mutation: the convicted actor revokes its key with a cut backdated before its own equivocating votes | fails **V14** — the proof stands; the erasure does not (Decision 4d) |
| G17 | A member's own bundle replayed alone, holding the proposal but not the hub's Enroll trail | V4 records **unresolvable**, never a failure — the scoping row, and the one an implementer will get wrong first |
| G18 | Every pre-ADR-0021 bundle, replayed jointly as it ships | V3 and V4 both hold; check counts change, pass status does not (W6's measured baseline) |

### W6. The compatibility survey — already run, results below

Decision 2 applies at L0, so it applies to bundles that already shipped. The survey the
first draft of this ADR deferred to implementation has been run instead (2026-08-22,
against every `export-*` directory in the tree), because deferring it would have shipped
a wrong risk assessment along with a wrong check.

**V3 — snapshot digest.** Every proposal in every shipped bundle already satisfies
`afp:quorumSnapshot == digest_of(sorted(afp:voters))`: 9 proposals across p2, p3,
p3-llm, p5, p5-llm, p6 and p6-llm, zero mismatches. The field has always been computed
correctly; it has simply never been checked. **V3 costs nothing to add.**

**V4 — electorate completeness.** Every *hub-host* bundle passes exactly
(`voters == enrolled member-role set`, no omissions): p2 30/30, p3 7/7, p3-llm 7/7,
p5 alpha 4/4, p6 atlas 5/5. There is **no historic liveness omission to grandfather** —
the honest-but-unfalsifiable `not-live` case does not occur in any shipped record.

Every *non-host* bundle "fails" — p5 bravo/gamma, p6 meridian/pelican/anchor/harbor —
and this is the scoping defect, not a data defect: those bundles hold the proposal as
received bytes and carry only their own Enroll, so a per-domain fold sees one member
where the proposal pins four or five. That measurement is what produced V4's three-valued
replay-wide scoping above.

**Consequences for the build, therefore:**

1. No demo needs regenerating, and no bundle needs grandfathering.
2. `afp:excluded` may be **required at L1 and optional at L0** without breaking anything,
   because at L0 the partition already holds with an empty exclusion list.
3. The risk in this ADR is **not** historic data. It is getting V4's scope right, and
   an implementer who wires V4 into the per-domain loop will see p5 and p6 go red
   immediately. That is the expected signal, and the fix is the replay-wide layer, never
   loosening the check.

### W7. Definition of done, per package

A package is done when: its own file(s) compile and every pre-existing test still passes;
its checks appear in the census with non-zero counts on at least one gate case; every
gate row naming it passes; **and every mutation row naming it fails for the named check
and no other**. `npm run gate` from `src/instance`, then the verifier against every
`export-*` bundle with pass status unchanged from before the package landed.

## Open questions — resolve before or during implementation

Recorded rather than guessed, because each one changes code and none of them is a detail
a hurried implementer should decide alone.

1. ~~**Does `afp:excluded` become required at L0, or only at L1?**~~ **Resolved by W6's
   survey:** required at L1, optional at L0, because every shipped L0 bundle already
   satisfies the partition with an empty exclusion list. Kept here rather than deleted,
   per the standing rule that a question which quietly disappears teaches a later reader
   nothing.
2. **Who may pin `afp:governanceSubject`?** Today any proposer can. Should a governance
   round require the subject to already have a proof or a dispute on record, so that
   "convene a round about you" is not itself a harassment primitive?
3. **What happens when recusal empties the electorate**, or drops it below the point where
   the pinned quorum form is meaningful? A floor rule, a named `no-decision` reason, or
   nothing?
4. **Does V14 belong in ADR-0012 rather than here?** It is a key-history rule, and
   `keys.py` is ADR-0012's file. It is placed here because the hazard is only visible
   from the conviction side, but an implementer may reasonably conclude the check should
   live beside the other interval checks. Either location is defensible; pick one and
   record it.
5. ~~**Can a restored agent be re-convicted on the same proof?**~~ **Resolved in the
   build, and now a stated rule:** a restoration masks every conviction recorded before
   it, for rounds pinned after it. `isZeroedFor` reads the conviction only when no
   restoration for that actor sits between the convicting round and the round being
   weighed — so the old proof cannot re-zero a restored seat, and a *new* conviction
   after the restoration zeroes normally. Forgiveness is forward-scoped in exactly the
   direction conviction is, which is what keeps one rule where two would otherwise grow.
6. ~~**Does an expelled member's weight leave the denominator of rounds pinned after the
   expulsion?**~~ **Confirmed against the built code, not assumed:** yes, and by the
   mechanism the question guessed. An admitted `afp:MemberExpel` calls the same
   `removeAgent` an `afp:Unenroll` does, so the seat is gone from the membership CRDT and
   `proposeRound` — which pins only current member-role agents — never sees it again. No
   expulsion-specific weight path exists, which is Decision 3's table holding: the
   denominator moves because the snapshot moved.
7. **Hub-scoped and transport keys are outside `afp:keyHistory` entirely.** Only the
   instance key and per-agent P1 keys are collected (`export.ts`), so a compromised
   hub-scoped or transport key can be neither recorded nor interval-checked — the
   per-key compatibility path swallows it silently. It does not block this ADR (L1 votes
   are signed with agent P1 keys, which *are* in the history, so V14 applies), but it is
   a live hole in the same family and belongs in whatever ADR next touches ADR-0012.
8. **Should `afp:role` on an Enroll become conditional?** It is emitted unconditionally,
   the sole exception to the emit-on-supply idiom every other optional field follows.
   Harmless today, but it is the idiom new implementers copy from.
9. **`afp:reputationRule` consuming proofs** (finding 65's third limb) is named in the
   triage and *not* decided here. It stays open, and this ADR does not block it.

## Build status

**Decisions 1 and 2 built** (2026-08-22), in the two slices W4's build order names.

**Slice one — Decision 1.** `Hub.onUnenroll` resolves the agent's `afp:operatedBy` and
refuses anyone else, logging through `logAdmission` as `onEnroll` already does;
`check_enroll_authority` widened from `type != "afp:Enroll"` to both membership verbs,
recording `unenroll: {agent} unenrolled by its own instance`; `enrolled_instances` gained
the `at_millis` cutoff. `writeAdmitted`'s comment now states the door-knock exemption as
a per-handler obligation rather than as a property of a pair.

One correction the build forced, worth recording because it silently weakened the cutoff:
the instant is the **proposal activity's** `published`, resolved through a new
`proposal_activity_for`. The long-standing idiom
`proposal.get("published") or decision_activity.get("published")` always fell through to
the *decision's* instant, because an `afp:Proposal` payload never carries `published` —
which is late enough to admit exactly the membership acts the cutoff exists to exclude.
ADR-0005's `effective_operator` reads the same corrected instant.

**Slice two — Decision 2.** `afp:excluded` on the proposal, emitted only when there is
something to declare; the hub computes it at propose time from its own state; V3 (the
snapshot digest) and V5 (status forms) per domain in `decision.py`; V4 (the partition)
replay-wide and three-valued in `afp_verify.check_electorate`, beside ADR-0020's
`check_equivocation_proofs` and for the same reason.

Two things surfaced that design had not:

1. **The status registry was incomplete.** ADR-0018's own gate pins three of four live
   enrolled members, citing 02's proposer-declared electorate. With only `not-live` and
   `recused` the hub's options there were to lie, to refuse a call 02 permits, or to emit
   a bundle its own verifier fails. `not-pinned` was added — see Decision 2's table. A
   registry that cannot express a case the repository already exercises is incomplete,
   and the existing gate found it in the first build minute.
2. **G0d was not discriminating, and the fix was arithmetic.** Two seats under one
   operator recompute to 1/1 whether or not the membership cutoff applies, so the row
   passed with its own fix reverted. Three seats under one operator recompute to 1/1/1
   pinned versus 2/1/1 unpinned, which discriminates. Every row in this gate was then
   checked the same way: revert its fix, confirm that row — and only that row — goes red.

Check counts rose on every bundle carrying a proposal (p2 656→658, p3 452→454, the p6
joint replay 441→445) with pass status unchanged everywhere, which is W6's measured
prediction holding.

**Decisions 3, 4 and 5 built** (2026-08-23), in one pass across WP-1/2/3 (TypeScript) and
WP-4/5 (Python), the two halves written against this ADR rather than against each other.
`test/adr0021.test.ts` now carries all of W5's matrix — 24 cases, full suite green at 221
— and every mutation row was checked the way slice two established: revert its fix, and
confirm that row, and only that row, goes red.

What landed: `afp:excluded` gained the `recused` status and its `afp:cause` registry, with
`Hub.proposeRound` taking a `recused` list it validates against its own conviction table
*before signing* (G5b — the same refusal ADR-0018 gives an unrecomputable quorum rule);
`afp:governanceSubject` on the proposal; `afp:KeyCompromiseClaim` on the instance's own
chain, admitted, checked for standing, and then deliberately inert; `afp:MemberExpel` and
`afp:MemberAdmit`, 03's vocabulary since v1, built for the first time as ADR-0019
actuations rather than hub commands; a `hub_restorations` table that makes `isZeroedFor`
forward-scope forgiveness exactly as it already forward-scoped conviction; and
`afp:evidence`/`afp:priorProofs` on the Enroll. On the verifier side, V6, V8-V14 and the
five new census families, with V6 replay-wide and three-valued beside V4 for the reason
W3 already gave.

Check counts on shipped bundles did **not** move (p2 658, p3 454, the p6 joint replay
445), which is the correct result and worth stating: every check in these three decisions
is conditional on material no bundle written before them carries.

**Three things the build found that the design had not**, all three the same shape — a
rule stated about a *party* where the mechanism is about a *key*, which is this campaign's
own through-line arriving inside its own ADR:

1. **V8 was stricter than its gate row, and the gate row was wrong.** The first G11
   named the convicted agent's own key as `afp:verificationMethod`. Under
   `keyCustody: "instance"` — the default here, and what every shipped bundle uses — an
   agent's activities are signed by its *operating instance's* key, so the claim was
   answering about a key the proof never used. The verifier refused it, correctly. A
   claim names the method that actually signed the votes.
2. **V12's third value was unreachable.** As first written, the evidence check scanned
   own-outbox Enrolls only — and an Enroll is issued by the enrolling agent's own
   instance, so the key that signed any cited proof is in that same bundle by
   construction. `unresolvable` was a branch no honest bundle could take, which is a dead
   field wearing a control-flow disguise (W0.8). Decision 5b's own motivating case is a
   *foreign* Enroll arriving at a hub host, where it lands in `received.jsonld`; V11-V13
   now scan received bytes too, and G15 builds exactly that bundle.
3. **V14 did not fire on the attack it exists to stop.** It matched a key-history entry's
   `afp:actor` against the embedded votes' `actor` — which never compare equal under
   instance custody, so G16b's backdated revocation retired the evidence in silence while
   the check stayed quiet. It matches on the embedded vote's own
   `proof.verificationMethod` now: the rule is about the key that signed, and that is
   custody-correct in both directions.

**Wired into the P6 demo (2026-08-23), which found two more.** `npm run demo:p6` now
runs the whole arc rather than stopping at conviction: the equivocator is convicted, its
operator publishes an `afp:KeyCompromiseClaim` that changes nothing, the pool opens a
governance round with the accused recused by the proof that convicted it, a member (never
the hub) carries out the `afp:MemberExpel`, and the next round pins four seats with
nothing to declare. `demo:p6:llm` runs the seat question through the same local models
that made the determination. Both replay clean, five bundles jointly, at 559 checks.

1. **A compromise claim has no lawful carrier across a boundary.** Decision 4a says where
   a claim lives — the instance's own chain — and says nothing about how the pool that
   must weigh it ever receives a copy. ADR-0008's grants admit task verbs
   (`direct-delegation`) and anything carrying an `afp:hub` (`hub`); a
   `Create{afp:KeyCompromiseClaim}` is neither, so the peers' own boundary gate refuses
   it. Measured by trying, not predicted. The demo therefore addresses it to nobody and
   says so: the other operators read the claim in the joint case file. Not fixed here —
   fixing it means either a new grant type or an `afp:hub` on the claim, and both are
   wire decisions that belong in whatever ADR next opens ADR-0008's grant registry.
2. **A ratified expulsion was invisible to the electorate fold**, and this one was a
   defect rather than a gap. The hub admits the `MemberExpel` and drops the seat from its
   membership CRDT, but `enrolled_roles_at` reads only `afp:Enroll`/`afp:Unenroll` — so
   the verifier still believed the expelled agent was a member-role seat, and **every
   round pinned after a lawful expulsion failed V4 by name, forever.** An honest hub
   carrying out a decision its own members ratified could no longer produce a passing
   bundle. The fold now consumes ratified membership actuations as the membership acts 03
   has always said they are, forward-scoped like everything else. Note why the obvious
   alternative is unavailable: the hub cannot emit an `afp:Unenroll` on the expelled
   agent's behalf, because Decision 1 binds an Unenroll to the agent's *own* operating
   instance. Decisions 1 and 4b have to interlock, and this is where they meet.

The pattern is the campaign's own, for the fourth time: a mechanism attached to the wrong
thing, invisible until something was built on top of it. Both were found by building the
demo, which is the argument for building one.

**Open question 4 is resolved by placement:** V14 lives here, in `afp_verify.py`, not in
ADR-0012's `keys.py`. It is replay-wide because the proof and the erasing key history sit
in different bundles by construction — the party publishing the history is the party the
proof is about — and `check_key_intervals` is a per-domain check. Either location was
defensible; this one is picked and recorded.

## References

- [Scenario 12 — The parametric trigger](../scenarios/12-the-parametric-trigger.md), findings 59, 64, 65
- [ADR-0020](0020-p6-hardened-round-stack.md) — the conviction, the denominator ruling this ADR honours, and the replay-wide key table Decision 5b depends on
- [ADR-0005](0005-operators-are-equal.md) and its amendment — the weight arithmetic recusal recomputes over, unforked
- [ADR-0014](0014-p5-shared-hub-stack.md) — `afp:uncounted`, the declare-the-absence move Decision 2 applies to the electorate
- [ADR-0019](0019-acting-on-a-decision.md) — the action policy and actuator Decision 4b reuses without extension
- [ADR-0012](0012-the-long-horizon.md) — rotation and revocation, which Decision 4c must not contradict
- [03 — Coordination](../03-coordination.md) § the vocabulary table (`afp:GovernanceDecision`, `afp:MemberAdmit`/`afp:MemberExpel`) and § Consensus hardening
