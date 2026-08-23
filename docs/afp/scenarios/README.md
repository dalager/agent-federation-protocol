# Spec-test scenarios

Each scenario walks a realistic workload through the protocol end to end, maps acceptance
criteria to spec mechanisms, and closes with a **verdict**: what held, and what strained.
Findings feed back into the spec — this directory is the reason v3.4 exists.

Not every revision comes from here: **v3.6** came from a readiness review of the roadmap
itself rather than from a scenario, and rescoped the phases (P1–P7, every profile a prefix)
after the phasing had fallen two revisions behind the design. Scenarios test what the
protocol does; that review tested whether the build order still matched it.

| # | Scenario | Axis stressed | Findings |
|---|---|---|---|
| [01](01-client-due-diligence.md) | Agentic due diligence on a new client | Solo profile, hub-per-case, direct delegation, HITL, audit replay | 3 |
| [02](02-observability-fix-pipeline.md) | Observability-to-fix pipeline | Standing hubs, ports vs. external providers, bidding as routing, risk gates | 3 |
| [03](03-co-staffed-project.md) | Two consultancies co-staffing a project | Federation, cross-operator governance, shared state, co-work, billing evidence | 4 + 2 recurring |
| [04](04-federated-estimation.md) | A question pushed to the hub: federated estimation | Unknown-arity allocation, partial answers, reconciliation, unverifiable deliverables | 6 |
| [05](05-integration-practice.md) | The integration practice: domain intelligence as an internal service | Standing solo instance answering other teams' shape/size/effort asks, requester roles, cross-team asset reuse, settlement on requester-reported actuals | 3 |
| [06](06-issue-triage-loop.md) | The issue triage loop: from bug tracker to reviewed fix | External system as initiator, untrusted third-party content entering the record, acting on your own classification, idempotent external writes, author/reviewer separation, supersession after review | 6 |
| [07](07-the-retraction.md) | The retraction: revising an answer the world already acted on | Superseding a ratified Synthesis, the cost of overturning a quorum, dispositions for acted-on justifications | 0 (sharpened 24) |
| [08](08-the-subcontract.md) | The subcontract: two operators, one boundary, no shared hub | The P4 handshake alone — adversarial probing of the gate, direct cross-boundary delegation, cross-boundary settlement, agreement expiry vs in-flight work, two-export replay | 7 |
| [08 · story](08-the-subcontract-story.md) | The same subcontract, outside-in | A first: the scenario retold through its human actors — the double sale, the near-miss, the seams. No findings machinery; a readability check on the whole design | — |
| [09](09-the-screening-sidecar.md) | The screening sidecar: an auditable agentic subsystem inside someone else's workflow | Solo profile behind a pre-existing actuation boundary, external initiator, fixed-panel fan-out, polyglot brains behind the port, dissent into the verdict, checkable actuation against an external API, subject-scoped audit export (EU AI Act) | 12 |
| [10](10-the-incident-bridge.md) | The incident bridge: three operators, one hub, and the host is the one on fire | The P5 shakedown — a shared hub across three trust domains, hub reads across the boundary, CRDT convergence after the host partitions, a quorum round with a member unreachable, membership churn mid-decision, and the first three-export replay | 7 |
| [11](11-the-snow-day.md) | The snow day: three parties, one decision, and a clock nobody controls | A hub that binds action rather than pooling information — an indivisible outcome, an externally imposed deadline, unverifiable local evidence held by the losing party, actuation by a party with no vote, and grading a decision the morning after. First scenario with a running counterpart (`npm run demo:p5:llm`) | 8 |
| [12](12-the-parametric-trigger.md) | The parametric trigger: five reinsurers, one storm, and a signature that voted twice | The P6 shakedown — first workload at n≥4 (real Byzantine tolerance), a rational equivocator with pinned incentives, a captured-key claim, backup-restore as accidental equivocation, quorum arithmetic after weight-zeroing, view-change capture, a merger the snapshot cannot see, recusal, and proof portability | 8 |
| [13](13-the-quarterly-split.md) | The quarterly split: four support desks, one retainer, and a number nobody can check twice | The P7 shakedown — the first object whose subject is a *set* of events rather than an event: independent recomputation against visibility classes, co-authored credit, a period edge on self-asserted clocks, work that did not hold, an expelled member's quarter, a dispute with no terminal, and a roll-up whose inputs are historical by definition | 9 |
| [· tuesday](the-operators-tuesday.md) | The operator's Tuesday | The built stack's ordinary day, every noun pointing at a file — commands, tables, outputs and warts of the solo profile as it runs today; the hard-focus baseline the P4 build will be measured against | — |

## Is this workload supported?

Every scenario above was written to *break* something, and each one did. This table is the
answer to the question the walkthroughs deliberately do not answer: **what holds today, and
how can you see it.** All sixty-five findings raised across the first nine campaigns are
closed — finding 32's remainder last among the first eight (2026-08-22), when building
this index caught that campaign 6 had been recording it as resolved while its own prose
said otherwise, and campaign 9's last three on 2026-08-23 with
[ADR-0021](../adr/0021-conviction-to-consequence.md)'s remaining decisions. Campaign 10
([scenario 13](13-the-quarterly-split.md), the P7 shakedown) is **open**: nine findings,
walked 2026-08-23 before any P7 stack ADR exists, and not yet triaged.

A scenario's own text is never rewritten when its findings land — a scenario records what
was true when it was walked, which is what makes it evidence. So read a walkthrough as
history and read this table as status; where a scenario has a runnable demonstration, the
demo shows the *resolved* world and the walkthrough shows what it cost to get there.

