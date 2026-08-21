# AFP standards-deviation critique

**Date:** 2026-08-21
**Scope:** `docs/afp/` spec + ADRs, `src/instance/` reference implementation, `src/verifier/`
**Checked against:** ActivityPub (W3C REC 2018), ActivityStreams 2.0 Core + Vocabulary, JSON-LD 1.1, WebFinger (RFC 7033), draft-cavage / RFC 9421 HTTP signatures, FEP corpus, W3C Data Integrity.

**Working stance:** AFP is not fully implemented yet. Every claim below must be either **refuted** (shown wrong, with evidence) or **fixed** (in spec prose, code, or both). Adhering to these standards is treated as a future enabler, not optional polish. Each finding carries a status field to track disposition.

Status legend: `open` | `refuted` | `fixed-spec` | `fixed-code` | `accepted-deviation` (deviation kept, but documented normatively as such).

---

## Overall verdict

AFP's self-description is honest and mostly accurate — it frames itself as "AS2 + an `afp:` extension context" with ActivityPub as a thin transport shim, and its ADRs consciously record their deviations. But the corpus contains one class of genuine spec-correctness problems (JSON-LD), several doc/code contradictions where the prose promises standard machinery that was never built, and a handful of places where standard AS2/AP semantics are quietly replaced rather than extended.

---

## 1. Errors — things that are actually wrong

### 1.1 The JSON-LD story doesn't hold together — `status: fixed-spec` + `fixed-code`

**Resolution (2026-08-21, ADR-0017 Decision 1):** the context document now exists at
`docs/ns/v3.jsonld`, canonical URL
`https://dalager.github.io/agent-federation-protocol/ns/v3.jsonld` — **live and
verified**: GitHub Pages serves it with `Content-Type: application/ld+json` and
`Access-Control-Allow-Origin: *`. It defines the `afp` prefix and all previously
unprefixed terms, with `@id`/`xsd:dateTime` coercions for load-bearing properties. All
docs, code, tests, fixtures, and the export now use the one canonical URL; the inline
Form-B example in `03-coordination.md` is canonicalized. `01-foundations.md` gains
normative text for the compacted-form processing model and byte-preserving relay of
signed documents. Original finding follows.

The most substantive finding.

- The `@context` used everywhere (`["https://www.w3.org/ns/activitystreams", "https://afp.example/ns/v3"]`, e.g. `docs/afp/01-foundations.md:30`, `src/instance/src/ap/documents.ts:19`) points at a context document that doesn't exist and *can't* exist — `afp.example` is an RFC 2606 reserved domain. Under real JSON-LD expansion, every `afp:` term silently drops (AS2 Core §5 / JSON-LD §3.2: keys that expand to no IRI are not Linked Data and are discarded).
- One example (`docs/afp/03-coordination.md:702`) instead defines the prefix inline as `{"afp": "https://afp.example/ns/v3#"}` — a *different* mapping, so the two context forms within the same spec are inequivalent.
- **Unprefixed invented properties** — `status`, `since`, `agent` on roster entries (`ap/documents.ts:205-208`), `nonce`, `value`, `unit`, and the whole CRDT-delta shape (`key`, `fieldType`, `adds`, `removes`, `element`, `tag`, `tombstoneTags`, `02-hubs-and-state.md:122-128`), plus `parties`/`grants`/`expiry` on agreements — are undefined under the AS2 context and get dropped by any JSON-LD-aware consumer. AS2 Core §5: publishers SHOULD provide context definitions for all extension terms.
- The signing design (`eddsa-jcs-2022` over compacted JSON) makes digest equality depend on **byte-identical compaction**, which JSON-LD does not guarantee. The "digest-equal agreement in both bundles" rule (`04-operations.md:139-142`) silently depends on this; it is stated nowhere.

