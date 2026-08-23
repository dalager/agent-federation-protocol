# ADR-0020 — The round under fire: a predicate, a succession, an early close, and a searchlight

- **Status:** Accepted, and **built** (2026-08-22) — gated by `test/adr0020.test.ts`
  (14 cases, the W5 matrix), full suite green at 197, every shipped bundle replaying
  with unchanged pass status, and the P6 demo (`npm run demo:p6`, `demo:p6:llm`) running
  scenario 12's beats 3-5 across five instances. This is the P6 stack ADR in the P2/P3/P4/P5 convention —
  and the first stack ADR written *after* its phase's shakedown scenario instead of
  before it, which is the order the roadmap has been recommending to itself since
  campaign 6
- **Date:** 2026-08-22
- **Applies to:** every hub running L1 — which, per the roadmap's own trigger, is every
  hub where ≥2 operators live. A solo or single-operator hub stays at L0 and nothing
  here reaches it
- **Builds on:** [ADR-0002](0002-p2-hub-and-crdt-stack.md) (the L0 round this hardens),
  [ADR-0005](0005-operators-are-equal.md) (the weights every threshold below is computed
  over), [ADR-0014](0014-p5-shared-hub-stack.md) (the hub as sequencing authority, and
  `afp:uncounted`), [ADR-0015](0015-the-case-file-at-n-parties.md) (the all-pairs join
  Decision 5 extends one check), [ADR-0018](0018-the-round-as-a-commitment.md) (the
  pinning discipline Decisions 3 and 4 apply to two more facts, and the
  `afp:no-decision` terminal Decision 4 gives a third reason)
