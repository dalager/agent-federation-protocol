# ADR-0031 — The resident process: a ledger with opinions grows a pulse

- **Status:** Proposed (2026-09-02) — program claim **C7** of
  [ADR-0024](0024-the-road-to-production.md); group: **Operations**
- **Date:** 2026-09-02
- **Applies to:** `npm run serve` — what a served instance does between requests, and
  what it tells an operator about itself
- **Builds on:** 04 § Reliability (deadlines and the delegator-side sweep; retries with
  backoff; backpressure), 02 § Gossip & anti-entropy, [ADR-0002](0002-p2-hub-and-crdt-stack.md)
  Decision 5 (deferred until needed), [ADR-0016](0016-p5-transport.md) Decisions 4–5
  (the exchange, hub-relayed by default), [ADR-0008](0008-p4-federation-stack.md)
  Decision 3 (the optional `afp:BoundaryDigest` heartbeat), [ADR-0025](0025-transport-hardening.md)
  Decision 6 (real-time backoff), [ADR-0004](0004-solo-foundation-hardening.md) H5 (the
  hub rehydrates from its store)
- **Driven by:** [the operator's Tuesday](../scenarios/the-operators-tuesday.md) — "there
  is no daemon", "nothing *notices* anything at night", "one writer" — and the review's
  verification that `src/instance/src` contains no timer outside demos and tests:
  `sweepOverdue`, `queue.drain` and `offerSync` run when a program calls them.
  [ADR-0023](0023-loose-ends-triaged.md) rows L20, L21

## Context

The baseline document is right that the cron-drives-a-library shape is honest, and right
that it is the reason "the agents noticed X" is never true unless a script ran. P4 added
the first resident process — the inbox listener — and with it the first thing that can
page an operator. It added nothing that acts on the instance's own behalf: an overdue
task becomes an `afp:Error` only when something calls the sweep; a queued delivery to a
peer that was briefly down is retried only when something calls `drain`, and then five
times in a second; two replicas of a hub converge only when a demo calls `offerSync`.

A served instance also says nothing about itself. There is no health endpoint, no
readiness check, no metric, and the logs are `console.log`. And the store is one SQLite
file with one writer, enforced by nothing: a second process opening the same file is a
corruption waiting for a moment.

## Decisions

### 1. `serve` runs a scheduler, and every scheduled act is either a recorded activity or a log line

A `Scheduler` in `runtime/scheduler.ts` owns four loops, each with a configurable
interval and jitter, each idempotent, each safe to run concurrently with inbox traffic:

| Loop | Default | Does |
|---|---|---|
| **sweep** | 30 s | `sweepOverdue()`: an overdue task becomes a recorded `afp:Error` (`deadline-missed`), as 04 specifies |
| **flush** | 10 s | `queue.flush(transport, now)` with a real clock: retries spaced by ADR-0025's schedule, `Retry-After` honoured, dead-letter after the configured attempts |
| **converge** | 60 s | one `Offer{afp:Digest}` toward each hub peer this instance replicates, hub-relayed by default (ADR-0016 D5); an urgent local change — an `Enroll`, an `Unenroll`, a proof — pushes immediately with decaying fan-out (02's rumor path), liveness registers excluded (ADR-0016 D3) |
| **heartbeat** | off | the optional `afp:BoundaryDigest` activity of ADR-0008 D3, published on an interval when enabled — closes ADR-0023 L21 by folding it here |

Scheduled acts that the spec says are activities are activities; the rest are structured
log lines. Nothing here is a new wire term. Closes ADR-0023 L20 and ADR-0002 Decision 5's
"until it's needed".

### 2. The instance answers for its own health

- `GET /healthz` — the process is up; unauthenticated, no body beyond `ok`.
- `GET /readyz` — the store opens, the signer answers, the origin serves its own actor
  document back to itself (the self-check [ADR-0032](0032-deployment-profile.md)
  Decision 2 specifies), the scheduler has ticked. Any failure is `503` with a named
  reason in the body — this one endpoint may say why, because it is for the operator's
  probe, not a stranger, and it names no data.
- `GET /metrics` — Prometheus text: inbox admissions and refusals by class (mirroring the
  boundary log's classes), queue depth and dead-letters, sweep counts, convergence lag
  per hub, rate-limit refusals. Counts only; no ids, no actors.

### 3. Logs are structured, and the boundary log stays the record

`console.log` becomes a JSON-lines logger with a level and a `component`. The boundary
log in SQLite remains the *record* of refusals — hash-chained, exportable — and the log
stream is its operational shadow, never the other way round.

### 4. One writer, enforced

The store opens in WAL mode. A lock file beside it holds the owning process id; a second
process refuses to start with a named error rather than opening the file. Concurrent
workflows share one process through the library, which is the shape the baseline already
describes; what changes is that the wrong shape now fails loudly instead of quietly.

### 5. Shutdown drains

`SIGTERM` stops accepting inbox POSTs, lets in-flight handlers finish (bounded by a
timeout), runs one final flush, releases the lock, and exits. Restart safety is already
gated (the hub rehydrates, ADR-0004 H5); this makes the stop side match.

### 6. Backpressure is honoured in both directions

Inbound: ADR-0025's rate limits answer `429`. Outbound: a peer's `429`/`503` with
`Retry-After` sets the minimum delay before the next attempt to that peer — 04's table
already claims it; the flush loop now does it.

## Options considered

| Option | Rejected because |
|---|---|
| Keep cron as the scheduler and document it | Cron cannot hold the single-writer lock a resident process holds, cannot honour `Retry-After` per peer, and cannot converge a hub replica between ticks |
| A message broker for the queue | ADR-0001 Decision 4 and every ADR since: the export is a file copy, and a broker breaks it for a queue SQLite already holds |
| Multi-process with a shared SQLite | WAL allows concurrent readers, not concurrent writers with this schema; the baseline's "one writer" is a fact of the design, so enforce it rather than pretend |
| Health endpoints authenticated | A load balancer's probe cannot sign requests; the endpoints name no data, so anonymity costs nothing |

## Consequences

**Positive** — something notices things at night; a peer that was down for two seconds
is retried in two seconds, not dead-lettered; replicas converge without a demo; the
operator has a probe, a metric and a log line.

**Negative** — the on-call wart the baseline predicted arrives in full: a resident process
can page. That is what production means.

**Accepted** — the scheduler's loops are the same functions the demos call; the demos and
the gate keep their injected clocks and run without it.

## Implementation architecture

### W1. Files

| Package | Touches | Content |
|---|---|---|
| **WP-1 · scheduler** | `runtime/scheduler.ts` (new), `cli.ts` (`serve`), `instance.ts`, `hub/hub.ts` (`offerSync` callers), `store/queue.ts` | Decisions 1, 6 |
| **WP-2 · health** | `ap/server.ts`, `runtime/metrics.ts` (new) | Decision 2 |
| **WP-3 · logs** | `runtime/log.ts` (new), every `console.log` in `src/` outside demos | Decision 3 |
| **WP-4 · writer** | `store/db.ts` (WAL, lock), `cli.ts` | Decisions 4–5 |
| **WP-5 · gate + docs** | `test/adr0031.test.ts`, instance README ("What this instance deliberately does not do yet" loses its first item), 04 § Reliability | W2 |

### W2. Gate matrix — `test/adr0031.test.ts` (fake timers)

| # | Case | Asserts |
|---|---|---|
| G1 | A task past its deadline, no program call | after one sweep tick, a recorded `afp:Error` `deadline-missed` |
| G2 | A peer down for one flush interval | delivered on the next tick; attempts spaced per schedule; no dead-letter |
| G3 | Two hub replicas diverged, no demo call | converged within two converge ticks; an `Enroll` pushes before the tick |
| G4 | Heartbeat enabled | an `afp:BoundaryDigest` activity per interval, on the record, replay clean |
| G5 | `/readyz` with the signer unavailable | `503` with the named reason; `/healthz` still `ok` |
| G6 | A second process on the same store | refuses to start; the first is unaffected |
| G7 | `SIGTERM` with an in-flight inbox POST | the POST completes; the lock is released; exit 0 |
| G8 | A peer answers `429 Retry-After: 30` | no attempt to that peer inside 30 s; other peers unaffected |
| G9 | Every shipped bundle replayed | unchanged |

## Build status

Not built.

## References

- 04 § Reliability & failure handling; 02 § Gossip & anti-entropy
- [The operator's Tuesday](../scenarios/the-operators-tuesday.md) § The warts
- [ADR-0023](0023-loose-ends-triaged.md) rows L20, L21
