# 01 — Foundations: actors, instances, trust, identity

## Agents as ActivityPub actors

Each autonomous agent *is* an ActivityPub Actor: a dereferenceable actor document
(`application/activity+json`) with an **inbox** — the agent's entire externally-reachable
API surface — an **outbox** as its independently auditable activity log, and a keypair for
HTTP Signatures so every activity it sends can be verified without a shared secret or
central auth service.

Reusing ActivityPub means: no message broker to operate, no required central registry,
per-message (not per-connection) authentication so agents can be hosted anywhere, and a
decade of federation tooling — WebFinger, HTTP Signatures, object-integrity proofs (the
Data Integrity successor to Linked Data Signatures), retry
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
  "@context": ["https://www.w3.org/ns/activitystreams", "https://dalager.github.io/agent-federation-protocol/ns/v3.jsonld"],
  "id": "https://alpha.operator.example/actor",
  "type": ["Application", "afp:Instance"],
  "name": "Alpha Operator Instance",
  "preferredUsername": "instance",
  "afp:operator": "Alpha Robotics Collective",
  "inbox": "https://alpha.operator.example/actor/inbox",
  "outbox": "https://alpha.operator.example/actor/outbox",
  "following": "https://alpha.operator.example/actor/following",
  "assertionMethod": [{
    "id": "https://alpha.operator.example/actor#ed25519-key",
    "type": "Multikey",
    "controller": "https://alpha.operator.example/actor",
    "publicKeyMultibase": "z6Mkf...ffbq"
  }],
  "authentication": [{
    "id": "https://alpha.operator.example/actor#transport-key",
    "type": "Multikey",
    "controller": "https://alpha.operator.example/actor",
    "publicKeyMultibase": "z6Mkg...ttq2"
  }],
  "afp:roster": "https://alpha.operator.example/roster",
  "afp:policy": "https://alpha.operator.example/afp/policy"
}
```

The policy document has moved off the reserved `.well-known` space it occupied in earlier
revisions (`/.well-known/afp-policy` → `/afp/policy`). Registering a name under
`.well-known` is RFC 8615 territory — the FEP's job once one exists, not something an
instance claims for itself by squatting the path — so the canonical location is ordinary,
and the old path stays served as an alias through the transition (ADR-0017 Decisions 5
and 8).

**Two key formats, two jobs** (ADR-0017 Decision 4). `assertionMethod` publishes a
**Multikey**, which is what `eddsa-jcs-2022` object integrity proofs verify against —
required from P1, because proofs are what survive an export. HTTP Signatures verify
against a second Multikey, `#transport-key`, published under `authentication` — the same
shape as the assertion key, a distinct key. Resolution is **authentication-first, with an
assertionMethod fallback** kept open as a compatibility window for actor documents that
have not yet published a dedicated transport key. Publishing only `assertionMethod` — as
earlier revisions of this example did — still verifies today through that fallback, but
leaves object-integrity and transport-authentication uses sharing one key indefinitely,
which the second key exists to end. A `publicKey`/`publicKeyPem` entry is a different
thing again: the RSA key the Mastodon-facing draft-cavage shim would need, since Mastodon's
HTTP Signature implementation expects RSA rather than Ed25519. That shim is not built; the
entry appears only if and when it is provisioned.

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
  "@context": ["https://www.w3.org/ns/activitystreams", "https://dalager.github.io/agent-federation-protocol/ns/v3.jsonld",
               "https://w3id.org/security/data-integrity/v1"],
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
  "proof": { "type": "DataIntegrityProof", "cryptosuite": "eddsa-jcs-2022", "created": "2026-08-16T09:00:00Z",
    "verificationMethod": "https://alpha.operator.example/actor#ed25519-key", "proofPurpose": "assertionMethod", "proofValue": "z3Fh9..." }
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

**The roster is a projection, not a source.** It is derived by replaying the instance's own
`Vouch`/`Disown` trail, and signed as a convenience so members can check it without walking
that trail. An implementation that assembles a roster straight from configuration has made
admission exactly the side-channel act this rule exists to prevent: the membership verifies,
but *how an agent came to be a member* is unrecorded and unauditable. The instance therefore
has an outbox of its own from P1 onward, and it is part of the export.