- **Driven by:** [scenario 12 / campaign 9](../scenarios/README.md#campaign-9--built-scenario-12-the-p6-shakedown),
  findings 58, 60, 61, 62 — the half of the campaign that changes how the round itself
  behaves; findings 59, 63, 64, 65 are triaged to the ADR-0005 amendment and ADR-0021
  and are **not** decided here

## Context

P6's roadmap row has four nouns — chained signed votes, `afp:EquivocationProof`,
snapshot-pinned membership, governance rollup — and 03 § Consensus hardening specifies
them well enough that scenario 12's cryptography *held end to end* before a line of P6
code exists: the anti-entropy catches the equivocator, the proof convinces a stranger,
zeroing needs no coordination, safety survives. What the scenario broke was everything
at the edges of that specification, and all four of this ADR's findings are edges of the
same shape — **a sentence of prose doing a job that everywhere else in this protocol is
done by a pinned, recomputable rule:**

- **What equivocation *is*** is answered twice, incompatibly: the prose convicts on
  same `(voter, round, seqNo)` with *different value*, the diagram's cross-check fires
  on *different hash*. An honest node that restores from backup and re-votes the same
  value with a grown `afp:observedVotes` set is convicted under one reading; an
  equivocator who varies *only* its observed-set — partitioning the mesh's causal view
  while keeping the value constant — escapes under the other (finding 58). The boundary
  between an incident and a sanction is currently a discrepancy between a paragraph and
  a picture.
- **Who inherits a stalled round** is *"the highest-reputation live replica"* — computed
  from nothing pinned, checked by no replay, excluding nobody, not even the voter whose
  proof stalled the round. And since ADR-0018/0019 the proposal carries the deadline,
  the bar, the binding, the electorate, the action policy and the irrevocability
  declaration: the right to open a round is the most consequential grant in the
  protocol, handed out by an unrecomputable popularity metric (finding 62). This is the
  only finding in the campaign that makes an attack *cheaper* as the spec stands —
  stalls can be manufactured, and each one is a lottery ticket for the throne.
- **A doomed round and a pending one are the same record.** Proof-triggered zeroing
  (and plain death) can push the reachable weight below ADR-0018's pinned bar with the
  deadline days away; the arithmetic of impossibility is on the record from the moment
  the proof lands, and nothing may act on it until the clock runs out the theatre
  (finding 60).
- **Completing a proof is voluntary, and concealment is invisible** — each half of an
  equivocation pair can sit in a different domain's received-bytes record, held by a
  party the equivocation favours, and a round can close on votes a member privately
  knew to be equivocal. The evidence is *already in the joint case file*; ADR-0015's
  all-pairs join carries both copies and does not look (finding 61).

One more thing belongs in this ADR because building L1 without deciding it would decide
it by accident: 03 says every L1 vote carries *"a detached signature over the whole vote
object"*. This repository has been here before — finding 27 was exactly this, a second
signature vocabulary drifting beside the one suite — and ADR-0008 ruled it once already
for the boundary. It is ruled the same way here before the drift compiles.

## Decisions

### 1. L1 lands on the machinery that exists — one signature suite, self-contained proofs, a policy trigger

The base stack, deciding P6's four nouns into the reference implementation:

- **The L1 vote's signature is the object integrity proof it already has.** 03's
  "detached signature" wording is corrected: an `afp:Vote` is signed exactly as every
  other activity is — one `eddsa-jcs-2022` proof over the object — and that proof is
  what an `afp:EquivocationProof` verifies. No second suite, no detached envelope
  (ADR-0008's ruling, applied one layer down).
- **An `afp:EquivocationProof` embeds both conflicting votes verbatim** — full signed
  objects, not hashes — because its defining property is verifying standalone, in the
  hands of someone who holds nothing else. Its own activity is `Announce`, `hub`
  visibility, on the round's thread.
- **Zeroing is agent-scoped and forward-scoped.** On verifying a proof, a receiver
  zeroes the convicted voter's weight for the proof's round and every later round in
  that hub — never retroactively re-tallying closed rounds, whose DecisionRecords are
  signed history. Instance-level consequences go to the governance rollup, unchanged.
- **Activation is hub policy with the roadmap's trigger as the default:** a hub whose
  enrolled members span ≥2 operators runs its rounds at L1. The proposal states its
  level (`afp:level: 1`), pinned like everything else on it, so a replay knows which
  round grammar to demand.

### 2. The equivocation predicate: values convict, state loss has a lawful shape

**Conviction requires contradiction, not duplication.** Two signed votes are an
equivocation pair if and only if they share `(actor, afp:round, afp:phase, afp:seqNo)`
and differ in **`value` or `afp:proposalHash`**. The diagram's "different hash"
cross-check is corrected to match — the prose wins, as it did in ADR-0018 Decision 2.

A same-tuple pair that agrees on both is **not proof material**. It is a
**state-loss event** with a defined, compliant shape:

- Receivers count the **first-seen** vote and discard the duplicate — which is nothing
  new; it is transport dedupe's rule applied at the tuple grain instead of the
  activity-id grain.
- A voter that knows it has lost state (a restore from backup) MUST NOT re-sign at a
  `seqNo` it may already have used. Its lawful move is to **re-vote at a `seqNo`
  strictly greater than any of its own votes it can observe** — its peers'
  `afp:observedVotes` sets, which anti-entropy already delivers, tell it exactly that.
  A later `seqNo` from the same voter in the same phase supersedes its earlier vote for
  tallying (the chain grammar already implies this; it is now stated), so the recovered
  node loses nothing but its amnesia.
- The observed-set attack the loose reading invited is closed from the other side:
  because `afp:observedVotes` differences alone can never convict, they also can never
  *count twice* — the tuple, not the hash, is the unit of ballot identity everywhere.

This is the decision that makes scenario 12's beat 5 an incident instead of a sanction,
and it must be settled before any demo exists: a demo that cannot tell the
backup-restore from the equivocator is gating the wrong thing.

### 3. The proposal pins its own succession

The view-change sentence is deleted from 03 and replaced by a pinned, recomputable rule,
under exactly the discipline ADR-0018 applied to the deadline and the bar:

- `afp:Proposal` (at L1) carries **`afp:successionRule`** — an object with a closed
  registry of forms, of which v1 defines one: **`snapshot-order`** — the pinned
  `afp:voters` list, in its declared order, rotated to start after the stalled round's
  proposer, **skipping any voter with an on-record `EquivocationProof` for that round
  and any voter recorded `silent` in it**. The first survivor is the successor; the
  next, if the successor's fresh round itself stalls; and so on. Deterministic,
  computed from the proposal and the record alone, no reputation, no liveness oracle.
- A fresh round claiming a stalled one carries **`afp:supersedesRound`** naming it by
  digest. Replay recomputes the successor from the stalled round's own record and
  **fails a fresh round whose proposer is not the entitled successor** — a usurped
  proposal is a named replay failure, not a fact on the ground.
- `afp:successionRule` is optional with a visible absence, per ADR-0018's pattern: no
  rule means no sanctioned succession — a stalled round simply expires `no-decision`
  and anyone may open an unrelated new round that inherits nothing and supersedes
  nothing. What no deployment gets is succession *without* a rule: `afp:supersedesRound`
  on a round whose predecessor pinned no rule fails replay.

The stakes are stated plainly in 03 where the old sentence was: since ADR-0018/0019 the
proposal is the protocol's most consequential object, and the right to open one in an
existing round's name is therefore governed like everything else that matters — by a
rule pinned before the fight starts.

### 4. A provably doomed round is closeable, now

`afp:noDecisionReason` (ADR-0018 Decision 2) gains a third value: **`quorum-impossible`**.

The arithmetic, integer-only and recomputable from the record alone:

```
attainable(option) = tally[option]
                   + Σ weight(v) for pinned voters v with:
                        no counted vote in this round, and
                        no on-record EquivocationProof for this round
doomed  ⇔  for every option o: attainable(o) < bar
```

When `doomed` holds, the hub MAY close the round immediately —
`no-decision(quorum-impossible)` — and MUST close it so on any member's demand; the
deadline no longer buys anything but delay. The verifier recomputes `doomed` from the
pinned weights, the counted votes and the proofs in the bundle, and fails a
`quorum-impossible` close whose arithmetic does not hold — and, symmetrically, does
**not** fail a hub for closing `expired` at the deadline instead: early close is a
right, not a duty, until a member demands it.

One boundary is drawn deliberately, because findings 60 and 64 will otherwise grow two
weight rules where one should do: zeroed weight **still counts in `T`**, the bar's
denominator, exactly as a silent seat's does (ADR-0018 W2 — the pinned total is the
pinned total). Zeroing removes a voter's ability to *cast*, never the electorate the
rule was computed over; shrinking the electorate itself is a recusal/exclusion question
and belongs to ADR-0021 and the ADR-0005 amendment, which MUST resolve it the same way
for declared exclusions as this decision does for cryptographic ones: **the denominator
moves only when the snapshot does.**

### 5. Concealment fails replay, so announcement is a duty with teeth

Two halves, in the order that makes the second enforceable:

- **The searchlight.** The joint replay (ADR-0009/0015) gains a cross-domain scan: over
  every `afp:Vote` present in any bundle — outbox or received-bytes record — group by
  `(actor, round, phase, seqNo)` and test Decision 2's predicate on each group. A
  conviction pair with **no corresponding `afp:EquivocationProof` on any domain's
  record fails the joint replay by name**, attributing the silence to every domain
  whose bundle held a half. This is ADR-0015's all-pairs machinery extended one check:
  the join already resolves every received byte against its sender; it now also reads
  what it resolved. A concealed equivocation becomes exactly as detectable as a
  two-story agreement, from the case file alone, with no goodwill required.
- **The duty.** A party holding both halves of a conviction pair MUST publish the
  proof; a party holding one half and observing a conflicting digest in anti-entropy
  MUST forward its half to the round's members (a `Create` on the thread — the proof
  needs two, and forwarding is how the second holder becomes able to assemble it).
  Both duties are enforceable only because of the scan — which is why the scan is the
  decision and the duty is its corollary, not the reverse.

