# 05 — Roadmap & open questions

## How the phases are ordered

Two rules shape the sequence, and they are the reason it was resequenced at v3.5.

**Every profile is a prefix, never a subset.** Phases add *participants*, not integrity
machinery. A solo operator runs P1→P3 and stops. A consortium runs P1→P7 in order. Nobody
cherry-picks a phase out of the middle, and nobody refactors when they federate — joining a
consortium is purely additive (see [06](06-deployment-profiles.md)). This is why hubs,
deliberation and allocation now sit *before* federation: none of them has a federation
dependency, and all three are immediately useful to a single operator.

**The audit properties are the floor, not a later phase.** Signing, hash-chained outboxes,
visibility classes and hash-addressed evidence all land in **P1**, at two agents, before
there is anything to federate. They cost almost nothing on day one and cannot be backfilled:
a chain that begins at activity 400 proves nothing about activities 1–399, and a Result
published without a visibility class has already been published. Every later phase inherits
them rather than adding them.

---

## P1 — One instance, two agents, one verifiable record

The smallest deployment that already proves the thesis. **No** hub, agreements, bidding,
voting, CRDTs, gossip, or Mastodon. Two agents in one process exchanging signed tasks — and
a record a stranger can verify. Stack decision:
[ADR-0001](adr/0001-p1-stack.md).

### Scope

