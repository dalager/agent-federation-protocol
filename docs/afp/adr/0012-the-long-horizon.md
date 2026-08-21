# ADR-0012 — The long horizon: verifying old exports, and what a bundle contains

- **Status:** Proposed
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
the bundle — per actor — the `keyId`, the public key, and its validity interval
(`afp:validFrom` / `afp:validUntil`, open-ended for keys still active). The history
is part of the manifest the instance signs at export time with its *current* key,
which chains trust: today's key vouches for yesterday's, and the verifier resolves
each activity's signature against the key valid *at its `published` instant* rather
than against the current actor document alone. A signature by a key outside its
declared interval is a named finding.

### 2. Rotation and revocation stop being the same word

01's key guidance is amended. **Rotation** archives: the superseded key keeps its
validity interval and remains part of the history — everything it signed in-interval
verifies forever. **Revocation** cuts: a compromised key's interval is *terminated at
the compromise instant*, and activities signed after that instant fail — which is
only decidable because Decision 3 gives the record a time anchor to decide it
against. The current actor document remains the source for *new* trust; the key
history is the source for *old* signatures. Neither substitutes for the other.

### 3. Deployments with retention duties MUST anchor, and MUST keep the bytes

Two SHOULDs are upgraded to MUSTs, conditionally — scoped to deployments holding a
declared retention duty (statutory or contractual):

- **Anchoring:** chain heads MUST be anchored outside the trust domain on a cadence
  proportionate to the duty (write-once media, a timestamping service, or shadow
  Notes to an external server — the 04/06 menu, now mandatory for this class). The
  anchor is what makes key-compromise disputes decidable and what backs Decision 2's
  interval cuts.
- **Artifact retention:** the bytes of every artifact referenced by a retained
  activity MUST be kept for the retention horizon. The digest-survives-the-bytes rule
  (07) remains the *federation* floor; it is not a retention policy. For everyone
  else both remain SHOULDs — this ADR adds no burden to a weekend deployment.

### 4. A bundle's contents are enumerated — and CRDT state is not among them

The export bundle is, exhaustively: the instance document, the roster, per-actor
outboxes (stubs included per ADR-0009), hub outboxes, artifacts, received
activities, and the manifest. **Hub CRDT state is a projection and is not exported.**
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

Nothing is built.

| ID | Task | Stage |
|---|---|---|
| **Z1** | `afp:keyHistory` in the manifest; export-time collection from the key store | 1 |
| **Z2** | Verifier: interval-based key resolution; out-of-interval finding; manifest-signature chain check | 1 |
| **Z3** | Rotation vs revocation in the instance key store (intervals, compromise cuts) | 2 |
| **Z4** | Content-inventory statement in 04/ADR-0009 territory; verifier rejects bundles with undeclared members | 2 |
| **Z5** | Gate: export → rotate the instance key → re-export → both bundles verify; mutate the key history (forged interval) → fails by name; sign after a revocation cut → fails by name | 3 |

## References

- [Scenario 09 — the screening sidecar](../scenarios/09-the-screening-sidecar.md),
  finding 40 and the sharp half of finding 32
- [ADR-0009](0009-federated-replay.md) — the manifest this extends, and the
  authority partition that contains the forged-history attack at P4+
- [ADR-0007](0007-supersession.md) — "never an erasure," which is why re-signing
  history was never on the table
