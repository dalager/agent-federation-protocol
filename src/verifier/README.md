# afp-verify

Replays an AFP export and says whether it holds up. Run it as the person who
**was not there**: it reads the export directory and nothing else — no instance
access, no private keys, no network.

```bash
python3 afp_verify.py ../instance/export --thread https://alpha.operator.local/threads/doc-1
python3 afp_verify.py ../instance/export -v      # show passing checks too
python3 afp_verify.py ../instance/export-p7/* -v # several bundles: one joint replay
```

Exit status is `0` only if every check passes. Requires Python 3.11+ and
`cryptography`; everything else is standard library.

Version: `0.9.0`, implementing spec revision `3.34` (`afp_verify.py --version`
prints both; ADR-0034 Decision 1).

## Installing

Three ways to get this running, in order of how much you trust the network:

**Copy the directory — nothing to install.** The property ADR-0001 asks for:
copy `src/verifier/` next to an export and run it.

```bash
python3 afp_verify.py ../instance/export --thread https://alpha.operator.local/threads/doc-1
```

**`pip install` from a checkout**, for the console script:

```bash
pip install ./src/verifier
afp-verify --version
afp-verify ../instance/export --thread https://alpha.operator.local/threads/doc-1
```

**`pip install` from the checksummed release archive**, for the auditor who
wants a pinned artifact rather than a checkout — verify the digest before
installing:

```bash
sha256sum -c SHA256SUMS                       # against the archive you downloaded
tar xzf afp-verify-<version>.tar.gz
pip install ./afp-verify-<version>
```

`scripts/release-archive.sh` (run from the repo root) builds that archive —
`dist/afp-verify-<version>.tar.gz` and `dist/SHA256SUMS` — from `git archive`
over this directory, `test/` and `ruvector.db` excluded.

