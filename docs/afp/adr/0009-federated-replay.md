# ADR-0009 — Federated replay: two exports, one engagement, and lawful redaction

- **Status:** Accepted, and **built** — gated by the first joint replay: two real
  instances, two exports (one scoped, with stubs and a declared omission), one command
- **Date:** 2026-08-20
- **Applies to:** verification of any engagement spanning trust domains — load-bearing
  from P4 (the boundary exists and is built, ADR-0008), unavoidable at P5
- **Builds on:** [ADR-0001](0001-p1-stack.md) (the single-export verifier this
  generalizes), [ADR-0005](0005-operators-are-equal.md) (the `afp:operatedBy` binding
  that becomes the partition key), [ADR-0008](0008-p4-federation-stack.md) (which built
  the boundary and refused, by name, to decide these two questions in its margins)
- **Driven by:** [scenario 08 / campaign 5](../scenarios/README.md#campaign-5--v316v317-adr-0008-adr-0009),
  findings 29a and 29b — the campaign's last two open items

## Context

The verifier's whole design assumes one operator's total record: `build_authority`
reads one roster, completeness means "every rostered agent has an outbox in *this*
bundle," and `check_chain` demands every actor's chain be contiguous from its first
activity. Scenario 08 broke both assumptions at once, and its outside-in telling showed
where the break lands in practice: the audit's last mile is *a person with two folders
and a checklist* — the one seam the P4 build deliberately left soft.

Two distinct problems, which ADR-0008 refused to solve in a stack ADR's margins:

**29a — completeness is single-domain.** Alpha's export *cannot* contain Bravo's
chains; it holds signed activities *received from* Bravo, whose `prevActivity` links
resolve only in Bravo's export. A federated replay needs each export to answer for its
own actors, cross-references to resolve across the pair, and every hole attributed to
the domain that owns it. And it has a security crux the review pass named: if either
bundle may carry the *other* domain's actor documents as authority, one operator can
smuggle forged counterparty keys and re-sign "received" history.

**29b — a scoped export and a tampered one share a signature.** Bravo's export is
engagement-scoped by right — its other clients are nobody's business — but chains are
contiguous by construction, so a lawfully-withheld activity leaves exactly the hole a
deleted one does. Today, deliberate redaction and tampering are indistinguishable,
which means the honest operator's discretion reads as the dishonest operator's crime.

One inherited principle bounds everything below: **supersession taught that revision is
an edge, never an erasure (ADR-0007); redaction is the same lesson for disclosure.**
The record is never mutated — an export is a *view* of it, and what this ADR decides is
what an honest view must still prove.

## Decisions

### 1. Federated replay is N single-export replays plus a cross-check — not a new verifier

The joint verification of an engagement takes the export set (two at P4) and runs in
two phases:

- **Phase one, per domain:** the existing single-export replay, unchanged, over each
  bundle — every check from P1's signatures to ADR-0008's federation checks runs as it
  does today, and every finding is labelled with its domain. Completeness stays what it
  was, *scoped to the domain's own roster*: Alpha's export answers for Alpha's actors
  and no one else's.
- **Phase two, across:** the cross-checks of Decisions 2–3, which only make sense over
  the pair.

This shape is a deliberate refusal to fork the verifier: a federated replay that
recomputed different things per-domain than a solo replay would make "verified" mean
two different words. One implementation, one meaning, run N times plus a join.

### 2. Authority is partitioned by `afp:operatedBy` — a domain's keys come only from its own export

The crux. In the joint replay, the verification keys for an actor operated by domain D
are believed **only from D's export** — its actor documents, its roster. A copy of
Bravo's actor document found in Alpha's bundle is evidence Alpha fetched it (beat 4 of
the scenario), never authority; if it disagrees with Bravo's own, that disagreement is
itself a named finding, attributed to whichever domain's copy fails its own signature.

Two corollaries, both cheap and both load-bearing:

- **The agreement must appear in both exports, digest-equal.** Each side's signed
  `Create{afp:FederationAgreement}` wraps the byte-identical object (ADR-0008's
  dual-Create); the joint replay checks the two objects' digests match. A pair of
  exports whose agreements differ is not one engagement — it is two stories.
- **Hole attribution falls out of the partition.** Every failing check names an actor;
  the actor's `afp:operatedBy` names the domain; the finding is Bravo's or Alpha's,
  never "the record's." An auditor's report gains the only column it was missing.

### 3. A received activity must be the same bytes its sender recorded

For every cross-boundary activity present in domain A's bundle as received-from-B: it
MUST resolve **by digest** to the same activity in B's export. A mismatch — same id,
different bytes — is a named divergence finding against whichever copy fails its
signature (or against both stories, when each verifies under its own domain's keys: the
strongest possible evidence that one operator re-signed history, surfaced rather than
averaged away). An absence is a named finding attributed to B — the sender owns the
proof that it sent what the receiver holds — *unless* B's export covers it with a
redaction stub, which is Decision 4's business.

### 4. Redaction is an export-time transform that emits stubs — the record is never touched

A scoped export replaces each withheld activity with a **redaction stub** in chain
position:

```json
{ "type": "afp:Redacted", "afp:digest": "sha256:…", "afp:visibility": "internal" }
```

- The stub carries the withheld activity's **digest** — which the exporter already
  holds, because the *next* activity's `afp:prevActivity` names it. The chain check
  accepts a stub as a link: the preceding activity's digest must equal what the stub
  declares, and the following activity's `prevActivity` must equal the stub's declared
  digest. Contiguity is preserved; content is not disclosed.
- **Stubs are 1:1 with withheld activities, deliberately.** A stub reveals that
  *something* existed at that chain position, in that quantity — and hides everything
  else: type, thread, addressees, content, timestamps. That trade is made openly: an
  export that must hide even the *count* of its other work should not be exporting that
  actor's chain at all (export a different agent's, or none — the roster row and a
  completeness waiver, Decision 5, exist for exactly that).
