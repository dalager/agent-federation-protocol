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
membership churn, sneakernet/airgapped federation, an adversarial operator rather than a
merely buggy one, and a task whose answer must be revised after the fact
(retraction/supersession of a published Synthesis). Client/observer participation was
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
