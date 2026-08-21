# 07 — Visibility, artifacts, lifecycle

Added in v3.4, driven by [scenario testing](scenarios/): the spec was strong on integrity
and authenticity and silent on the **read side** — who may fetch what — on where
attachment bytes actually live across operators, and on how a hub ends.

## Audience & visibility

AFP's prior text described outboxes as "independently auditable by anyone who can fetch
it." That is the correct *default* for a public Fediverse actor and the wrong default for
an agent handling client PII, screening outcomes, or a competitor's estimates. Visibility
is now explicit.

### Four visibility classes

Declared per activity via `afp:visibility` — **required, not inferred**. An earlier
revision said an absent field was inferred from AS2 addressing (`to`/`cc`/`audience`);
that inference no longer exists anywhere. The P1 obligation makes the class a required
argument on every builder, so no code path can publish an activity without one, and
replay names a missing class as a failure rather than guessing at it: *the record does not
say who may read this* is a defect in the record, not a puzzle for the reader.

Addressing still tells you which class to **choose** — it just no longer stands in for
the declaration. Never assumed public.

| Class | Who may fetch | Typical use |
|---|---|---|
| `public` | Anyone, unauthenticated | Actor documents, capability advertisements, shadow Notes about non-sensitive events |
| `hub` | Instances holding an active FederationAgreement **whose grants admit that hub**, and their enrolled agents | Hub-scoped CRDT deltas, Announced Tasks, Bids, Votes, DecisionRecords |
| `parties` | Only actors named in `to`/`cc` — an instance actor qualifies when named itself | Direct `Offer{Task}` / `Result` between two agents — payload and attachments |
| `internal` | Only the originating instance | Records an instance keeps for its own audit but does not federate |

**Actor documents and roster entries are necessarily `public`** — signature verification
requires key fetch. Everything else defaults *closed*: the narrowest class that serves the
activity's addressing, and `internal` where nothing else fits. "Defaults closed" is a
rule for the publisher choosing a class, not a licence to omit one.

### Authorized fetch

Reads are authenticated the same way writes are. A `GET` on any non-`public` resource
carries an HTTP Signature; the server runs the same two-tier gate as an inbox POST
(agreement → deny-list → roster/MembershipProof → class check), then serves or returns
`404` (not `403` — non-existence and non-authorization are indistinguishable to a
stranger, so probing yields nothing).

This is the same mechanism Mastodon calls *authorized fetch*; AFP makes it mandatory for
every class above `public`.

> **Built for the P4 shape** ([ADR-0013](adr/0013-authorized-fetch.md)). A `GET` for a
> non-`public` resource now resolves the requester from its signature, runs the same
> deny-list and agreement stages the inbox runs, and decides by class: `public` to
> anyone including the unsigned; `hub` to an enrolled agent of an operator whose
> agreement grants that hub; `parties` to an agent the activity names; `internal` to
> nobody, ever, including a grant holder. An unsigned request is not an error — it is
> anonymous, and anonymous still sees exactly what it saw before, which is how a server
> with no gate configured stays byte-identical to the old one.
>
> Two limits worth knowing rather than discovering. Enrollment in a hub this instance
> does not host is answered by a **presented `afp:MembershipProof`** ([ADR-0014](adr/0014-p5-shared-hub-stack.md)
> Decision 1, built): a hub-signed, expiring statement in the requester's pocket, verified
> against the hub's published key — so the answer survives the hub's own partition, which
> is when it matters. Without one, the predicate still refuses, exactly as before. And
> `parties` admits the agent the addressing
> *names* — being the operator of a named agent is not admission, because at P4 that
> activity was already delivered to that operator anyway.

### The auditor role

Audit needs read access that is broad, time-bounded, and recorded. An instance MAY grant
`afp:AuditGrant` — a signed, expiring credential naming an auditor actor, a scope (hub,
thread, or period), and the classes it unlocks. Fetches under a grant are logged into the
granting instance's own record, so *the audit itself is auditable*. A grant never unlocks
`internal`, and it never crosses to another operator's data — each operator grants for
their own.

> **Wired, and bounded by what enables it** ([ADR-0013](adr/0013-authorized-fetch.md)
> A5). `grantAdmits` now has a caller: a live grant widens which classes its named
> auditor may read, after the deny-list and never past it, and never to `internal`. A
> served fetch admitted by a grant is reported to the host so it can be recorded — the
> only read this design logs, and the reason is in 04 § What the record does not answer.
> What a deployment must still do is *supply* the grants and record the callback: an
> instance that hands the gate an empty grant list has an auditor role that opens
> nothing, exactly as before.

