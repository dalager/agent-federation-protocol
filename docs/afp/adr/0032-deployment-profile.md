# ADR-0032 — The deployment profile: TLS, origin, configuration, storage, upgrades, backup

- **Status:** Accepted (2026-09-02), **built** (2026-09-13) — program claim **C8** of
  [ADR-0024](0024-the-road-to-production.md); group: **Operations**
- **Date:** 2026-09-02
- **Applies to:** how an instance is put on the internet and kept there — everything
  between `git clone` and a served origin a counterparty can federate with
- **Builds on:** 06 § Deployment profiles, [ADR-0001](0001-p1-stack.md) Decisions 2 and 4
  (Node, no dependencies, SQLite, the export is a file copy), [ADR-0012](0012-the-long-horizon.md)
  Decision 3 (retention duty), [ADR-0017](0017-standards-conformance.md) Decision 4's
  execution plan (the seat-policy default flip, deferred to "next phase"),
  [ADR-0025](0025-transport-hardening.md) Decision 1 (TLS-only), [ADR-0026](0026-key-custody-and-the-signer-port.md)
  Decision 6 (keys backed up apart from data)
- **Driven by:** the instance README's two-terminal example (http origins, no proxy, no
  validation), [the operator's Tuesday](../scenarios/the-operators-tuesday.md) warts
  (`--experimental-sqlite` on every invocation; backup is `cp`), [ADR-0004](0004-solo-foundation-hardening.md)
  H13 (an `ALTER TABLE` guard standing in for migrations), [ADR-0023](0023-loose-ends-triaged.md)
  row L19

## Context

The instance runs from a clean checkout with no install and no build step, and that is
worth keeping. Between that and production there is a layer nobody has written: which
Node, behind which proxy, with which origin, validated how, upgraded how, backed up how.
Today `AFP_ORIGIN` is whatever the environment says, the schema is whatever the last
`CREATE TABLE IF NOT EXISTS` and one guarded `ALTER TABLE` produced, backup is a file copy
of a live database, and the seat policy the spec calls conformant is not the default.

## Decisions

### 1. Supported runtime: one Node LTS line, the flag pinned to the script

The instance supports the current Node LTS line and states it in `engines`. The
`--experimental-sqlite` flag lives in the npm scripts and the documented service unit,
never in an operator's own command line; when the LTS line ships `node:sqlite` without
the flag, the scripts drop it and nothing else changes. No container is required; a
reference `Containerfile` is provided that copies the checkout and sets the entrypoint,
and it adds no dependency.

### 2. Origin and TLS: the proxy terminates, the instance verifies itself

TLS is terminated by a reverse proxy the operator runs; the instance listens on
loopback. At startup the instance validates its configuration with named errors:
`AFP_ORIGIN` is `https:` (ADR-0025 D1), the data directory is writable and owned by the
process user, the signer answers, and — the **self-check** — it fetches its own
`AFP_ORIGIN/actor` through the proxy and requires the document's `id` to equal the origin
it published. A misrouted origin is the commonest federation failure and is now a startup
error rather than a signature mystery a week later.

### 3. Configuration is a validated schema, and secrets are files

`config.ts` becomes a schema with defaults, types, and a `validate()` that reports every
problem at once. Secrets (`AFP_KEY_PASSPHRASE_FILE`, the webhook secret of
[ADR-0028](0028-port-agents.md), the signer's client certificate) are file paths, never
values in the environment, so a process listing leaks nothing. `afp config check` runs
the validation and the self-check without starting the server.

### 4. Schema migrations are versioned and forward-only

A `schema_version` table replaces the `ALTER TABLE` guard. Migrations are numbered files
under `store/migrations/`, applied in order at startup inside one transaction each, and
never edited once shipped. A store from a newer version refuses to open under an older
binary with a named error. The compatibility gate the phases already keep — every shipped
bundle replays unchanged — is joined by a store gate: every shipped demo store opens and
migrates on the current binary.

### 5. Backup and restore are runbooks with commands

`afp backup <dir>` uses SQLite's online backup API against the live WAL-mode store and
writes the artifact directory beside it; keys are **not** included
([ADR-0026](0026-key-custody-and-the-signer-port.md) D6). `afp restore <dir>` refuses to
overwrite a live store, verifies the backup opens and migrates, and then — because a
restored instance is exactly the backup-restore case ADR-0020 Decision 2 ruled on — logs
the restore point so a same-value duplicate vote after it is explicable. Retention of
exports follows the operator's declared `afp:retentionDuty` (ADR-0012), and the runbook
says where they go.

### 6. The seat-policy default flips to `follow-required`

The hub's default `seatPolicy` becomes `follow-required`, as ADR-0017 Decision 4's plan
deferred to "next phase". Every demo and the instance library `Follow` before they
`Enroll`; 02's migration note gains the sentence that the flip happened and at which
revision; `enroll-implies-seat` remains available as an explicit setting for a transition.
Closes ADR-0023 L19; scenario 14 ([ADR-0030](0030-scenario-re-walks-and-the-coverage-index.md))
walks it.

### 7. A production checklist, in the README, every line a command or a file

Node version; proxy configuration for TLS and the inbox paths; `AFP_DEV` unset;
`afp config check` clean; `afp keys` custody mode chosen and recorded; backup scheduled;
`/readyz` probed; the policy document of [ADR-0033](0033-operator-obligations.md)
published. The list is the README's, not this ADR's, so it can grow.

## Options considered

| Option | Rejected because |
|---|---|
| Terminate TLS in the instance | A certificate lifecycle inside a zero-dependency process is the kind of code that goes wrong quietly; proxies do this well and operators already run one |
| Postgres for production | ADR-0001 Decision 4's trigger fired at P5 and the store held (ADR-0023 L8); a file copy that is also the export is worth more than a second database to operate |
| Bidirectional migrations | Down-migrations are tested by nobody and run by someone at 3 a.m.; forward-only with a refusal is honest |
| Keep `enroll-implies-seat` as default for compatibility | ADR-0017 called `follow-required` the conformant target; a production default that is not the conformant one is a deviation the deviations section would have to explain |

## Consequences

**Positive** — a misconfigured origin fails at startup; a schema change is a numbered
file; a backup is a command that cannot corrupt a live store; the conformant seat policy
is the default.

**Negative** — a proxy is now a hard requirement for a federated instance; the solo
profile keeps loopback-only serving without one.

**Accepted** — the reference `Containerfile` is a convenience, not a supported artifact.

## Implementation architecture

| Package | Touches | Content |
|---|---|---|
| **WP-1 · runtime + config** | `package.json` engines and scripts, `config.ts` (schema, `validate`), `cli.ts` (`config check`), `Containerfile` | Decisions 1–3 |
| **WP-2 · migrations** | `store/db.ts`, `store/migrations/` (new), every `CREATE TABLE IF NOT EXISTS` and the `ALTER TABLE` guard | Decision 4 |
| **WP-3 · backup** | `cli.ts` (`backup`, `restore`), `store/db.ts` | Decision 5 |
| **WP-4 · seat default** | `hub/hub.ts`, every demo, 02 § migration note, `test/adr0017-d4-follow.test.ts` | Decision 6 |
| **WP-5 · gate + docs** | `test/adr0032.test.ts`, instance README § Production checklist | Decision 7 |

Gate: `afp config check` fails on each named misconfiguration and passes on the reference
one; every shipped demo store migrates; `afp backup` then `afp restore` round-trips a
store whose replay is byte-identical; the seat-default flip leaves every shipped bundle
unchanged and the D4 gate green under both settings.

## Build status

**Built (2026-09-13).** `cd src/instance && npm test` is green — `test/adr0032.test.ts`
carries the ADR's own gate paragraph as G1–G8 (config check, the demo-store migration
sweep, backup/restore round-trip, the seat-default flip, the legacy fixture, the
newer-store refusal, the no-flag proof, and the full-bundle replay), plus an "ADR-0032
primitives" block for the handful of cases (a failed migration's rollback,
`readSecretFile`'s trim/empty-refusal) that map to no G-row; it replaces
`test/adr0032-wp2.test.ts` and `test/adr0032-wp13.test.ts`, both deleted, with no case
dropped. `test/adr0017-d4-follow.test.ts` carries the two D4/D6-specific cases G4 cites
rather than repeats: the inverted default ("an Enroll without a Follow is refused") and
the explicit-compat proof ("enroll-implies-seat, set explicitly, still enrolls").

**What was built versus what the ADR wrote:**

- **The `--experimental-sqlite` flag was already unnecessary** on the Node ≥24 line this
  ADR targets — `node:sqlite` needs no flag past that line — so the npm scripts and the
  documented service unit simply never carry it, rather than carrying it "pinned"; G7
  proves no script does.
- **`config check`'s signer probe is skipped, named**, before the instance key is ever
  minted and while `serve` holds the store's lock — in both cases `config check` must
  never mint a key or collide with a live process's lock, so the line reads
  `skipped — no instance key minted yet` / `skipped — store held by pid <n>` rather than
  failing or lying about a result it cannot honestly produce.
- **`AFP_SIGNER_CLIENT_CERT_FILE` is validated (readable) but unconsumed** — nothing in
  this codebase reads it yet; it is provisioned ahead of [ADR-0035](0035-remote-custody-and-the-asynchronous-port.md)'s
  remote-signer adapter, which is the file's first reader.
- **Migration 001 is the verbatim baseline**, every `CREATE TABLE IF NOT EXISTS` this
  codebase had folded in with `IF NOT EXISTS` kept (and kept *only* there — every later
  migration is plain DDL, since there is no pre-schema-version store left to be
  compatible with); **migration 002** (`restore_points`) is the first real forward
  migration. Six schema sites were folded into 001 — `store/db.ts`, `federation/federation.ts`,
  `allocation/store.ts`, `hub/store.ts`, `store/dedupe.ts`, and `crdt/store.ts` — the last
  of which the ADR's implementation-architecture table did not name; one door, one
  schema (ADR-0027) meant it belonged here too, not left the sixth site creating tables
  of its own.
- **`afp restore` records its point per [ADR-0020](0020-p6-hardened-round-stack.md) Decision 2** — a `restore_points` row
  logged after the swap, so a same-value duplicate vote observed after that instant is
  explained by the log rather than mistaken for equivocation.
- **"The seat-default flip leaves every shipped bundle unchanged"** reads as: previously
  exported bundles still replay (the verifier accepts both the `enroll-implies-seat` and
  `follow-required` shapes) — a *fresh* export of any demo legitimately gains a
  Follow/Accept pair it did not carry before. Building the flip surfaced one real gap the
  ADR's prose did not anticipate: `Follow`/`Accept{Follow}`/`Undo{Follow}` all cross a
  real federation boundary whenever the hub or the follower is foreign (every
  multi-operator demo), and the verifier's grant check matches a `"hub"` grant on
  top-level `afp:hub` — a field none of the three carried. Fixed by adding `afp:hub` to
  `follow`, `acceptFollow` and `undoFollow` (`ap/activities.ts`, `hub/activities.ts`),
  the same convention every other hub-emitted/hub-addressed activity already follows
  (`hub/activities.ts`'s own `castVote` docstring says as much for votes).
- **Which tests kept `enroll-implies-seat` explicitly, and why:** `test/adr0017-d4-follow.test.ts`'s
  own compat case, whose subject *is* the pre-flip behaviour; and `test/adr0014.test.ts`'s
  chain-head/anchor test, whose subject is ADR-0012's anchoring invariant and needs the
  hub to have emitted nothing yet — the default's Accept{Follow} would otherwise give it
  a head before the test can check there wasn't one. Every other hub-building test and
  demo now Follows before it Enrolls — `testHub` (`test/helpers.ts`) delivers the Follow
  itself (unless told `seatPolicy: "enroll-implies-seat"`), so every other caller through
  it needed no per-test change.
- **A wire-shape change, not just a default flip:** `follow`, `acceptFollow` and
  `undoFollow` (`ap/activities.ts`, `hub/activities.ts`) now carry top-level `afp:hub`
  naming the hub — none of the three did before. Building the flip surfaced this: all
  three cross a real federation boundary whenever the hub or the follower is foreign
  (every multi-operator demo), and the verifier's grant check matches a `"hub"` grant on
  top-level `afp:hub`, a field none of them carried. `test/demos.test.ts` (all eight) and
  `test/adr0032.test.ts` G4 confirm the Python verifier admits the new shape.
- **Seat state does not converge across replicas.** A relayed `afp:Enroll` — carried
  inside a replica's `Accept{afp:StateDeltas}` or a `pushSync` (ADR-0016 Decision 2) —
  was already admitted by the origin hub under *its* seat state; the replica re-derives
  the Enroll rather than re-admitting it, since `hub_seats` is not itself CRDT-tracked
  and a replica that never saw the Follow would otherwise refuse every synced Enroll
  under the new default. `Hub.receive`/`dispatch`/`onEnroll` take a `relayed` flag,
  set only by `onStateDeltas`, that skips the seat gate alone — signature verification
  and dedupe still run. Converging seats themselves (shipping `Follow`/`Undo{Follow}`
  in the sync set) is the recorded follow-up, not built here. `test/adr0032.test.ts` G4
  carries the gate case; `test/adr0016.test.ts` T7 and `test/adr0031.test.ts` G3
  (pre-existing replica-convergence gates) are what caught the gap.
  **Answered 2026-09-19 by [ADR-0037](0037-the-served-hub.md) Decision 3:** seats are an
  OR-Set in `crdt_state` keyed by instance actor and tagged by the `Follow`, `hub_seats`
  is gone (migration 003), and `relayed` no longer skips the seat gate — it means
  ordering, and an `Enroll` whose seat never arrives is refused and logged rather than
  admitted. G4 here was rewritten to the new truth: the carried `Follow` seats the
  leader on the replica, and `followers` is byte-equal on both.
- **Three things the review changed after the build.** `restoreStore` decided whether the
  target store was live by *opening* it — which ran the target's pending migrations as a
  side effect of asking, before the `--force` refusal was even reached; it now reads the
  lock (`db.ts`'s `lockHolder`: the in-process set, then the lock file's pid, a dead pid
  reading as nobody) and never opens what it may be about to refuse to touch. Two gates
  hung the suite at their 300-second ceiling rather than failing: `test/adr0016.test.ts`
  T7 closed an operator's bootstrap server and rebound its port without awaiting the
  close or dropping keep-alive sockets, so the client pool's next POST went to a dead
  socket — a lost delivery that read as "0 of 5 seats converged", timing-dependent, and
  a promise that never settled; the rebind now closes every connection and awaits the
  close. And `test/adr0032.test.ts` G2 closed each multi-operator demo's instances but
  not its HTTP servers, an open handle that kept the process alive after every case had
  passed; it now calls each demo's own `close()`. The suite runs in under four seconds
  again.
- **The Containerfile's base image** is `node:24-slim` (Debian) rather than alpine or
  distroless: `node:sqlite` is a native addition to the Node binary itself, so there is
  no musl/glibc concern alpine would answer, and slim keeps a shell and a package
  manager available for an operator's own proxy/TLS debugging without the full image's
  size.

## References

- 06 § Deployment profiles; [ADR-0001](0001-p1-stack.md) § Revised under contact
- [ADR-0017 D4 execution plan](0017-d4-execution-plan.md) R2
- [ADR-0023](0023-loose-ends-triaged.md) rows L8, L19
