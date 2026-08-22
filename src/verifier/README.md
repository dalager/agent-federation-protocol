# afp-verify

Replays an AFP export and says whether it holds up. Run it as the person who
**was not there**: it reads the export directory and nothing else — no instance
access, no private keys, no network.

```bash
python3 afp_verify.py ../instance/export --thread https://alpha.operator.local/threads/doc-1
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
| **Every signing key had authority over its actor** | A valid signature from a key entitled to sign for someone else — a forgery |
| **Every rostered agent contributes an outbox** | A whole participant was removed; no per-actor chain can show this |
| **Every artifact is referenced by an activity** | Unbound evidence, travelling with the record but proving nothing |
| Outbox `totalItems` matches its contents | The collection disagrees with itself |
| Every activity declares `afp:visibility` | The record does not say who may read it |
| Every attachment carries `afp:digest`, and the bytes match | Evidence was swapped or altered |
| Each actor's chain starts at its first activity | The log does not begin where it claims |
| Each `afp:prevActivity` links to its predecessor | An activity was removed, inserted, or reordered |
| The thread reaches a terminal `afp:Result` / `afp:Error` | The workflow never closed |
| One outcome per `correlationId` | A task was answered twice — the collision scenario 02 found |
| **(P2) `afp:DecisionRecord`'s `afp:weightTally` recomputes from `afp:countedVotes`** | The declared outcome doesn't match the arithmetic over the votes actually cast |
| **(P2) Every hash in `afp:countedVotes` resolves to a present, validly signed `afp:Vote`** | A counted vote you cannot produce — evidence for the outcome does not exist |
| **(P2) Every counted vote's `actor` is in the pinned `afp:quorumSnapshot` voter set** | A vote from outside the snapshot was counted — the mid-round-enrollment attack 02 names |
| **(P3) Every `afp:BidReveal` hashes to a prior in-window `afp:BidCommit` by the same actor** | A reveal with no sealed commitment behind it, or a commit snuck in outside the bid window |
| **(P3) Every digest in `afp:winningBids` resolves to a present reveal** | An unproducible winning bid — the auction's version of a counted vote you cannot produce |
| **(P3) The announced selection rule recomputes to the Award's performer set and synthesizer** | The published rule did not actually pick these winners (rules reimplemented here from spec: `ranking`, `coverage`) |
| **(P3) A multi-performer Award's `afp:Synthesis` binds present Results, a method, and dissent** | The combined answer floats free of its evidence, or dissent was summarized away |
| **(P3) Under `afp:estimatorPolicy: exclude`, no performer is a listed estimator** | The agent that framed the budget was awarded the work it estimated |

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

**Authority.** A signature answers *who wrote these bytes*, not *who was entitled to*. For
each activity the signing key must be authorized for its `actor`, per the roster's
`afp:keyCustody`: under `self` custody the agent's own key, under `instance` custody the key
of its `afp:operatedBy` instance — and then `afp:actingAs` must name the agent. This is not
belt-and-braces: the **tail** of every chain has no successor to protect it, so an
unauthorized re-signing of the last activity is invisible to integrity checks alone.

Chain digests use the same canonicalization: `afp:prevActivity` is
`sha256:<hex>` over the canonical form of the previous activity **including its
proof**, so the chain binds signed bytes rather than a payload someone could
re-sign. `afp:countedVotes` hashes use the same digest, over the full signed
`Create{afp:Vote}` activity — not just its `object` — for the same reason.

**DecisionRecord — the three-check extension (ADR-0002 Decision 3, 04 replay
step 7).** Run only when an export contains at least one `afp:DecisionRecord`;
an export with none (all of P1) runs none of this and verifies exactly as
before. Payloads may travel bare (an activity typed `afp:DecisionRecord`) or
wrapped in the standard AS2 activities 03 specifies —
`Create{afp:DecisionRecord}`, `Offer{afp:Proposal}`, `Create{afp:Vote}` —
and the checks read their fields from the payload either way. For each
`afp:DecisionRecord`:

1. Find the `afp:Proposal` with the same `afp:round`. It carries the explicit
   per-voter weights for the round (`afp:voterWeights`) — P2 weight is
   liveness-gated uniform weight, recorded explicitly so the tally never
   depends on state the verifier can't see (02, ADR-0002 Decision 3). The
   pinned voter set is the proposal's explicit `afp:voters` list, falling
   back to the keys of `afp:voterWeights` when a proposal omits it. No
   matching proposal is itself a failure: without it neither the pinned
   voter set nor the weights are recoverable.
2. **Evidence-set completeness.** For each hash in `afp:countedVotes`, look it
   up among the signed activities present in the bundle. Missing, or present
   but not a `Create{afp:Vote}`, or present but its signature doesn't
   verify — each is a failure naming that hash. *"A counted vote you cannot
   produce is a failure"* (04).
3. **Snapshot discipline.** For each counted vote that resolved, its `actor`
   must be in the pinned voter set the proposal named at round start. A
   validly signed vote from an actor outside that set is rejected anyway
   (02 "Snapshot-pinning": an agent enrolled after round start isn't in the
   pinned set even if it later votes).
4. **Tally recomputation.** Sum each surviving vote's value weighted by
   `afp:voterWeights[actor]`. A pinned voter with no counted vote abstains
   by omission: its weight is added under `"abstain"` (04's DecisionRecord
   example carries that key). Compare against `afp:weightTally` over the
   union of keys with default 0 and float tolerance — a zero-weight entry
   on either side (an option nobody chose, an explicit `abstain: 0`) is not
   a mismatch. Any real mismatch is a failure showing both the recomputed
   and the declared tally.

This is set-membership checking and arithmetic over already-verified
signatures — no second signature suite, no consensus protocol, nothing that
would compromise the verifier's zero-dependency property.

## The bundle it reads

```
MANIFEST.json           what this bundle contains
instance.jsonld         the instance actor
roster.jsonld           the signed roster
actors/<name>.jsonld    agent actors, each carrying a Multikey
outbox/<name>.jsonld    OrderedCollection of signed activities, in chain order
outbox/instance.jsonld  the instance's own Vouch/Disown trail — how the roster came to be
artifacts/sha256-<hex>  raw bytes, named by their own digest
```

## Trying to break it

The four mutations P1's demo calls for. The first two are integrity failures; the
last two are the ones a signature-only replay accepts.

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

And the two that need the roster:

```bash
# re-sign the LAST activity of an outbox with another agent's published key
python3 afp_verify.py /tmp/tampered
# [ FAIL ] authority: writer[1] …/activities/0002
#          signed with …/agents/reviewer#ed25519-key, which has no authority over …/agents/writer