| Scenario | Findings | Resolved by | See it run | Gated by |
|---|---|---|---|---|
| [01](01-client-due-diligence.md) | 3 · closed | spec v3.4 ([07](../07-visibility-and-artifacts.md), [03](../03-coordination.md)) | `npm run demo:offline` | `gate.test.ts` |
| [02](02-observability-fix-pipeline.md) | 3 · closed | spec v3.4 | `npm run demo:offline` | `gate.test.ts` |
| [03](03-co-staffed-project.md) | 4 + 2 · closed | spec v3.4, [ADR-0005](../adr/0005-operators-are-equal.md) | `npm run demo:p2` | `hub.test.ts`, `adr0005.test.ts` |
| [04](04-federated-estimation.md) | 6 · closed | spec v3.5 ([03](../03-coordination.md), [04](../04-operations.md)) | `npm run demo:p3` · `demo:p3:llm` | `allocation.test.ts` |
| [05](05-integration-practice.md) | 3 · closed | [ADR-0004](../adr/0004-solo-foundation-hardening.md) | — | `adr0004.test.ts` |
| [06](06-issue-triage-loop.md) | 6 · closed | [ADR-0006](../adr/0006-checkable-actuation.md), [ADR-0007](../adr/0007-supersession.md), spec v3.13–v3.14 | — | `adr0006.test.ts`, `adr0007.test.ts` |
| [07](07-the-retraction.md) | 0 · sharpened 24 | [ADR-0007](../adr/0007-supersession.md) | — | `adr0007.test.ts` |
| [08](08-the-subcontract.md) | 7 · closed | [ADR-0008](../adr/0008-p4-federation-stack.md), [ADR-0009](../adr/0009-federated-replay.md) | `npm run demo:p4` | `adr0008.test.ts`, `adr0008b.test.ts`, `adr0009.test.ts` |
| [09](09-the-screening-sidecar.md) | 12 · closed | [ADR-0010](../adr/0010-pinning-without-an-auction.md), [ADR-0011](../adr/0011-supersession-meets-the-irreversible-world.md), [ADR-0012](../adr/0012-the-long-horizon.md) | — | `adr0010.test.ts`, `adr0010-parity.test.ts`, `adr0011.test.ts`, `adr0012.test.ts` |
| [10](10-the-incident-bridge.md) | 7 · closed | [ADR-0014](../adr/0014-p5-shared-hub-stack.md), [ADR-0015](../adr/0015-the-case-file-at-n-parties.md) | `npm run demo:p5` | `adr0014.test.ts`, `adr0014-m6.test.ts`, `adr0015.test.ts`, `adr0016.test.ts` |
| [11](11-the-snow-day.md) | 8 · closed | [ADR-0018](../adr/0018-the-round-as-a-commitment.md), [ADR-0019](../adr/0019-acting-on-a-decision.md) | `npm run demo:p5:llm` | `adr0018.test.ts`, `adr0019.test.ts` |
| [12](12-the-parametric-trigger.md) | 8 · closed | [ADR-0020](../adr/0020-p6-hardened-round-stack.md) (58, 60, 61, 62) · [ADR-0005 amendment](../adr/0005-operators-are-equal.md) (63) · [ADR-0021](../adr/0021-conviction-to-consequence.md) (59, 64, 65) | `npm run demo:p6` · `demo:p6:llm` | `adr0020.test.ts`, `adr0005.test.ts`, `adr0021.test.ts` |
| [13](13-the-quarterly-split.md) | 9 · closed | [ADR-0022](../adr/0022-the-summary-declares-its-frame.md) (66-73) + its [ADR-0017](../adr/0017-standards-conformance.md) amendment (74) | — (no P7 demo yet) | `adr0022.test.ts` |

**Where the "See it run" column is empty**, the scenario's shape is covered by its gate
files rather than by a demo. Three of the four are workloads that live inside another
system — 05's internal service answering other teams, 06's bug tracker, 09's caseworker
sidecar — where a standalone demo would have to simulate the host system before it could
show anything; 07 is a mechanism test with no standalone workload of its own. The gates
exercise the same machinery against real exports and the real verifier, so what is missing
is the narrative walkthrough, not the coverage. A demo for any of them would be a genuine
improvement, not a formality.

