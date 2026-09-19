# Scenario 14 — The seat migration: an instance leaves a hub, and comes back

> Spec-test scenario, written under [ADR-0030](../adr/0030-scenario-re-walks-and-the-coverage-index.md)
> Decision 3. Closes [ADR-0023](../adr/0023-loose-ends-triaged.md) row **L14** and the
> loose end [ADR-0017](../adr/0017-standards-conformance.md) named in its own
> Consequences: "the hub's implicit seat derivation is replaced by explicit Follow/Accept
> state — a behavior change to enrollment that needs its own migration note in 02 and a
> scenario." The migration note exists (02 § Hub-level Follow/Accept). This is the
> scenario. It walks one instance's seat from `Follow` through `Undo{Follow}` and back to
> a revived `Follow`, under **both** seat policies the built hub actually runs today —
> `enroll-implies-seat` (the shipped default) and `follow-required` (ADR-0017 Decision 4's
> conformant target, not yet the default: that flip is
> [ADR-0032](../adr/0032-deployment-profile.md) Decision 6, unbuilt). Deliberately does
> not build or simulate the flip itself — it walks the two policies exactly as they exist
> in `hub/hub.ts` today, side by side, so the difference the flip will make is visible
> before anyone makes it.

| **Support status** | **Supported — findings 84–89** |
|---|---|
| Findings raised | 6 |
| Resolved by | finding 87 — closed (ADR-0032 D6); the rest, candidates named below |
| See it run | — the gate covers it: no shipped demo calls `followHub`/`unfollowHub` (checked against `demoP5.ts`, `demoP6.ts`, `demoP7.ts`'s headers) |
| Gated by | `adr0017-d4-follow.test.ts` |

**Read the walkthrough below as history**, in the same spirit as every other scenario:
what strained on 2026-09-13, against the build that existed that day. The
[support index](README.md#is-this-workload-supported) carries the current-status view.

## User story

**As** the operator of a boutique firm whose seat at a partner's standing hub tracks a
single retainer,
**I want** the hub's record to show, unambiguously, when my instance held a seat, when it
left, and when it came back,
**so that** a dispute about "were we even a member when that vote happened" is answered
by replaying the record rather than by asking anyone to remember.

## Cast

One hub, one instance, one relationship, walked twice — once under each seat policy the
hub supports.

| Instance | Role | Capability |
|---|---|---|
| `partner.example` (**hosts `nightdesk`**) | hub operator | — |
| `boutique.example` (**the seat in question**) | instance holding (or losing, or regaining) a seat; one agent, `b-assessor` | `afp:cap:assess` |

The contract behind the seat: a quarterly retainer, same shape as scenario 13's pool but
with only one outside firm — the retainer lapses, the firm's seat should lapse with it,
and six months later a new retainer is signed and the firm comes back. Nothing here is
adversarial; every activity in this walkthrough is honestly signed by the party it claims
to be from. The question is entirely what the record *shows*, not who is lying.

## Walkthrough

**1. Under `enroll-implies-seat` — the shipped default — there is no seat to lose,
because there was never one to hold.** `boutique.example` sends `afp:Enroll` for
`b-assessor` directly; `Hub.receive` admits it with no `Follow` precondition at all — the
seat is derived implicitly from the Enroll trail, exactly as `hub/hub.ts`'s own comment
says: `seatPolicy` defaults to `"enroll-implies-seat"`, which "keeps every existing hub
test's behavior byte-identical." The retainer lapses at quarter's end. Nothing happens on
the record. Boutique simply stops sending activities. Six months later the new retainer
is signed and `b-assessor` re-enrolls; the hub admits it exactly as it did the first time,
because nothing was ever revoked.

**This is the scenario's first and sharpest finding, and it costs nothing to state
plainly: under the default policy, "leaving" is not an event.** An auditor replaying the
export six months later sees two `Enroll` activities from `boutique.example` with a gap
between them, and the record offers no way to distinguish that gap from an instance that
simply had no work to send for two quarters. The retainer's lapse — the fact the story
turns on — exists nowhere in `nightdesk`'s outbox. (**Finding 84.**)

**2. Under `follow-required` — the conformant target ADR-0017 Decision 4 built and
ADR-0032 Decision 6 will one day default to — leaving is an act on the record.**
`boutique.example` first sends `Follow{object: nightdesk}`; the hub's `Accept` names the
Follow's own activity id as its object and carries a proof, and `boutique.example` now
appears in `hub.followers()`. Only now does `afp:Enroll` for `b-assessor` succeed — under
this policy, `Hub.receive` checks `hasSeat(this.db, origin)` before admitting an Enroll
at all, and an Enroll from an unseated origin is refused with a reason on the admission
log: `"no seat: instance ${origin} has not Followed this hub (ADR-0017 D4)"`. The refusal
is not silent — 08's finding 26 (a hard-rejected stranger leaves no trace) does not repeat
here, because the refused party is a known origin and the log names it by that origin,
with the ADR that governs the rule cited in the reason string itself.

**3. The retainer lapses, and `Undo{Follow}` says so.** `boutique.example` sends
`Undo{Follow}` naming its own prior `Follow` as `target`. `Hub.receive` revokes the seat
— `boutique.example` drops out of `hub.followers()` — and **mass-unenrolls every agent
that instance had enrolled**: `b-assessor` drops out of `hub.members()` in the same call,
with no separate `Unenroll` activity required or produced. This is the mechanism finding
1's gap needed and doesn't have under the default policy: the retainer's lapse is now one
signed activity, on the record, at the instant it happens.

**But the mass-unenroll is a side effect with no stated treatment of work already in
flight.** If `b-assessor` held an open `correlationId` — a task awarded but not yet
answered — at the instant the Undo lands, nothing in `hub/hub.ts` or `store.ts`
distinguishes that case from an agent that had nothing outstanding. The seat vanishes,
the agent drops off the roster, and any Result `b-assessor` might still produce arrives
from an unenrolled agent with no rule for what the hub does with it. 08's finding 28 built
exactly this distinction for an *agreement's* expiry — new work stalls, in-flight work
runs to its terminal outcome — and the ruling there was explicit that the alternative (an
expiry that kills in-flight work) "would turn every agreement's last week into a dead
zone." A seat's revocation is more abrupt than an agreement's expiry (there is no
retainer-end grace period modeled at all — Undo is instantaneous), which makes the
unanswered question sharper here, not milder. (**Finding 85.**)

**4. Six months later, `boutique.example` re-Follows, and the seat comes back empty.**
A fresh `Follow{object: nightdesk}` lands; the hub's `Accept` re-admits
`boutique.example` to `hub.followers()`. 02's own account of this path is explicit and is
the one this beat confirms rather than contradicts: "a later re-Follow revives the seat
empty, enrollment starting" — and the gate's own test is named for exactly this,
"re-Following after Undo revives the same seat." `b-assessor` sends a fresh `Enroll` and
is admitted, under the same `hasSeat` check as beat 2. Nothing carries forward from the
first seat: no prior role, no prior capability grant survives the Undo — `b-assessor`'s
second `Enroll` restates `afp:cap:assess` from scratch, and the hub has no memory that
this is a *returning* agent rather than a new one, beyond the actor id itself being the
same string in both `Enroll` activities. That is enough for a replay to prove it is the
same actor; it is not enough to answer "did this seat's standing (any accumulated
reputation, any prior role above `member`) survive the gap" — the record's honest answer
is that nothing above bare re-enrollment was ever asked to survive, because nothing in
the seat table stores anything but current membership.