The scan runs per round over vote activities only; it is linear in votes held and needs
no pairwise bundle diffing beyond what ADR-0015 already does.

## Options considered

- **Convicting on hash difference** (58): rejected — it criminalizes restoring from
  backup, which at a five-year horizon is every node's future, and it buys nothing:
  the value/proposalHash predicate already catches every pair that could split a tally.
- **A state-loss confession activity** (`afp:StateLossNotice`): rejected as machinery —
  the supersede-by-higher-`seqNo` rule gives recovery a lawful shape with zero new
  vocabulary; a notice can ride in `content` if a deployment wants the courtesy.
- **Reputation-ordered succession, recomputably pinned** (62): rejected — even pinned,
  it aims the throne at whoever farms standing, and scenario 12's Meridian *was* the
  standing leader. Snapshot order is dumb on purpose; dumbness is the security
  property.
- **Making the doomed close mandatory and automatic** (60): rejected — a hub that
  waits for its deadline harms only time, and an automatic close adds a hub-clock
  dependency to a decision members can already force by demand. MAY-plus-MUST-on-demand
  keeps the hub honest without making its clock load-bearing.
- **Shrinking the bar's denominator when a voter is zeroed** (60): rejected explicitly —
  it lets a proof *lower the bar*, which hands an attacker with one captured key the
  power to make a contested round easier to win, and it forks the weight arithmetic
  finding 64's recusal will need. The denominator moves only when the snapshot does.
