# 02 — Hubs, shared state, gossip, membership

## Problem-scoped hubs

**`afp:Hub` extends AS2 `Group`** — precedent: federated community actors (e.g. Lemmy
communities), an actor that many others address and that owns shared, member-visible state.
One hub per common problem; an operator can enroll different subsets of their workforce in
different hubs.

### Enrollment is two-level, deliberately

1. **Instance level** — `Follow`/`Accept` between instance and hub establishes the
   instance's seat in hub governance (voting eligibility, visibility). No agents enrolled
   yet.
2. **Agent level** — the instance issues a signed `afp:Enroll` per agent, carrying that
   agent's hub-scoped capability declarations:

```json
{
  "@context": ["https://www.w3.org/ns/activitystreams", "https://dalager.github.io/agent-federation-protocol/ns/v3.jsonld"],
  "id": "https://alpha.operator.example/activities/en1",
  "type": "afp:Enroll",
  "actor": "https://alpha.operator.example/actor",
  "object": "https://alpha.operator.example/agents/a1",
  "target": "https://hub.consortium.example/actor",
  "afp:hub": "https://hub.consortium.example/actor",
  "afp:capabilities": ["afp:cap:image-classification"],
  "afp:hubKey": "https://alpha.operator.example/agents/a1#hub-key-1",
  "afp:role": "member"
}
```

`afp:Unenroll` removes one agent from the hub's membership OR-Set; `Undo{Follow}` at
instance level mass-unenrolls everything that instance put into the hub.

**Enrollment carries a role** (`afp:role`, default `member` — ADR-0004): not everyone on
a hub is there to decide. A **`requester`** may announce tasks and publish Results on its
own threads (an ask, and later the observed actuals that settle it) but never bids,
votes, or appears in a quorum snapshot; an **`observer`** only reads at `hub` visibility.
The role is folded into the membership state and replayed from the Enroll trail, so "who
could ask," "who could answer," and "who could decide" are distinguishable in the record
— enforcement at bid admission and snapshot-pinning, never in workflow code. Role state
merges deterministically: per-agent last-writer-wins over the Enroll trail (latest
`published`, compared as an *instant* rather than as a string; equal timestamps break by
higher activity digest) — re-enrolling with a new role is the upgrade/downgrade path, on
the record.

### Hub-scoped state

v2's capability registry and membership set stop being global: every hub-scoped store is
keyed `(hubId, crdtType)`, and both the explicit `Update{afp:CRDTDelta}` activities that
move application-defined stores and the governing activities that move the protocol's own
stores carry a required `afp:hub` field. The alternative — namespacing `crdtId` itself —
was rejected: what moves a store is already a discrete signed activity either way (ADR-0016
Decision 3), a field is trivially filterable/routable, and it lets one gossip batch carry
deltas for several hubs a peer shares without ambiguity.

### Governance concentration, kept accountable

Member admission and dispute adjudication inevitably concentrate at the hub. Mitigation:
the hub's governance activities (`afp:GovernanceDecision`, `afp:MemberAdmit`,
`afp:MemberExpel`) require a **weighted quorum vote among current instance members**,
reusing the L1 machinery — *never* a signature from the hub's own key. The hub key signs
only transport-level things (message forwarding, state storage attestation).

Practical consequence: whoever operates the physical hub server has no unilateral power
beyond availability — a malicious or compromised hub can censor or go dark, but cannot
forge governance outcomes or corrupt history, because everything of consequence is
independently signed by members and gossip-replicable. Recovery from a bad hub operator:
stand up a replacement hub actor, replay CRDT deltas from surviving members' outboxes —
costly, but a liveness failure, not a correctness one.

## Shared state as CRDTs

Explicit state types with defined merge rules. In v3 **every store is keyed
`(hubId, crdtType)`** — there is no global registry.