Because a roster is derived, it must be **byte-stable** between reads: regenerating it with
a fresh timestamp on every fetch yields a different signature each time, which an auditor
comparing two copies cannot distinguish from tampering. Its `created` is the time of the
last membership change, not the time of the request.

### Key custody

Declared per agent via `afp:keyCustody` on the roster entry:

- `self` — the agent holds its own keypair (v1/v2 model).
- `instance` — the instance signs on the agent's behalf, tagging `afp:actingAs`.
  Verifiers — including a peer's boundary at P4 — check the proof against the
  **operator's** published keys (the `afp:operatedBy` actor document), never the
  agent's: the activity says whose work it is; the proof says whose key vouched.

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
Offer{afp:FederationAgreement}   Alpha → Beta   (parties + grants + expiry)
        → CounterSign            Beta
        → Create{afp:FederationAgreement}   published to both outboxes — the trust anchor
```

"Countersign" is **dual-Create, not multi-signature** (ADR-0008): each party publishes
its *own* signed `Create` over a byte-identical agreement object, whose digest is the
agreement's identity. An agreement is **active** only while an instance holds both
Creates over digest-equal objects and `afp:expires` has not passed — one Create is an
offer on the record, not a permission. The agreement's scope is a list of **grants**:
a `hub` grant admits traffic addressed to the named hub, a `direct-delegation` grant
admits the P1 delegation flow on named capabilities, and grants never cross-admit —
the gate checks each activity against the grant that admits it, never "some grant
exists." The narrowest real federation — one counterparty, named capabilities, no hub
— states its own scope (scenario 08, finding 25).

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

1. An active, unexpired `FederationAgreement` with the sender's instance holds a
   **grant admitting this activity** (hub grant for hub traffic, delegation grant for
   direct delegation — ADR-0008) → else **hard reject** (instance gate)
2. Sender's instance is not explicitly deny-listed → else **hard reject** (a blocklist
   overrides an agreement, e.g. after `Defederate`)
3. Sender agent's roster membership / `MembershipProof` is valid and unexpired
   → else **hard reject**
4. Sender agent's hub-scoped reputation ≥ policy floor — **defined as skipped for
   direct-delegation traffic** (no hub, no reputation to weigh; an undefined check in a
   hard-gate sequence is how implementations fork — ADR-0008) → else **soft degrade**: accept,
   but discount vote/bid weight. Unset reputation defaults neutral.

> **Found by building it.** Admission must reach all the way in. The first P4
> implementation ran this gate correctly and then handed the admitted activity to the
> *internal* receive path, whose own roster check — built when every sender was local —
> rejected any foreign actor; and its boundary proof check verified instance-custody
> activities against the *agent's* keys instead of the operator's (`afp:actingAs`,
> 01 — Key custody), 401-ing legitimate traffic. Both failures were masked by honest
> machinery: the dead-letter produced a signed `afp:Error` that closed the thread
> plausibly, and the record verified green. The rule the fix generalizes: a
> gate-admitted foreign actor is exactly what the boundary exists to admit — checks
> downstream of the gate must distinguish "unknown locally" from "unauthorized."

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
  `/.well-known/webfinger` (ADR-0017 Decision 4), served for both `acct:` and URL resource
  queries per RFC 7033: 400 on a malformed resource, 404 on an unknown one, `Access-Control-
  Allow-Origin: *`, `application/jrd+json`. The instance actor itself resolves under the
  literal username `instance` (`@instance@alpha.operator.example`).
- **Within a hub** — the hub's own roster and capability registry *are* the discovery
  mechanism; a per-hub directory actor is redundant and dropped.
- **Discovering hubs themselves** — a thin, out-of-band consortium-published list at a
  well-known URL (NodeInfo-style). Flagged open: revisit only if concurrent hub count
  outgrows a hand-maintained list.
- **Self-description** — the instance itself now serves real NodeInfo 2.1 at
  `/.well-known/nodeinfo`, per FEP-f1d5: the standard discovery indirection, software name
  and version, `"protocols": ["activitypub"]` (ADR-0017 Decision 5). Self-description is
  the one place where inventing a bespoke document would have negative value — every
  consumer of it is, by definition, not AFP — so it reuses the ecosystem's format rather
  than adding one of its own.

### Authentication — two mechanisms with different lifetimes

| Mechanism | Authenticates | Lives |
|---|---|---|
| **HTTP Signature** (RFC 9421 native — `Signature-Input`/`Signature`, Ed25519, `Content-Digest`; draft-cavage emitted only as the double-knock fallback for legacy peers, ADR-0017 Decision 2) | One hop — method, authority, path, `Date`, and the body digest for requests that carry one | Consumed on receipt; never appears in an outbox |
| **Object integrity proof** (FEP-8b32, `eddsa-jcs-2022`) | The activity itself | Travels with the activity permanently, including through export |

The distinction decides what a *replay* can check. A third party handed an exported outbox
never sees an HTTP Signature — it was consumed by a transport that no longer exists. Only
the object integrity proof survives. So **every activity carries a proof from P1 onward**,
while HTTP Signatures become mandatory at P4, when there is first a real hop to
authenticate: an instance whose agents are wired in-process has no hop to sign, and its
record is identical either way. Failures at either layer are audit-logged and dropped,
never processed.

**The `afp:` context and the processing model** (ADR-0017 Decision 1). The extension
context is published at
`https://dalager.github.io/agent-federation-protocol/ns/v3.jsonld` (source:
`docs/ns/v3.jsonld` in this repository) and is referenced in exactly one canonical form —
`["https://www.w3.org/ns/activitystreams", "<context-url>"]`, the AS2 context first. The
context defines the `afp` prefix (so every `afp:*` term resolves by compact-IRI
expansion, which AS2 Core § 5 requires extension-supporting consumers to perform) and
gives explicit definitions to AFP's unprefixed terms (`agent`, `status`, `since`,
`nonce`, `value`, the CRDT-delta fields, agreement fields). The rule: a property either
belongs to AS2 or appears in the AFP context document — a bare invented key is a spec
bug.

