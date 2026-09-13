# Scenario 16 — The hostile edge: five adversaries, and what none of them need a mechanism to do

> Spec-test scenario, written under [ADR-0030](../adr/0030-scenario-re-walks-and-the-coverage-index.md)
> Decision 3. **The first scenario whose cast is the attacker**, and the one the security
> ADRs are measured against: [ADR-0025](../adr/0025-transport-hardening.md) (the wire),
> [ADR-0027](../adr/0027-the-port-is-a-security-boundary.md) (the ingestion boundary),
> [ADR-0028](../adr/0028-port-agents.md) (the webhook door), [ADR-0029](../adr/0029-the-human-window-and-the-activitypub-premise.md)
> (the command route), and [ADR-0013](../adr/0013-authorized-fetch.md) (the read gate,
> whose Decision 5 already rules that refusals are not logged). Scenario 08's Mallory
> established the pattern — a validly-keyed party to nothing, probing a boundary that
> holds — and this scenario does not repeat her; it extends the cast to four more shapes
> of hostility the built stack has never been walked against together, and asks, at every
> beat, the question a mechanism-by-mechanism gate cannot: **what can an adversary who does
> not care which mechanism it is still do?**

| **Support status** | **Supported — findings 90–95** |
|---|---|
| Findings raised | 6 |
| Resolved by | — (candidates named below; several are accepted narrowings, not open work) |
| See it run | — gates only, no demo runs an adversarial workload |
| Gated by | `adr0025.test.ts`, `adr0027.test.ts`, `adr0028.test.ts`, `adr0029.test.ts`, `adr0013.test.ts` |