**Fix directions:** publish a real, resolvable `@context` document on a real domain with one canonical prefix mapping; prefix or define every invented property; *or* normatively declare that AFP documents are plain JSON in a fixed compacted form and JSON-LD processing is out of scope (several fediverse projects do exactly this — but it must be said).

### 1.2 Internal contradiction on HTTP signatures — `status: fixed-spec` + `fixed-code`

**Resolution (2026-08-21, ADR-0017 Decision 2):** RFC 9421 is now the native scheme in
`httpSig.ts` (structured `Signature-Input`/`Signature`, Ed25519, RFC 9530
`Content-Digest`, `created`/`expires`), draft-cavage survives as the verify-side shim
and double-knock fallback. `01-foundations.md:281` and ADR-0008 (amended in place) now
agree with each other and with the code. Original finding follows.

`01-foundations.md:281` says "**HTTP Signature** (RFC 9421; draft-cavage for legacy peers)". ADR-0008 (accepted, `adr/0008-p4-federation-stack.md:98-101`) decides the opposite — draft-cavage *instead of* RFC 9421 — and the code implements only draft-cavage (`federation/httpSig.ts`). Line 281 is stale relative to the accepted ADR and the built code.

### 1.3 The cavage rationale is self-defeating as built — `status: fixed-code` (partially; RSA/Mastodon interop still future)

