# 03 — Vocabulary, patterns, bidding, consensus

## Coordination vocabulary

Standard AS2 types — `Follow`, `Accept`, `Reject`, `Announce`, `Create`, `Update`, `Undo`,
`Offer` — are reused wherever their semantics fit. The `afp` extension adds what AS2 has no
vocabulary for. Core object types from v1: `Task`, `Capability`, `Result`, `Error`, `Vote`
— delivered via standard activities, correlated by `correlationId`.

### Task delegation — the v1 baseline flow, unchanged

```json
{
  "@context": ["https://www.w3.org/ns/activitystreams", "https://afp.example/ns/v3"],
  "id": "https://alpha.operator.example/agents/a1/activities/8f2a",
  "type": "Offer",
  "actor": "https://alpha.operator.example/agents/a1",
  "to": ["https://beta.operator.example/agents/b1"],
  "object": {
    "id": "https://alpha.operator.example/agents/a1/tasks/task-9931",
    "type": "afp:Task",
    "afp:capability": "afp:cap:image-classification",
    "afp:deadline": "2026-08-16T14:30:00Z",
    "afp:correlationId": "task-9931",
    "context": "urn:afp:thread:batch-12",
    "afp:visibility": "parties",
    "content": "Classify the attached image set",
    "attachment": [{
      "type": "Link",
      "href": "https://alpha.operator.example/artifacts/sha256-4b71...",
      "mediaType": "application/zip",
      "afp:digest": "sha256:4b71...c908",
      "afp:size": 20971520
    }]
  }
}
```

`Accept`/`Reject` answer the Offer (a `summary` carries the reject reason); the worker
returns `Create{afp:Result}` with the same `correlationId`, or `Create{afp:Error}` on
failure — the typed-outcome objects AS2 lacks.

