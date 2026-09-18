# ADR-0035 — Remote custody: what an operator actually wants from an HSM, and what the asynchronous port would cost

- **Status:** Built in part (2026-09-18) — Decisions 2, 3, 5 built; Decision 4 costed and
  deliberately unscheduled; completes program claim **C2** of
  [ADR-0024](0024-the-road-to-production.md), the one adapter
  [ADR-0026](0026-key-custody-and-the-signer-port.md) left unbuilt; group: **Security**
- **Date:** 2026-09-04
- **Applies to:** `crypto/signer.ts`, every path that signs, and the operator who has to
  answer "where does your instance key live"
- **Builds on:** [ADR-0026](0026-key-custody-and-the-signer-port.md) Decisions 1–2 (the
  signer port, the file and agent adapters, rotation as a command),
  [ADR-0012](0012-the-long-horizon.md) Decisions 1–2 (versioned key ids, validity
  intervals, `afp:keyHistory`, the rotation/revocation distinction),
  [ADR-0025](0025-transport-hardening.md) Decision 2 (the fetch policy every outbound
  request now crosses), [ADR-0001](0001-p1-stack.md) (zero dependencies, and therefore
  no typechecker)
- **Driven by:** ADR-0026's revision-under-contact note, which deferred the `remote`
  adapter to "the asynchronous port" without costing either the port or the adapter — and
  which, measured, turns out to have overstated the cost by about a third and to have
  specified the wire contract in a way Ed25519 cannot honour; and, since,
  [scenario 15](../scenarios/15-the-production-tuesday.md) finding **98** — on a served
  instance, custody improved by one word (file custody with a passphrase on the same
  disk), and this ADR is the sentence's only remaining answer

## Context

ADR-0026 built the signer port and two of its three adapters. `remote` was deferred with
one sentence: it needs `sign(bytes): Promise<Uint8Array>`, and the port was made
synchronous because async "would turn the whole signing core async". That sentence was
never checked. Three things are now measured rather than asserted.

**The blast radius was overstated.** The note claimed actor-document construction — 99
call sites in synchronous HTTP handlers — would have to become async. It would not:
`instanceActor`, `agentActor` and `hubActor` assemble documents out of *public* halves
and never sign. `signedRoster` is the only document builder that signs. The true surface,
counted:

| Path | Signs? | Call sites (src + test) |
|---|---|---|
| `attachProof` | the primitive | 18 |
| `publish` / `publishAsInstance` / `emit` | yes | ~200 |
| `rosterDocument()` → `signedRoster` | yes | 11 |
| `exportBundle` (the manifest) | yes | 69 |
| `signRequest` / `signRequestCavage` | yes | 28 |
| `instanceDocument()` / `agentDocument()` / hub `actorDocument()` | **no** | 115 — unaffected |

**Two structural facts decide the shape, not the count.** `httpTransport.deliver` is
already `async`, so HTTP-signature signing costs almost nothing to make async; and every
GET handler in `ap/server.ts` already runs inside an `async` IIFE, so serving a signed
roster costs nothing either. Against that, `AfpInstance`'s **constructor** signs:
`provision()` publishes the `Vouch` trail, so a fully async port turns construction into
`await AfpInstance.open(...)` — a change to the shape of every test and demo, not just to
the count. 122 synchronous `it(...)` callbacks would gain `async`.

**The repository has no typechecker.** Node strips types; there is no `tsc` step and, by
ADR-0001, no dependency to add one. A 300-site async migration in a codebase with no
compile-time check for a forgotten `await` is a materially different proposition from the
same migration in a typechecked repo: the failure mode of a missed `await` is a `Promise`
stored where an activity belonged, which the gate catches only where a gate happens to
look. This is the single strongest argument in what follows.

**And the specified wire contract cannot work.** ADR-0026 Decision 1 describes the
adapter as "`POST /sign` with the bytes' digest". Ed25519 signs a *message*, hashing it
internally as part of the algorithm; there is no mode in which signing a caller-supplied
digest yields a signature that verifies over the original bytes (Ed25519ph exists, is a
different algorithm, and is not what `eddsa-jcs-2022` names). The adapter must send the
bytes. For object proofs that is 64 bytes — `proofConfigHash || documentHash` — so the
correction costs nothing; but a service built to the sentence as written would have
produced signatures that never verify.

Underneath all of it sits a question the ADR never asked: **what does an operator actually
want from remote custody?** Not, in most cases, "every signature crosses the network".
What they want is that a stolen host cannot sign indefinitely, and that they can say where
the key lives. Those are different requirements with very different costs, and only one of
them needs a promise.

