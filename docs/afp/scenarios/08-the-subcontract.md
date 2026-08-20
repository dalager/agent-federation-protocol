# Scenario 08 — The subcontract: two operators, one boundary, no shared hub

> Spec-test scenario, the P4 shakedown: the **federation handshake and nothing else**.
> Exercises: `afp:FederationAgreement` as a hub-less contract shadow, the two-tier gate
> proven against an uninvited third operator, direct cross-boundary delegation on the P1
> flow, authorized fetch in both directions, the operator's Mastodon window, agreement
> expiry against in-flight work — and the first **two-export replay**, where completeness
> stops being a single-operator concept. Deliberately refuses to open a shared hub:
> cross-operator hubs, enrollment seats and CRDT sync are P5's scenario, not this one.
> Verdict at the end.

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

**5. The work happens behind Bravo's port, as it always did.** `b-assessor`'s brain runs
whatever tooling Bravo runs; what crosses back is a signed `Result`: findings document as
a hash-addressed attachment, `afp:producedBy`, the evidence digests. Nothing in this
beat is new — which is the beat's finding-shaped non-finding: P1's obligations (signing,
hash-addressing, visibility, reconciliation) were designed at one operator to be
boundary-ready, and this is the scenario that collects on that design.

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

**8. The client replays two exports.** Alpha exports its record; Bravo exports its
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
| Expiry stalls new work, never in-flight work | Terminal-outcome rule per accepted `correlationId` | **Previously unstated — finding 28** |
| The operator can watch without joining | Shadow Notes + command grammar + `afp:AuditGrant` | Yes (04/07) |
| A third party can replay the whole engagement | Two exports, verified together | **Single-domain verifier — finding 29** |

## Spec verdict

**Held where it matters most.** The deepest result is beat 5: direct cross-operator
delegation required *no new object, no new field, no new duty* — the P1 flow crossed the
boundary intact, because signing, hash-addressing and visibility were made mandatory at
two agents precisely so this day would be an addition, not a migration. The hardening
paid out too: roles, weights, actuation and supersession all arrive at P4 as settled
semantics rather than open questions.

**Strained — five findings, opening campaign 5:**

25. **The agreement's scope grammar is hub-shaped.** 01's gate wording assumes every
    agreement names a hub; the narrowest real federation — direct delegation on named
    capabilities, no hub — cannot state its own scope. Candidate: scope as a set of
    grants (hubs *and/or* capabilities-for-direct-delegation), with the gate checking
    the activity against the grant that admits it.
26. **Boundary rejection leaves no trace.** A hard-rejected stranger's Offer vanishes;
    "we refused Mallory" and "Mallory never called" are the same record. The
    audit-log-at-admission discipline (ADR-0003 D6, ADR-0006) wants a boundary
    equivalent — local, not federated: the refusing instance logs what it refused and
    why, so its own audit can answer "were we probed."
27. **The roadmap's "LD-Signatures" row is pre-ADR-0001 drift.** Object payloads are
    already portably signed (`eddsa-jcs-2022`); the boundary needs transport
    authentication of the hop, not a second signature suite with RDF canonicalization.
    ADR-0008 should restate the P4 obligation as HTTP Signatures for delivery plus the
    existing object proofs — or argue concretely for more.
28. **Agreement death vs in-flight work was unstated.** Ruled here, mirroring the hub
    availability gate: expiry and `afp:Defederate` stall *new* work at the boundary;
    activities on an already-accepted `correlationId` flow until terminal outcome. Needs
    spec text, and a gate mutation (a post-expiry Offer accepted = failure).
29. **Completeness is single-domain; federation makes it per-trust-domain.** The
    verifier's completeness, chain and thread checks all assume one operator's total
    record. A federated replay needs: per-domain completeness (each export answers for
    its own actors), cross-export reference resolution, and honest attribution of holes
    to the domain that owns them. The largest verifier change since P1 — and the reason
    to build the two-export replay *before* P5 multiplies what crosses the boundary.

**Deferred on purpose:** whether `Accept{Follow}` seat evidence is subsumed by the
FederationAgreement (ADR-0005's trigger) stays untriggered — nothing enrolled anywhere
in this scenario, which is precisely its discipline. It fires in P5's scenario, where a
shared hub exists to have seats.

**Where AFP is the wrong tool here, stated plainly.** A subcontract between two firms
that already trust each other's invoices needs email and a PDF. The machinery earns its
cost when the *record* is the deliverable: when the client will ask exactly what the
subcontractor did, when neither firm may see inside the other, and when the answer must
survive both firms' incentives to embellish. One task with one counterparty rarely
clears that bar; an engagement whose findings feed a compliance case, or a standing
subcontracting relationship where settlements accumulate into standing (ADR-0004),
does. The agreement's expiry date is the tell: if nobody would notice it lapsing, the
boundary did not need a protocol.