| State (per hub) | CRDT | Merge rule |
|---|---|---|
| Capability registry | `OR-Map<agentId, OR-Set<capability>>` | add/remove-wins via unique tags + tombstones |
| Agent liveness / load | `LWW-Register` of `{status, load, lastSeen}` | highest timestamp wins, nodeId tiebreak |
| Membership | `OR-Set<AgentRef>` (+ join epoch) | set union; suspected-flag, not removal, on staleness |
| Vote tallies (L0) / vote receipts (L1) | `G-Counter` / `G-Set` of signed receipts | monotonic sum / set union |
| Reputation inputs | `G-Set` of signed events (completions, strikes) | set union; score derived locally |

Two populations move this state, both by signed activity, neither by a bare unsigned delta
(ADR-0016 Decision 3). Application-defined stores mutate via an explicit
`Update{afp:CRDTDelta}` with a required `afp:hub` field, exactly as the worked example
below shows. The protocol's own stores — membership, capabilities, roles, seats, vote
receipts, assets — are moved by their governing activities (`afp:Enroll`,
`Create{afp:Vote}`, `Update{afp:Asset}`, …), from which each replica derives its own deltas
locally; those deltas never travel on their own. CRDT merges are commutative, associative,
idempotent — receivers apply deltas on arrival with no ordering requirement, and duplicates
are free. This eliminates reordering as a concern for this entire state class; task
execution, which has real side effects, uses causal ordering instead (below).

### Application-defined stores

The table above enumerates the *protocol's own* state. The `crdtId`/`crdtType` machinery is
deliberately generic: applications MAY define their own hub-scoped stores using the same
delta envelope and the same CRDT types — a shared backlog as
`OR-Map<itemId, LWW-Register<{status, assignee, priority}>>`, a knowledge-base index as
`OR-Map<tag, OR-Set<entryId>>`, and so on. They gain hub scoping, cross-operator sync,
order-tolerance, and audit for free.

Two rules: pick a `crdtId` that won't collide with protocol stores (prefix application
stores, e.g. `app:backlog`), and remember that CRDTs converge state — they don't record
*work*. Work stays in threaded activities (`context`); the CRDT holds the current view.

```json
{
  "@context": ["https://www.w3.org/ns/activitystreams", "https://dalager.github.io/agent-federation-protocol/ns/v3.jsonld"],
  "id": "https://alpha.operator.example/activities/delta-33ab",
  "type": "Update",
  "actor": "https://alpha.operator.example/agents/a1",
  "to": ["https://hub.consortium.example/actor"],
  "object": {
    "type": "afp:CRDTDelta",
    "afp:hub": "https://hub.consortium.example/actor",
    "afp:crdtId": "capability-registry",
    "afp:crdtType": "OR_MAP",
    "afp:delta": {
      "key": "https://alpha.operator.example/agents/a1",
      "fieldType": "OR_SET",
      "adds": [{ "element": "afp:cap:image-classification", "tag": "a1-1737000242-14" }],
      "removes": [{ "element": "afp:cap:translation-en-da", "tombstoneTags": ["a1-1736990001-9"] }]
    }
  },
  "published": "2026-08-16T10:04:05Z"
}
```

## Gossip & anti-entropy

Anti-entropy keeps hub-scoped CRDT state converged: periodically exchange a digest — a
Merkle root over local state (large/many-key state) or a version vector of per-actor delta
counts (small state) — via `Offer{afp:Digest}`; the receiver pulls only what it's missing
via `Accept{afp:StateDeltas}`. Urgent changes (an agent going offline) push immediately
with decaying-fanout rumor spreading instead of waiting for the next pull cycle.

> **v3 reality check: NAT and firewalls.** v2's "pick k random peers and gossip directly"
> assumed same-operator reachability. Cross-operator instances typically sit behind their
> own NAT/firewall with no open inbound path to each other. Across instance boundaries the
> **default is hub-relayed delta exchange** — the hub is always-reachable by construction —
> with direct instance-to-instance gossip as an opt-in fallback once a
> `FederationAgreement` confirms mutual reachability. Within one operator's own fleet,
> direct gossip remains the default.

