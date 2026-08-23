# 05 — Roadmap & open questions

## How the phases are ordered

Two rules shape the sequence, and they are the reason it was resequenced at v3.5.

**Every profile is a prefix, never a subset.** Phases add *participants*, not integrity
machinery. A solo operator runs P1→P3 and stops. A consortium runs P1→P7 in order. Nobody
cherry-picks a phase out of the middle, and nobody refactors when they federate — joining a
consortium is purely additive (see [06](06-deployment-profiles.md)). This is why hubs,
deliberation and allocation now sit *before* federation: none of them has a federation
dependency, and all three are immediately useful to a single operator.

**The audit properties are the floor, not a later phase.** Signing, hash-chained outboxes,
visibility classes and hash-addressed evidence all land in **P1**, at two agents, before
there is anything to federate. They cost almost nothing on day one and cannot be backfilled:
a chain that begins at activity 400 proves nothing about activities 1–399, and a Result
published without a visibility class has already been published. Every later phase inherits
them rather than adding them.

---

## P1 — One instance, two agents, one verifiable record

The smallest deployment that already proves the thesis. **No** hub, agreements, bidding,
voting, CRDTs, gossip, or Mastodon. Two agents in one process exchanging signed tasks — and
a record a stranger can verify. Stack decision:
[ADR-0001](adr/0001-p1-stack.md).

### Scope

