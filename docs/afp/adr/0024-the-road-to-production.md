# ADR-0024 — The road to production: what "production" means for AFP, and the program that gets there

- **Status:** Proposed (2026-09-02) — the umbrella for ADRs [0025](0025-transport-hardening.md)
  through [0034](0034-release-conformance-and-disclosure.md). It decides what the
  claim "production" means for this protocol and sequences the ADRs that make it true;
  it builds nothing itself
- **Date:** 2026-09-02
- **Applies to:** the whole record — spec, instance, verifier, scenarios, and the
  operator who runs it
- **Builds on:** every phase ADR (P1–P7 are built and gated); [ADR-0023](0023-loose-ends-triaged.md)
  (the ledger of what those ADRs left open); [ADR-0017](0017-standards-conformance.md)
  (the compatibility claim, and the one decision it holds back)
- **Driven by:** the 2026-09-02 review of the built stack against the thirteen scenarios
  and against the transport and gate code — three questions, three answers:
  *usable* as a protocol and record format, not yet as a deployable system; *hardened*
  by what AFP added, not by ActivityPub; *scenarios supported* in the coordination core
  and narrowed at every external edge

## Context

P7 closed on 2026-08-23. Every phase the roadmap named is built, gated by mutation tests,
and demonstrated over real sockets. A stranger with no keys can replay what was said, by
whom, under which pinned rules, and every recomputable thing recomputes. That is the
thesis, and it holds.

It is also all that holds. The review found the distance from "the thesis holds" to "an
operator can run this for a real consortium" to be four things, none of them a phase:

1. **The transport is a demo transport.** No TLS enforcement, no fetch policy, no SSRF
   guard, no body cap, no rate limiting, retries that burst through a virtual clock. The
   record's cryptography is sound; the process that carries it would not survive a
   hostile network for a day.
2. **The edges are conventions.** Every scenario's external system — the bug tracker, the
   repo, the caseworker system, the client app, the bus company — is assigned by the spec
   to a "port agent" that MUST reconcile outcomes and MUST bound hostile text. No port
   agent exists. The model brain receives task content and decoded attachment bytes
   verbatim (`src/instance/src/brains/openai.ts`).
3. **Nothing runs unattended.** There are no timers in the instance. Sweeps, retries and
   convergence happen when a script calls them. The author's own baseline calls the
   architecture "a ledger with opinions, and programs that visit it", which is honest and
   is not production.
4. **The premise is under-stated.** ActivityPub earns its place as an identity,
   discovery and vocabulary convention. It provides no security property and no
   behavioural interop — a stock Mastodon server drops every AFP object, and the one
   bridge the spec offers is a function nobody calls. The spec should say what AP buys
   and stop implying the rest.

Two things are worth stating so the program does not overreach. The protocol's honest
limits — Byzantine tolerance only at four or more operators, the hub host as an
availability single point, readership unprovable — are **not** production gaps; they are
ruled and recorded, and the program leaves them alone. And the FEP
([ADR-0017](0017-standards-conformance.md) Decision 8) stays the operator's call; the
program does not schedule it.

## Decisions

### 1. "Production" is a set of claims, each with an ADR that makes it checkable

An AFP instance is production-ready when every claim below is true and gated, in the
sense the phases already established: a gate that can fail, a demo that runs, a document
that says so with every noun pointing at a file.

| # | Claim | Group | ADR |
|---|---|---|---|
| C1 | Every transport surface survives a hostile internet: TLS-only, bounded fetches, no server-side request forgery, capped bodies, rate limits, real backoff | Security | [ADR-0025](0025-transport-hardening.md) |
| C2 | Keys are custodied behind a signer port, rotatable and revocable by runbook, and `afp:keyHistory` names every key that ever signed | Security | [ADR-0026](0026-key-custody-and-the-signer-port.md) |
| C3 | Hostile text and untrusted bytes cannot steer a brain or execute; the record says what each brain was told | Security | [ADR-0027](0027-the-port-is-a-security-boundary.md) |
| C4 | The external systems the scenarios describe run as code behind port-agent contracts, with reconciliation and idempotency gated | Scenario coverage | [ADR-0028](0028-port-agents.md) |
| C5 | Humans approve, watch and command through a first-class AFP surface; the ActivityPub premise is stated precisely and the Mastodon window is an optional projection | Scenario coverage | [ADR-0029](0029-the-human-window-and-the-activitypub-premise.md) |
| C6 | The support index tells "mechanism gated" from "workload demonstrated" per acceptance criterion, and the four early scenarios are re-walked once C3 and C4 land | Scenario coverage | [ADR-0030](0030-scenario-re-walks-and-the-coverage-index.md) |
| C7 | The instance runs unattended: scheduler, retries, sweeps, convergence, health, metrics, graceful shutdown, single-writer discipline | Operations | [ADR-0031](0031-the-resident-process.md) |
| C8 | The instance deploys behind TLS with validated configuration, versioned schema migrations, backup and restore runbooks | Operations | [ADR-0032](0032-deployment-profile.md) |
| C9 | The operator has published, signed, the obligations a deployment owes: seat policy, controllers, retention, thread layout, brains, terms | Operator obligations | [ADR-0033](0033-operator-obligations.md) |
| C10 | Releases are versioned, every shipped bundle replays unchanged on every commit in CI, a third implementation can run the conformance kit, and there is a disclosure process | Release engineering | [ADR-0034](0034-release-conformance-and-disclosure.md) |

