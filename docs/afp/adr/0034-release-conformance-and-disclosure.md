# ADR-0034 — Release engineering, conformance and disclosure: how the record ships

- **Status:** Accepted (2026-09-02), **built** (2026-09-13) — program claim **C10** of
  [ADR-0024](0024-the-road-to-production.md); group: **Release engineering**
- **Date:** 2026-09-02
- **Applies to:** versioning of the spec and the two implementations, continuous
  integration, the conformance kit a third implementation runs, distribution of the
  verifier, and the security disclosure process
- **Builds on:** [ADR-0001](0001-p1-stack.md) Decision 5 (a second implementation in
  another language is the mechanism), the parity harness of [ADR-0004](0004-solo-foundation-hardening.md)
  H7 (raw JSON through both implementations), the compatibility gate every phase ADR
  carries ("every shipped bundle replays unchanged"), [ADR-0017](0017-standards-conformance.md)
  Decision 8 (the FEP, deferred by choice — untouched here)
- **Driven by:** the review: there is no CI (no `.github/`, no pipeline of any kind — the
  gate runs when a person runs it); the implementation is `0.1.0` under a spec at
  revision 3.33 with no stated relationship; the verifier is a directory an auditor
  copies; a third implementation would have to reverse-engineer the gates to know what
  conformance means; and there is nowhere to report a vulnerability

## Context

The repository's discipline is unusually good at the level of a commit: mutation gates,
parity between two implementations, honest ledgers. It has no discipline at the level of
a release, because there has been no release. Production changes that: a counterparty
federating with this instance needs to know which spec revision it speaks, which
implementation version it runs, and that the version they were tested against is the one
still shipping. An auditor needs a verifier they can install, not a checkout. A second
implementer — the interop story the spec has told since ADR-0001 — needs a conformance
kit, not a reading assignment. And the first person to find a hole in ADR-0025's transport
needs somewhere to send it.

## Decisions

### 1. Two version lines, one stated relationship

The spec keeps its revision line (v3.33 and on). The instance and the verifier get
semantic versions, and each release names the spec revision it implements in
`package.json` (`afp.specRevision`), in the verifier's `--version`, and in NodeInfo's
software block, which counterparties already fetch. A minor implementation release may
implement a later spec revision; a spec revision that changes a wire shape requires a
major implementation release, and the compatibility gate proves old bundles still
replay.

### 2. CI runs on every commit, and a demo that stops producing a passing bundle fails it

A pipeline runs: the gate (`npm run gate`); every demo the support index lists under "See
it run", with stub brains, exporting its bundles; the verifier over every bundle just
produced and over every bundle checked into `fixtures/`; the parity harness; and the
link-and-anchor check the documentation sync introduced. The `:llm` demos are excluded.
Green is the merge condition. This is [ADR-0030](0030-scenario-re-walks-and-the-coverage-index.md)
Decision 4 made real.

### 3. A conformance kit a third implementation can run

`conformance/` packages what the gates already contain into a form that needs neither
TypeScript nor Python to run: the raw-JSON parity cases, one clean bundle and its named
mutations per phase and per hardening ADR, each with the expected verdict and the check
name it must fail, and a runner contract (`run <bundle-dir> → exit code + named failures`).
A third implementation passes conformance when it agrees with the kit on every bundle.
The kit is versioned with the spec revision, and the two existing implementations run it
in CI as the proof that the kit is honest.

### 4. The verifier is installable

`afp-verify` ships as a Python package (`pip install afp-verify`) with `cryptography` as
its only dependency and a pinned minimum Python, plus a checksummed source archive for
the auditor who will not install anything. The Go port stays parked behind
[ADR-0023](0023-loose-ends-triaged.md) L22's trigger; if it fires, the conformance kit is
what proves the port.

### 5. A disclosure process, and a threat model to report against

`SECURITY.md` states how to report, what response time to expect, and that reports about
the transport (ADR-0025), the ports (ADR-0027) and the record's checks are all in scope.
`docs/afp/threat-model.md` states, once, what the protocol defends against and what it
does not — the honest limits already scattered through 03, 04 and the ADRs, collected —
so a reporter can tell a finding from a known limit. The policy document
([ADR-0033](0033-operator-obligations.md)) carries the same contact per deployment.

### 6. Releases are signed, and the release names its bundles

A release is a tag whose notes name the spec revision, the conformance-kit version, and
the digests of the fixture bundles it was gated against. The tag is signed with a release
key the README publishes. Nothing here changes the record; it changes whether the
software that produced a record can be identified after the fact, which is the same
question `afp:producedBy` answers for brains.

## Options considered

| Option | Rejected because |
|---|---|
| Version the implementation by spec revision | An implementation fix that changes no wire shape would then bump the spec, or go unversioned |
| Skip CI and keep the gate as a pre-commit habit | The review found a build-status row claiming rate limiting exists; habits do not catch that, and a pipeline that runs the demos would have caught the unwired shadow Notes |
| Make the conformance kit the TypeScript test suite | A third implementer should not need Node to know whether they conform; bundles and expected verdicts are language-neutral |
| Publish the FEP as part of the release process | ADR-0017 Decision 8 is the operator's call and this program does not schedule it |

