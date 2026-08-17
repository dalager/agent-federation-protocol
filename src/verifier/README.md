# afp-verify

Replays an AFP export and says whether it holds up. Run it as the person who
**was not there**: it reads the export directory and nothing else — no instance
access, no private keys, no network.

```bash
python3 afp_verify.py ../instance/export --thread urn:afp:thread:doc-1
python3 afp_verify.py ../instance/export -v      # show passing checks too
```

Exit status is `0` only if every check passes. Requires Python 3.11+ and
`cryptography`; everything else is standard library.

## Why this exists as a separate program

Per [ADR-0001](../../docs/afp/adr/0001-p1-stack.md): if the writer and the
verifier shared a canonicalization function, a bug in it would make an invalid
record verify clean — the verifier would be attesting to its own bug, and
"replay passes" is the entire product of P1.

So this is a **deliberately independent second implementation**, in a different
language, sharing no code with `src/instance`. It was written from the algorithm
below rather than by porting the TypeScript. If the two disagree, that
disagreement is the finding, not a nuisance to paper over.

It is also the cheapest interop test available before P4 goes anywhere near
another implementation.

> **Deviation from ADR-0001:** the ADR specifies Go, for the single static
> binary an auditor can run with nothing installed. No Go toolchain was
> available in the build environment, so this is Python — which keeps the
> essential property (different language, zero shared code) and loses the
> zero-install handoff. It is ~250 lines; a Go port stays open.

## What it checks

| Check | Failing means |
|---|---|
| Manifest present, cryptosuite declared | Not an AFP export bundle |
| Actor documents publish verification keys | Nothing can be verified at all |
| Roster signature verifies **from the cached copy** | Membership was altered, or the roster needs a live roundtrip it should not need |
| Every activity's proof verifies | The record was edited after signing |
| Every activity declares `afp:visibility` | The record does not say who may read it |
| Every attachment carries `afp:digest`, and the bytes match | Evidence was swapped or altered |
| Each actor's chain starts at its first activity | The log does not begin where it claims |
| Each `afp:prevActivity` links to its predecessor | An activity was removed, inserted, or reordered |
| The thread reaches a terminal `afp:Result` / `afp:Error` | The workflow never closed |
| One outcome per `correlationId` | A task was answered twice — the collision scenario 02 found |

## The algorithm, restated

An independent implementation has to be able to reproduce this without reading
the instance's source. Signatures are `eddsa-jcs-2022`
([FEP-8b32](https://socialhub.activitypub.rocks/t/fep-8b32-object-integrity-proofs/2725),
[W3C Data Integrity EdDSA](https://www.w3.org/TR/vc-di-eddsa/)):

1. **Proof configuration** — the document's `proof` object, minus `proofValue`,
   plus the document's `@context`:
   ```json
   { "@context": [...], "type": "DataIntegrityProof", "cryptosuite": "eddsa-jcs-2022",
     "created": "...", "verificationMethod": "...", "proofPurpose": "assertionMethod" }
   ```
   The emitted proof does *not* carry `@context`; it is present only while hashing.
2. **Canonicalize** both the proof configuration and the document-without-`proof`
   using [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) (`jcs.py`).
3. **Hash** each with SHA-256.
4. **Signing input** = `SHA256(proofConfig) || SHA256(document)` — proof
   configuration first, 64 bytes total.
5. **Verify** with Ed25519 against the key named by `verificationMethod`,
   resolved from the `assertionMethod` entries of the actor documents in the
   bundle. `proofValue` is multibase base58btc (`z` prefix).

Chain digests use the same canonicalization: `afp:prevActivity` is
`sha256:<hex>` over the canonical form of the previous activity **including its
proof**, so the chain binds signed bytes rather than a payload someone could
re-sign.

## The bundle it reads

```
MANIFEST.json           what this bundle contains
instance.jsonld         the instance actor
roster.jsonld           the signed roster
actors/<name>.jsonld    agent actors, each carrying a Multikey
outbox/<name>.jsonld    OrderedCollection of signed activities, in chain order
artifacts/sha256-<hex>  raw bytes, named by their own digest
```

## Trying to break it

The two mutations P1's demo calls for, and what they produce:

```bash
cp -r ../instance/export /tmp/tampered

# flip one byte of archived evidence
python3 -c "p='/tmp/tampered/artifacts/'+__import__('os').listdir('/tmp/tampered/artifacts')[0]
b=bytearray(open(p,'rb').read()); b[0]^=1; open(p,'wb').write(bytes(b))"
python3 afp_verify.py /tmp/tampered
# [ FAIL ] artifact: sha256:67af8618… matches its digest
#          bytes hash to sha256:482581e9… but are referenced as sha256:67af8618… by …/activities/0001

# remove one activity from the middle of an outbox
python3 -c "import json; p='/tmp/tampered/outbox/writer.jsonld'; d=json.load(open(p))
d['orderedItems'].pop(1); json.dump(d,open(p,'w'))"
python3 afp_verify.py /tmp/tampered
# [ FAIL ] chain: writer[1] …/activities/0003 links to its predecessor
#          expected afp:prevActivity sha256:4bd2ba5a…, found sha256:7f02ecf5…
```

Both are exercised automatically by gate check 10 in
`../instance/test/gate.test.ts`, which shells out to this script.