- **A per-vote countersigning scheme so concealment is impossible rather than
  detectable** (61): rejected — it doubles every round's message complexity to prevent
  something the case file can already convict after the fact, and this protocol's
  standing bet (scenario 08, ADR-0009) is that attributable-after-the-fact beats
  prevented-at-double-cost.

## Consequences

- The four nouns of P6 land with their edges decided instead of discovered: what
  convicts, who inherits, when doom closes, and how silence fails. Every one is a
  pinned or recomputable rule where scenario 12 found a sentence of prose.
- 03 § Consensus hardening is edited three times: the detached-signature wording
  (Decision 1), the cross-check caption in the diagram (Decision 2), and the
  view-change sentence (Decision 3). Each edit replaces prose with a pointer here.
- `afp:no-decision` gains its third reason; ADR-0018's V3/V4 checks extend to it
  mechanically.
- The joint replay gets its first *cross-domain semantic* check — everything before
  Decision 5 cross-checked bytes and manifests; this reads meaning across bundles.
  Worth naming because it will not be the last: finding 63's declared-control merge
  will want the same posture.
- Existing exports replay unchanged: every new property is L1-scoped and every new
  check is conditional on L1 material being present; no shipped bundle contains any.
- The seam left open on purpose: restoration of a zeroed voter, recusal, and proof
  portability are ADR-0021's; the electorate itself moving is the ADR-0005
  amendment's. Decision 4's denominator ruling is the contract both must honour.

## Implementation architecture

Same governing properties as ADR-0018's: **integer arithmetic only**, and
**recomputable from the record alone**.

### W1. Wire schemas

**`afp:Vote` (L1)** — as 03 already draws it, with the signature ruling applied and one
clarification: `afp:observedVotes` entries are activity digests at the same grain as
`afp:countedVotes`.

```jsonc
{
  "type": "afp:Vote",
  "afp:round": "https://windward.example/rounds/dagmar",
  "afp:phase": "prepare",                  // "prepare" | "commit"
  "afp:seqNo": 1,                          // integer ≥ 1, per (voter, round, phase)
  "afp:proposalHash": "sha256:…",
  "afp:quorumSnapshot": "sha256:…",
  "value": "yes",
  "afp:observedVotes": ["sha256:…", "sha256:…"]
  // signed like every other object: one eddsa-jcs-2022 integrity proof
}
```

**`afp:Proposal` (L1) — three new optional properties** beside ADR-0018's:

```jsonc
{
  "afp:level": 1,                                       // NEW — pins the round grammar
  "afp:successionRule": { "afp:form": "snapshot-order" }, // NEW — optional
  "afp:supersedesRound": "sha256:…"                     // NEW — on a successor round only:
                                                        // digest of the stalled proposal ACTIVITY
}
```

**`afp:EquivocationProof`** — `Announce`-carried, both votes verbatim:

```jsonc
{
  "type": "Announce",
  "object": {
    "id": "https://pelican-re.example/proofs/dagmar-meridian-1",
    "type": "afp:EquivocationProof",
    "afp:round": "https://windward.example/rounds/dagmar",
    "afp:votes": [ { /* full signed afp:Vote */ }, { /* full signed afp:Vote */ } ]
  }
}
```

