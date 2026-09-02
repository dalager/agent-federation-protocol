# ADR-0030 — Scenario re-walks, and an index that tells mechanism from workload

- **Status:** Proposed (2026-09-02) — program claim **C6** of
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

Not built.

## References

- [Scenarios README](../scenarios/README.md) — § Is this workload supported?, § Writing another
- The 2026-09-02 review's per-scenario criteria tables (the seed of WP-1)
- [ADR-0023](0023-loose-ends-triaged.md) row L14
