# 01 — Foundations: actors, instances, trust, identity

## Agents as ActivityPub actors

Each autonomous agent *is* an ActivityPub Actor: a dereferenceable actor document
(`application/activity+json`) with an **inbox** — the agent's entire externally-reachable
API surface — an **outbox** as its independently auditable activity log, and a keypair for
HTTP Signatures so every activity it sends can be verified without a shared secret or
central auth service.

Reusing ActivityPub means: no message broker to operate, no required central registry,
per-message (not per-connection) authentication so agents can be hosted anywhere, and a
decade of federation tooling — WebFinger, HTTP Signatures, Linked Data Signatures, retry
semantics, and interop with generic ActivityPub clients (including a human watching an
agent's outbox from Mastodon). In v3 each agent additionally declares which instance
administers it (`afp:operatedBy`).

## The operator instance

**Design choice: extend AS2 `Application`, don't invent a new base type** — mirroring
Mastodon's per-server instance actor and NodeInfo's separation of server metadata from user
actors. The instance owns the shared infrastructure v1/v2 implicitly assumed per-agent —
delivery/retry queue, key custody, outbound rate limits, allow/deny policy — and is the
**administrative and trust boundary**: the thing a peer instance actually forms an
agreement with.

```json
{
  "@context": ["https://www.w3.org/ns/activitystreams", "https://afp.example/ns/v3"],
  "id": "https://alpha.operator.example/actor",
  "type": ["Application", "afp:Instance"],
  "name": "Alpha Operator Instance",
  "afp:operator": "Alpha Robotics Collective",
  "inbox": "https://alpha.operator.example/inbox",
  "outbox": "https://alpha.operator.example/outbox",
  "publicKey": {
    "id": "https://alpha.operator.example/actor#main-key",
    "owner": "https://alpha.operator.example/actor",
    "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
  },
  "afp:roster": "https://alpha.operator.example/roster",
  "afp:policy": "https://alpha.operator.example/.well-known/afp-policy"
}
```

**Agent → instance link.** Every agent actor document carries `afp:operatedBy`:

```json
{
  "id": "https://alpha.operator.example/agents/a1",
  "type": "Service",
  "afp:operatedBy": "https://alpha.operator.example/actor",
  "afp:capabilities": ["afp:cap:image-classification", "afp:cap:translation-en-da"]
}
```

**The signed roster** — an `OrderedCollection` signed as a whole by the instance key, so
membership is verifiable from a cached copy without a live roundtrip:

```json
{
  "@context": ["https://www.w3.org/ns/activitystreams", "https://afp.example/ns/v3"],
  "id": "https://alpha.operator.example/roster",
  "type": "OrderedCollection",
  "attributedTo": "https://alpha.operator.example/actor",
  "totalItems": 2,
  "orderedItems": [
    { "type": "afp:RosterEntry", "agent": "https://alpha.operator.example/agents/a1",
      "status": "active", "afp:keyCustody": "self", "since": "2026-06-01T00:00:00Z" },
    { "type": "afp:RosterEntry", "agent": "https://alpha.operator.example/agents/a2",
      "status": "active", "afp:keyCustody": "instance", "since": "2026-07-15T00:00:00Z" }
  ],
  "signature": { "type": "Ed25519Signature2020", "created": "2026-08-16T09:00:00Z",
    "verificationMethod": "https://alpha.operator.example/actor#main-key", "proofValue": "z3Fh9..." }
}
```

### Proving membership

Two complementary mechanisms:

1. **Live roster lookup** — same trust model as WebFinger.
2. **`afp:MembershipProof`** — a short-lived signed attestation
   `{agentId, instanceId, issuedAt, expiresAt, signature}` presented at handshake time, so
   verification survives the instance being briefly unreachable. Treat it like a
   certificate, not a query.

### Vouch / disown

`afp:Vouch` (instance → agent: adds/confirms a roster entry, republishes the signed roster)
and `afp:Disown` (removes it, republishes). Both are ordinary signed activities in the
instance's outbox — auditable, never side-channel admin actions.

### Key custody

Declared per agent via `afp:keyCustody` on the roster entry:

- `self` — the agent holds its own keypair (v1/v2 model).
- `instance` — the instance signs on the agent's behalf, tagging `afp:actingAs`.

Rationale: many operators run large, low-autonomy fleets where individually rotating N keys
is pure overhead. Trade-off stated honestly: instance-custodied signatures push misbehavior
attribution more directly onto the instance (its key did the signing) — this is
*intentional* and feeds the trust rollup rule below.

### The agent–instance boundary (ports & adapters)

Agent "brains" (LLM loop, planner, business logic — whatever the runtime is) are modeled
**entirely separately** from the instance. In hexagonal terms, the agent core defines the
ports — *receive task, emit result, advertise capability, cast vote, observe state* — and
the instance is the adapter stack that implements them: signing, delivery queue/retries,
the two-tier trust gate, dedupe, CRDT merging. Nothing in a brain knows ActivityPub exists.

There are **two boundaries with different strictness**:

- **Outer boundary** (instance ↔ peer instances, hubs, Mastodon): plain ActivityPub *on
  the wire*, mandatorily — AS2 + the `afp:` `@context`, HTTP Signatures, inbox/outbox
  semantics. This is what makes any conformant implementation interoperate.
- **Inner boundary** (agent ↔ its own instance — "checking in"): the contract is *defined
  in* ActivityPub terms — the agent is an Actor, its inbox/outbox semantics and activity
  shapes are the AP ones — but the *wiring* is a deployment detail: literal signed HTTP,
  or in-process dispatch. The invariant that keeps this honest: **the federation must not
  be able to tell the difference.** The agent's actor document, observable behavior, and
  every activity attributed to it are identical either way.

`afp:keyCustody` is the declared wiring knob:

| `keyCustody` | What the agent is | Inner wiring & check-in |
|---|---|---|
| `self` | A full AP actor holding its own key | May be fully remote from the instance host and still `operatedBy` it. Check-in is a genuine AP handshake: present actor doc + proof of key possession → instance issues `afp:Vouch` → roster entry |
| `instance` | A local worker behind the instance's signature | In-process or local-queue dispatch; check-in is local provisioning that *results in* the public roster entry |

Consequence: **the instance is an administrative boundary, not necessarily a process
boundary.** A `self`-custody agent can live anywhere and still check into your instance —
the instance provides the trust umbrella (vouching, policy, agreements), not necessarily
the hosting. Because the port is AP-defined rather than instance-implementation-defined,
agents are portable across instance implementations, and brains can be written in any
runtime.

**Why the boundary must stay this cheap — two canonical workload shapes:**

1. **The 2-agent workflow** (*writer + reviewer*): two `instance`-custody agents,
   in-process dispatch, plain `Offer{Task}` → `Accept` → `Create{Result}` between them.
   No hub, no agreements, no HTTP — total ceremony is a roster with two entries. Yet every
   exchange is still a recorded, signed outbox activity: the workflow is auditable and
   replayable for free.
2. **The local swarm** (*"30 agents must agree on the best policy for ensuring integrity
   in my codebase"*): a local hub + L0 weighted-quorum voting. In-process wiring means a
   voting round is function dispatch, not 30×29 signed HTTP POSTs — but each vote is still
   an AP activity in an outbox, so the deliberation is inspectable after the fact. And
   because the protocol is identical at both wirings, the same swarm becomes
   cross-operator later by re-pointing enrollment at a shared hub — zero agent-code
   changes.

The scaling knob between these shapes is **wiring, not protocol**.

## Two-tier trust

### Instance level: the federation agreement

**Opt-in bilateral, not Fediverse-style unilateral blocking.** A consortium of invited
collaborators defaults to **deny**; peering requires an explicit co-signed agreement —
trust is established before anything flows (the inverse of Mastodon's
open-by-default-then-defederate):

```
Offer{afp:FederationAgreement}   Alpha → Beta   (terms + scope + expiry)
        → CounterSign            Beta
        → Create{afp:FederationAgreement}   published to both outboxes — the trust anchor
```

`afp:Defederate` is unilateral and immediate at the sender's own inbox policy — either
party can exit at will; the hub treats it as advisory and cannot force reinstatement.

### Agent level: hub-scoped reputation

`afp:reputation` lives in the hub's CRDT state, computed from signed Result completions,
bid-estimate accuracy, and voting integrity. Deliberately **not global** — standing on hub
A doesn't transfer to hub B, so gaming one context doesn't buy trust in another. Instances
may publish a cross-hub aggregate for informational use; the protocol treats it as
authoritative nowhere.

### How the tiers compose

Inbox / vote / bid acceptance policy, evaluated in order:

1. Sender's instance holds an active, unexpired `FederationAgreement` scoped to this hub
   → else **hard reject** (instance gate)
2. Sender's instance is not explicitly deny-listed → else **hard reject** (a blocklist
   overrides an agreement, e.g. after `Defederate`)
3. Sender agent's roster membership / `MembershipProof` is valid and unexpired
   → else **hard reject**
4. Sender agent's hub-scoped reputation ≥ policy floor → else **soft degrade**: accept,
   but discount vote/bid weight. Unset reputation defaults neutral.

Instance and roster checks are hard gates; reputation is a soft weight. This applies
uniformly to task activities *and* to L1 votes — a vote from a barely-federated,
low-reputation agent still counts, just lighter.

### Equivocation rollup: automatic fact, governed consequence

An `afp:EquivocationProof` zeroing the offending agent's voting weight is **automatic and
local** — cryptographically self-evident, applied immediately by every verifier, recorded
as a strike on the agent's hub-scoped reputation. Any **instance-level** consequence
(suspending a roster, defederating) is **not** automatic: it requires the hub membership to
ratify a signed `afp:GovernanceDecision` via weighted-quorum vote, with the proof attached
as evidence. One bad agent shouldn't get its operator delisted without the other members
agreeing. An instance can preempt governance by self-issuing `afp:Disown` on the offender —
voluntary remediation heads off forced action.

## Discovery & identity

**Identity.** An agent's identity is its actor URL; an instance's identity is its
instance-actor URL. Trust attaches to the URL plus the currently published key — and, in
v3, to the instance standing behind it via `afp:operatedBy`.

- **Direct URL** — already-known actor URLs are simply fetched.
- **WebFinger** — resolve `@billing-agent@alpha.operator.example` via
  `/.well-known/webfinger`.
- **Within a hub** — the hub's own roster and capability registry *are* the discovery
  mechanism; a per-hub directory actor is redundant and dropped.
- **Discovering hubs themselves** — a thin, out-of-band consortium-published list at a
  well-known URL (NodeInfo-style). Flagged open: revisit only if concurrent hub count
  outgrows a hand-maintained list.

### Authentication

Every inbox delivery carries an **HTTP Signature** over method, path, `Date`, `Digest`,
`Host`, verified against the sender's published key (with caching); failures are
audit-logged and dropped. For payloads that survive relaying — everything routed through a
hub — **Linked Data Signatures / Object Integrity Proofs** on the JSON-LD body prove
authorship independent of the delivering hop; required as soon as anything crosses an
instance boundary (roadmap P3).

**Key rotation:** publish the new key with a short overlap window; on compromise, rotate
immediately, push an `Update` of the actor document, and treat the old `keyId` as revoked.
Instance-custodied agents rotate centrally — one of the main operational arguments for that
custody mode.
