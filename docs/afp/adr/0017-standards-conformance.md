# ADR-0017 — Standards conformance: making the compatibility claim true

- **Status:** Accepted in progress — Decision 1 **built** (context live at the
  canonical URL, served as `application/ld+json` with CORS), Decision 2 **built**
  (RFC 9421 native in `httpSig.ts`, cavage shim, double-knocking in `transport.ts`),
  Decision 3 **built** (dereferenced inbox delivery, every advertised URL served,
  paged collections with `@context`, ld+json profile negotiation, and the
  `inbox_log` that gives inbox GET something true to serve);
  Decisions 4–8 open. Drafted from
  [docs/critique-standards-deviation.md](../../critique-standards-deviation.md), the
   2026-08-21 four-source audit of the spec and instance against ActivityPub, AS2,
  JSON-LD, WebFinger, and current fediverse signature practice
- **Date:** 2026-08-21
- **Applies to:** every document any AFP actor emits, every HTTP surface an instance
  serves, and every claim the spec makes about what "plain ActivityPub on the wire"
  means. Acute before any federation with software AFP does not control.
- **Builds on:** [ADR-0001](0001-p1-stack.md) (the cryptosuite this keeps, the Fedify
  decision this amends), [ADR-0008](0008-p4-federation-stack.md) (the draft-cavage
  decision whose revisit trigger has fired), [ADR-0013](0013-authorized-fetch.md) (the
  covered-header discipline this preserves under a new signature scheme),
  [ADR-0014](0014-p5-shared-hub-stack.md) (the membership-proof header this registers
  properly)
- **Driven by:** the standards-deviation critique — not a scenario. The position taken
  here: adhering to the standards AFP names is a future enabler, so every finding is
  resolved by making the claim true rather than by retracting the claim, except where
  the deviation is the design.

## Context

The critique found three kinds of trouble. **Errors**: the `afp:` `@context` cannot
resolve (it lives on an RFC 2606 reserved domain, in two inequivalent forms), a dozen
invented properties are unprefixed and would be dropped by any JSON-LD processor, the
spec contradicts its own accepted ADR about which signature scheme is in force, and
delivery constructs inbox URLs by string concatenation. **Misrepresentations**: WebFinger,
`Follow`/`Accept` enrollment, and the P4 `publicKeyPem` are documented as present and
are not built; ADR-0001 adopts Fedify and the instance has zero dependencies.
**Deviations by design**: `afp:visibility` replaces AP audience semantics, `Update` and
`Announce` are repurposed, custom verbs sit outside the AS2 vocabulary — all defensible,
none stated normatively as deviations.

The through-line is that AFP's architecture is sound — the critique found the
authorized-fetch design, the `eddsa-jcs-2022`/FEP-8b32 choice, and the delivery-honesty
table to be at or ahead of ecosystem practice — but its *interface contract* is not yet
the one it advertises. This ADR commits to the contract.

One framing constraint governs everything below. AFP has two boundaries
(01 § boundaries): the outer one is "plain ActivityPub on the wire, mandatorily." That
sentence is only worth writing if a conformant, non-AFP consumer can process the wire
format without private knowledge. Every decision below is an instance of that test.

## Decisions

### 1. A real, resolvable `@context` — one URL, one mapping, published

The `afp:` context moves from `https://afp.example/ns/v3` to a real, operator-neutral
URL that serves a JSON-LD context document — chosen:
`https://dalager.github.io/agent-federation-protocol/ns/v3.jsonld`, served from this
repository's `docs/ns/v3.jsonld` via GitHub Pages, with the spec pinning its content
(long-term: alongside a FEP, Decision 8). One canonical form, used everywhere:

```json
"@context": ["https://www.w3.org/ns/activitystreams",
             "https://dalager.github.io/agent-federation-protocol/ns/v3.jsonld"]
```

The context document defines the `afp` prefix and **every term AFP uses**, including
the currently unprefixed ones (`status`, `since`, `agent`, `nonce`, `value`, `unit`,
the CRDT-delta shape, agreement fields). The inline-prefix form at 03:702 is removed.
The rule going forward: *a property either belongs to AS2 or appears in the AFP context
document; a bare invented key is a spec bug.*

Alongside this, the spec states the processing model explicitly: **AFP documents are
authored and consumed in compacted form; conformance requires byte-preserving relay of
signed documents** ("store what you verified" generalized to the wire). This is what
`eddsa-jcs-2022` over compacted JSON already assumes; it becomes normative text instead
of an unstated dependency, and it is what makes digest-equal comparison sound.

### 2. RFC 9421 native; draft-cavage becomes the compatibility shim

