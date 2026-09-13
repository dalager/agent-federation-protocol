# Fixtures

ADR-0034 Decision 2 — "the shipped bundles, moved out of `export-*`". One
directory per demo the support index lists under "See it run"
(`docs/afp/scenarios/README.md#is-this-workload-supported`): `p1`–`p8`. Each
holds exactly what that demo exports — a single-operator demo, one bundle
directory; a multi-operator demo, its several bundle directories side by
side, each named for the operator that produced it — plus a `VERIFY.json`
recording the verifier invocation:

```json
{ "bundles": ["export"], "thread": "https://alpha.operator.local/threads/doc-1" }
```

`bundles` is a list of directories relative to the fixture's own directory;
`thread` is `null` when the demo's own replay does not pass `--thread` (the
multi-bundle demos replay every thread the joint bundle contains). A runner
needs nothing else — `scripts/verify-fixtures.sh` reads `VERIFY.json` and
nothing more to reconstruct the exact `afp_verify.py` invocation each fixture
was proved against.

## Producing them

`scripts/refresh-fixtures.mjs` runs each demo's `runXDemo` (stub brains,
deterministic clocks) into a temp workspace, exactly as
`src/instance/test/demos.test.ts` does, copies the resulting export
director(y|ies) here, and writes each `VERIFY.json`.

```bash
node scripts/refresh-fixtures.mjs
```

**A fixture is a frozen artifact, not a reproducible build.** Re-running the
script produces bundles that still verify clean, but are not byte-identical
to the ones they replace: each run mints fresh signing keys and the demos'
clocks are deterministic only in their step pattern, not in embedding a fixed
wall-clock origin shared across runs. That is fine — what a fixture proves is
"a bundle shaped like this one replays," not "this exact byte string was
produced again" — but it means a refresh is a deliberate act (and a diff),
not something to run casually or in CI.

## Verifying them

```bash
scripts/verify-fixtures.sh
```

This is what `src/instance/test/fixtures.test.ts` (the compatibility gate:
"every shipped bundle replays unchanged," now over bundles that are actually
shipped) and the CI `verifier` job both run.

## Size

Total ~2.3M across all eight fixtures as of the ADR-0034 WP-1/2 refresh
(`p7`, the four-desk quarterly split, is the largest at ~530K — well under
the ~2M-per-demo watch line).
