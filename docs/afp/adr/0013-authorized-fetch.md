# ADR-0013 — Authorized fetch: the read side of the two-tier gate

- **Status:** Accepted, and **built** for the P4 shape — gated by admission-by-class at
  the gate itself, and by the covered-header discipline that makes a body-less signature
  safe. Remote-hub enrollment stays P5's problem (Decision 3)
- **Date:** 2026-08-21
- **Applies to:** every deployment that serves anything over HTTP — acute from P4, where
  a second operator exists to be entitled to something, and unavoidable at P5, where a
  shared hub's members read each other's activities as a matter of course
- **Builds on:** [ADR-0008](0008-p4-federation-stack.md) (the two-tier gate this
  generalizes to reads, and the hop signatures it already verifies),
  [ADR-0005](0005-operators-are-equal.md) (`afp:operatedBy`, which makes a requesting
  agent's operator resolvable), [ADR-0009](0009-federated-replay.md) (the export, which
  is why nothing has needed this yet)
- **Driven by:** the v3.20 sync audit — not a scenario. 07 described a mechanism, 05
  listed it among P4's built items, and no code performed it.

## Context

07 § Authorized fetch has said since v3.4 that reads are authenticated the way writes
are: a `GET` on a non-`public` resource carries an HTTP Signature, the server runs the
same two-tier gate as an inbox `POST`, and then serves or returns `404`. The audit that
closed campaign 6 found that only the second half exists. `ap/server.ts` reads no
signature on any route; it serves `public` and returns `404` to everyone else, and
`grantAdmits` — the admission logic that would decide these cases — is reached only by
the audit-grant flow.

So the rule is enforced in the direction that refuses and absent in the direction that
admits. A federated peer that *is* named in a `parties` activity is turned away exactly
as a stranger is. That passes P4's gate check, which asks only that a non-named peer get
`404` rather than `403` — the check was never wrong, the mechanism description was.

**Why it went unnoticed, and why that stops being true.** Every built phase moves the
record by *export*: a bundle, under the operator's control, handed over deliberately.
Nothing in P1–P4 needs a peer to fetch an activity it is entitled to, so the missing half
cost nothing and showed nowhere. Two things end that. P5 puts several operators on a
shared hub, where reading each other's hub-class activities is the normal case rather
than an audit event. And the auditor role — a grant that "unlocks classes" — is
unimplementable while nothing above `public` is ever served: the grant can be issued,
recorded and expired, and it opens nothing.

One inherited constraint bounds every decision below. ADR-0009 refused to fork the
verifier so that "verified" could not mean two things; the same argument applies here
with more force, because this is admission control rather than a report: **if reads
admitted on different facts than writes, "admitted" would mean two different words in one
system, and the narrower one would be a guess about which.**

## Decisions

### 1. One gate, two doors — the read path runs the inbox's gate, in its order

A `GET` for a non-`public` resource runs the same ordered stages ADR-0008 built for the
inbox, against the same state: **agreement → deny-list → roster / membership → class**.
Not a parallel implementation that resembles it; the same stages, so a peer that may send
you an activity about a thread and a peer that may read that thread are decided by one
body of rules.

The seam is already there, and is better placed than it looks from the outside. The gate
does not consume an activity: it reduces one to an **`ActivitySummary`** and decides on
that, and `admittingGrant(agreement, summary)` — the part that reads an agreement's
`afp:grants` — takes the summary alone. So the reusable body is *denylist → active
agreements → admitting grant*, verbatim, and what a read supplies is a summary of the
**resource** (its hub, its thread, its class) instead of a summary of an activity.

The stages that need a variant, and only these:

- **Summary construction.** `summarize()` reads an activity's shape; a read needs the
  equivalent for an outbox collection, a single activity, or an artifact. Same type, new
  constructor — not a new decision procedure.
- **The final stage.** The inbox asks "may this actor write here"; the read asks "may this
  actor see this class" (Decision 3). That stage is genuinely new, and it is the only
  genuinely new one.
- The inbox verifies a body digest. `signRequest` and `verifyRequest` both hardcode
  `(request-target) host date digest` and compare `digest` against the body
  unconditionally, so a `GET` — which has no body — needs the covered set to become
  `(request-target) host date`.

