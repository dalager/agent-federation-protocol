# 06 — Deployment profiles

Two supported profiles, one architecture. The protocol is designed so that the solo profile
is a *degenerate case* of the federated one — never a fork.

## Federated consortium (the default story)

Multiple operator instances, bilateral `FederationAgreement`s, shared problem-scoped hubs —
everything in this spec, phases P1–P7.

## Solo / airgapped: the consortium of one

A solo operator hosting an airgapped deployment runs **a local `afp:Instance` and one or
more local `afp:Hub`s, co-located** — same server, typically the same process: the hub is a
route (`/hub/*`) mounted next to the agent actors (`/agents/*`), not a second system.

### Why run a local hub with only one operator

1. **The hub is nearly free.** It's just another actor — inbox, outbox, a CRDT store —
   sharing the deployment's existing delivery queue and state store.
2. **Uniform code paths — the real payoff.** Agents discover each other via the hub
   roster, publish capabilities into hub-scoped CRDTs, optionally allocate via
   announce/bid/award — *identically* to the federated case. Joining a consortium later is
   purely additive: sign a `FederationAgreement`, enroll a subset of agents in a remote hub
   alongside the local one. No federation refactor, ever.
3. **Problem-scoping is useful solo.** Three concurrent problems → three local hubs:
   separated state, per-problem capability enrollment, per-problem contribution summaries.
   Hubs are an *organizational* unit that happens to also be the federation unit.
4. **Local bidding is real load balancing.** When several local agents share a capability,
   announce/bid/award against the local hub is a scheduler — bids carry load/latency
   estimates, and estimate-vs-actual feedback tunes selection over time.

### Degenerate simplifications (dropped, not forked)

| Mechanism | Federated | Solo / airgapped |
|---|---|---|
| `FederationAgreement` | Required, bilateral, deny-by-default | None — the trust gate short-circuits on `operatedBy == self` (do **not** model a self-agreement) |
| L1 Byzantine voting | Triggered at ≥2 operators in a hub | Skipped — one trust domain means equivocation defense defends against yourself. Stay at L0; governance quorum-of-one auto-passes |
| LD-Signatures on relayed payloads | Required from P4 | Skipped — the relay is you |
| DNS / TLS | Public DNS, public CA | Internal DNS, private CA — or plain HTTP inside the gap |
| HTTP Signatures + signed outboxes | Required | **Keep.** See below — this is the one thing an airgapped deployment must not drop |

### Keep signing everything — the sneakernet property

AFP's data model is signed, immutable, self-contained activities: nothing in the
verification path requires the network that delivered the bytes. Keeping HTTP Signatures
and signed outboxes inside the airgap therefore buys two things:

1. **Reconnection with evidence intact.** An airgapped instance that later joins a
   consortium can present its signed outbox history and L1-style certificates; contribution
   evidence survives the gap.
2. **Sneakernet federation.** Two airgapped sites can federate *offline*: periodically
   export signed outbox bundles + CRDT deltas to removable media, import and verify on the
   other side. CRDT merges are order-tolerant and idempotent, so batch import "just works";
   direct task delegation across the gap degrades to whatever the physical exchange cadence
   allows, with `Task` deadlines sized accordingly.