- Redaction happens **at export time, in `exportBundle`**, driven by a scope (a thread
  set, a visibility floor, an agreement's grants). The outbox is untouched — the same
  record can produce the full export tomorrow, and two exports of different scopes are
  two views that agree wherever they overlap, checkably.
  *(Constrained by [ADR-0010](0010-pinning-without-an-auction.md) Decision 5: a scope may
  not withhold a thread's task-bearing activity while disclosing an answer on that thread.
  The pins an answer was judged under are frame rather than content, and every pin check is
  conditional on their being resolvable — so redacting them fails nothing and silences all
  of them. Only the thread-set scope is implemented today, and it cannot split a thread;
  the constraint is stated for the visibility-floor and grant scopes named above, which
  can.)*
- **Monotonicity across stubs:** a stub carries no `published`, so the chain-wide
  non-decreasing check (ADR-0008) brackets across it — the first disclosed activity
  after a stub run must not precede the last disclosed one before it. The backstop
  survives redaction with its teeth intact.

### 5. A scoped export declares its scope, and completeness respects it

The manifest gains `afp:exportScope`: the threads (or agreement digest) the bundle
answers for, and the roster entries it deliberately omits. Phase-one completeness for a
scoped export checks *the declared scope*: every scoped actor has an outbox, every
outbox chain is contiguous-with-stubs, and an actor omitted from scope is a stated
omission, not a silent hole. An undeclared gap remains exactly what it is today —
tampering. The line this draws is the whole point of 29b: **discretion is declared;
deletion is detected.**

*(Extended by [ADR-0012](0012-the-long-horizon.md): the manifest becomes a signed document
and gains `afp:keyHistory`, `afp:members`, and — where a deployment declares one —
`afp:retentionDuty` and `afp:anchors`. This ADR specified how an export is *scoped* without
ever stating what a bundle *contains*; `afp:members` closes that, and the key history keeps
a scoped export verifiable after the keys that signed it have been rotated away.)*

## Options considered

| Option | Rejected because |
|---|---|
| A separate "federated verifier" with its own rules | "Verified" would mean different things at one operator and two; N-runs-plus-join keeps one implementation and one meaning |
| Trust either bundle's copy of the counterparty's actor documents | One operator smuggles forged keys and re-signs received history — the exact attack Decision 2 exists to name |
| Aggregate stubs (one stub per gap, count hidden) | Makes a 3-activity gap indistinguishable from a 300-activity gap — a redaction mechanism that hides *scale* invites the launderer, and 29b's goal is distinguishing discretion from deletion, not maximizing discretion |
| Stubs carry type/thread but not content | Leaks the coordination metadata the pairwise profile exists to protect (v3.15); digest-only is the minimum that preserves the chain, so it is the maximum that should be required |
| Redact by rewriting the outbox (tombstones in the record) | Erasure in the record is the one thing this project never does — ADR-0007 said it for revision, and disclosure is not an exception |
| Defer 29b again, ship 29a alone | Phase one *requires* chain checks over scoped exports — Bravo's lawful scope fails `check_chain` without stubs, so 29a without 29b verifies only total exports, which is 29a without its reason to exist |

## Consequences

**Positive**

- The audit's last mile — the person with two folders — becomes a command: the join is
  mechanical, findings arrive pre-attributed to a domain, and the strongest tampering
  evidence (two validly-signed divergent copies) surfaces by construction.
- Discretion stops costing honesty: a boutique with other clients exports its
  engagement, stubs and a declared scope, and passes — while an identical-looking
  *undeclared* gap still fails. The two signatures 29b complained about become two
  verdicts.
- Nothing at one operator changes: a total export has no stubs, no scope declaration,
  and phase one is today's verifier verbatim.

**Negative / accepted risks**

- A stub reveals existence and count. Accepted openly (Decision 4) — the alternative
  hides scale, and hiding scale is the launderer's feature request.
- Digest-equality across exports assumes both sides exported the *same serialization*
  of received activities. True today (activities travel as signed bytes and are stored
  as received); becomes an obligation worth one spec sentence: store what you verified,
  not a re-serialization.
- Phase two is only as good as having both exports. A counterparty that refuses to
  export cannot be forced by a verifier; what the joint replay proves then is exactly
  what phase one proves — *whose* story is complete — which is the honest maximum.

**Revisit triggers**

| Trigger | Reconsider |
|---|---|
| P5 shared hubs (three-plus domains, hub-relayed traffic) | Whether the join scales as pairwise cross-checks or needs the hub's own export as a third domain |
| An `afp:BoundaryDigest` in an export | Whether the boundary log root becomes a required phase-two input, per ADR-0008's trigger |
| A scoped export needs to hide *count* | The aggregate-stub debate reopens — with the launderer objection on the table from the start |

## Build status

Nothing is built. The staging mirrors the decisions' dependency: stubs first (phase one
must survive them before a join means anything), then the partition, then the join.