**5. The compat proof, read the other way round.** The gate's own name for this case —
"default seatPolicy (enroll-implies-seat) still enrolls without any Follow — the compat
proof" — is doing real work for an operator who has not yet taken ADR-0032 Decision 6:
a hub run today, with no configuration at all, behaves exactly as every pre-ADR-0017
test assumed. Reading it from this scenario's seat, the same fact is the finding from
beat 1 restated structurally: the compatibility the proof protects *is* the absence of a
`Follow` precondition, which is the same absence that makes leaving unrecordable. The two
are the same fact, described from the builder's side and the auditor's side.

**6. Nothing here touches governance weight, and that turns out to be right, not an
oversight.** `boutique.example` never held a vote in this walkthrough — one agent, one
capability, no round — so whether a seat revoked mid-quorum-round changes a pinned
electorate never comes up. It is worth naming rather than leaving implicit: ADR-0018
Decision 5 already pins a round's electorate and weights at open time precisely so that
membership churn mid-round cannot retroactively change who was entitled to vote in it.
A seat lost between beat 3 and a hypothetical open round would show up in the *next*
round's electorate, never the one already pinned — the mechanism this scenario would need
already exists one ADR over, and re-testing it here would only repeat scenario 12's own
walk of quorum arithmetic under churn. Noted and not exercised. (**Finding 89**, filed as
narrowed rather than open, precisely because ADR-0018 already answers it.)

## Acceptance criteria → mechanisms

