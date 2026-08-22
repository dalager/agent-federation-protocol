# ADR-0017 Decision 4 — Execution Plan

Work packages for cheap executors (Sonnet subagents / local model). Architecture
calls R1–R5 are FIXED — executors must not revisit them.

## Pre-decided architecture calls (executors must NOT revisit these)

**R1 — Key separation: transport keys live under `authentication`, fragment `#transport-key`, with an assertionMethod fallback kept for verification.**
Each actor gains a second Ed25519 keypair, published as a Multikey under the actor document's top-level `authentication` property (a real controller-document verification relationship whose purpose is exactly transport auth; `assertionMethod` stays proof-only, per FEP-521a's spirit). Key material reuses the existing pattern from `loadOrCreateHubKeyPair` (`src/instance/src/crypto/keys.ts:180-195`): wrap `loadOrCreateKeyPair(keyDir, "<name>--transport", controller)` and override `keyId` to `${controller}#transport-key`. **Signing side switches entirely to the transport key** (transport.ts deps, all test GET signatures in new tests). **Verifying side resolves keyId against `authentication` first, then falls back to `assertionMethod`** — this is what keeps the 135 existing tests green (they sign hops with the proof key) and keeps the bootstrap intact (actor docs stay unauthenticated; nothing about resolution order changes the regress). The fallback is documented in 01 as a compatibility window, not the contract. Do NOT make `extractKeyId` reject proof keys — the ADR's "no longer resolves to a proof key" is satisfied on the emission side plus doc contract; hard-rejecting breaks backward compat.

**R2 — Hub seat state: constructor option `seatPolicy: "follow-required" | "enroll-implies-seat"`, defaulting to `"enroll-implies-seat"`.**
Under `enroll-implies-seat` today's behavior is byte-identical (the `instances` LWW map at `hub.ts:539-548` still fills from the Enroll). Under `follow-required`, `onEnroll` rejects (via the existing `logAdmission` path) any Enroll whose issuer has no active seat row. Seats are persisted in a new `hub_seats` table (hub/store.ts pattern). New ADR-0017-D4 tests and demos run `follow-required`; 02 gets a migration note saying `follow-required` becomes the default in the next phase. Chosen because flipping the default now would force rewriting every hub test that enrolls without Follow.

**R3 — Follow/Accept semantics.** `Follow{actor: instanceActor, object: hubActorId}` published by the instance actor, visibility `"public"` (it is governance trail, same class as Vouch/Disown). Hub records the seat and replies `Accept` whose `object` is the *Follow activity id* (mirrors the existing Accept-takes-the-Offer convention). `Undo{Follow}` (object = the original Follow activity id, plus `target` naming the hub for cheap resolution) revokes the seat and mass-unenrolls every agent whose `instanceOf(agent)` equals the follower. `Follow` and `Undo` join the door-knock class in `Hub.writeAdmitted` (`hub.ts:332-344`) — the boundary gate (agreements) is unchanged: cross-operator Follow still rides an existing FederationAgreement, consistent with 02.

**R4 — WebFinger usernames.** `preferredUsername`: instance actor → the literal `"instance"`; agent → its spec `name`; hub → its `hubId`. `acct:` lookup order: `instance` → instance actor; else agent name; else hub id. `resource=https:` accepts any of the three actor ids verbatim. Route is unauthenticated (discovery surface, same class as `/actor`).

**R5 — followers/following are derived collections, served publicly** (they are the seat/governance record, same publicity rationale as the roster): hub `followers` = actor ids with active seats; instance `following` = replay of its own Follow/Undo trail from the outbox. Served through the existing `collectionDocument` (server.ts:67) — widen its `items` parameter type to `unknown[]` so plain id strings are legal items. Advertise only what exists: hub → `followers`, instance → `following`.

---

## Work packages

