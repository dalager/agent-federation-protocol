# Scenario 07 — The retraction: revising an answer the world already acted on

> Spec-test scenario, deliberately narrow: built *around* revision, as finding 24 asked,
> rather than meeting it in passing. Exercises: superseding a **ratified** Synthesis,
> what overturning a quorum's answer must cost, and the disposition of actions taken on
> a justification that was later withdrawn. Written against the post-ADR-0006 stack, so
> every action is already hash-bound to its answer — which is exactly what makes the
> question answerable. Verdict at the end.

| **Support status** | **Supported — all findings closed** |
|---|---|
| Findings raised | 0 raised — it sharpened finding 24 |
| Resolved by | [ADR-0007](../adr/0007-supersession.md) |
| See it run | no standalone demo — covered by the gate(s) below ([why](README.md#is-this-workload-supported)) |
| Gated by | `adr0007.test.ts` |

**Read the walkthrough below as history.** It records what strained when this workload was
first walked, and is deliberately left as written — that is what makes a scenario evidence
rather than a brochure. Every strain it names is now built; the
[support index](README.md#is-this-workload-supported) is the current-status view, and the
ledger there names the decision that closed each finding.


## User story

**As** the platform team of OurAwesomeProduct,
**I want** the compatibility advisories my swarm issues to other teams to be *revisable*
— retracted or corrected when later evidence contradicts them —
**so that** a wrong answer does not have to be defended forever, and everything done on
the strength of the wrong answer is visibly dealt with rather than quietly orphaned.

## Cast

One instance, one standing hub `hub-platform-oap`. Same shape as scenario 06's; the only
new agent is the one whose job is to be wrong later.

| Agent | Capability | Role |
|---|---|---|
| `advisor-deps` | `afp:cap:assess` | coverage: `dependencies` — upgrade compatibility |
| `advisor-api` | `afp:cap:assess` | coverage: `api-surface` — breaking-change analysis |
| `advisory-scribe` | `afp:cap:notify` | write port: publishes advisories to the teams' channel |

## Walkthrough

**1. The question with consequences.** May client teams upgrade `libfoo` from v3 to v4?
The auction pins coverage over `{dependencies, api-surface}`, an `afp:actionPolicy`
(`safe → publish-advisory`, `unsafe → publish-warning`, `unclear → hold`), and — because
teams will commit sprint time on this answer — hub policy requires ratification.

**2. The answer, ratified.** Both assessors find v4's changelog clean for the product's
usage. The Synthesis answers `safe` with confidence 80; an L0 round ratifies it — the
DecisionRecord's `afp:outcome` names the Synthesis, which is how the record says *the
quorum stands behind this answer*, not merely the synthesizer.

**3. The world moves.** `advisory-scribe` publishes the advisory, the activity
hash-bound to its justification (`afp:actsOn` = the Synthesis digest, `afp:action:
"publish-advisory"` — admissible under the pinned policy, ADR-0006). Two client teams
schedule upgrades. The external write carries its `correlationId`-derived idempotency
key (v3.13); the scribe reconciles with the channel reference.

**4. The evidence that should have lost.** A week in, a client team hits data corruption:
v4 changed a serialization default in a code path the changelog never mentioned.
`advisor-api` reproduces it. The `safe` answer is now known-wrong, ratified, published,
and **acted on**.

**5. The retraction.** A new Synthesis answers `unsafe`, and here the record's existing
vocabulary runs out — three times:

- It names the answer it replaces. `afp:supersededInputs` is the wrong property: 04
  defines it as *input-level* — Results revised during reconciliation — and stretching it
  to answer-level (as scenario 06's step 7 loosely did) conflates "an input was updated"
  with "the conclusion was withdrawn." Retracting an answer needs its own edge:
  **`afp:supersedes`**, the digest of the superseded Synthesis activity.
- It must cost what the original cost. The `safe` answer was a *quorum's* answer; if the
  `unsafe` revision needs only a synthesizer's signature, any lone agent can un-decide
  what a round decided. **Ratification parity**: a ratified Synthesis is superseded only
  by a Synthesis that is itself ratified. (The reverse direction stays cheap — an
  unratified answer can be corrected without convening anyone.)
- The advisory is still out there. The publish action's justification is withdrawn, and
  the record must show the loop closed: a **disposition** — an activity naming the
  action it disposes of (`afp:disposes` = the publish activity's digest) and acting on
  the superseding answer (`afp:actsOn` = the new Synthesis digest). Here: the scribe's
  correction notice, admissible as `publish-warning` under the same pinned policy.

**6. What replay can now answer.** Why did team X upgrade? — the advisory, hash-bound to
the `safe` Synthesis. Is that answer still the record's answer? — no: superseded by
digest, by a ratified revision. Was the advisory dealt with? — yes: the disposition, in
the same thread, acting on the revision. None of those three questions is answerable
today; all three are one digest-walk each once the edges exist.

## Acceptance criteria → mechanisms

| Criterion | Mechanism | Status |
|---|---|---|
| The revision names exactly what it withdraws | `afp:supersedes` — digest of the superseded Synthesis, distinct from input-level `afp:supersededInputs` | **finding 24, sharpened** |
| A quorum's answer is not un-decided by one signature | Ratification parity, checkable from DecisionRecords already on the record | **finding 24, sharpened** |
| Actions on a withdrawn justification are visibly dealt with | `afp:disposes` + `afp:actsOn` on the disposing activity — the actuation loop run once more, under the same pinned policy | **finding 24, sharpened** |
| The advisory itself was admissible, both times | `afp:actionPolicy` (ADR-0006) — `publish-advisory` for `safe`, `publish-warning` for `unsafe` | Yes (v3.12) |
| The correction did not post twice | Idempotency key on the external write (v3.13) | Yes |
| The superseded answer stays in the record | Nothing is deleted; supersession is an edge, not an erasure | Yes (P1 — append-only outboxes) |

## Spec verdict

**Held, with finding 24 confirmed and sharpened — no new findings.** The scenario was
written to stress exactly the seam finding 24 predicted, and found precisely the three
requirements above, no more: a property for answer-level supersession, a parity rule for
overturning ratified answers, and a disposition edge for acted-on justifications. All
three are recomputable-record extensions in the established mold, and ADR-0006's
`afp:actsOn` is what makes the third one *possible* — before actions were hash-bound,
"what did we do about the wrong answer" was not a question the record could parse.

**Where AFP is the wrong tool here, stated plainly.** Most revisions are not
retractions. A typo in an advisory, a broadened version range, an added caveat — those
are new Results on the thread, and dressing them as supersession would make every edit a
governance event. `afp:supersedes` is for the case where the *conclusion* was wrong and
things were done about it: the answer flips, not merely improves. A deployment that
cannot tell the difference should ask whether the original needed ratifying at all.