**The last one to close — finding 32.** ADR-0012 landed its sharp half in v3.20 (the
bundle's declared content inventory, CRDT state stated to be outside it) and the other half
was triaged as "06 deployment guidance", then never written: campaign 6's prose has said
both "32's remainder is 06 deployment guidance" and "all twelve findings resolved" ever
since. Writing this index is what caught the contradiction. Closed 2026-08-22 in
[06 — Designing for per-subject disclosure](../06-deployment-profiles.md#designing-for-per-subject-disclosure):
where disclosure is per-subject the thread SHOULD be the subject-scoped unit, and
cross-thread carriers SHOULD hold references rather than subject content. The build-out
sharpened it beyond the original candidate — ADR-0015 Decision 3 now carries a hub's
converged state into the record at `afp:Archive`, so a store that quietly accumulated
subject content is excluded right up until the hub closes and then published wholesale,
which makes what may go in a hub-scoped store a disclosure decision taken at design time.

Three ADRs are **not** scenario-driven and appear nowhere above:
[ADR-0013](../adr/0013-authorized-fetch.md) (a sync audit),
[ADR-0016](../adr/0016-p5-transport.md) (the roadmap's P5 row) and
[ADR-0017](../adr/0017-standards-conformance.md) (a standards-deviation critique). Scenarios
are one source of pressure on this spec, not the only one.

## Findings ledger

### Campaign 1 → v3.4

The nine distinct findings from scenarios 01–03, and where each landed:

| # | Finding | Resolution |
|---|---|---|
| 1 | Read-side access control unspecified | [07 — Audience & visibility](../07-visibility-and-artifacts.md#audience--visibility): four classes, authorized fetch, `afp:AuditGrant` |
| 2 | Hub lifecycle unspecified | [07 — Hub lifecycle](../07-visibility-and-artifacts.md#hub-lifecycle): `afp:Freeze`, `afp:Archive` as canonical case file |
| 3 | External evidence provenance implicit | [07 — Artifacts](../07-visibility-and-artifacts.md#artifacts--attachments): mandatory `afp:digest`, plus `afp:sourceUrl`/`afp:fetchedAt` |
| 4 | External *action* outcomes never reconciled | [03 — External systems](../03-coordination.md#external-systems-keep-the-firehose-behind-the-port): reconciliation is a MUST |
| 5 | Telemetry-as-activities anti-pattern unstated | Same section: firehose stays behind the port |
| 6 | `correlationId` overloaded as thread id | [03 — Correlation vs. threading](../03-coordination.md#correlation-vs-threading--two-distinct-ids): AS2 `context` for threads |
| 7 | Co-work unmodeled | [03 — Ping-pong thread](../03-coordination.md#co-work-the-ping-pong-thread), plus `afp:contributionSplit` escape hatch |
| 8 | Blob/artifact layer assumed shared storage | [07 — Artifacts](../07-visibility-and-artifacts.md#artifacts--attachments): each instance serves its own, hash-addressed |
| 9 | "Byzantine-hardened" overclaimed at small n | [03 — L1 guarantees table](../03-coordination.md#consensus-hardening--level-1): accountability (n=2) vs. tolerance (n≥4) |

### Campaign 2 → v3.5

Six findings from scenario 04. Two are protocol additions, not conventions:

| # | Finding | Resolution |
|---|---|---|
| 10 | `afp:Award` was single-winner; some questions need a coalition | [03 — Selection rules](../03-coordination.md#selection-rules-one-performer-or-several): ranking **or** set selection over `afp:coverage`, arity emergent, synthesizer deterministically named |
| 11 | No primitive for answers that aren't decisions | [04 — Synthesis](../04-operations.md#synthesis-answers-that-are-not-decisions): `afp:Synthesis` with method, contributing Results, assumptions, superseded inputs, and dissent as a first-class field |
| 12 | Estimate accuracy unscoreable at answer time | [04 — Settlement](../04-operations.md#settlement-scoring-answers-that-cannot-be-verified-yet): `afp:Settlement` + explicit *unsettled* state; correct dissent raises standing |
| 13 | Estimator/bidder conflict of interest | [03 — Estimating what you may later be paid to do](../03-coordination.md#estimating-what-you-may-later-be-paid-to-do): hub policy MUST take a position |
| 14 | Silence on announced tasks is ambiguous | [03 — Declining is a record](../03-coordination.md#declining-is-a-record-silence-is-not): explicit Reject within the bid window |
| 15 | Answer sufficiency conflated with voting quorum; `estimatedCost` ambiguity | Same section: sufficiency stated in the announce (coverage and/or count); Bid cost-to-perform distinguished from a costing answer |

## Writing another

Useful scenarios stress an axis the existing ones don't. Untested so far: three or more
operators (real Byzantine tolerance, coalition dynamics at n≥4), long-lived hubs with heavy
membership churn, sneakernet/airgapped federation, an adversarial operator beyond
[scenario 08](08-the-subcontract.md)'s probing Mallory (replay, equivocation, a captured
key), and a task whose answer must be revised after the fact — exercised by
[scenario 07](07-the-retraction.md) and resolved in [ADR-0007](../adr/0007-supersession.md). Client/observer participation was
exercised by scenario 05 — and strained into finding 2 (requester roles).

### Campaign 3 → v3.9 (ADR-0004)

Three findings from scenario 05, landed as the solo-foundation hardening before any
federation work ([ADR-0004](../adr/0004-solo-foundation-hardening.md)):

| # | Finding | Resolution |
|---|---|---|
| 16 | Reusable components have identity across hubs; capabilities describe agents, artifacts are bare bytes | [07 — Assets](../07-visibility-and-artifacts.md#assets-identity-for-reusable-components): `afp:Asset` registered on the record, `afp:reuses`/`afp:reused` claims resolvable at replay |
| 17 | Enrollment is binary; serving non-member teams needs a requester/observer role | [02 — Enrollment](../02-hubs-and-state.md#enrollment-is-two-level-deliberately): `afp:role` on the Enroll, enforced at bid admission and snapshot-pinning, replayed from the Enroll trail |
| 18 | A staffing policy now wants to consume reputation — ADR-0003 Decision 5's revisit trigger has fired | [03 — Consuming reputation, recomputably](../03-coordination.md#consuming-reputation-recomputably): `afp:reputationRule` + `afp:settlementSnapshot` pinned in the Announce; `divergence-decay` as the first registry entry |

Scenario 05's minor precision also landed:
[06 — Where visibility ends](../06-deployment-profiles.md#where-visibility-ends-the-port-boundary).

Keep the format: user story → cast → walkthrough → acceptance criteria mapped to spec
mechanisms → verdict with findings. Be willing to conclude that something strained; a
scenario that finds nothing has usually been written to flatter the spec.

### Campaign 4 → v3.12–v3.14 (ADR-0006, ADR-0007)

Six findings from [scenario 06](06-issue-triage-loop.md), the first scenario where the
swarm *acts* on its own conclusion inside an external system rather than only recording
it. Unresolved; candidates below are the scenario's own suggestions, not decisions.

| # | Finding | Candidate |
|---|---|---|
| 19 | Content ingested through a port is untrusted in a way the spec never names — 04 covers fediverse command injection and untrusted *results*, but not a task description arriving from an external system | **Resolved** (v3.14): the port duty stated positively in [03](../03-coordination.md#external-systems-keep-the-firehose-behind-the-port) — third-party content enters as hash-addressed evidence; the task text is the port's own bounded summary |
| 20 | Nothing binds an action to the answer that justified it — selection and reputation have pinned named rules, actuation has none | **Resolved** ([ADR-0006](../adr/0006-checkable-actuation.md)): `afp:actionPolicy` pinned in the Announce, `afp:category` on the Synthesis, `afp:actsOn`/`afp:action` hash-binding every consequence to its cause — recomputed at replay (03, 04) |
| 21 | 03's reconciliation duty stops short of idempotence — a crash between doing the external thing and recording it is indistinguishable from not having done it | **Resolved** (v3.13): the side effect MUST carry an idempotency key derived from the `correlationId` — [03](../03-coordination.md#external-systems-keep-the-firehose-behind-the-port), mirrored in 04's trail-edges table |
| 22 | A task that cannot be answered *as posed* has no honest terminal outcome, and the replay procedure demands one | **Resolved** (v3.13): `afp:err:insufficient-information` named in [03](../03-coordination.md#task-delegation--the-v1-baseline-flow-unchanged) — the thread closes; a later reply is a new ask with the closed thread as prehistory |
| 23 | Separation of duties is specified once, for one pair (estimator/bidder); "the author of a fix may not review it" is the same shape with no mechanism | **Resolved** ([ADR-0006](../adr/0006-checkable-actuation.md)): `afp:excludePerformersOf` on the Announce — the excluded set rebuilt from prior Awards at replay, enforced at admission in the estimator wall's lane (03) |
| 24 | Supersession revises an answer that has already been acted on — and nothing says who may supersede a ratified Synthesis, or makes the withdrawn justification visible | **Resolved** ([scenario 07](07-the-retraction.md) → [ADR-0007](../adr/0007-supersession.md)): `afp:supersedes` distinct from input-level `supersededInputs`; ratification parity — a quorum's answer retracted only by a quorum; `afp:disposes` for every action whose justification was withdrawn (04) |

Landed in three moves: 20 and 23 first ([ADR-0006](../adr/0006-checkable-actuation.md),
v3.12), 21 and 22 as spec precision (v3.13), then 19 as spec text and 24 through
[scenario 07](07-the-retraction.md) — the scenario finding 24 asked for, which sharpened
it into [ADR-0007](../adr/0007-supersession.md)'s three decisions (v3.14). Campaign
closed.

### Campaign 5 → v3.16–v3.17 (ADR-0008, ADR-0009)

Seven findings from [scenario 08](08-the-subcontract.md), the P4 shakedown: the
handshake exercised alone, with an adversarial prober and a two-export replay. The raw
walkthrough surfaced five; the scenario's own review pass split one and added one, and
its corrections are folded into the scenario's verdict. Findings 25–28 and 30 are **resolved** — [ADR-0008](../adr/0008-p4-federation-stack.md)
accepted and built (v3.16): grants, dual-Create activation, the hop's HTTP Signatures
over the one payload suite, the hash-chained boundary log, expiry semantics with the
global monotonicity backstop, and both ingestion duties enforced at the receiving port.
**29a/29b are resolved** — [ADR-0009](../adr/0009-federated-replay.md) accepted and
built (v3.17): federated replay as N single-export replays plus a cross-check, received
bytes matched against the sender's record, redaction as export-time digest-only stubs
with declared scope — discretion is declared, deletion is detected, and the auditor's
two folders are one command. **Campaign closed, 7 for 7.**

| # | Finding | Candidate |
|---|---|---|
| 25 | The agreement's scope grammar is hub-shaped — the narrowest real federation (direct delegation, no hub) cannot state its own scope | Scope as a set of grants: hubs and/or capabilities-for-direct-delegation, the gate checking each activity against the grant that admits it |
| 26 | Boundary rejection leaves no trace — a refused stranger and a silent wire are the same record | Local by necessity (no commitment point exists for a stranger — verifiable rejection is impossible in the negative), but stronger than a log: a hash-chained, instance-signed rejection record, exportable as an assertion |
| 27 | "LD-Signatures" wording is pre-ADR-0001 drift — in the roadmap's P4 row and 01's tooling list; 04 already fuses the terms into the two-layer model | Wording cleanup plus ADR-0008 confirming `eddsa-jcs-2022` satisfies 04's relay obligation; no interop pressure forces RDF canonicalization |
| 28 | Agreement expiry vs in-flight work was unstated | As ruled in the scenario: expiry stalls new work, an accepted `correlationId` flows to terminal outcome — plus the backstop that pays everywhere: `published` non-decreasing along each `prevActivity` chain |
| 29a | Verifier completeness is single-domain | Per-trust-domain completeness, cross-export resolution, holes attributed to their domain — and authority **partitioned by `afp:operatedBy`**, so one bundle cannot smuggle forged counterparty actor documents |
| 29b | A scoped export and a tampered one share a signature — lawful redaction gaps a `prevActivity` chain exactly as deletion does | A record-level redaction mechanism (digest-only stubs keeping the chain linkable), decided as spec, not patched in the verifier |
| 30 | Neither ingestion duty names the federated boundary as its site — 04's untrusted-result sandbox and finding 19's port summary both apply to a subcontractor's Result, and neither says so | One paragraph siting both duties at the boundary, before "boundary-ready" gets read as "trust the attachment" |

### Campaign 6 → v3.18–v3.20 (ADR-0010, ADR-0011, ADR-0012)

Twelve findings from [scenario 09](09-the-screening-sidecar.md), the first scenario to
deploy the solo profile *inside* another system's actuation boundary and the first
driven by a statutory documentation duty (EU AI Act) rather than an internal one. The
initial walkthrough surfaced three; a full spec pass — verifying every mechanism the
scenario leans on against 01–07 and the ADRs — corrected two of the scenario's own
claims (the "nothing lost" fan-out beat, the `actsOn` target) and surfaced nine more.
The through-line of the campaign: **the machinery added in campaigns 2–5 (action
policies, synthesizer naming, sufficiency, dispositions) anchored itself to the
Announce/Award pair, and the degenerate direct flow — the one 06 promises is "a
degenerate case, never a fork" — silently loses all of it.** Triaged into three
proposed ADRs and two lighter tracks:
[ADR-0010](../adr/0010-pinning-without-an-auction.md) (34, 35, 37 — pins on the
task-bearing activity, the `actsOn` hop, the `afp:no-verdict` release),
[ADR-0011](../adr/0011-supersession-meets-the-irreversible-world.md) (38, 39 —
declared irreversibility, the `annotate` disposition, panel deltas,
`afp:priorThread` and the fork ruling), and
[ADR-0012](../adr/0012-the-long-horizon.md) (40 + the sharp half of 32 — key
history in the manifest, rotation vs revocation, conditional retention MUSTs, the
bundle's content inventory with CRDT state excluded). Findings 31, 33, 36, 41, 42
are spec-precision edits (no ADR needed) — **written into the spec body at v3.22**, after
a roadmap review caught that "triaged as needing no ADR" had been quietly recorded as
"resolved": the presentation convention for renderings and `afp:producedBy`'s definition
in 04, port agents and the human-disposition reconciliation in 03, and the replay
guarantee's boundary in 04's replay procedure. 32's remainder is 06 deployment guidance
resting on ADR-0012 Decision 4. ADR-0010 is **Accepted and built** — findings 34, 35
and 37 are closed, and the build corrected three of its own rulings on the way (the
sequential-thread ordering rule, an unconditional outcome check that would have failed
every governance vote, and the leg partition's scope). [ADR-0011](../adr/0011-supersession-meets-the-irreversible-world.md) is **Accepted and
built** too — findings 38 and 39 closed, with declared irreversibility, the `annotate`
disposition, the panel delta, and `afp:priorThread`; its build turned ADR-0007's own gate
red, which was the requirement working rather than a regression.
[ADR-0012](../adr/0012-the-long-horizon.md) is **Accepted and built** as well — key
history in a now-signed manifest, rotation distinguished from revocation, declared
retention duties, and the bundle's content inventory with CRDT state stated to be outside
it. **Campaign 6 is closed**: all twelve findings resolved — 32's deployment-guidance
remainder last, in v3.28, after this directory's support index caught it standing open;
three ADRs built and swept
into the spec body.

| # | Finding | Candidate |
|---|---|---|
| 31 | The audit deliverable ends at the verified bundle; the human reads a rendering the spec constrains only for notifications (04's dissent-travels SHOULD) — an unconstrained rendering can omit dissent or narrate a record other than the one it ships with | Generalize 04's SHOULD into a presentation convention: renderings derived mechanically from a verified export, carrying the bundle digest and the verifier's result |
| 32 | Subject-scoped disclosure rides on an unstated convention — ADR-0009's scope grammar (thread/visibility/agreement) has no data-subject axis, and cross-thread carriers (application CRDT stores, settlement/reputation registers) have no thread to cut at; whether CRDT state is in the export bundle at all is unstated | Deployment guidance: thread SHOULD be the subject-scoped unit where disclosure is per-subject; cross-thread state SHOULD carry no subject content; state the export's content inventory either way |
| 33 | `afp:producedBy` has no prose definition in the spec body — a class-diagram field plus an ADR-0001 paragraph; under a regulatory duty it must identify the whole brain's versioned configuration | Define it in 04 § Rationale externalization as convention-not-machinery: a resolvable, versioned brain-configuration identifier; non-normative for replay |
| 34 | `afp:actionPolicy`, `afp:answerSufficiency`, and the synthesizer's mandate are all anchored to an Announce/Award the direct-delegation flow lacks — the verifier's governing-policy chain (`Synthesis → afp:award → Award → afp:task → Announce`) has no root, and three checks silently no-op in exactly the flow the spec prescribes when the target is known | Let a thread-opening activity (or the direct `Offer{Task}`) pin policy, sufficiency, and synthesizer; give the replay lookup a fallback to it |
| 35 | `afp:actsOn` must resolve to a Synthesis — a deployment that ratifies must bind its action to the unratified artifact while the DecisionRecord rides alongside, unchecked | `actsOn` MAY name a DecisionRecord whose outcome names a Synthesis; the verifier follows the one hop |
| 36 | The external initiator has no actor model — a port that emits signed activities must be *some* rostered actor or its activities are forgeries under 04's authority rule; scenario 06 rostered its port as two agents but the rule is nowhere stated | State it: an external system emitting activities is modeled as instance-custody port agent(s), rostered and vouched; read/write split RECOMMENDED where input is hostile |
| 37 | No panel-level non-answer terminal that actuates — per-task error codes exist, but a partial panel (three Results, one Error) has no defined synthesis-over-partials rule, no "no verdict" category in ADR-0006's closed set, and therefore no admissible action releasing the external state machine | A reserved non-answer terminal that is still an actuation with an admissible action — the external workflow is always released |
| 38 | Supersession assumes the world can be un-acted-on — no notion of an irrevocable action, no disposition form for "annotate, cannot undo," and ratification parity assumes the current quorum is a meaningful successor to the one that decided | An `annotate-only` disposition for actions declared irrevocable at policy-pin time; supersession records name the panel delta when membership materially changed |
| 39 | "A new ask with the closed thread as prehistory" (03) has no property and collides with ADR-0007's same-`context` rule — a contestation is plausibly both, and choosing the new-thread fork silently disables retraction | `afp:priorThread` making prehistory followable, plus one paragraph ruling the fork: revising the answer reopens the thread; a new ask on new information opens a new one naming its predecessor |
| 40 | Nothing supports verifying a five-year-old export — rotation treats old keys as revoked, actor documents are current-state, no key-validity windows or manifest key history, anchoring only a SHOULD, artifact retention scoped to federation lifetime rather than statute | Manifest carries signing-key history with validity intervals; statutory deployments MUST anchor chain heads externally and retain artifact bytes for the retention horizon |
| 41 | Human oversight ends outside the record — the Article-14 moment (the caseworker's decision on a flagged case) never enters it, and the only recorded-human-decision mechanism (Mastodon command mapping) is P4, out of the solo profile | Extend 03's reconciliation duty one notch: where a flagged outcome hands off to a human, the port SHOULD reconcile the human's disposition onto the same `context` |
| 42 | What replay proves is never stated in one place — it recomputes signatures, chains, digests, tallies, and rules, never a `Result`'s `content`; and the dedupe rule is quietly load-bearing as the verdict-consistency control for non-deterministic brains | One paragraph in 04's replay procedure stating the guarantee's boundary, with the dedupe rule cross-referenced as what makes a brain's verdict single-valued |

### Campaign 7 → v3.24–v3.27 (ADR-0014, ADR-0015)

Seven findings from [scenario 10](10-the-incident-bridge.md), the first workload that needs
a *shared* hub rather than a mesh of pairwise agreements — and therefore the first to ask
P5's two defining questions out loud. Written before the P5 stack ADR on purpose: every
finding this repository has acted on came from a scenario that went first.

**Closed 2026-08-21, the same day it opened** — seven findings, two ADRs, both built and
gated: [ADR-0014](../adr/0014-p5-shared-hub-stack.md) (43–46) and
[ADR-0015](../adr/0015-the-case-file-at-n-parties.md) (47, 49, and 48's second half; the
first half closed at source in ADR-0010 Decision 5). The through-line held to the end:
every fix either reused machinery that already existed or made an existing silence
visible, and the one genuinely new record surface (`afp:uncounted`, `afp:state`) entered
where state stops changing rather than while it still is.

The through-line: **the hub is somebody's server.** P4 could avoid that question because
there was no hub; P5 cannot, and five of the seven findings are one decision wearing
different faces — who hosts it, how a member proves membership to a third party, what
members do while the host is partitioned, and whose state the case file carries.

**Triaged into two proposed ADRs and one amendment**, grouped by the decision each finding
forces rather than by the subject it touches:

- [ADR-0014](../adr/0014-p5-shared-hub-stack.md) — the P5 shared-hub stack (43, 44, 45,
  46): everything that changes how the **hub itself** behaves and how members relate to it.
  `afp:MembershipProof` so a member can prove enrollment to a peer that does not host the
  hub; the host-as-participant problem and a sanctioned degraded mode; the hub as the
  sequencing authority its members' clocks cannot be; and a quorum that can tell silence
  from refusal. Follows the P2/P3/P4 stack-ADR convention.
- [ADR-0015](../adr/0015-the-case-file-at-n-parties.md) — the case file at N parties (47,
  49, and the second half of 48): what an export *proves* once there are more than two of
  them. Extends ADR-0009's join from a pair to all-pairs, carries the hub's converged state
  into the record via `afp:Archive`, and makes a per-domain check census visible so a
  bundle that checked nothing cannot pass as a clean one.
- **An amendment to [ADR-0010](../adr/0010-pinning-without-an-auction.md)** for the first
  half of 48 — its own open question, that a redacted pin-bearing `Offer` leaves a thread
  whose pins resolve to nothing. A live hole *today* at N=1, not a P5 problem. **Done:**
  ADR-0010 Decision 5, built and gated — the export refuses to emit such a bundle, and
  replay names one arriving from elsewhere. Closed before P5 widens the redaction surface,
  which was the point of triaging it separately.

Build order follows the dependencies rather than the numbering: the ADR-0010 amendment
first (small, and it is a correctness hole in shipped code), then ADR-0014 with finding 43
first inside it — it is what unblocks ADR-0013's `hub` reads and therefore the scenario's
third beat — then ADR-0015, which needs a working three-party flow to have anything to
replay.

| # | Finding | Candidate |
|---|---|---|
| 43 | *(**closed** — ADR-0014 Decision 1, built)* `afp:MembershipProof` was a noun with no mechanism, and it blocked the read path: a hub-class activity lives in its author's outbox, but the fetching member is enrolled in a hub the author does not host, so ADR-0013's `hub` predicate (scoped to locally-hosted hubs) refuses every cross-member read | Define it — a signed, expiring statement by the hub naming agent, hub and role, presented by the fetcher and verified against the hub's published key |
| 44 | *(**closed** — ADR-0014, built)* The hub is a single point of failure that is also a participant; when the host is the operator having the incident, the shared state goes with it and the spec's implicit answer is "wait" | State the risk in 06 and sanction a degraded mode: members MAY continue on the P4 direct flow and reconcile into the hub on its return, as a recorded act |
| 45 | *(**closed** — ADR-0014, built)* Three clocks, one timeline, no comparison — `published` is self-asserted and monotonicity is chain-local, while "who knew what when" is the audit's first question | The hub SHOULD anchor its own chain head on a cadence (ADR-0012's mechanism); cross-operator ordering claims SHOULD be relative to hub-observed order |
| 46 | *(**closed** — ADR-0014, built)* An unreachable member is not an abstention, and a `DecisionRecord` cannot tell them apart — liveness registers, which would, live on the partitioned hub | Record the snapshot members from whom no vote was counted, distinguishing a recorded `Reject` from silence |
| 47 | *(**closed** — ADR-0015, built)* The case file omits the state the operators worked from: ADR-0012 keeps CRDT state out of the export correctly, and at P5 that state *is* the coordinated timeline | Make ADR-0012's own revisit trigger concrete — `afp:Archive` carries the final converged state into the record as an activity, once, when it stops changing |
| 48 | *(**closed** — first half ADR-0010 Decision 5, second half ADR-0015's census)* A no-op check hides better in three bundles than in one — ADR-0010's unresolved redaction question means a stubbed pin-bearing `Offer` leaves checks silently passing, and per-domain phase one makes that indistinguishable from clean | Resolve ADR-0010's open question before P5 widens the redaction surface; have the joint replay report a per-domain check census, so a bundle that checked nothing is visible |
| 49 | *(**closed** — ADR-0015, built)* ADR-0009's join was specified for a pair — received bytes resolve against *the* sender, agreements are digest-equal across *two* copies — and at N=3 a party can observe a divergence between two others | State the join as all-pairs, and decide whether a divergence between two domains is reported to the third |

### Campaign 8 → built (scenario 11 → ADR-0018, ADR-0019)

**Closed 2026-08-22.** Eight findings from [scenario 11](11-the-snow-day.md), the first workload where the hub's
output is a **binding decision** rather than a pooled conclusion: three parties who must
close their schools together or not at all, before a deadline the world sets, on evidence
only one of them can see. It is also the first scenario with a **running counterpart** —
`npm run demo:p5:llm` in the reference instance — so its numbers are copied from an actual
run rather than imagined, which is how finding 51 was noticed at all (a decision closing on
exactly half the electorate, with the record unable to say whether that sufficed).

**The through-line: campaign 6 found that the machinery had anchored itself to the
Announce/Award pair and that the degenerate direct flow lost all of it. ADR-0010 extended
the anchor to the direct `Offer{Task}` and stopped there — and the governance round, opened
with `Offer{afp:Proposal}`, has no task-bearing activity at all.** It therefore inherits no
pinning, no action policy, no sufficiency and no irrevocability declaration. Nobody noticed,
because until this scenario every recorded decision was about work rather than about the
world.

**Triaged into two proposed ADRs and one lighter track**, grouped by the decision each
finding forces rather than by the subject it touches:

- [ADR-0018](../adr/0018-the-round-as-a-commitment.md) — **the round as a commitment**
  (50, 51, 56, 57) — **accepted and built**, findings 50, 51, 52, 56 and 57 closed: everything that makes a round answerable to the world it decides for.
  A proposal that pins its own deadline and quorum rule; the 03 diagram/prose
  contradiction ruled for the prose — an expired or under-threshold round closes with a
  reserved `afp:no-decision` outcome (ADR-0010 Decision 4's release, arriving at the
  round); a declared `afp:binding` with `afp:Departure` as the recorded act of not
  following an outcome — visible non-compliance over unenforceable compliance; and the
  `DecisionRecord` as a settleable subject, so 04's dissent credit finally reaches the
  arena where dissent is most expensive.
- [ADR-0019](../adr/0019-acting-on-a-decision.md) — **acting on a decision** (53, 54,
  55) — **accepted and built**, all three closed: the campaign's through-line as one ADR. `Offer{afp:Proposal}` becomes a pin site
  under ADR-0010 Decision 1's discipline, rooting the resolution chain for actions on
  `DecisionRecord`s; the role table gains an `actuator` — reads everything, influences
  nothing, publishes only `afp:actsOn`-bearing activities; and the actor of a
  decision-actuation is checked at replay against the Enroll trail the verifier already
  rebuilds.
- **Spec precision, no ADR** — finding 52 lands as two sentences in 02, folded into
  ADR-0018's Decision 5: the dilution consequence stated plainly (a silent seat spends
  its own operator's weight — the cure is not to pin it), and the electorate stated as
  proposer-declared and visible, which the implementation's explicit-voters parameter
  already is.

Built in that order — ADR-0018's finding 51 first (a pinned, recomputable quorum rule —
the one live gap in shipped records, found by reading a demo's output), then the rest of
ADR-0018, then ADR-0019. **The seam between them resolved against ADR-0018.** It had
ruled that a `no-decision` outcome admits no action; grounding ADR-0019 in ADR-0010
Decision 4 showed that ruling was the parked-application failure wearing a safety hat, so
a round that fails to decide *does* release its actuator, through the policy's reserved
`afp:no-decision` key. ADR-0018's clause is amended in place with the reasoning kept.

| # | Finding | Candidate |
|---|---|---|
| 50 | *(**closed** — ADR-0018 Decision 1 + 2, built)* A round has no clock, and the deadline that matters is not the hub's — `afp:Proposal` pins no voting window, and 03's diagram abandons a timed-out round (`Undo{Vote}`) while the prose four lines below states every round closes with a `DecisionRecord` | Pin an optional deadline; rule the contradiction for the prose — an expired round closes with a non-answer outcome, the shape ADR-0010's `afp:no-verdict` release already has |
| 51 | *(**closed** — ADR-0018 Decision 1, built)* The quorum threshold is specified everywhere and pinned nowhere — 02 calls quorum "a weight-sum threshold" with two named minimums, and no proposal carries one, no close checks one, no replay recomputes one | Pin the rule beside the weights it is computed over, recomputable at replay; failing to clear it becomes a defined outcome |
| 52 | *(**closed** — ADR-0018 Decision 5, spec precision in 02)* A silent seat spends its own operator's weight — ADR-0005's per-operator total is preserved but split per pinned voter, so seating an agent that never votes halves the voice of the one that does; `afp:uncounted` names the silence, not its price | State the deployment consequence in 02; better, let a snapshot exclude by declared participation |
| 53 | *(**closed** — ADR-0019 Decision 1, built)* `Offer{afp:Proposal}` is not a task-bearing activity, so a decision reached by a round alone can pin no `afp:actionPolicy` and declare no `afp:irrevocableActions` — finding 34 one flow further out | Extend ADR-0010 Decision 1's fallback to the proposal, same whole-object equality rule |
| 54 | *(**closed** — ADR-0019 Decision 2, built)* The role vocabulary has no actuator — a party whose function is to carry out a decision it must not influence has no seat; `observer` cannot publish, `member` hands it a vote | An `actuator` role, or a narrow `observer` write-path restricted to `afp:actsOn`-bearing activities, mirroring the requester's |
| 55 | *(**closed** — ADR-0019 Decision 3, built)* Nothing constrains who may act — replay checks the binding, the category and the admissibility, never the actor | Require the actor to be enrolled in the hub whose round produced the outcome, checked from the Enroll trail replay already rebuilds |
| 56 | *(**closed** — ADR-0018 Decision 4, built)* A `DecisionRecord` cannot be settled, so a correct dissenter cannot be credited — settlement binds to estimates or a Synthesis, follows an award, once per task; 04 states the stake itself ("a swarm that penalizes accurate minority objections will stop producing them") | Let a settlement take a `DecisionRecord` as its subject, keeping the award-follows precondition for the allocation case |
| 57 | *(**closed** — ADR-0018 Decision 3, built)* An outcome that binds jointly has no expression, and defection has no record — harmless while outcomes were divisible, load-bearing once a decision is indivisible by construction | A declared joint-binding property on the proposal, plus a recorded act by which a member states it is not following an outcome it was pinned into — visible non-compliance beats unenforceable compliance |

### Campaign 9 → built (scenario 12, the P6 shakedown)

**Opened 2026-08-22, closed 2026-08-23.** Eight findings from [scenario 12](12-the-parametric-trigger.md),
the first workload at n≥4 operators — where L1's `floor(2n/3)+1` is real tolerance
rather than the n=2 accountability consolation — and the first with adversaries *inside*
the agreement: a member for whom a failed round is profitable (its arbitration clause
wakes on `afp:no-decision`, so campaign 8's honest non-answer terminal becomes a target),
a key its operator later claims was captured, and an honest node whose restore-from-backup
produces the exact record shape of an equivocator. Written before the P6 stack ADR on
purpose, per the standing pattern.

**The through-line: the proof is about a key; every consequence is about a party.**
The cryptography held end to end — chained votes, anti-entropy, the standalone proof,
automatic zeroing, the governance rollup — and every finding lives *after* the moment of
cryptographic conviction, in territory L1 never specified. A second pattern repeats from
campaigns 6 and 8: machinery gains power faster than the rules governing access to it —
ADR-0018 made the proposal the protocol's most consequential object, and the view-change
sentence that hands proposals out was never re-examined (finding 62, the scenario's own
triage suggestion for first, since it is the only finding that makes an attack *cheaper*
as specified).

**Triaged into two proposed ADRs and one amendment** (2026-08-22), grouped by the
decision each finding forces rather than by the subject it touches:

- **[ADR-0020](../adr/0020-p6-hardened-round-stack.md) — the P6 hardened-round stack**
  (62, 58, 60, 61) — **accepted and built** (2026-08-22, `test/adr0020.test.ts`, 10
  cases, suite green at 192; findings 58, 60, 61 and 62 closed): everything that changes
  how the **L1 round itself** behaves, following the P2/P3/P4/P5 stack-ADR convention.
  The proposal pins its own succession — a deterministic successor rule over the pinned
  snapshot, zeroed voters excluded, checked at replay (62 — first, inside its own ADR,
  because it is the only finding that makes an attack *cheaper* as the spec stands, and
  because it is ADR-0018's own pinning discipline applied to one more sentence); the
  equivocation predicate ruled precisely — differing *values* convict, a same-value hash
  mismatch becomes a defined state-loss event with a compliant re-vote path (58 — before
  any demo exists, since a demo that cannot tell the backup-restore from the equivocator
  would be gating the wrong thing); the provably-doomed round closes `afp:no-decision`
  early, citing arithmetic replay recomputes (60 — ADR-0018 Decision 2's shape, arriving
  before the deadline instead of at it); and the joint replay scans received votes
  cross-domain for same-tuple conflicts, failing by name on any pair without an on-record
  proof — which is what makes a MUST-announce duty on proof-holders enforceable rather
  than aspirational (61 — ADR-0015's all-pairs join extended one check, the machinery the
  scenario found already half-covering it).
- **An amendment to [ADR-0005](../adr/0005-operators-are-equal.md)** for 63 — the
  declared change of control — **built** (2026-08-22, gated in `adr0005.test.ts`;
  finding 63 closed). Small on its own: an `afp:operatedBy` transfer act in the
  existing Vouch/Disown grammar, which a snapshot MUST consult (seats under common
  declared control merge to one operator-weight, per ADR-0005's own rule), plus the
  honest sentence in 02 that *undeclared* common control is collusion-class —
  consortium-terms territory, exactly as cross-instance bid collusion already is.
  Triaged separately rather than folded into ADR-0021 because it amends ADR-0005's core
  invariant, and because ADR-0021's recusal needs its recompute-over-a-remainder
  machinery to already exist.
- **[ADR-0021](../adr/0021-conviction-to-consequence.md) — after the proof: conviction to
  consequence** (59, 64, 65) — **accepted and built** (Decisions 1 and 2 on 2026-08-22,
  Decisions 3-5 on 2026-08-23; `test/adr0021.test.ts`, 24 cases, suite green at 221 —
  findings 59, 64 and 65 closed). Decomposing it turned up
  **two** defects older than the campaign and promoted both ahead of the findings that
  exposed them. The first: `afp:Unenroll` has no authority check in either
  implementation, so anyone with a verifying key can remove any agent from any hub —
  which makes every electorate rule built on the Enroll trail theatre until it is fixed.
  The second: the pinned electorate is never checked. `afp:quorumSnapshot` is a digest nothing recomputes, and
  omission from `afp:voters` is unlimited and invisible — so a hub already had an
  undeclared, undetectable recusal, and a declared one layered on top would have bound
  only the honest. The campaign's
  through-line as one ADR — conviction is cryptographic, consequence is governance, and
  the seam between them is unbuilt. A recorded compromise claim referencing the proof and
  feeding the instance-level governance round that already exists, with restoration a
  GovernanceDecision like any other membership act — zeroing stays automatic either way
  (59); a declared recused set with recorded cause on the proposal, excluded from the
  snapshot with per-operator totals recomputed over the remainder, checked at replay as
  the estimator wall already is (64); and the proof given a destination — citable as
  enrollment evidence, consumable by a named reputation-registry derivation, with
  blacklist federation explicitly declined and the reasons recorded (65).

Build order follows the dependencies rather than the numbering: **ADR-0020 first, with
finding 62 first inside it** (the live attack surface, and the smallest fix), then 58
before any P6 demo is written, then 60 and 61; **the ADR-0005 amendment second** (63 —
it hands ADR-0021 the electorate-recompute machinery recusal needs); **ADR-0021 last**,
because a contest, a recusal and a portable proof all presuppose a round that can no
longer be captured or quietly stalled. The seam to watch: 60 and 64 both shrink an
electorate mid-flight — one by arithmetic, one by declaration — and the two must resolve
weight the same way or replay will need two rules where one should do.

| # | Finding | Candidate |
|---|---|---|
| 58 | *(**closed** — ADR-0020, built)* Equivocation is "different value" in 03's prose and "different hash" in its diagram — a backup-restored honest re-vote convicts under one reading, and an observed-set-only equivocator escapes under the other | Rule it precisely: proof requires differing values; same-value hash mismatch becomes a defined state-loss event with a compliant re-vote path |
| 59 | *(**closed** — ADR-0021 Decision 4, built)* The proof punishes the key, not the culprit — no contest path, no compromised-vs-malicious distinction, no ADR-0012 interplay, no restoration mechanism | A recorded compromise claim feeding the existing instance-level governance round; zeroing stays automatic, restoration becomes a GovernanceDecision |
| 60 | *(**closed** — ADR-0020, built)* A doomed round is indistinguishable from a pending one — zeroing can make the pinned quorum rule unsatisfiable with the deadline days away | A defined early close: `afp:no-decision` citing recomputable impossibility, checked at replay like the tally |
| 61 | *(**closed** — ADR-0020, built)* Nothing obliges completing a proof, and concealment is invisible — though both halves of the pair already sit in the joint case file | The joint replay scans received votes cross-domain for same-tuple conflicts and fails by name on any pair lacking an on-record proof; then a MUST-announce duty has teeth |
| 62 | *(**closed** — ADR-0020, built)* The view change is unpinned power — "highest-reputation live replica" is recomputable nowhere, excludes nobody (not even the zeroed equivocator), and now confers ADR-0018's full pin authority | The proposal pins its own succession: a deterministic successor rule over the pinned snapshot, zeroed voters excluded, checked at replay |
| 63 | *(**closed** — ADR-0005 amendment, built)* A declared change of control has no mechanism — five seats, four owners, and the f=1 arithmetic silently assumes an independence the record cannot state | An `afp:operatedBy` transfer act in the Vouch/Disown grammar that snapshots MUST consult; undeclared control named honestly as collusion-class, consortium-terms territory |
| 64 | *(**closed** — ADR-0021 Decisions 2 and 3, built)* The accused votes on its own expulsion — the governance path has no recusal, though the estimator wall solved the same shape at bid admission | A declared recused set with recorded cause on the proposal; snapshot excludes them with per-operator totals recomputed; replay checks it |
| 65 | *(**closed** — ADR-0021 Decision 5, built)* The proof does not travel — enrollment weighs vouches not history, reputation consumes settlements not proofs, so a convicted equivocator re-enrolls elsewhere clean | Enrollment MAY cite proofs as evidence; a named reputation-registry derivation MAY consume them; blacklist federation explicitly declined, with reasons |


### Campaign 10 → built (scenario 13, the P7 shakedown)

**Opened and closed 2026-08-23.** Nine findings from [scenario 13](13-the-quarterly-split.md), the
first workload whose subject is a **set** of events rather than an event — four support
desks splitting one retainer by what each of them actually did. Written before the P7
stack ADR on purpose, the third time after scenarios 10 and 12, and the first shakedown
in which **nobody misbehaves**: every party is honest, and they still cannot agree on the
number.

**The through-line: a sum is only as recomputable as its input set is agreed, and the
protocol does not name sets.** P1 through P6 made each event checkable — this signature,
this tally, this proof, this expulsion — and every one of those answers a question about
something you can point at. `afp:ContributionSummary` is the first object whose subject is
a *boundary*: which events, over which window, seen by whom, credited at what weight,
still valid under which vocabulary. Each finding is a different edge of that boundary left
undrawn.

A second pattern, familiar since campaign 6 and confirmed here for the fourth time:
**fields outlive the mechanisms they were written for.** `afp:contributionSplit` has been
normative since v3.4 (campaign 1's finding 7) and implemented never; `afp:inputHash` has
sat in 04's example since the same revision with no preimage ever defined. Both are the
`afp:hubKey` shape ADR-0021's W0.8 named — a field nobody checks is documentation
pretending to be a mechanism — and both sit directly under the arithmetic P7 exists to
make checkable.

**Triaged into one stack ADR** (2026-08-23), following the P2/P3/P4/P5/P6 convention:
[ADR-0022](../adr/0022-the-summary-declares-its-frame.md) — the summary declares its frame
(66-73), with 74 amended into [ADR-0017](../adr/0017-standards-conformance.md) where the
standards-conformance rules live. **All five decisions and the amendment are built** (`adr0022.test.ts`, 24 cases, suite
green at 245).

Build order followed the campaign's own logic — the defect that makes an honest party
invisible first. `afp:contributionSplit` went first because it needs no summary object to
exist, it closes a rule normative since v3.4 and implemented never, and every later
decision reads the credit it fixes. Building it found the sharper half of finding 67: a
fractional share does not fail the accounting check, it fails **canonicalisation** — the
JCS profile refuses to read a signed document containing one, so 03 as written was
unimplementable rather than merely awkward.

| # | Finding | Candidate |
|---|---|---|
| 66 | *(**closed** — ADR-0022 Decision 2, built)* `afp:contributionSplit` is required by 03 whenever `attributedTo` names several actors — and implemented nowhere, so the pool's commonest pattern (one desk triages, another fixes) credits neither | Implement it on both sides, and make "counts for no one" a visible outcome rather than a silent subtraction |
| 67 | *(**closed** — ADR-0022 Decision 2a, built)* A map of fractions summing to 1 is unrepresentable under the JCS numeric profile — the wall ADR-0005 already hit for vote weights and solved with integer shares over an LCM denominator | Integer shares plus a declared denominator; the same arithmetic, unforked |
| 68 | *(**closed** — ADR-0022 Decision 1, built)* `afp:period` selects on self-asserted `published`, which ADR-0014's finding 45 already ruled cannot carry cross-operator ordering — a ticket straddling a quarter boundary belongs to whichever quarter its author says | Define the period over hub-observed order, ADR-0014's own answer applied to the question it did not anticipate |
| 69 | *(**closed** — ADR-0022 Decision 3, built)* `afp:inputHash` has no defined preimage: the field exists so a second party can confirm it summed the same things, and nothing says what those are | Define the canonical input set and ordering; recompute at replay; fail a summary whose hash does not match the set it declares |
| 70 | *(**closed** — ADR-0022 Decision 1, built)* "Any member can recompute it" (04) collides with visibility (07, ADR-0013): non-`public` work is 404 to everyone unentitled, so two members recompute honestly and disagree with no way to tell an entitlement gap from an error | The summary declares its input scope and counts what the computer could not read — ADR-0015's census, in accounting form |
| 71 | *(**closed** — ADR-0022 Decision 4, built)* Work that did not hold has no accounting rule and often no marker: `afp:Settlement` actuals move reputation and `afp:supersedes` retracts a ratified Synthesis, but neither states a contribution consequence — and a bare Result on a direct award has no vocabulary at all | Credit at acceptance; record the settlement or supersession as its own fact inside the period; check it, so both readings stop being available |
| 72 | *(**closed** — ADR-0022 Decision 4, built)* An expulsion's accounting scope is unstated: ADR-0021 forward-scoped conviction for *weight* and said nothing about contribution, so a summary spanning one either counts the expelled member's accepted work or erases it | State the parallel — accounting is forward-scoped too — and record the membership change inside the period |
| 73 | *(**closed** — ADR-0022 Decision 5, built)* A dispute has no terminal: 04 resolves the mechanical case by republishing a corrected summary, producing two unranked summaries for one period with no supersession edge and no rule for which stands | Ratify a summary in an ADR-0018 round; corrections supersede under ADR-0007's grammar; everything else is a draft and says so |
| 74 | *(**closed** — ADR-0022's ADR-0017 amendment, built)* A summary's inputs are historical by definition, and the vocabulary moves under them: the `afp:bidCommit` → `afp:BidCommit` rename (ADR-0017 D5) shipped with no read-side compatibility, so pre-rename bundles fail replay today, and fail *misleadingly* | Read-side aliases for renamed types (the draft-cavage precedent, ADR-0017 D2); a named failure for a retired spelling; a summary that pins the vocabulary it was computed under |
