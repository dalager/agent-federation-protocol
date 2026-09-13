# Conformance kit

ADR-0034 Decision 3. What the gates already contain, packaged so a third
implementation can find out whether it conforms without reading TypeScript or
Python: the raw-JSON parity cases, a clean bundle and its named mutations per
phase and hardening ADR, and a runner contract.

**Conformance means:** a third implementation agrees with this kit on every
bundle and every mutation below — same verdict, and for a mutation the same
named check failing.

## Runner contract

```
run <bundle-dir> [--thread T]  →  exit code (0 = every check passed)
                                   one line per failed check, containing
                                   the check's name, to stdout or stderr
```

A joint replay (several bundle directories on one command line, ADR-0009) is
the same contract with more than one `<bundle-dir>` argument. `afp_verify.py`
already speaks this contract; that is what `conformance/run.py`'s default
`--verifier` invokes.

## Layout

```
conformance/
  VERSION            the spec revision this kit was cut against
  cases/parity.json  the raw-JSON parity cases (single source — see below)
  bundles/<name>.json  a fixture + thread + expected verdict ("pass")
  mutations/<name>.json  one named edit to a bundle's outbox + expected
                          verdict ("fail") + the check name(s) that must
                          appear in a failing line
  run.py             the reference runner (stdlib only)
```

`bundles/*.json` reference `../fixtures/<pN>` rather than copying — the
fixtures already live at the repo root (`fixtures/`, ADR-0034 Decision 2) and
running the kit needs a checkout, not a standalone archive.

```json
{ "fixture": "../fixtures/p7", "bundles": ["northwind", "dayshift", "kestrel", "lantern"],
  "thread": null, "verdict": "pass" }
```

A mutation names the bundle it starts from, which of that bundle's several
directories (`domain`) holds the outbox to edit, the outbox, and one edit in a
small language-neutral vocabulary:

```json
{ "bundle": "p7", "domain": "northwind", "outbox": "fixer",
  "op": "set", "select": { "objectType": "afp:ContributionSummary" },
  "path": "object.afp:entries.0.afp:credited", "value": 999999,
  "expect": { "verdict": "fail",
              "failing": ["entries recompute from the frame", "credit disagrees for"] } }
```

`select` picks activities from the outbox's `orderedItems` by `objectType`
(`item.object.type`), `type` (`item.type`), `id`, or a positional `index`.
`path` is dotted from the activity root (numeric segments index into arrays).
`op` is one of:

- `set` — write `value` at `path` on each selected activity
- `delete` — remove the field at `path`
- `append` — push `value` onto the array at `path` (or, with no `path`, onto
  the outbox's `orderedItems` itself — a forged activity spliced in)
- `filter` — with no `path`, drop the selected activities from
  `orderedItems`; with `path` and `match`, drop entries from the array at
  `path` whose fields equal `match`

`expect.failing` is a list of regexes; the mutation passes conformance when
the verifier's output — run against the mutated bundle — exits nonzero and at
least one of them matches a line of it.

## Versioning

`conformance/VERSION` holds the spec revision (ADR-0034 Decision 1) this kit
was cut against — read once, at authoring time, from
`src/instance/package.json`'s `afp.specRevision`, and bumped by hand when the
kit is re-cut against a later revision. `src/instance/test/adr0034-wp3.test.ts`
asserts the two still agree.

## Parity: one source, both runners

`conformance/cases/parity.json` is the single copy of the raw-JSON parity
cases (ADR-0004 H7). `src/verifier/test/parity/cases.json` is a **symlink**
to it (`run_parity.py` and `parity.test.ts` need no path change — both already
resolve the file relative to `src/verifier/test/parity/`, and a symlink reads
the same bytes). This kit ships no `run.mjs`: TypeScript has no bundle
verifier of its own to point at — `parity.test.ts` already runs the same
cases directly against the writer's derivations, in-process. A third
implementation's half of parity conformance is: run `run_parity.py`'s cases
through its own reimplementation and diff against either existing side's
answers.

## Running it

```bash
python3 conformance/run.py                              # against afp_verify.py
python3 conformance/run.py --verifier "python3 /path/to/other/afp_verify.py"
python3 conformance/run.py --verifier "go run ./cmd/afp-verify"
```

Prints one line per bundle and per mutation, `PASS` or `FAIL`, and exits
nonzero on any disagreement. Both existing implementations run it in CI (the
`conformance` job, `.github/workflows/gate.yml`) — the two-implementation
proof, applied to the kit itself, that its cases are exercised honestly.

## Gated only in the implementations' own suites

These mutations are real gates — `mutateBundle`/`mutate`/`mutateFile` calls in
`src/instance/test/*.test.ts` — that this kit does not (yet) express, because
doing so needs something outside the vocabulary above: re-signing a mutated
activity, minting a fresh signed proof or vote, or hand-building an activity
that has no analog in a shipped fixture. ADR-0034 accepts this lag; each is
named here so it is a stated gap, not a silent one.

| Test | Why it's outside the DSL |
|---|---|
| `adr0010.test.ts` (pin/synthesis/action mutations, `mutate()`) | Needs a bespoke multi-agent fan-out scenario the shipped fixtures don't carry; several mutations also re-sign |
| `adr0011.test.ts` (irrevocable-action mutations) | Same — a purpose-built scenario, not a shipped fixture |
| `adr0018.test.ts` G-checks re-signing a `DecisionRecord`/`Proposal` after mutating it | The DSL edits JSON in place; these tests re-sign the mutated payload so the fault isolates to arithmetic/membership rather than also tripping the signature check |
| `adr0019.test.ts` G2/G3 (actor re-pointed to an outsider, action re-labelled) | The shipped fixtures' `afp:actsOn` activities don't carry the exact shape these mutations target; expressing them needs a purpose-built bridge scenario |
| `adr0020.test.ts` (forged `afp:EquivocationProof`, spliced convicted ballot, unearned `afp:noDecisionReason`) | No shipped fixture contains an `afp:EquivocationProof` or a convicted voter; these need freshly minted, validly signed evidence |
| `adr0021.test.ts` (unauthorized `Unenroll` spliced in) | Needs a validly signed forged activity — signing is outside the DSL |
| `adr0028.test.ts` chain-position assertions beyond the content-hash edit | The content-hash mutation is expressed (`p7-result-contenthash-mutated.json`); the accompanying chain-position assertions in that test are checked incidentally by the same verifier run, not as a separate named mutation |
| `adr0029.test.ts`, `adr0031.test.ts`, `adr0032.test.ts` | These ADRs' gates are round-trip/behavioral (resident-process pulse, deployment migrations), not outbox mutations — nothing to express in this vocabulary |
| `adr0033.test.ts` (`mutateFile` on `policy.jsonld`, `MANIFEST.json`, `outbox/instance.jsonld`) | `mutateFile` edits files besides an agent's outbox (the operator-obligations policy document, the manifest); the kit's vocabulary is scoped to outbox activities per Decision 3's own framing ("one clean bundle and its named mutations") |

Eleven mutations are expressed today, against real shipped fixtures
(`p1`, `p2`, `p5`, `p7`), spanning ADR-0009/2's chain integrity, ADR-0002
Decision 3's `DecisionRecord` arithmetic and evidence-set completeness
(ADR-0014's `afp:uncounted` partition), and ADR-0022's contribution
accounting (frame validity, entry recomputation, membership, disputes) and
ADR-0028's content-hash binding. The table above accounts for the rest.
