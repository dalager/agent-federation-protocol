# ADR-0016 — The P5 transport: the hub gets an inbox, and convergence carries activities

- **Status:** Accepted, and **built** (2026-08-21) — gated per decision and end-to-end by
  T7: foreign enrollments and votes through the hub's real inbox over real sockets; an
  unenrolled write refused opaquely, and refused identically with a valid membership proof
  presented; an enrolled observer's vote admitted at the door and dead in the handler; an
  application store's explicit delta activity converging beside the protocol stores; a
  bare replica converging to the leader's canonical hashes by digest exchange; the hub
  killed mid-task with in-flight mesh work completing; and no artifact bytes ever crossing
  the hub host
- **Date:** 2026-08-21
- **Applies to:** P5's remaining scope — every deployment where the hub is reachable over
  the network rather than in the host's process, and where more than one instance holds a
  replica of hub-scoped state
- **Builds on:** [ADR-0002](0002-p2-hub-and-crdt-stack.md) (the CRDT stack, and Decision 5
  which deferred this exchange to P5 by name), [ADR-0008](0008-p4-federation-stack.md) (the
  boundary, the inbox, and the two-tier gate this reuses rather than parallels),
  [ADR-0013](0013-authorized-fetch.md) (the read gate that keeps artifacts on the
  originating instance), [ADR-0014](0014-p5-shared-hub-stack.md) (the shared hub whose
  partition behaviour this must not contradict, and whose M6 gate named this scope as the
  part it did not prove)
- **Driven by:** the P5 row of the [roadmap](../05-roadmap.md) — hub-relayed digest
  exchange and anti-entropy, cross-instance CRDT sync, artifacts served by each originating
  instance — and its kill criterion: *kill the hub mid-task, new allocation stalls,
  in-flight work completes*

## Context

P5's stack ADR built what a shared hub *means*: proofs of membership, degraded operation,
hub-observed order, legible silence. It did not build how anything reaches the hub. ADR-0014
M6 said so in its own header — enrollments and votes reach the hub in-process — and that
honesty is the whole of this ADR's scope. Everything in the two ADRs above assumes a hub
that receives; the hub cannot receive.

Three facts about the built code set the shape of what follows, and two of them corrected
this ADR's own draft.

**The hub has no receiving half.** `ap/server.ts` routes `POST` to `/actor/inbox` and
`/agents/:name/inbox` and nowhere else; the hub is served read-only at `GET /hubs/:id`, a
route ADR-0014 added so a peer could fetch the hub's key. `hub/transport.ts` throws
outright for any target that is not local. A hub is addressable, resolvable, and deaf.