Two processing rules are normative. **AFP documents are authored and consumed in
compacted form** — implementations read literal keys and are not required to run JSON-LD
expansion. And **signed documents are relayed byte-for-byte**: `eddsa-jcs-2022` signs
the JCS canonicalization of the compacted document, so a re-compaction that changes
serialization breaks digest equality. "Store what you verified, not a re-serialization"
(04 § replay) applies on the wire, not only in the archive.

**Cryptosuite: `eddsa-jcs-2022`.** EdDSA signing, SHA-256 hashing, and JSON Canonicalization
Scheme (RFC 8785) canonicalization, per FEP-8b32. Chosen deliberately over the
RDF-canonicalization suites (`Ed25519Signature2020`, `eddsa-rdfc-2022`): JCS is essentially
key-sorting and is implementable in any language in a couple of hundred lines, which is what
keeps an *independent* verifier cheap — and an independent verifier is what makes the audit
claim worth anything. Documents carrying a proof include
`https://w3id.org/security/data-integrity/v1` in their `@context`.

**Key rotation — and why it is not revocation** (ADR-0012). Publish the new key with a
short overlap window and push an `Update` of the actor document. What must *not* happen is
the thing this section used to prescribe — treating the old `keyId` as revoked. Rotation
and revocation are opposite claims about the past:

- **Rotation archives.** The superseded key keeps its validity interval; everything it
  signed while valid verifies forever. Retiring a key is not a statement that its
  signatures were lies.
- **Revocation cuts.** A compromised key's interval is terminated at the compromise
  instant, and anything signed after that instant fails.

Conflating them strands the corpus: `instance` custody means one key signs everything, so
a single routine rotation would retroactively invalidate every activity that key ever
signed, for a verifier resolving keys from the current — now rewritten — document. The
actor document remains the source of *current* trust; an export's `afp:keyHistory`
(04 § The manifest) is the source for *old* signatures, carrying each key's interval and
`afp:retiredBy`. Instance-custodied agents rotate centrally — one of the main operational
arguments for that custody mode, and the reason getting this distinction right matters
more here than in a per-agent-key deployment.
