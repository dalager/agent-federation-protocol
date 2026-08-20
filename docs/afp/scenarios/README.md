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
| [· tuesday](the-operators-tuesday.md) | The operator's Tuesday | The built stack's ordinary day, every noun pointing at a file — commands, tables, outputs and warts of the solo profile as it runs today; the hard-focus baseline the P4 build will be measured against | — |

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

### Campaign 5 → v3.16 (ADR-0008) — 29a/29b open

Seven findings from [scenario 08](08-the-subcontract.md), the P4 shakedown: the
handshake exercised alone, with an adversarial prober and a two-export replay. The raw
walkthrough surfaced five; the scenario's own review pass split one and added one, and
its corrections are folded into the scenario's verdict. Findings 25–28 and 30 are **resolved** — [ADR-0008](../adr/0008-p4-federation-stack.md)
accepted and built (v3.16): grants, dual-Create activation, the hop's HTTP Signatures
over the one payload suite, the hash-chained boundary log, expiry semantics with the
global monotonicity backstop, and both ingestion duties enforced at the receiving port.
**29a/29b have a proposed resolution** in
[ADR-0009](../adr/0009-federated-replay.md) — federated replay as N single-export
replays plus a cross-check, authority partitioned by `afp:operatedBy`, and redaction as
an export-time transform emitting digest-only stubs, so discretion is declared and
deletion is detected. They mark resolved, and the campaign closes, when it is accepted
and built.

| # | Finding | Candidate |
|---|---|---|
| 25 | The agreement's scope grammar is hub-shaped — the narrowest real federation (direct delegation, no hub) cannot state its own scope | Scope as a set of grants: hubs and/or capabilities-for-direct-delegation, the gate checking each activity against the grant that admits it |
| 26 | Boundary rejection leaves no trace — a refused stranger and a silent wire are the same record | Local by necessity (no commitment point exists for a stranger — verifiable rejection is impossible in the negative), but stronger than a log: a hash-chained, instance-signed rejection record, exportable as an assertion |
| 27 | "LD-Signatures" wording is pre-ADR-0001 drift — in the roadmap's P4 row and 01's tooling list; 04 already fuses the terms into the two-layer model | Wording cleanup plus ADR-0008 confirming `eddsa-jcs-2022` satisfies 04's relay obligation; no interop pressure forces RDF canonicalization |
| 28 | Agreement expiry vs in-flight work was unstated | As ruled in the scenario: expiry stalls new work, an accepted `correlationId` flows to terminal outcome — plus the backstop that pays everywhere: `published` non-decreasing along each `prevActivity` chain |
| 29a | Verifier completeness is single-domain | Per-trust-domain completeness, cross-export resolution, holes attributed to their domain — and authority **partitioned by `afp:operatedBy`**, so one bundle cannot smuggle forged counterparty actor documents |
| 29b | A scoped export and a tampered one share a signature — lawful redaction gaps a `prevActivity` chain exactly as deletion does | A record-level redaction mechanism (digest-only stubs keeping the chain linkable), decided as spec, not patched in the verifier |
| 30 | Neither ingestion duty names the federated boundary as its site — 04's untrusted-result sandbox and finding 19's port summary both apply to a subcontractor's Result, and neither says so | One paragraph siting both duties at the boundary, before "boundary-ready" gets read as "trust the attachment" |