| Area | What P1 builds |
|---|---|
| Identity | Instance actor (`afp:Instance`) + agent actors carrying `afp:operatedBy` and `afp:capabilities`, each publishing a **Multikey** in `assertionMethod`; WebFinger optional |
| Roster | The signed `OrderedCollection`, two entries, `afp:keyCustody: instance` — published from day one even though no peer reads it yet, and **derived from the instance's own `afp:Vouch` trail** rather than from configuration ([01](01-foundations.md#vouch--disown)) |
| Flow | `Offer{afp:Task}` → `Accept`/`Reject` → `Create{afp:Result}` or `Create{afp:Error}`, keyed by `afp:correlationId` ([03](03-coordination.md#task-delegation--the-v1-baseline-flow-unchanged)) |
| Signing | An **object integrity proof** (`eddsa-jcs-2022`) on every activity — the only signature that survives export, and therefore the only one a replay can check ([01](01-foundations.md#authentication--two-mechanisms-with-different-lifetimes)). HTTP Signatures only if P1 is wired over loopback HTTP |
| Transport | Outbox queue with backoff, dead-letter, and failures surfaced as local `Error`s |
| Timeouts | `afp:deadline` on delegated tasks and a delegator-side sweep: a performer that never answers yields a recorded `afp:Error`, because "thinking" and "dead" are otherwise indistinguishable ([04](04-operations.md#reliability--failure-handling)) |
| Idempotency | **Both** dedupe layers: transport dedupe on activity `id`, task-level replay on `correlationId` |
| Record | The four obligations below |

**Why the instance actor and roster are in P1 and not deferred to the federation phase:**
`afp:keyCustody` is declared *on a roster entry*, so without a roster there is nowhere to
state how an agent is wired; and agent actor documents published without `afp:operatedBy`
change their trust semantics the day it is added. Both cost one JSON document each.

### The four obligations, honored from activity #1

These are data-model decisions, not features. Each is nearly free at the start and
expensive-to-impossible to retrofit — which is exactly why they belong in the first phase
rather than the audit phase.

| Obligation | Rule | If deferred |
|---|---|---|
| `afp:visibility` | Every published activity declares a class; absent the field the class is inferred from addressing and defaults **closed** ([07](07-visibility-and-artifacts.md#four-visibility-classes)) | A later default-to-public retroactively republishes client data |
| `afp:digest` | Mandatory on every attachment; bytes not matching the digest MUST be discarded ([07](07-visibility-and-artifacts.md#artifacts--attachments)) | Evidence already in the record is unverifiable forever |
| `afp:prevActivity` | Per-actor outbox hash chain, from each actor's first activity ([04](04-operations.md#outbox-integrity-hash-chained-logs-afpprevactivity)) | The chain has a hole at the beginning that can never be filled |
| `context` vs `correlationId` | Two distinct stored keys — thread and task ([03](03-coordination.md#correlation-vs-threading--two-distinct-ids)) | Reusing one id for both replays the wrong cached Result |

### The demo

**A draft, a critique, a revision — and a stranger who can prove it happened.**

Two agents, `writer` and `reviewer`, both instance-custody, wired in-process. A human hands
the writer a brief with one source document attached. Then:

```
writer  --Offer{Task: "review this draft"}-->  reviewer     context: urn:afp:thread:doc-1
        <--Accept--                                          correlationId: task-1
        <--Create{Result: critique}--
writer  --Offer{Task: "review the revision"}-->  reviewer    correlationId: task-2
        <--Accept-- / <--Create{Result: approved}--
```

The writer drafts from the brief, delegates the review, **revises against the critique**,
and delegates again — one thread, two tasks, no network. The drafting itself is the
writer's own work rather than a delegated task, so it enters the record as a hash-addressed
attachment on the writer's signed Offer.

Then export the outboxes — the two agents' **and the instance's own**, which carries the
`Vouch` trail the roster is derived from — and hand them to **someone who was not there,
holds no keys, and has no access to the instance**. They run the replay procedure from
[04](04-operations.md#replay-procedure).

It passes. Then break it four ways, on purpose:

| Mutation | What fails | What it tests |
|---|---|---|
| **Flip one byte** of the archived source document | The attachment digest no longer matches | Evidence integrity |
| **Delete one activity** from the middle of an outbox | The next `afp:prevActivity` link | Log completeness |
| **Re-sign the last activity** with another agent's published key | No authority over that `actor` | Signer authority |
| **Delete a whole agent's outbox** | A rostered agent with no activities | Participant completeness |

The last two matter because a signature-only replay passes both: the chain does not protect
the *tail* of an outbox, and a per-actor chain cannot show that a participant is missing
entirely ([04](04-operations.md#signature-is-not-authority)).

**P1's deliverable is not a completed task. It is a record a stranger can verify and a
forger cannot quietly edit** — produced by a system with two agents and no network.

### Acceptance gate

P1 is done when every one of these is demonstrably true. They are the phase's definition of
done, not aspirations:

1. A second `Offer` with a `correlationId` already seen replays the cached `Result`; the
   agent brain is **not** invoked twice.
2. A redelivered activity `id` is dropped at the inbox *before* dispatch — a distinct layer
   from (1), with distinct storage.
3. An unsigned or bad-signature delivery is dropped **and** audit-logged. Never processed.
4. A delivery failure retries with backoff, dead-letters after N attempts, and surfaces as a
   local `afp:Error`. Nothing is silently dropped.
5. Every published activity carries an explicit `afp:visibility`; no code path defaults to
   `public`.
6. Every attachment carries `afp:digest`; a fetch returning non-matching bytes is discarded.
7. Each actor's outbox is an unbroken `afp:prevActivity` chain from its first activity, and
   a gap or fork is detectable from the chain alone.
8. The thread is grouped by `context`; no `correlationId` is reused across tasks.
9. The roster verifies as a whole against the instance key **from a cached copy**, with no
   live roundtrip.
10. Third-party replay by `context` succeeds on the clean export and fails, with a specific
    pointer, on each of **four** deliberate mutations: a flipped evidence byte, a removed
    activity, **an activity re-signed with another agent's published key**, and **a whole
    agent's outbox deleted**. The last two check *authority* and *completeness* rather than
    integrity, and a signature-only replay passes both
    ([04](04-operations.md#signature-is-not-authority)).
11. **The wiring is invisible.** Nothing in any actor document, activity, or outbox reveals
    that dispatch was in-process. This is the invariant that makes P2–P7 additive
    ([01](01-foundations.md#the-agentinstance-boundary-ports--adapters)) — a P1 record must
    be indistinguishable in shape from a federated one.

Check (11) is worth failing the phase over. If it holds, every later phase is a matter of
adding participants; if it does not, federation becomes a rewrite.

---

## P2–P7

Each phase is independently demoable, and earlier phases keep working unmodified as later
ones add capability around them.

| Phase | Scope | Demo | Gate |
|---|---|---|---|
| **P2 — Local hub & L0 deliberation** | `afp:Hub` as a local route beside the agents, enrollment, hub-scoped CRDT capability registry, L0 weighted-quorum voting, `afp:DecisionRecord` closing every round, `afp:GovernanceDecision`, hub lifecycle (`Freeze`/`Archive`). Still one operator — the hub machinery has no federation dependency | *"30 agents agree on the best policy for codebase integrity"*: a local swarm deliberates and closes with a DecisionRecord | Any member recomputes the weight tally from the recorded `countedVotes` and agrees; a vote missing from the tally is detectable from the record alone |
| **P3 — Local allocation** | `afp:Bid` with commit-reveal windows, selection rules in both families (ranking **and** set-selection over `afp:coverage`), deterministic tie-break, `afp:Award` naming performer(s) and synthesizer, `afp:Reauction`, `afp:Synthesis`, `afp:Settlement`, estimator/bidder separation of duties. Local bidding is real load balancing | A question no single agent covers, awarded to a coalition whose size the bid pool forced, answered by a Synthesis carrying its dissent | Any member recomputes the published selection rule over the revealed bids and reaches the same performer set and synthesizer; every reveal matches its commitment hash |
| **P4 — Federation handshake & operator visibility** | `Offer{FederationAgreement}` → countersign → published trust anchor, `afp:MembershipProof`, deny-list and `afp:Defederate`, **LD-Signatures on payloads crossing an instance boundary**, authorized fetch enforced against a real peer, `afp:AuditGrant`, dual-publish shadow Notes and the narrow inbound command grammar | Two instances mutually recognize each other; an operator follows an agent from a **stock Mastodon account** and watches the thread | A validly-signed activity from an un-agreed instance is hard-rejected; a `parties` activity returns **404, not 403**, to a federated peer that is not named in it |
| **P5 — Shared hubs across operators** | Two-level enrollment, hub-relayed digest exchange and anti-entropy (the NAT-realistic default), cross-instance CRDT sync, artifacts served by each originating instance, `hub` visibility enforced across the boundary, `Archive` as a member-quorum GovernanceDecision | A cross-operator task where the hub brokers discovery and allocation but sits on neither the payload nor the result path | Kill the hub mid-task: new allocation stalls, **in-flight work completes** |
| **P6 — L1 Byzantine voting** | Chained signed votes (`afp:observedVotes`, `afp:seqNo`, `afp:proposalHash`), `afp:EquivocationProof`, snapshot-pinned membership, governance rollup. Activated by the concrete trigger **"≥2 operators live in a hub"** | A 3-instance hub surviving a deliberately equivocating agent | The EquivocationProof verifies standalone from the two conflicting votes; the offender's weight zeroes with no coordination; any *instance*-level consequence requires a ratified GovernanceDecision |
| **P7 — Contribution accounting** | `afp:ContributionSummary` and the `afp:ContributionDispute` flow — last, because it consumes P6's certificates and P1's Result flow | An independently recomputed, agreeing ContributionSummary | A second operator recomputes it from certificates and Results and matches; a dispute filed with evidence resolves against the record, not against a claim |

---

## Profiles

Because every profile is a prefix, the mapping is a stopping point rather than a
cherry-pick:

| Profile | Phases |
|---|---|
| **Solo / airgapped** | P1 → P3, then stop |
| **Federated consortium** | P1 → P7 in order |

A solo deployment MAY additionally switch on P4's **dual-publish shadow Notes** at any point
without adopting the rest of P4 — publishing Notes to an external follower requires no
agreement, and it is the cheapest way to anchor outbox chain heads outside a trust domain
where the operator holds every key
([06](06-deployment-profiles.md#keep-signing-everything--the-sneakernet-property)).

## Open questions

- **Directory-of-hubs bootstrap.** Left as an out-of-band, consortium-published list at a
  well-known URL. Hubs churn far less than agents, so a hand-maintained list suffices;
  revisit (a lightweight meta-hub?) only if concurrent hub count grows past a handful.
  Don't design it before there's evidence of the need.
- **Cross-instance bid collusion.** Commit-reveal stops a single dishonest bidder from
  sniping off visible bids, but cannot detect two instances coordinating bids out-of-band
  before submission. That's a consortium-terms/policy matter — who you agree to federate
  with in the first place — not something the protocol can enforce cryptographically.
  Stated here rather than glossed over.