Validity is recomputed, never trusted: same `(actor, round, phase, seqNo)`, both proofs
verify against the actor's published key, and `value` or `afp:proposalHash` differ. A
proof failing any leg is itself a replay failure — a false accusation is worse than
none, and it is signed.

**`afp:DecisionRecord`** — `afp:noDecisionReason` closed set becomes
`expired | threshold-not-met | quorum-impossible`.

### W2. Algorithms

**Ballot identity and tallying (Decision 2):** the counted ballot for `(voter, phase)`
is the voter's highest-`seqNo` vote with valid proof and no conviction; a same-tuple
duplicate agreeing in value and proposalHash is dropped at receive (tuple-grain dedupe,
beside the existing id-grain dedupe, mirroring P1's two layers).

The receiver keeps **one counted ballot per voter** (`hub_vote_receipts`' own primary
key) but remembers the last vote seen **per `(round, voter, phase)`**, because phase is
part of the tuple conviction is decided on. Two consequences, both gated by G11: a vote
from an earlier phase never displaces a later one's counted ballot — a stale or replayed
`prepare` arriving after a `commit` is dropped, not counted — and the earlier phase's
vote survives the round advancing, so an equivocation on it stays convictable instead of
being evicted by the phase change.

**Conviction (Decisions 2, 5):**

```
convicts(a, b) ⇔ a.actor == b.actor && a.round == b.round
              && a.phase == b.phase && a.seqNo == b.seqNo
              && (a.value != b.value || a.proposalHash != b.proposalHash)
              && verify(a) && verify(b)
```

One function, mirrored: TypeScript `src/instance/src/hub/equivocation.ts`, Python
`src/verifier/equivocation.py` — a parity pair like `thresholdOf`/`threshold_of`.

**Successor (Decision 3):**

```
successor(stalled):                       # from the stalled proposal + its round's record
  order    = stalled.voters               # pinned, declared order
  proposer = stalled.activity.actor       # the WIRE actor of the Offer{afp:Proposal} —
                                          # never off-record state (build ruling, 2026-08-22:
                                          # an early draft keyed rotation on a hub-local
                                          # "proposedBy" the record never carries, which the
                                          # verifier could not have recomputed)
  start = proposer in order ? index(proposer, order) + 1
                            : 0           # hub-signed proposals (ADR-0014's normal case):
                                          # rotation starts at the first pinned voter
  for v in rotate(order, start):
      if v has an on-record EquivocationProof in stalled.round: continue
      if v is recorded silent in stalled.round's DecisionRecord: continue
      return v
  return none                             # no sanctioned succession remains
```

**Doom (Decision 4):** as in the decision text; `bar` is ADR-0018's `thresholdOf` over
the **pinned** weights, unchanged.

### W3. Verifier checks

All L1-conditional; names follow the census convention.

| # | Check name | Fails when |
|---|---|---|
| V1 | `vote: {id} L1 fields are well-formed` | an `afp:level: 1` round contains a vote missing phase/seqNo/proposalHash, or `seqNo < 1` |
| V2 | `proof: {id} convicts` (replay-wide, attributed to the announcing domain) | an `afp:EquivocationProof` whose two votes fail any leg of `convicts`, or whose own `afp:round` is not the round its votes were cast in (a genuine pair announced under another round's name would otherwise convict — and, forward-scoped, zero — a voter in a round it never equivocated in) |
| V3 | `{label} tally counts no convicted ballot` | a counted vote's actor has an on-record proof for that round |
| V4 | `{label} tally counts each tuple once` | two counted votes share `(actor, phase, seqNo)` |
| V5 | `{label} quorum-impossible is justified` | reason `quorum-impossible` and the recomputed `doomed` predicate does not hold at close |
| V6 | `round: {id} successor is entitled` | `afp:supersedesRound` present and the proposer ≠ `successor(stalled)`, or the stalled proposal pinned no succession rule |
| V7 | `succession: {id} rule is a known form` | `afp:successionRule` present with a form outside the registry |
| V8 (joint, new) | `equivocation: unannounced conviction pair in round {round}` | the cross-domain scan (Decision 5) finds a conviction pair with no on-record proof **convicting that voter** in any bundle — attributed to every domain holding a half. Keyed by `(round, convicted actor)`, never by round alone: one announced proof excuses the pair it convicts, and buys no concealment for any other pair in the same round |

V8 lives in the joint layer beside ADR-0015's all-pairs checks, and appears in the
per-domain census so a bundle that scanned nothing is visible, per finding 48's rule.

**V2 lives there too, and for a reason the P6 demo found rather than the design did.**
A proof convicts an actor who, in any real consortium, belongs to a *different*
operator: Atlas publishes it, Meridian signed the votes, and Meridian's verification key
is published in Meridian's actor document — that is, in Meridian's bundle. Verifying the
embedded votes against only the announcing bundle's key table therefore fails every
genuine cross-domain proof, which is every proof that matters; the first five-operator
run failed exactly this way. The key table of the whole replay is the right one, and it
resolves the way ADR-0009's received bytes already do — against the domain that owns
them. A single-bundle replay merges one bundle, which is the previous behaviour
unchanged. The finding is still attributed to the domain whose bundle holds the proof,
so `proof:` stays on that domain's census line (finding 48's rule again).

This is worth recording as a class, not a slip: "verifies standalone" was true of the
*proof object* and false of the *replay procedure*, and no unit gate could see the gap
because a unit gate's equivocator lives in the same instance as its accuser. The demo
was the first thing that put the two on opposite sides of a boundary. G14 now holds that
shape at unit cost.

### W4. Work packages

Disjoint ownership, per the standing convention:

| WP | Owns | Content |
|---|---|---|
| **WP-1 · vote chains + proofs** | `src/instance/src/hub/equivocation.ts` (new), `src/instance/src/hub/activities.ts`, `store.ts` | W1 builders, tuple-grain dedupe, `convicts`, zeroing table |
| **WP-2 · round logic** | `src/instance/src/hub/hub.ts` | L1 phases over the existing round machinery, doom check + close reasons, succession on propose, proof handling on receive |
| **WP-3 · verifier** | `src/verifier/equivocation.py` (new), `decision.py`, `afp_verify.py` | V1–V7, the V8 joint scan, `successor`/`doomed` recomputation |
| **WP-4 · gate + spec text** | `src/instance/test/adr0020.test.ts` (new), `docs/afp/03-coordination.md` | W5's matrix; 03's three edits (Decisions 1–3) |

### W5. Gate matrix — `test/adr0020.test.ts`

Every row discriminating; mutations fail *for the named reason*. The demo obligation
from scenario 12 is a row, not an afterthought.

| # | Case | Asserts |
|---|---|---|
| G1 | Five members, L1 round, one scripted equivocator (different `value` to two camps) | proof assembles, verifies standalone, weight zeroed, honest close; replays clean |
| G2 | One scripted backup-restore: same value, grown observed-set, same seqNo | **no proof**; duplicate dropped; re-vote at higher seqNo counted; replays clean — **the finding-58 discriminator, G1's twin** |
| G3 | Mutation: forge a proof from G2's benign pair | verifier fails **V2** |
| G4 | Mutation: splice a convicted voter's ballot into `afp:countedVotes` | verifier fails **V3** |
| G5 | Zeroing makes every option unattainable; a member demands close | `no-decision(quorum-impossible)`; replays clean |
| G6 | Mutation: claim `quorum-impossible` while an option remained attainable | verifier fails **V5** |
| G7 | Stalled round with `snapshot-order`; entitled successor opens the fresh round | `afp:supersedesRound` resolves; replays clean |
| G8 | Mutation: the *convicted* voter opens the successor round | verifier fails **V6** |
| G9 | Concealment: both proof halves present across two bundles, no proof announced | joint replay fails **V8** by name, attributed to both holders |
| G10 | A pre-P6 L0 bundle (every shipped export) | zero new checks fire; check counts unchanged — the compatibility gate, per ADR-0018 G12's rule |
| G11 | A stale `prepare` arrives after the same voter's counted `commit` | the counted ballot does not move backwards through the phases; the earlier phase's vote is still remembered, so an equivocation on it is still convictable |
| G12 | Mutation: a genuine pair announced under a *different* round's name | verifier fails **V2** — the proof's `afp:round` must be the round its votes were cast in |
| G13 | Two conviction pairs in one round; one announced, one concealed across two bundles | joint replay still fails **V8** on the concealed pair, naming its actor — one proof convicts one voter, never a whole round |
| G14 | A proof announced by one domain over votes signed by another, whose key only the second bundle publishes | joint replay passes **V2** from the case file's merged key table — the cross-domain shape every real conviction has |

## Build status

**Built** (2026-08-22) — all five decisions, the four work packages built by four
concurrent agents on W4's disjoint file ownership, gated by `test/adr0020.test.ts`
(14 cases), the whole suite green at 197, and every shipped bundle replaying under the
extended verifier with **unchanged pass status** (`export-p2` and `export-p3` pass;
`export-p3-llm`'s 10 award-check failures and the `export-p4`/`export-p5*` missing
manifests are pre-existing and identical before and after this ADR — the P5 demo's
regenerable state is gitignored per the 2026-08-21 commit, so those bundles are
incomplete on a fresh checkout by design).

Three things surfaced at integration, and each is recorded because none was visible
inside a single work package — the same lesson as ADR-0018's build, still paying:

1. **The successor rotation nearly keyed on off-record state.** The hub side first
   tracked a caller-supplied `proposedBy` that never reached the wire — exactly the
   class of defect this campaign exists to catch, caught this time at the seam review
   because the verifier could not have recomputed it. Ruled mid-build and amended into
   W2 above: the stalled proposer is the **wire actor** of the stalled
   `Offer{afp:Proposal}`, start-at-0 when it is not a pinned voter. Both
   implementations now compute succession from the same signed facts.
2. **`Hub.proposeRound({supersedesRound})` cannot itself mint a valid successor round
   today**, and the gate says so honestly instead of faking it: the hub signs every
   proposal as the hub actor, and the entitled successor is always a *member* — two id
   namespaces that never collide, so the in-process guard is unsatisfiable and a
   hub-signed successor round would fail V6 at replay anyway. This is the mechanism
   working, not a gap in it: succession is a member's act, the enforceable check is
   the replay's (Decision 3's own words), and G7/G8 therefore exercise it at the wire
   — a successor proposal signed by the entitled member replays clean, one signed by
   anyone else fails `round: … successor is entitled` by name. A member-signed
   proposal path through the hub API is future work and is commented as such at the
   guard.