| Criterion | Mechanism | Status |
|---|---|---|
| A seat can be sought explicitly, and admitted with proof | `Follow` → hub `Accept{object: the Follow id}`, proof present | Yes (beat 2) |
| Enrollment can be gated on a live seat | `follow-required`: `hasSeat` check before `Enroll` admits | Yes (beat 2) — **not the default, finding 84/89** |
| Enrollment without any seat concept is still possible | `enroll-implies-seat` (default): `Enroll` alone admits | Yes (beat 1) — **and that is the whole gap, finding 84** |
| A seat's loss is an event on the record | `Undo{Follow}`, mass-unenrolling that instance's agents in the same call | Yes (beat 3) — **only under `follow-required`; in-flight work unaddressed, finding 85** |
| A lost seat can be regained | Re-`Follow` after `Undo`, hub re-`Accept`s | Yes (beat 4) — **revives empty; no continuity claim made or checked, finding 86** |
| A refusal for lack of a seat is on the record, not silent | Admission log entry naming the ADR and the reason | Yes (beat 2) |
| Revoking a seat unenrolls only that instance's agents, not the hub's other members | Mass-unenroll scoped by origin | Yes (per `adr0017-d4-follow.test.ts`'s own multi-instance case, cited not repeated here) |
| The default policy is the conformant one | — | **No — finding 87; ADR-0032 D6 is the flip, unbuilt** |
| A seat revoked between rounds cannot retroactively change a pinned electorate | ADR-0018 Decision 5's pinned electorate/weights | Yes, by a mechanism built for a different scenario — **narrowed here, finding 89** |

## Spec verdict

**Held: the mechanism ADR-0017 Decision 4 built does exactly what it says.** Every beat
of the `follow-required` half ran without a single surprise — `Follow`/`Accept` establish
a seat with proof, `Enroll` is gated on it by name, `Undo{Follow}` revokes it and
mass-unenrolls in one call, and a re-`Follow` revives it. The seven-case gate
(`adr0017-d4-follow.test.ts`) that exists for this mechanism turns out to *be* this
scenario's walkthrough already, one layer down — which is itself worth stating, since it
means this scenario adds no new implementation pressure, only the naming ADR-0023 L14
asked for.

**Strained — six findings, opening the current campaign alongside scenario 16:**

84. **Under the shipped default, "leaving" is not a mechanism.** `enroll-implies-seat`
    derives a seat implicitly from the Enroll trail and revokes nothing — an instance
    whose retainer lapsed and one that merely went quiet for two quarters are the same
    shape in the export. Candidate: none needed beyond ADR-0032 Decision 6 itself —
    the finding is that today's default is the gap, and the fix already has an ADR
    number and is simply not yet the default.

85. **A revoked seat's in-flight work has no stated rule.** `Undo{Follow}`'s
    mass-unenroll is unconditional and instantaneous; nothing distinguishes an
    unenrolled agent with an open `correlationId` from one with none. Candidate: the
    same terminal-outcome discipline 08's finding 28 gave agreement expiry — an
    unenrolled agent's already-awarded work runs to its terminal outcome before the
    unenrollment forecloses further activity on that correlation, with new work refused
    from the Undo instant.

86. **A revived seat carries no stated continuity.** Re-`Follow` after `Undo` "revives
    the seat empty" by design (02's own words), but nothing states — or checks — whether
    any standing above bare membership (role, reputation, capability grants) is expected
    to survive the gap, versus start over. Candidate: a sentence in 02 stating the
    empty-revival rule explicitly as a rule rather than an implementation fact, so a
    future reader does not have to infer it from test names.

87. **The conformant policy is not the default.** ADR-0017 Decision 4 named
    `follow-required` the conformant target and shipped it opt-in; a hub run with no
    configuration today runs the policy this scenario shows has the seat-loss gap.
    **Closed (ADR-0032 D6):** the default flipped — `Hub`'s `seatPolicy` now defaults to
    `follow-required`, `enroll-implies-seat` remains available as an explicit setting, and
    every shipped demo Follows before it Enrolls. See the coverage re-walk above.

88. **Follow/Undo churn itself is not logged as an admission event.** The admission log
    (`admissionLog`) records `Enroll` outcomes; a `Follow`/`Undo{Follow}` cycle that
    never reaches an `Enroll` leaves the outbox activities themselves as the only trail
    — sufficient for replay, but there is no single log a hub operator can read to see
    "who has joined and left the hub" without reconstructing it from Follow/Undo pairs
    across every instance's chain. Candidate: an admission-log style entry (or a derived
    view) for seat changes themselves, parallel to the one Enroll already gets.