### WP1 — Transport keypair plumbing (crypto + instance) — *Sonnet*
Files: `src/instance/src/crypto/keys.ts`, `src/instance/src/instance.ts`.
- keys.ts: add `export function loadOrCreateTransportKeyPair(keyDir, name, controller): KeyPair` — exactly the `loadOrCreateHubKeyPair` pattern, file suffix `--transport`, keyId `${controller}#transport-key`. (~10 lines.)
- instance.ts: in the constructor, alongside each existing `keys.set(...)`, also set `"@instance:transport"` and `"<agent>:transport"` entries. Add `transportKey(name: string): KeyPair` accessor mirroring `key()`.
Acceptance test (in WP6 file): `transport key id ends with #transport-key and differs from the proof key id`.

### WP2 — Actor documents: `authentication`, `preferredUsername`, followers/following links — *mechanical; small local model OK*
File: `src/instance/src/ap/documents.ts` (+ call sites in `instance.ts`, `hub/hub.ts` where `hubActor(...)` is invoked).
- `instanceActor(origin, operator, name, key, transportKey: KeyPair)` → adds `preferredUsername: "instance"`, `authentication: [multikey(transportKey)]`, `following: ${id}/following`.
- `agentActor(origin, spec, key, hubKeys, transportKey)` → `preferredUsername: spec.name`, `authentication: [multikey(transportKey)]`.
- `hubActor(origin, hubId, key, operatedBy?, transportKey?)` → `preferredUsername: hubId`, `followers: ${id}/followers`, `authentication` when transportKey given.
- Update the three call sites (`instance.ts` `instanceDocument`/`agentDocument`; `hub/hub.ts` where it builds its document) to pass the new key. Hub: create its transport key with `loadOrCreateTransportKeyPair(keyDir, `hub-${hubId}`, actorId)` next to its existing key load.
Depends on WP1. New properties are additions; if any document-snapshot test fails, update fixtures (flag to Sonnet if non-trivial).

### WP3 — keyId resolution: authentication-first — *Sonnet (security-adjacent)*
Files: `src/instance/src/federation/inbox.ts` (lines 85–103), `src/instance/src/federation/readGate.ts` (`resolveRequester`, ~90–120).
- Factor a shared helper (new file `src/instance/src/federation/resolveTransportKey.ts`, <60 lines): `transportKeyFromDocument(doc, keyId): KeyObject | null` — scan `doc.authentication` entries first, then `doc.assertionMethod`, matching `id === keyId`, decode via `publicKeyFromMultibase`. Replace the two inline loops with calls to it. **Object-proof verification (`proofVerifies` in inbox.ts, `verifySignature` in hub.ts) stays assertionMethod-only — do not touch.**
- `transport.ts`: no code change (it takes `keyId`/`privateKey` deps); WP3 updates every production wiring of `httpTransport` deps (demos `demoP4/P5.ts`, anywhere `instance.key("@instance")` feeds transport deps) to `instance.transportKey(...)`.
Depends on WP1/WP2. Parallel with WP4.

### WP4 — WebFinger — *mechanical; small local model OK*
Files: new `src/instance/src/ap/webfinger.ts` (~120 lines), edit `src/instance/src/ap/server.ts` (one route beside `/actor`).
- `export function webfingerResponse(deps: {origin: string, instanceUsername: "instance", agentNames: string[], hubIds: string[]}, resourceParam: string | null): { status: 200|400|404; body: unknown }`.
- Semantics: no/unparseable `resource` → 400 `{error:"malformed resource"}`; `acct:user@host` where host ≠ origin host → 404; known subject → 200 JRD:
```json
{ "subject": "acct:d3@127.0.0.1:PORT",
  "aliases": ["https://.../agents/d3"],
  "links": [{ "rel": "self", "type": "application/activity+json", "href": "https://.../agents/d3" }] }
```
  `resource=https:...` form: subject echoes the resource, same links. Content-Type `application/jrd+json`, header `Access-Control-Allow-Origin: *`.
