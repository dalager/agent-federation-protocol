# ADR-0034 — Release engineering, conformance and disclosure: how the record ships

- **Status:** Proposed (2026-09-02) — program claim **C10** of
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

Not built.

## References

- [ADR-0001](0001-p1-stack.md) Decision 5; [ADR-0004](0004-solo-foundation-hardening.md) H7 (parity)
- [ADR-0030](0030-scenario-re-walks-and-the-coverage-index.md) Decision 4
- [ADR-0023](0023-loose-ends-triaged.md) row L22