> **Confidentiality is not secrecy from the operator.** Every class is readable by the
> instance hosting the actor. AFP protects data *between* operators and from the public;
> it offers no mechanism to hide an agent's activity from its own operator, by design.

## Artifacts & attachments

Spec examples previously attached `s3://` links, quietly assuming storage every party can
read. Across operators that assumption fails.

**Rule: each instance serves its own artifacts.** An attachment is a `Link` carrying:

```json
{
  "type": "Link",
  "href": "https://alpha.operator.example/artifacts/sha256-9c1f...",
  "mediaType": "application/pdf",
  "afp:digest": "sha256:9c1f...774e",
  "afp:size": 184320
}
```

- **Hash-addressed** — `afp:digest` is mandatory; a fetcher that gets bytes not matching
  the digest MUST discard them. This makes artifacts tamper-evident independent of
  transport and makes caching/relaying safe.
- **Authorized fetch** — artifact `GET`s run the same gate and inherit the visibility
  class of the activity that referenced them.
- **Retention** — the serving instance SHOULD keep artifacts at least as long as the
  activities referencing them are federated; on expiry, the digest still proves what was
  claimed even when bytes are gone. That is the **federation floor, not a retention
  policy** (ADR-0012): where a deployment declares an `afp:retentionDuty`, the *bytes* of
  every artifact referenced by a retained activity MUST be kept for the declared horizon.
  A digest proves what was claimed; it does not hand a data subject the document their
  application consisted of, and a statutory horizon is a claim about the bytes.
- **Externally-fetched evidence** — when an artifact is a copy of something obtained
  outside AFP (a fetched web page, a registry extract), the Link SHOULD additionally carry
  `afp:sourceUrl` and `afp:fetchedAt`, so evidence provenance doesn't stop at "the agent
  said so."

Large-blob transfer is out of scope: AFP addresses and authenticates artifacts, it does
not define a bulk transport. Instances MAY front artifact endpoints with ordinary
object storage or a CDN, provided the gate and digest rules are preserved.

### Assets: identity for reusable components

An artifact is bytes with a digest. A **reusable component** — built in one project,
hardened in another, offered for reuse in a third — is a third thing between agents and
artifacts: an **asset**, with identity, versions, and provenance across hubs (ADR-0004,
from scenario 05):

```json
{
  "id": "urn:afp:asset:mitid-broker-adapter",
  "type": "afp:Asset",
  "afp:version": "3.1",
  "afp:digest": "sha256:…",
  "afp:sourceUrl": "https://git.example/integrations/mitid-broker-adapter",
  "afp:originContext": "urn:afp:thread:proj-x-build",
  "attributedTo": "https://alpha.operator.example/agents/i-identity"
}
```

- **Registration is on the record**: a hub-scoped OR-Map `assetId → asset record`, fed by
  ordinary signed `Update{afp:Asset}` activities — never a side-channel catalogue. One
  (id, version) is immutable once registered; a new version is a new entry.
- **Referenceable from allocation** (03): a Bid MAY claim `afp:reuses` — "my cost is low
  *because* I start from this," under the sealed commitment — and the delivering Result
  MAY carry `afp:reused` with the adaptation's own digest, closing the loop. Reuse
  becomes a fact in the record rather than a slide.
- **Checkable at replay**: every asset reference must resolve to a registered
  `afp:Asset` **by (id, version)** — an unresolvable reuse claim is the asset-flavored
  *"counted vote you cannot produce."* The reference carries no copy of the asset's own
  digest to cross-check against: the Bid claims id and version, and the Result's digest is
  the adaptation's, which is a different artifact by design.

## Hub lifecycle

Hubs are cheap to create and, in case-per-hub patterns, numerous. A hub ends explicitly.

| Act | Meaning |
|---|---|
| Creation | Implicit: the hub actor exists and instances Follow it |
| `afp:Freeze` | Hub accepts no new Tasks/Bids/rounds; existing threads may still close. Reversible by governance |
| `afp:Archive` | Terminal. References the final state: CRDT snapshot hash, the closing `DecisionRecord`s, artifact manifest. Hub becomes read-only |

`afp:Archive` is a `GovernanceDecision` (member quorum,
[02](02-hubs-and-state.md#membership--dynamic-quorum)) in a federated hub, and a plain
instance-signed activity in the solo profile. Its payload is the **canonical case
file**: enough hashes for any member to verify their own retained replica is the complete,
unpruned record. Post-archive, member instances retain their replicas independently — the
hub host going away does not destroy the archive.

A FederationAgreement expiring does *not* archive a hub; it stops that instance's access.
Archival is a separate, deliberate act — usually taken before the agreement lapses.