Everything above is available to a single operator with two agents and no network — it is
the whole of roadmap P1. Note what is already mandatory at that scale: the attachment is
hash-addressed rather than a bare `s3://` path ([07](07-visibility-and-artifacts.md#artifacts--attachments)),
the activity declares its read class rather than defaulting open, and the thread id is
carried separately from the task id. `afp:hub` joins this object only once a hub exists to
scope it to (P2); it is absent, not empty, before then.

### Correlation vs. threading — two distinct ids

These were conflated in earlier revisions; scenario testing surfaced the collision.

| Id | Scope | Purpose |
|---|---|---|
| `id` (standard AS2) | **One activity**, globally unique | Transport dedupe: a redelivered POST is dropped at the inbox *before* dispatch |
| `afp:correlationId` | **One task**, globally unique | Matches Offer→Accept→Result; the idempotency/replay key (an agent already holding it replays its cached Result) |
| `context` (standard AS2) | **One thread**, spanning many tasks | Groups every activity belonging to one incident, case, or backlog item — e.g. `"urn:afp:incident:inc-4471"` |

Never reuse a `correlationId` across tasks to express "same workflow" — that collides with
the dedupe rule and will cause a second task to be answered with the first one's cached
Result. Use `context`, which AS2 provides precisely for grouping related activities. Audit
replay follows `context`; delivery mechanics follow `correlationId`.

**Two dedupe layers, not one — build both.** They sit at different depths and answer
different questions. `id` dedupe (a short-TTL seen-ids store) absorbs retry storms and
duplicate delivery of *the same activity*. `correlationId` replay (the pending-task table)
absorbs *the same task* arriving as a genuinely new, differently-identified activity — a
re-send after a delegator timeout, a re-auction, a peer that never saw the 2xx. An
implementation with only the first executes work twice; one with only the second drops
legitimate redeliveries it should have absorbed silently.

### Co-work: the ping-pong thread

`Offer`/`Accept`/`Result` assumes exactly one performer, which is what keeps attribution
(and therefore contribution accounting) exact. Genuinely joint work — two agents iterating
on one artifact — is modeled as **alternating single-performer tasks sharing one
`context`**: A produces, B critiques and returns, A revises, converged. The thread is the
co-work record; every hop has exactly one author, like pair programming where each commit
still has one committer.

Where a Result truly has no single author, AS2's `attributedTo` accepts an array. If used,
the emitting instances MUST also state a contribution split (`afp:contributionSplit`, a
map of actor → fraction summing to 1) so ContributionSummary stays computable; absent it,
verifiers count such a Result for no one rather than double-counting.

### External systems: keep the firehose behind the port

AFP is a coordination protocol, **not** an event bus. High-frequency external signals
(metrics, logs, traces, webhooks) belong behind an agent's adapter (01 — ports & adapters),
aggregated by its brain; only decision-worthy events cross the port as activities. Piping
a raw stream into an inbox defeats retry queues, dedupe stores, and audit replay alike.

Conversely, for side effects an agent executes in an external system (opening a change
proposal, filing a tracker record, merging), the authoritative outcome lives outside AFP.
Port agents **MUST reconcile**: emit a follow-up `Result` into the same `context` carrying
the external reference, a content hash of the artifact, and an observation timestamp —
otherwise the trail ends at "we proposed" and audit cannot establish what actually
happened.

### v2 terms (consensus, state, ordering)

| Term | Attached to | Purpose |
|---|---|---|
| `afp:round`, `afp:phase`, `afp:seqNo`, `afp:proposalHash`, `afp:observedVotes`, `afp:quorumSnapshot` | `afp:Vote` | L1 chained voting / equivocation detection |
| `afp:EquivocationProof` | `Announce` object | Pair of conflicting signed votes as verifiable proof |
| `afp:crdtId`, `afp:crdtType`, `afp:delta` | `afp:CRDTDelta` in `Update` | CRDT delta-state sync |
| `afp:merkleRoot`, `afp:versionVector` | `afp:Digest` in `Offer` | Gossip anti-entropy digest exchange |
| `afp:StateDeltas` | `Accept` object | Response to a digest pull |
| `afp:seq`, `afp:vclock` | any causal-workflow activity | Causal ordering / gap detection |

### v3 terms (federation, hubs, bidding, accounting)

| Term | Kind | Meaning |
|---|---|---|
| `afp:Instance` | Actor type | Operator's server; administrative/trust boundary hosting agent actors |
| `afp:operatedBy` | Property (agent actor) | Which instance administers / is accountable for this agent |
| `afp:roster` | Collection (on Instance) | Signed list of vouched-for agents, with status |
| `afp:MembershipProof` | Credential | Short-lived signed attestation of instance membership, cacheable |
| `afp:Vouch` / `afp:Disown` | Activity | Instance adds / removes an agent from its roster |
| `afp:keyCustody` | Property (roster entry) | `"instance"` \| `"self"` — who signs for this agent |
| `afp:FederationAgreement` | Object | Bilateral, co-signed, scoped, expiring trust anchor between instances |
| `afp:Defederate` | Activity | Unilateral withdrawal from a FederationAgreement |
| `afp:Hub` | Actor type (Group-like) | Problem-scoped rendezvous/relay owning hub-scoped CRDT state |
| `afp:Enroll` / `afp:Unenroll` | Activity | Adds/removes one agent to/from a hub's membership CRDT |
| `afp:hub` | Property | Scopes a CRDTDelta, Task, Bid, etc. to one hub's namespace |
| `afp:GovernanceDecision` | Activity | Signed, quorum-voted hub-level decision (admission, expulsion, disputes) |
| `afp:MemberAdmit` / `afp:MemberExpel` | Activity | Specific governance decisions on hub membership |
| `afp:Bid` | Activity (reserved in v1, now live) | Signed offer to perform an announced Task, with estimates |
| `afp:Award` | Activity | Signed, independently-verifiable selection of a winning bid |
| `afp:Reauction` | Activity | Restarts allocation after award timeout/failure |
| `afp:capabilityMatch`, `afp:estimatedCost`, `afp:estimatedLatency` | Properties (Bid) | Self-declared fit and estimates, later checked against actuals |
| `afp:bidCommit` / `afp:BidReveal` | Activity pair | Commit-reveal sealed bidding, deters sniping |
| `afp:reputation` | Property (hub-scoped, per agent) | Running score from completions, estimate accuracy, voting integrity |
| `afp:ContributionSummary` | Object | Periodic, independently-recomputable per-operator contribution roll-up |
| `afp:ContributionDispute` | Activity | Challenge to a ContributionSummary, with evidence |
| `afp:DecisionRecord` | Object (in `Create`) | First-class outcome record closing every voting round: outcome, snapshot hash, counted-vote hashes, weight tally |
| `afp:prevActivity` | Property (any activity) | Optional per-actor outbox hash chain — makes logs append-only-verifiable |
| `context` (standard AS2) | Property (any activity) | Thread id grouping all activities of one incident/case/item — distinct from `correlationId` |
| `afp:contributionSplit` | Property (Result) | Actor → fraction map, required when `attributedTo` names several actors |
| `afp:visibility` | Property (any activity) | `public` \| `hub` \| `parties` \| `internal` — read-side access class (07) |
| `afp:AuditGrant` | Credential | Signed, expiring, scoped read grant naming an auditor actor (07) |
| `afp:digest`, `afp:size` | Properties (Link) | Hash-addressing for artifacts; `afp:digest` is mandatory on attachments (07) |
| `afp:sourceUrl`, `afp:fetchedAt` | Properties (Link) | Provenance for externally-fetched evidence (07) |
| `afp:Freeze` / `afp:Archive` | Activity | Hub lifecycle: suspend new work / terminal read-only close with canonical state hashes (07) |
| `afp:coverage` | Property (Bid) | Declared sub-domains this bidder claims, with per-domain confidence — input to set-selection rules |
| `afp:Synthesis` | Object (in `Create`) | Combined answer bound to contributing Results: method, range, confidence, assumptions, dissent, superseded inputs (04) |
| `afp:Settlement` | Activity | Links prior estimates to observed actuals, releasing deferred reputation adjustment (04) |

## Coordination patterns

### 8a — Direct task delegation (v1 baseline, still the workhorse)

```
agent-a1 (Alpha)                              agent-b1 (Beta)
    |--Offer{Task task-9931}------------------->|  signed POST; two-tier trust gate
    |<--Accept{task-9931}------------------------|  (or Reject w/ reason)
    |               ... work happens locally ... |
    |<--Create{Result, correlationId=task-9931}--|
    |  match by correlationId to pending task    |
```

The delegator keeps a pending-task table keyed by `correlationId` with a deadline; the HTTP
response to the `Offer` POST only means "delivered," never "accepted." Used whenever the
target agent is already known — bidding exists for when it isn't.

### 8b — Capability discovery inside a hub

```
alpha-instance --afp:Enroll{agent-a1, caps}--> hub H   (after instance Follow/Accept)
hub H --Announce / gossip--> members' inboxes
members merge the delta into their (hubId)-scoped CRDT capability registry
```

### 8c — Consensus Level 0: cooperative broadcast quorum

```
proposer --Offer{Proposal}--> pinned voter set (membership snapshot)
each voter --Create{Vote}--> all peers (mesh)
each participant tallies locally; weighted quorum --> proceed
quorum reached --> proposer emits Create{afp:DecisionRecord}   (see 04 — Audit & provenance)
timeout without quorum --> Undo{Vote} / abandon round
```

Default consensus level — eventually-consistent, reorder-tolerant, not linearizable;
adequate *within* one operator's trust boundary. Any round whose voters span two or more
operators should run Level 1 — a concrete policy trigger, not a maybe. **Every round —
either level — closes with an `afp:DecisionRecord`** so the outcome is a recorded,
verifiable artifact, not merely a derivable one (see 04 — Audit & provenance).

### 8d — Hub fan-out broadcast

The hub doubles as the channel actor: `Create` to the hub, hub `Announce`s to every
enrolled member. Join/leave is enrollment, so senders never track subscriber lists.

## Bidding & allocation

Cross-operator allocation — for when the announcer *doesn't* know who should do the task.
When the target is known, skip all of this and use the direct `Offer` flow; `Bid` sits
alongside v1's flow, it doesn't replace it.

1. **Announce** — `afp:Announce{Task}` broadcast to the hub: task spec, required
   capabilities, deadline, `afp:hub`, and — published up front, not decided after the
   fact — the **selection rule** that will pick the performer(s).
2. **Bid, sealed** — during the bid window, bidders submit only a commitment hash
   (`afp:bidCommit`); after it closes they submit `afp:BidReveal` with values matching the
   hash. Commit-reveal deters last-moment undercutting off visible bids — open bidding on a
   hub (needed for auditability) would invite exactly that.
3. **Award** — the announcer (or the pre-published deterministic rule) emits `afp:Award`
   referencing the winning bid(s). Anyone can recompute the published rule over the
   revealed bids and verify the award — selection is checkable even when a human made
   the call.
4. **Accept / Result** — exactly the v1 flow keyed by `correlationId`, seeded by a Bid
   instead of a direct Offer.

```json
{
  "@context": ["https://www.w3.org/ns/activitystreams", "https://afp.example/ns/v3"],
  "id": "https://beta.operator.example/activities/bid-77",
  "type": "afp:Bid",
  "actor": "https://beta.operator.example/agents/b1",
  "afp:instanceEndorsement": "https://beta.operator.example/actor",
  "object": "https://hub.consortium.example/tasks/task-42",
  "afp:hub": "https://hub.consortium.example/actor",
  "afp:capabilityMatch": 0.93,
  "afp:estimatedCost": { "unit": "afp:compute-unit", "value": 120 },
  "afp:estimatedLatency": "PT4M",
  "afp:bidWindow": { "opens": "2026-08-16T10:00:00Z", "closes": "2026-08-16T10:05:00Z" },
  "published": "2026-08-16T10:00:12Z",
  "proof": { "type": "DataIntegrityProof", "cryptosuite": "eddsa-jcs-2022", "proofValue": "..." }
}
```

*(Shown post-reveal; the commit phase sends only `afp:commitment`, a hash of this
payload — which MUST include a `nonce` field, or a low-entropy bid is recoverable from
its commitment by enumerating the handful of plausible values.)*

**Sniping and lying, honestly bounded.** Signatures give non-repudiation of what was
*claimed*, not truth of the claim. The real deterrent is reputational: declared
`estimatedCost`/`estimatedLatency` are checked against the Result's actual telemetry, and
chronic over-promising drags hub-scoped reputation down, which feeds future selection odds.
A statistical guarantee, not a hard one.

- **Tie-breaking** — deterministic and discretion-free: `hash(taskId || bidderId)` as the
  secondary sort key, a protocol constant, never a per-task choice.
- **Re-auction** — on award-timeout (no `Accept`) or deadline miss,
  `afp:Reauction{taskId, priorAward}`. Fast path: next-ranked bidder from the same pool if
  the window hasn't gone stale; slow path: full re-`Announce`. The failed winner takes the
  reputation hit either way.

### Selection rules: one performer, or several

A selection rule is any **published, deterministic function from the revealed bid set to a
performer set**. Two families cover the useful cases:

| Family | Rule | Arity |
|---|---|---|
| **Ranking** | Score each bid, take the top one | Exactly 1 — the default |
| **Set selection** | Choose the minimal bid set satisfying a stated predicate | Emergent from the bid pool |

Set selection exists because some tasks cannot be answered by any single agent: a question
spanning four constraint domains, where each bidder covers one or two, needs a *coalition*,
and how many is a property of the question discovered from the bids — not something the
announcer can declare up front. Bids therefore carry `afp:coverage`: the declared
sub-domains this bidder claims, with per-domain confidence. A typical rule reads *"minimal
set covering all declared domains at confidence ≥ 0.6, ties broken by the protocol
constant."*

When a rule awards several performers it MUST also name, by the same deterministic rule, a
**synthesizer** — the agent responsible for reconciling partial answers into one
(see [04 — Synthesis](04-operations.md#synthesis-answers-that-are-not-decisions)).
Synthesizing carries real discretion, so who holds it is never an ad-hoc choice, and hub
policy MAY require the resulting synthesis to be ratified by a vote.

**Answer sufficiency is not voting quorum.** [02](02-hubs-and-state.md)'s quorum math
governs *voting* participation. "How many independent answers make an acceptable answer"
is a separate threshold, and a hub may express it as coverage (all domains spanned), as a
count (at least 3 independent estimates), or both. State it in the announce, not after.

### Declining is a record; silence is not

On an announced task, not bidding is ambiguous — "not my domain," "saturated," "offline,"
and "never saw it" are indistinguishable. Agents that cannot contribute SHOULD `Reject`
explicitly within the bid window with a reason. That converts the enrolled population's
coverage of a question from an inference into a record, which is what an audit asking
*"were the right agents consulted?"* actually needs.

### Estimating what you may later be paid to do

Where a task's *answer* is a cost or effort figure, whoever answers frames a budget they
may later bid to earn — an incentive to shade in either direction. Commit-reveal addresses
bid sniping, not this. Hub policy MUST take a position, and SHOULD do one of:

- exclude agents (or their whole instance) from bidding on execution of work they
  estimated; or
- permit it, and record bid-vs-own-estimate divergence as a reputation signal, visible to
  every hub member.

> **Precision:** `afp:estimatedCost` on a Bid means *what performing this task costs the
> bidder* — bid metadata. When the task is itself a costing question, the answer's figure
> lives in the `Result`/`afp:Synthesis`, never in the Bid. Do not conflate them.

## Consensus hardening — Level 1

**Problem.** In L0, votes are point-to-point `Create`s — agent A has no way to prove to B
what it told C. A Byzantine actor can equivocate: "accept" to B, "reject" to C, same round,
and neither can prove it happened.

### Signed vote chains

Every L1 `Vote` embeds:

- `afp:proposalHash` — hash of the thing being voted on
- `afp:seqNo` — monotonic per (voter, round) sequence number (replay prevention)
- `afp:observedVotes` — hashes of every signed vote this voter saw before casting its own
- a detached signature over the whole vote object

Two peers each holding one of a Byzantine voter's conflicting signed votes can produce a
self-contained `Announce{afp:EquivocationProof}` — same (voter, round, seqNo), different
value — cryptographic, third-party-verifiable proof, not an accusation. Receivers zero that
voter's weight immediately (agent-level, automatic); instance-level consequences go through
hub governance.

```json
{
  "@context": ["https://www.w3.org/ns/activitystreams", { "afp": "https://afp.example/ns/v3#" }],
  "id": "https://agent-a.example/activities/vote-91a3",
  "type": "Create",
  "actor": "https://agent-a.example/actor",
  "to": ["https://agent-b.example/actor", "https://agent-c.example/actor", "https://agent-d.example/actor"],
  "object": {
    "id": "https://agent-a.example/votes/round-7f2c9e/agent-a/2",
    "type": "afp:Vote",
    "afp:round": "urn:afp:round:7f2c9e",
    "afp:phase": "commit",
    "afp:seqNo": 2,
    "afp:proposalHash": "sha256:9d3b1c...e21f",
    "afp:quorumSnapshot": "sha256:mem-4a71c9...",
    "value": "accept",
    "afp:observedVotes": [
      "sha256:vote-agent-b-round7f2c9e-seq1",
      "sha256:vote-agent-c-round7f2c9e-seq1"
    ],
    "proof": {
      "type": "DataIntegrityProof",
      "cryptosuite": "eddsa-jcs-2022",
      "created": "2026-08-16T10:04:02Z",
      "verificationMethod": "https://agent-a.example/actor#key-1",
      "proofPurpose": "assertionMethod",
      "proofValue": "z4o9c..."
    }
  },
  "published": "2026-08-16T10:04:02Z"
}
```

### Mapping PBFT's phases — and where synchrony breaks

| PBFT phase | ActivityPub mapping | Where assumptions break |
|---|---|---|
| pre-prepare | Proposer `Offer{Proposal}` to the snapshot-pinned voter set | Maps cleanly — already a fire-and-forget broadcast |
| prepare | Each replica `Create`s a signed `Vote{phase: prepare}` to *every other replica* | PBFT waits for 2f+1 *matching* prepares — a wait that assumes bounded delay. Over async inboxes, "not yet" and "never" are indistinguishable |
| commit | `Vote{phase: commit}`, same 2f+1 bar | Same problem, compounded — a stalled prepare blocks commit indefinitely without timeouts |

**What's achievable, honestly:** L1 keeps PBFT's **safety** — equivocation is provable, so
two conflicting proposals can never both collect a valid quorum certificate — but
downgrades **liveness** to best-effort: soft rounds under generous timeouts riding the
outbox retry queue; a stalled round triggers a simplified view change (the
highest-reputation live replica issues a fresh round referencing the stalled one). No
formal termination bound, but no silent inconsistency either.

**What L1 buys at small operator counts — read this before claiming "Byzantine
tolerance":**

| Operators in hub | Guarantee |
|---|---|
| 1 (solo profile) | Nothing L1 adds — equivocation defense would defend against yourself. Stay at L0 |
| 2 | **Accountability, not tolerance.** No honest majority exists to outvote a dishonest party, but misbehavior yields portable cryptographic proof (EquivocationProof) usable commercially and in governance. Deadlock resolves off-protocol |
| ≥4 (f=1) | Actual Byzantine fault *tolerance*: `floor(2n/3)+1` can proceed correctly despite f malicious voters |

Both properties are worth having; conflating them is not. At n=2 the value is a
non-repudiable record, not automatic recovery.

Raft was rejected: its leader must detect its own unreachability via missed acks in bounded
time, and this transport has no delivery acks at all.

**Threshold signatures (optional):** 2f+1 commit votes can be aggregated into one compact
commit certificate — worth adding only once L1 is load-bearing; start with the bundle of n
signed votes. These certificates are also the evidence backbone for contribution accounting
and governance decisions. Either way, the round closes with an `afp:DecisionRecord` that
embeds or references the certificate (see 04 — Audit & provenance).

### A Byzantine-hardened voting round

```mermaid
sequenceDiagram
    participant P as Proposer
    participant B as agent-b
    participant C as agent-c
    participant D as agent-d (Byzantine)

    Note over P,D: n=4, f=1 - need 2f+1=3 matching votes per phase

    P->>B: Offer{Proposal} (pre-prepare)
    P->>C: Offer{Proposal}
    P->>D: Offer{Proposal}

    par prepare (all-to-all broadcast)
        B->>C: Create{Vote phase=prepare seq=1}
        C->>B: Create{Vote phase=prepare seq=1}
        D->>B: Create{Vote phase=prepare seq=1, value=X}
        D->>C: Create{Vote phase=prepare seq=1, value=Y}
    end

    Note over B,C: D told B 'X' and C 'Y' for the same (round, seq=1) - equivocation

    B->>C: anti-entropy exchange of observedVotes sets
    Note over B,C: cross-check finds two signed D-votes, same seqNo, different hash

    B-->>D: Announce{afp:EquivocationProof}
    C-->>D: Announce{afp:EquivocationProof}
    Note over B,C: D's weight zeroed; instance-level consequence goes to hub governance

    par commit (honest replicas only)
        B->>C: Create{Vote phase=commit seq=2}
        C->>B: Create{Vote phase=commit seq=2}
    end

    Note over P,D: only 2 honest votes, 3 needed - round times out
    Note over P,D: fallback: highest-reputation live replica issues a fresh round
```