ADR-0008 chose draft-cavage over RFC 9421 for Mastodon's sake and named "fediverse
migration toward RFC 9421" as its revisit trigger. The trigger has fired (Mastodon 4.7
falls back to 9421; Fedify leads with it), and the critique showed the cavage choice
never bought its stated benefit: the covered-set refusal rejects Mastodon's actual
signatures, and Mastodon needs RSA keys AFP does not publish.

So the transport-auth scheme inverts:

- **Native:** RFC 9421 (`Signature-Input`/`Signature` structured fields), Ed25519,
  `Content-Digest` (RFC 9530), `created`/`expires` parameters.
- **Shim:** draft-cavage emission and verification kept behind double-knocking (try
  9421; on rejection, retry cavage; cache the peer's preference per origin), enabled
  only when Mastodon-facing interop is configured — at which point the instance also
  provisions the second RSA keypair and `publicKey.publicKeyPem` that interop actually
  requires (Decision 4).

ADR-0013's one dangerous detail survives the migration intact: **the covered component
set is still derived from the request method, never from the peer's declaration** — in
9421 terms, a signature whose covered components omit the method-required set is
refused. The hardening was never cavage-specific; it is restated against 9421's
component model.

### 3. Delivery becomes spec-shaped

- The recipient's inbox is **read from the dereferenced actor document**, never
  constructed as `${target}/inbox`. Actor fetches are cached; the cache is keyed by
  actor id.
- Every URL an actor document advertises is served: `GET` on instance and hub
  `outbox`, and `GET` on inboxes for their owners (or the `inbox` property is removed
  where a surface is genuinely absent — an advertised 404 is the one option that goes).
- Served collections carry `@context`, are `OrderedCollection` with
  `OrderedCollectionPage` paging past a size threshold, and `totalItems` is the
  collection's size, with filtering expressed by what the page contains — matching how
  authorized fetch already reasons ("fewer rights, not an error").
- `application/ld+json; profile="https://www.w3.org/ns/activitystreams"` is accepted
  and honored as equivalent to `application/activity+json` on both `Accept` and
  `Content-Type`.

`sharedInbox` and followers-collection fan-out remain out of scope until Decision 6's
deviations section — AFP's addressing model does not use them, and saying so is
Decision 6's job.

### 4. The promised machinery gets built: WebFinger, Follow/Accept, split keys

- **WebFinger** (RFC 7033): `/.well-known/webfinger` answering `resource=acct:…` and
  `resource=https:…` for instance, hub, and agent actors; JRD with the
  `rel="self"`/`application/activity+json` link; HTTPS-only, CORS `*`, 400 for a
  malformed `resource`, 404 for an unknown one. Actors gain `preferredUsername`.
- **Follow/Accept enrollment** becomes what 02 already documents: instance-level
  `Follow` answered by hub `Accept{Follow}` establishes the seat; `afp:Enroll` remains
  the per-agent second level; `Undo{Follow}` mass-unenrolls. The hub stops deriving
  seats implicitly from the enroll trail. Actors gain `followers`/`following`
  collections, which is also what makes the "a Mastodon user can Follow an AFP agent"
  claim in 04 eventually true rather than aspirational.
- **Key separation** per FEP-521a: `assertionMethod` Multikeys remain the
  object-proof keys; transport signing uses a distinct key entry, so the HTTP-signature
  `keyId` no longer resolves to a proof key. The "two key formats, two jobs" sentence
  in 01 becomes true. The doc example mismatch (`#main-key` vs `#ed25519-key`) is fixed
  in passing.

### 5. Namespace hygiene

- `urn:afp:*` is retired in favor of `https:` URIs under the AFP namespace (threads,
  rounds, incidents, assets) — no IANA URN registration debt, and the ids become
  dereferenceable in principle, which is the AP-native shape anyway.
- `/.well-known/afp-policy` and the `afp-membership-proof` header are either submitted
  for registration (RFC 8615 / the HTTP field registry) once the FEP exists, or moved
  off reserved surfaces (`/afp/policy`; an `Afp-Membership-Proof` field name is fine —
  registration is the point, not the casing).
- **NodeInfo** (FEP-f1d5) is served at `/.well-known/nodeinfo` with the standard
  discovery indirection — software name, version, `"protocols": ["activitypub"]`. It
  answers 01's open question about instance self-description with the ecosystem's
  existing answer instead of a bespoke one.
- `afp:bidCommit` is renamed `afp:BidCommit`.

### 6. Deliberate deviations become normative text

A new spec section — **"Deviations from ActivityPub"** — states, as rules rather than
implications:

- `afp:visibility` is the authorization model; AS2 addressing (`to`/`cc`) names
  parties but never grants access, `as:Public`, `bto`/`bcc`/`audience`, sender-side
  followers expansion, `sharedInbox`, and §7.1.2 inbox forwarding are **not part of
  AFP**, and an AFP instance is therefore not a general-purpose AP server at the
  addressing layer. (The decision stands; the silence goes.)
- `Update{afp:CRDTDelta}` and `Update{afp:Asset}` are declared as AFP-defined
  semantics distinct from AP §7.3 replacement — or moved to `afp:`-typed verbs if
  review concludes dual-use of `Update` misleads more than it buys. Same treatment for
  `Announce`-as-call-for-bids; the 04 table row claiming boost-identity is corrected.
- Custom verbs are audited against AS2: where a core activity fits with a `target`
  (`afp:MemberAdmit`/`afp:MemberExpel` against `Add`/`Remove`, `afp:Award` against
  `Accept`), the activity dual-types (`"type": ["Add", "afp:MemberAdmit"]`) per AS2
  Core §5; where nothing fits (`afp:Vouch`, `afp:Enroll`, commit/reveal), the pure
  extension type stays and the deviations section says why.
- The `Offer{afp:Task}` doc/code divergence is resolved (envelope carries
  `afp:visibility` and `context`, matching code), and `Offer` gains its AS2 `target`.

### 7. The prose is reconciled where the ADRs moved

- 01:281 is corrected to match this ADR (9421 native, cavage shim) — the current text
  accidentally predicted this decision and was wrong only about the present tense.
- ADR-0001's Fedify decision is amended (not rewritten): the zero-dependency instance
  is the fact on the ground and has earned its keep through P5; Fedify is re-scoped
  from "adopted" to "the reference implementation to test against," and this ADR's
  conformance surfaces (WebFinger, 9421, delivery) are the parts where Fedify's
  behavior is the interop oracle.
- The "same trust model as WebFinger" analogy at 01:93 is corrected — the roster's
  signed collection is a stronger model, and saying so is better advertising anyway.
- The critique document tracks all of this: each finding's `status:` field moves to
  `fixed-spec`, `fixed-code`, `accepted-deviation`, or `refuted` as work lands, and
  this ADR does not close until no finding reads `open`.

### 8. AFP is written up as a FEP

Following FEP-a4ed, the extension surface (the `afp:` context, the visibility model,
the membership-proof header) is submitted as a Fediverse Enhancement Proposal, with
ForgeFed as the precedent for a domain-specific AP extension. This is sequenced last
deliberately: the FEP is the forcing function that makes Decision 1's context URL
permanent and Decision 5's registrations real, and it is the legitimacy claim the
README's "decade of federation tooling" paragraph is currently borrowing on credit.

## Rejected options

- **Retract the compatibility claim instead** — rewrite the spec as "AP-inspired."
  Cheaper, honest, and it forfeits the stated reason AFP chose ActivityPub at all:
  interop with existing tooling as a future enabler. Rejected on the driving belief.
- **Keep cavage as native and add 9421 later.** Preserves ADR-0008's letter while its
  rationale is known-broken (the covered-set refusal rejects the very peers cavage was
  chosen for). Two schemes are inevitable either way; leading with the dead one is
  spending the migration twice.
- **A bespoke instance-metadata document instead of NodeInfo.** `afp-policy` already
  exists and could grow — but self-description is the one place where a bespoke format
  has negative value; the consumers are by definition not AFP.
- **Registering `urn:afp:`.** An IANA URN NID registration is real work purchasing
  ids that are worse (non-dereferenceable) than the `https:` ones AFP already knows
  how to mint.
- **JSON-LD processing in the instance.** Full expansion/compaction support would make
  the context resolvable question moot from the inside. It re-imports the complexity
  ADR-0001 rejected with the RDF tarpit, for consumers AFP doesn't have; the
  compacted-form processing model (Decision 1) buys conformance without it.

## Consequences

- The instance grows real dependencies or real code: 9421 signing, WebFinger, NodeInfo,
  actor-document delivery resolution, collection paging. The zero-dependency stance is
  no longer a point of pride where it contradicts an accepted decision.
- Two keypairs per actor (proof + transport), three where the cavage/RSA shim is
  enabled. Key custody language in 01 needs a pass.
- The hub's implicit seat derivation is replaced by explicit Follow/Accept state — a
  behavior change to enrollment that needs its own migration note in 02 and a scenario.
- Until Decision 1's context URL is live, every emitted document still carries the
  `.example` context; the critique's finding 1.1 stays `open` and this ADR stays
  Proposed. That is the correct pressure.

## Revisit triggers

- Mastodon or Fedify drop draft-cavage entirely → delete the shim, and ADR-0008's
  signature decision is fully superseded.
- The FEP process stalls or the context URL cannot be made permanent → Decision 1
  falls back to serving the context from each operator's own domain with a
  spec-pinned hash, and digest-equal comparison rules gain a context-equivalence note.
- AS2 successor work in the SWICG produces a vocabulary for typed outcomes or task
  coordination → the `afp:` verbs audit in Decision 6 reruns against it.
