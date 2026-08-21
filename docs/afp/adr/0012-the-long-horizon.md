# ADR-0012 — The long horizon: verifying old exports, and what a bundle contains

- **Status:** Accepted, and **built** — gated by a key rotation that strands nothing
  (exports from either side of it verify), by each new claim failing its own mutation,
  and by a pre-ADR-0012 bundle verifying unchanged
- **Date:** 2026-08-21
- **Applies to:** any deployment with a retention duty longer than a key's working
  life — statutory audit horizons (five-plus years), regulatory archives, and any
  export expected to verify after the instance that produced it has rotated, migrated,
  or died
- **Builds on:** [ADR-0001](0001-p1-stack.md) (the signatures that must keep
  verifying), [ADR-0009](0009-federated-replay.md) (the manifest and export format
  this ADR extends — and the content-inventory question it left implicit)
- **Driven by:** [scenario 09 / campaign 6](../scenarios/README.md#campaign-6--open),
  finding 40, and the sharp half of finding 32

## Context

The record's whole promise is "a stranger holding no keys can replay it" — and the
promise quietly expires with the first key rotation. 01's guidance treats a rotated
key as *revoked*; the actor document is a current-state document; and `instance`
custody means one instance key signs everything, so a single routine rotation strands
the entire prior corpus for a verifier that resolves keys from the current document.
Scenario 09's deployment carries a five-year statutory horizon: an export produced in
year one, demanded in year four, verifies against keys the actor document no longer
carries. The failure is silent today and total on the day it matters.

Around the same horizon, three softer duties turn out to be load-bearing: external
anchoring of chain heads is a SHOULD (04, 06) — but without a time anchor, "was this
signed before or after the key was compromised" has no answer, which is the entire
question in an integrity dispute; artifact retention is scoped to *federation
lifetime* (07: "the digest still proves what was claimed even when bytes are gone") —
but a data subject is entitled to the bytes their application consisted of, not to a
digest of them; and ADR-0009 specified how an export is *scoped* without ever stating
what a bundle *contains* — in particular whether hub CRDT state is in it at all,
which is where finding 32's redaction question dead-ends: state with no thread has no
seam for the stub machinery to cut.

## Decisions

### 1. The manifest carries the signing-key history

The export manifest gains **`afp:keyHistory`**: for every key that signed anything in
the bundle — per actor — the `keyId`, the public key, its validity interval
(`afp:validFrom` / `afp:validUntil`, the latter absent for keys still active), and how
it left service:

```json
"afp:keyHistory": [
  { "afp:actor": "https://alpha.example/agents/writer",
    "id": "https://alpha.example/agents/writer#ed25519-key",
    "publicKeyMultibase": "z6Mk…",
    "afp:validFrom": "2026-01-01T00:00:00Z",
    "afp:validUntil": "2026-06-01T00:00:00Z",
    "afp:retiredBy": "rotation" }
]
```

`afp:retiredBy` is `rotation` or `revocation`, and it is on the record rather than
inferred from whether an interval happens to be closed — Decision 2 turns on that
distinction, and a reader should not have to reconstruct it.

**`afp:validFrom` is absent when the key's start was never recorded, and absent means
unbounded below.** A first key predating any key store has no knowable beginning, and the
tempting substitutes — the PEM's mtime, the moment the exporter ran — are guesses dressed
as facts. The failure they cause is not symmetric: a synthesized start *later* than
activities the key legitimately signed fails exactly the corpus this ADR exists to keep
verifiable, and it fails it silently, years later, for a key that was never rotated at
all. Rotation and revocation supply instants the record genuinely knows — the rotation,
the compromise — and those get written down. A beginning is not one of them. (A key store
also has no clock of its own: the instance's may be a replay or test clock running years
from wall time, so stamping a start there dates the key by when a *process* ran.)

The verifier resolves each activity's signature against the key valid *at its
`published` instant* rather than against the current actor document alone. A signature by a key outside its declared
interval is a named finding, and so is a **gap**: the intervals for an actor MUST cover
every activity in its chain, because a chain reaching into a period no declared key
covers is a chain signed by something the bundle refuses to name.

**What signing the history proves, and what it does not.** The manifest is signed at
export time with the instance's current key, so the history is internally consistent and
tamper-evident: today's key vouches for yesterday's. That much is real. What it is not is
*grounding* — the verifier reads the current key from the bundle too, so a forger who
controls the whole export can produce a coherent history for keys that never existed.
This is not a regression (an export's instance document has always been self-asserted;
replay checks internal consistency and external trust arrives out of band) but the
history widens what the self-assertion claims, so the honest statement belongs in the
spec rather than in a reader's assumptions: **the key history is exactly as trustworthy
as the thing anchoring it** — the live actor document while the instance still exists,
ADR-0009's partition at P4+ where a domain's history is believed only from its own
export, and Decision 3's external anchor once neither of those is available. A bundle
with a key history and no anchor is self-consistent, not proven.

One check the bundle *can* make on itself, and MUST: the key that signed the manifest
MUST itself appear in the history and be valid at the manifest's own instant. An export
signed by a key its own history says was retired is incoherent on its face.

**Two mechanical facts this decision depends on, neither of which exists yet.**

*Key ids must be able to coexist.* A `keyId` is derived today as
`{controller}#ed25519-key` — one deterministic id per actor, which is exactly the shape a
history cannot express: a rotated key and its successor would collide in the same
`verificationMethod` id-space, and a bundle cannot say which of two keys a signature
names. Rotation therefore **versions the id**: the first key keeps `#ed25519-key`
unchanged, and each rotation appends an ordinal — `#ed25519-key-2`, `#ed25519-key-3`.
Keeping the first id unversioned is not cosmetic; it is what lets every export written
before this ADR keep verifying against ids it already contains.

*The manifest must become a signed document.* It is plain unsigned JSON today — counts
and names, nothing attesting to them — so "the manifest the instance signs" is new
machinery rather than an extension of an existing signature. It gains the same
`DataIntegrityProof` every other document carries, over the same JCS canonicalization,
which also means the export's self-description stops being the one part of a bundle
anybody could edit freely. A bundle whose manifest carries no proof is read as
pre-ADR-0012 and checked as it is today; a manifest that carries one must verify.

### 2. Rotation and revocation stop being the same word

01's key guidance is amended — it currently says to "treat the old `keyId` as revoked",
which is the conflation this decision undoes. **Rotation** archives: the superseded key
keeps its validity interval and remains part of the history, `afp:retiredBy: "rotation"`,
and everything it signed in-interval verifies forever. **Revocation** cuts: a compromised
key's interval is *terminated at the compromise instant*, `afp:retiredBy: "revocation"`,
and activities signed after that instant fail. The current actor document remains the
source for *new* trust; the key history is the source for *old* signatures. Neither
substitutes for the other.

**The interval is compared against `published`, which the signer asserts.** This is the
decision's real limit and it must be stated where an implementer will meet it. A holder
of a compromised key can date an activity before the cut, and the interval check alone
will admit it. Three things narrow that, none of which is the check itself: the activity
must also occupy a position in a hash chain whose neighbours' digests already exist, so a
backdated activity has to be spliced rather than appended; ADR-0008's chain-wide
`published` monotonicity means the splice has to be consistent with everything around it;
and Decision 3's external anchor pins chain heads to instants the signer does not
control, which is what finally makes "before or after the compromise" answerable rather
than merely assertable.

So the honest ordering is: the interval check catches the routine case — a key used past
its retirement, a bundle whose history does not cover its own chain — and the anchor is
what makes it catch an adversary. An unanchored deployment gets the hygiene, not the
proof, and Decision 3 is why a deployment with a statutory duty does not get to stop at
hygiene.

### 3. Deployments with retention duties MUST anchor, and MUST keep the bytes

Two SHOULDs are upgraded to MUSTs, conditionally — and the condition is **declared on
the record, which is what makes it checkable at all**. The manifest carries
`afp:retentionDuty`:

```json
"afp:retentionDuty": { "afp:horizon": "P5Y", "afp:basis": "EU AI Act Art. 12" }
```

Declaring it is what turns the MUSTs on. That direction matters: the verifier cannot
know from bytes whether a deployment is subject to a statute, and a rule keyed on
something unknowable is decoration. Keyed on a declaration, it is exact — a bundle
that declares a duty and fails the duty's obligations fails by name, and a bundle that
declares none is held to the SHOULDs as before. The obvious objection is that a
deployment can evade the checks by not declaring; that is true and is not this ADR's
problem to solve — *whether* the duty exists is a question for the auditor and the
statute, and the protocol's job is that a deployment which says it is holding a
five-year record is held to what that means. Silence is visible, and an auditor reading
a bundle with no declared duty where one is owed has learned something.

The two obligations, scoped to a declared duty:

- **Anchoring:** chain heads MUST be anchored outside the trust domain on a cadence
  proportionate to the duty (write-once media, a timestamping service, or shadow
  Notes to an external server — the 04/06 menu, now mandatory for this class). The
  anchor is what makes key-compromise disputes decidable and what backs Decision 2's
  interval cuts. Anchors are recorded in the manifest as `afp:anchors`: per entry, the
  anchored actor, the chain-head digest, the instant, and an external reference
  (`afp:anchorRef` — a URL, a transaction id, a media serial).

  **What the verifier can check, and where the auditor takes over.** In-bundle: that a
  declared duty is accompanied by at least one anchor, and that every anchored digest is
  in fact a chain head the bundle contains. Note what is deliberately *not* checked:
  whether the anchoring kept to a cadence. "Proportionate to the duty" is guidance to an
  operator, not a field — nothing on the record declares a cadence, and a check against
  an undeclared quantity would be a check against an assumption. If a deployment class
  ever needs cadence enforced, the cadence has to be declared first, and that is a
  different ADR. What the verifier also cannot do is dereference the anchor —
  a verifier reaches no network by design, and an anchor that resolves to nothing looks
  identical to one that resolves correctly. So the last step is an auditor's, exactly as
  ADR-0009 left the counterparty who refuses to export: the bundle proves it *claims* an
  anchor and that the claim is internally coherent; a person checks the timestamping
  service. Naming that seam is better than a check that implies more than it performs.
- **Artifact retention:** the bytes of every artifact referenced by a retained
  activity MUST be kept for the retention horizon. The digest-survives-the-bytes rule
  (07) remains the *federation* floor; it is not a retention policy. For everyone
  else both remain SHOULDs — this ADR adds no burden to a weekend deployment.

### 4. A bundle's contents are enumerated — and CRDT state is not among them

The export bundle is, exhaustively: the instance document, the roster, per-actor
outboxes (stubs included per ADR-0009), hub outboxes, artifacts, received
activities, and the manifest — and the manifest **enumerates** them as `afp:members`, a
sorted list of every file path relative to the bundle root, so "what this bundle
contains" is a declaration rather than a directory listing:

```json
"afp:members": ["artifacts/sha256-4b71….bin", "instance.jsonld",
                "outbox/reviewer.jsonld", "outbox/writer.jsonld", "roster.jsonld"]
```

Paths, not digests: the contents are already covered by signatures and the artifact
digests they reference, and a second integrity layer over the same bytes would be
ceremony. What was missing was the *set*. `MANIFEST.json` is not a member of its own
list, for the obvious reason. The enumeration is
what makes the rule checkable in both directions: a member present but undeclared is a
finding (something travelled that the export does not admit to carrying), and a member
declared but absent is the one ADR-0009 already names (a hole where the scope promised
content). Before this, an export was whatever happened to be on disk when someone
zipped it.

**Hub CRDT state is a projection and is not exported.**
02 already states the principle — CRDTs converge *state*; *work* stays in threaded
activities — and this decision gives it its consequence: anything that must ever be
disclosed, redacted, retained, or replayed MUST live in activities, because
activities are the only thing the export, the stub machinery, and the verifier can
see. A deployment that parks subject content in an application CRDT has put it
somewhere no audit view can lawfully cut — finding 32's dead-end, now a stated rule
instead of a surprise. (The companion deployment guidance — thread as the
subject-scoped unit where disclosure is per-subject — lands in 06, not here; this
decision is the protocol fact it rests on.)

## Options considered

| Option | Rejected because |
|---|---|
| Resolve old signatures against archived actor-document versions (document history instead of key history) | Requires retaining and serving every historical document revision; the manifest already exists, is signed, and travels with the bundle — the key history is the minimal fact needed |
| Timestamping service required for all deployments | The conditional MUST keeps the weekend deployment free; the duty-bearing deployment was already paying for retention — anchoring is marginal |
| Keep rotation-as-revocation, re-sign old history with the new key | Re-signing history is the exact operation every other ADR treats as the attack; the fix cannot be the crime |
| Export CRDT state with its own redaction mechanism | Builds a second disclosure machinery for a store 02 says should not hold disclosable work; stating the boundary is cheaper and firmer than doubling the surface |
| Put the key history in each actor document rather than the manifest | The actor document is live state serving current trust; the manifest is the export's self-description — old-signature resolution is the export's problem |
| Infer rotation vs revocation from whether an interval is closed | Every retired key has a closed interval; the distinction that matters is *why*, and leaving it to inference means the two cases are the same bytes. `afp:retiredBy` costs one field and makes a compromise legible as a compromise |
| Key the retention MUSTs on the deployment rather than on a declaration | A verifier cannot know from bytes whether a statute applies; a rule conditioned on the unknowable is decoration. Keyed on a declaration it is exact, and an undeclared duty is itself visible to an auditor |
| Have the verifier dereference anchors | A verifier reaches no network by design (it is the property that lets a stranger replay a bundle offline years later); a check that implied it had verified an external timestamp would claim more than it performed |
| Let the key history be optional for everyone, forever | Then the deployment that most needs it is the one least likely to have configured it. The conditional MUST attaches it to the declared duty, where the cost is already being paid |

## Compatibility and migration

- **An absent `afp:keyHistory` means today's behaviour, not a failure.** Every existing
  export has none; those bundles resolve keys from the instance document exactly as they
  do now. Without this the ADR would strand the entire existing corpus in the name of not
  stranding corpora.
- **The interval checks attach per *key*, not per bundle.** A `verificationMethod` the
  history declares must satisfy its interval; one the history does not declare resolves
  from the actor documents as it always has. This is not a loophole — an undeclared key is
  no weaker than it is today — and it is required for correctness rather than merely for
  tolerance: agents hold hub-scoped keys alongside their P1 key, and those sign votes,
  bid commits and reveals. A rule of "every activity must resolve to a declared interval"
  would fail every P2 and P3 bundle in the repository for the offence of using a key the
  export never claimed to have a history for.
- **The content inventory is the one retroactive check**, and it is deliberately mild: a
  bundle whose manifest declares no members is read as pre-inventory and skipped, rather
  than failed for lacking a field that did not exist when it was written.
- **`afp:retentionDuty` turns checks on, never off.** A bundle that declares none is held
  exactly where it is held today.
- **01's key-rotation paragraph is amended in place** — "treat the old `keyId` as
  revoked" is the sentence Decision 2 exists to correct, and leaving it standing while
  the verifier implements the opposite is the drift these sweeps keep finding.
- **Spec sweep** once built: 01's rotation guidance; 04's replay procedure gains the
  key-resolution step (which is where an interval is consulted, and the procedure's list
  is P1-era); 07's artifact-retention floor gains the conditional MUST; ADR-0009's
  manifest description gains the new members.

## Consequences

**Positive**

- An export verifies at year four exactly as at day one; rotation becomes routine
  hygiene instead of a silent corpus-stranding event.
- Compromise disputes become decidable: interval cut plus external anchor answers
  before-or-after.
- The bundle's contents are a stated fact; finding 32's redaction question gets its
  floor (nothing undisclosable hides in state), and the 06 guidance has protocol to
  stand on.

**Negative / accepted risks**

- The manifest grows a security-critical section; a forged key history is now the
  attack to consider. Contained by the signing chain (current key signs the history)
  plus anchoring — and by ADR-0009's partition at P4+: a domain's key history is
  believed only from its own export.
- Conditional MUSTs introduce a deployment classification ("holds a retention duty")
  the spec must define crisply enough to be checkable at all.
- The CRDT rule constrains application design retroactively for any deployment that
  already parked disclosable content in state. The migration is theirs; the
  alternative was building disclosure machinery for a store designed not to need it.

**Revisit triggers**

| Trigger | Reconsider |
|---|---|
| Post-quantum migration of the signature suite | Whether `afp:keyHistory` needs per-suite entries and a cross-suite trust chain |
| A deployment needs CRDT state in a case file (e.g. a frozen hub's final state as evidence) | Whether an `afp:Archive` snapshot activity (07) is the sanctioned carrier — state entering the record *as an activity*, keeping Decision 4 intact |
| Key custody moves agent-side (`self` custody at scale) | Whether per-agent histories aggregate in the manifest or per actor document |

## Build status

Built. The staging was forced: nothing can be rotated until a key store can
hold two keys for one actor, and nothing can be checked until the manifest can carry —
and attest to — what the checks read.

| ID | Task | Where | Stage |
|---|---|---|---|
| **Z1** ✅ | Versioned key ids and a rotation primitive: `keyId` stays `#ed25519-key` for a first key and takes an ordinal on each rotation; `KeyPair` carries `validFrom`/`validUntil`/`retiredBy`, persisted beside the PEM (only the raw PEM is written today). `loadOrCreateKeyPair` is load-or-create *only* — the rotate path is new, as is the revocation cut that closes an interval at a compromise instant | `crypto/keys.ts` | 1 |
| **Z2** ✅ | The manifest becomes a signed document (`@context` + `DataIntegrityProof`; it is schemaless unsigned JSON today) and gains `afp:keyHistory`, `afp:members`, and — when declared — `afp:retentionDuty` and `afp:anchors` | `export.ts`, `crypto/proof.ts` | 1 |
| **Z3** ✅ | Verifier: interval-aware key resolution. `collect_public_keys` returns a flat `id → bytes` map and `verify_proof` looks up by id alone, so both gain the `published` dimension; `Authority`/`check_authority` gain the same for revocation cuts. New checks: out-of-interval signature, a chain reaching into a period no declared key covers, and the manifest's own proof resolving to a key its history says was valid then | `afp_verify.py`, `proof.py` | 2 |
| **Z4** ✅ | Verifier: the content inventory — every file in the bundle is declared in `afp:members` and every declared member is present. A manifest with no `afp:members` is pre-inventory and skipped, never failed | `afp_verify.py` | 2 |
| **Z5** ✅ | The declared-duty obligations: when `afp:retentionDuty` is present, at least one anchor exists, every anchored digest is a chain head the bundle actually contains, and every artifact referenced by a retained activity has its bytes present rather than only its digest. The anchor is never dereferenced — that seam is the auditor's | `afp_verify.py`, `export.ts` | 2 |
| **Z6** ✅ | Gate `test/adr0012.test.ts`: export → rotate the instance key → publish more → re-export → **both** bundles verify; then a forged interval, a signature dated outside its key's interval, a chain period no key covers, an undeclared file added to the bundle, a declared duty with no anchor, and an anchor naming a digest that is not a chain head — each failing by name | `test/adr0012.test.ts` | 3 |
| **Z7** ✅ | Regression: every existing export verifies unchanged. All of them predate every field here — unsigned manifest, no history, no members — so the whole ADR must be a no-op on them or it has stranded the corpus it exists to protect | `export*/`, `test/*` | 3 |

Decision 4 needs no code to *remove* anything: `exportBundle` already never reads the
CRDT store, so the rule states a fact the implementation already has. What Z4 adds is the
inventory that makes the fact checkable rather than incidental.

## References

- [Scenario 09 — the screening sidecar](../scenarios/09-the-screening-sidecar.md),
  finding 40 and the sharp half of finding 32
- [ADR-0009](0009-federated-replay.md) — the manifest this extends, and the
  authority partition that contains the forged-history attack at P4+
- [ADR-0007](0007-supersession.md) — "never an erasure," which is why re-signing
  history was never on the table
