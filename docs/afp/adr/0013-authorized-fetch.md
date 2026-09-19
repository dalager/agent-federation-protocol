# ADR-0013 — Authorized fetch: the read side of the two-tier gate

- **Status:** Accepted, and **built** for the P4 shape — gated by admission-by-class at
  the gate itself, and by the covered-header discipline that makes a body-less signature
  safe. Remote-hub enrollment, deferred here as P5's problem, is since answered by
  [ADR-0014](0014-p5-shared-hub-stack.md) Decision 1's presented proof
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
| `parties` | The requesting agent is **named in the activity's `to`/`cc`** — or is an **instance actor that is itself named** there. See the narrowing below: "the operating instance of a named agent" is deliberately *not* admitted. |
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
- **`parties` admits only what the addressing says outright.** An earlier draft of the
  row above read "or is the operating instance of a named actor", citing ADR-0005's
  principle that an instance may read what its own agent was sent. Implemented literally,
  that means resolving the operator of *every* addressee — a document fetch per `to`/`cc`
  entry, on every read, to answer a question the activity does not state. The narrowing is
  not just a concession to a synchronous predicate: at P4 an activity addressed to
  someone's agent was **already delivered to that operator**, so fetching it back is
  redundant, and the case that is not redundant — an instance actor addressed directly —
  is exactly the one the addressing already names. So the predicate reads what is written
  and refuses the rest, which is Decision 7's closed-by-default applied where it costs
  nothing. If a future flow genuinely needs the wider reading, it needs a way to answer
  "who operates this actor" without a fetch, and that is a dependency to add deliberately
  rather than a predicate to loosen.
- **Enrollment is answerable here only for hubs this instance hosts.** `Hub.roleOf` reads
  local hub state, and it answers correctly for *foreign* agents too, because enrolling a
  foreign agent is already a recorded act gated by `afp:operatedBy` (ADR-0005). What it
  cannot answer is enrollment in a hub somebody else hosts — at the time this was
  written there was no `afp:MembershipProof` in the codebase. So this ADR's `hub`
  predicate was **scoped to locally-hosted hubs**, the whole of P4, and the remote case
  named as P5's problem rather than half-built here. *(That problem is now solved where
  it was named: [ADR-0014](0014-p5-shared-hub-stack.md) Decision 1 widened the clause to
  roleOf-or-presented-proof, leaving every other stage of this gate untouched.)*

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

**Amended 2026-09-19 — the rule is about every refusal, not only reads**
([scenario 16](../scenarios/16-the-hostile-edge.md) findings 90 and 94). As written above,
the reasoning is scoped to the read gate and its confirmation-leakage risk. The *practice*
is already wider: an unsigned inbox delivery, a command from an actor no policy lists, a
`Follow` the hub declines, an `afp:Enroll` from an instance with no seat refused before
admission — none of these reaches `logRejection` either. The hostile-edge walk found the
gap between the two and was right to: a reader who takes the stated reasoning at face
value would conclude the silence elsewhere is an oversight, and "fix" it.

It is not an oversight, and the test that decides it is not "is this a read" but **what
did the refused party spend, and can the record name them.**

- **Logged.** A refusal of an activity that arrived *signed, under a live agreement or a
  live seat* — the sender spent a signed activity, the record can name them, and the
  volume is bounded by the set of peers who got that far. `logRejection` hash-chains
  these, and they are evidence: "your Enroll was refused, here is the reason" is a fact a
  counterparty may need at replay.
- **Not logged.** A refusal of anything unsigned, unagreed, unseated or anonymous — the
  stranger spent nothing, the record cannot name them, and the volume is bounded only by
  the attacker's patience. Logging these hands any stranger a pen that writes into your
  record: a denial of service against your own log, and a permanent transcript of what
  strangers guessed. The reasoning above generalises exactly, and this is the general
  statement of it.

**Where a refused stranger belongs is the operator's telemetry, not the record.** These
are two different artifacts with two different jobs, and the scenarios have been treating
them as one. The record is append-only evidence, bound into exports and replayed by
counterparties; telemetry is operational, rotated, never exported, and nobody's evidence.
A flood, a forged authority claim and a probe for a thread that does not exist all belong
in the second. Correlating them into a pattern is intrusion detection, which
[scenario 16](../scenarios/16-the-hostile-edge.md) finding 93 accepted as not the
protocol's to answer; this amendment only rules on which artifact the material lands in,
and why an implementer must not promote it to the first.