3. **G9's concealment case needed no hub at all** — the two halves of the conviction
   pair are held as received bytes by two domains that never compare notes, each
   bundle passing alone, the joint replay failing the pair by name. That is Decision 5
   doing precisely what it was designed for, and it doubles as the first test of the
   census rule from finding 48 at the equivocation family.

**The demo is built** (`npm run demo:p6`, and `demo:p6:llm` with a local model writing
the underwriters' verdicts): scenario 12's beats 3-5 verbatim, five instances over real
HTTP, one scripted equivocator and one scripted restore told apart by the joint replay,
with the doomed round closed early on demand and the successor entitled by the pinned
rule. G1 and G2 were that demo's skeleton in unit form; running it at five operators
found the V2 scoping defect recorded in W3 above, which is the third time in this
repository that a demo has caught what a gate structurally could not — the gate and the
demo fail differently, and the difference is the point.

## References

- [Scenario 12 — The parametric trigger](../scenarios/12-the-parametric-trigger.md), findings 58, 60, 61, 62
- [03 — Coordination](../03-coordination.md) § Consensus hardening — Level 1 (the prose this ADR turns into rules)
- [ADR-0008](0008-p4-federation-stack.md) (the one-suite ruling Decision 1 reapplies)
- [ADR-0015](0015-the-case-file-at-n-parties.md) (the all-pairs join Decision 5 extends)
- [ADR-0018](0018-the-round-as-a-commitment.md) (the pinning discipline throughout; `thresholdOf`, whose denominator Decision 4 refuses to fork)
