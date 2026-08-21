# ADR-0014 — The P5 shared-hub stack: the hub is somebody's server

- **Status:** Accepted, and **built** (2026-08-21) — gated per decision with
  discriminating mutations, and end-to-end by M6: three operators over real sockets, the
  proof verified against a hub document fetched from a third party, the host partitioned
  and the read surviving from the requester's pocket, the mesh carrying real delegation
  through the real inbox gate, and a post-partition round telling a recorded decline from
  two silences
- **Date:** 2026-08-21
- **Applies to:** P5 — every deployment where more than one operator shares a hub, which
  is the first configuration where the hub stops being an implementation detail of one
  instance and becomes shared infrastructure with an owner
- **Builds on:** [ADR-0002](0002-p2-hub-and-crdt-stack.md) (the hub and its CRDT state,
  built for one operator), [ADR-0005](0005-operators-are-equal.md) (per-operator weight,
  which only has something to prove at n>2), [ADR-0008](0008-p4-federation-stack.md) (the
  two-tier gate and the pairwise agreements this leans on when the hub is gone),
  [ADR-0013](0013-authorized-fetch.md) (whose `hub` read predicate is scoped to
  locally-hosted hubs precisely because Decision 1 here did not exist)
- **Driven by:** [scenario 10 / campaign 7](../scenarios/README.md#campaign-7--open),
  findings 43, 44, 45, 46

## Context

P2 built a hub for one operator, where "the hub" and "the instance" are the same trust
domain, the same process, and the same failure. P4 federated two operators without a hub at
all — deliberately, so the handshake could be proven on its own. P5 is where those meet,
and the meeting exposes a fact neither phase had to state: **a shared hub is one member's
server**. There is no neutral party in this design, no consortium host, and P5 should not
invent one — that would be a new kind of operator with new trust properties, which is a
larger change than the problem needs.

Scenario 10 walked three transit operators through a live route leak on one shared hub and
found the consequences of that fact arriving in the first four beats:

- A member cannot **prove** its enrollment to a peer that does not host the hub, so
  hub-class activities — which live in their author's outbox, not the hub's — are
  unreadable by exactly the members the hub exists to serve (finding 43).
- The host is also a participant, and the participant most likely to convene an incident
  bridge is the one having the incident. When the host partitions, the shared state goes
  with it, while the members' *pairwise* agreements remain perfectly intact (finding 44).
- Three operators' `published` instants are three unsynchronized opinions, and chain
  monotonicity constrains each chain only against itself — so "who knew what when", the
  audit's first question, has no answer the record can defend (finding 45).
- A quorum that cannot reach a member records the same tally whether that member refused
  or was unreachable (finding 46).

The inherited constraint: **P5 adds participants, never integrity machinery.** Every phase
before it kept that rule, and the decisions below are shaped by refusing to introduce a new
trust root, a second signature suite, or a second meaning of "member".

## Decisions

### 1. `afp:MembershipProof` — the hub vouches for its members, to whoever asks

The hub issues, on request or on enrollment, a signed statement naming **one agent, one
hub, one role, and an expiry**:

```json
{
  "type": "afp:MembershipProof",
  "afp:hub": "https://alpha.example/hubs/incident-bridge",
  "agent": "https://bravo.example/agents/s-noc",
  "afp:role": "member",
  "afp:expires": "2026-08-21T12:00:00Z",
  "proof": { "type": "DataIntegrityProof", "cryptosuite": "eddsa-jcs-2022", "…": "…" }
}
```

A fetching member presents it; the serving instance verifies it against **the hub's own
published key** — a document it already holds, because it is enrolled in that hub and
resolved the hub's actor to enroll at all. No new trust root: the hub was already the
authority on its own membership, and this is that authority written down and made
portable.

This is what widens ADR-0013's `hub` predicate from "a hub I host" to "a hub whose proof I
can verify". The predicate's shape is unchanged — an active agreement, not deny-listed, and
enrolled — but the third clause is now answerable by a third party:
`roleOf(hub, agent) !== null` **or** a valid presented proof. The deny-list and agreement
stages run before either, exactly as before; a proof widens the enrollment clause and
nothing else, for the same reason ADR-0013 held that a grant never lifts a deny-listing.

Four mechanical rulings an implementer meets immediately, decided here:

- **The fetcher presents the proof; the server never fetches it.** It travels as a request
  header (`afp-membership-proof`, base64url of the signed JSON) on the signed `GET`. This
  is finding 44 shaping Decision 1: the hub is unreachable exactly when coordination
  matters most, so a design where the *server* asks the hub "is this agent a member" fails
  with the host — while a proof in the requester's pocket keeps working for its lifetime.
- **The header is deliberately outside the HTTP signature's covered set.** The covered set
  is derived from the method and must stay that way — ADR-0013's downgrade lesson — and
  nothing is lost: the proof is not a bearer credential for the request, it is a
  hub-signed statement *about an agent*, and the gate requires the named agent to equal
  the requester the HTTP signature already authenticated. Stripping the header in transit
  denies rights; presenting someone else's proof names someone else and admits nothing.
- **Verification resolves the hub's key the way every key resolves**: an unauthenticated
  fetch of the hub's actor document (the bootstrap invariant), then the proof's
  `DataIntegrityProof` against its published key. The document is cacheable and members
  already hold it — they resolved it to enroll — so verification, like presentation,
  survives the hub's partition. Expiry bounds the staleness that caching buys.
- **The proof is transport machinery and never enters the record**, exactly parallel to
  the hop signature: reads leave no trace (ADR-0013 Decision 5), so the credential that
  admitted one leaves none either, and the Python verifier has no surface here. The
  *enrollment* the proof attests to is already on the record — the `Enroll` trail is the
  authority, and the proof is that authority made portable, not a second copy of it.

**It expires, and expiry is the point.** Membership churns; a proof that outlived its
subject's enrollment would be a capability nobody can revoke. Short-lived and re-issued is
the right trade, and it is the same trade `afp:AuditGrant` already makes.

### 2. The hub is a participant, and members degrade to the mesh rather than waiting

State the risk the topology creates rather than leaving it to be discovered: **a shared hub
is a single point of failure that is also one of the parties**, and the correlation between
"the host is unavailable" and "there is an incident worth coordinating" is not small.

The sanctioned answer is not a second hub or a failover protocol. It is that **members MAY
continue on the P4 direct flow while the hub is unreachable**, because the pairwise
agreements that admitted them to the hub in the first place are still live and still
mutual. What changes is what happens on the hub's return: the work done in the mesh is
**reconciled into the hub as ordinary recorded activities**, not merged as a silent state
fix-up. A reader must be able to see that a stretch of the incident happened off-hub, and
when it rejoined.

Degrading to the mesh is not a lesser mode of the same thing — it loses the hub's fan-out,
its shared state, and its quorum. Saying so is the point: an operator that knows it is
running degraded behaves differently from one that thinks the bridge is quiet.

**The reconciliation edge already exists, and that is the ruling.** Work done in the mesh
happens on ordinary P4 threads; when the hub returns, the activity that carries the work
back onto a hub thread names the mesh thread as **`afp:priorThread`** — ADR-0011
Decision 4's property, doing exactly what it was built for. The mesh thread closes with a
terminal outcome like any thread; the hub-side continuation opens with its prehistory
followable; and the verifier's existing check (a named prior thread that is present must
be closed and unretracted) applies unchanged. No new activity type, no merge protocol, no
"rejoin" ceremony: the inherited constraint said P5 adds participants and never integrity
machinery, and Decision 2 is the constraint holding — the off-hub stretch is visible in
the record because it is an ordinary thread with an ordinary edge, not because anything
new was invented to describe it.