## Decisions

### 1. Two custody modes, because they answer two different threats

| Mode | Threat answered | Cost |
|---|---|---|
| **`remote-issued`** (Decision 2) | A stolen host can sign only until the current short-lived key expires | One async call per rotation. No change to the signing core |
| **`remote`** (Decision 4) | A stolen host can never produce a signature at all; the private key provably never exists outside the HSM | The asynchronous port — ~300 call sites, a constructor that becomes a factory, and no typechecker to catch a missed `await` |

An operator who wants "our keys are in a KMS" is served by the first. An operator under a
rule that says *the key material never leaves the module* — some regulated deployments do
say exactly that — is served only by the second. The program builds the first now and
specifies the second so it can be built when someone needs it, rather than pretending the
distinction away.

### 2. `remote-issued` custody: the HSM issues the signing key, it does not perform every signature

The root key lives in the KMS or HSM and signs one thing: the rotation that introduces a
short-lived signing key. The instance holds that short-lived key under the ordinary `file`
adapter and signs everything with it, synchronously, exactly as today.

This is not a new mechanism. It is the mechanism [ADR-0012](0012-the-long-horizon.md)
already built, used at a cadence it was never pointed at:

- The short-lived key is an ordinary rotation — `#ed25519-key-<n>` with `validFrom` and
  `validUntil` already in the sidecar and already in `afp:keyHistory`.
- Everything it signed in its interval verifies forever, which is precisely ADR-0012
  Decision 2's rotation guarantee.
- The interval check in `keys.py` already fails a signature outside its key's declared
  window, with no change.
