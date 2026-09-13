# ADR-0023 — The loose ends, triaged: what twenty-two ADRs left open, and what closes each

- **Status:** Proposed (2026-09-02) — a plan, not a design. Every item below already has
  its design in the ADR it links to, or is a decision that ADR declined to take. Nothing is
  built *by* this ADR; a subtask closes only when this ledger names the commit or ADR that
  closed it (see [Closing protocol](#3-closing-protocol-strike-through-never-delete)).
  The rows this ledger marks **build** and **decide** are sequenced by the
  road-to-production program, [ADR-0024](0024-the-road-to-production.md) Decision 5
- **Date:** 2026-09-02
- **Applies to:** the whole record — `src/instance`, `src/verifier`, the spec chapters, and
  the ADRs themselves
- **Builds on:** every ADR from [0001](0001-p1-stack.md) to
  [0022](0022-the-summary-declares-its-frame.md); each subtask names its origin
- **Driven by:** the 2026-09-02 audit of the ADRs for unfinished work, run after the v3.33
  sync: every status line, deferred decision, revisit-trigger table, open question and
  build-status row, cross-checked against the code where a claim could be checked

## Context

Twenty-two ADRs, twenty-one of them "built". Read as a set, they still carry four kinds of
loose end, and the audit that produced this ledger found every kind:

1. **Specified, not built.** A decision the ADR states in full and the code does not have —
   the visibility-floor and agreement-grant export scopes ([ADR-0009](0009-federated-replay.md)
   Decision 4), the Mastodon-facing half of P4 ([ADR-0008](0008-p4-federation-stack.md)
   Decision 6), periodic anti-entropy ([ADR-0002](0002-p2-hub-and-crdt-stack.md) Decision 5).
2. **Declined or left open on purpose.** Questions an ADR recorded rather than guessed at —
   six of [ADR-0021](0021-conviction-to-consequence.md)'s nine, the governance-action
   dispositions [ADR-0019](0019-acting-on-a-decision.md) calls "a real gap", the seat-policy
   default flip the [D4 execution plan](0017-d4-execution-plan.md) scheduled for "next phase".
3. **Revisit triggers that fired and were never revisited.** Three ADRs named "P5" as the
   condition to reopen a decision; P5 has been built since 2026-08-21, and no document
   records whether the decision was reopened.
4. **Prose that outlived its build.** A build-status section that still opens with "Nothing
   is built" above a table of checkmarks; a sentence promising Fedify at P4 in the same file
   as the amendment that retired it.

The repository already has the rule that covers this: *a blocker that quietly disappears
teaches a later reader nothing.* It has been applied inside ADRs and in the roadmap's
"what blocked Px" sections; it has never been applied across the ADRs as a set. That is
what this ledger is for. It is deliberately one file, so the question "what did the record
leave open" has one answer, and deliberately not a design, so it never competes with the
ADR that owns each item.

**What was verified rather than read.** Where the audit could check a claim against the
code it did: `afp:keyHistory` collects instance, agent and hub-actor keys and nothing else
(`src/instance/src/export.ts`); the export accepts a thread-set scope and no other
(`ExportScope` in the same file); `shadowNote`, `parseCommand` and `politeReply` exist in
`src/instance/src/federation/visibility.ts` and have no callers; the hub's `seatPolicy`
default is still `enroll-implies-seat` (`src/instance/src/hub/hub.ts`); no floor rule
exists for an electorate emptied by recusal; the store is `node:sqlite`; the critique's 19
findings all read `fixed-*` or `accepted-deviation`. Items the audit could not check are
marked as such in their rows.

## Decisions

### 1. One ledger, four dispositions

Every subtask carries an id (`L1`…), the origin section it links to, what it touches, what
"done" looks like, a size, and exactly one disposition:

| Disposition | Meaning | Closes by |
|---|---|---|
| **build** | The design exists; the code, verifier or document does not | A commit, gated |
| **decide** | The origin ADR declined the decision; someone must take it | An ADR or an amendment to the origin ADR, then possibly a build |
| **reconcile** | The record disagrees with itself or with the code | A commit editing the origin text, no code |
| **park** | Correctly deferred behind a named trigger; no work until it fires | Nothing — the row records the trigger so it stops being invisible |

A `park` row is not a backlog item. It exists so that the next reader can tell "deferred
with a trigger" from "forgotten", which the audit could not do without reading every ADR.

### 2. Order: integrity first, then the record's own honesty, then the shop window

The three items that touch what a replay can prove go first (L1, L2, L3). The items that
make the record contradict itself go second, because they are cheap and because every
later reader pays for them (L6–L14). The Mastodon-facing wiring and the scheduler go third:
they are real work the roadmap promised, and nothing checkable depends on them (L15–L20).
Parked items stay parked (L21–L31).

### 3. Closing protocol: strike through, never delete

A subtask closes only by a reference this file can carry: `~~L-nn~~ **closed** — commit
`abc1234` / ADR-00nn Decision k`. The row stays. A fired trigger is additionally recorded
**in the origin ADR**, as one line under its revisit table — "*Fired at P5; outcome: …*" —
so the origin keeps its own history and this ledger is never the only place the outcome
lives.

### 4. What this ADR does not do

It does not decide any of the `decide` rows; each names the ADR or amendment that should.
It does not reopen anything an origin ADR rejected under "Options considered" — those are
closed, and the audit skipped them on purpose. And it does not touch
[ADR-0017](0017-standards-conformance.md) Decision 8: the FEP is deferred by the operator's
choice, recorded as such, and this ledger records it the same way.

## The ledger

### Track A — Integrity: what a replay can prove

| ID | Origin | What is open | Touches | Done when | Size | Disposition |
|---|---|---|---|---|---|---|
| **L1** | [ADR-0021 § Open questions](0021-conviction-to-consequence.md#open-questions--resolve-before-or-during-implementation) Q7; [ADR-0012](0012-the-long-horizon.md) Decision 1 | Per-agent hub-scoped keys (`<agent>--hub-<id>`) and transport keys (`<agent>--transport`) are outside `afp:keyHistory`, so a compromised one can be neither recorded nor interval-checked. Verified: `collectKeyHistory` in `src/instance/src/export.ts` walks the instance key, each agent's P1 key and each hub actor's keys | `src/instance/src/export.ts`, `src/instance/src/crypto/keys.ts`, `src/verifier/keys.py`, `test/adr0012.test.ts` | Every `verificationMethod` that signed an activity in the bundle appears in `afp:keyHistory` with its interval; a hub-scoped key revoked with a backdated cut fails `check_key_intervals` by name (V14 reach); a mutation gate proves it. Recorded as an amendment to ADR-0012, which ADR-0021 Q7 says is where it belongs | M | **part-closed** — [ADR-0026](0026-key-custody-and-the-signer-port.md) Decision 3 (2026-09-04): `allKeyHistories` walks proof, hub-scoped and transport keys, so they are now *recorded* with their intervals; the ordinal convention is shared so rotated keys of any kind get distinct ids. **Still open:** the backdated-cut check cannot fire, because no exported activity is signed by a hub-scoped or transport key — under `instance` custody the instance key signs, including for votes embedded in an `afp:EquivocationProof`. Carrying a hub-scoped signature into a bundle is the remaining work |
| **L2** | [ADR-0009 Decision 4](0009-federated-replay.md#4-redaction-is-an-export-time-transform-that-emits-stubs--the-record-is-never-touched) and Decision 5; [ADR-0010 Decision 5](0010-pinning-without-an-auction.md#5-an-answer-may-not-be-disclosed-without-the-pins-it-was-judged-under) (the "latent" hole) | Only the thread-set scope is built. The visibility-floor and agreement-grant scopes are specified, referenced by ADR-0010 as the place its pin-redaction refusal must also hold, and absent. Verified: `ExportScope` carries `threads` only | `src/instance/src/export.ts`, `src/verifier/afp_verify.py` (`afp:exportScope` reading), `test/adr0009.test.ts` | `exportBundle` accepts a visibility floor and an agreement's grants as scopes; stubs land 1:1 in chain position; `afp:exportScope` declares which; a scoped bundle replays clean under each; the ADR-0010 Decision 5 refusal (an answer without its pins) holds under both new scopes | M | **closed** — [ADR-0026](0026-key-custody-and-the-signer-port.md) Decision 5 (2026-09-04): `{ visibilityAtLeast }` and `{ agreement }` join the thread-set scope behind one `inScope` predicate, the manifest declares which produced the bundle, and `federation.py` `check_export_scope` holds a bundle to the scope it claims (over-disclosure is the checkable direction) |
| **L3** | [ADR-0019 § Build status](0019-acting-on-a-decision.md#build-status) ("Not built, deliberately: dispositions over governance actions"); [ADR-0007](0007-supersession.md); [ADR-0011](0011-supersession-meets-the-irreversible-world.md) | `afp:disposes` and `annotate` are specified over a superseded *Synthesis*. A superseded *decision* has no supersession mechanism, so an action taken on a DecisionRecord that later proves wrong has no disposition duty. ADR-0018's `afp:Departure` records refusal, not retraction | A scenario first (the standing pattern: 10, 12 and 13 all walked before their ADR), then a stack ADR | An ADR exists that either specifies how a `DecisionRecord` is superseded — by a later round naming it, with ratification parity and the disposition duty extended to its actuations — or records why a decision is never retracted, only re-decided. Its gate mirrors ADR-0007's | L | **decide** → its own campaign |
| **L4** | [ADR-0021 § Open questions](0021-conviction-to-consequence.md#open-questions--resolve-before-or-during-implementation) Q3; [ADR-0021 Decision 3](0021-conviction-to-consequence.md#3-recusal-declared-caused-and-the-denominator-moves-because-the-snapshot-moved) | Nothing says what happens when recusal empties the electorate, or drops it below where the pinned quorum form is meaningful. Verified: no floor rule in `proposeRound` | `src/instance/src/hub/hub.ts` (`proposeRound`), `src/verifier/decision.py` (V4), `test/adr0021.test.ts` | One of three is ruled and built: a floor rule that refuses to open the round, a named `afp:noDecisionReason` (`electorate-exhausted`) that closes it, or a recorded ruling that nothing is needed and why. The verifier recomputes whichever is chosen | S–M | **built (ADR-0033)** — `afp:governance.afp:electorateFloor`: `refuse` or `no-decision:electorate-exhausted`, both, per deployment; `hub/governance.ts`'s `electorateExhausted`, `decision.py`'s `electorate_exhausted` |
| **L5** | [ADR-0021 § Open questions](0021-conviction-to-consequence.md#open-questions--resolve-before-or-during-implementation) Q2 | Any proposer may pin `afp:governanceSubject`. Whether "convene a round about you" needs a precondition — a proof or a dispute on the record — so it is not itself a harassment primitive | `src/instance/src/hub/hub.ts` (`proposeRound`), `src/verifier/decision.py` (`check_proposal_electorate`), ADR-0021 amendment | An amendment to ADR-0021 states the precondition and the verifier checks it, or states that any proposer may and why the record's attributability is enough | S decide, S build | **built (ADR-0033)** — `afp:governance.afp:subjectPrecondition`: `any-member` (default) or `proof-or-dispute-on-record`, checked at `Hub.proposeRound` and recomputed by `check_policy`'s `_check_governance_subject` |

### Track B — The record agreeing with itself

| ID | Origin | What is open | Touches | Done when | Size | Disposition |
|---|---|---|---|---|---|---|
| **L6** | [ADR-0009 § Build status](0009-federated-replay.md#build-status) | Opens with "Nothing is built. The staging mirrors the decisions' dependency" above a table in which every row is checked | `docs/afp/adr/0009-federated-replay.md` | The paragraph states what is built and keeps the staging rationale as history | S | **reconcile** |
| **L7** | [ADR-0001 § Revised under contact](0001-p1-stack.md#revised-under-contact) | "*This is not a reversal at P4.* Fedify remains the right choice for federation transport" stands in the same file as the ADR-0017 amendment (under [Decision 3](0001-p1-stack.md#3-activitypub-layer-fedify-adopted-at-p1-despite-barely-using-it)) that re-scoped Fedify to an interop oracle | `docs/afp/adr/0001-p1-stack.md` | The P4 sentence is struck through with a pointer to the amendment | S | **reconcile** |
| **L8** | [ADR-0001 § Consequences](0001-p1-stack.md#consequences), revisit trigger "P5 multi-hub cross-operator sync → Decision 4, SQLite → Postgres" | The trigger fired when P5 was built (2026-08-21). The store is still `node:sqlite`; no document says the decision was reopened or why it held | `docs/afp/adr/0001-p1-stack.md` (one line under the table); optionally [ADR-0016](0016-p5-transport.md) | The origin table carries "*Fired at P5; outcome:* …" with the reason SQLite held — P5's sync carries activities rather than shared state, and the file-copy export property survives | S | **built** — the "*Fired at P5; outcome:*" line is now under [ADR-0001's revisit-trigger table](0001-p1-stack.md#consequences) |
| **L9** | [ADR-0004 § Consequences](0004-solo-foundation-hardening.md#consequences), revisit trigger "Cross-hub asset reference at P5 → whether the registry needs a resolution protocol beyond digest equality" | Fired at P5; no later ADR mentions it. Not verified either way whether any P5+ workload references an asset across hubs | `docs/afp/adr/0004-solo-foundation-hardening.md`; possibly [ADR-0014](0014-p5-shared-hub-stack.md) | Either "fired; no cross-hub reference has occurred; digest equality stands until one does", recorded, or a small decision on resolution | S | **decide** (small), then record |
| **L10** | [ADR-0010 § Consequences](0010-pinning-without-an-auction.md#consequences), revisit trigger "P5 cross-operator direct delegation → whether the counterparty must countersign pins that bind *its* actuator" | Fired at P5; [ADR-0019](0019-acting-on-a-decision.md) settled who may act but not whether a foreign actuator consents to the pins that bind it | `docs/afp/adr/0010-pinning-without-an-auction.md`; ADR-0019 amendment if a rule is added | A ruling: enrollment under a hub whose proposals carry pins *is* consent, or a countersign is required for direct (hubless) delegation — recorded under the origin table, built if the second | S decide, M if build | **decide** |
| **L11** | [ADR-0010 § Build status](0010-pinning-without-an-auction.md#build-status) ("two prose statements go stale", "spec sweep once built"); [ADR-0002 § Consequences](0002-p2-hub-and-crdt-stack.md#consequences) ("the `(actorId, hubId?)` key-store extension is a P1 schema migration") | All done — `action.py`'s docstring cites ADR-0010, ADR-0006 Decision 1 carries the amendment pointer, 03 has the pin rows, `crypto/keys.ts` has the hub-scoped store — and none is marked done where it was promised | The two origin ADRs | Each promise carries its "done, see …" | S | **reconcile** |
| **L12** | [ADR-0009 § Consequences](0009-federated-replay.md#consequences), revisit trigger "P5 shared hubs → whether the join scales as pairwise cross-checks" | Answered by [ADR-0015](0015-the-case-file-at-n-parties.md) Decision 1 (all-pairs at N=3, with a spanning-join trigger of its own); ADR-0009 does not say so | `docs/afp/adr/0009-federated-replay.md` | One line under the table | S | **reconcile** |
| **L13** | [ADR-0017 Decision 7](0017-standards-conformance.md#7-the-prose-is-reconciled-where-the-adrs-moved); [ADR-0017 § Consequences](0017-standards-conformance.md#consequences) ("Key custody language in 01 needs a pass") | Two of Decision 7's items are still open. The "same trust model as WebFinger" analogy Decision 7 says it corrects still stands in [01 § Proving membership](../01-foundations.md) and in the HTML rendition; 01's key-custody paragraph says nothing about the second keypair per actor (third with the shim) | `docs/afp/01-foundations.md`, `docs/afp/agent-federation-protocol.html`, `docs/afp/adr/0017-standards-conformance.md` | Both sentences corrected; Decision 7 marked built in the status line | S | **reconcile** |
| **L14** | [ADR-0017 § Consequences](0017-standards-conformance.md#consequences) ("a behavior change to enrollment that needs its own migration note in 02 and a scenario") | The 02 migration note exists; no scenario walks the Follow/Accept seat change. Scenario 08 predates it | `docs/afp/scenarios/` (a new walkthrough — scenarios are never rewritten) | A scenario walks an instance's seat from Follow to `Undo{Follow}` and back, under both seat policies, and its findings (if any) are triaged | M | **built (ADR-0030)** — [scenario 14 — the seat migration](../scenarios/14-the-seat-migration.md), findings 84–89; the default-flip half (finding 87) stays open for ADR-0032 Decision 6 |
| **L15** | [ADR-0022 § W1](0022-the-summary-declares-its-frame.md#w1-wire-schemas) | The frame example carries `afp:hubs` in `afp:inputScope`; the builder emits `afp:visibility` only. Verified in `hub/summary.ts` | `docs/afp/adr/0022-the-summary-declares-its-frame.md` or `src/instance/src/hub/summary.ts` | Either the example loses `afp:hubs` or the builder gains it with a verifier check | S | **reconcile** |

### Track C — The shop window: P4b wiring and the scheduler

| ID | Origin | What is open | Touches | Done when | Size | Disposition |
|---|---|---|---|---|---|---|
| **L16** | [ADR-0008 Decision 6](0008-p4-federation-stack.md#6-build-staging-the-trust-core-first-the-shop-window-second), row F8 (marked built); 04 § Dual-publish | `shadowNote` builds a `Create{Note}` representation and nothing calls it. No operator-visible event is dual-published; a Mastodon account following an agent sees nothing. The instance README says so ("Mastodon visibility: not yet"); ADR-0008's build row does not | `src/instance/src/instance.ts` (outbox emit), `src/instance/src/federation/visibility.ts`, `src/instance/src/ap/server.ts` (followers collection), a gate | Every event the spec lists as operator-visible emits a `public` shadow Note to followers carrying the chain head and a link to the machine activity; a gate proves a `parties` payload never leaks into a shadow; ADR-0008's F8 row says "representation built; wiring landed in L16" | M | **built (ADR-0029)** — `instance/window.ts`'s `maybeShadow`, behind `AFP_FEDIVERSE_WINDOW`, off by default; G4/G5 in `test/adr0029.test.ts` |
| **L17** | [ADR-0008 Decision 6](0008-p4-federation-stack.md#6-build-staging-the-trust-core-first-the-shop-window-second); 04 § Participation inbound | `parseCommand`, `isAuthorizedController` and `politeReply` exist and are not wired into the inbox; `afp:policy`'s `controllers` list is read by nothing | `src/instance/src/inbox.ts`, `src/instance/src/federation/visibility.ts`, the policy document | An inbound `Create{Note}` mention from an authorized controller executes one of the three grammar forms; an unauthorized or unparseable one gets the fixed polite reply; a gate proves no other path parses stranger text. Ordered **after** L16 — 04 says this half SHOULD NOT be pulled forward | M | **built (ADR-0029)** — wired at `POST /agents/:name/command` and at the inbox's `onMention`, both through `ports/command.ts`'s `executeCommand`; G3 in `test/adr0029.test.ts` |
| **L18** | [ADR-0008 Decision 2](0008-p4-federation-stack.md#2-payloads-keep-the-one-signature-suite-the-hop-gets-http-signatures) (the recorded RSA wart); [ADR-0017 § Revisit triggers](0017-standards-conformance.md#revisit-triggers) | Delivering a shadow Note to a real Mastodon inbox needs an RSA keypair per actor and the draft-cavage shim on that path. Not built; recorded as a wart in both ADRs | — | Trigger: a real Mastodon follower is wanted. Counter-trigger already recorded: Mastodon drops draft-cavage → delete the shim instead | — | **park** |
| **L19** | [ADR-0017 D4 execution plan § Pre-decided calls](0017-d4-execution-plan.md#pre-decided-architecture-calls-executors-must-not-revisit-these), R2 ("default flip is a later, separate change with its own 02 note") | The hub's `seatPolicy` default is still `enroll-implies-seat`; `follow-required` is the conformant target. Verified in `hub.ts` | `src/instance/src/hub/hub.ts`, every demo's enrollment order, `test/adr0017-d4-follow.test.ts`, `docs/afp/02-hubs-and-state.md` (the migration note) | Default flipped; every demo Follows before it Enrolls; the 02 note says the flip happened and names the revision | S–M | **built (ADR-0032)** |
| **L20** | [ADR-0002 Decision 5](0002-p2-hub-and-crdt-stack.md#5-gossip--anti-entropy-deferred-until-its-needed); [ADR-0016 Decision 4](0016-p5-transport.md#4-the-digest-is-the-version-vector-made-answerable-by-provenance); 02 § Gossip & anti-entropy | The exchange is built and runs when a demo calls `offerSync`. Nothing schedules it, and the rumor-push for urgent changes 02 describes does not exist. The instance README lists "gossip anti-entropy" as not yet done | `src/instance/src/hub/hub.ts` (`offerSync`), `src/instance/src/hub/transport.ts`, a gate over two replicas | Replicas converge on an interval with jitter and no demo call; an urgent change (liveness excluded, per ADR-0016) pushes immediately; the README line comes out | M | **built (ADR-0031)** — `runtime/scheduler.ts`'s `converge` loop; the urgent push is `Hub.pushSync` (not `offerSync`) toward every peer, fired from `Hub.onUrgent`; G3 in `test/adr0031.test.ts` |
| **L21** | [ADR-0008 Decision 3](0008-p4-federation-stack.md#3-the-boundary-gate-leaves-a-trace-it-can-sign) ("an optional periodic `afp:BoundaryDigest` activity") | The payload builder exists; nothing publishes it except the P4 demo's console line. Optional by the ADR's own words, so not a gap until ADR-0009's trigger ("a BoundaryDigest in an export") is wanted | `src/instance/src/federation/federation.ts`, L20's scheduler | Folded into L20's scheduler as an opt-in heartbeat, or left parked | S | **built (ADR-0031)** — folded into the scheduler's `heartbeat` loop, off by default (`AFP_HEARTBEAT_MS=0`); G4 in `test/adr0031.test.ts` |

### Track D — Parked, with the trigger written down

| ID | Origin | Parked item | Trigger that reopens it |
|---|---|---|---|
| **L22** | [ADR-0001 Decision 5](0001-p1-stack.md#5-the-verifier-is-a-second-implementation-in-go-sharing-no-code), [§ Revised under contact](0001-p1-stack.md#revised-under-contact) | The Go verifier port ("stays open and is a small job" — no longer small at fourteen modules); if the trigger fires, the conformance kit ([ADR-0034](0034-release-conformance-and-disclosure.md) Decision 3) is what proves the port | An auditor who cannot run Python; airgapped delivery becoming the primary mode |
| **L23** | [ADR-0001 § Consequences](0001-p1-stack.md#consequences) | Single-binary instance (`bun build --compile` or a Go rewrite) | Airgapped deployment becomes the primary delivery mode |
| **L24** | [ADR-0016 Decision 4](0016-p5-transport.md#4-the-digest-is-the-version-vector-made-answerable-by-provenance) | `afp:merkleRoot` — specified, deferred, emitted by nothing | A hub-scoped store large enough that the version vector is the expensive part of the exchange |
| **L25** | [ADR-0016 § Consequences](0016-p5-transport.md#consequences) | A windowing rule for a replica behind by more than one exchange can carry, and a way to say "partially converged" on the record | A replica that far behind |
| **L26** | [ADR-0010 Decision 1](0010-pinning-without-an-auction.md#1-pins-live-on-the-task-bearing-activity--the-announce-when-there-is-one-the-direct-offertask-when-there-is-not) ("a federated variant would need the boundary log, and does not exist yet") | Pins-precede-answers ordering across actors, via the boundary log rather than `published` | Cross-actor clock skew producing a false ordering failure |
| **L27** | [ADR-0010 Decision 4](0010-pinning-without-an-auction.md#4-every-action-policy-carries-a-non-answer-key--terminality-always-releases-the-actuator) | Coverage-shaped sufficiency in the direct flow (`afp:coverage` on the Result, `minConfidence` beside the sufficiency) | A direct-flow deployment that needs coverage rather than a count |
| **L28** | [ADR-0005 Decision 4](0005-operators-are-equal.md#4-all-three-roles-are-instance-granted-vote-weight-reputation-stays-deferred); [ADR-0004 § Consequences](0004-solo-foundation-hardening.md#consequences) | Vote-weight reputation — deferred with a stated reason (accuracy is not judgement; standing entrenches) | A hub policy that genuinely needs unequal operators, and an answer to entrenchment |
| **L29** | [ADR-0021 § Open questions](0021-conviction-to-consequence.md#open-questions--resolve-before-or-during-implementation) Q9 | `afp:reputationRule` consuming proofs (finding 65's third limb) | The same trigger as L28 |
| **L30** | [ADR-0021 § Open questions](0021-conviction-to-consequence.md#open-questions--resolve-before-or-during-implementation) Q4 and Q8 | Housekeeping: whether V14 lives in `keys.py` beside the other interval checks; whether `afp:role` on an Enroll should follow the emit-on-supply idiom | Whoever builds L1 decides Q4 in passing; Q8 whenever `enroll()` is next touched. Neither blocks anything |
| **L31** | [ADR-0017 Decision 8](0017-standards-conformance.md#8-afp-is-written-up-as-a-fep) and the two registrations under [Decision 5](0017-standards-conformance.md#5-namespace-hygiene) | The FEP, the `.well-known/afp-policy` and `afp-membership-proof` registrations, and the context URL's permanence | The operator's call, and nobody else's. Recorded here only so the list is complete |

The remaining revisit triggers in ADRs 0002–0016 — a fifth CRDT type, a bottlenecked
in-process hub, a rule the selection registry cannot express, a chain of supersessions, a
regulator rejecting `annotate`, post-quantum migration, hub-hosting moving mid-life, a hub
archived under partition, a consortium too large for all-pairs — have **not** fired and
need no row: their origin tables already say what reopens them.

## Traceability — by origin ADR

| Origin | Subtasks |
|---|---|
| [ADR-0001](0001-p1-stack.md) | L7, L8, L22, L23 |
| [ADR-0002](0002-p2-hub-and-crdt-stack.md) | L11, L20 |
| [ADR-0004](0004-solo-foundation-hardening.md) | L9, L28 |
| [ADR-0005](0005-operators-are-equal.md) | L28 |
| [ADR-0007](0007-supersession.md) | L3 |
| [ADR-0008](0008-p4-federation-stack.md) | L16, L17, L18, L21 |
| [ADR-0009](0009-federated-replay.md) | L2, L6, L12 |
| [ADR-0010](0010-pinning-without-an-auction.md) | L2, L10, L11, L26, L27 |
| [ADR-0011](0011-supersession-meets-the-irreversible-world.md) | L3 |
| [ADR-0012](0012-the-long-horizon.md) | L1 |
| [ADR-0015](0015-the-case-file-at-n-parties.md) | L12 |
| [ADR-0016](0016-p5-transport.md) | L8, L20, L24, L25 |
| [ADR-0017](0017-standards-conformance.md) and its [D4 plan](0017-d4-execution-plan.md) | L13, L14, L18, L19, L31 |
| [ADR-0019](0019-acting-on-a-decision.md) | L3, L10 |
| [ADR-0021](0021-conviction-to-consequence.md) | L1, L4, L5, L29, L30 |
| [ADR-0022](0022-the-summary-declares-its-frame.md) | L15 |

ADRs 0003, 0006, 0013, 0014, 0018 and 0020 carry no open subtask: their deferrals were
closed by a later ADR that says so in the origin, or their triggers have not fired.

## Options considered

| Option | Rejected because |
|---|---|
| Fix the reconciliations silently, in the sync commits | The audit found them precisely because earlier fixes were silent; a ledger that names them is the mechanism, not overhead |
| One issue per subtask in a tracker | The ADRs are the tracker this repository has chosen; an external list would drift from them the way the vocabulary table drifted from the code |
| Decide the `decide` rows here | Each is a design question with its own scenario shape (L3 especially); deciding them in a plan ADR would be the "specifying policy ahead of evidence" the pre-v3.6 roadmap rotted on |
| Drop the `park` track as noise | Without it the next audit repeats the work of telling "deferred with a trigger" from "forgotten" |

## Consequences

**Positive** — the question "what did twenty-two ADRs leave open" has one answer, every
answer points back at the text that owns it, and three revisit triggers that fired in
August stop being invisible. The integrity items are small and sharply gated; none of them
changes a shipped bundle's pass status until it lands.

**Negative** — another document to keep true. Mitigated by the closing protocol: a row
closes with a reference or not at all, and a fired trigger is recorded in the origin as
well, so this file can be stale without the origin being wrong.

**Accepted** — L3 is a campaign, not a subtask, and this ledger says so rather than
pretending a row can hold it.

## Order of work

1. **Slice 1 — an afternoon.** L6, L7, L8, L11, L12, L13, L15: the reconciliations. No
   code, no gate changes; the record stops contradicting itself.
2. **Slice 2 — integrity.** L1 as an ADR-0012 amendment with its mutation gate; then L2.
3. **Slice 3 — the small decisions.** L4, L5, L9, L10, L19, each an amendment paragraph in
   its origin and, where ruled so, a small build.
4. **Slice 4 — the shop window.** L16, then L17, then L20 (with L21 folded in if wanted).
5. **L3** gets a scenario and its own ADR, in the pattern every phase since P5 has used.
6. **L14** whenever scenario-writing capacity exists; it depends on nothing.

## Build status

First movement 2026-09-04, both by [ADR-0026](0026-key-custody-and-the-signer-port.md):
**L2** (the two unbuilt export scopes) is **closed** by its Decision 5. **L1**
(hub-scoped and transport keys outside `afp:keyHistory`) is *part-closed* by its
Decision 3 — the keys are recorded; the interval check that row also asks for cannot
fire until a hub-scoped signature actually travels in a bundle. Every other row above
is open.

| Slice | Rows | State |
|---|---|---|
| 1 | L6 L7 L11 L12 L13 L15; **L8 built** | open (L8 closed) |
| 2 | L1 L2 | open |
| 3 | L4 L5 L9 L10; **L19 built (ADR-0032)** | open |
| 4 | **L16 L17 L20 (L21) built (ADR-0029/0031)** | closed |
| campaign | L3 | open |
| docs | **L14 built (ADR-0030)** | closed |
| parked | L18 L22–L31 | parked, triggers recorded |

## References

- Every origin ADR linked above, at the section named.
- [05 § Open questions](../05-roadmap.md#open-questions) — the protocol's two standing
  questions, which are not loose ends and are not repeated here.
- [`src/instance/README.md` § What this instance deliberately does not do yet](../../../src/instance/README.md)
  — the two items it names (gossip anti-entropy, Mastodon visibility) are L20 and L16/L17.
- `docs/critique-standards-deviation.md` — all 19 findings closed; the source of ADR-0017
  Decision 7's remaining prose items (L13).
