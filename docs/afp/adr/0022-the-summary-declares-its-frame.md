# ADR-0022 — The P7 accounting stack: a summary declares its frame, or it is a number in a signed envelope

- **Status:** Accepted, and **built** (2026-08-23) — all five decisions, gated by
  `test/adr0022.test.ts` (24 cases, suite green at 245), every shipped bundle replaying
  with unchanged pass status and unmoved check counts
- **Date:** 2026-08-23
- **Applies to:** P7, and — for Decision 2 — **every phase from P1 onward**, because a
  co-authored `afp:Result` is producible the moment two agents share a thread and the
  rule governing it has been normative since v3.4
- **Builds on:** [ADR-0004](0004-solo-foundation-hardening.md) (recomputable reputation
  consumption, whose `afp:reputationRule` + `afp:settlementSnapshot` pair is the shape
  Decisions 1 and 3 copy), [ADR-0005](0005-operators-are-equal.md) (the integer-share
  arithmetic Decision 2 reuses rather than reinventing),
  [ADR-0007](0007-supersession.md) (answer-level retraction, which Decision 4 must not
  contradict), [ADR-0013](0013-authorized-fetch.md) and
  [07](../07-visibility-and-artifacts.md) (the read gate Decision 1 collides with),
  [ADR-0014](0014-p5-shared-hub-stack.md) (hub-observed order, Decision 1's answer to the
  period edge), [ADR-0015](0015-the-case-file-at-n-parties.md) (the check census,
  Decision 1's model), [ADR-0018](0018-the-round-as-a-commitment.md) (declare-before-you-act,
  the discipline this whole ADR applies one layer up), [ADR-0021](0021-conviction-to-consequence.md)
  (forward-scoping, which Decision 4 extends to accounting)