| ID | Task | Stage |
|---|---|---|
| **V1** ✅ | Redaction stubs in `exportBundle` (scope option: threads / visibility floor / agreement); stub-aware `check_chain` + monotonicity bracketing | 1 |
| **V2** ✅ | `afp:exportScope` in the manifest; scoped completeness (declared omissions vs silent holes) | 1 |
| **V3** ✅ | Partitioned `build_authority` over an export set; agreement digest-equality; domain-labelled findings | 2 |
| **V4** ✅ | Cross-export resolution: received-bytes digest match, divergence and absence findings with attribution | 2 |
| **V5** ✅ | The joint entry point (`afp_verify.py` accepting multiple exports, or a thin `fed_verify.py` orchestrating phase one per export + phase two) | 2 |
| **V6** ✅ | Gate: the two-instance flow of `test/adr0008.test.ts` extended to export both sides and joint-verify — clean pass, then mutations: forged counterparty actor doc (partition catches), re-signed received activity (divergence), silent gap vs stubbed gap (deletion fails, discretion passes), mismatched agreement objects | 2 |
| **V7** — | Parity cases: none needed — no shared derivation exists (see the note above); covered by V6's mutations | — |

## References

- [Scenario 08 — the subcontract](../scenarios/08-the-subcontract.md) findings 29a/29b,
  and [the outside-in telling](../scenarios/08-the-subcontract-story.md) — the "person
  with two folders" this ADR retires
- [ADR-0008](0008-p4-federation-stack.md) — the boundary this replay audits, and the
  refusal that kept these decisions whole
- [ADR-0007](0007-supersession.md) — "an edge, never an erasure," inherited here as
  "a view, never a mutation"