**There is no delta log, and there should not be one.** The version vector
(`crdt/store.ts`) holds per-actor *counts* per `(hub, crdtId)`, and ADR-0002 promised the
digest would be "a `SELECT`, not a migration" — but a count says how many, never which, so
"pull only what I'm missing" as an array of `CRDTDelta`s is not answerable from present
state. The instinct is to add the missing log. Grounding says otherwise, and it corrects
something wider than one ADR: [02](../02-hubs-and-state.md#shared-state-as-crdts) states
that "every mutation travels as `Update{afp:CRDTDelta}`" and prints a worked example of an
agent signing one, and ADR-0002 Decision 5 promised "deltas as discrete signed activities
(so replay *is* re-merge)". **For the protocol's own stores, the build did not take that
shape.** One `afp:Enroll` produces five `crdt.apply` calls across five stores, derived
inside the hub from the admitted activity; those deltas are not signed, never leave, and
are not evidence of anything on their own.

The divergence is narrower than it first looks, and the narrowing is what makes Decision 3
a unification rather than a repudiation. 02's *application-defined stores* use the delta
envelope exactly as written — an application's mutation **is** a signed
`Update{afp:CRDTDelta}`, a first-class activity with an author and a proof. So the protocol
has two populations: protocol stores, moved by a governing activity (`afp:Enroll`,
`Create{afp:Vote}`, `Update{afp:Asset}`), and application stores, moved by an explicit
delta activity. **Both are activities.** What does not exist in either population is a bare
unsigned delta worth logging, and adding a log would be manufacturing one — a second,
unsigned path into shared state, which is precisely the integrity machinery P5 is not
allowed to add.

**The hub's key resolver is synchronous.** `HubDeps.fetchActor` is a local lookup returning
an actor document or null, while the federation inbox resolves keys over async HTTP and
verifies the object proof before dispatching. Whether the hub's inbox is a second receiving
implementation or the existing one pointed somewhere else is decided by that seam, not by
preference.

The inherited constraint, unchanged since P5 opened: **P5 adds participants, never
integrity machinery.** Every decision below is the constraint holding — no new trust root,
no second signature suite, no second meaning of "member", and no second way for state to
change.

## Decisions

### 1. The hub's inbox is the instance's inbox with a different dispatch target

`POST /hubs/:id/inbox` goes live, and it is **`handleInboxPost` with `receive` bound to
`hub.receive`** — not a second receiving implementation. The hop signature check, the
object-proof verification against the author's published keys, the deny-list, the
agreement gate, the opaque refusal: all of it is the P4 boundary, already built, already
gated, already the thing every foreign byte crosses. A hub that received bytes any other
way would be a second front door into the same trust domain, and the second door is always
the one nobody audits.

The synchronous seam is resolved rather than papered over. The HTTP layer verifies the
object proof asynchronously against documents it fetches; the hub then verifies the same
proof synchronously against the document cache that fetch populated. **The two
verifications are not redundancy to remove.** `Hub.receive` is also the in-process entry
point — P1 through P4 call it directly, and ADR-0002's gate check 11 requires that nothing
in the bytes can tell whether the caller was local. Stripping the hub's own check to avoid
doing the work twice would make the hub trust its caller, which is exactly the property
the in-process path was built not to have.

What the hub does **not** get is a queue that pretends. The distinction matters because a
queue already exists: P1's delivery queue retries with backoff on a thrown hop, and
[04](../04-operations.md) has senders backing off on `429`/`503`. That machinery stays,
unchanged, and covers what it was built for — a transient failure, where retrying is
correct because the peer is coming back within the window. What is refused is a buffer that
absorbs a **partition**: once retries are exhausted the write fails to its caller, and
ADR-0014 Decision 2 says what happens next — the member degrades to the mesh, visibly, and
reconciles on return through `afp:priorThread`. A buffer that held the write instead would
hand every operator the belief that the bridge is quiet, which is the failure ADR-0014
named. Backoff is patience; an unbounded buffer is a lie about reachability.

### 2. The write path gates on enrollment; role governs what the write may do; the membership proof has no part in either

Four checks already exist and this decision is that they compose, in the order the boundary
already executes them, with nothing added:

1. **Hop signature** — the delivery is authenticated (ADR-0008).
2. **Object proof** — the author is authenticated against their own published keys, or
   their operator's under `afp:actingAs` custody (ADR-0008).
3. **Operated-by, then deny-list, then agreement** with the sending agent's operator —
   `Federation.gate`'s executed order.
4. **`roleOf(agent) !== null`** — the hub's own record of its own enrollment.

**Enrollment is admission; role is authority, and role is not checked here.** Check 4 asks
only whether the sender is enrolled at all. It deliberately does not ask what the write is
allowed to *do*, because [02](../02-hubs-and-state.md) already places that elsewhere and
says why: a `requester` may announce and report actuals but never bids, votes, or appears
in a quorum snapshot; an `observer` "only reads at `hub` visibility" — and enforcement
belongs "at bid admission and snapshot-pinning, never in workflow code". The built dispatch
honours this (an observer cannot announce). Folding role into the transport gate would put
the same rule in two places, and the copy at the door is the one that goes stale when a
role changes. **The door asks whether you are enrolled; the handler asks whether your role
permits this.**

**`afp:MembershipProof` is deliberately absent, and the absence is the ruling.** The proof
exists because a *third party* cannot ask the hub whether an agent is enrolled — that is
the whole of ADR-0014 Decision 1, and the reason it travels in the requester's pocket is
that the hub is unreachable exactly when it matters. On the write path there is no third
party: the hub is the authority on its own membership and it is the one being written to.
Accepting a proof here would let a bearer artifact write into shared state that other
members read, when the non-portable, non-expiring, authoritative answer is a local lookup.
A proof widens a read predicate for someone who cannot ask; it never substitutes for asking
when you are the one who knows.

**This narrows a line in the spec body, and the narrowing is deliberate.**
[04](../04-operations.md#security--trust) states the two-tier gate as running "on every
task-relevant activity: FederationAgreement → deny-list → roster/MembershipProof as hard
gates" — which reads as admitting the proof on any path, writes included. That sentence
predates ADR-0014, which introduced the proof for reads and scoped it there.
[07](../07-visibility-and-artifacts.md#authorized-fetch) already states the same chain
correctly *as the read gate*. This decision holds that 07's placement is the right one and
04's is over-general; T6 amends 04 accordingly.

An unenrolled or deny-listed sender gets the boundary's existing opaque refusal. The hub
does not distinguish "not a member" from "not admitted" in its response, for the reason
ADR-0013 gave: a refusal that explains itself is a probe that maps what exists.

### 3. What travels is the admitted activity, not the bare delta

This is the ADR's load-bearing decision and it follows from the second fact in the Context.
A replica that is behind is missing **activities** — signed, hash-chained, replayable,
already the substance the record is made of — and shipping those is the only option that
adds no new kind of thing. The receiving replica dispatches them through `hub.receive` like
any other inbound activity, re-derives its own deltas, and converges. **Replay is re-merge**
— ADR-0002's phrase, finally true in the built sense rather than the intended one.

`afp:StateDeltas` therefore carries activities (or their digests, to be pulled) — and for
an application-defined store those activities *are* `Update{afp:CRDTDelta}`s, exactly as 02
specifies. One rule covers both populations: **ship the signed activity that moved the
store.** 02's prose is amended to say that rather than to imply the protocol's own stores
also travel as explicit delta activities; the activity names on the wire are unchanged.

02 already assumes this shape where it matters most. Its recovery story for a bad hub
operator is to "stand up a replacement hub actor, replay CRDT deltas from surviving
members' **outboxes**" — a recovery that only works if what moved the state is recoverable
from the members' signed records, which is precisely this decision. The alternative
readings of `afp:StateDeltas` would leave that paragraph describing something the protocol
could not do.

Two consequences must be stated rather than discovered:

- **Hub-generated deltas are not synced, and liveness is the whole of that set.** A
  liveness register is applied with the *hub's* actor as origin — it is the hub's own
  observation, derived from no member's activity, and there is nothing signed behind it to
  ship. Ruling: liveness is ephemeral, re-observed at each replica, and excluded from the
  sync set. A liveness value that survived a partition and arrived stale is worse than an
  absent one, because it asserts a member is reachable at exactly the moment the assertion
  is wrong. This keeps the synced set exactly equal to the activity-derived stores.
- **An activity moves more than one store.** One `Enroll` touches membership,
  capabilities, role, seat and liveness. The version vector is per-store, so a shortfall is
  named per-store and answered with the activities that touched *that* store from *that*
  origin — which means the hub must record which activity moved which store. That is
  Decision 4's provenance row, and it is a pointer, never a copy.

### 4. The digest is the version vector, made answerable by provenance

`Offer{afp:Digest}` carries `afp:versionVector` — per `(hub, crdtId)`, per origin actor —
and the receiver asks for the shortfall by store and origin. To answer, the hub records on
every `apply` which activity produced the delta: `(hub, crdtId, origin, activityId)`. The
pull becomes a `SELECT`, which is what ADR-0002 meant and what the counts alone could not
deliver.

**Provenance points; it does not duplicate.** The row holds an activity id, not activity
bytes, so there is exactly one copy of every state change and exactly one thing a replay
verifies. A table holding the deltas themselves would be a second source of truth for the
same fact, and the two would disagree the first time anyone touched either.

Ordering within an origin's shortfall is that origin's own outbox chain — an order that
already exists, that the origin cannot revise without breaking its chain, and that no
recipient controls. It needs no invention here, and it does not compete with ADR-0014
Decision 3: the hub's relay order remains the hub's outbox, which is the only ordering the
hub actually witnessed.

`afp:merkleRoot` is **specified and deferred**. It is 02's answer for large or many-key
state, the version vector is 02's answer for small state, and every store this protocol has
today is small. Deferring it is the same honest deferral ADR-0015 made for the
hash-addressed form of `afp:Archive`, with the same condition on returning: a deployment
whose vector is itself the expensive part of the exchange.

### 5. Hub-relayed by default, direct gossip as routing — and the hub never carries payload

Cross-operator instances sit behind their own NAT with no inbound path to each other; the
hub is always-reachable by construction, or it is partitioned and Decision 2 of ADR-0014
applies. So the **default is hub-relayed** delta exchange, with direct instance-to-instance
gossip **opt-in** once a `FederationAgreement` confirms mutual reachability.

The ruling that keeps this from becoming two protocols: **the bytes are identical either
way**. The same signed activities travel, gated the same way at the same boundary, dispatched
into the same `receive`. Direct gossip is a routing choice about which socket carries them,
never a second path with its own rules — and a deployment that turns it on gains latency,
not capability.

And the hub relays **activities, never artifact bytes**. This is not new policy: 07 states
it as a rule already — "each instance serves its own artifacts" — with artifact `GET`s
running the same gate under ADR-0013. This decision only observes that the hub's arrival on
the network does not create an exception, and names the consequence: a hub that never sat
on the payload path cannot take in-flight work down with it when it dies, which is the
mechanical reason the P5 kill criterion can hold.

What *does* cross the hub is activities, and 04 already anticipated it — the object-integrity
proof is "load-bearing from roadmap P4 onward (P5 more so, when payloads start crossing a
hub)". That is this ADR arriving on schedule: the relay is untrusted with the payload it
relays, because every activity carries its author's proof through it.

### 6. The exchange is on the record and has no verifier check — stated, so the silence is a ruling

`Offer{afp:Digest}` and `Accept{afp:StateDeltas}` are ordinary signed activities in the
sender's outbox, at **`hub` visibility** — the class 07 defines for exactly this traffic,
whose typical use it lists as "hub-scoped CRDT deltas". The class is required and never
inferred (07), so an ADR that introduced two activity types without naming one would be
leaving a defect in the record by omission. They are not a side channel, because this
project does not have side channels: enrollment rides an activity, asset registration rides
an activity, and convergence traffic is not the place to start making exceptions.

When the hub is the one relaying, the hub's own key signs the hop and the exchange. 02
sanctions precisely that and no more: the hub key "signs only transport-level things
(message forwarding, state storage attestation)" and *never* a governance outcome. A digest
exchange is message forwarding and state attestation — the two things named — so this
decision spends no new hub authority.

They get **no verifier check**, and that is a decision rather than an omission. They assert
nothing about the work: a digest says what one replica held at one instant, and the
activities it pulls are verified as activities, by the checks those activities already have.
A check over the exchange would be checking that a transport ran — the class of
`report.record` site this repository has criticized three times for inflating a passing
count. ADR-0015's census will show the family with its count, so a reader sees the traffic
and sees that nothing was claimed about it, which is the difference between a silence and
an oversight.

The remaining transport machinery — the hop signature, the digest header, the routing
choice — stays off the record entirely, exactly as it has since ADR-0008.

## Options considered

| Option | Rejected because |
|---|---|
| Add a per-actor delta log and ship bare deltas | Manufactures a signed artifact the build never had, and creates a second unsigned path into shared state. The activities that produced the deltas are already signed, chained and replayable — the log would be a lossy copy of them that replay would then have to reconcile against the original |
| State-based merge: ship whole CRDT state and lean on the join | Converges, and loses everything else. State is a projection ADR-0012 deliberately keeps out of the record, a merged state cannot say who moved it (the version vector counts per origin for a reason), and a replica would be accepting shared state from a peer on the peer's word rather than on the authors' signatures |
| A second receiving implementation for the hub | Two front doors into one trust domain, and the second is the one nobody audits. Every check on the boundary would have to be written, and later changed, in two places |
| Accept `afp:MembershipProof` on the write path | Lets a bearer artifact write into state other members read, when the authoritative answer is a local lookup at the party being written to. The proof exists for whoever cannot ask the hub; the hub can always ask itself |
| Queue writes to an unreachable hub and replay them on its return | Hands every operator the belief that the bridge is quiet. ADR-0014 Decision 2 already sanctions the visible alternative, and a silent buffer would compete with it |
| Relay artifact bytes through the hub | Puts the hub on the payload path, which fails the P5 kill criterion directly: in-flight work would die with the host. ADR-0013 already serves artifacts from the originating instance under the gate |
| Direct instance-to-instance gossip as the default | Assumes a mutual inbound path that cross-operator deployments do not have. It is the v2 assumption 02's reality check retired |
| Verify the digest exchange in the replay | Checks that a transport ran, over activities whose own checks already cover everything asserted. The passing count grows and nothing new is proven |

## Consequences

**Positive**

- The hub becomes an addressable participant rather than an implementation detail of its
  host's process, which is what every P5 decision above it already assumed.
- Convergence carries signed evidence, so a replica that catches up holds the same
  verifiable record as one that was never behind — and a bundle exported from either
  replays identically.
- The kill criterion becomes a mechanical property rather than a hope: the hub is off the
  payload path by construction, so killing it stalls new allocation and nothing else.
- ADR-0002's deferred exchange closes in the terms it was deferred in, with its one
  incorrect premise corrected on the record rather than quietly worked around.

**Negative / accepted risks**

- Shipping activities is heavier on the wire than shipping deltas — an `Enroll` carries its
  capabilities, its proof and its envelope to move five small values. Accepted: the
  alternative is unsigned state changes, and this protocol has never traded evidence for
  bytes.
- The provenance table grows with every delta and is pure overhead for a deployment that
  never syncs. Bounded by holding ids rather than bytes, and by being derivable — it can be
  rebuilt from the record it points into.
- The double proof verification (HTTP layer, then hub) costs a signature check per inbound
  activity. Accepted deliberately: the in-process path's independence is worth more than the
  cycles, and it is the property that keeps the local and remote hubs indistinguishable.
- Opt-in direct gossip is a second thing to configure, and configuration is where
  deployments diverge. Contained by the bytes being identical, so a misconfiguration costs
  latency rather than correctness.

**Revisit triggers**

| Trigger | Reconsider |
|---|---|
| A hub-scoped store large enough that the version vector is itself the expensive part of the exchange | Whether `afp:merkleRoot` stops being deferred, and what a Merkle-scoped pull means when the unit is an activity |
| A replica that is behind by more activities than it can accept in one exchange | Whether the pull needs a windowing rule, and whether a partially-converged replica should say so on the record |
| Liveness being wanted across replicas after all | Whether the hub's own observations need to become signed activities, and whether that makes the hub an author about its members |
| A deployment where two hubs must converge with each other | Whether this is anti-entropy at all, or the multi-master hub ADR-0014 rejected, arriving by another road |

## Build status

Staging follows the dependency: nothing converges until the hub can receive, and nothing
can be pulled until the hub can say which activity moved which store.

| ID | Task | Where | Stage |
|---|---|---|---|
| **T1** ✅ | `POST /hubs/:id/inbox` live, composed from `handleInboxPost` with `receive` bound to `hub.receive`; the document cache seam that lets the hub's synchronous verify run against what the async layer fetched | `ap/server.ts`, `hub/transport.ts` | 1 |
| **T2** ✅ | The write-path gate in the executed order — operated-by, deny-list, agreement, then `roleOf(agent) !== null`; unenrolled and deny-listed senders refused opaquely and indistinguishably; no membership proof consulted; role **not** checked at the door — authority stays in the handlers, per Decision 2 | `federation/inbox.ts`, `hub/hub.ts` | 1 |
| **T3** ✅ | Delta provenance: `(hub, crdtId, origin, activityId)` recorded on every `apply`, so a per-store shortfall resolves to the activities that produced it. Ids, never bytes | `crdt/store.ts`, `hub/hub.ts` | 2 |
| **T4** ✅ | `Offer{afp:Digest}` / `Accept{afp:StateDeltas}` carrying activities, published at `hub` visibility (07's required class, never inferred); the shortfall computed per store and origin; hub-relayed as the default route; liveness excluded from the sync set; a transient hub failure retried by the existing queue's backoff, a partition failed to the caller — the queue/buffer line Decision 1 draws | `hub/hub.ts`, `hub/activities.ts`, `federation/` | 2 |
| **T5** ✅ | Direct instance-to-instance gossip, opt-in behind a `FederationAgreement` that confirms mutual reachability — the same bytes over a different socket, sharing the T4 code path rather than paralleling it | `federation/` | 2 |
| **T6** ✅ | Spec sweep, five amendments the draft's own sweep surfaced: (a) 02's "every mutation travels as `Update{afp:CRDTDelta}`" qualified to the two populations — explicit delta activities for application-defined stores, governing activities for protocol stores; (b) 02's anti-entropy section and 03's vocabulary table given the built meaning of `afp:StateDeltas`, and liveness's exclusion stated; (c) ADR-0002 Decision 5's "deltas as discrete signed activities" corrected where it was written; (d) 04's two-tier gate line narrowed so `MembershipProof` is the read path's, matching 07; (e) 04's and `federation.ts`'s gate order corrected to the executed one — **a pre-existing defect this ADR only found**, see below | `02-hubs-and-state.md`, `03-coordination.md`, `04-operations.md`, `05-roadmap.md`, `adr/0002`, `federation/federation.ts` | 3 |
| **T7** ✅ | Gate, over real sockets, extending M6's three-operator harness: enrollments and votes reach the hub through its **real inbox**; an unenrolled foreign agent's write is refused opaquely; a member presenting a valid membership proof on a write is refused just the same; an enrolled **observer's** vote crosses the door and dies in the handler — admission and authority discriminated as two different refusals at two different layers; an application-defined store's `Update{afp:CRDTDelta}` syncs by the same exchange as a protocol store's governing activity — one path, two populations; a replica lagging by a known number of activities converges by digest exchange, and its converged state matches the leader's canonical hashes; the hub is killed mid-task and **new allocation stalls while in-flight work completes**; artifact bytes are shown never to traverse the hub | `test/adr0016.test.ts` (extending `adr0014-m6.test.ts`) | 3 |

| **T8** ✅ | The P5 demo (`demo:p5`): the transport as a narrative, leaving three verifiable case files on disk — and the first N=3 joint replay whose counted votes genuinely crossed a boundary. Building it falsified one clause of Decision 6 (below) | `demoP5.ts`, `cli.ts`, `decision.py`, `afp_verify.py` | 3 |

Nothing in T1–T5 adds a verifier check, per Decision 6.

**Amendment (T8, same day): the transport did reach the verifier after all — not with
a new check, but by widening an old one's pool.** Decision 6's claim that the exchange
has no verifier surface holds; what it did not foresee is that the *hub inbox* changes
what an existing check must resolve. With foreign votes arriving as received bytes, a
DecisionRecord's `afp:countedVotes` resolves from the thread pool — own plus received —
rather than own activities alone, which is ADR-0015 N2's ruling applied to votes one
refusal earlier. A counted vote held as received bytes defers its signature to phase
two's received-check against the sender's bundle (its author's keys live there, not
here); an own-bundle vote still fails locally. Discrimination-verified: a tampered
received vote passes phase one and fails phase two by name — `joint: received {id}
matches the sender's record` — and the hub host's bundle alone still replays clean, the
same stance ADR-0015 N1 takes on a sender's absence. T7's assertions are over transport
behaviour and converged state, not over the record — and the one record-touching artifact
of this ADR, the exchange activities themselves, is checked by the activity machinery it
already rides.

**T6(e) is not this ADR's defect and should be weighed separately.** The two-tier gate's
*executed* order is operated-by → deny-list → agreement. 04 states it as "FederationAgreement
→ deny-list", and `federation.ts`'s own header comment states it as "agreement → deny-list
→ operated-by" — both inverted relative to the code beneath them. Nothing is currently
wrong: an activity refused at either stage is refused, and ADR-0013's rule that a grant
never lifts a deny-listing is satisfied a fortiori by deny-list running first. But three
descriptions and one behaviour is how a later reader talks themselves into the wrong
change. Listed here because the sweep found it; it could equally be fixed on its own,
ahead of this ADR and independent of whether it is accepted.

## References

- [ADR-0002](0002-p2-hub-and-crdt-stack.md) Decision 5 — the deferral this closes, and the
  one premise in it the build did not take
- [ADR-0008](0008-p4-federation-stack.md) — the boundary and the two-tier gate Decisions 1
  and 2 reuse rather than parallel
- [ADR-0013](0013-authorized-fetch.md) — the read gate that keeps artifacts on the
  originating instance, and the opaque-refusal rule Decision 2 inherits
- [ADR-0014](0014-p5-shared-hub-stack.md) — the partition behaviour Decision 1 must not
  contradict, and the membership proof Decision 2 declines to reuse
- [02 — Gossip & anti-entropy](../02-hubs-and-state.md#gossip--anti-entropy) — the wire
  shapes, and the NAT reality check behind Decision 5
- [02 — Governance concentration](../02-hubs-and-state.md#governance-concentration-kept-accountable)
  — what the hub key may sign, and the recovery story that presumes Decision 3
- [04 — Security & trust](../04-operations.md#security--trust) — the gate line Decision 2
  narrows, and the relayed-payload rule Decision 5 rests on
- [07 — Visibility, artifacts, lifecycle](../07-visibility-and-artifacts.md) — the `hub`
  class the exchange activities carry, and the artifact-serving rule Decision 5 inherits