3. **Audit-grade anchoring.** Chained outbox logs (`afp:prevActivity`, see
   [04 — Audit & provenance](04-operations.md#audit--provenance)) protect against bugs and
   accidental corruption — but a solo operator holds every key and store, so history is
   not tamper-evident *against yourself*. For audit-grade deployments, periodically anchor
   chain heads outside the trust domain: write-once media, a timestamping service, or
   shadow Notes (carrying the chain-head hash) federated to an external Mastodon server.

### Where visibility ends: the port boundary

Visibility classes ([07](07-visibility-and-artifacts.md#audience--visibility)) scope
**the record** — who may read which published activity. They do not scope what an agent's
*brain* has seen: a brain that reads confidential inputs to ground a published answer has
seen them, whatever the answer cites (a rate card consulted for an estimate, client terms
behind an assumption). What a brain may say about what it read is **operator policy at
the port boundary** (01 — ports & adapters), not protocol machinery — prompt discipline,
adapter-side redaction, or restricting which stores an adapter materializes. Deployments
handling confidential inputs should state that policy as explicitly as they state their
visibility defaults; the protocol is honest about where its guarantee ends (ADR-0004,
from scenario 05).

## The pairwise profile: federation without a hub

Scenario 08 proved a third profile by walking it: two operators, one agreement, direct
delegation — recognition without rendezvous. It is coherent, already half-real (P4a *is*
this profile), and worth choosing deliberately, because what it gives up is precise.

The reason it works at all is a property 02 already states: the hub has **no unilateral
power beyond availability** — it can censor or go dark, never forge. The hub was never a
trust anchor; it is an actor. So everything whose guarantee is *replay* survives its
absence: direct delegation, settlement and bilateral standing, even sealed bidding — an
announcer can run its own auction, pinning rule and window and recomputing the Award
from the reveals, and an announcer-auctioneer can censor commits no more and no less
detectably than a hub can (the bidder's own outbox proves what was sent either way).
The neutral party never bought integrity; it bought reach.

What the profile gives up, in order of how much it hurts:

1. **The electorate.** A quorum needs a defined voter set, and the voter set *is* hub
   membership — the Enroll trail, the pinned snapshot, the per-operator seats
   (ADR-0005). Without it there is no answer to "who gets to vote," and everything
   downstream collapses: rounds, `DecisionRecord`, `afp:MemberAdmit`/`Expel`,
   ratification and therefore ratification parity (ADR-0007), Byzantine machinery at
   n≥3. Multi-party governance degrades to diplomacy — pairwise contracts cannot bind
   a third party.
2. **Discovery.** No capability registry means delegating only to firms already known;
   a bid pool is an address book, and "push a question to the hub and let coverage
   decide" (scenario 04) has nowhere to be pushed.
3. **Commons reputation.** Bilateral standing accumulates fine (scenario 08 settles);
   a *shared* settlement trail that a third operator's selection can consume
   (ADR-0004) has nowhere to live. Alpha's history with Bravo cannot inform Gamma's
   choice.
4. **O(n) coordination.** k counterparties means k(k−1)/2 agreements to negotiate,
   renew and expire, and pairwise state sync — against 02's NAT reality, where two
   firewalled instances often have no inbound path to each other and hub relay is the
   answer. A "dumb relay" fix is a hub with fewer features.
5. **The canonical case file.** Archive-as-record (07) has no single home; an
   engagement's history is two half-views permanently — the two-export problem
   (finding 29a) as a way of life rather than a transition.

What it gains: no hub host and none of the hosting politics (scenario 03's "hosted on
Alpha's infrastructure" is a soft power position); agreements that map one-to-one onto
contracts a lawyer can read; and — underrated — **metadata privacy**: a hub sees the
coordination graph of all its members (who asked, who bid, how often) even when
payloads travel direct, while a pairwise mesh shows each pair's pattern only to that
pair.

The boundary of the profile is one sentence: **a hub is what you call the place where
an electorate keeps its membership.** Everything else a hub does is convenience that
pairwise machinery replaces at O(n²) cost. Federating without one works for exactly as
long as every question has at most two parties; the first decision that must bind
three is the moment a membership record exists, whatever it gets called. The adoption
path this implies is the profile's best argument: start pairwise on P4a — one
counterparty, one agreement, the smallest first bite — and add a hub the day an
electorate is needed, not before.

### Profile → phase mapping

Since v3.5 the phases are ordered so that **every profile is a prefix, never a subset** —
the solo operator stops, rather than skipping around:

| Profile | Phases |
|---|---|
| **Solo / airgapped** | P1 → P3 (single instance, local hub and L0 deliberation, local allocation), then stop |
| **Pairwise** | P1 → P4 (recognition and direct cross-operator delegation, no shared hub), then stop |
| **Federated consortium** | P1 → P7 in order |

That ordering is possible because the hub machinery, L0 deliberation and announce/bid/award
have **no federation dependency** — they are useful to one operator on day one, and
everything genuinely bilateral (agreements, LD-Signatures, hub relaying, L1, contribution
accounting) sits behind them. A solo deployment that later joins a consortium continues from
P4; it does not revisit P1–P3.

One optional exception, in the additive direction: dual-publish shadow Notes (nominally P4)
need no agreement and may be switched on at any phase, since they are the cheapest external
anchor for outbox chain heads — see above.