| Area | What P1 builds |
|---|---|
| Identity | Instance actor (`afp:Instance`) + agent actors carrying `afp:operatedBy` and `afp:capabilities`, each publishing a **Multikey** in `assertionMethod`; WebFinger optional |
| Roster | The signed `OrderedCollection`, two entries, `afp:keyCustody: instance` — published from day one even though no peer reads it yet, and **derived from the instance's own `afp:Vouch` trail** rather than from configuration ([01](01-foundations.md#vouch--disown)) |
| Flow | `Offer{afp:Task}` → `Accept`/`Reject` → `Create{afp:Result}` or `Create{afp:Error}`, keyed by `afp:correlationId` ([03](03-coordination.md#task-delegation--the-v1-baseline-flow-unchanged)) |
| Signing | An **object integrity proof** (`eddsa-jcs-2022`) on every activity — the only signature that survives export, and therefore the only one a replay can check ([01](01-foundations.md#authentication--two-mechanisms-with-different-lifetimes)). HTTP Signatures only if P1 is wired over loopback HTTP |
| Transport | Outbox queue with backoff, dead-letter, and failures surfaced as local `Error`s |
| Timeouts | `afp:deadline` on delegated tasks and a delegator-side sweep: a performer that never answers yields a recorded `afp:Error`, because "thinking" and "dead" are otherwise indistinguishable ([04](04-operations.md#reliability--failure-handling)) |
| Idempotency | **Both** dedupe layers: transport dedupe on activity `id`, task-level replay on `correlationId` |
| Record | The four obligations below |

**Why the instance actor and roster are in P1 and not deferred to the federation phase:**
`afp:keyCustody` is declared *on a roster entry*, so without a roster there is nowhere to
state how an agent is wired; and agent actor documents published without `afp:operatedBy`
change their trust semantics the day it is added. Both cost one JSON document each.

### The four obligations, honored from activity #1

These are data-model decisions, not features. Each is nearly free at the start and
expensive-to-impossible to retrofit — which is exactly why they belong in the first phase
rather than the audit phase.

| Obligation | Rule | If deferred |
|---|---|---|
| `afp:visibility` | Every published activity declares a class — required, not inferred; a missing `afp:visibility` fails replay, and everything above `public` defaults **closed** ([07](07-visibility-and-artifacts.md#four-visibility-classes)) | A later default-to-public retroactively republishes client data |
| `afp:digest` | Mandatory on every attachment; bytes not matching the digest MUST be discarded ([07](07-visibility-and-artifacts.md#artifacts--attachments)) | Evidence already in the record is unverifiable forever |
| `afp:prevActivity` | Per-actor outbox hash chain, from each actor's first activity ([04](04-operations.md#outbox-integrity-hash-chained-logs-afpprevactivity)) | The chain has a hole at the beginning that can never be filled |
| `context` vs `correlationId` | Two distinct stored keys — thread and task ([03](03-coordination.md#correlation-vs-threading--two-distinct-ids)) | Reusing one id for both replays the wrong cached Result |

### The demo

**A draft, a critique, a revision — and a stranger who can prove it happened.**

Two agents, `writer` and `reviewer`, both instance-custody, wired in-process. A human hands
the writer a brief with one source document attached. Then:

```
writer  --Offer{Task: "review this draft"}-->  reviewer     context: https://writer.example/threads/doc-1
        <--Accept--                                          correlationId: task-1
        <--Create{Result: critique}--
writer  --Offer{Task: "review the revision"}-->  reviewer    correlationId: task-2
        <--Accept-- / <--Create{Result: approved}--
```

The writer drafts from the brief, delegates the review, **revises against the critique**,
and delegates again — one thread, two tasks, no network. The drafting itself is the
writer's own work rather than a delegated task, so it enters the record as a hash-addressed
attachment on the writer's signed Offer.

Then export the outboxes — the two agents' **and the instance's own**, which carries the
`Vouch` trail the roster is derived from — and hand them to **someone who was not there,
holds no keys, and has no access to the instance**. They run the replay procedure from
[04](04-operations.md#replay-procedure).

It passes. Then break it four ways, on purpose:

| Mutation | What fails | What it tests |
|---|---|---|
| **Flip one byte** of the archived source document | The attachment digest no longer matches | Evidence integrity |
| **Delete one activity** from the middle of an outbox | The next `afp:prevActivity` link | Log completeness |
| **Re-sign the last activity** with another agent's published key | No authority over that `actor` | Signer authority |
| **Delete a whole agent's outbox** | A rostered agent with no activities | Participant completeness |

The last two matter because a signature-only replay passes both: the chain does not protect
the *tail* of an outbox, and a per-actor chain cannot show that a participant is missing
entirely ([04](04-operations.md#signature-is-not-authority)).

**P1's deliverable is not a completed task. It is a record a stranger can verify and a
forger cannot quietly edit** — produced by a system with two agents and no network.

### Acceptance gate

P1 is done when every one of these is demonstrably true. They are the phase's definition of
done, not aspirations:

1. A second `Offer` with a `correlationId` already seen replays the cached `Result`; the
   agent brain is **not** invoked twice.
2. A redelivered activity `id` is dropped at the inbox *before* dispatch — a distinct layer
   from (1), with distinct storage.
3. An unsigned or bad-signature delivery is dropped **and** audit-logged. Never processed.
4. A delivery failure retries with backoff, dead-letters after N attempts, and surfaces as a
   local `afp:Error`. Nothing is silently dropped.
5. Every published activity carries an explicit `afp:visibility`; no code path defaults to
   `public`.
6. Every attachment carries `afp:digest`; a fetch returning non-matching bytes is discarded.
7. Each actor's outbox is an unbroken `afp:prevActivity` chain from its first activity, and
   a gap or fork is detectable from the chain alone.
8. The thread is grouped by `context`; no `correlationId` is reused across tasks.
9. The roster verifies as a whole against the instance key **from a cached copy**, with no
   live roundtrip.
10. Third-party replay by `context` succeeds on the clean export and fails, with a specific
    pointer, on each of **four** deliberate mutations: a flipped evidence byte, a removed
    activity, **an activity re-signed with another agent's published key**, and **a whole
    agent's outbox deleted**. The last two check *authority* and *completeness* rather than
    integrity, and a signature-only replay passes both
    ([04](04-operations.md#signature-is-not-authority)).
11. **The wiring is invisible.** Nothing in any actor document, activity, or outbox reveals
    that dispatch was in-process. This is the invariant that makes P2–P7 additive
    ([01](01-foundations.md#the-agentinstance-boundary-ports--adapters)) — a P1 record must
    be indistinguishable in shape from a federated one.

Check (11) is worth failing the phase over. If it holds, every later phase is a matter of
adding participants; if it does not, federation becomes a rewrite.

---

## P2–P7

Each phase is independently demoable, and earlier phases keep working unmodified as later
ones add capability around them.

> **Before P4 opens the federation door**, the solo foundation is hardened per
> [ADR-0004](adr/0004-solo-foundation-hardening.md) — **built**: enrollment roles
> (`member`/`requester`/`observer`), `afp:Asset` identity for reusable components, and
> recomputable reputation consumption (`afp:reputationRule` + `afp:settlementSnapshot`).
> All three are P1–P3-scoped record extensions that turn into migrations if deferred past
> the point where two operators share the state. Three further ADRs — likewise built —
> complete that first round: [ADR-0005](adr/0005-operators-are-equal.md) (one operator, one
> weight), [ADR-0006](adr/0006-checkable-actuation.md) (actions checkable against the
> answers that justified them), [ADR-0007](adr/0007-supersession.md) (retraction with
> ratification parity and dispositions).
>
> **A second round followed, and it is the more instructive one.** Campaign 6 found that
> the machinery above had anchored itself to the `Announce`/`Award` pair, so the
> *degenerate* direct flow — the one this spec tells deployments to use whenever the
> target is known — silently lost all of it.
> [ADR-0010](adr/0010-pinning-without-an-auction.md) gave the pins a second carrier and
> replay a second root; [ADR-0011](adr/0011-supersession-meets-the-irreversible-world.md)
> gave supersession an honest form where the world offers no undo, and settled who may
> answer after a panel changes; [ADR-0012](adr/0012-the-long-horizon.md) stopped a routine
> key rotation from stranding every export signed before it. All three are built.
> [ADR-0013](adr/0013-authorized-fetch.md) then built the read half of the P4 gate — and
> is the first ADR here driven by an **audit** rather than a scenario, because the spec had
> described that mechanism as working since v3.4 and no code performed it.
>
> The pattern worth carrying into P5: every one of these was a mechanism attached to the
> wrong thing, invisible until something was built on top of it. P5 introduces the richest
> set of new anchoring choices yet — remote hubs, relayed state, cross-instance enrollment
> — so the same class of defect should be expected there, and a scenario should go first.
>
> **It did, twice more, and the pattern held both times.** Campaign 7 (scenario 10) walked
> P5 before its stack ADR and produced [ADR-0014](adr/0014-p5-shared-hub-stack.md) and
> [ADR-0015](adr/0015-the-case-file-at-n-parties.md), both built;
> [ADR-0016](adr/0016-p5-transport.md) then built the transport that was P5's remaining
> scope, and **P5 is built**. Campaign 8 (scenario 11) found the same defect class one flow
> further out — the governance round is opened with `Offer{afp:Proposal}`, which is not a
> task-bearing activity, so it inherited none of the pinning, sufficiency or irrevocability
> machinery — closed by [ADR-0018](adr/0018-the-round-as-a-commitment.md) and
> [ADR-0019](adr/0019-acting-on-a-decision.md), both built. Campaign 9 (scenario 12) did it
> for P6; its state is below.
>
> Running alongside those, and driven by an audit rather than a scenario in ADR-0013's
> manner: [ADR-0017](adr/0017-standards-conformance.md) makes the ActivityPub-compatibility
> claim true — the `afp` context published at a canonical URL, RFC 9421 native with a cavage
> shim, dereferenced delivery with every advertised URL answering, WebFinger and FEP-521a
> transport keys, origin-minted `https` ids replacing `urn:afp:*`, and the deviations from
> ActivityPub given a normative home. Decisions 1-6 are built and 7 partially; **Decision 8
> (publishing an FEP) is deliberately deferred** — it is a public act, and the protocol is
> not ready for that audience yet.

| Phase | Scope | Demo | Gate |
|---|---|---|---|
| **P2 — Local hub & L0 deliberation** — **built**, stack in [ADR-0002](adr/0002-p2-hub-and-crdt-stack.md) | `afp:Hub` as a local route beside the agents, enrollment, hub-scoped CRDT capability registry, L0 weighted-quorum voting, `afp:DecisionRecord` closing every round, `afp:GovernanceDecision`, hub lifecycle (`Freeze`/`Archive`). Still one operator — the hub machinery has no federation dependency | *"30 agents agree on the best policy for codebase integrity"*: a local swarm deliberates and closes with a DecisionRecord — `npm run demo:p2` runs exactly this | Any member recomputes the weight tally from the recorded `countedVotes` and agrees; a vote missing from the tally is detectable from the record alone. **Holds:** the independent verifier recomputes the tally, demands every counted vote be producible, and rejects out-of-snapshot votes |
| **P3 — Local allocation** — **built**, stack in [ADR-0003](adr/0003-p3-allocation-stack.md) | `afp:Bid` with commit-reveal windows (one commitment per bidder, reveals after close), selection rules in both families (ranking **and** set-selection over `afp:coverage`), deterministic tie-break, `afp:Award` naming performer(s) and synthesizer, `afp:Reauction` with its reduced pool bound to the prior award, `afp:Synthesis`, `afp:Settlement`, estimator/bidder separation enforced at bid admission. Local bidding is real load balancing | A question no single agent covers, awarded to a coalition whose size the bid pool forced, answered by a ratified Synthesis carrying its dissent — `npm run demo:p3` runs exactly this, and `npm run demo:p3:llm` runs the same auction with the answers written by a real local model | Any member recomputes the published selection rule over the revealed bids and reaches the same performer set and synthesizer; every reveal matches its commitment hash. **Holds:** the independent verifier rebuilds the admitted bid pool from the record alone, reruns both rule families, and demands the recomputed performers, synthesizer and winning-bid digests equal the Award's — plus answer sufficiency, synthesis binding, and the estimator wall |
| **P4 — Federation handshake & operator visibility** — **built**, stack in [ADR-0008](adr/0008-p4-federation-stack.md) | `Offer{FederationAgreement}` → countersign → published trust anchor, `afp:MembershipProof`, deny-list and `afp:Defederate`, **payload integrity across the boundary carried by the existing `eddsa-jcs-2022` object proofs, with HTTP Signatures authenticating each hop** (ADR-0008 — no second signature suite), authorized fetch, both halves ([ADR-0013](adr/0013-authorized-fetch.md), built): non-`public` resources return 404 to everyone unentitled, and a signed request from an entitled peer is served — enrollment scoped to locally-hosted hubs until `afp:MembershipProof` exists, `afp:AuditGrant`, dual-publish shadow Notes and the narrow inbound command grammar | Two instances mutually recognize each other; an operator follows an agent from a **stock Mastodon account** and watches the thread | A validly-signed activity from an un-agreed instance is hard-rejected; a `parties` activity returns **404, not 403**, to a federated peer that is not named in it. **And the engagement joint-verifies** ([ADR-0009](adr/0009-federated-replay.md), built): both sides' exports replay in one command — one scoped with `afp:Redacted` stubs and a declared omission — passing clean while a deleted stub, tampered received bytes, or a two-story agreement each fail by name |
| **P5 — Shared hubs across operators** — **built**, stack in [ADR-0014](adr/0014-p5-shared-hub-stack.md), [ADR-0015](adr/0015-the-case-file-at-n-parties.md) and [ADR-0016](adr/0016-p5-transport.md) | Two-level enrollment and `afp:MembershipProof`, the hub's own HTTP inbox, hub-relayed digest exchange and anti-entropy (the NAT-realistic default), cross-instance CRDT sync carrying activities, artifacts served by each originating instance and never crossing the hub host, `hub` visibility enforced across the boundary on the read gate ([ADR-0013](adr/0013-authorized-fetch.md), built), the degraded mode when the host is partitioned, `afp:uncounted` for the silence a DecisionRecord could not name, the all-pairs join at N=3, and `Archive` carrying the converged state into the record once | A cross-operator task where the hub brokers discovery and allocation but sits on neither the payload nor the result path — `npm run demo:p5` runs three operators over real sockets and leaves three verifiable case files, and `demo:p5:llm` tells the same hub as scenario 11's snow day | Kill the hub mid-task: new allocation stalls, **in-flight work completes**. **Holds:** ADR-0016's T7 kills the host mid-task with in-flight mesh work completing, and the N=3 joint replay verifies counted votes that genuinely crossed a boundary, with a per-domain check census so a bundle that checked nothing is visible |
| **P6 — L1 Byzantine voting** — **built**, stack in [ADR-0020](adr/0020-p6-hardened-round-stack.md) and [ADR-0021](adr/0021-conviction-to-consequence.md) | Chained signed votes (`afp:observedVotes`, `afp:seqNo`, `afp:proposalHash`), `afp:EquivocationProof`, snapshot-pinned membership, governance rollup — plus campaign 9's hardening: succession pinned in the proposal, the equivocation predicate ruled on values, the provably-doomed round's early close, and cross-domain concealment detected at replay. Activated by the concrete trigger **"≥2 operators live in a hub"**. ADR-0021 then built the far side of conviction: an authorized membership trail, a recomputable electorate, recusal by declared cause, `afp:KeyCompromiseClaim`, membership actuation as a ratified act, forward-scoped restoration, and a proof that travels as cited enrollment evidence | A 3-instance hub surviving a deliberately equivocating agent — `npm run demo:p6` runs it at **five** instances over real HTTP with one scripted equivocator and one scripted backup-restore told apart by the joint replay, then carries the conviction through to consequence: a capture claim that changes nothing, a governance round that recuses its own subject, a member-published expulsion, and a next round pinning four seats. `demo:p6:llm` runs both questions on a local model | The EquivocationProof verifies standalone from the two conflicting votes; the offender's weight zeroes with no coordination; any *instance*-level consequence requires a ratified GovernanceDecision. **Holds:** gated by `adr0020.test.ts` (14 cases) and `adr0021.test.ts` (24, W5's whole matrix) — and running it at five operators found a defect no unit gate reached, since a real conviction always crosses a boundary |
| **P7 — Contribution accounting** | `afp:ContributionSummary` and the `afp:ContributionDispute` flow — last, because it consumes P6's certificates and P1's Result flow | An independently recomputed, agreeing ContributionSummary | A second operator recomputes it from certificates and Results and matches; a dispute filed with evidence resolves against the record, not against a claim |

---

## Profiles

Because every profile is a prefix, the mapping is a stopping point rather than a
cherry-pick:

| Profile | Phases |
|---|---|
| **Solo / airgapped** | P1 → P3, then stop |
| **Pairwise** | P1 → P4, then stop — recognition and direct delegation, no shared hub ([06](06-deployment-profiles.md#the-pairwise-profile-federation-without-a-hub)) |
| **Federated consortium** | P1 → P7 in order |

A solo deployment MAY additionally switch on P4's **dual-publish shadow Notes** at any point
without adopting the rest of P4 — publishing Notes to an external follower requires no
agreement, and it is the cheapest way to anchor outbox chain heads outside a trust domain
where the operator holds every key
([06](06-deployment-profiles.md#keep-signing-everything--the-sneakernet-property)).

## What blocked P5, and how it closed

P5 is built; this section is kept as the record of what stood in its way, because a blocker
that quietly disappears teaches a later reader nothing.

[Scenario 10](scenarios/10-the-incident-bridge.md) walked P5 end to end before its stack ADR
existed, and reported seven findings (campaign 7). Its through-line is the decision P5 cannot
avoid and P4 never had to make: **the hub is somebody's server** — which settles hosting,
proof of membership, what members do while the host is partitioned, and whose state the
case file carries, as one question with four faces.

Two of those findings were already known here before the scenario confirmed them, and both
are now closed. They are kept below with their resolutions.

- ~~**`afp:MembershipProof` exists in prose only.**~~ **Closed** — [ADR-0014](adr/0014-p5-shared-hub-stack.md)
  Decision 1, built and gated: the hub issues a signed, expiring statement naming agent,
  hub and role; the fetcher presents it on the signed `GET`; the serving instance verifies
  it against the hub's published key and requires the named agent to equal the requester
  it already authenticated. ADR-0013's `hub` predicate is widened from "a hub I host" to
  "a hub whose proof I can verify" — deny-list and agreement stages unchanged. P5's hub
  reads are unblocked, Decisions 2–4 followed the same day, and M6 closed it out over three real HTTP servers. ADR-0015 followed — cross-receiver consistency, the check census, the archived state — and **campaign 7 is closed**: seven findings, two ADRs, opened and shut in a day. P5's remaining scope was the transport it always was: the hub's own HTTP inbox and cross-instance CRDT sync. [ADR-0016](adr/0016-p5-transport.md) covered that scope and is **built** — gated end to end over real sockets, and demonstrated by `npm run demo:p5`.
- ~~**A scoped export can silently disarm the pin checks.**~~ **Closed** —
  [ADR-0010](adr/0010-pinning-without-an-auction.md) Decision 5, built at v3.23. Redacting
  a pin-bearing `Offer` left the thread with no task activity, so the governing pins
  resolved to nothing and every actuation check on it no-opped; the export now refuses to
  emit such a bundle and replay names one that arrives from anywhere else. Closed before P5
  widens the redaction surface, which was the whole reason for triaging it as its own track
  rather than folding it into a P5 ADR.

## What blocked P6, and how it closed

P6 is built; this section is kept as the record of what stood in its way, per the standing
rule that a blocker which quietly disappears teaches a later reader nothing.

[Scenario 12](scenarios/12-the-parametric-trigger.md) walked P6 end to end before its stack
ADR existed — the same move scenario 10 made for P5 — and reported eight findings
(campaign 9). **All eight are closed**, and so are the two older defects found while
decomposing them. Its through-line is the seam L1's spec never crosses: **the proof is
about a key; every consequence is about a party.** The cryptography held end to end; every
finding lives after the moment of conviction. Triaged in the
[campaign 9 ledger](scenarios/README.md#campaign-9--built-scenario-12-the-p6-shakedown)
into [ADR-0020](adr/0020-p6-hardened-round-stack.md) (the hardened-round stack —
**built and gated** (`adr0020.test.ts`, 14 cases): succession pinned in the proposal, the
equivocation predicate ruled precisely, the provably-doomed round's early close, and
replay-detected concealment — findings 58, 60, 61 and 62 closed), an ADR-0005 amendment
(declared change of control — **built and gated**, `adr0005.test.ts`; finding 63 closed), and
[ADR-0021](adr/0021-conviction-to-consequence.md) (conviction to consequence: a
recomputable electorate, contest and restoration, recusal, proof portability — Decisions
1 and 2 **built and gated** on 2026-08-22, Decisions 3-5 on 2026-08-23 — the recusal
whose cause the record resolves, conviction to governed consequence with forward-scoped
restoration, and the proof given a destination). Three are kept below — all now closed, and all worth naming because each was live in the
built code when it was found:

- ~~**Finding 62 is a live attack surface, not a gap.**~~ **Closed** — ADR-0020
  Decision 3, built the same day: `afp:successionRule` pinned in the proposal,
  rotation keyed on the stalled proposal's wire actor, an unentitled successor a named
  replay failure. Kept below as written, per the standing rule that a blocker which
  quietly disappears teaches a later reader nothing. The view-change rule
  ("highest-reputation live replica issues a fresh round") is prose no proposal pins and
  no replay checks — and since ADR-0018/0019 the proposal carries the deadline, quorum
  rule, binding, electorate, action policy and irrevocability. Stalling rounds to farm
  proposer-ship got *more* valuable with every campaign that made the proposal stronger.
  It went first inside ADR-0020.
- ~~**Finding 58 gates the demo before the demo exists.**~~ **Closed** — ADR-0020
  Decision 2, built: values or `proposalHash` convict, a same-value duplicate is state
  loss with a lawful re-vote path, and gate case G2 is exactly the
  scripted-restore-that-must-not-convict this bullet asked for. Prose and diagram
  disagreed on
  what equivocation *is* (different value vs. different hash), and the difference decides
  whether an honest backup-restore is convicted. The demo that bullet asked for is
  **built** — `npm run demo:p6`: five instances over real HTTP, one scripted
  equivocator, one scripted restore, told apart by the joint replay, with
  `demo:p6:llm` running the same pool on a local model. Running it at five operators
  found a defect no unit gate could reach — V2 verified a proof's embedded votes
  against the announcing bundle's keys alone, and a real conviction always crosses a
  boundary (ADR-0020 W3, gate G14).

- ~~**A membership-removal primitive with no authority check**~~ **Closed** — ADR-0021
  Decision 1, built and gated the same day it was found (`adr0021.test.ts` G0a-G0d):
  both implementations now bind an `afp:Unenroll` to the agent's own operating instance,
  and the membership trail is read as of the round being weighed. Kept below as written,
  per the standing rule that a blocker which quietly disappears teaches a later reader
  nothing. (found 2026-08-22 while
  decomposing [ADR-0021](adr/0021-conviction-to-consequence.md), not by any scenario).
  `Hub.onUnenroll` performs no issuer binding, `writeAdmitted` puts `afp:Unenroll` in the
  door-knock class, and no verifier check examines who signed one — so any party holding
  any key that verifies can remove any agent from any hub, and the bundle replays clean.
  Measured against the real hub, not inferred. It is ADR-0021 Decision 1, deliberately
  sized as a standalone first slice: a handful of lines in `hub.ts` and `decision.py`,
  no new wire property. Worth landing ahead of everything else in that ADR, because
  every electorate rule above it reads the trail this defect lets anyone edit.

## Known blockers before P7 opens

[Scenario 13](scenarios/13-the-quarterly-split.md) walks P7 end to end before its stack
ADR exists — the same move scenarios 10 and 12 made for P5 and P6 — and reports nine
findings ([campaign 10](scenarios/README.md#campaign-10--open-scenario-13-the-p7-shakedown),
open). It is the first shakedown in which **nobody misbehaves**: four honest support desks
split one retainer, and they still cannot agree on the number.

Its through-line is the one thing P7 asks for that no earlier phase needed: **a sum is
only as recomputable as its input set is agreed, and the protocol does not name sets.**
Every mechanism P1–P6 built answers a question about an event you can point at;
`afp:ContributionSummary` is the first object whose subject is a *boundary* — which
events, over which window, seen by whom, credited at what weight, still valid under which
vocabulary — and each finding is a different edge of that boundary left undrawn.

Two are worth naming here, because a P7 build hits them in its first hour and neither is
visible from the phase table above:

- **`afp:contributionSplit` is normative and implemented nowhere.** 03 requires it
  whenever a Result's `attributedTo` names several actors, and rules that a Result
  lacking it counts *for no one*. It has been in the spec since v3.4 (campaign 1's
  finding 7) and appears in no builder and no check. So the collaborative case — the one
  where credit is genuinely ambiguous, and the whole reason a split field exists — is
  silently dropped from the arithmetic P7 is built to make checkable. Worse when someone
  implements it as written: a map of fractions summing to 1 is unrepresentable under the
  JCS numeric profile, which is the wall ADR-0005 already hit for vote weights and solved
  with integer shares over an LCM denominator.
- **"Any member can recompute it" is not true today, and the record cannot say so.** 04
  calls the inputs "fully derived from public signed data"; 07 and ADR-0013 guarantee
  that non-`public` work is served to nobody unentitled — 404, by design. Two members
  therefore recompute the same period honestly and disagree, with no way to tell an
  entitlement gap from an error or a fraud. The fix's shape already exists one layer
  down: ADR-0015's census made "a check that could not be evaluated" visible instead of
  silent, and a summary computed over a partial view is exactly that in accounting form.

## Open questions

- **Directory-of-hubs bootstrap.** Left as an out-of-band, consortium-published list at a
  well-known URL. Hubs churn far less than agents, so a hand-maintained list suffices;
  revisit (a lightweight meta-hub?) only if concurrent hub count grows past a handful.
  Don't design it before there's evidence of the need.
- **Cross-instance bid collusion.** Commit-reveal stops a single dishonest bidder from
  sniping off visible bids, but cannot detect two instances coordinating bids out-of-band
  before submission. That's a consortium-terms/policy matter — who you agree to federate
  with in the first place — not something the protocol can enforce cryptographically.
  Stated here rather than glossed over.