- **Driven by:** [scenario 13 / campaign 10](../scenarios/README.md#campaign-10--built-scenario-13-the-p7-shakedown),
  findings **66-74**

## Context

Campaign 10's through-line is that **a sum is only as recomputable as its input set is
agreed, and the protocol does not name sets.**

Every mechanism P1 through P6 built answers a question about an event you can point at:
this signature verifies, this tally recomputes, this proof convicts, this expulsion was
ratified. `afp:ContributionSummary` is the first object in this protocol whose subject is
a **boundary** — which events, over which window, seen by whom, credited at what weight,
still valid under which vocabulary — and scenario 13 found nine different edges of that
boundary left undrawn.

The scenario is worth reading for one property no earlier shakedown had: **nobody in it
misbehaves.** Four honest support desks recompute the same quarter from the same rules
and get different numbers, and not one of them has done anything wrong. Every
disagreement is manufactured by a silence in the spec. That is a different failure mode
from campaign 9's — there, the record could not say what to *do* about a party it had
convicted; here the record cannot say what it *summed*.

Two of the nine findings are older than the campaign and are promoted ahead of the rest
for the same reason ADR-0021's were:

- **`afp:contributionSplit` has been normative since v3.4 and implemented never**
  (finding 66). 03 requires it whenever a Result's `attributedTo` names several actors
  and rules that a Result lacking it counts *for no one*. No builder emits it; no check
  reads it. So the collaborative case — the one where credit is genuinely ambiguous, and
  the entire reason the field was invented (campaign 1's finding 7) — is silently dropped
  from the arithmetic P7 exists to make checkable. The desk that does the most co-work is
  the desk the ledger can see least of.
- **And as specified it cannot be written down** (finding 67). 03 defines the split as "a
  map of actor → fraction summing to 1"; the AFP JCS numeric profile forbids non-integer
  numbers in a signed document. This is not an inconvenience, it is the identical wall
  ADR-0005 hit for vote weights — and solved, with integer shares over a
  least-common-multiple denominator, in an ADR that post-dates 03's sentence and was
  never carried back to it.

That pair is this ADR's first slice, and it is worth landing on its own: it is a handful
of lines, it needs no summary object to exist, and every decision below reads the credit
it fixes.

## Decisions

### 1. A summary declares its frame, or it is not recomputable

**Built.**

`afp:ContributionSummary` MUST pin, before any arithmetic, the four things a second party
needs in order to sum the same set:

```jsonc
{
  "afp:frame": {
    "afp:periodRule": { "afp:form": "hub-observed", "afp:hub": "…", "afp:from": "sha256:…", "afp:to": "sha256:…" },
    "afp:inputScope":  { "afp:visibility": ["public", "hub"], "afp:hubs": ["…"] },
    "afp:splitRule":   { "afp:form": "declared-shares" },
    "afp:vocabulary":  "v3.29"
  }
}
```

**The period edge is hub-observed, not wall-clock** (finding 68). `afp:period`'s
`start`/`end` select on `published`, which is self-asserted — the thing ADR-0014's
resolution of finding 45 already ruled cannot carry a cross-operator ordering claim. A
ticket that straddles a quarter boundary currently belongs to whichever quarter its own
author says it does. The `hub-observed` form pins the period as a half-open interval
between two of the **hub's own chain-head digests**, which is the one order every member
observes identically and no member can move. Wall-clock `afp:period` stays as
human-readable narration; it is never what the arithmetic selects on.

**The input scope is declared and its gaps are counted** (finding 70). 04 calls the
inputs "fully derived from public signed data"; 07 and ADR-0013 guarantee that
non-`public` work is served to nobody unentitled — 404, by design and correctly. Two
members therefore recompute honestly and disagree, with no way to tell an entitlement gap
from an error or a fraud. So a summary declares the visibility classes it summed over,
and — this is the load-bearing half — carries `afp:unreadable`, a count of activities in
the period the computer could see the *existence* of and not the content of, per
operator. A difference between two summaries then resolves to a stated cause instead of
an accusation.

This is ADR-0015's census in accounting form, and the invariant behind it is the same
one: **a quantity that could not be computed is never silently folded into one that
could.**

### 2. The split is integer shares, and it is refused at the port

**Built.** Two halves, both small.

**2a. Shares, not fractions.** `afp:contributionSplit` is a map of actor → **positive
integer share**; the denominator is their sum. A consumer scales to a common denominator
the way `voterWeights` already does. No new arithmetic is introduced, and an implementer
who finds themselves writing a rounding rule has taken a wrong turn.

```jsonc
"attributedTo": ["https://dayshift.example/agents/triage", "https://kestrel.example/agents/fixer"],
"afp:contributionSplit": { "https://dayshift.example/agents/triage": 1,
                           "https://kestrel.example/agents/fixer": 3 }
```

**2b. The MUST binds the writer; the fallback is for the reader.** 03 states both a
requirement ("the emitting instances MUST also state a contribution split") and a
fallback ("absent it, verifiers count such a Result for no one"), and a rule with a
defined fallback is a rule nobody keeps. Ruled: a co-authored Result without a split is
**refused at the builder** — `createResult` throws rather than emitting an uncreditable
Result — and is a **named replay failure**. 03's fallback is retained for exactly one
job, stated explicitly rather than left as a general escape: it is what an accounting
pass does with a pre-ADR record it is nonetheless summing.

The keys MUST equal the `attributedTo` set exactly. A split naming somebody who is not an
author credits a stranger; a split omitting an author silently drops them, which is
finding 66's defect in miniature and would survive the fix that closes it.

### 3. `afp:inputHash` gets a preimage, or it is deleted

**Built.**

Finding 69. The field exists so a second party can confirm it summed the same things, and
no document has ever said what "the same things" are — which makes it precisely the shape
`afp:quorumSnapshot` had before ADR-0021 Decision 2a called it "a digest nothing
recomputes, decorative since P2."

`afp:inputHash` MUST equal `digest_of(sorted(activity digests in the frame))` — the
canonical set being every activity the declared `afp:frame` selects, by digest, sorted,
with the unreadable ones excluded and counted separately per Decision 1. The verifier
recomputes it from the frame and fails a summary whose advertised hash does not match the
set it declares.

A field whose preimage is unspecified is not a weaker check than a specified one. It is
not a check, and it reads to a casual auditor exactly like one. If Decision 3 is not
built, `afp:inputHash` should be removed from 04's example rather than left standing.

### 4. Credit is fixed at acceptance, and nothing reaches backwards

**Built.**

Two findings, one rule.

**Work that did not hold** (finding 71). The record can say "it did not hold" in two
ways — `afp:Settlement` actuals move reputation (ADR-0004), `afp:supersedes` retracts a
ratified Synthesis (ADR-0007) — and neither states a contribution consequence. The
commonest case has no vocabulary at all: a bare Result on a direct award, re-opened later,
is simply a new task. Ruled: **contribution is credited at acceptance and is never
un-counted.** A settlement or a supersession inside the period is recorded as its own
fact in the summary (`afp:qualified`, a per-operator count) rather than deducted from the
count. A pool that pays only for fixes which turn out permanent is a pool where nobody
touches a hard ticket, and — more to the point here — a number that can move after the
fact is not a number two parties can agree on.

**An expelled member's quarter** (finding 72). ADR-0021 forward-scoped conviction and
restoration for *weight* and said nothing about contribution. Ruled by the same
principle, stated once for both: **accounting is forward-scoped.** Work accepted before
an expulsion counts; the summary records the membership change inside its own period. The
alternative — summing only over current members — erases a company's work retroactively
by an act it took no part in, which is the exact shape ADR-0021 refused for rounds.

### 5. A summary becomes authoritative by ratification, and a correction supersedes

**Built.**

Finding 73. 04 resolves the mechanical dispute by "republishing a corrected summary",
which produces two unranked summaries for one period, signed by different members,
with no supersession edge and no rule for which stands. `afp:computedBy` is deliberately
not a privileged role, so nothing breaks the tie — the protocol has an object that says
what a quarter was worth, a mechanism for challenging it, and no mechanism for the
challenge to *end*.

Ruled, entirely out of machinery that already exists:

- Every summary is a **draft** until ratified. A draft is a legitimate, publishable
  object; it simply carries no authority, and says so.
- A summary becomes authoritative by being the subject of an ordinary ADR-0018 round —
  the same rounds that decide everything else consequential, recusal-aware since
  ADR-0021, with the summary's digest as the pinned subject.
- A correction supersedes under ADR-0007's grammar (`afp:supersedes` naming the ratified
  summary's activity digest), and a ratified summary is superseded only by a ratified
  one — the ratification-parity rule, transplanted unchanged.
- `afp:ContributionDispute` is **built**, and it is what 04 makes it: the cheap path with
  a floor under it. It names its summary, its ground (a closed set of 04's own three) and
  its evidence, and it is refused at the builder and failed at replay if it cites nothing
  the case file carries — a dispute with no evidence is the claim this object exists to
  replace. The mechanical grounds are adjudicated by the disputed summary's own
  recomputation rather than by anything new; `quality` escalates, and that routing has
  teeth: a summary under an unanswered quality dispute may not be superseded by a draft,
  or the cheap path swallows the expensive one and the contested question leaves the
  record.

## The vocabulary amendment (finding 74)

Recorded here and **amended into [ADR-0017](0017-standards-conformance.md)** rather than
decided here, because it is a standards-conformance rule and that is ADR-0017's file:
a renamed wire type keeps a **read-side alias**, exactly as draft-cavage was kept when
RFC 9421 became native (ADR-0017 Decision 2), and a bundle using a retired spelling fails
by a check that *names the retired spelling* rather than by whatever downstream check
happens to notice the absence first.

Why it belongs to this campaign at all: for every other object a vocabulary change is a
migration nuisance. For the first object whose inputs are **historical by definition** it
is an accounting error with a signature on it — a look-back over a period that spans a
rename silently sums a different set.

## Options considered

- **Leaving the split as fractions and rounding at consumption**: rejected. Rounding is a
  rule, rules need to be recomputable identically in two implementations, and this
  repository already owns an exact integer answer to the same question (ADR-0005). A
  second weight arithmetic is the wrong turn W0.1 exists to stop.
- **Making a summary hub-computed and authoritative**: rejected, and 04 rejected it
  first — the entire value of the object is that nobody's arithmetic has to be trusted.
  Decision 5 adds a terminal without adding a privileged computer.
- **Making absence of a split a silent zero** (03's fallback, generalized): rejected. It
  is what the protocol does today and it makes the most collaborative operator the least
  visible one. A rule whose violation is invisible is not a rule.
- **Selecting the period on `published` with a tolerance window**: rejected. A tolerance
  is a second self-asserted number; the hub's chain already provides an order every
  member observes identically.

## Consequences

- A summary is bigger and more explicit: a frame, an unreadable census, a qualified
  count. That is the cost of a number two parties can agree on, and it is the same trade
  ADR-0018 made when it put the deadline, the bar and the policy on the proposal.
- Decision 2 changes a builder's error behaviour: a caller that co-authors a Result and
  supplies no split now throws where it previously emitted. No shipped bundle in this
  repository names several actors in `attributedTo`, so nothing existing changes shape —
  verified against every `export-*` bundle before landing.
- Decision 1 does **not** make a partial-view summary invalid. It makes it *legible*. Two
  honest members with different entitlements still produce different numbers; what
  changes is that the difference now has a stated cause.
- Decision 5 gives disputes a terminal without giving anyone a casting vote, at the cost
  of one round per authoritative summary. Pools that never dispute anything can leave
  every summary a draft and pay each other on drafts; the protocol's job is to make the
  distinction sayable.

## Implementation architecture

Governing properties, unchanged since ADR-0018 and repeated because they are the two an
implementer breaks first: **integer arithmetic only**, and **recomputable from the record
alone**.

### W0. Invariants

1. **Never fork the weight arithmetic.** Shares scale to a common denominator the way
   `voterWeights` does. If you are writing a rounding rule, stop.
2. **A quantity that could not be computed is never folded into one that could.**
   Unreadable inputs are counted, never estimated, never dropped silently.
3. **Nothing reaches backwards.** Credit is fixed at acceptance; settlements,
   supersessions and expulsions are recorded inside the period, never subtracted from it.
4. **Closed registries stay closed.** An unrecognised `afp:form` in a period rule, split
   rule or scope fails; it never falls through to a default.
5. **Every new property is emitted only when supplied.** An unchanged caller must produce
   byte-identical output.
6. **No dead fields.** Every property this ADR adds is read by a named check in the same
   work package that emits it. `afp:contributionSplit` is this campaign's cautionary
   precedent and it is three years old.

### W1. Wire schemas

**`afp:Result` — one new property (Decision 2, built):**

```jsonc
{
  "attributedTo": ["https://a.example/agents/x", "https://b.example/agents/y"],
  "afp:contributionSplit": { "https://a.example/agents/x": 1, "https://b.example/agents/y": 3 }
}
```

Required when `attributedTo` is an array naming more than one actor; forbidden otherwise.
Values are integers `>= 1`. Keys equal the `attributedTo` set exactly.

**`afp:ContributionSummary` — the frame (Decisions 1, 3, 4, 5):** see Decision 1's block,
plus `afp:unreadable` (per-operator counts), `afp:qualified` (per-operator counts),
`afp:inputHash` (Decision 3's preimage), `afp:supersedes` (Decision 5), and the
draft/ratified distinction carried by whether a `DecisionRecord` names the summary's
digest.

### W2. Algorithms

```python
split_is_well_formed(result) -> bool:
    authors = attributed_actors(result)          # [] for a single-author Result
    split   = result.get("afp:contributionSplit")
    if len(authors) <= 1:
        return split is None                     # forbidden where there is nothing to split
    if not isinstance(split, dict) or set(split) != set(authors):
        return False
    return all(isinstance(v, int) and not isinstance(v, bool) and v >= 1 for v in split.values())

credit(result, actor) -> tuple[int, int]:        # (share, denominator) — never a float
    split = result["afp:contributionSplit"]
    return split[actor], sum(split.values())
```

### W3. Verifier checks

| # | Check name | Fails when |
|---|---|---|
| V1 | `contribution: {id} co-authored result declares a well-formed split` | **built** — `attributedTo` names several actors and `afp:contributionSplit` is absent, names a different set, or carries a non-integer or non-positive share; or a single-author Result carries one |
| V2 | `contribution: {id} summary frame is a known form` | a period/scope/split rule outside its closed registry |
| V3 | `contribution: {id} input hash matches the set its frame declares` | `afp:inputHash != digest_of(sorted(selected digests))` |
| V4 | `contribution: {id} unreadable inputs are counted, not dropped` | the frame's scope excludes activities the replay can see and the summary counts none |
| V5 | `contribution: {id} credit is fixed at acceptance` | an entry deducts for a settlement or supersession inside the period instead of recording it |
| V6 | `contribution: {id} ratified summary supersedes only a ratified one` | ADR-0007's parity rule, over summaries |

### W4. Work packages

| WP | Owns | Content | Depends on |
|---|---|---|---|
| **WP-1 · split (built)** | `src/instance/src/ap/activities.ts`, `src/verifier/decision.py` | Decision 2: the builder refusal and V1 | — |
| **WP-2 · frame** | `src/instance/src/hub/summary.ts` (new), `src/verifier/summary.py` (new) | Decisions 1 and 3: the frame, the census, the preimage; V2-V4 | WP-1 |
| **WP-3 · validity** | `src/verifier/summary.py` | Decision 4: acceptance-fixed credit, forward-scoped membership; V5 | WP-2 |
| **WP-4 · terminal** | `src/verifier/summary.py`, `src/instance/src/hub/hub.ts` | Decision 5: ratification as an ADR-0018 round, supersession parity; V6 | WP-2 |
| **WP-5 · gate + spec** | `src/instance/test/adr0022.test.ts`, `docs/afp/03-coordination.md`, `docs/afp/04-operations.md` | W5's matrix; 03's fraction sentence corrected, 04's frame and terminal | all |

**Land it in slices, smallest first.** Slice one is **Decision 2** — the split — because
it needs no summary object to exist, because it closes a rule that has been normative and
unimplemented for three years, and because every later decision reads the credit it
fixes.

### W5. Gate matrix — `test/adr0022.test.ts`

| # | Case | Asserts |
|---|---|---|
| G1 | A single-author Result, unchanged | replays clean; byte-identical to pre-ADR output |
| G2 | A co-authored Result with integer shares | replays clean; `contribution:` runs |
| G3 | The builder refuses a co-authored Result with no split | throws at the port, before anything is signed |
| G4 | Mutation: a split whose keys omit one author | fails **V1** |
| G5 | Mutation: a split naming a non-author | fails **V1** |
| G6 | Mutation: a fractional share | refused by the **numeric profile** at canonicalisation, before V1 runs — see Build status |
| G7 | A single-author Result carrying a split | fails **V1** — nothing to divide |
| G8 | Every shipped bundle, replayed as it ships | unchanged pass status and check counts |

## Build status

**Decision 2 built** (2026-08-23), as W4's first slice. `createResult` takes an
`attributedTo` array and an `afp:contributionSplit`, validates the pair before signing —
keys equal to the author set, shares positive integers — and throws on a co-authored
Result with no split; `check_contribution_split` records
`contribution: {id} co-authored result declares a well-formed split` per domain, over the
thread pool. Gated by `test/adr0022.test.ts`; every shipped bundle replays with unchanged
pass status, and no bundle's check count moves, because no bundle in this repository has
ever named two authors on a Result — which is finding 66 restated as a measurement.

**One thing the build found that the design had not, and it strengthens finding 67.**
The gate's fractional-share row was written to assert that a `0.75` share fails the
contribution check by name. It does not: it never reaches the check at all. The JCS
canonicaliser refuses to read a signed document containing a non-integer
(`ValueError: non-integer number 0.75 is not allowed in a signed AFP document`), so the
replay dies at `bundle: readable` with `contribution:0` in the census. 03's "map of actor
→ fraction summing to 1" is therefore not awkward-but-workable — **it is unreadable by
this protocol's own signing profile**, and any implementer who had tried to build 03 as
written would have discovered that at the first signature rather than the first
recomputation. The gate row now asserts what actually happens, which is the better
evidence.

**Decisions 1 and 3 built** (2026-08-23), as W4's second slice: `summary.ts` and
`summary.py` as parity twins, the frame emitted and recomputed, the census counted, the
input hash given the preimage it never had. `contributionSummary` publishes a **draft**
(nobody is privileged, so nothing else would be honest until Decision 5 exists), and the
arithmetic is a pure function any member can run over whatever it can read.

Two things the build found that the design had not, both worth the slice on their own:

1. **The merged pool double-credits, and the record is not at fault.** A joint replay
   pools every bundle's activities, and ADR-0009's received bytes are *verbatim copies* —
   so a Result answered by one operator and received by another appears twice, and a naive
   sum credits the work twice from a perfectly correct case file. Both implementations now
   deduplicate by digest before counting anything. This is the first arithmetic in the
   protocol that reads the whole case file rather than one domain's half, and it is the
   first place where the joint pool's duplication became a wrong number instead of a
   redundant check.
2. **The parity rule earned itself back in one run.** The two implementations disagreed
   immediately: `afp:Settlement` travels as a *bare* afp-typed activity carrying its
   payload in `object`, so Python's `afp_object` matched the envelope on its first branch
   and returned an activity with no `afp:task` on it — silently routing every settled task
   into the unreadable census. The TypeScript, written against the wire shape, had it
   right. Had the Python been transliterated from the TypeScript rather than mirrored from
   this ADR, the two would have agreed and both would have been wrong in the same way for
   whichever shape the transliteration missed.

**Decisions 4 and 5 built** (2026-08-23), as W4's third slice — and the check that
carries Decision 4 is not the one the ADR expected. `afp:qualified` and `afp:membership`
record what the period contained, but what makes "credit is fixed at acceptance"
*enforceable* is **V5, the entries themselves recomputing**: nothing in the recomputation
can express a deduction, so a summary that quietly un-counts work it already credited
cannot match a second party's arithmetic. That check is also P7's own roadmap gate line —
"a second operator recomputes it from certificates and Results and matches" — and it was
missing from W3's original table, which listed the input *set* and never the numbers.

Decision 5 needed no new machinery at all: a summary is ratified by a `DecisionRecord`
whose `afp:outcome` names it, which is **04's existing ratification idiom**, the same one
ADR-0007 already reads to tell a ratified Synthesis from a cheap one. Parity transplants
unchanged (a ratified summary is superseded only by a ratified one), and the terminal
check — at most one ratified, unsuperseded summary per period — is replay-wide for the
reason every check of its kind is: the competing summaries live in different members'
bundles by construction.

**A third build finding, and it is a rule the ADR had not stated.** The two
implementations disagreed on whose credit an agent's work is, once that agent has left the
hub: the TypeScript read the hub's live membership, the Python folded the trail as of
"now", and they bucketed the same Result differently. Both were wrong. The operator is the
`actor` of the agent's own `afp:Enroll` — where ADR-0005 Decision 2 binds it — resolved
**as of the period's close**, and an `afp:Unenroll` does not clear it: leaving a hub ends
a seat, it does not retroactively change who did the work. Resolving as of *now* would let
an agent that leaves after a quarter re-bucket its own past credit, which is the defect
ADR-0021 Decision 1 closed for weights, arriving one layer up in accounting. Both
implementations now fold the same rule from the same evidence.

## References

- [Scenario 13 — The quarterly split](../scenarios/13-the-quarterly-split.md), findings 66-74
- [04 — Contribution accounting](../04-operations.md#contribution-accounting) — the object this ADR gives a frame
- [03 — Co-work](../03-coordination.md#co-work-the-ping-pong-thread) — the fraction sentence Decision 2 corrects
- [ADR-0005](0005-operators-are-equal.md) — the integer-share arithmetic, unforked
- [ADR-0015](0015-the-case-file-at-n-parties.md) — the census Decision 1 copies
- [ADR-0018](0018-the-round-as-a-commitment.md) — declare-before-you-act, one layer down
- [ADR-0021](0021-conviction-to-consequence.md) — forward-scoping, which Decision 4 extends to accounting