89. **Seat loss mid-round and a pinned electorate — answered elsewhere, narrowed here.**
    Not exercised in this walkthrough (no round was open), but worth naming: ADR-0018
    Decision 5 already pins a round's electorate and weights at open time, so a seat
    lost between rounds affects only the next round's electorate. Filed narrowed, not
    open — the mechanism exists; this scenario simply never gave it a round to protect.

## Coverage as of 2026-09-13

Per ADR-0030 Decision 1. No demo runs any beat of this scenario — `followHub` and
`unfollowHub` are called from no `demoP*.ts` file today (checked: `demoP5.ts`,
`demoP6.ts`, `demoP7.ts` build hubs and enroll agents but never Follow one) — so every row
is at best mechanism gated, and the unbuilt default flip is honestly edge not built.

| Criterion | Class | Evidence |
|---|---|---|
| A seat can be sought explicitly, and admitted with proof | mechanism gated | `test/adr0017-d4-follow.test.ts` "Follow establishes a seat, and the hub answers Accept…" |
| Enrollment can be gated on a live seat | mechanism gated | `test/adr0017-d4-follow.test.ts` "Enroll without a seat is rejected under follow-required…" |
| Enrollment without any seat concept is still possible | mechanism gated | `test/adr0017-d4-follow.test.ts` "default seatPolicy (enroll-implies-seat) still enrolls without any Follow…" |
| A seat's loss is an event on the record | mechanism gated | `test/adr0017-d4-follow.test.ts` "Undo{Follow} revokes the seat and mass-unenrolls only that instance's agents" |
| A lost seat can be regained | mechanism gated | `test/adr0017-d4-follow.test.ts` "re-Following after Undo revives the same seat" |
| A refusal for lack of a seat is on the record, not silent | mechanism gated | `test/adr0017-d4-follow.test.ts` (same case) — admission-log assertion on the reason string |
| Revoking a seat unenrolls only that instance's agents, not the hub's other members | mechanism gated | `test/adr0017-d4-follow.test.ts` "Undo{Follow} revokes the seat…" — two-instance case |
| The default policy is the conformant one | edge not built | [ADR-0032](../adr/0032-deployment-profile.md) Decision 6 — cited, unbuilt |
| A seat revoked between rounds cannot retroactively change a pinned electorate | narrowed | `test/adr0018.test.ts` pinned-electorate cases — built for a different scenario, not re-walked here |

**Counts:** 0 demonstrated · 7 gated · 1 narrowed · 1 not built.

## Coverage as of 2026-09-13 (after the default flip)

Per ADR-0030 Decision 1, re-walked after [ADR-0032](../adr/0032-deployment-profile.md)
Decision 6 built. The default `seatPolicy` is now `follow-required`, and every demo this
gate runs (`demo:p2`, `demo:p3`, `demo:p5`, `demo:p6`, `demo:p7`, `demo:p8`) Follows before
it Enrolls — the "no demo runs any beat of this scenario" reading above no longer holds:
`followHub` is now called from `demoP2.ts`, `demoP3.ts`, `demoP5.ts`, `demoP6.ts`,
`demoP7.ts` and `demoP8.ts`. Only rows the flip actually changes are reclassified below;
every other row keeps the prior section's class and evidence.

| Criterion | Class | Evidence |
|---|---|---|
| A seat can be sought explicitly, and admitted with proof | workload demonstrated | `npm run demo:p2` — the instance Follows the hub before enrolling; **was: mechanism gated** |
| Enrollment can be gated on a live seat | workload demonstrated | `npm run demo:p2` — under the new default, every demo's Enroll now rides a real prior seat; **was: mechanism gated** |
| Enrollment without any seat concept is still possible | mechanism gated | `test/adr0017-d4-follow.test.ts` "enroll-implies-seat, set explicitly, still enrolls without any Follow…" — now reachable only by explicit override, no longer the default |
| A seat's loss is an event on the record | mechanism gated | `test/adr0017-d4-follow.test.ts` "Undo{Follow} revokes the seat and mass-unenrolls only that instance's agents" |
| A lost seat can be regained | mechanism gated | `test/adr0017-d4-follow.test.ts` "re-Following after Undo revives the same seat" |
| A refusal for lack of a seat is on the record, not silent | mechanism gated | `test/adr0017-d4-follow.test.ts` "ADR-0032 D6: default seatPolicy is now follow-required…" — admission-log assertion on the reason string |
| Revoking a seat unenrolls only that instance's agents, not the hub's other members | mechanism gated | `test/adr0017-d4-follow.test.ts` "Undo{Follow} revokes the seat…" — two-instance case |
| The default policy is the conformant one | mechanism gated | `test/adr0017-d4-follow.test.ts` "ADR-0032 D6: default seatPolicy is now follow-required — an Enroll without a Follow is refused"; `src/hub/hub.ts` `seatPolicy` default; **was: edge not built — finding 87, now closed (ADR-0032 D6)** |
| A seat revoked between rounds cannot retroactively change a pinned electorate | narrowed | `test/adr0018.test.ts` pinned-electorate cases — built for a different scenario, not re-walked here |

