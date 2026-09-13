# ADR-0030 — Scenario re-walks, and an index that tells mechanism from workload

- **Status:** Accepted (2026-09-02), **built** (2026-09-13) — program claim **C6** of
  [ADR-0024](0024-the-road-to-production.md); group: **Scenario coverage**. Runs after
  [ADR-0027](0027-the-port-is-a-security-boundary.md), [ADR-0028](0028-port-agents.md)
  and [ADR-0029](0029-the-human-window-and-the-activitypub-premise.md)
- **Date:** 2026-09-02
- **Applies to:** `docs/afp/scenarios/` — the walkthroughs, the support index, and the
  rule that a scenario is never rewritten
- **Builds on:** the scenario discipline itself (README § Writing another), the support
  index's "See it run" and "Gated by" columns, [the operator's Tuesday](../scenarios/the-operators-tuesday.md)
  as the baseline genre
- **Driven by:** the review's third answer. Of roughly 131 acceptance criteria across the
  thirteen scenarios, about 113 are built and gated, 11 are built as a mechanism the
  record can carry rather than the workflow the author described, and 7 are not built.
  The support index marks all 74 findings closed, which is true of the findings; a finding
  closed by a spec sentence assigning a duty to a port agent is not the same as the
  workload running, and the index cannot currently say which it was

## Context

The scenarios are the repository's evidence, and the discipline around them is its best
habit: written to break something, findings triaged into ADRs, walkthroughs never
rewritten. The index that answers "is this workload supported" has one axis too few. It
says whether findings closed and which decision closed them; it does not say whether the
closing was a gate over the workload, a gate over a mechanism the workload would use, or
a sentence.

The pattern in the review is clean and worth recording. Scenarios 10 through 13, written
after the scenario-first discipline matured, are supported end to end, with demos over
real sockets and a real model where the judgement is genuinely the model's. Scenarios 04,
05, 07 and 08 are close behind. The early four — 01, 02, 06, 09 — are stories about an
external system and a human, and the code stops at the port. Their criteria read
"closed" because the *findings* closed, and the findings were about the record.

## Decisions

### 1. Every acceptance criterion carries a coverage class, appended, never rewritten

Each scenario gains a dated section, **Coverage as of <date>**, appended below the spec
verdict and the findings, with one row per criterion in the scenario's own table:

| Class | Meaning |
|---|---|
| **workload demonstrated** | A demo runs the criterion's workload and a gate asserts the workload's outcome |
| **mechanism gated** | A gate asserts the mechanism the criterion names; no demo runs the workload |
| **narrowed** | Built, but to a reading narrower than the author's — the row says how |
| **edge not built** | The criterion lives in an external system, a human step or a brain's judgement that has no counterpart in code |

The walkthrough above it is untouched; the section is history's answer to the
walkthrough's question. The support index gains a column summarising the four counts per
scenario and links to the section.

### 2. The four early scenarios are re-walked once C3, C4 and C5 land

01, 02, 06 and 09 get a second dated coverage section after ADR-0027, ADR-0028 and
ADR-0029 are built, walked against `demo:p8` and the approval and window surfaces.
Anything that strains is a finding, triaged through the campaign ledger exactly as before
(campaign 11). The first coverage section stays as the record of what the review found.

### 3. Three new scenarios

- **Scenario 14 — the seat migration.** An instance's seat from `Follow` through
  `Undo{Follow}` and re-`Follow`, under both seat policies, with the default flipped
  ([ADR-0032](0032-deployment-profile.md) Decision 6). Closes [ADR-0023](0023-loose-ends-triaged.md)
  L14 and ADR-0017's "needs a scenario".
- **Scenario 15 — the production Tuesday.** The program's definition of done
  ([ADR-0024](0024-the-road-to-production.md) Decision 3): an operator's day on a served
  instance on the public internet, every noun a file, warts listed, written in the
  baseline's genre after [ADR-0031](0031-the-resident-process.md) and
  [ADR-0032](0032-deployment-profile.md) land.
- **Scenario 16 — the hostile edge.** An adversarial walk: a stranger, a counterparty
  turned hostile, a poisoned attachment, a forged key document, a flood — against
  [ADR-0025](0025-transport-hardening.md) and [ADR-0027](0027-the-port-is-a-security-boundary.md).
  The first scenario whose cast is the attacker, and the one the security ADRs are
  measured against.

### 4. Demos are gates

