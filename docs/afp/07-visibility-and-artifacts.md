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

Declared per activity via `afp:visibility`; absent the field, the class is inferred from
AS2 addressing (`to`/`cc`/`audience`) — never assumed public.

| Class | Who may fetch | Typical use |
|---|---|---|
| `public` | Anyone, unauthenticated | Actor documents, capability advertisements, shadow Notes about non-sensitive events |
| `hub` | Instances holding an active FederationAgreement scoped to that hub, and their enrolled agents | Hub-scoped CRDT deltas, Announced Tasks, Bids, Votes, DecisionRecords |
| `parties` | Only actors named in `to`/`cc` (plus their operating instances) | Direct `Offer{Task}` / `Result` between two agents — payload and attachments |
| `internal` | Only the originating instance | Records an instance keeps for its own audit but does not federate |

**Actor documents and roster entries are necessarily `public`** — signature verification
requires key fetch. Everything else defaults *closed*: an activity with no explicit class
and no addressing is `internal`.

### Authorized fetch

Reads are authenticated the same way writes are. A `GET` on any non-`public` resource
carries an HTTP Signature; the server runs the same two-tier gate as an inbox POST
(agreement → deny-list → roster/MembershipProof → class check), then serves or returns
`404` (not `403` — non-existence and non-authorization are indistinguishable to a
stranger, so probing yields nothing).

This is the same mechanism Mastodon calls *authorized fetch*; AFP makes it mandatory for
every class above `public`.

### The auditor role

Audit needs read access that is broad, time-bounded, and recorded. An instance MAY grant
`afp:AuditGrant` — a signed, expiring credential naming an auditor actor, a scope (hub,
thread, or period), and the classes it unlocks. Fetches under a grant are logged into the
granting instance's own record, so *the audit itself is auditable*. A grant never unlocks
`internal`, and it never crosses to another operator's data — each operator grants for
their own.

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
  claimed even when bytes are gone.
- **Externally-fetched evidence** — when an artifact is a copy of something obtained
  outside AFP (a fetched web page, a registry extract), the Link SHOULD additionally carry
  `afp:sourceUrl` and `afp:fetchedAt`, so evidence provenance doesn't stop at "the agent
  said so."

Large-blob transfer is out of scope: AFP addresses and authenticates artifacts, it does
not define a bulk transport. Instances MAY front artifact endpoints with ordinary
object storage or a CDN, provided the gate and digest rules are preserved.

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
