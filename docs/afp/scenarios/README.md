# Spec-test scenarios

Each scenario walks a realistic workload through the protocol end to end, maps acceptance
criteria to spec mechanisms, and closes with a **verdict**: what held, and what strained.
Findings feed back into the spec — this directory is the reason v3.4 exists.

| # | Scenario | Axis stressed | Findings |
|---|---|---|---|
| [01](01-client-due-diligence.md) | Agentic due diligence on a new client | Solo profile, hub-per-case, direct delegation, HITL, audit replay | 3 |
| [02](02-observability-fix-pipeline.md) | Observability-to-fix pipeline | Standing hubs, ports vs. external providers, bidding as routing, risk gates | 3 |
| [03](03-co-staffed-project.md) | Two consultancies co-staffing a project | Federation, cross-operator governance, shared state, co-work, billing evidence | 4 + 2 recurring |

## Findings ledger

All nine distinct findings from the first campaign, and where each landed in v3.4:

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

## Writing another

Useful scenarios stress an axis the existing ones don't. Untested so far: three or more
operators (real Byzantine tolerance, coalition dynamics), long-lived hubs with heavy
membership churn, sneakernet/airgapped federation, an adversarial operator rather than a
merely buggy one, and client/observer participation with read-only scope.

Keep the format: user story → cast → walkthrough → acceptance criteria mapped to spec
mechanisms → verdict with findings. Be willing to conclude that something strained; a
scenario that finds nothing has usually been written to flatter the spec.