**Resolution (2026-08-21, ADR-0017 Decision 2):** the rationale inversion is resolved by
inverting the scheme — RFC 9421 native, cavage as shim, double-knocking with per-origin
preference cache in `transport.ts`. The covered-set discipline is preserved in both
schemes (restated against 9421's component model). Point (b) — RSA keys for actual
Mastodon interop — remains future work, tied to Decision 4's Mastodon-facing stage.
Original finding follows.

ADR-0008 chose draft-cavage *for Mastodon compatibility*, but:

- (a) the verifier **rejects any signature whose `headers` list differs from the method-derived set** (`httpSig.ts:135-141`). Mastodon signs `(request-target) host date digest content-type`, so a real Mastodon signature is refused outright. The inversion is a deliberate, well-argued hardening (ADR-0013 Decision 1: prevents signature-stripping downgrade) — but it forfeits exactly the interop that justified rejecting RFC 9421.
- (b) AFP publishes only Ed25519 Multikeys in `assertionMethod`; Mastodon requires RSA `publicKey.publicKeyPem`.
- (c) the Mastodon delivery path is explicitly unimplemented (`federation/visibility.ts:219-229`).

Also, `algorithm="hs2019"` with Ed25519 is not what Mastodon accepts.

### 1.4 Delivery resolves inboxes by string concatenation — `status: open`

`federation/transport.ts:32` POSTs to `${target}/inbox` instead of dereferencing the target actor document and reading its `inbox` property (AP §7.1 requires resolving the recipient's inbox). Works between AFP instances by convention; breaks against essentially every real fediverse actor. No `sharedInbox` support; no recipient discovery from `to`/`cc`/`bto`/`bcc`/`audience` (only `to` is ever emitted, `ap/activities.ts:37`).

### 1.5 Advertised URLs that 404 — `status: open`

Actor documents publish `inbox`/`outbox` for the instance and hub actors, but the server routes neither `GET /actor/outbox`, `GET /hubs/:id/outbox`, nor any `GET .../inbox` (`ap/server.ts:152-266`). AP §4.1 requires actors' inbox/outbox to be dereferenceable OrderedCollections. Additionally, the one outbox that *is* served (`/agents/:name/outbox`) lacks `@context`, has no paging (AP §5.1 recommends paged collections), and its `totalItems` reflects the post-filter count rather than the collection size (`ap/server.ts:204-209`).

### 1.6 Doc/code shape divergence on `Offer{afp:Task}` — `status: open`

The spec example puts `afp:visibility` and `context` on the **object** (`03-coordination.md:12-37`); the code puts both on the **activity envelope** (`ap/activities.ts:39-40`).

### 1.7 Media type — `status: open`

Only bare `application/activity+json` is produced/accepted (`ap/server.ts:26`, `federation/transport.ts:40`). AP §3.2 requires servers to respond to `Accept: application/ld+json; profile="https://www.w3.org/ns/activitystreams"`; treating the two as equivalent is a SHOULD. Plain-JSON handling of the profile parameter is absent.

---

## 2. Misrepresentations — promised standard machinery that doesn't exist

### 2.1 WebFinger claimed, entirely unimplemented — `status: open`

Claimed at `01-foundations.md:13`, `01:269-270`, `README.md:179` (architecture diagram), `README.md:212` ("v1 baseline"), `05-roadmap.md:34`. No `/.well-known/webfinger` route, no `acct:` URI (RFC 7565) anywhere in docs or code, no JRD, no `rel="self"` link. Also `01:93`'s "same trust model as WebFinger" is backwards: WebFinger is unauthenticated DNS+TLS trust; AFP's roster is a signed collection — a stronger, different model.

If implemented, honor RFC 7033: HTTPS only, CORS `*`, 400 for malformed `resource`, 404 (not empty JRD) for unknown, JRD with `rel=self` + `application/activity+json` link.

### 2.2 `Follow`/`Accept` enrollment documented, not implemented — `status: open`

The documented two-level enrollment (instance `Follow` → hub `Accept`, then per-agent `afp:Enroll`; `02-hubs-and-state.md:10-33`) collapses to one level in code: hub seats are derived from the `afp:Enroll` trail alone (`hub/hub.ts:539-542`). `Undo{Follow}` mass-unenrollment (`02:33`, `02:180-186`) does not exist. No actor has `followers`/`following` collections, so "any Mastodon user can `Follow` an AFP agent directly" (`04-operations.md:506-507`) is aspirational. AP §7.5 also expects a `Follow` recipient to respond with `Accept`/`Reject` delivered back to the follower.

### 2.3 ADR-0001 adopts Fedify; the code has zero dependencies — `status: open`

ADR-0001 Decision 3 (`adr/0001-p1-stack.md:75-92`) adopts Fedify specifically to inherit WebFinger, the inbox pipeline, double-knocking, and Mastodon quirks. `src/instance/package.json` declares no dependencies; everything is hand-rolled on Node builtins. The ADR is unamended.

### 2.4 `publicKeyPem` promised at P4, never shipped — `status: open`

`01-foundations.md:48-54` says an instance adds `publicKey`/`publicKeyPem` at P4. The code (P4/P5 built per ADR-0008/0014/0016) instead resolves HTTP-Signature `keyId` against `assertionMethod` Multikey entries (`federation/inbox.ts:86-103`, `federation/readGate.ts:93-112`). Consequence: **one key serves both object proofs and transport auth**, contradicting the spec's own "two key formats, two jobs" framing — cross-protocol key reuse is a real, if modest, cryptographic hygiene concern. FEP-521a (multiple keys via Multikey/`assertionMethod`) is the clean fix.

### 2.5 Roster example's proof cannot verify — `status: open`

The roster proof references `verificationMethod: …#main-key` (`01:85`) while the actor publishes `…#ed25519-key` (`01:38`).

---

## 3. Deviations by design — defensible, but must be stated normatively as deviations

### 3.1 `afp:visibility` replaces AP audience semantics — `status: open`

`https://www.w3.org/ns/activitystreams#Public` appears nowhere; `bto`/`bcc`/`audience` are never produced or consumed (`readGate.ts:137` reads only `to`/`cc`); delivery fan-out from addressing — sender-side followers expansion (AP §7.1, a MUST), `sharedInbox` (§7.1.3), and the §7.1.2 inbox-forwarding MUST — is absent. Coherent for a closed federation, but AFP is therefore *not* AP-interoperable at the addressing layer; the spec should say so explicitly instead of implying compatibility. (`07-visibility-and-artifacts.md:16-24` abolishes addressing inference deliberately — the decision is fine, the framing as AP-compatible is not.)

### 3.2 `Update` as a CRDT-delta carrier — `status: open`

AP §7.3 S2S Update means replacement of the object; AFP's `Update{afp:CRDTDelta}` (`02:110-131`) and `Update{afp:Asset}` (`07:146-148`) carry deltas where the object of the activity is not the object being updated.

### 3.3 `Announce` repurposed — `status: open`

AS2 `Announce` is share/boost ("calling attention to"). AFP uses `Announce{afp:Task}` as a call-for-bids (`03:467`) and `Announce{afp:EquivocationProof}` as an accusation (`03:695`). `04-operations.md:538`'s claim that hub fan-out ≡ Mastodon boost, "identical mechanism, reused as-is", is an overstatement — the announced object is a custom type Mastodon drops.

### 3.4 Custom top-level activity verbs — `status: open`

`afp:Enroll`, `afp:Vouch`, `afp:Award`, `afp:MemberAdmit`, `afp:MemberExpel`, `afp:bidCommit`, … are top-level activity types outside the AS2 vocabulary. AS2 Core §5: an extension type overlapping a core type MUST also specify the core type (dual-typing, e.g. `["Offer", "afp:Bid"]`); Vocab §3 note: avoid extension types that unduly duplicate existing vocabulary. Some AFP verbs genuinely have no AS2 counterpart; others duplicate it (`afp:MemberAdmit`/`afp:MemberExpel` ≈ `Add`/`Remove` with `target`; `afp:Award` ≈ `Accept`). Also `afp:bidCommit` breaks the type-capitalization convention every other type follows (`03:184`).

### 3.5 Unregistered namespace minting — `status: open`

Never acknowledged in the docs:

- `/.well-known/afp-policy` — RFC 8615 expects IANA registration of well-known URI suffixes.
- `urn:afp:*` (`urn:afp:thread:*`, `urn:afp:round:*`, `urn:afp:incident:*`, `urn:afp:asset:*`) — RFC 8141 requires IANA registration of URN NIDs. (A `tag:` URI or an `https:` URI namespace avoids the problem entirely.)
- `afp-membership-proof` request header (`ap/server.ts:145-149`, ADR-0014) — unregistered, and deliberately outside the signature's covered set.

### 3.6 Legacy `Digest` header — `status: fixed-code`

**Resolution (2026-08-21):** the native scheme sends RFC 9530 `Content-Digest`; the
legacy `Digest` header now appears only in the cavage shim, where it belongs. Original
finding follows.

`Digest: SHA-256=<base64>` (RFC 3230, `httpSig.ts:84`) rather than RFC 9530 `Content-Digest`. Consistent with draft-cavage, but dated; resolves itself with an RFC 9421 migration.

### 3.7 Minor AS2 shape issues — `status: open`

- Roster `orderedItems` contain `afp:RosterEntry` objects with no `id` — AS2 collections should contain Objects/Links (transient objects without `id` are legal, but referenced entries deserve ids).
- `Reject` reason carried in `summary` (`03:39`) — `summary` is a natural-language summary of the object; stretch, not illegal.
- `Offer{afp:Task}` omits `target` (AS2 Offer = "offering object *to target*"); recipient rides only in `to`. The `afp:Enroll` example does use `target`.
- `afp:cap:image-classification` — a CURIE with a second colon expands to `…/v3#cap:image-classification`; legal but unusual.

---

## 4. What AFP gets right (no action; keep)

- **Authorized fetch (ADR-0013)** is stronger and more coherent than Mastodon's: per-visibility-class gating, 404-not-403 on reads, unsigned = anonymous rather than error, the unauthenticated key-bootstrap invariant, `Cache-Control: private, no-store`. The docs correctly note authorized fetch is a Mastodon convention, not part of the AP spec.
- **FEP-8b32 object integrity proofs + `eddsa-jcs-2022` + Multikey** is exactly where the ecosystem converged (Mastodon 4.7 now verifies eddsa-jcs-2022 proofs). Rejecting RDF canonicalization in favor of JCS (RFC 8785) matches current practice.
- `Accept` correctly takes the prior `Offer` activity — not the task — as its `object` (`ap/activities.ts:101`).
- The delivery-reliability table (`04-operations.md:448-459`) is an accurate, honest account of what AP delivery does and doesn't provide.
- The `eddsa-jcs-2022` proof construction (`crypto/proof.ts:11-16`: hash(proofConfig) ‖ hash(document−proof), proofValue = `z`+base58btc) matches W3C VC-DI-EdDSA.

---

## 5. Ecosystem inspiration / forward path

1. **RFC 9421 with double-knocking.** The fediverse is mid-migration: Mastodon 4.7 emits cavage and falls back to RFC 9421; Fedify tries 9421 first and caches peer preference. ADR-0008's own revisit trigger ("fediverse migration toward RFC 9421") has arguably fired. A greenfield protocol should be RFC 9421 + Ed25519 + `Content-Digest` native, with cavage as an optional compatibility shim — which also dissolves the Mastodon-RSA wart (a second RSA keypair only where cavage interop is wanted).
2. **FEP-521a** — multiple actor keys via Multikey/`assertionMethod`; formal adoption fixes the transport/proof key-reuse issue (§2.4).
3. **FEP-2677** — identifying the Application (instance) actor; AFP has the concept natively, aligning costs nothing.
4. **NodeInfo (FEP-f1d5)** — serve real `/.well-known/nodeinfo` beside `afp-policy`; cheap interop and self-description win.
5. **Write AFP up as a FEP** (per FEP-a4ed). ForgeFed proves the domain-specific-AP-extension pattern; a FEP forces publication of a real, resolvable `@context` (fixing §1.1) and buys legitimacy.
6. **Tooling to study/steal:** Fedify (actor dispatch, WebFinger, delivery, double-knocking done right), ActivityPub Test Suite + ActivityPub Fuzzer (conformance testing), Digit (minimal correct WebFinger), apsig (HTTP sigs + integrity proofs in one library).

---

## 6. Highest-leverage fixes, in order

1. **Publish a real, resolvable `@context`** on a real domain with one canonical prefix mapping, and prefix or define every invented property — or normatively declare plain-JSON/fixed-compaction semantics and state the byte-stability requirement the signing design depends on (§1.1).
2. **Reconcile doc/code contradictions**: either build WebFinger / `Follow`+`Accept` / distinct transport keys, or amend `01-foundations.md`, ADR-0001, and `02-hubs-and-state.md` to match what is built (§§1.2, 2.1–2.4). Given the intent to implement fully, prefer building; amend ADRs where the design has genuinely moved.
3. **Revisit ADR-0008's cavage decision** (§1.3, §5.1): its Mastodon rationale is contradicted by the covered-set refusal and Ed25519-only keys, and the ecosystem trigger it named has occurred. Target RFC 9421 native.
4. **Make delivery spec-shaped**: dereference recipient inboxes from actor documents; serve every advertised inbox/outbox URL; add `@context` and paging to served collections (§§1.4, 1.5).
5. **Document every deliberate deviation normatively** (§3) — a "Deviations from ActivityPub" section in the spec, so compatibility claims are precise.

---

*Provenance: compiled from a four-agent research pass — an exhaustive claims inventory over `docs/afp/` + `src/` (with file:line citations), and normative distillations of ActivityPub, AS2 Core/Vocabulary + JSON-LD, and WebFinger/HTTP-signature/FEP ecosystem practice. Key code claims (transport inbox concatenation, covered-set refusal, absence of `as:Public`, the stale RFC 9421 line) were independently spot-checked.*
