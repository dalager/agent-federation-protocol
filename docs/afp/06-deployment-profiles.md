# 06 — Deployment profiles

Two supported profiles, one architecture. The protocol is designed so that the solo profile
is a *degenerate case* of the federated one — never a fork.

That promise has to be maintained, not just made. Scenario 09 found it broken for
actuation: the solo profile routes almost everything through direct delegation, and the
policy, sufficiency and synthesizer pins were all anchored to an `Announce` that flow does
not produce — so three checks silently did nothing in the profile this page calls
degenerate. ADR-0010 gave the pins a second carrier and replay a second root. The lesson
generalizes past that fix: *degenerate* means fewer activities, never fewer checks, and a
mechanism that only functions when an auction ran has forked the profiles without saying so.

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
   engagement's history is two half-views permanently. The federated replay
   (ADR-0009) makes the pair *jointly checkable* — agreement digest-equal, received
   bytes matched, findings attributed per domain — so the two-export problem
   (finding 29a) costs verification nothing; what remains lost is the single
   canonical archive a hub would host.

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

## Hosting profiles: self-hosted and hosted

The three profiles above are *trust topologies* — who federates with whom. A second
axis, orthogonal to it, is *hosting* — where an instance runs — and it has two values.

**Self-hosted** ([ADR-0032](adr/0032-deployment-profile.md)): one Node process from a
clean checkout, one SQLite file, one writer held by a lock beside the file, ADR-0031's
scheduler ticking in-process, TLS terminated by a proxy the operator runs. The same
process hosts the hubs its policy's `afp:hostedHubs` names, on the same store and the
same scheduler ([ADR-0037](adr/0037-the-served-hub.md)) — hosting a hub is a deployment
fact, not a second deployment. This is the
reference profile: it runs with no account anywhere, and a claim it cannot honour is a
claim the program does not make.

**Hosted** ([ADR-0036](adr/0036-the-hosted-profile.md)): one platform actor per instance
— a single-threaded object with attached SQLite storage, an alarm and a fetch handler,
of which Cloudflare's Durable Objects are the concrete case. Stripped to invariants,
ADR-0032's profile reads *one store, one writer, one clock, one origin, a proxy that
terminates TLS*, and such an actor is that list: the pid lock, the WAL pragma and the
`node:http` server are the self-hosted profile's ways of obtaining what the platform
provides. The instance reaches it through two ports — a store port over plain SQL and a
request port over standard `Request`/`Response` — with the Node runtime as one adapter
of each and the actor as the other, the way the signer port already made key custody an
adapter choice (ADR-0026).

What the hosted profile buys is the shape the self-hosted one cannot: one operator, one
object, and a host holding thousands with no isolation code of its own — an instance
for the practitioner who wants one without wanting a server. What it costs is stated in
the ADR and not softened here: the export stops being a file copy (ADR-0001 Decision 4
deviates under this profile), the platform is a hard dependency, `agent` custody is
unavailable and `remote-issued` custody (ADR-0035) is the baseline, and the attached
storage ceiling is a retention bound to check `afp:retentionDuty` against.

The rule for trust-topology profiles holds across the hosting axis too: **degenerate
means fewer mechanisms, never fewer checks.** Where the platform makes a check
unnecessary — the private-range refusal of ADR-0025, on an edge that cannot reach
private ranges — the profile records `refused-by-platform` in the log rather than
letting the check quietly become nothing. One conformance kit (ADR-0034) gates both
profiles with the same fixtures; a release names which it was gated on.

Every trust topology runs under either hosting profile. The pairing that matters most
is *solo × hosted*: the consortium of one, on an object it never operates.

## Designing for per-subject disclosure

Some deployments owe a trace to a *person* rather than to a counterparty: the EU AI Act
duty that motivates [scenario 09](scenarios/09-the-screening-sidecar.md), a subject access
request, a regulator asking what was decided about one applicant. The export machinery does
not have that axis. ADR-0009's scope grammar cuts an export on **thread, visibility, or
agreement**, and none of those three is a data subject — so whether a subject-scoped export
is even possible is decided by how a deployment laid out its threads, long before anyone
asks for one. Two rules follow, and both are design-time or never (finding 32).

**Where disclosure is per-subject, the thread SHOULD be the subject-scoped unit.** One
case, one `context`. Then the existing grammar already produces the export the duty
demands, with no new mechanism and no per-request judgement: thread-scoped export, other
threads become digest-only stubs (ADR-0009), the chain stays linkable, and the pins the
answer was judged under travel with it (ADR-0010 Decision 5). A deployment that instead
runs one long thread per *caseworker*, per shift, or per batch has made subject-scoped
disclosure structurally impossible — redaction operates on activities, an activity belongs
to exactly one thread, and there is no cut that separates two subjects sharing one.

**Cross-thread carriers SHOULD carry no subject content.** Application-defined CRDT stores
(02), the settlement trail and the reputation registers it feeds (ADR-0004) are keyed by
task, agent or asset — never by thread — so there is no cut to make in them at all. Keep
them to references: ids, digests, counts, scores. The moment one holds a subject's name, a
case summary, or a free-text note, that content is outside every scope the export grammar
can express, and the honest answer to "produce this subject's record, and only this
subject's" becomes *no*.

That second rule is sharper than it looks, because two later decisions pull in opposite
directions. ADR-0012 Decision 4 keeps CRDT state **out** of the bundle and makes the
omission checkable by declaring the bundle's content inventory. ADR-0015 Decision 3 then
lets `afp:Archive` carry the hub's converged state **into** the record, once, at the moment
it stops changing — because at P5 that state *is* the coordinated timeline a regulator
asks about. Both are right. Together they mean a store's contents are excluded right up
until the hub closes, and then published wholesale: a store that accumulated subject
content quietly for the life of an engagement discloses it all at archive time, to everyone
holding the case file. Deciding what may go in a hub-scoped store is therefore a disclosure
decision taken at design time, not a storage decision taken per write.

Neither rule is machinery, and neither is enforced — a protocol cannot inspect what a
deployment means by a thread. What the protocol does guarantee is that the choice is
visible: the content inventory says what a bundle contains, and the thread structure is
plain in the record. State the layout you chose, and why, next to your retention duty
(ADR-0012) — a deployment that never wrote it down has usually not made the choice. That
place is now `afp:threadLayout` on the signed policy document
([ADR-0033](adr/0033-operator-obligations.md) Decision 1).