**What the build actually offers today, stated exactly, because "belongs in telemetry"
is not the same as "is in telemetry".** Refusals are *counted*, not described:
`afp_inbox_refusals_total{class}` and `afp_ratelimit_refusals_total{scope}`
(`runtime/metrics.ts`) move when a delivery is rejected or a bucket refuses. The
structured log stream ADR-0031 Decision 3 built (`runtime/log.ts`, JSON lines to stderr)
is the natural home for the *event* — which address, which claimed actor, which route —
and no refusal path calls it. So an operator can see that refusals are happening and how
fast, and cannot see what was refused. That is a real gap and it is an operational one,
not a protocol one: it is closed by calling the existing logger from the existing refusal
paths, needs no wire change, no ADR of its own, and no counterparty ever sees the
difference. It is named here so the next implementer reads it as unfinished plumbing
rather than as the deliberate silence the rest of this decision describes.

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
| ~~P5 hubs hosted by another operator~~ | Fired: [ADR-0014](0014-p5-shared-hub-stack.md) Decision 1 built `afp:MembershipProof` and widened A3's `hub` predicate to roleOf-or-presented-proof |
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

**Revised under contact (2026-09-18).** [ADR-0038](0038-the-operators-own-work.md)'s read
CLI (`npm run show`) found that a controller held on the instance it reads from was refused
the very thread it had delegated on: Decision 3's `parties` row required an active agreement
with the requester's operator, and an instance holds no agreement with itself. Two narrow
rules amend the row, in `federation/readGate.ts`'s `admitsParties` only — `admitsHub` and
the grant path are untouched:

1. **A self-operated requester satisfies the agreement stage by construction.**
   `ReadGateDeps` gains `selfActor`, this instance's own actor id; a requester whose
   `afp:operatedBy` *is* that id (compared as an actor id, never as an origin prefix) skips
   `activeAgreementsWith`. An instance is not a counterparty to itself — `inbox.ts` has said
   "no self-agreement to model" since P1. The deny-list stage and the party test run
   unchanged, so this widens nothing a stranger can reach: a requester operated by another
   instance still needs an agreement, and a self-operated requester still has to be a party.
2. **The author of an activity is a party to it.** `actor` joins the `to`/`cc` list. The
   author already holds the bytes they signed; admitting them to read back what they
   published discloses nothing to anyone who could not already produce it. Only `actor` —
   under instance custody `afp:actingAs` names the same agent `actor` already names
   (`instance.ts` `publish`), so it adds no one and is not consulted.

Pinned by `test/adr0013.test.ts`: "self-operation waives the agreement stage — and only
self-operation does" (a requester operated by another instance with no agreement is still
refused a `parties` activity naming it; the same requester under its own operator is
admitted) and "self-operation never waives the party rule; the author is a party" (a
self-operated requester neither named nor author is refused; the author is admitted;
`afp:actingAs` alone admits nobody). Every prior case in this file and in
`test/adr0029.test.ts` passes with no assertion changed; ADR-0038's G8(b) is the end-to-end
case over HTTP.

**The same hole on the write side, recorded here for symmetry (2026-09-19,
[ADR-0037](0037-the-served-hub.md)).** `serve` hosts a hub now, and a hub's inbox is the
only door to it — there is no in-process path a served instance can take, the way every
demo's embedding program did. So the operator's own instance, seating itself on its own
hub, arrived at its own boundary and was refused at exactly the stage above:
`Federation.gate` looks for an agreement with the sender's operator, and there is none to
find. `federation/inbox.ts` now waives that stage for a sender whose operator is this
instance's own actor id — compared as an actor id, never as an origin prefix, the same
rule as above — and waives nothing else: the HTTP signature is verified before it, the
deny-list still applies, and `admitWrite` (the hub's seat and enrollment gate, which is
what actually authorizes a hub write) still runs after it. ADR-0037's G2 is the
end-to-end case.

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
