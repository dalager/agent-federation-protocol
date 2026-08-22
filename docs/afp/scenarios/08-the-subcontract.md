# Scenario 08 — The subcontract: two operators, one boundary, no shared hub

> Spec-test scenario, the P4 shakedown: the **federation handshake and nothing else**.
> Exercises: `afp:FederationAgreement` as a hub-less contract shadow, the two-tier gate
> proven against an uninvited third operator, direct cross-boundary delegation on the P1
> flow, authorized fetch in both directions, the operator's Mastodon window, agreement
> expiry against in-flight work — and the first **two-export replay**, where completeness
> stops being a single-operator concept. Deliberately refuses to open a shared hub:
> cross-operator hubs, enrollment seats and CRDT sync are P5's scenario, not this one.
> Verdict at the end. An outside-in companion —
> [the same events as the people involved tell them](08-the-subcontract-story.md) —
> carries the human side: how it was sold, what it cost, what was harder than expected.

| **Support status** | **Supported — all findings closed** |
|---|---|
| Findings raised | 7 |
| Resolved by | [ADR-0008](../adr/0008-p4-federation-stack.md), [ADR-0009](../adr/0009-federated-replay.md) |
| See it run | `npm run demo:p4` |
| Gated by | `adr0008.test.ts`, `adr0008b.test.ts`, `adr0009.test.ts` |

