# 06 — Deployment profiles

Two supported profiles, one architecture. The protocol is designed so that the solo profile
is a *degenerate case* of the federated one — never a fork.

## Federated consortium (the default story)

Multiple operator instances, bilateral `FederationAgreement`s, shared problem-scoped hubs —
everything in this spec, phases P1–P6.

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
| LD-Signatures on relayed payloads | Required from P3 | Skipped — the relay is you |
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

### Profile → phase mapping

| Profile | Phases |
|---|---|
| **Solo / airgapped** | P1 + the hub machinery from P3 (local-only, no LD-Sigs, no hub-relay concerns) + optionally P5 bidding. Skip P2 and P4 entirely. |
| **Federated consortium** | P1 → P6 in order. |

The hub machinery has **no federation dependency** — a solo deployment can adopt it
immediately after P1. Only P3's cross-boundary parts (LD-Signatures, hub-relayed state
sync) and P2/P4 are federation-specific.