The installed package puts these flat modules under one namespace,
`afp_verify.<module>`, rather than as top-level `keys`, `policy`, `action`, …
— see `__init__.py`'s docstring for why and the trade-off it accepts. Nothing
about invoking `afp_verify.py` directly, from a checkout, changes.

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
> zero-install handoff. It began at ~250 lines and is now fourteen modules, one
> per mechanism it replays (see [Beyond P3](#beyond-p3-one-module-per-extension));
> a Go port stays open.

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

### Beyond P3: one module per extension

Every ADR after P3 added its own extension to the replay. Each lives in its own module,
so an auditor asking "what does *this* extension check" finds it in one place; each is a
deliberate reimplementation from the ADR's own algorithm rather than a port of the
TypeScript; and each fires only when its material is present, so a bundle written before
the ADR verifies exactly as it did. The census printed after every replay shows which
families ran per domain — a family at `0` where you expected work is the question to ask.

| Extension | Specified by | Module | What it checks |
|---|---|---|---|
| Roles and voter weights | ADR-0004 D1, ADR-0005 | `decision.py`, `allocation.py` | A requester or observer never bids and is never pinned; only the hub, a member or a requester announces; `afp:voterWeights` recompute per *instance* from the pinned voters and the Enroll trail; an Enroll or Unenroll is issued by the agent's own instance |
| Assets | ADR-0004 D2 | `asset.py` | `Update{afp:Asset}` replays into a registry; one `(id, version)` is immutable; registration is a member-role act; every `afp:reuses` / `afp:reused` resolves to a registered asset |
| Reputation | ADR-0004 D3 | `reputation.py` | Bidder scores rederive from settled estimates against actuals under the announced rule — integer percent divergence, exact rational decay, a neutral prior of 50 |
| Pins and checkable actuation | ADR-0006, ADR-0010 | `pins.py`, `action.py` | Every task-bearing activity on a thread agrees on one pin digest; a Synthesis carries a category from the pinned closed `afp:actionPolicy`; every `afp:actsOn` resolves to a present Synthesis, or a DecisionRecord one hop away; the claimed action equals what the policy names for it; the pinned synthesizer is who emitted the Synthesis, and a partial Synthesis accounts for every leg of its thread |
| Supersession | ADR-0007, ADR-0011 | `action.py` | `afp:supersedes` resolves in the same thread; a quorum's answer is retracted only by a quorum; every action whose justification was withdrawn has a recorded disposition |
| The federation boundary | ADR-0008 | `federation.py` | Every cross-boundary activity is covered by a co-signed `afp:FederationAgreement`, present in this export, holding an admitting grant and unexpired when the activity published — checked against *the grant that admits it*, never "some grant exists" |
| Joint replay and redaction | ADR-0009, ADR-0015 | `federation.py`, `afp_verify.py` | Over several bundles: the co-signed agreement is digest-equal in every party's export; every activity held as received bytes resolves byte-for-byte in the counterparty's export, or is covered by a redaction stub declaring its digest; a stub stands in chain position; an omitted actor is declared in the manifest, not silently absent; an archived hub's carried state hashes to its declared canon |
| Keys over time | ADR-0012 | `keys.py`, `afp_verify.py` | Every signature resolves to a key valid at its `published` instant per `afp:keyHistory`, and a signing actor's intervals leave no gap; the manifest's own signing key is in its own history; every file is declared in `afp:members` and vice versa; a declared `afp:retentionDuty` has anchors naming real chain heads and keeps the bytes it retains |
| The round as a commitment | ADR-0018, ADR-0019 | `decision.py`, `action.py` | A decision-subject `afp:Settlement` closes the round it names; an `afp:Departure` names a present, `joint`-binding decision the departing actor was actually pinned to vote on; an action on a decision resolves the DecisionRecord it acts on across own and received bytes |
| L1 round hardening | ADR-0020 | `equivocation.py`, `decision.py`, `afp_verify.py` | An L1 vote carries well-formed `afp:phase` / `afp:seqNo` / `afp:proposalHash`; an `afp:EquivocationProof` satisfies every leg of the predicate against the actor's published key, resolved across the whole replay; a successor round's proposer is the entitled successor; the searchlight pools every vote across every bundle and fails a conviction pair that no proof on record names |
| Conviction to consequence | ADR-0021 | `electorate.py`, `decision.py`, `afp_verify.py` | `afp:quorumSnapshot` is the digest of the voter list it travels with; voters plus declared exclusions account for the whole member trail; every `recused` cause resolves against the agent it excludes; an `afp:KeyCompromiseClaim` comes from the convicted agent's own instance and answers a real proof; `MemberExpel` / `MemberAdmit` actuates a round that pinned that subject; a proof cited on an Enroll convicts the agent being enrolled; a revocation cut may not predate a vote a proof embeds |
| Contribution accounting | ADR-0022 | `summary.py`, `decision.py`, `allocation.py` | A co-authored Result's `afp:contributionSplit` is integer shares over its authors; a summary's frame is present and every form in it resolvable; the entries recompute from the frame over the merged pool, or the replay says `unresolvable` by name; `afp:inputHash` matches its defined preimage; a dispute points at things that exist and ends in a ratified correction — two standing summaries for one period is a named failure; a retired type spelling is named, never silently aliased |

Where a check needs evidence another party holds — the electorate against the hub's
Enroll trail, a summary against four operators' Results — it is **replay-wide and
three-valued**: pass, fail, or `unresolvable`. The third is printed in the census rather
than recorded as a pass.

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
MANIFEST.json           what this bundle contains — signed since ADR-0012, with its
                        `afp:members` inventory and the signer's `afp:keyHistory`
instance.jsonld         the instance actor
roster.jsonld           the signed roster
actors/<name>.jsonld    agent actors, each carrying a Multikey
outbox/<name>.jsonld    OrderedCollection of signed activities, in chain order
outbox/instance.jsonld  the instance's own Vouch/Disown trail — how the roster came to be
received.jsonld         since P4: the foreign bytes this instance admitted at its boundary,
                        each one checked against its sender's own bundle in a joint replay
artifacts/sha256-<hex>  raw bytes, named by their own digest
```

Several bundle directories on one command line are one **joint replay** (ADR-0009,
ADR-0015): each bundle verifies on its own first, then the cross-checks run over the set
and the census prints what ran per domain.

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