### 2. Groups run in parallel; scenario coverage waits for its two prerequisites

Security (C1–C3) and operations (C7–C8) share no files and proceed concurrently. C4 and
C5 depend on C3, because a port agent that hands a brain unbounded text is the gap C3
closes. C6 runs last, because it re-walks scenarios against C3, C4 and C5. C9 and C10 can
start any time and must be finished before the program is declared done.

### 3. The program's definition of done is a scenario, not a checklist

[The operator's Tuesday](../scenarios/the-operators-tuesday.md) is the baseline the
solo profile was measured against: the built stack's ordinary day, every command and path
real, warts listed. The program is done when **scenario 15, the production Tuesday**
([ADR-0030](0030-scenario-re-walks-and-the-coverage-index.md) Decision 3), can be
written the same way about a served instance on the public internet holding a real
consortium's record — and its warts list is shorter than the baseline's, not merely
different.

### 4. What the program does not promise

- **Fediverse behavioural interop.** AFP objects are not consumable by fediverse
  software and will not become so. [ADR-0029](0029-the-human-window-and-the-activitypub-premise.md)
  says exactly what is and is not interoperable.
- **A workflow engine.** Operators drive workflows with their own programs against the
  library and the ports. [ADR-0028](0028-port-agents.md) gives them contracts, not an
  orchestrator.
- **Byzantine tolerance below four operators, or a hub that survives its host.** Ruled in
  03 and [ADR-0014](0014-p5-shared-hub-stack.md); repeated here so nobody reads the
  program as reopening them.
- **The FEP.** Deferred by the operator's choice; unchanged.

### 5. ADR-0023's ledger is consumed, not duplicated

Every ADR-0023 row that this program closes names its ADR here. Rows the program does not
touch stay parked in the ledger with their triggers.

| ADR-0023 row | Program ADR |
|---|---|
| L1 (key history covers every key) | ADR-0026 |
| L2 (export scopes: visibility floor, agreement grant) | ADR-0026 Decision 5 — an export is a key-custody artefact as much as a record |
| L4, L5 (electorate floor; who may pin a governance subject) | ADR-0033 — a hub policy question, decided as an operator obligation with a verifier check |
| L14 (the seat-migration scenario) | ADR-0030 |
| L16, L17 (shadow Notes and command grammar wired) | ADR-0029 |
| L19 (seat-policy default flip) | ADR-0032 Decision 6 — a deployment default, flipped with a migration note |
| L20, L21 (periodic anti-entropy; boundary-digest heartbeat) | ADR-0031 |
| L3 (dispositions over governance actions), L6–L13, L15 | Not in this program: L3 is its own campaign; the reconciliations are slice 1 of ADR-0023 and need no ADR |

## Options considered

| Option | Rejected because |
|---|---|
| One "production" ADR with all decisions | Ten claims across four disciplines in one file would be the 1,948-line `hub.ts` of ADRs; each group has its own reviewers, files and gates |
| A P8 phase | The roadmap's phases add participants; production adds no participant. Calling it a phase would imply every profile must climb it, and the solo operator does not need rate limiting |
| Fix the transport first and leave the edges as conventions | The review's sharpest finding is that the early scenarios' intent lives at the edges; a hardened transport carrying unbounded text into a brain is not safer |
| Re-platform the envelope to plain signed JSON | Considered seriously in the review. Rejected in [ADR-0029](0029-the-human-window-and-the-activitypub-premise.md): the AS2 envelope, ids and signatures are sunk cost that works; what changes is the *claim*, not the bytes |

## Consequences

**Positive** — "usable" stops being a feeling. Ten claims, ten ADRs, ten gates, and a
scenario that is the definition of done. The review's findings each land in exactly one
place.

**Negative** — the program is larger than any phase, and most of it is unglamorous.
Nothing in it changes what a replay proves; all of it changes whether anyone could run the
thing that produces the replay.

**Accepted** — some ADRs below will be revised under contact, as every phase ADR was. The
program's own revisit trigger is the production Tuesday: if it cannot be written honestly
with these ten claims true, the claims were the wrong ten.

## Build status

Nothing built. This ADR closes when scenario 15 exists and every claim C1–C10 is marked
built in its ADR.

| Claim | ADR | State |
|---|---|---|
| C1 | 0025 | built |
| C2 | 0026 | built, less the `remote`/`agent` signer adapters |
| C3 | 0027 | proposed |
| C4–C6 | 0028, 0029, 0030 | proposed |
| C7–C8 | 0031, 0032 | proposed |
| C9–C10 | 0033, 0034 | proposed |

## References

- [ADR-0023 — The loose ends, triaged](0023-loose-ends-triaged.md)
- [The operator's Tuesday](../scenarios/the-operators-tuesday.md) — the baseline
- [05 — Roadmap](../05-roadmap.md) — the phases this program sits after
- [Scenarios support index](../scenarios/README.md#is-this-workload-supported)