- server.ts: `if (path === "/.well-known/webfinger") return` handler (GET only), passing `url.searchParams.get("resource")`. Unauthenticated. Note: `send()` sets negotiated AP content type — pass explicit `"application/jrd+json"` and set the CORS header via `res.setHeader` before `send`.
Tests (WP6): 400 on missing resource; 404 on unknown acct; 200 JRD for instance (`acct:instance@host`), agent, hub, and the `https:` form; CORS header present; content type `application/jrd+json`.
Parallel with WP3.

### WP5 — Follow/Accept enrollment at the hub — *Sonnet (the one genuinely stateful WP)*
Files: `src/instance/src/hub/store.ts`, `hub/hub.ts`, `hub/activities.ts`, `ap/activities.ts`, `instance.ts`, `ap/server.ts`.
1. `hub/store.ts`, add to `ensureHubSchema`:
```sql
CREATE TABLE IF NOT EXISTS hub_seats (
  instance_actor TEXT PRIMARY KEY,
  follow_activity TEXT NOT NULL,
  followed_at TEXT NOT NULL,
  revoked_at TEXT            -- NULL while the seat is live
);
```
   plus `saveSeat(db, actor, followId, at)`, `revokeSeat(db, actor, at)`, `liveSeats(db): string[]`, `hasSeat(db, actor): boolean` (revive on re-Follow: upsert clearing `revoked_at`).
2. `ap/activities.ts`: builders `follow(envelope, target)` → `{...base(envelope,"Follow"), object: target}`; `undoFollow(envelope, followActivityId, target)` → `{...base(envelope,"Undo"), object: followActivityId, target}`.
3. `instance.ts`: `followHub(hubActorId): OutboxEntry` → publish-as-instance to `[hubActorId]`, thread `urn:afp:thread:seats`, visibility `"public"`; `unfollowHub(hubActorId)` finds its own latest prior Follow in the outbox and publishes the Undo; `followingIds(): string[]` replays Follow/Undo for `/actor/following`.
4. `hub/hub.ts`:
   - `HubDeps` gains `seatPolicy?: "follow-required" | "enroll-implies-seat"` (default `"enroll-implies-seat"`).
   - `dispatch`: BEFORE the existing `Accept` line, add `if (type === "Follow") return this.onFollow(activity);` and `if (type === "Undo") return this.onUndoFollow(activity);`.
   - `onFollow`: object must equal this hub's actor id; actor must be an instance actor per its fetched document (same `Application`/`afp:Instance` check as inbox.ts:154). `saveSeat`. Publish `Accept` through the hub's existing publish machinery (reuse the envelope/attachProof/outbox/queue path used by existing hub emissions; every published activity needs proof + `afp:visibility` or `outbox.append` throws): new builder in `hub/activities.ts` `acceptFollow(envelope, followActivityId, follower)` → `{...base, type:"Accept", object: followActivityId, to:[follower]}`, visibility `"public"`.
   - `onUndoFollow`: resolve the referenced Follow (by `target` naming this hub, or lookup in `hub_seats.follow_activity`); actor must equal the seated instance; `revokeSeat`; for every member agent with `instanceOf(agent) === actor`, run the unenroll logic (extract the body of `onUnenroll` into a private `removeAgent(agent, byActor, activityId)` so both call it).
   - `onEnroll`: after the ADR-0005 issuer check, `if (seatPolicy === "follow-required" && !hasSeat(db, origin)) { logAdmission(..., "rejected", "no seat: instance has not Followed this hub (ADR-0017 D4)"); return; }`.
   - `writeAdmitted`: extend the door-knock allowance: `if (type === "Follow" || type === "Undo") return true;`.
   - `followers(): string[]` → `liveSeats(this.db)`.
5. `ap/server.ts`: two GET collection routes: `/hubs/:id/followers` (extend the `hubs` option entry type with optional `followers?(): string[]`) and `/actor/following` over `instance.followingIds()`; both public (R5), both via `collectionDocument` (widen items to `unknown[]`).
Run WP5 sequentially AFTER WP2 and WP4 (textual collisions in server.ts/instance.ts).

