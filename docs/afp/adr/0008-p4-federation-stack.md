# ADR-0008 — The P4 federation stack: recognition, the boundary, and its record

- **Status:** Accepted, and **built** — P4a and P4b, gated by the first two-instance
  test over real HTTP (see [Build status](#build-status))
- **Date:** 2026-08-20
- **Applies to:** P4 — the federation handshake and the instance boundary. Shared hubs,
  cross-operator CRDT sync and enrollment seats stay P5.
- **Builds on:** [ADR-0001](0001-p1-stack.md) (the signature suite this ADR refuses to
  duplicate), [ADR-0005](0005-operators-are-equal.md) (whose `afp:operatedBy` binding
  becomes fetch-dependent here), [ADR-0006](0006-checkable-actuation.md)/[0007](0007-supersession.md)
  (whose disciplines recur at the boundary)
- **Driven by:** [scenario 08 / campaign 5](../scenarios/README.md#campaign-5--v316v317-adr-0008-adr-0009),
  findings 25–28 and 30 — as sharpened by the scenario's own review pass
- **Explicitly not here:** findings 29a/29b (the two-export verifier and redaction
  stubs) are verifier and record architecture, deferred to their own ADR — deciding them
  as a side effect of a stack ADR is how their hardest questions would get buried

## Context

The solo profile is built, hardened, and gated (ADR-0001–0007). Scenario 08 stressed
the next seam — two operators, one boundary, no shared hub — and found that the
narrowest real federation cannot state its own scope, that a refused stranger and a
silent wire are the same record, that the roadmap's signature wording contradicts a
decision this project already made, that agreement expiry against in-flight work was
never stated, and that the two content-ingestion duties the spec already imposes never
name the boundary as their site.

Three session-wide lessons shape every decision below:

- **Wire-value interpretation is where dual implementations actually diverge.** The
  ADR-0004 build shipped six divergences, none algorithmic — floats, timestamp
  representations, type coercions. At one operator those were latent; a counterparty's
  serializer makes them the *default condition*. Every mechanism this ADR adds lands
  with raw-JSON parity cases, and no boundary rule may compare timestamps as strings.
- **The agreement is the contract's shadow.** The strongest line in the scenario's
  outside-in telling was an operator's: "when the contract ends, it actually ends."
  The agreement's fields exist to mirror commercial terms a lawyer can read — parties,
  what is permitted, until when — and the gate exists to make those terms self-executing.
- **P4 ends the no-daemon era, and that is a bigger operational shift than any object
  here.** The built stack is a library programs visit — nothing listens. A boundary
  means an inbox someone else can reach at times of their choosing: the first resident
  process, with the attack surface and the paging duty that implies. The stack below is
  chosen to keep that resident surface as small as the trust model allows.

## Decisions

### 1. The agreement carries grants, not a hub reference

`afp:FederationAgreement` is established as 01 sketches — `Offer` → countersign → the
co-signed object in **both** outboxes — and its scope becomes a list of **grants**:

```json
{
  "type": "afp:FederationAgreement",
  "afp:parties": ["https://alpha.example/actor", "https://bravo.example/actor"],
  "afp:grants": [
    { "afp:grantType": "direct-delegation", "afp:capabilities": ["afp:cap:assess-security"] },
    { "afp:grantType": "hub", "afp:hub": "https://alpha.example/hubs/proj-x" }
  ],
  "afp:expires": "2027-03-31T23:59:59Z"
}
```

- A **hub grant** admits hub-addressed traffic for that hub; a **direct-delegation
  grant** admits `Offer`/`Accept`/`Result`/`Error` traffic on the named capabilities.
  **Grants do not cross-admit**: the gate checks each inbound activity against *the
  grant that admits it*, never "some grant exists." Scenario 03's hub-scoped agreement
  is the one-grant degenerate case — upward compatible, nothing recorded changes shape.
- 01's gate order is amended where finding 25's review found it dangling: check 4
  (hub-scoped reputation, soft) is **defined as skipped** for direct-delegation
  traffic — there is no hub whose reputation could apply, and an undefined check in a
  hard-gate sequence is how implementations fork.
- **"Co-signed" means dual-Create, not multi-signature.** `attachProof` is
  single-proof by construction (ADR-0001), and this ADR does not touch the
  cryptographic core: each party publishes its **own** signed
  `Create{afp:FederationAgreement}` wrapping a **byte-identical** agreement object,
  whose digest is the agreement's identity. The activation rule a gate enforces
  follows: an agreement is **active** only while the instance holds *both* Creates
  over digest-equal objects — its own, and the counterparty's received via inbox —
  and `afp:expires` has not passed. One Create is an offer on the record, not a
  permission.
- **Replay recomputes admissibility.** For every cross-boundary activity: a co-signed
  agreement between the two operators, active at the activity's `published` instant,
  holding a grant that covers it — or a named failure that says which grants existed
  and why none admitted this. The verifier work is symmetric to `check_enroll_authority`:
  a small module, no new cryptography.

### 2. Payloads keep the one signature suite; the hop gets HTTP Signatures

Finding 27, settled the way 04 already implies: **there is no second payload-signature
suite.** The `eddsa-jcs-2022` object-integrity proof every activity has carried since P1
*is* the payload integrity across relays that 04 §security requires — it travels with
the activity, covers addressing, and survives any number of hops. What P4 adds is
**transport authentication of each hop**: HTTP Signatures on every inbox POST, verified
before anything else runs, unsigned or invalid deliveries audit-logged and dropped
(04's existing rule, now load-bearing).

- HTTP Signatures follow **fediverse practice (draft-cavage)** rather than RFC 9421,
  because the staged Mastodon-facing half (Decision 6) has no choice, and running one
  scheme is cheaper than two. **Amended by [ADR-0017](0017-standards-conformance.md)
  Decision 2:** this ADR's own revisit trigger — fediverse migration toward RFC 9421 —
  has fired (Mastodon 4.7, Fedify), so the scheme inverted: RFC 9421 is native,
  draft-cavage survives as the double-knock fallback for legacy peers. Known wart, recorded here: Mastodon's implementation
  expects RSA keys for HTTP Signatures, while AFP actors publish Ed25519 multikeys —
  the Mastodon-facing delivery path may need an RSA key alongside, on the actor
  document, when that stage lands. The AFP-to-AFP path uses Ed25519 throughout.
- **Wording cleanup lands with this ADR:** the roadmap's P4 row ("LD-Signatures on
  payloads…") and 01's tooling-reuse list are restated in ADR-0001's terms. Pre-ADR-0001
  drift, third instance found this session; the fix is the same each time — name the
  thing the project actually decided.

### 3. The boundary gate leaves a trace it can sign

The two-tier gate runs as 01 orders it — agreement → deny-list → `afp:MembershipProof`
→ reputation-soft — with two of its inputs given the shapes they never had:

- **Check 3 reduces, at P4a, to the fetched-`operatedBy` binding.** In the pairwise
  profile there is no shared roster for a proof object to attest against; what the
  check means here is ADR-0005's issuer rule applied over the wire — the sending
  agent's actor document (fetched from the counterparty) names an `afp:operatedBy`
  that is a party to the admitting agreement. A distinct `afp:MembershipProof`
  *object* is deferred to P5, where hub enrollment gives it content to prove.
- **`afp:Defederate` is a signed activity in the issuing instance's own outbox** —
  actor: the instance, object: the counterparty instance, `summary`: the reason —
  whose local effect is immediate: the agreement is treated as expired *now* and the
  counterparty enters the deny-list. It is advisory to the other side (which may not
  even receive it) and load-bearing on one's own: the record shows when and why the
  door closed, which is what scenario 03 already assumed of it.

Rejection then acquires a record, with its limits stated honestly:

- **Verifiable rejection is impossible in the negative.** ADR-0003 D6 made bid
  rejection checkable because the announce pins who was considered; a boundary stranger
  appears in no roster, no agreement, no announce — there is no commitment point, and
  no export can ever prove the *absence* of unlogged probes. The duty is therefore
  local, and claiming more would be the false assurance this project keeps refusing.
- Local, but stronger than a table: a **hash-chained, instance-signed boundary log** —
  each rejected delivery's digest, actor, claimed type, gate step that refused it, and
  the prior entry's hash. Tamper-evident, exportable as an assertion when an operator
  chooses, corroborable against the prober's own outbox if that ever surfaces.
- The log is **not** per-probe activities in the instance's outbox: a stranger who can
  make you write to your permanent record by knocking has a spam lever on your outbox
  chain. Instead, an optional periodic **`afp:BoundaryDigest`** activity publishes the
  log's running root and entry count — the outbox carries a heartbeat-sized commitment,
  the log carries the detail, and rate limiting (04) stays in front of both.

### 4. Expiry stalls new work, never in-flight work — with a backstop that pays everywhere

Finding 28's ruling becomes normative, mirrored from P5's hub-availability gate:

- From the expiry instant (or `afp:Defederate`, which is expiry now plus a deny-list
  entry): new cross-boundary `Offer`s are refused at the gate. Activities on a
  `correlationId` whose `Accept` predates expiry remain deliverable until that
  correlation reaches its terminal outcome — a Result, or an `afp:Error` whose code is
  named in 03 per the error-code house rule.
- **The recipient's gate, on the recipient's clock.** At P4, skew is accepted and each
  operator's gate is authoritative for what it admits; cross-operator clock discipline
  is revisited at P5, when shared state gives clocks something to disagree about.
- Replay compares three instants the record already carries — Offer `published`,
  Accept `published`, agreement `afp:expires` — **as instants, never strings**
  (`instantMillis`/`instant_millis`, the session's hardest-won lesson). Named failures:
  a post-expiry Offer admitted; a late outcome with no in-time Accept.
- **The monotonicity backstop**, adopted globally: `published` MUST be non-decreasing
  along each actor's `afp:prevActivity` chain, checked by the verifier for every chain
  in every export. Chain position then brackets any backdated timestamp between
  honestly-dated neighbors. Collusive backdating buys nothing a colluding pair could
  not buy by co-signing a longer agreement — the check defends the honest counterparty
  and the third-party auditor, which is who every check here defends. Backward
  compatible: every existing export was written by monotonic clocks.

### 5. The boundary is a port, and both ingestion duties are sited there

Finding 30, one paragraph of spec and one sentence of principle. A counterparty's
`Result` is **third-party content**: it ran attacker-controllable instructions in
someone else's environment, and its prose is a stranger's text. Both existing duties
apply at the boundary and the spec will say so where each lives:

- 04's sandbox duty (checksum, content-type sniffing, size limits, isolated execution
  of anything fetched) runs **before** anything trusts a cross-boundary attachment.
- 03's port-ingestion duty runs on the content: a counterparty's deliverable enters the
  record as hash-addressed evidence, and what a downstream brain acts on is the
  receiving port's own bounded summary. *An agreement authenticates the counterparty;
  it does not sanitize their output.* "We have an agreement with them" and "their
  output is safe to execute" are unrelated claims — the scenario's near-miss, stated as
  a rule.

### 6. Build staging: the trust core first, the shop window second

P4's roadmap row bundles two deliverables with different risk profiles. They are built
in order:

- **P4a — the trust core**: Decisions 1–5, the inbox listener, `afp:MembershipProof`,
  deny-list and `afp:Defederate`, authorized fetch enforced against a real peer. Gate:
  scenario 08's shape — Mallory hard-rejected with a boundary-log entry, 404-not-403,
  a post-expiry Offer refused while the in-flight Result lands.
- **P4b — operator visibility**: dual-publish shadow Notes, the narrow inbound command
  grammar, `afp:AuditGrant` served over authorized fetch. Nothing in P4b gates P4a, and
  the RSA interop wart lives entirely here.

**Runtime shape, mapped to the seams that exist.** The boundary is not a new
architecture; it is two bounded changes to named files. Sending side: an
`HttpTransport` implementing the existing `Transport.deliver(target, activity)` port
(`store/queue.ts`) — the same seam every in-process delivery already crosses, so
retry, backoff and dead-lettering come along unchanged. Receiving side: an inbox
`POST` route on `ap/server.ts` (today `GET`-only by design) that runs HTTP-Signature
verification, then the gate, then hands the activity to the same dispatch the local
transport feeds. **The bootstrap that makes signed fetch possible**: actor documents
are `public`, so the unauthenticated fetch of a counterparty's actor document is the
anchor — its published keys then verify that counterparty's signed requests for
everything above `public`. The regress terminates by visibility design, and P4
depends on it staying that way.

**The gate's test harness is two real instances in one test process** — two
`AfpInstance`s with distinct origins (the ADR-0005 gate already proved that
construction), real HTTP over ephemeral localhost ports, real signatures, no mocked
wire. HTTP Signatures themselves need **no Python mirror**: transport authentication
is ephemeral and never enters the record, so the verifier never sees it — the parity
clause below deliberately scopes to derivations that land in the record, and that
asymmetry is correct, not an omission.

Parity discipline is not optional for any of it: every derivation or comparison this
ADR adds (grant admissibility, expiry instants, boundary-log chaining) lands with
raw-JSON cases in the shared parity harness before its gate is called done.

## Options considered

| Option | Rejected because |
|---|---|
| Keep hub-only agreement scope, model direct delegation as a degenerate one-party hub | A fiction in the record: a "hub" nobody operates, with lifecycle rules nothing runs — and P5 would inherit the lie |
| A second payload-signature suite (true LD-Signatures) for relayed objects | Re-imports the RDF-canonicalization tarpit ADR-0001 was written to escape, for a guarantee the existing object proof already provides end to end |
| RFC 9421 HTTP Signatures (the modern standard) | The Mastodon-facing stage cannot use it; two transport-auth schemes for one boundary is complexity spent against the wrong risk |
| Per-probe rejection activities in the instance outbox | Hands strangers a write lever on the permanent record; the hash-chained local log with a periodic published root keeps tamper-evidence without the spam surface |
| Expiry kills in-flight work | Turns every agreement's final week into a dead zone and punishes the compliant counterparty mid-delivery — the scenario's operator named completion-with-a-hard-edge as the property that sold the design |
| A trusted timestamp authority instead of the monotonicity backstop | A third party in a two-party trust model; the backstop gets bracketing from evidence already signed, which is this project's move every time |
| Decide 29a/29b here while context is warm | The two-export replay and redaction stubs are the deepest changes on the docket; deciding them in a stack ADR's margins is how "deliberate redaction looks like deletion" would ship unexamined |

## Consequences

**Positive**

- The narrowest federation — one counterparty, one capability, no hub — becomes
  first-class, stateable, and replayable, which is how most federations will start.
- The boundary inherits the record's character: refusals chain, expiry is checkable,
  actions on foreign answers stay policy-bound (ADR-0006 needs no boundary amendment —
  `afp:actsOn` digests cross unchanged).
- The monotonicity backstop hardens every timestamp-dependent rule retroactively, at
  the cost of one verifier check.

**Negative / accepted risks**

- **The resident process.** An inbox listener is a standing attack surface where none
  existed; the operator's Tuesday gains a thing that can page. Mitigated by P4a's
  minimalism (verify-then-gate before any parsing beyond the envelope) and rate
  limiting, accepted as the irreducible price of being reachable.
- Draft-cavage is a dead-end standard adopted for compatibility. Accepted with a
  revisit trigger rather than fought now.
- The boundary log is only as durable as the instance's own storage discipline — it is
  custody-grade, not consensus-grade, and Decision 3 says so out loud.

**Revisit triggers**

| Trigger | Reconsider |
|---|---|
| Fediverse migration toward RFC 9421 | Whether the transport-auth scheme follows |
| A third operator (n≥3) or scenario 03's shared-hub workload | P5's stack ADR — grants meet enrollment seats (ADR-0005 E4 fires there) |
| The two-export verifier ADR lands | Whether `afp:BoundaryDigest` should be a required input to a federated replay rather than an operator option |
| An agreement wants renegotiation without expiry-and-resign | Amendment semantics — currently a new agreement is the only edit |

## Build status

All eight tasks are built; the two-export verifier (29a) and redaction stubs (29b)
remain tracked by their own forthcoming ADR. The gate is `test/adr0008.test.ts` — two
real `AfpInstance`s with distinct origins over ephemeral localhost HTTP, real
signatures, no mocked wire — running scenario 08's shape end to end, plus
`test/adr0008b.test.ts` for P4b.

| ID | Task | Stage |
|---|---|---|
| **F1** ✅ | `afp:FederationAgreement` with grants; handshake builders; gate module (agreement → deny-list → proof → soft-reputation, check 4 skipped for direct grants) | P4a |
| **F2** ✅ | The boundary on the existing seams: `HttpTransport` implementing `Transport.deliver` (send), inbox `POST` on `ap/server.ts` (receive) — signature verification, then the gate, then the same dispatch local transport feeds | P4a |
| **F3** ✅ | Hash-chained boundary log + optional `afp:BoundaryDigest`; rate limiting in front | P4a |
| **F4** ✅ | Expiry semantics at the gate; verifier: grant admissibility, expiry instants, and the global `published`-monotonicity check | P4a |
| **F5** ✅ | Boundary ingestion: sandbox + summarize duties enforced at the receiving port | P4a |
| **F6** ✅ | Spec text: 01/03/04 amendments, roadmap-row and 01:13 wording cleanup, error codes named per the house rule | P4a |
| **F7** ✅ | Parity cases for every new derivation, in the raw-JSON harness | P4a |
| **F8** ✅ | Shadow Notes, command grammar, `afp:AuditGrant` over authorized fetch; the RSA interop wart | P4b |

## References

- [Scenario 08 — the subcontract](../scenarios/08-the-subcontract.md) and its
  [outside-in telling](../scenarios/08-the-subcontract-story.md) ·
  [the operator's Tuesday](../scenarios/the-operators-tuesday.md) — the no-daemon
  baseline Decision 6's listener ends
- [01 — two-tier trust & the handshake](../01-foundations.md) ·
  [04 — security](../04-operations.md) · [05 — roadmap P4/P5 rows](../05-roadmap.md)
- [ADR-0001](0001-p1-stack.md) — the suite Decision 2 refuses to duplicate ·
  [ADR-0004](0004-solo-foundation-hardening.md) §"A note on the parity work" — why
  Decision 6's parity clause is not ceremony