## Consequences

**Positive** — a counterparty can name what it federates with; an auditor can install the
verifier; a third implementation has a finish line; a reporter has an address; a release
can be tied to the bundles it was proved against.

**Negative** — CI is a maintenance cost the repository has never paid, and the demos are
slow. They run in parallel and with stub brains; the gate alone is six seconds.

**Accepted** — the conformance kit will lag the gates until CI proves it does not.

## Implementation architecture

| Package | Touches | Content |
|---|---|---|
| **WP-1 · versions** | `package.json`, `src/verifier/afp_verify.py` (`--version`), `ap/nodeinfo.ts`, README | Decision 1 |
| **WP-2 · CI** | `.github/workflows/gate.yml` (or the forge's equivalent), `fixtures/` (the shipped bundles, moved out of `export-*`), the docs link check as a script | Decision 2 |
| **WP-3 · kit** | `conformance/` (cases, bundles, expected verdicts, runner contract), both implementations' runners | Decision 3 |
| **WP-4 · package** | `src/verifier/pyproject.toml`, release archive script | Decision 4 |
| **WP-5 · disclosure** | `SECURITY.md`, `docs/afp/threat-model.md` | Decision 5 |
| **WP-6 · release** | release script, README § Releases | Decision 6 |

Gate: CI is green on the commit that lands it; both implementations pass the conformance
kit; `pip install` from the archive verifies a fixture bundle; the threat model's "does
not defend against" list matches the limits stated in 03 and 04 word for word where it
quotes them.

## Build status

**The first CI run, 2026-09-19 — red, and worth the entry.** Run
[35440209742](https://github.com/dalager/agent-federation-protocol/actions/runs/35440209742)
on `7dc2bbb`: `conformance`, `package` and `verifier` green, `gate` red on exactly one
case — ADR-0037 G6 — with `cannot reach http://localhost:13305/api/v1/chat/completions`.
That endpoint is a model server on the *author's laptop*. The case had been passing for
four days on the strength of a process nobody else runs.

The cause was a call-shape mistake, not a brain choice. `runDemo` takes
`{ fresh?, config?, clock? }`; the test passed its `Config` positionally, so
`options.config` was `undefined` and the demo ran `loadConfig()` over the ambient
environment instead — the default data directory rather than the test's temp workspace,
a live clock rather than the fixed one, and `AFP_BRAIN`'s default `llm` rather than the
`brain: "stub"` the line above it asked for. Three isolation properties lost to one
missing object literal, and the only one that showed was the one CI could see.

Two fixes, at two depths. The case now calls `runDemo({ fresh: true, config, clock })`
and exports through the instance the demo hands back, rather than opening a second one
on the same store. And `npm run gate` now pins `AFP_LLM_BASE_URL` to a closed port, so
**the gate cannot reach a model server even when one is running** — the local run and the
CI run no longer differ on the one environment fact that hid this. Any future test that
needs a live brain must now stand up its own, which the `llm`-brain cases already do.

**Built, 2026-09-13.** `cd src/instance && npm test` (`npm run gate`): 549 cases, 547
passing, 0 failing, 2 recorded skips — both in `test/adr0034.test.ts` G1, both the same
environment fact rather than a gap in what shipped (below). The conformance
kit: 19 cases (8 bundles, 11 mutations), all passing against `afp_verify.py`. Parity: one
shared case file (`conformance/cases/parity.json`, symlinked into
`src/verifier/test/parity/cases.json`), checked by both implementations.

`test/adr0034.test.ts` folds WP-1–4's own tests in under `describe("ADR-0034
primitives")` and adds the ADR's own gate paragraph as four numbered cases:

- **G1** — every `run:` command `.github/workflows/gate.yml` names, executed in the order
  it appears, exits 0 locally. This is "CI is green on the commit that lands it" in the
  only form this session can prove: the actual GitHub Actions run happens on push, after
  this ADR's changes are committed, which this session does not do. One step
  (`gate`'s own `npm test`) is proven by construction rather than re-invoked, since this
  test file is itself running inside that command and literally re-running it would
  recurse forever.
- **G2** — `conformance/run.py` exits 0 against `afp_verify.py` (the Python side); the
  TypeScript side's conformance is `test/parity.test.ts`, cited rather than duplicated —
  the kit ships no `run.mjs` because TypeScript has no bundle verifier of its own to
  point at (`conformance/README.md` § "Parity: one source, both runners").
- **G3** — builds the release archive, installs it into a clean `venv`, and runs
  `afp-verify` over `fixtures/p1/export`, asserting `PASSED`.
- **G4** — parses every attributed `> ` blockquote in `docs/afp/threat-model.md` (each
  followed by an em-dash attribution line naming a source file and heading anchor),
  resolves the path, and asserts the quoted text appears
  verbatim (whitespace-normalised) in the named source, and the anchor's heading slug
  exists there. Ten quotes checked, above the ADR's own "at least six."

**What was built versus what the ADR wrote — five honest gaps:**

1. **The link checker did not exist before this ADR.** The ADR's own Decision 2 named
   "the link-and-anchor check the documentation sync introduced" as something already in
   place; it was aspirational — `scripts/check-links.mjs` is new, written for WP-2. Its
   first draft's slug rule (collapsing runs of whitespace before hyphenating) produced 74
   false positives before it was corrected to GitHub's actual rule (each space becomes
   its own hyphen, so "Foo & Bar" slugs to `foo--bar`, not `foo-bar`) — the checker's own
   comment states this explicitly rather than leaving the disagreement to be
   rediscovered.
2. **Fixtures are frozen artifacts, not reproducible builds.** `fixtures/README.md` says
   so directly: re-running `scripts/refresh-fixtures.mjs` produces bundles that still
   verify clean but are not byte-identical to the ones they replace (fresh keys per run).
   Committing them, rather than generating them in CI, is the deliberate consequence.
3. **The conformance kit expresses 11 of the mutations the implementations gate; the
   rest are suite-only lag, named rather than silent.** `conformance/README.md`'s table
   accounts for every excluded mutation (`adr0010`, `adr0011`, `adr0018` G-checks,
   `adr0019` G2/G3, `adr0020`, `adr0021`, `adr0028`'s chain-position assertions,
   `adr0029`/`adr0031`/`adr0032`, `adr0033`) and why each needs something outside the
   kit's edit vocabulary (re-signing, freshly minted evidence, file-level mutation
   beyond an outbox). The TypeScript implementation's own conformance proof is the
   parity cases — it has no bundle verifier the kit could point `--verifier` at.
4. **The pip package needs a path shim.** The flat verifier modules (`keys.py`,
   `policy.py`, …) install under one namespace, `afp_verify.<module>`, rather than as
   top-level modules, because a `pip`-installed package cannot claim bare top-level names
   without risking collisions in whatever environment installs it — `__init__.py`'s
   docstring states the trade-off; nothing about invoking `afp_verify.py` directly from a
   checkout changes.
5. **CI's first real run is on push; nothing in this session proves a green run on
   GitHub.** G1 above is the closest local proof available — every command gate.yml
   names, run in order, in this repository, right now. It is not a substitute for the
   actual Actions run, which has not happened, because this ADR's changes are not
   committed by this session (no commits were made, per the run's own constraints).
   Two of G1's steps are recorded skips rather than passes — the workflow's
   `python3 -m pip install cryptography` in the `verifier` and `conformance` jobs —
   because this host's `python3` carries no `pip` module (`cryptography` is already
   importable here, so the step is unnecessary locally; `actions/setup-python` provides
   `pip` in CI). Everything else G1 names runs and passes here, including the `package`
   job's archive → clean venv → `afp-verify` steps, and G3 runs the same proof for real.
   The review found the first draft of that `package` step extracting into a fixed
   `/tmp/afp-verify-*` path, where a stale extraction from an earlier run was what the
   glob picked up — fine on a clean runner, a false skip everywhere else; it now works in
   a `mktemp -d` of its own, and the `pip` invocations are `python3 -m pip` so they bind
   to the interpreter the job set up rather than to whatever `pip` is on `PATH`.

**No release has been cut, and no signing key exists.** `git config gpg.format` and
`user.signingkey` are both empty in this environment; `scripts/release.sh` refuses to tag
without one — "a release is signed or it is not a release" — and its `--dry-run` mode
was run before this ADR's own commit and stopped at the *clean-tree* check, not the
signing-key check, because the tree genuinely was not clean when it ran. Both checks are
real refusals of the same kind: this session cannot produce a release, and the script
says so rather than approximating one. The package metadata claims no license, because
the repository declares none anywhere; choosing one is the operator's call, and a
`pip` package must not assert what the source does not carry.

**The spec revision moved 3.33 → 3.34.** `docs/afp/README.md`'s changelog names what
ADR-0024 through ADR-0034 added to the wire since v3.33's sweep: ADR-0027's `afp:consumes`
and `afp:producedBy` template digest; ADR-0028's port-agent reconciliation fields and
`Create{afp:Act}`; ADR-0029's `afp:Rendering`, its command grammar, and `afp:shadowOf`;
ADR-0031's `afp:BoundaryDigest`; ADR-0032's `afp:hub` and the seat default; ADR-0033's
`afp:Policy` and its properties; and this ADR's own `afp:specRevision`, published in
**NodeInfo's `metadata`, not the software block** — FEP-f1d5's own shape puts extension
fields in `metadata`, and the software block is reserved for `name`/`version`/`repository`/
`homepage`, which is why `ap/nodeinfo.ts` places it there rather than beside
`INSTANCE_VERSION`. `src/instance/package.json`, `src/verifier/version.py`,
`conformance/VERSION` and every README/`SECURITY.md` mention of the revision are bumped
together; `test/adr0034.test.ts`'s Decision 1 cases keep them in agreement.

## References

- [ADR-0001](0001-p1-stack.md) Decision 5; [ADR-0004](0004-solo-foundation-hardening.md) H7 (parity)
- [ADR-0030](0030-scenario-re-walks-and-the-coverage-index.md) Decision 4
- [ADR-0023](0023-loose-ends-triaged.md) row L22