### WP6 — Tests — *Sonnet; three files parallel once WP5 lands*
Copy the `adr0017-d3.test.ts` harness (freePort/serve/jumpClock/workspace).
- `adr0017-d4-webfinger.test.ts`: WP4 cases + `actor documents carry preferredUsername matching the JRD subject`.
- `adr0017-d4-keys.test.ts`: assertionMethod proof-only + authentication carries `#transport-key`; hop signed with transport key admitted at inbox (202, real socket); hop signed with legacy proof key still admitted (compat fallback); read gate resolves a GET signed with the transport key (owner reads own inbox log).
- `adr0017-d4-follow.test.ts` (in-process hub, `seatPolicy: "follow-required"`): Follow establishes seat + hub answers Accept{Follow} (object = follow id, to = instance actor, proof present); Enroll without seat rejected (admission log names the reason); Follow → Enroll seats and enrolls + `/hubs/:id/followers` lists the instance over HTTP; Undo{Follow} revokes and mass-unenrolls only that instance's agents; re-Follow revives; default seatPolicy still enrolls without Follow (compat proof); `/actor/following` lists the hub after followHub.
Run: `node --experimental-sqlite --test src/instance/test/adr0017-d4-*.test.ts`, then the full suite (135 must stay green).

### WP7 — Documentation reconciliation — *mechanical; each file independent*
- `docs/afp/01-foundations.md`: fix roster example `#main-key` → `#ed25519-key` (~line 85); rewrite "Two key formats, two jobs" (~48-54): assertionMethod Multikey = object proofs; `authentication` Multikey `#transport-key` = HTTP signatures; `publicKeyPem` appears only when the cavage/RSA Mastodon shim is provisioned. Add `preferredUsername` + `following` to the instance-actor example; note WebFinger is served.
- `docs/afp/02-hubs-and-state.md`: migration note after "Enrollment is two-level": implementations MAY run `enroll-implies-seat` during transition; `follow-required` is the conformant target, reference instance flips its default next phase. Document Accept's object = the Follow activity.
- `docs/afp/adr/0001-p1-stack.md`: dated amendment block under Decision 3 (per ADR-0017 Decision 7): Fedify re-scoped from "adopted" to "the reference implementation to test against"; conformance surfaces name Fedify as the interop oracle. Do not rewrite the original text.
- `docs/critique-standards-deviation.md`: resolution blocks — 2.1 → fixed-code; 2.2 → fixed-code + fixed-spec; 2.3 → fixed-spec (after the ADR-0001 amendment); 2.4 → fixed-code (publicKeyPem stays tied to the future Mastodon shim — say so); 2.5 → fixed-spec.
- `docs/afp/adr/0017-standards-conformance.md`: status header — Decision 4 built, Decision 7 partially.
- `docs/ns/v3.jsonld`: likely zero change (Follow/Accept/Undo/preferredUsername/followers/following/authentication are AS2/security vocab); verify no new `afp:` terms.

## Sequencing

```
WP1 ──► WP2 ──► WP3 ──┐
                WP4 ──┼──► WP5 ──► WP6 ──► WP7 (statuses)
(WP7 doc-only parts: 01 roster fix, ADR-0001 amendment — parallel with everything)
```
Token economy: WP2, WP4, WP7 are mechanical (local model with this spec verbatim); WP1 is trivial; WP3, WP5, WP6 need Sonnet.

## Risk flags (resolutions fixed above)
- Key separation vs bootstrap → R1. Never make verification transport-key-only in this change.
- Hub seat migration → R2. Default flip is a later, separate change with its own 02 note.
- File-size ceilings: server.ts gains ~60 lines (keep WebFinger in webfinger.ts); hub.ts is already ~957 lines — keep seat persistence in store.ts, or extract `hub/seats.ts` (Sonnet judgment).
