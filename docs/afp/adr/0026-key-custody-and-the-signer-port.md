# ADR-0026 — Key custody and the signer port: the record's guarantees are cryptographic; the keys' protection must stop being a directory permission

- **Status:** Proposed (2026-09-02) — program claim **C2** of
  [ADR-0024](0024-the-road-to-production.md); group: **Security**
- **Date:** 2026-09-02
- **Applies to:** every private key an instance holds — instance, agent, hub-scoped and
  transport — and every export that must be safe to hand to a stranger
- **Builds on:** [ADR-0012](0012-the-long-horizon.md) (key history, rotation versus
  revocation), [ADR-0017](0017-standards-conformance.md) Decision 4 (two keys per actor,
  three with the shim), [ADR-0021](0021-conviction-to-consequence.md) Decisions 4a and 4d
  (compromise claims; a revocation cut may not predate embedded evidence), 01 §
  key custody (`self` versus `instance`), [ADR-0009](0009-federated-replay.md)
  Decisions 4–5 (export scopes)
- **Driven by:** [the operator's Tuesday](../scenarios/the-operators-tuesday.md) —
  "key custody is currently *file custody*" — and [ADR-0023](0023-loose-ends-triaged.md)
  rows L1 (hub-scoped and transport keys are outside `afp:keyHistory`, verified in
  `src/instance/src/export.ts`) and L2 (the visibility-floor and agreement-grant export
  scopes are specified and unbuilt, verified in the same file)

## Context

Every key the instance uses is a PEM file under `data/keys/`, loaded by
`src/instance/src/crypto/keys.ts`, and the roster's `self`-custody option — an agent that
holds its own key — is supported by the record and exercised by nothing. The honest
statement in the baseline document stands: the guarantees are cryptographic; the
protection is a directory permission and a careful operator.

Three further facts make this a production blocker rather than a wart. First,
`afp:keyHistory` collects the instance key, each agent's P1 key and each hub actor's keys,
and nothing else: the per-agent hub-scoped keys that sign votes and the transport keys
that sign hops can be neither recorded nor interval-checked (ADR-0021 Q7, "a live hole").
Second, rotation and revocation have no operator surface — the history entries ADR-0012
specified are produced by demo code. Third, an export is the one artefact that leaves the
operator's hands, and today its scope grammar cannot express "everything a regulator may
see" or "everything this counterparty was granted"; the thread-set scope is all there is.

## Decisions

### 1. A signer port, and the instance never holds a private key outside its adapter

`crypto/signer.ts` defines `Signer { keyId; publicKeyMultibase; sign(bytes): Promise<Uint8Array> }`.
Everything that signs — object proofs, HTTP signatures, the manifest — takes a `Signer`.
Adapters:

- **`file`** — today's PEM files, now created `0600`, optionally encrypted at rest with a
  passphrase from `AFP_KEY_PASSPHRASE_FILE`; the reference adapter, and the only one the
  gate needs.
- **`remote`** — an HTTP signer behind mutual TLS (`POST /sign` with the bytes' digest),
  the shape an operator's KMS or HSM proxy fits; a reference implementation in
  `tools/signer/` proves the contract with a file-backed service.
- **`agent`** — for `self`-custody agents: the instance holds no key at all; the agent
  presents signed activities through the port and the instance verifies, exactly as 01
  § "the agent–instance boundary" describes and nothing has yet exercised.

The custody mode of every key is declared in the roster entry it already has
(`afp:keyCustody`) and, for transport and hub-scoped keys, in the actor document's key
entry as `afp:custody: "file" | "remote" | "agent"` — informational, so an auditor can
see where a key lived.

### 2. Rotation and revocation are a runbook and a CLI, not demo code

`afp keys rotate <actor> [--kind proof|transport|hub:<id>]` publishes the new key with an
overlap window, `Update`s the actor document, and writes the ADR-0012 history entry.
`afp keys revoke <keyId> --since <instant> [--claim <proofDigest>]` cuts the interval,
publishes the document update, and — when the key signed votes embedded in an on-record
`afp:EquivocationProof` — refuses a `--since` earlier than those votes, which is ADR-0021
Decision 4d enforced at the moment it matters rather than only at replay; `--claim`
publishes the `afp:KeyCompromiseClaim` in the same act. The runbook in the instance README
is the human procedure around these two commands.

### 3. `afp:keyHistory` names every key that ever signed anything in the bundle

`collectKeyHistory` in `export.ts` walks, per actor: the proof key, every hub-scoped key
(`<actor>--hub-<id>`), and the transport key. Transport keys sign hops, not activities,
and their signatures never enter a bundle; they enter the history anyway, because a
revoked transport key with an interval is how a boundary-log entry's authentication can be
re-judged later. `keys.py`'s `check_key_intervals` covers the additional entries with no
change: it is already keyed on `verificationMethod`, not on actor. Closes ADR-0023 L1 as
the ADR-0012 amendment ADR-0021 Q7 asked for; decides Q4 in passing — V14 stays in
`keys.py`, beside the other interval checks.

### 4. An export never carries private material, and the gate proves it

An export gate scans every file in a bundle for PEM headers, multibase private-key
prefixes, and the passphrase file's contents; any hit fails the export before it is
written. Cheap, and the one accident an operator cannot undo.

### 5. Export scopes: visibility floor and agreement grant

ADR-0009 Decision 4 specified three scopes and P4 built one. The two remaining are built
here because both are custody decisions — what leaves the operator's hands:

- **Visibility floor** — `{ visibilityAtLeast: "hub" }` stubs every activity below the
  floor; the manifest's `afp:exportScope` declares the floor.
- **Agreement grant** — `{ agreement: <digest> }` stubs every activity the named
  agreement's grants would not have admitted; the manifest names the agreement. This is
  the export a counterparty is entitled to, produced without a human judging each thread.

Both use the existing 1:1 stub-in-chain-position mechanism, both keep the ADR-0010
Decision 5 refusal (no answer without its pins), and both replay clean in the joint
verifier. Closes ADR-0023 L2.

### 6. Backup separates keys from data

The README's `cp` backup becomes two runbooks: the SQLite file through the backup API
(ADR-0032), and `data/keys/` — or nothing, under `remote` and `agent` custody — through
whatever the custody adapter documents. A backup that mixes the two is how a key ends up
in an object-storage bucket.

## Options considered

| Option | Rejected because |
|---|---|
| Mandate an HSM | Solo and airgapped operators are first-class profiles (06); a signer *port* with a file adapter keeps them running and lets a consortium host demand `remote` by agreement |
| Encrypt PEM files and stop there | Encryption at rest with a passphrase on the same host protects against a stolen backup and nothing else; the port is what lets custody improve without touching the instance |
| Leave transport keys out of the history because their signatures are not in the bundle | The boundary log records who was authenticated; re-judging that after a revocation needs the interval |
| Build the two export scopes under a scenario-coverage ADR | They are custody decisions — what may leave — and ADR-0010 Decision 5's refusal has to hold under them, which is a verifier concern, not a workload one |

## Consequences

**Positive** — key material has a place to be that is not a directory, rotation is a
command, and the two things a regulator or a counterparty is entitled to can be exported
without a human choosing threads.

**Negative** — three custody adapters is three ways to misconfigure; the `remote` adapter
in particular moves the trust to a service the operator must run. ADR-0033 makes the
custody mode a published obligation so at least it is stated.

**Accepted** — `agent` custody makes the instance verify rather than sign; the P1 gate's
"the wiring is invisible" invariant must hold across the change, and G8 below checks it.

## Implementation architecture

### W1. Files

| Package | Touches | Content |
|---|---|---|
| **WP-1 · port** | `crypto/signer.ts` (new), `crypto/keys.ts`, `crypto/proof.ts`, `federation/httpSig.ts`, `export.ts` (manifest signing) | Decision 1 |
| **WP-2 · runbook** | `cli.ts` (`keys` subcommands), instance README | Decision 2 |
| **WP-3 · history** | `export.ts`, `crypto/keys.ts`, `src/verifier/keys.py` | Decision 3 |
| **WP-4 · scopes** | `export.ts` (`ExportScope`), `src/verifier/afp_verify.py` (`afp:exportScope` reading) | Decision 5 |
| **WP-5 · gate** | `test/adr0026.test.ts`, `test/adr0012.test.ts` (extended) | W2, Decision 4 |

### W2. Gate matrix — `test/adr0026.test.ts`

| # | Case | Asserts |
|---|---|---|
| G1 | Every demo under the `file` adapter | byte-identical record to before this ADR |
| G2 | The `remote` adapter against the reference signer | same record; the instance process holds no private key object |
| G3 | An `agent`-custody agent signs out of process | roster says `self`; replay clean; P1 gate check 11 (wiring invisible) holds |
| G4 | `afp keys rotate` then export | old and new signatures both verify (ADR-0012 G1 shape) |
| G5 | `afp keys revoke --since` earlier than an embedded convicting vote | refused at the CLI; the proof stands |
| G6 | A bundle's `afp:keyHistory` after a hub round | names the hub-scoped key that signed each vote and the transport key; a backdated cut on a hub-scoped key fails `keys:` by name |
| G7 | An export directory containing a planted PEM | the export refuses to write |
| G8 | Visibility-floor and agreement-grant scoped exports | stubs 1:1; joint replay clean; an answer whose pins fall below the floor is refused (ADR-0010 D5) |
| G9 | Every shipped bundle replayed | unchanged |

## Build status

Not built.

## References

- 01 § Key custody; 01 § The agent–instance boundary
- [ADR-0012](0012-the-long-horizon.md), [ADR-0021](0021-conviction-to-consequence.md) Q4 and Q7
- [ADR-0009](0009-federated-replay.md) Decisions 4–5; [ADR-0010](0010-pinning-without-an-auction.md) Decision 5
- [ADR-0023](0023-loose-ends-triaged.md) rows L1, L2, L30
