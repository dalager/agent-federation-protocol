# ADR-0032 — The deployment profile: TLS, origin, configuration, storage, upgrades, backup

- **Status:** Proposed (2026-09-02) — program claim **C8** of
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

Not built.

## References

- 06 § Deployment profiles; [ADR-0001](0001-p1-stack.md) § Revised under contact
- [ADR-0017 D4 execution plan](0017-d4-execution-plan.md) R2
- [ADR-0023](0023-loose-ends-triaged.md) rows L8, L19