**Read the walkthrough below as history**, exactly as every other scenario in this
directory: what strained on 2026-09-13, against the build that existed that day. The
[support index](README.md#is-this-workload-supported) carries the current-status view.

## User story

**As** the operator of an instance that accepts mail from the open internet — inbound
deliveries, a webhook door, a command surface a human can mention from Mastodon —
**I want** to know, mechanism by mechanism and then all at once, what an adversary who
holds no agreement, a forged one, a poisoned payload, a stolen key claim, or simply more
requests than my rate limiter tolerates can actually accomplish against my instance,
**so that** the answer to "are we safe" is the record of five specific attempts rather
than a claim that the stack is "hardened."

## Cast

Five adversaries, one each, none coordinating — this is not a campaign against one
target's defenses in sequence, it is the same instance facing five unrelated shapes of
hostility, because that is what an operator's Tuesday actually contains.

| Adversary | Shape | What it holds |
|---|---|---|
| **Mallory-the-stranger** (`stranger.example`) | Never had an agreement with anyone | Valid keys, published; zero standing |
| **Judas** (`partner.example`, formerly agreed) | A counterparty whose agreement is live, whose behavior turns hostile mid-relationship | A real, current `afp:FederationAgreement`; a key document it controls |
| **the poisoned attachment** | Not an actor — a payload | Bytes that lie about their type, or instruction-shaped text, or an image sent to an agent with no declared appetite for images |
| **the forger** (`forger.example`) | A validly keyed party asserting authority it was never granted | A real, working keypair; a signature that verifies; no grant naming it |
| **the flood** (`flood.example`, and an open swarm of anonymous addresses) | Volume, not cunning | Nothing but a network connection and patience |

The target throughout is `defender.example`, the instance from scenario 08's Alpha,
unchanged: `i-identity`, `i-archivist`, a webhook door, a command route, and the ordinary
fetch/read machinery every earlier scenario already exercises honestly.

## Walkthrough

**1. Mallory-the-stranger — three ways of having no standing, none of them subtle.**
An unsigned `POST` to the inbox is refused before any brain, any hub gate, or any
signature check runs at all — there is nothing to verify. A validly-signed `Offer{afp:Task}`
from `stranger.example`, who holds real keys and no agreement with anyone at `defender.example`,
meets the two-tier gate scenario 08 already proved: agreement-before-signature, hard
rejected. And an anonymous mention on the fediverse window — no signer `defender.example`
recognizes, no signature at all, garbage content — gets `ports/command.ts`'s fixed polite
reply (ADR-0029 G3(d)), identical regardless of which of the three it was. Nothing here
is new; it is 08's Mallory, restated as a checklist rather than a plot.

**What is new is naming the shared property of all three refusals: none of them are
logged as a *security* event.** The webhook and command routes each answer politely and
move on; ADR-0013 Decision 5 already rules, for the read side, that "refusals are not
logged" — by design, so that a probe cannot use response timing or a public failure log to
learn *why* it failed. That is a real, deliberate tradeoff, not an oversight, and this
scenario's job is to say so plainly rather than let it be discovered by an operator
looking for it later: an operator who wants to know "how many strangers tried" cannot ask
the record; they can only ask each port's own process log, if one exists and is kept.
(**Finding 90.**)

**2. Judas — a counterparty turning hostile is the scenario 08 boundary answering a
question 08 never asked, because 08's counterparty stayed honest.** Four moves, each
against `adr0025.test.ts`'s own gate:

- Judas's actor document, fetched during ordinary delivery, now serves a redirect to a
  document Judas does not control. Refused, not followed (G4) — a redirect is exactly the
  shape a compromised or malicious counterparty would use to substitute a key document
  after the agreement was signed against the original.
- Judas's key document balloons past the size cap on a later fetch. Refused, streamed
  rather than buffered whole (G5) — the fetch never holds the whole hostile payload in
  memory before rejecting it.
- Judas signs a request with a `keyId` whose fetched document's `id` does not match the
  key's claimed controller. Refused (G6) — this is the beat that answers what an
  *agreement* alone cannot: a live `FederationAgreement` with `partner.example` says
  nothing about which keys speak for `partner.example` today, and G6 is the check that a
  hostile key substitution mid-relationship does not silently inherit the agreement's
  standing.
- Judas replays a signed request — same `keyId`, same `date`, same signature — a second
  time inside the freshness window. Refused (G9) — a captured-and-replayed request from an
  *agreed* counterparty is exactly the threat the nonce cache exists for; Mallory-the-
  stranger never gets far enough to need it.

**Held, unambiguously: an agreement is not a blank cheque.** Every one of the four checks
fires regardless of whether the caller has ever been agreed with — the two-tier gate (08)
answers "may this party speak to us at all," and ADR-0025's checks answer "is what is
speaking to us actually who the agreement names," which turns out to be a different
question the moment an agreed counterparty's infrastructure — not its intent — goes bad.

**3. The poisoned attachment — three payloads, one port, none of them an actor at all.**
Bytes claiming to be a JSON document that are in fact something else entirely are refused
at content-type sniffing, before any brain sees them (ADR-0027 G1) — the checksum and
sniff run *before* trust, exactly the sandboxing 08's finding 30 asked for and never sited.
Instruction-shaped text — "ignore your instructions and…" — arrives as external evidence,
quarantined: the outcome and the action taken are unchanged by what the text says, because
the brain reasons over an excerpt the port produced, never the raw bytes spliced into a
task's own `content` (ADR-0027 G2). And a PNG sent to an agent whose capability
declaration carries no `afp:consumes` for image types gets a reference and an empty
excerpt — never the bytes themselves (ADR-0027 G4).

**What none of the three individually show, and the reason this beat exists at all: a
model reading the quarantined excerpt is still a model, and quarantine bounds what it can
*do*, not what it can be talked into wanting to do.** ADR-0027 G6 is the mechanism that
actually closes this gap — "a brain that names an action in its text does not get that
action; the pinned policy does" — and it is worth stating plainly rather than assuming:
the poisoned attachment can produce a `Result` whose *prose* argues for an action the
policy never pinned, and that prose is signed, on the record, and entirely legitimate
input for whatever reads the Result next. The action itself never happens; the
argument for it still landed in the record, addressed to whichever human or brain reads
that Result next and is not itself protected by G6. (**Finding 91.**)

**4. The forger — a signature that verifies, over an authority that was never granted.**
`forger.example` holds a real keypair and signs an activity claiming to speak *for* an
actor it has no relationship to — the shape 04 names directly: "Signature is not
authority." Two built checks answer two different versions of this:

- `gate.test.ts`'s verifier catches a *tail* activity re-signed with another agent's own
  published key inside a record that already rostered that agent under someone else — the
  chain has no successor to break, so only the roster's authority rule catches it, and it
  does, by name (`no authority over`).
- `adr0005.test.ts` catches the live version: Alpha, honestly signing with its own key,
  tries to `Enroll` one of Beta's own agents at a shared hub — "the signature itself
  verifies — this is an authority failure, not a forgery" — and the hub refuses because
  `afp:operatedBy` names Beta, not Alpha, as the agent's operator.

**Both are the same finding at two different layers, and stating that plainly is this
beat's contribution.** Neither check is about whether a signature is valid; both are
about whether the signer had standing to say the thing it signed. That distinction —
cryptographic validity versus protocol authority — is the one property every other beat
in this scenario assumes and never has to re-derive, because 04 drew it once and the
roster/`operatedBy` machinery enforces it everywhere authority could otherwise be
smuggled through a valid signature.

**5. The flood — volume against a bucket, not cleverness against a gate.** An
unauthenticated burst against the served instance's public surface answers `429` with
`Retry-After` once the per-address token bucket empties (ADR-0025 "an unauthenticated
burst against a served instance answers 429 with Retry-After"), and admits again once the
window passes. Independently, a single oversized inbox `POST` — one request, not a burst —
is refused `413` against the configured body cap (G7), which is the flood's quieter
cousin: one very large request costs the same defensive posture as many small ones,
handled by a different limit entirely.

**What the flood cannot do, stated because it is the useful negative result: it cannot
starve a legitimate counterparty's traffic, because the bucket is per-address.** Judas,
mid-agreement, delivering ordinary signed activities from `partner.example`'s own address,
is unaffected by `flood.example` hammering a different address — the isolation is address-
scoped, not global, which is the detail that makes the rate limiter a defense against
volume rather than a single shared failure point every adversary can trip on someone
else's behalf. That said plainly is itself worth checking rather than assuming: nothing
in `adr0025.test.ts` proves a flood from one address cannot exhaust a resource shared
*underneath* the per-address buckets (a connection pool, a file descriptor limit, the
process's own event loop) — the bucket bounds requests admitted past it, not the cost of
the connections that arrive to be bounced. (**Finding 92.**)

**6. What no single mechanism answers: the record after all five.** This is the point of
writing an adversarial scenario at all rather than trusting five green gate files to add
up to safety, and it is where this walkthrough stops confirming built mechanisms and
starts asking what an adversary indifferent to which one it defeats can still extract.

- **What is not refused.** Every one of the five adversaries above was refused at the
  specific thing it tried. None of them were refused from *trying again, differently* —
  nothing in the built stack rate-limits or flags an address that has been refused by
  three different mechanisms in the same hour as a pattern worth escalating. Each check
  is independently sound and mutually unaware of the others. (**Finding 93.**)
- **What the record does and does not show.** Judas's four attempts, Mallory's three,
  and the forger's one are each refused correctly, and ADR-0013 Decision 5's "refusals
  are not logged" — reasonable for the *read* gate it was written for, where logging a
  refusal risks confirming a record's existence to the very party being refused — is not
  actually scoped to reads anywhere in the built stack; it is simply true everywhere,
  because nothing else logs refusals either. A read-gate refusal and a forged-signature
  refusal have different reasons to stay silent (the first to avoid confirming existence;
  the second has no such reason at all), and the built stack does not distinguish them.
  (**Finding 94.**)
- **What a model can still be steered toward, within the pinned action's bound.**
  Restated from beat 3 as the scenario's sharpest line: quarantine and G6's pinned-action
  rule bound what a poisoned attachment can make an agent *do*. Neither bounds what it can
  make an agent *say*, in a signed Result a human or a downstream brain will read next
  without the same quarantine discipline protecting *them*. (**Finding 91, restated as
  the scenario's throughline rather than one beat's local finding.**)

## Acceptance criteria → mechanisms

| Criterion | Mechanism | Status |
|---|---|---|
| An unsigned or unagreed stranger is refused before any brain runs | Inbox parse + two-tier gate (08, ADR-0025) | Yes |
| A flood is bounded per address, with a machine-readable backoff | Token bucket, `Retry-After` (ADR-0025 G8) | Yes — **shared-resource exhaustion beneath the bucket untested, finding 92** |
| An oversized single request is refused without buffering the hostile payload whole | Streamed size cap (ADR-0025 G5, G7) | Yes |
| A counterparty's key substitution mid-relationship does not inherit the agreement's standing | `keyId` ↔ controller check (ADR-0025 G6) | Yes |
| A replayed signed request is refused inside the freshness window | Nonce/replay cache (ADR-0025 G9) | Yes |
| Bytes that lie about their type never reach a brain | Content-type sniffing at the port (ADR-0027 G1) | Yes |
| Instruction-shaped text cannot change the outcome or the action taken | Quarantined excerpt, pinned action (ADR-0027 G2, G6) | Yes — **the argument still lands in the record for the next reader, finding 91** |
| An undeclared media type never reaches an agent as bytes | `afp:consumes`-gated excerpting (ADR-0027 G4) | Yes |
| A signature that verifies is not treated as authority it was never granted | Roster/`afp:operatedBy` authority check (`gate.test.ts`, `adr0005.test.ts`) | Yes |
| An anonymous or unauthorized command changes nothing and gets a fixed reply | `ports/command.ts` polite reply (ADR-0029 G3(d)) | Yes — **and is not recorded as a security event, finding 90** |
| Refused attempts across mechanisms are correlated as a pattern | Nothing | **No — finding 93** |
| A read-gate refusal's silence and every other refusal's silence are the same design decision | Nothing distinguishes them | **No — finding 94** |

## Spec verdict

**Held: every mechanism this scenario aimed at an adversary answered as its own gate
says it does.** Nothing here found a hole in ADR-0025, ADR-0027, ADR-0028, ADR-0029 or
ADR-0013's own claims — every refusal named above is a real assertion an existing test
already makes, exercised here by a party built to defeat it rather than to demonstrate
it. That is itself the finding worth stating first: five independently-hardened surfaces,
walked together, did not produce a new hole at any of their seams — 08's boundary, 04's
authority rule, and ADR-0027's ingestion pipeline all held against a cast built
specifically to look for the gap between "hardened" and "hardened against this."

**The forged-authority checks this scenario relies on were both built for a different
scenario** — 03's `gate.test.ts`, ADR-0005's own hub test — not for an adversarial walk.
Both hold under adversarial pressure, which is this scenario's proof of them rather than
a new mechanism gap: neither test's own framing names an adversary, they name a
correctness property, and this is exactly the gap ADR-0030's third rejected option
warned against ("a gate proves a mechanism; a scenario proves a story holds under an
adversary who does not care which mechanism it is"). **And nothing here required a new
mechanism at all** — five adversary shapes, five built defenses, zero new holes at any of
their seams. The honest risk this leaves unaddressed is the one a scenario cannot close
by construction: an adversary who finds the *sixth* shape nobody has walked yet.

**Strained — six findings:**

90. **A refused stranger's attempt is not recorded as a security event.** Consistent
    with ADR-0013 Decision 5's own reasoning for the read gate — a logged refusal can
    itself leak information to a prober — but that reasoning was scoped to one gate and
    the silence turns out to be universal, by omission rather than by extending the
    rule on purpose. Candidate: state the rule at the level it actually operates
    (every refusal, not just reads) so a future gate cannot un-silence one path by
    accident while believing it is following precedent.

91. **Quarantine bounds action, not argument.** ADR-0027 G6 stops a poisoned attachment
    from causing an unpinned action; nothing stops it from producing a signed Result
    whose prose argues for one, addressed to whatever reads that Result next without the
    same quarantine discipline. Candidate: a duty, parallel to the ingestion duty itself,
    that a Result's own content inherits a provenance marker when it was produced while
    reasoning over quarantined evidence — so a downstream reader (human or brain) knows
    to apply the same skepticism the port already did.

92. **The per-address bucket is proven per-address; the resources beneath it are not
    proven to survive a flood from one address.** Nothing in `adr0025.test.ts` measures
    connection-level or process-level cost of the requests a flood sends before they are
    bounced. Candidate: a load-shaped test at the transport layer beneath the token
    bucket, or an explicit statement that this is an operational (proxy/OS) concern
    ADR-0032's production checklist already delegates.

93. **Refusals across mechanisms are not correlated.** Each of the five adversaries was
    caught by exactly the mechanism aimed at it; nothing aggregates "this address has now
    been refused by three unrelated gates" into a signal worth escalating. Candidate:
    out of scope for the wire protocol itself — this is exactly the shape of an
    operational intrusion-detection concern, and the honest answer may be "accepted,
    not the protocol's to answer," in ADR-0030's own vocabulary, rather than a spec
    mechanism.

94. **"Refusals are not logged" is universal in practice and scoped in its stated
    reasoning.** ADR-0013 Decision 5 reasons about read-gate confirmation leakage
    specifically; the same silence covers refusals with no such leakage risk (a forged
    signature, a malformed body) for no stated reason. Candidate: either extend the rule
    explicitly to every refusal with the shared reasoning restated, or log the refusals
    that carry no confirmation risk and say why those differ from the read gate's.

95. **A counterparty's key substitution is caught only because ADR-0025 G6 exists —
    and its gate reasons about the *actor's* controller, not the *agreement's* scope.**
    Judas's forged key document names a controller mismatch the check catches; a subtler
    version — a key document that resolves correctly but grants capabilities the
    agreement never scoped — is not this scenario's finding 25 (08's own scope-grammar
    strain) restated, and is left there rather than duplicated. Filed narrowed: the
    mechanism this scenario needed already exists; the deeper scope question is 08's.

## Coverage as of 2026-09-13

Per ADR-0030 Decision 1. No demo runs an adversarial workload against `defender.example`
— every gate cited here is a mechanism test written for a correctness property (08's
handshake, 04's authority rule, ADR-0025/27/28/29's own build gates), exercised here by an
adversary rather than asserted by a builder, so every row is mechanism gated except the
two the built stack genuinely does not answer.

| Criterion | Class | Evidence |
|---|---|---|
| An unsigned or unagreed stranger is refused before any brain runs | mechanism gated | `test/adr0025.test.ts` G1b, G3 · `test/adr0008.test.ts` two-tier gate |
| A flood is bounded per address, with a machine-readable backoff | mechanism gated | `test/adr0025.test.ts` G8, "an unauthenticated burst against a served instance answers 429 with Retry-After" |
| An oversized single request is refused without buffering the hostile payload whole | mechanism gated | `test/adr0025.test.ts` G5, G7 |
| A counterparty's key substitution mid-relationship does not inherit the agreement's standing | mechanism gated | `test/adr0025.test.ts` G6 |
| A replayed signed request is refused inside the freshness window | mechanism gated | `test/adr0025.test.ts` G9 |
| Bytes that lie about their type never reach a brain | mechanism gated | `test/adr0027.test.ts` G1 |
| Instruction-shaped text cannot change the outcome or the action taken | mechanism gated | `test/adr0027.test.ts` G2, G6 |
| An undeclared media type never reaches an agent as bytes | mechanism gated | `test/adr0027.test.ts` G4 |
| A signature that verifies is not treated as authority it was never granted | mechanism gated | `test/gate.test.ts` (tail re-sign, "no authority over") · `test/adr0005.test.ts` (cross-operator Enroll refusal) |
| An anonymous or unauthorized command changes nothing and gets a fixed reply | mechanism gated | `test/adr0029.test.ts` G3(d) |
| Refused attempts across mechanisms are correlated as a pattern | edge not built | finding 93 — accepted as an operational concern, not exercised anywhere |
| A read-gate refusal's silence and every other refusal's silence are the same design decision | narrowed | `test/adr0013.test.ts` (silent-refusal cases) — the rule is proven for reads only; its universality elsewhere is unstated, not tested |

**Counts:** 0 demonstrated · 10 gated · 1 narrowed · 1 not built.