```json
{
  "@context": ["https://www.w3.org/ns/activitystreams", "https://dalager.github.io/agent-federation-protocol/ns/v3.jsonld"],
  "id": "https://alpha.operator.example/activities/digest-77e1",
  "type": "Offer",
  "actor": "https://alpha.operator.example/actor",
  "to": ["https://hub.consortium.example/actor"],
  "object": {
    "type": "afp:Digest",
    "afp:hub": "https://hub.consortium.example/actor",
    "afp:merkleRoot": "sha256:c1a9...774e",
    "afp:versionVector": {
      "https://alpha.operator.example/agents/a1": 41,
      "https://beta.operator.example/agents/b1": 19
    }
  },
  "published": "2026-08-16T10:05:00Z"
}
```

Reply: an `Accept` referencing the `Offer` id, whose object is an `afp:StateDeltas` array
carrying the signed activities that moved the stores — explicit delta activities for
application-defined stores, governing activities for protocol stores — or their digests to
be pulled; empty if already converged. The receiver dispatches them through the hub's
ordinary receive path and re-derives its own state; replay is re-merge (ADR-0016 Decision
3). Hub-generated liveness registers are excluded from the sync set: liveness is ephemeral,
re-observed per replica, and a stale liveness value asserts reachability exactly when the
assertion is wrong (ADR-0016 Decision 3).

## Membership & dynamic quorum

Hub membership is an explicit `OR-Set<AgentRef>` (join-epoch tagged), fed by enrollment:

- **Join** = instance `Follow` + `afp:Enroll`
- **Leave** = `afp:Unenroll` / `Undo{Follow}`
- **Failure** = gossip heartbeat staleness marks an agent *suspected* without removing it —
  excluded from live-weight calculations, retained for accountability. Avoids thrashing on
  transient network blips.

Quorum size is computed, not configured, over the live (non-suspected) **seated
instances** `n` — one operator, one weight (ADR-0005), which is also the right unit for
the Byzantine bound, since two agents of one operator are not independent failure domains:

- **Byzantine minimum** — `floor(2n/3) + 1`, for L1 rounds
- **Partition-aware minimum** — `floor((n − maxExpectedPartitionSize)/2) + 1` for L0,
  from recent connectivity/staleness observations
- **Weight, not headcount** — and not agent-count either: each seated instance carries the
  same total, divided among its live pinned voters, so an operator's say does not grow by
  running more agents. Quorum is a weight-sum threshold. Weight is liveness-gated only —
  hub-scoped reputation is deliberately *not* a term in it (ADR-0005 Decision 4)

**Snapshot-pinning.** At round start the proposer hashes the merged membership CRDT and
embeds it (`afp:quorumSnapshot`) plus the explicit voter list (`afp:voters`) — only
`member`-role enrollees are eligible (ADR-0004) — and the
per-voter weights (`afp:voterWeights`) in the proposal — recorded explicitly so tally
recomputation never depends on state a verifier can't see, and *recomputable* from the
pinned voters and the roster, so a proposer cannot simply write the numbers it wants.
Votes are validated against the pinned set: an agent enrolled *after* round start simply
isn't in it. This closes late-join tally skew and the mid-round Sybil attack — in the
multi-operator setting, it's what stops an operator from bulk-enrolling agents mid-vote to
swing a governance decision. Pinning closes only that mid-round variant; bulk-enrolling
*between* rounds is closed by the weighting itself, which is why the two rules are one
design (ADR-0005).

## Causal ordering

For multi-step workflows whose intermediate updates mutate side-effecting state (unlike
CRDT state), `correlationId` alone can't express "step 3 depends on step 2." Opt-in causal
metadata: `afp:seq` (monotonic per-actor) and/or `afp:vclock` (map of `actorId → seq`).

Receivers run a causal tracker: an activity is deliverable when the origin's `seq` is
exactly last-seen + 1 and no vclock entry exceeds what's been seen; gapped activities
buffer (bounded, with timeout) until the predecessor arrives or is pulled explicitly via
the gossip mechanism. Plain two-hop delegation never pays this cost.