# delete a whole agent's outbox — every surviving chain is still intact
python3 afp_verify.py /tmp/tampered
# [ FAIL ] completeness: rostered agent writer has an outbox
#          …/agents/writer is on the signed roster but contributes no outbox to this bundle
```

All four are exercised automatically by gate check 10 in
`../instance/test/gate.test.ts`, which shells out to this script.

### DecisionRecord: the three P2 mutations

`test/fixtures/` hand-builds a small, self-contained L0 voting round (its own
export bundle, signed with test keys — no dependency on the TypeScript hub)
and derives the three mutations ADR-0002 Decision 3 calls for:

```bash
python3 test/fixtures/mutate_decision_fixture.py /tmp/decision-fixtures
python3 afp_verify.py /tmp/decision-fixtures/clean --thread https://hub.example/threads/round-1
# PASSED

python3 afp_verify.py /tmp/decision-fixtures/mistally --thread https://hub.example/threads/round-1
# [ FAIL ] decision: …/decision weightTally recomputes from countedVotes
#          recomputed {'candidate-x': 2.0, 'candidate-y': 1.0} but afp:DecisionRecord declares {'candidate-x': 99.0, ...}

python3 afp_verify.py /tmp/decision-fixtures/missing-vote --thread https://hub.example/threads/round-1
# [ FAIL ] decision: …/decision evidence-set completeness
#          afp:countedVotes names a hash with no present, valid afp:Vote to back it: sha256:6fc7e552…

python3 afp_verify.py /tmp/decision-fixtures/outside-snapshot --thread https://hub.example/threads/round-1
# [ FAIL ] decision: …/decision snapshot discipline
#          counted vote from outside the pinned quorum snapshot: …/agents/voter-outsider (sha256:b46a57ff…)
```

Each mutation trips exactly the check it targets — `mistally` and
`outside-snapshot` re-sign the `DecisionRecord` after mutating it, so the
fault is isolated to the arithmetic/membership check rather than also
tripping the general signature check the way a naive post-hoc edit would.