**Read the walkthrough below as history.** It records what strained when this workload was
first walked, and is deliberately left as written — that is what makes a scenario evidence
rather than a brochure. Every strain it names is now built; the
[support index](README.md#is-this-workload-supported) is the current-status view, and the
ledger there names the decision that closed each finding.


## User story

**As** the lead of the integration practice (scenario 05) — whose client engagement now
includes a security assessment of the MitID integration, a domain the practice does not
cover —
**I want** to subcontract that assessment to a boutique security firm running its own
AFP instance, delegating the task directly to their assessor and getting back a signed,
evidence-bound Result,
**so that** I can hand my client a record proving what the subcontractor did and what it
rested on — without either firm seeing inside the other's systems, and without standing
up shared infrastructure for a four-week engagement.

## Cast

Two instances, each behind its own firewall. **No shared hub** — the practice's standing
hub stays local to the practice, and Bravo is never enrolled in anything.

| Instance | Agents in play | Capability |
|---|---|---|
| `integration.consultancy.example` (**Alpha** — scenario 05's practice) | `i-identity` (delegates, holds the client context), `i-archivist` (serves artifacts) | `afp:cap:integrate`, `afp:cap:recall` |
| `sec.boutique.example` (**Bravo**) | `b-assessor` | `afp:cap:assess-security` |
| `mallory.example` (**Mallory** — uninvited) | `m-probe` | validly keyed, party to nothing |

Mallory is not a broken peer; it is a *correct* one that was never agreed with. Every
probe it sends is validly signed against its own published keys — which is exactly why
signature verification alone cannot be the gate.

## Walkthrough

**1. The handshake is the subcontract's shadow.** `Offer{afp:FederationAgreement}`
Alpha→Bravo: expiry at the engagement's end, and scope naming **direct delegation on two
capabilities** — no hub. Bravo countersigns; the co-signed agreement lands in both
outboxes as the trust anchor (01). And here the vocabulary strains immediately: 01's
two-tier gate is worded "an active, unexpired `FederationAgreement` **scoped to this
hub**" — the scope grammar is hub-shaped, and this agreement's honest scope is a
capability list and a counterparty, with no hub to name. The narrowest real federation
has no place to put its narrowness.

**2. The gate earns its keep before any work does.** Mallory delivers a validly-signed
`Offer{afp:Task}` to `b-assessor`. Bravo's gate runs agreement-before-everything: no
active agreement with `mallory.example` → **hard-rejected**, unopened. Mallory then
fetches a `parties`-scoped activity from Alpha's outbox: **404, not 403** — to a peer
outside the parties, non-membership does not even confirm existence (07). Both are P4's
own gate criteria, exercised by an adversary rather than asserted. But the rejection
itself raises the scenario's second strain: Bravo dropped the Offer *silently*. An
admission decision that leaves no trace is the pattern ADR-0003 Decision 6 rejected at
bid admission and ADR-0006 rejected at actuation — at the boundary, "we never dealt with
Mallory" is currently indistinguishable from "we never heard from Mallory."

**3. The delegation is the P1 flow with a firewall in it.** `i-identity` sends
`Offer{afp:Task}` directly to `b-assessor`: requirements as a hash-addressed,
`parties`-scoped attachment, `correlationId` fresh, deadline set. Bravo `Accept`s. What
is new is only the hop: the delivery now crosses operators, so transport authentication
(HTTP Signatures) joins the object integrity proofs every activity has carried since P1.
And here the roadmap's own wording strains: the P4 row says **"LD-Signatures on payloads
crossing an instance boundary"** — a phrase that predates ADR-0001, which chose
`eddsa-jcs-2022` object proofs precisely to avoid RDF canonicalization. The payloads
crossing this boundary are *already signed, portably*; what the hop needs is transport
auth, not a second signature suite. The scenario runs on that reading and flags the row
as drift for ADR-0008 to settle.

**4. Authorized fetch, both directions, is what the boundary makes of old duties.**
`b-assessor` fetches the requirements artifact from `i-archivist` — authorized because
Bravo is a party, over an authenticated fetch. In the other direction, Alpha resolves
`b-assessor`'s actor document from Bravo — which is what `afp:operatedBy` *means* across
a boundary: ADR-0005's issuer binding, and every "whose agent is this" question after
it, now rests on fetching the counterparty's published documents rather than reading a
local roster. The trust source does not change; the transport under it does.

**5. The work happens behind Bravo's port — and what comes back is not yet trusted.**
`b-assessor`'s brain runs whatever tooling Bravo runs; what crosses back is a signed
`Result`: findings document as a hash-addressed attachment, `afp:producedBy`, the
evidence digests. The *shape* needed nothing new — P1's obligations (signing,
hash-addressing, visibility, reconciliation) were designed at one operator to be
boundary-ready, and this beat collects on that design. But shape is not safety, and the
first draft of this scenario conflated them. 04 already imposes a duty written for
exactly this moment: a cross-operator `Result` ran attacker-controllable instructions in
*someone else's* environment, so the receiving port **sandboxes the result** — checksum
verification, content-type sniffing, size limits, isolated execution of anything fetched
— before anything trusts the attachment. And finding 19's ingestion duty applies with the
roles shifted: a subcontractor's findings prose is a stranger's text that Alpha's brains
will reason over, so it enters as hash-addressed evidence, summarized at the port, never
spliced into a downstream task's `content`. Both duties exist; neither names the
federated boundary as its site, and the seam between them is finding 30.

**6. The operator watches from a stock Mastodon account.** Alpha's partner follows the
engagement thread via dual-published shadow Notes; a reply of anything but the
authorized command grammar gets a polite read-only response (04). The client's auditor
gets an `afp:AuditGrant` scoped to the engagement thread and its artifacts — a read
window with an expiry, not a seat.

**7. The boundary closes mid-flight.** A second delegated task (a re-test after fixes)
is still open when the agreement expires. Ruling, mirrored from P5's hub-death gate —
*the boundary's death stalls new work, never in-flight work*: activities on an
already-accepted `correlationId` remain deliverable until that correlation reaches its
terminal outcome; new Offers are rejected from the expiry instant. The re-test Result
lands, is settled, and nothing further crosses. An expiry that killed in-flight work
would turn every agreement's last week into a dead zone; one that admitted new work
would make expiry meaningless. The record shows both halves: the late Result accepted,
the post-expiry third Offer refused.

Two edges of this beat are noted and deliberately not exercised. *Whose clock evaluates
the expiry instant*: each operator's gate runs on its own clock, and a delivery near the
boundary could be pre-expiry on Bravo's clock and post-expiry on Alpha's — at P4 the
recipient's gate decides, skew is accepted, and cross-operator clock discipline is
revisited when P5 gives the record shared state to disagree about. And *whether Bravo may
correct its findings after expiry* — a post-expiry supersession (ADR-0007) of pre-expiry
work is neither plainly new work nor plainly in-flight; ADR-0007's own revisit trigger
names federation-era supersession, and it stays deferred to it rather than half-answered
here.

**8. The subcontract settles, roles reversed.** Alpha delivered actuals to scenario
05's practice as a *requester*; here it receives them as one. The assessment's estimate
(Bravo's quoted effort and window) meets what the engagement actually took, Alpha reports
the actuals onto the thread, and an `afp:Settlement` lands — ADR-0004's machinery with
the boundary in the middle. This is what the closing paragraph's "standing subcontracting
relationship where settlements accumulate into standing" *means* mechanically: without
this beat the sentence is decoration, and the first draft had exactly that decoration.
One engagement settles once; the reputation it seeds only matters if there is ever a
second.

**9. The client replays two exports.** Alpha exports its record; Bravo exports its
engagement thread (scoped by the agreement — Bravo's other clients are not Alpha's
business). The auditor replays **both together**, and the verifier meets a situation
campaigns 1–4 never posed: every completeness rule so far assumes one operator's total
record — "every rostered agent has an outbox." Here, Alpha's export *cannot* contain
Bravo's chains; it holds signed activities *received from* Bravo, whose `prevActivity`
chains resolve only in Bravo's export. Completeness is suddenly **per trust domain**:
each export complete for its own actors, cross-references resolving across the pair or
failing honestly, and a hole in Bravo's chain being Bravo's failure, not Alpha's. The
single-bundle verifier has no vocabulary for any of that.

## Acceptance criteria → mechanisms

| Criterion | Mechanism | Status |
|---|---|---|
| Recognition is explicit, scoped, and expires | `afp:FederationAgreement`, co-signed, in both outboxes | Yes (01) — **scope grammar strained, finding 25** |
| A validly-signed stranger is refused | Two-tier gate: agreement before signature | Yes (01/04) — **silent refusal strained, finding 26** |
| Non-parties cannot confirm a record exists | `parties` visibility → 404, not 403 | Yes (07) |
| The hop is authenticated; payloads stay portably signed | HTTP Signatures on delivery + `eddsa-jcs-2022` object proofs | **Roadmap wording drift, finding 27** |
| Cross-boundary identity rests on published documents | Authorized fetch of actor documents; `afp:operatedBy` binding (ADR-0005) | Yes, once fetch is enforced |
| A counterparty's Result is sandboxed and summarized before anything trusts it | 04's untrusted-result duty + finding 19's ingestion duty, at the boundary | **Sited nowhere — finding 30** |
| The subcontract settles on the receiving operator's actuals | `afp:Settlement`, roles reversed (ADR-0004) | Yes — exercised in beat 8 |
| Expiry stalls new work, never in-flight work | Terminal-outcome rule per accepted `correlationId` | **Previously unstated — finding 28** |
| The operator can watch without joining | Shadow Notes + command grammar + `afp:AuditGrant` | Yes (04/07) |
| A third party can replay the whole engagement | Two exports, verified together | **Single-domain verifier — finding 29a** |
| A scoped export is distinguishable from a tampered one | Nothing — redaction and deletion currently share a signature | **finding 29b** |

## Spec verdict

**Held where it matters most.** The deepest result is beat 5: direct cross-operator
delegation required *no new object and no new field* — the P1 flow crossed the boundary
intact, because signing, hash-addressing and visibility were made mandatory at two
agents precisely so this day would be an addition, not a migration. (This verdict's
first draft claimed *no new duty* either; review caught that as false — see finding 30 —
and the correction is worth keeping visible: "boundary-ready" and "boundary-safe" are
different claims.) The hardening paid out too: roles, weights, actuation, settlement and
supersession all arrive at P4 as settled semantics rather than open questions, and beat
8 runs ADR-0004's settlement loop across the boundary unchanged.

**Strained — seven findings, opening campaign 5** (as sharpened by this scenario's own
review — the raw walkthrough surfaced five, and the review split one and added one):

25. **The agreement's scope grammar is hub-shaped.** 01's gate wording assumes every
    agreement names a hub; the narrowest real federation — direct delegation on named
    capabilities, no hub — cannot state its own scope. Candidate: scope as a set of
    grants (hubs *and/or* capabilities-for-direct-delegation), with the gate checking
    the activity against the grant that admits it.
26. **Boundary rejection leaves no trace.** A hard-rejected stranger's Offer vanishes;
    "we refused Mallory" and "Mallory never called" are the same record. The honest
    scope must be stated up front: unlike ADR-0003 D6, where the announce's pinned
    estimator list gives rejection an external commitment point, a stranger appears in
    no roster and no agreement — **verifiable rejection is impossible in the negative**,
    and no export can prove the absence of unlogged probes. So the duty is local but
    stronger than a log: a hash-chained, instance-signed rejection record, tamper-evident
    and exportable as an assertion — with the prober's own outbox as corroboration if it
    ever surfaces.
27. **The "LD-Signatures" wording is pre-ADR-0001 drift — narrower than first thought.**
    04's security section already fuses the terms ("Linked Data Signatures / Object
    Integrity Proofs on the object itself; the HTTP-layer signature only authenticates
    the relaying hop"), which *is* the two-layer model this scenario runs on. What
    remains is wording cleanup — the roadmap's P4 row and 01's tooling-reuse list both
    still say "LD-Signatures" bare — plus ADR-0008 confirming explicitly that
    `eddsa-jcs-2022` satisfies 04's relay obligation. No interop pressure forces RDF
    canonicalization: Mastodon ignores object proofs it does not understand, and AFP's
    only Mastodon touchpoint is directly-delivered Notes.
28. **Agreement death vs in-flight work was unstated.** Ruled here, mirroring the hub
    availability gate: expiry and `afp:Defederate` stall *new* work at the boundary;
    activities on an already-accepted `correlationId` flow until terminal outcome. Replay
    checks compare three timestamps the record already carries: no cross-boundary Offer
    `published` after the admitting agreement's expiry, and a late Result admissible only
    against an Accept published in time. Collusive backdating buys nothing a colluding
    pair could not get by co-signing a longer agreement — but the check deserves a
    backstop that pays everywhere: **`published` non-decreasing along each actor's
    `prevActivity` chain**, so chain position brackets any backdated timestamp. That
    check is absent from the verifier today and benefits every timestamp-dependent rule,
    not just this one.
29a. **Completeness is single-domain; federation makes it per-trust-domain.** The
    verifier's completeness, chain and thread checks all assume one operator's total
    record. A federated replay needs: per-domain completeness (each export answers for
    its own actors), cross-export resolution (an activity Alpha holds as received must
    match, byte for byte, the same activity in Bravo's export), holes attributed to the
    domain that owns them — and one security rule the review surfaced as the crux:
    **authority partitioned by `afp:operatedBy`**. Keys for a Bravo-operated actor are
    believed only from Bravo's export, or one bundle can smuggle forged counterparty
    actor documents and re-sign "received" activities. The co-signed agreement appears
    in both exports and must be digest-equal. The largest verifier change since P1 —
    and the reason to build the two-export replay *before* P5 multiplies the traffic.
29b. **A scoped export and a tampered one currently share a signature.** Bravo's export
    is engagement-scoped by right — its other clients are nobody's business — but
    `afp:prevActivity` chains are contiguous by construction, so a lawfully-withheld
    activity leaves the same hole a deleted one does: a chain starting mid-stream or
    gapped, both of which the chain check calls tampering. Deliberate redaction needs a
    record-level mechanism — candidate: **redaction stubs**, digest-only placeholders
    that keep the chain linkable while withholding content — and the design must face
    what a stub still reveals (that something existed) and still hides (everything
    else). Split from 29a because it is a spec decision about the record, not a
    verifier architecture question, and merging them would bury it.

30. **Neither ingestion duty names the boundary as its site.** 04's
    sandbox-untrusted-results duty (checksums, sniffing, size limits, isolated
    execution) and finding 19's port-ingestion duty (evidence in, port's own summary
    out) are both written — and beat 5 shows both applying to a subcontractor's Result,
    with neither saying so. One paragraph siting them at the federated boundary, before
    an implementer reads "boundary-ready" as "trust the attachment."


**Deferred on purpose, and said so:** whether `Accept{Follow}` seat evidence is subsumed
by the FederationAgreement (ADR-0005's trigger) stays untriggered — nothing enrolled
anywhere in this scenario, which is precisely its discipline; it fires in P5's scenario,
where a shared hub exists to have seats. Likewise cross-operator clock discipline and
post-expiry supersession of pre-expiry work (both noted at beat 7): the first is
accepted skew until P5 gives the record shared state to disagree about, the second is
ADR-0007's own named trigger and belongs to it.

**Where AFP is the wrong tool here, stated plainly.** A subcontract between two firms
that already trust each other's invoices needs email and a PDF. The machinery earns its
cost when the *record* is the deliverable: when the client will ask exactly what the
subcontractor did, when neither firm may see inside the other, and when the answer must
survive both firms' incentives to embellish. One task with one counterparty rarely
clears that bar; an engagement whose findings feed a compliance case, or a standing
subcontracting relationship where settlements accumulate into standing (ADR-0004),
does. The agreement's expiry date is the tell: if nobody would notice it lapsing, the
boundary did not need a protocol.