**Counts:** 2 demonstrated · 6 gated · 1 narrowed · 0 not built.

## Coverage as of 2026-09-19 (after the operator got the commands)

Per ADR-0030 Decision 1, re-walked a third time after
[ADR-0039](../adr/0039-the-operator-takes-a-seat.md) built. The prior section recorded a
seat mechanism that was conformant and gated but reachable only from inside a demo or a
test — and this scenario's whole arc is an *operator* taking a seat, losing it and taking
it again. `POST /actor/command` and `npm run hub -- follow|unfollow|enroll|unenroll|list`
close that gap: the acts the earlier sections gated are now acts the operator of a running
instance can perform against it, signed as a controller, without opening the store.

What this does not change is the record. ADR-0039 publishes exactly the activities the
prior sections already gated — `Follow`, `Undo{Follow}`, `afp:Enroll`, `afp:Unenroll` — so
no row moves class on the strength of the mechanism. What moves is reachability, and the
rows below say so in their evidence. Only rows ADR-0039 touches are re-evidenced; every
other row keeps the prior section's class and evidence.

| Criterion | Class | Evidence |
|---|---|---|
| A seat can be sought explicitly, and admitted with proof | workload demonstrated | `npm run demo:p2` — the instance Follows the hub before enrolling; now also operator-reachable, `test/adr0039.test.ts` G3 "follow seats the operator's own instance, enroll adds an agent, and both reverse" against a real `serve` |
| Enrollment can be gated on a live seat | workload demonstrated | `npm run demo:p2` — under the `follow-required` default, every demo's Enroll rides a real prior seat (unchanged) |
| Enrollment without any seat concept is still possible | mechanism gated | `test/adr0017-d4-follow.test.ts` "enroll-implies-seat, set explicitly, still enrolls without any Follow…" — reachable only by explicit override (unchanged) |
| A seat's loss is an event on the record | mechanism gated | `test/adr0017-d4-follow.test.ts` "Undo{Follow} revokes the seat and mass-unenrolls only that instance's agents" — and the operator's path to it, `test/adr0039.test.ts` G3 (the "both reverse" half) plus G4's refusal-by-name when there is no live Follow; **finding 84's departure half closes here**: departure is a mechanism *and* a command |
| A lost seat can be regained | mechanism gated | `test/adr0017-d4-follow.test.ts` "re-Following after Undo revives the same seat" — re-`Follow` is `npm run hub -- follow` a second time; what a revived seat *carries* is finding 86, still open |
| A refusal for lack of a seat is on the record, not silent | mechanism gated | `test/adr0017-d4-follow.test.ts` "ADR-0032 D6: default seatPolicy is now follow-required…" — admission-log assertion on the reason string (unchanged); the operator-side refusal is `politeReply`, deliberately uninformative, `test/adr0039.test.ts` G4 |
| Revoking a seat unenrolls only that instance's agents, not the hub's other members | mechanism gated | `test/adr0017-d4-follow.test.ts` "Undo{Follow} revokes the seat…" — two-instance case (unchanged) |
| The default policy is the conformant one | mechanism gated | `test/adr0017-d4-follow.test.ts` "ADR-0032 D6: default seatPolicy is now follow-required — an Enroll without a Follow is refused"; `src/hub/hub.ts` `seatPolicy` default (unchanged; finding 87 closed) |
| A seat revoked between rounds cannot retroactively change a pinned electorate | narrowed | `test/adr0018.test.ts` pinned-electorate cases — built for a different scenario, not re-walked here; ADR-0039 gives the revocation a command, not the round a re-walk (unchanged) |

**Counts:** 2 demonstrated · 6 gated · 1 narrowed · 0 not built.

**What stays open after this walk.** Findings 85 (an unenrolled agent's in-flight work),
86 (what a revived seat carries) and 88 (Follow/Undo churn is not itself an admission-log
entry) are untouched by ADR-0039 — it makes the seat acts reachable, and none of the three
is about reachability. 88 is the one this walk sharpens: now that an operator can churn a
seat from a terminal in two commands, the absence of a seat-change log entry is far easier
to reach than it was when only a demo could do it.