Every demo the support index lists under "See it run" also runs in CI
([ADR-0034](0034-release-conformance-and-disclosure.md)) with stub brains, and its
exported bundles replay under the verifier as part of the run. A demo that stops
producing a passing bundle fails the build. The `:llm` variants stay out of CI and stay
in the index as the judgement checks they are.

## Options considered

| Option | Rejected because |
|---|---|
| Rewrite the early scenarios to match what was built | The standing rule, and the reason the scenarios are evidence: a walkthrough records what was true when it was walked |
| Mark the narrowed criteria as findings now | They are not spec defects; they are coverage facts. The re-walk of Decision 2 is where new findings come from, once the edges exist to walk |
| Skip scenario 16 as duplicative of the security gates | A gate proves a mechanism; a scenario proves a story holds under an adversary who does not care which mechanism it is |

## Consequences

**Positive** — "supported" gets the axis it lacked; the early scenarios get the re-walk
their intent deserves; the program gets its definition of done as a document in the genre
that already exists.

**Negative** — coverage sections are one more thing that dates. They are dated on
purpose; a stale one is history, not a lie.

**Accepted** — some narrowed rows will stay narrowed after the re-walk. A regulator's
question about a model's judgement is not a protocol's to answer, and the row will say
so.

## Implementation architecture

| Package | Touches | Content |
|---|---|---|
| **WP-1 · coverage sections** | every `scenarios/NN-*.md`, `scenarios/README.md` | Decision 1, from the review's tables |
| **WP-2 · re-walks** | scenarios 01, 02, 06, 09; the campaign ledger | Decision 2 |
| **WP-3 · new scenarios** | `scenarios/14-…`, `15-…`, `16-…` | Decision 3 |
| **WP-4 · demos in CI** | with ADR-0034 | Decision 4 |

No verifier or wire change. The gate is the index itself: every criterion has a class,
every class is one of four, and every "workload demonstrated" names a demo that CI runs.

## Build status

**Built, 2026-09-13** — WP-1 through WP-3 of the four-package plan above; WP-4's CI
wiring stays [ADR-0034](0034-release-conformance-and-disclosure.md)'s to land.

- **WP-1 · coverage sections.** Every one of the thirteen original scenarios (01–13)
  carries a `## Coverage as of 2026-09-13` section, one row per acceptance criterion from
  the review's own tables, classed *workload demonstrated · mechanism gated · narrowed ·
  edge not built*, with a `**Counts:**` line and a link the support index's own Coverage
  column resolves to. The 131 criteria the review counted across the thirteen scenarios
  hold: no criterion was added or dropped in giving them a class, only classed.
- **WP-2 · re-walks.** Scenarios 01, 02, 06 and 09 each carry a second, dated section —
  `## Coverage as of 2026-09-13 (re-walk)` — walked against the surfaces ADR-0027,
  ADR-0028 and ADR-0029 actually built. The first coverage section of each stays exactly
  as WP-1 wrote it, per Decision 2: a scenario's own text, coverage sections included
  once dated, is never rewritten, only appended to. The re-walk produced campaign 11's
  first nine findings (75–83), triaged in the campaign ledger.
- **WP-3 · new scenarios.** [Scenario 14 — the seat migration](../scenarios/14-the-seat-migration.md)
  (6 findings, 84–89) and [scenario 16 — the hostile edge](../scenarios/16-the-hostile-edge.md)
  (6 findings, 90–95) are written, each carrying its own criteria table and a single
  `Coverage as of 2026-09-13` section (no re-walk — these are new, not being re-read).
  **Scenario 15 — the production Tuesday — is deliberately not written.** Decision 3
  scopes it to after ADR-0031 (the resident process) and ADR-0032 (the deployment
  profile) land, because its entire premise — "an operator's day on a served instance on
  the public internet" — has no served instance to walk yet; writing it now would be the
  exact anti-pattern Decision 1's Option table rejects, a scenario that records what was
  never actually true. The two written scenarios add 21 criteria (9 and 12) to the
  review's 131, for 152 across fifteen scenarios, fourteen of which now carry a coverage
  section (15 is the one exception, by design, until its ADRs exist).