### 3. The hub is the sequencing authority its members' clocks cannot be

Cross-operator ordering claims SHOULD be made **relative to hub-observed order**, not to
any member's `published` instant. The hub sees the activities it relays, in the order it
relays them; that is a single vantage point where three clocks are three opinions.

And the hub SHOULD **anchor its own chain head externally** on a cadence, reusing ADR-0012's
mechanism rather than inventing a second one. ADR-0012 introduced anchoring for a retention
duty; a shared hub has the same need for a different reason — its members must be able to
show a stranger that the sequence they agree on was fixed before the dispute, not composed
after it.

**Hub-observed order is the hub's own hash-chained outbox** — a thing it already has.
Every Announce it fanned out, every proposal, every DecisionRecord sits in one chain
whose order no member controls, and "relative to hub-observed order" means citing those
activities by digest, which the record already supports everywhere else. The hub exposes
its **chain head** so a deployment can anchor it on a cadence; the anchor itself rides
ADR-0012's existing carrier (`afp:anchors` in the manifest, `{actor, head, instant,
anchorRef}`), and ADR-0012's existing check — every anchored digest is a chain head the
bundle contains — applies to a hub's head with no new rule, because the hub's outbox is
in the bundle like every other actor's.

What this decision does **not** do is make the hub a timestamping authority for its
members' own records. Each member's chain remains its own, self-asserted and self-signed.
The hub's order is evidence about relaying, which is the only thing the hub actually
witnessed.

### 4. A quorum records who was silent, not merely who voted

A `DecisionRecord` gains the snapshot members from whom **no vote was counted**, separating
two facts that currently look identical:

- **Declined** — a recorded `Reject` from that member. It participated and said no.
- **Silent** — nothing on the record from that member at all.

Both are already implicit in the difference between `afp:countedVotes` and
`afp:quorumSnapshot`; what is missing is that a reader must reconstruct it, and the
reconstruction is exactly the kind of inference this project turns into a field. A tally of
two-of-three during a partition is a different decision from two-of-three with one refusal,
and an operator reading it years later should not have to guess which.

The shape on the record: **`afp:uncounted`** on the DecisionRecord — one entry per
snapshot member from whom no vote was counted, `{agent, afp:status}` with status
`"declined"` or `"silent"`. Declined means a recorded `Reject` of the round's proposal
exists from that member — the same AS2 shape 03 already prescribes for declining an
announced task, now meaning the same thing for a proposal: participation without assent.
The writer emits the field whenever it closes a round, an **empty list included**, so a
full turnout is distinguishable from a pre-ADR-0014 record that never accounted for
anyone. Replay holds the field to its arithmetic: counted actors and uncounted agents
MUST partition the pinned electorate exactly, and every `"declined"` MUST be backed by a
present `Reject` — a decline the bundle cannot produce is the counted-vote-you-cannot-
produce, one refusal earlier.

Deliberately **not** decided here: whether a silent member should block the decision.
That is quorum policy, which ADR-0002 put in the hub's hands, and a protocol rule would be
deciding for every deployment what only some of them mean. The protocol's job is that the
difference shows.

## Options considered

| Option | Rejected because |
|---|---|
| A neutral consortium-hosted hub | Invents a new kind of operator with new trust properties, and someone still hosts *it*. The problem is not solved, only moved somewhere the design has no vocabulary for |
| Replicate the hub across members (multi-master) | A second consistency problem on top of the CRDT one, and the hub's authority over membership would need a quorum of hubs. Enormous, for an availability property the mesh already provides |
| Members prove membership by presenting the hub's roster | The roster is a current-state document served by the hub — which is unreachable in exactly the case a proof is needed, and stale copies cannot be distinguished from current ones |
| Make membership proofs long-lived to survive hub outages | A capability nobody can revoke, in a design whose whole membership story is that admission is a recorded, reversible act |
| Have the hub timestamp members' activities | Makes the hub an authority over records it did not author, and creates a dependency that fails with the host. Hub-observed *relay* order claims only what the hub saw |
| Let a silent member block every decision | Hands any partitioned or malicious member a veto over an incident response. Quorum policy is the hub's, and this ADR only makes silence legible |
| Record silence as an abstention | Writes a decision the member never made — the finding itself |

## Consequences

**Positive**

- The shared hub's members can read the shared work, which is the property that makes a
  hub worth having rather than a fan-out convenience.
- An incident bridge survives its host, in a stated, recorded mode rather than by whatever
  each operator improvises.
- "Who knew what when" gains a defensible answer for the one ordering that spans operators.
- A quorum's shape is visible years later without inference.

**Negative / accepted risks**

- A membership proof is a bearer artifact for its lifetime. Short expiry is the mitigation;
  it is the same shape, and the same accepted risk, as `afp:AuditGrant`.
- Degraded mode is a second path through the same incident, and two paths are harder to
  reason about than one. Accepted because the alternative is an unstated third path that
  every operator invents under pressure.
- Hub-observed order is one more thing the hub is trusted for, and the hub is a member.
  Contained by what the claim covers: relay order, not authorship.

**Revisit triggers**

| Trigger | Reconsider |
|---|---|
| A hub with enough members that pairwise degraded mode is impractical | Whether the mesh fallback needs a coordinator, and whether that is a hub by another name |
| Hub-hosting moves between operators mid-life | Whether membership proofs and hub identity survive a host migration, or whether that is a new hub |
| A member disputes hub-observed order | Whether the hub's relay log needs to be exportable evidence in its own right |

## Build status

Staging follows the dependency: nothing about a shared hub is testable
until a member can prove membership to a peer.

| ID | Task | Stage |
|---|---|---|
| **M1** ✅ | `afp:MembershipProof`: issuance at the hub, the signed shape, expiry | 1 |
| **M2** ✅ | Verification at the serving instance; ADR-0013's `hub` predicate widened from locally-hosted to proof-bearing | 1 |
| **M3** ✅ | Degraded mode: the mesh fallback and the recorded reconciliation on the hub's return | 2 |
| **M4** ✅ | Hub-observed order; hub chain-head anchoring on a cadence (reusing ADR-0012's carrier) | 2 |
| **M5** ✅ | Silent-vs-declined on the `DecisionRecord`; verifier check that the two are distinguishable and consistent with the snapshot | 2 |
| **M6** ✅ | Gate: three instances, one hub — a member reads a peer's hub activity under a proof; an expired proof is refused; the host partitions and the mesh carries the work; the reconciliation is visible on return; a round with one member silent records it as silent, not as an abstention | 3 |

## References

- [Scenario 10 — the incident bridge](../scenarios/10-the-incident-bridge.md), findings
  43–46
- [ADR-0013](0013-authorized-fetch.md) — the read predicate this widens, and the reason it
  was scoped narrowly in the first place
- [ADR-0012](0012-the-long-horizon.md) — the anchoring mechanism Decision 3 reuses rather
  than duplicating