**And that variant carries the one genuinely dangerous detail in this ADR.** The covered
header set MUST be derived from the **request method**, never from the `headers=` list the
incoming `Signature` header declares about itself. `GET` ⇒ `(request-target) host date`;
`POST` ⇒ the same plus `digest`. If the verifier instead honours whatever the signature
says it covered, an attacker downgrades a `POST` by simply declaring it covered no
`digest`, and the body becomes unauthenticated while the signature still verifies. That is
a signature-stripping attack against the *write* path introduced by a change to the read
path, which is the kind of thing that gets found later and named after someone.

For the same reason this is a **parameterization of one signing-string builder, not a
second one**: ADR-0008 refused a second signature suite so that one string shape keeps one
meaning, and two hand-maintained builders drift in exactly the way that produces the bug
above. One builder, one caller-independent rule for which headers a method covers.

### 2. The reader is whoever signed, and identity is two-tier

The HTTP Signature's `keyId` resolves to an actor document, which yields the requesting
**agent** and — via `afp:operatedBy` — its **instance**. Both matter, because the gate is
two-tier: the agreement and deny-list stages judge the instance; roster, enrollment and
addressing judge the agent.

An unsigned request is not an error. It is **anonymous**, and anonymous is a legitimate
identity with exactly one entitlement: the `public` class. This keeps the common case
(fetching an actor document to verify somebody's signature) free of ceremony.

**The bootstrap invariant, stated so it cannot be broken later.** Verifying a signature
requires fetching the signer's key, which means the routes that serve keys can never
themselves require a verified signature: **actor documents and the roster are `public` by
necessity, not by choice.** 07 already says this; it becomes load-bearing here, because
the day someone "hardens" the actor route is the day every signature in the federation
becomes unverifiable in one move.

### 3. Admission by class, stated as predicates

| Class | Admitted when |
|---|---|
| `public` | Always. No signature required, none consulted. |
| `hub` | The requesting instance holds an **active agreement whose grants admit that hub**, and the requesting agent is **enrolled in that hub** — any role, including `observer`; reading is what an observer is for. |
| `parties` | The requesting agent is **named in the activity's `to`/`cc`**, or is the **operating instance of a named actor** (ADR-0005: an instance may read what its own agent was sent). |
| `internal` | **Never.** Not to a peer, not to an agreement holder, not under a grant. |

Two precisions the code forces, and they are the difference between a predicate and a
wish:

- **An agreement is not hub-scoped; its grants are.** `activeAgreementsWith` keys on the
  counterparty alone, and the hub lives inside a `"hub"`-type grant within the agreement.
  So the `hub` predicate reuses `admittingGrant` with a summary carrying the resource's
  hub — the existing machinery, asked a read-shaped question. The `parties` predicate
  needs no grant at all: **the addressing is the entitlement.** An active agreement
  establishes that we speak; being named in `to`/`cc` establishes that this was sent to
  you. Inventing a `"read"` grant type to express that would add a thing to configure that
  the activity already says.
- **Enrollment is answerable here only for hubs this instance hosts.** `Hub.roleOf` reads
  local hub state, and it answers correctly for *foreign* agents too, because enrolling a
  foreign agent is already a recorded act gated by `afp:operatedBy` (ADR-0005). What it
  cannot answer is enrollment in a hub somebody else hosts — there is no
  `afp:MembershipProof` in the codebase; it exists only in prose. So this ADR's `hub`
  predicate is **scoped to locally-hosted hubs**, which is exactly the whole of P4, and
  the remote case is named as P5's problem rather than half-built here.

`internal` is absolute deliberately. 07 already says a grant never unlocks it, and this
ADR declines to add the one exception that would eventually be asked for: a class whose
meaning is "this instance's own business" stops meaning anything the first time it is
served to somebody else, and the honest alternative for a deployment that wants an
auditor to see something is to publish it at a class the auditor can hold.

**Grants are a fourth door, not a fifth class.** An `afp:AuditGrant` widens which classes
a named auditor may read, within a scope and period. A grant is a widening of entitlement,
never a bypass of the gate — but the two gate stages it meets are not alike, and an
earlier draft of this decision lost that distinction by naming them in one breath:

- **The deny-list still refuses, and a grant cannot lift it.** Deny-listing an operator is
  the strongest refusal this protocol has; a mechanism that could widen past it would make
  it advisory. Checked *inside* the grant path, not merely before it — the ordinary
  predicate fails a deny-listed requester and then the grant branch runs, so a check
  placed only in the predicate is a check the grant path never performs.
- **An active agreement is NOT required.** The grant *is* the relationship. Requiring an
  agreement as well would make grants useless for the case they exist for — an external
  compliance auditor, who has no federation with the operator and never will — and 07 is
  explicit that a grant is issued *to an auditor actor*, not to a peer. What the auditor
  cannot be is deny-listed.

The asymmetry is the point: a grant answers "we chose to let this party read", and a
deny-list answers "we refuse this party entirely". Only one of those is a statement the
other may override.

### 4. `404` is the only refusal, and it must be indistinguishable

Absent, unauthorized, and `internal` return the same status, the same body, and no
distinguishing header. This is already 07's rule; what this ADR adds is the part that
makes it true rather than intended:

- **The refusal must not be distinguishable by shape.** One `notFound()` helper, one
  body, for every refusal reason. No "not found" versus "forbidden" in a JSON `error`
  field that a prober can read.
- **Nor by order.** If existence is checked before entitlement, a missing resource
  refuses immediately and an unauthorized one refuses after a key fetch — and the timing
  difference is the oracle the `404` was chosen to deny. The resource is resolved and the
  requester is judged before anything is returned, and the two are combined into one
  answer at the end.
- Timing cannot be made identical by construction, and this ADR does not pretend to
  constant-time HTTP. What it requires is that no *structural* difference remain: no
  extra round trip, no different code path length, on the refusal branch.

**Reads refuse with `404` while writes refuse with `403`, and that asymmetry is
deliberate.** The inbox answers a refused sender `403 refused`, which is right: a peer
that tried to deliver something needs to learn that it was turned away, and it already
knows the activity exists because it wrote it. A reader learns nothing it is entitled to
by being told a resource exists but is closed — that sentence *is* the disclosure for a
thread id, a hub name, or an agent's caseload. An implementer unifying the two status
codes for tidiness would be trading a real property for a symmetry.

### 5. Authorized fetch is access control, not audit — the record proves publication, never readership

This is the decision that keeps the system honest about itself.

Everything else in AFP is checkable after the fact: a stranger with the bundle recomputes
what was claimed and by whom. **Reads are not like that.** A read leaves no trace in the
record; an operator that serves a `parties` activity to somebody who should not have it
produces exactly the same bundle as one that refuses. Replay cannot see it, the peer
cannot prove it, and the auditor cannot either.

So the ADR states the boundary rather than letting the symmetry in 07's phrasing —
"reads are authenticated the same way writes are" — imply a checkability it does not
carry. **Authentication is symmetric; accountability is not.** What the record proves is
what was published and who signed it. Who read it is a property of a server's behaviour
at a moment, and the only mechanisms that would make it checkable are ones this ADR
rejects (Options considered): a logged read is a record of who-read-what, which is
itself sensitive, unbounded, and still cannot stop the reader copying what it read.

**And read refusals are not logged — which is where an implementer will most reasonably
go wrong.** The inbox hash-chains every refusal into the record (`logRejection`), so
mirroring it on the read path looks like consistency. It is not. An inbox refusal is
bounded by peers who hold an agreement and costs the sender a signed activity; a read
refusal is free, anonymous and unbounded, so logging it hands any stranger a pen that
writes into your record — a denial of service against your own log, and a permanent
transcript of what strangers guessed. Nothing of evidentiary value is lost: a refusal
proves only that somebody asked, which is the one fact nobody needs.

**The one exception is the grant, and it is exceptional for a reason.** Fetches under an
`afp:AuditGrant` ARE recorded, because the grant is a recorded, expiring credential
issued for exactly this: an audit whose own reach must be auditable. The cost is bounded
by the grant's scope and period, and the sensitivity is the point rather than a leak —
"the audit itself is auditable" is a promise 07 already makes, and this is where it is
kept.

### 6. Non-public responses are not cacheable by anything shared

07 permits fronting artifact endpoints with object storage or a CDN "provided the gate
and digest rules are preserved". Authorized fetch makes that proviso sharp: a response
that depended on *who asked* MUST NOT be stored by a cache that will serve it to somebody
who did not ask.

Every non-`public` response carries `Cache-Control: private, no-store` and `Vary:
Signature`. The `Vary` is belt to the `no-store` braces — a shared cache that honours
neither is a data leak wearing a performance improvement's clothing, and this is stated
in the ADR rather than left to an operator's CDN configuration, because it is the kind of
mistake that is invisible until it is a disclosure.

### 7. The solo profile is degenerate, never a fork

ADR-0010 learned this the hard way: a mechanism that only works when federation exists
has forked the profiles without saying so. With one operator there are no agreements and
no foreign agents, and the same code path runs with an empty agreement set: `hub` admits
locally enrolled agents, `parties` admits named local actors, `internal` admits nobody,
and anonymous still gets `public`. Nothing branches on "am I federated".

**Artifacts keep their present rule**: an artifact is served at the *narrowest* class
among the activities referencing it. An artifact reachable from a `public` activity is
already disclosed by that activity, so the broader reading would also be defensible — but
"closed by default" is the house rule, the conservative reading can only ever refuse
somebody who has another way to ask, and the permissive one can only ever over-disclose.

## Options considered

| Option | Rejected because |
|---|---|
| A separate authenticated read API beside the public one | Two doors admitting on different rules is exactly the fork ADR-0009 refused for the verifier; "admitted" would mean two things and the narrower would be a guess |
| Bearer tokens or capability URLs instead of HTTP Signatures | A second credential type to issue, carry, expire and revoke — and ADR-0008 already refused a second signature suite for the same reason. The signature is already at the door |
| `403` for unauthorized, `404` for absent | Hands a prober an existence oracle for every thread id it can guess; the class of the resource leaks even when the content does not |
| Log every non-`public` read | Creates a who-read-what record that is itself sensitive and grows without bound, and buys no real accountability — the reader can copy what it read, so the log constrains nobody while implying it does |
| Infer entitlement from addressing alone, unsigned | `to`/`cc` names an actor; anyone can claim to be it. Unsigned entitlement is not entitlement |
| Let a CDN cache non-public responses on `Vary: Signature` | Betting PII on every intermediary's `Vary` correctness. `no-store` is the only instruction that fails safe |
| Serve `internal` to a sufficiently privileged grant | A class meaning "this instance's own business" stops meaning anything the first time it is served to somebody else; publish at a class the auditor can hold instead |
| Defer until P5, when shared hubs need it | The auditor role is *already* specified and already unimplementable, and 07 has told implementers this works since v3.4 |

## Compatibility and migration

- **`public` behaviour is bit-for-bit unchanged**, signed or unsigned. Every existing
  fetch path keeps working, which is most of them: actor documents, the roster, shadow
  Notes.
- **Nothing that 404s today starts being served without a signature.** The change is
  strictly additive at the admitting end; no resource becomes *more* reachable to an
  anonymous caller.
- **The verifier is untouched.** Reads leave no record (Decision 5), so replay has
  nothing new to check and no existing export re-reads differently. This ADR is the first
  in the campaign with no verifier surface at all — which is itself the evidence for
  Decision 5's honesty rather than an oversight.
- **05's P4 row and 07's "specified, not yet built" note** come out when this lands. Both
  were written by the sync audit that motivated this ADR; leaving them standing after the
  build would be the same drift in the other direction.

## Consequences

**Positive**

- The promise 07 has made since v3.4 becomes true, and the auditor role becomes
  implementable end to end rather than a credential that opens nothing.
- P5's shared hubs get their read path from the gate that already exists, rather than
  from a new mechanism designed under deadline when the first three-operator hub needs it.
- The system gains an explicit, written boundary on what its record does *not* prove —
  which is worth more than the feature, because a reader who believes reads are auditable
  will design something on that belief.

**Negative / accepted risks**

- **Readership stays unprovable.** Accepted and stated (Decision 5). A deployment whose
  threat model includes its own operator leaking data by reading it needs controls this
  protocol does not offer.
- **Every non-public `GET` now costs a signature verification and possibly a key fetch.**
  Key caching is an implementation matter, but the amplification is real: a cold peer's
  first read may fetch an actor document first.
- **The gate runs on a hotter path than the inbox.** Reads are more frequent than writes
  by nature, and a gate stage that was cheap per-activity may not be cheap per-request.
- **`Vary: Signature` is unusual enough that intermediaries mishandle it.** Mitigated by
  `no-store` being the load-bearing half.

**Revisit triggers**

| Trigger | Reconsider |
|---|---|
| P5 shared hubs where the hub relays reads on members' behalf | Whether the hub can admit on a member's behalf, and what that does to the two-tier identity |
| Probing at scale (an adversary enumerating thread ids) | Whether rate limiting and `404` discipline need to be specified rather than left to deployment |
| A one-off share with a party outside any agreement | Whether capability URLs earn their keep for a bounded case, having been rejected as a general mechanism |
| P5 hubs hosted by another operator | `afp:MembershipProof` — the mechanism that would let this instance verify enrollment in a hub it does not host. It exists in prose only, and A3's `hub` predicate is scoped to locally-hosted hubs until it exists |
| Read volume making per-request gating the bottleneck | Whether an admission decision may be cached per (requester, class, scope), and for how long |

## Build status

Built. The staging was forced by the signature: nothing could be admitted until a `GET`
could be authenticated at all.

| ID | Task | Where | Stage |
|---|---|---|---|
| **A1** ✅ | The method-derived covered-header set. `signRequest`/`verifyRequest` hardcode `(request-target) host date digest` and compare `digest` to the body unconditionally; both learn the set from the **method**, never from the incoming `headers=` list. One builder, parameterized — not a second pair. Includes the negative test that a `POST` declaring it covers no `digest` is refused | `federation/httpSig.ts` | 1 |
| **A2** ✅ | `resolveRequester(headers) → { agent, operatedBy } \| null`: keyId → actor document (unauthenticated fetch, per the bootstrap invariant) → `afp:operatedBy`, or self when the actor is an instance actor. Lifted from the inline block in `handleInboxPost` and shared with it, so one rule answers "who is asking" on both paths | `federation/inbox.ts`, new shared helper | 1 |
| **A3** ✅ | The read summary and the class stage: an `ActivitySummary`-shaped value for a resource (its hub, thread, class) so `admittingGrant` decides the `hub` case unchanged; the `parties` predicate over `to`/`cc` plus `afp:operatedBy`; `internal` refused unconditionally; `Hub.roleOf` for enrollment, scoped to locally-hosted hubs | `federation/grants.ts`, new read-gate module | 2 |
| **A4** ✅ | `handleAuthorizedFetch` — mirrors `handleInboxPost`'s stage *order* without calling it (that function is body-coupled throughout): authenticate → resolve requester → denylist → active agreement → class. Wired into `ap/server.ts` ahead of the outbox and artifact handlers, falling through to today's public-only behaviour when unsigned | `ap/server.ts`, new module | 2 |
| **A5** ✅ | Wire `grantAdmits` — designed for this and currently called by nothing — as the class-stage widening for `afp:AuditGrant`, and **record the admitted fetch**, which is the one read this ADR does log (Decision 5). Refusals stay unlogged, deliberately | `federation/visibility.ts`, read-gate module | 2 |
| **A6** ✅ | Response discipline: one `notFound()` body for every refusal reason; resolve-then-judge so refusal order leaks nothing; `Cache-Control: private, no-store` and `Vary: Signature` on every non-`public` response; artifacts keep the all-referencing-activities-are-public rule for the anonymous path | `ap/server.ts` | 3 |
| **A7** ✅ | Gate `test/adr0013.test.ts` on the real-HTTP scaffold from `adr0008.test.ts` (`freePort()`, `operator()`): a signed `GET` from an agreed, enrolled peer fetches a `hub` activity; the same peer is refused a `parties` activity it is not named in; a named peer fetches it; an unsigned `GET` gets `public` only; a deny-listed instance is refused; `internal` is refused to everyone including a grant holder; an expired agreement is refused; a grant-admitted fetch appears in the record while a refusal does not; and every refusal is byte-identical | `test/adr0013.test.ts` | 3 |

A verifier task is conspicuously absent, and that absence is Decision 5 in executable
form: reads leave no record, so there is nothing for replay to check. The single exception
— the grant-admitted fetch of A5 — becomes an ordinary recorded activity and replays like
any other, needing no new check of its own.

## References

- [07 — Authorized fetch](../07-visibility-and-artifacts.md#authorized-fetch), the
  section this ADR makes true, and its "specified, not yet built" note
- [ADR-0008](0008-p4-federation-stack.md) — the two-tier gate and the hop signatures
- [ADR-0009](0009-federated-replay.md) — the refusal to fork a mechanism so that one word
  keeps one meaning