- **The gate.** `test/adr0030.test.ts` runs six checks (G1–G6) over every numbered
  scenario file: a current coverage section exists (G1) alongside an acceptance-criteria
  table (G1b); every coverage row carries one of the four classes and the row count
  matches the criteria table (G2); a "workload demonstrated" row names an `npm run
  demo...` script that exists in `package.json`, is not a `:llm` variant, and is one of
  the scripts `test/demos.test.ts` actually runs (G3); a "mechanism gated"/"narrowed" row
  names a `test/*.test.ts` file that exists on disk (G4); the section's own `**Counts:**`
  line matches its rows and sums to the row count (G5); and the support index's Coverage
  cell for each scenario — the `demonstrated·gated·narrowed·not built` tuple and its
  anchor — agrees with the section it links to (G6, over the whole README at once).
  Alongside it, `test/demos.test.ts` runs the eight demos the support index cites under
  "See it run" (`demo`/`demo:offline` sharing one gate, then p2 through p8) into isolated
  workspaces and replays every exported bundle under the verifier — WP-4's local half;
  wiring both files into CI is [ADR-0034](0034-release-conformance-and-disclosure.md)'s.
- **What the gate caught on its first run.** `test/adr0030.test.ts`'s first pass over
  the freshly written WP-1 sections named four violations, file and row, before any were
  fixed:
  1. [03](../scenarios/03-co-staffed-project.md)'s `narrowed` row "Joint work with exact
     attribution" carried an Evidence cell that opened with the prose "narrowed to: …"
     instead of the backticked `test/adr0022.test.ts` citation G4 requires.
  2. [05](../scenarios/05-integration-practice.md) repeated the same shape on two
     `narrowed` rows — "Guidance is eventually scored on the requester's actuals" and
     "Cross-project component discovery" — each citing `test/adr0004.test.ts` after the
     prose rather than leading with it.
  3. [04](../scenarios/04-federated-estimation.md)'s `**Counts:**` line read
     "7 demonstrated · 3 gated" while the table beneath it held 8 demonstrated and 2
     gated — no row's class was wrong; the author had miscounted the rows (G5).
  4. The support index's Coverage cell for scenario 04 read `[7·3·0·0]`, the propagated
     form of #3 (G6) — a wrong number the index would otherwise have carried
     indefinitely, since nothing else in the repository cross-checks it.

  All four are fixed as of this build. What they say about the gate: three were a
  formatting drift a proofread of thirteen markdown tables would plausibly not have
  caught, and the fourth was an arithmetic slip that would have put a wrong number into
  the one table this whole ADR exists to make trustworthy. That is the case for
  "the gate is the index itself" stated concretely rather than as a slogan: the index is
  only evidence if something checks it, and here something did, immediately, by name,
  rather than the wrong Coverage cell surfacing later as a reader's unexplained doubt
  about whether scenario 04's "closed" findings really meant what the cell claimed.
- **Two changes made to the gate itself during this review**, alongside the four content
  fixes above. First, G6 derives the README anchor it checks against from the current
  coverage heading's own GitHub slug, rather than a fixed string — the mechanism WP-2's
  re-walk sections need, since a re-walk section shares its scenario's date with the
  first section and is distinguished only by a `(re-walk)` suffix in its heading, and the
  anchor has to follow the heading exactly. Second, `test/demos.test.ts` was written
  alongside `adr0030.test.ts` rather than after it, because G3's own rule — "a 'workload
  demonstrated' row names a demo that CI runs" — is only a real check once something
  actually runs that demo and asserts an outcome over it; `demos.test.ts` is that
  something, and its `DEMOS_IN_GATE` list is what G3 reads to decide a cited script
  counts.
- **Coverage classes, and where they came from.** ADR-0030's own Context is explicit
  that "the 2026-09-02 review's per-scenario criteria tables" are not in this repository
  — they were the review's working notes, not a committed artifact. Every class in every
  WP-1 section here was therefore re-derived from the repository's own evidence as it
  stands today (which test file, which demo, which build note), not transcribed from
  those tables; where a class differs from what the review's summary paragraph implies
  (the "about 113 built and gated, 11 narrowed, 7 not built" estimate in this ADR's own
  Status line), this build trusts the re-derivation, since it is checkable and the
  review's estimate is not.
- **What ADR-0032 Decision 6 changes and does not change here.** Scenario 14 walks both
  seat policies as `hub/hub.ts` runs them today; the default flip to `follow-required` is
  ADR-0032's decision, not this one's, and scenario 14's finding 87 says so rather than
  assuming the flip and walking a hub that does not exist yet — the same discipline
  Decision 3 applies to scenario 15 in full, applied here to one row of scenario 14.

## References

## References

- [Scenarios README](../scenarios/README.md) — § Is this workload supported?, § Writing another
- The 2026-09-02 review's per-scenario criteria tables (the seed of WP-1)
- [ADR-0023](0023-loose-ends-triaged.md) row L14
