# ADR-0026 — Key custody and the signer port: the record's guarantees are cryptographic; the keys' protection must stop being a directory permission

- **Status:** Built (2026-09-04), with one stated exception — the `remote` signer adapter,
  which waits on the asynchronous port — program claim **C2** of
  [ADR-0024](0024-the-road-to-production.md); group: **Security**
- **Date:** 2026-09-02
- **Applies to:** every private key an instance holds — instance, agent, hub-scoped and
  transport — and every export that must be safe to hand to a stranger
- **Builds on:** [ADR-0012](0012-the-long-horizon.md) (key history, rotation versus
  revocation), [ADR-0017](0017-standards-conformance.md) Decision 4 (two keys per actor,
  three with the shim), [ADR-0021](0021-conviction-to-consequence.md) Decisions 4a and 4d
  (compromise claims; a revocation cut may not predate embedded evidence), 01 §
  key custody (`self` versus `instance`), [ADR-0009](0009-federated-replay.md)
  Decisions 4–5 (export scopes)
- **Driven by:** [the operator's Tuesday](../scenarios/the-operators-tuesday.md) —
  "key custody is currently *file custody*" — and [ADR-0023](0023-loose-ends-triaged.md)
  rows L1 (hub-scoped and transport keys are outside `afp:keyHistory`, verified in
  `src/instance/src/export.ts`) and L2 (the visibility-floor and agreement-grant export
  scopes are specified and unbuilt, verified in the same file)

## Context

Every key the instance uses is a PEM file under `data/keys/`, loaded by
`src/instance/src/crypto/keys.ts`, and the roster's `self`-custody option — an agent that
holds its own key — is supported by the record and exercised by nothing. The honest
statement in the baseline document stands: the guarantees are cryptographic; the
protection is a directory permission and a careful operator.

Three further facts make this a production blocker rather than a wart. First,
`afp:keyHistory` collects the instance key, each agent's P1 key and each hub actor's keys,
and nothing else: the per-agent hub-scoped keys that sign votes and the transport keys
that sign hops can be neither recorded nor interval-checked (ADR-0021 Q7, "a live hole").
Second, rotation and revocation have no operator surface — the history entries ADR-0012
specified are produced by demo code. Third, an export is the one artefact that leaves the
operator's hands, and today its scope grammar cannot express "everything a regulator may
see" or "everything this counterparty was granted"; the thread-set scope is all there is.

## Decisions

### 1. A signer port, and the instance never holds a private key outside its adapter

`crypto/signer.ts` defines `Signer { keyId; publicKeyMultibase; sign(bytes): Promise<Uint8Array> }`.
Everything that signs — object proofs, HTTP signatures, the manifest — takes a `Signer`.
Adapters:

- **`file`** — today's PEM files, now created `0600`, optionally encrypted at rest with a
  passphrase from `AFP_KEY_PASSPHRASE_FILE`; the reference adapter, and the only one the
  gate needs.
- **`remote`** — an HTTP signer behind mutual TLS (`POST /sign`; the request carries the
  *bytes*, not their digest — Ed25519 hashes internally, so a signature over a
  caller-supplied digest never verifies over the message. Corrected in
  [ADR-0035](0035-remote-custody-and-the-asynchronous-port.md), which also costs the port),
  the shape an operator's KMS or HSM proxy fits; a reference implementation in
  `tools/signer/` proves the contract with a file-backed service.
- **`agent`** — for `self`-custody agents: the instance holds no key at all; the agent
  presents signed activities through the port and the instance verifies, exactly as 01
  § "the agent–instance boundary" describes and nothing has yet exercised.

The custody mode of every key is declared in the roster entry it already has
(`afp:keyCustody`) and, for transport and hub-scoped keys, in the actor document's key
entry as `afp:custody: "file" | "remote" | "agent"` — informational, so an auditor can
see where a key lived.

### 2. Rotation and revocation are a runbook and a CLI, not demo code

`afp keys rotate <actor> [--kind proof|transport|hub:<id>]` publishes the new key with an
overlap window, `Update`s the actor document, and writes the ADR-0012 history entry.
`afp keys revoke <keyId> --since <instant> [--claim <proofDigest>]` cuts the interval,
publishes the document update, and — when the key signed votes embedded in an on-record
`afp:EquivocationProof` — refuses a `--since` earlier than those votes, which is ADR-0021
Decision 4d enforced at the moment it matters rather than only at replay; `--claim`
publishes the `afp:KeyCompromiseClaim` in the same act. The runbook in the instance README
is the human procedure around these two commands.

### 3. `afp:keyHistory` names every key that ever signed anything in the bundle

`collectKeyHistory` in `export.ts` walks, per actor: the proof key, every hub-scoped key
(`<actor>--hub-<id>`), and the transport key. Transport keys sign hops, not activities,
and their signatures never enter a bundle; they enter the history anyway, because a
revoked transport key with an interval is how a boundary-log entry's authentication can be
re-judged later. `keys.py`'s `check_key_intervals` covers the additional entries with no
change: it is already keyed on `verificationMethod`, not on actor. Closes ADR-0023 L1 as
the ADR-0012 amendment ADR-0021 Q7 asked for; decides Q4 in passing — V14 stays in
`keys.py`, beside the other interval checks.

### 4. An export never carries private material, and the gate proves it

An export gate scans every file in a bundle for PEM headers, multibase private-key
prefixes, and the passphrase file's contents; any hit fails the export before it is
written. Cheap, and the one accident an operator cannot undo.

### 5. Export scopes: visibility floor and agreement grant

ADR-0009 Decision 4 specified three scopes and P4 built one. The two remaining are built
here because both are custody decisions — what leaves the operator's hands:

- **Visibility floor** — `{ visibilityAtLeast: "hub" }` stubs every activity below the
  floor; the manifest's `afp:exportScope` declares the floor.
- **Agreement grant** — `{ agreement: <digest> }` stubs every activity the named
  agreement's grants would not have admitted; the manifest names the agreement. This is
  the export a counterparty is entitled to, produced without a human judging each thread.

Both use the existing 1:1 stub-in-chain-position mechanism, both keep the ADR-0010
Decision 5 refusal (no answer without its pins), and both replay clean in the joint
verifier. Closes ADR-0023 L2.

### 6. Backup separates keys from data

The README's `cp` backup becomes two runbooks: the SQLite file through the backup API
(ADR-0032), and `data/keys/` — or nothing, under `remote` and `agent` custody — through
whatever the custody adapter documents. A backup that mixes the two is how a key ends up
in an object-storage bucket.

## Options considered

| Option | Rejected because |
|---|---|
| Mandate an HSM | Solo and airgapped operators are first-class profiles (06); a signer *port* with a file adapter keeps them running and lets a consortium host demand `remote` by agreement |
| Encrypt PEM files and stop there | Encryption at rest with a passphrase on the same host protects against a stolen backup and nothing else; the port is what lets custody improve without touching the instance |
| Leave transport keys out of the history because their signatures are not in the bundle | The boundary log records who was authenticated; re-judging that after a revocation needs the interval |
| Build the two export scopes under a scenario-coverage ADR | They are custody decisions — what may leave — and ADR-0010 Decision 5's refusal has to hold under them, which is a verifier concern, not a workload one |

## Consequences

**Positive** — key material has a place to be that is not a directory, rotation is a
command, and the two things a regulator or a counterparty is entitled to can be exported
without a human choosing threads.

**Negative** — three custody adapters is three ways to misconfigure; the `remote` adapter
in particular moves the trust to a service the operator must run. ADR-0033 makes the
custody mode a published obligation so at least it is stated.

**Accepted** — `agent` custody makes the instance verify rather than sign; the P1 gate's
"the wiring is invisible" invariant must hold across the change, and G8 below checks it.

## Implementation architecture

### W1. Files

| Package | Touches | Content |
|---|---|---|
| **WP-1 · port** | `crypto/signer.ts` (new), `crypto/keys.ts`, `crypto/proof.ts`, `federation/httpSig.ts`, `export.ts` (manifest signing) | Decision 1 |
| **WP-2 · runbook** | `cli.ts` (`keys` subcommands), instance README | Decision 2 |
| **WP-3 · history** | `export.ts`, `crypto/keys.ts`, `src/verifier/keys.py` | Decision 3 |
| **WP-4 · scopes** | `export.ts` (`ExportScope`), `src/verifier/afp_verify.py` (`afp:exportScope` reading) | Decision 5 |
| **WP-5 · gate** | `test/adr0026.test.ts`, `test/adr0012.test.ts` (extended) | W2, Decision 4 |

### W2. Gate matrix — `test/adr0026.test.ts`

| # | Case | Asserts |
|---|---|---|
| G1 | Every demo under the `file` adapter | byte-identical record to before this ADR |
| G2 | The `remote` adapter against the reference signer | same record; the instance process holds no private key object |
| G3 | An `agent`-custody agent signs out of process | roster says `self`; replay clean; P1 gate check 11 (wiring invisible) holds |
| G4 | `afp keys rotate` then export | old and new signatures both verify (ADR-0012 G1 shape) |
| G5 | `afp keys revoke --since` earlier than an embedded convicting vote | refused at the CLI; the proof stands |
| G6 | A bundle's `afp:keyHistory` after a hub round | names the hub-scoped key that signed each vote and the transport key; a backdated cut on a hub-scoped key fails `keys:` by name |
| G7 | An export directory containing a planted PEM | the export refuses to write |
| G8 | Visibility-floor and agreement-grant scoped exports | stubs 1:1; joint replay clean; an answer whose pins fall below the floor is refused (ADR-0010 D5) |
| G9 | Every shipped bundle replayed | unchanged |

## Build status

**All six decisions built, 2026-09-04**, except the two adapters named below. C2 is
otherwise closed.

**Decision 1 — the signer port**, `crypto/signer.ts` (new): `Signer { keyId,
publicKeyMultibase, custody, sign(bytes) }`, with `fileSigner(pair)` and
`signerOver(keyId, key)` as the `file` adapter. Everything that signs takes one —
`attachProof` (whose `verificationMethod` now comes from the signer, so a caller
cannot sign as one key and claim another), `signRequest`/`signRequestCavage`, the
export manifest, the hub, the roster. `AfpInstance.signer(name)` /
`transportSigner(name)` are the accessors; the `KeyObject` stays closed over
inside the adapter rather than handed out. PEMs are written `0600` (already true)
and, with `AFP_KEY_PASSPHRASE_FILE` set, encrypted at rest as PKCS#8 —
unset, every existing key directory loads byte-unchanged.

> **Revision under contact — the port is synchronous.** The ADR specified
> `sign(bytes): Promise<Uint8Array>` and did not price it: `attachProof` is
> synchronous and is reached from `instance.publish` (158 call sites) and from
> actor-document construction served inside synchronous HTTP handlers (99 more).
> Async would have turned the entire signing core async for the benefit of the one
> adapter this pass does not build. `file` and `agent` custody are natively
> synchronous; `remote` is what wants a promise, and should arrive with the async
> variant it needs rather than imposing one now. The `remote` and `agent`
> adapters, and the `afp:custody` field on published key entries, are unbuilt —
> `Signer.custody` exists and is `"file"` throughout.

**Decision 3 — `afp:keyHistory` names every key that ever signed**, `crypto/keys.ts`
`allKeyHistories` + `export.ts`: per actor, the proof key, every hub-scoped key
(discovered from the key directory, not guessed) and the transport key. The
ordinal convention is now shared by all three kinds, so a rotated key of any kind
gets a distinct id instead of two history entries colliding on one. **Closes
ADR-0023 row L1's recording half** — ADR-0021 Q7's "live hole". `keys.py` needed no
change, exactly as predicted, because its interval check is keyed on
`verificationMethod`; its docstring is corrected, since it had asserted hub-scoped keys
are never in the history.

> **What L1 does not yet get.** The ledger's "done when" also asks that a hub-scoped key
> revoked with a backdated cut fail `check_key_intervals` by name. It does not, and cannot
> today: checked against a P6 bundle, **no exported activity is signed by a hub-scoped or
> transport key at all** — all 49 top-level proofs use the proof key, and so do the votes
> embedded in an `afp:EquivocationProof`, because under `instance` custody the instance key
> signs on the agent's behalf. Declaring these keys *arms* the interval check rather than
> exercising it: the day such a signature travels in a bundle it is judged. L1 is therefore
> marked part-closed, not closed. Making votes actually carry their hub-scoped signature
> into the bundle is a separate change and belongs with whoever revisits ADR-0021 Q7.

**Decision 4 — an export never carries private material**, `export.ts`
`refusePrivateMaterial`: every file in a written bundle is scanned for PEM private
headers, the Ed25519 private multibase prefix, and the passphrase file's contents;
any hit throws before the bundle is handed over.

### Found while building this: the manifest's signature was never verified

ADR-0012 Decision 1 made the manifest a signed document so that "the export's
self-description stops being the one part of a bundle anybody could edit freely."
The verifier checked only *which key* the manifest named — never the signature.
A bundle whose `exportedAt`, `afp:members`, `afp:exportScope`, `afp:retentionDuty`,
`afp:anchors` or `afp:keyHistory` had been rewritten replayed clean, demonstrated
on a P6 bundle. Decision 3 makes this worse, since the widened key history lives
in that manifest: a forger could insert a key entry or backdate an interval and
the interval checks would judge against their data.

Fixed in `keys.py` `check_manifest_signature`, called from `afp_verify.py`, and
verified against keys published by the bundle's **actor documents only** — never
the manifest's own history, which is inside the document being verified and would
let a forger supply the public half of the key they signed the rewrite with. A
signed manifest naming a method no actor document publishes is reported rather
than passed over. This also caught a real fixture defect: ADR-0005's gate helper
folded foreign instances into a host bundle by editing `afp:members` without
re-signing, and now re-signs as a real exporter would.

**Decision 2 — rotation and revocation as a runbook and a CLI**, `instance/keyOps.ts` (new)
+ `cli.ts`: `npm run keys -- list | rotate | revoke`. `rotate` closes the outgoing
interval and mints the next ordinal; `revoke` cuts the interval and mints nothing
("we were compromised" and "what signs next" are separate decisions), with `--claim`
publishing the `afp:KeyCompromiseClaim` in the same act. The **ADR-0021 Decision 4d
refusal is enforced at the CLI**: a `--since` at or before a vote that an on-record
`afp:EquivocationProof` embeds and this key signed is refused, naming the vote and the
earliest instant that would be acceptable — replay catches backdating after the fact,
this catches it at the moment the operator would commit it. The runbook is in the
instance README.

> **Key commands deliberately do not boot the agents.** Revocation mints no successor,
> which leaves the key store with no active key — a state `loadOrCreateKeyPair` refuses
> by design (ADR-0012 D2). The first cut of this command constructed an `AfpInstance`
> and was therefore unable to run `keys rotate`, the sanctioned way out, at exactly the
> moment it was needed. `keyOps` takes `{ keyDir, origin, db }` instead; a gate case
> pins the dead end shut.

**Decision 5 — export scopes**, `export.ts`: `{ visibilityAtLeast }` and `{ agreement }`
join the thread-set scope behind the one `inScope` predicate, so the 1:1 stub mechanism,
the ADR-0010 D5 pins guard and the received-activity filter are unchanged by adding a
scope kind. The manifest declares which scope produced the bundle. `federation.py`
`check_export_scope` holds a bundle to what it claims — **over-disclosure is the
checkable direction**: a bundle cannot prove it withheld the right things (the withheld
bytes are absent by construction), but one claiming a `hub` floor while disclosing an
`internal` activity, or claiming an agreement's grants while disclosing what those
grants refuse, has broken its own declaration. A grant-scoped bundle that omits the
agreement it names is reported rather than passed over. **Closes ADR-0023 row L2.**

**Decision 6 — backup separates keys from data**: two runbooks in the instance README,
the record through SQLite's backup API and the keys through their own encrypted path,
with the note that under `remote`/`agent` custody there is nothing there to back up.
An export bundle is not a backup, and Decision 4's refusal is the backstop for the one
accident that cannot be undone.

**The `agent` adapter (2026-09-04).** `agentSigner(keyId, publicKeyMultibase, sign)` plus
an optional `signer` on `AgentRegistration`: when present the instance mints and loads
**no** private key for that actor, which is what `self` custody was always supposed to
mean and never did — before this, the roster said `self` while the instance still minted
and held the PEM. The agent's own signer is the only way to sign as that actor anywhere in
the process, and the actor document publishes the public half from it. `afp:custody` is
published on the key entries the roster does not cover (the transport key, and hub-scoped
keys), the proof key's custody remaining the roster's `afp:keyCustody` — Decision 1's own
division, not a duplicate. The transport key stays instance-held under every custody mode:
the HTTP hop is the instance's delivery on the agent's behalf, not the agent's own act,
and no hop signature ever enters the record.

**Still not built: the `remote` adapter.** It needs the asynchronous port this build
deliberately did not adopt (see the revision note above); `tools/signer/` does not exist,
and G2 is correspondingly absent. `remote` remains a `Custody` value the type admits and
no adapter produces.

> **Costed and designed since, in [ADR-0035](0035-remote-custody-and-the-asynchronous-port.md)**,
> which corrects this ADR on two counts. The revision note's blast radius was overstated:
> actor documents assemble from public halves and never sign, so the "99 more" call sites
> it names are unaffected, and the real constraint is not the count but `AfpInstance`'s
> constructor, which signs. And Decision 1's `POST /sign` sentence specified a digest,
> which Ed25519 cannot honour. ADR-0035 also proposes `remote-issued` custody — the HSM
> issues a short-lived signing key rather than performing every signature — which reaches
> most of what an operator wants from remote custody through the interval model
> [ADR-0012](0012-the-long-horizon.md) already built, and needs no promise anywhere.

Gate: `test/adr0026.test.ts` — G1 as an *independent* byte-identity check (the
`eddsa-jcs-2022` signing input is rebuilt in the test and signed with the bare
key, so the port is proved not to have changed the algorithm rather than compared
against itself), the signer's closed-over private half, `0600`, encryption at rest
round-tripping, G6 (hub-scoped and transport keys in the history, no id
collisions), G7 (a planted PEM refuses the export), and the manifest-signature
regression above; G3 (an agent-custody agent signs out of process, no PEM is minted, the
record replays clean and leaks no wiring — P1 gate check 11 across the change); G4 (both
signatures verify across a rotation), G5 (the backdated cut refused by name), the
no-bootable-instance dead end, and G8a/G8b/G8c (both scopes stub 1:1 and replay clean; a
bundle disclosing below its declared floor fails). `npm run gate` — 285/285, run four
times over for the flake below; p1/p4–p7 demos clean; the joint P7 replay passes 981 checks and a bundle
written before this ADR still verifies.

## References

- 01 § Key custody; 01 § The agent–instance boundary
- [ADR-0012](0012-the-long-horizon.md), [ADR-0021](0021-conviction-to-consequence.md) Q4 and Q7
- [ADR-0009](0009-federated-replay.md) Decisions 4–5; [ADR-0010](0010-pinning-without-an-auction.md) Decision 5
- [ADR-0023](0023-loose-ends-triaged.md) rows L1, L2, L30