- `afp:custody: "remote-issued"` on the published key entry states where the *root* lives
  (ADR-0026 Decision 1's informational field, already built).

What is new is one artifact: the successor is introduced by an activity **signed with the
root key**, so the delegation is on the record and checkable rather than asserted. Call it
`afp:KeyDelegation` — object fields `afp:delegatedKey` (the successor's `keyId` and
`publicKeyMultibase`), `afp:validFrom`, `afp:validUntil`, and `afp:rootKey`. One remote
signature per rotation, at a cadence the operator chooses.

**The compromise window becomes a configured number.** An hour's lifetime means a stolen
host signs for at most an hour, and the record shows exactly which interval is suspect.
That is a stronger, more legible property than "the key is in an HSM" usually delivers in
practice, and it is expressible in the interval model that already exists.

**What it does not give you**, stated plainly so nobody buys it under the wrong
impression: the signing key does exist in host memory for its lifetime. A deployment whose
rule is *never in host memory* must use Decision 4 and pay for the async port.

### 3. The remote signing service contract

One contract serves both modes; `remote-issued` calls it rarely, `remote` calls it per
signature.

```
POST {AFP_SIGNER_URL}/sign
  Content-Type: application/json
  { "keyId": "https://alpha.example/actor#ed25519-key-7",
    "alg":   "ed25519",
    "message": "<base64 of the bytes to sign>" }
→ 200 { "signature": "<base64, 64 bytes>" }
→ 403   the client certificate is not authorized for this keyId
→ 404   unknown keyId

GET {AFP_SIGNER_URL}/keys/{keyId}
→ 200 { "keyId": …, "publicKeyMultibase": "z6Mk…" }
```

- **`message`, never a digest** — for the reason in the Context. For an object proof the
  message is the 64-byte `proofConfigHash || documentHash`; for an HTTP signature it is
  the signature base.
- **Mutual TLS, and the service binds cert to `keyId`.** A signer that signs whatever
  `keyId` it is asked for has moved the trust boundary without narrowing it; the
  authorization must be the service's, because the client is the thing assumed stolen.
- **Retry is safe, and that is a property of the algorithm.** Ed25519 is deterministic:
  the same message under the same key yields the same signature. A retried `/sign` cannot
  fork the record, which is what makes a network-dependent signer tolerable at all.
- **A signing failure must never leave a half-appended chain.** `emit` builds, signs, then
  appends; a throw from the signer happens before `outbox.append`, so the chain is
  untouched. This ordering is load-bearing and must be preserved by any async migration —
  it is the one invariant an async rewrite could silently break.
- **ADR-0025's address policy will refuse this endpoint.** A KMS on a private range is
  exactly what `policedFetch` exists to block. The signer URL is configuration, not a
  fetched resource: it is called directly, not through `policedFetch`, and its host is
  pinned by mTLS rather than by the SSRF guard. An operator putting it on a routable
  address gets no exemption. This is stated because the alternative — quietly widening
  `AFP_TRUSTED_NETS` — would weaken a boundary ADR-0025 built on purpose.
- **Availability couples.** With `remote`, a KMS outage stops the instance publishing
  entirely. With `remote-issued`, it stops only the next rotation, and the current key
  keeps working until it expires — another reason the issued mode is the better default.

`tools/signer/` ships a file-backed reference implementation of this contract, so a third
implementation has something to conform to and the gate has something to run against.

### 4. The asynchronous port, if and when it is built

`Signer.sign` becomes `(bytes) => Promise<Uint8Array>`; `fileSigner` and `agentSigner`
return resolved promises. The migration is mechanical but wide, and its order matters:

1. **Correct the record first** (this ADR's Context) so nobody re-derives the wrong count.
2. **Free edges first** — `signRequest`/`signRequestCavage` and `httpTransport`, which is
   already async, and `exportBundle`, whose callers are mostly already async. These land
   independently and keep the gate green.
3. **`attachProof` → async**, then `emit`, `publish`, `publishAsInstance`,
   `rosterDocument`, and the hub's publish path.
4. **`AfpInstance` construction becomes `static async open(...)`**, because `provision()`
   signs. This is the change with the widest test surface and should be its own commit.
5. **The gates and demos migrate with it** — 122 `it(...)` callbacks gain `async`.

**The migration must not run without a safety net.** With no typechecker, a forgotten
`await` produces a `Promise` where an activity was expected. Two cheap nets, both
dependency-free: a `node --check`-style script that greps the known async-returning
symbols for unawaited call sites, and — better — a gate case that asserts no serialized
activity anywhere in a bundle contains the string `"[object Promise]"` or a `proofValue`
that fails to decode. The second catches the whole class at the record boundary, which is
where this repository has always preferred to catch things.

### 5. What the verifier is owed by all of this: nothing

A signature verifies identically regardless of where its private half lived. No check in
`afp_verify.py` changes for either mode. The one addition is a `keys:` check for
Decision 2's delegation, if built: the activity introducing a delegated key must itself be
signed by the key the delegation names as root, and the delegated interval must fall
inside the root's. That is an interval question, and `keys.py` is already the file that
answers interval questions.

## Options considered

| Option | Rejected because |
|---|---|
| **Full async port now**, then the `remote` adapter | The cost is real (~300 sites, a factory constructor, 122 test callbacks) and, crucially, unguarded — no typechecker stands between a mechanical migration and a `Promise` written into a record. Worth paying when a deployment's rule genuinely forbids key material in host memory; not worth paying to reach a capability `remote-issued` mostly delivers |
| **Dual port** — keep `sign`, add `signAsync`, let each call site choose | Two signing paths, one of which every gate exercises and the other of which nothing does. This repository's whole claim is that its claims are gated; an under-exercised second path through the signing core is the shape of defect it exists to avoid |
| **Synchronous bridge** — worker thread plus `Atomics.wait` on a `SharedArrayBuffer`, so a remote signer is callable synchronously | Works, and costs zero call sites — but blocks the event loop for the KMS round trip on *every* signature, in a process that is simultaneously serving inbox POSTs and the read gate. It converts a latency cost into an availability cost and hides it behind a synchronous signature. Named here so the next person does not rediscover it and mistake it for free |
| **Deferred signing** — `publish` enqueues an unsigned intent, a worker signs and appends | Breaks the synchronous `OutboxEntry` return the whole codebase is written against, and complicates the chain: `afp:prevActivity` is the digest of the *signed* predecessor, so signing must serialize per actor anyway. The right shape at high volume with a slow signer; the wrong shape for the first remote deployment |
| **Mandate an HSM**, as ADR-0026 already rejected | Unchanged: solo and airgapped operators are first-class profiles (06) |

## Consequences

**Positive** — the operator question "where does your instance key live" gets a real
answer without a rewrite, and the answer is on the record as an interval a stranger can
check. The expensive option stays available and is now costed honestly rather than
deferred with a sentence.

**Negative** — two custody modes is one more thing to explain, and `remote-issued` invites
the misreading that the key is never in host memory. Decision 2 says otherwise in as many
words, and [ADR-0033](0033-operator-obligations.md) should require the mode *and its
key lifetime* to be published, since a one-year "short-lived" key is the mode's failure
case.

**Accepted** — until Decision 4 is built, an operator whose rule forbids key material in
host memory cannot run AFP compliantly, and should be told so rather than sold
`remote-issued` as equivalent.

## Implementation architecture

### W1. Files

| Package | Touches | Content |
|---|---|---|
| **WP-1 · service** | `tools/signer/` (new), `docs/afp/adr/0035` | Decision 3's contract, file-backed reference implementation, mTLS |
| **WP-2 · adapter** | `crypto/signer.ts`, `config.ts` (`AFP_SIGNER_URL`, client cert paths) | `remoteIssuedSigner`; the `remote` adapter stays unbuilt until WP-4 |
| **WP-3 · delegation** | `ap/activities.ts` (`afp:KeyDelegation`), `instance/keyOps.ts` (`rotate --root remote`), `verifier/keys.py` | Decision 2's on-record artifact and its interval check |
| **WP-4 · async port** | everything in Decision 4's ordered list | Only when a deployment needs Decision 4 |
| **WP-5 · gate + docs** | `test/adr0035.test.ts`, instance README runbook, [ADR-0033](0033-operator-obligations.md) row | W2 |

### W2. Gate matrix — `test/adr0035.test.ts`

| # | Case | Asserts |
|---|---|---|
| G1 | Rotation with `--root remote` against the reference signer | exactly one call to `/sign`; the successor signs everything after it |
| G2 | The delegation activity | signed by the root key, names the delegated key, and its interval falls inside the root's |
| G3 | A delegated key signing outside its declared interval | fails `keys:` by name at replay |
| G4 | The reference signer refuses a `keyId` the client cert is not bound to | `403`, and the rotation fails closed |
| G5 | Signer unreachable at rotation time | the current key keeps signing; the failure is reported, not swallowed |
| G6 | A signing failure mid-publish | no activity appended, chain head unmoved |
| G7 | `/sign` called twice with the same message | byte-identical signature (Ed25519 determinism — the retry-safety claim) |
| G8 | Every shipped bundle replayed | unchanged: custody leaves no trace in the record |

Gate for WP-4, if it is ever built: the whole existing gate, green, plus a case asserting
no bundle anywhere serializes a `Promise`.

## Build status

**Decisions 2, 3 and 5 built, 2026-09-18.** Decision 4 (the async port, the full `remote`
adapter) remains costed and deliberately unscheduled — nothing below builds it.

**WP-1 — the reference signer**, `src/tools/signer/server.ts` (new): a file-backed
`POST /sign` / `GET /keys/{keyId}` service behind mutual TLS, `node:https`/`node:crypto`
only (ADR-0001). The client certificate's SHA-256 fingerprint must appear in the keyId's
own authorized list — the service's own authorization, never the caller's assertion, per
Decision 3. `src/tools/signer/devCerts.ts` generates a dev/test CA, server and client
certificate through the system `openssl` binary — a test-time dependency of this file
alone, not an npm package and not a runtime dependency of the instance.

**WP-2 — the adapter**, `crypto/signer.ts`: `Custody` gains `"remote-issued"`; the async
`AsyncSigner`/`remoteIssuedSigner`/`fetchRemoteSignerPublicKey` call the reference contract
directly over `node:https` with a client certificate, never through `policedFetch` (Decision
3's own point). `crypto/proof.ts` gains `attachProofAsync` — the one call site in the
codebase that awaits a signature, exactly the narrow exception the ADR asked for.
`config.ts`/`configSchema.ts` gain `AFP_SIGNER_URL`, `AFP_SIGNER_ROOT_KEY_ID`,
`AFP_SIGNER_CLIENT_CERT_FILE`/`AFP_SIGNER_CLIENT_KEY_FILE`/`AFP_SIGNER_CA_FILE`, and
`AFP_ISSUED_KEY_LIFETIME_MS` (named for what it actually drives — the *successor's*
lifetime, not the root's; an earlier draft called it `AFP_SIGNER_ROOT_KEY_LIFETIME_MS` and
was renamed on review before anything shipped under the old name). A remote request that
never answers no longer hangs a rotation forever: `RemoteSignerClientConfig.timeoutMs`
(default 10s) destroys the request and the failure propagates through the same fail-closed
path as an unreachable host.

**WP-3 — the delegation**, `ap/activities.ts` (`afp:KeyDelegation`, fields exactly as
Decision 2 specified: `afp:delegatedKey` `{keyId, publicKeyMultibase}`, `afp:validFrom`,
`afp:validUntil`, `afp:rootKey`), `instance/keyOps.ts` (`rotateKeyWithRemoteRoot`, reached
by `afp keys rotate <actor> --root remote`), `verifier/keys.py` (`check_key_delegations`).
Two amendments came out of review, both closing a hole the first pass left open:

> **The root's public half is never asserted by the record it authenticates.** The first
> pass embedded `afp:rootKeyMultibase` in the delegation activity itself and folded it into
> the manifest's `afp:keyHistory` — both are part of the export the same host produces, so a
> thief who had stolen it could mint a fake root, name the real `afp:rootKey` id, and
> delegate themself a successor with every check passing (the same "a forger supplies the
> public half of the key they signed with" hole ADR-0026 Decision 1 already closed for the
> manifest signature). Fixed by publishing the root's public half on the **instance actor
> document** instead — `instanceDocument()` gains an `assertionMethod` entry per recorded
> root, `afp:custody: "remote-issued"`, sourced from `crypto/keys.ts`'s new
> `recordRemoteRootKey`/`remoteRootKeys` (an `instance.roots.json` sidecar, written only
> after a `/sign` call succeeds). `afp:rootKeyMultibase` and the `export.ts` fold are gone;
> `check_key_delegations` resolves `afp:rootKey` from actor documents alone
> (`collect_public_keys(export)`, no history) and both verifies the delegation's own
> signature against that key and requires it be published there before anything else about
> the delegation is trusted. The anchor is the actor document a counterparty already fetched
> and cached *before* any theft — the same limit every other published key already has, and
> the reason this is a real property rather than a repeated assertion: the root itself
> carries no interval of its own on the document, since nothing here tracks its lifecycle.

> **The compromise window is enforced at replay, not merely declared.** The first pass
> minted the successor's `afp:keyHistory` entry with no `validUntil` at all, so a signature
> made long after the delegation's own hour-long window verified anyway —
> `check_key_intervals` had nothing to check it against. `rotateKeyPair` (`crypto/keys.ts`)
> gained a `declaredValidUntil` parameter, kept deliberately separate from the field that
> marks a key actually retired (`activeEntry` reads presence of `validUntil`, not time, as
> "no longer signs" — writing the delegated bound directly into `validUntil` would have
> stranded the key before it ever got to sign anything). `keyHistory` exports
> `validUntil ?? declaredValidUntil`, so the delegated window reaches `afp:keyHistory` once
> no real retirement has superseded it. Because that history entry is still something the
> same (possibly stolen) host asserts, `check_key_delegations` independently holds every
> signature by a delegated key to the window **its own root-signed delegation declares** —
> unforgeable by whoever holds only the successor — so a doctored history entry cannot widen
> what the delegation itself already fixed.

`afp:custody: "remote-issued"` also now joins the `CustodyMode`/`Custody` enums
(`policySpec.ts`, `crypto/signer.ts`), and the policy document gains `afp:keyLifetimeMs`
(`ap/policy.ts`, `policySpec.ts` `CustodySpec.keyLifetimeMs`) — the small ADR-0033 addition
the Consequences section asked for. `runtime/configCheck.ts` adds a `custody` line: when the
policy declares any custody mode `remote-issued`, `custody.keyLifetimeMs` must equal
`AFP_ISSUED_KEY_LIFETIME_MS`, failing by name (both values) otherwise — the two lifetimes are
easy to change independently and nothing else holds them to agreeing.

**WP-5 — gate and docs**, `test/adr0035.test.ts`: G1, G4, G5, G6, G7, G8 as specified; G2 and
G3 each gained a "b" case pinning one of the two amendments above (G2b: a delegation whose
root is stripped from the actor document fails by name; G3b: a signature made past the
delegation's own `validUntil` fails even with `afp:keyHistory` otherwise untouched), plus a
timeout case and a config-check mismatch case. 13/13. Instance README gains a "Remote-issued
custody" runbook section. `npm test` (`src/instance`) — 568 tests, 566 pass, 2 pre-existing
skips, 0 failures, including the full existing demo/parity/fixture gate unchanged.

## References

- [ADR-0026](0026-key-custody-and-the-signer-port.md) Decision 1 and its revision note — corrected here on two counts: the async blast radius, and `POST /sign` taking a digest
- [ADR-0012](0012-the-long-horizon.md) Decisions 1–2 — the interval model `remote-issued` reuses wholesale
- [ADR-0025](0025-transport-hardening.md) Decision 2 — why the signer endpoint is configuration rather than a policed fetch
- [ADR-0001](0001-p1-stack.md) — zero dependencies, hence no typechecker, hence Decision 4's chief risk
