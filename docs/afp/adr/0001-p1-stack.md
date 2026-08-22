# ADR-0001 — Technology stack for P1

- **Status:** Accepted, then **partially revised during implementation** — see
  [Revised under contact](#revised-under-contact) at the end. Two of the five
  decisions changed; the reasoning behind all five is unchanged.
- **Date:** 2026-08-17 (revised the same day, once P1 was built)
- **Applies to:** [P1 — one instance, two agents, one verifiable record](../05-roadmap.md#p1--one-instance-two-agents-one-verifiable-record)
- **Supersedes:** the generic "tech stack suggestion" survey in the spec (§23), which
  predated the P1 rescope

## Context

P1's deliverable is not a working task pipeline — it is **a record a third party can
verify**. Two agents, one process, no network; then an exported outbox that a stranger
holding no keys can replay, and that fails loudly when one byte of evidence is altered or
one activity is removed.

That reframing changes what the stack has to be good at. Working backwards from the
[acceptance gate](../05-roadmap.md#acceptance-gate):

| Requirement | Stack consequence |
|---|---|
| Signed activities from activity #1 | A canonicalization scheme — the genuinely constraining choice |
| Third-party replay of an export | A verifier that runs with no access to the instance |
| Hash-chained outbox, seen-ids, pending tasks | An embedded store; the file itself is the export |
| Hash-addressed artifacts | Content-addressed blobs — a directory named by digest |
| Two agents, in-process, no network | **No broker, no Postgres, no containers.** P1 infra should be zero |
| Brains behind a port | An LLM SDK that never touches the protocol layer |

Note what is *absent*: at P1 there is no federation, so Mastodon compatibility,
delivery fan-out, SSRF protection and authorized fetch — the things an ActivityPub
framework is mainly worth — are all unused until P4.

### A precision that changes the dependency list

The P1 scope originally said "HTTP Signatures on every delivery — *including* in-process
dispatch." That is wrong in a way that matters here. An HTTP Signature authenticates one
hop and is discarded on receipt; it never enters an outbox, so a third party replaying an
export never sees one. What survives is the **object integrity proof** on the activity
itself.

So P1's mandatory crypto is object integrity proofs. HTTP Signatures are needed only if P1
is wired over loopback HTTP, and become genuinely mandatory at P4 when there is a real hop
to authenticate. The spec now states this as two mechanisms with different lifetimes
([01 — Authentication](../01-foundations.md#authentication--two-mechanisms-with-different-lifetimes)).

## Decisions

### 1. Signature suite: `eddsa-jcs-2022`, not `Ed25519Signature2020`

The highest-leverage decision, and the one with a spec consequence.

`Ed25519Signature2020` canonicalizes with RDF Dataset Canonicalization (URDNA2015) — a
heavyweight dependency that exists in a handful of languages and therefore silently picks
the rest of the stack. [FEP-8b32](https://socialhub.activitypub.rocks/t/fep-8b32-object-integrity-proofs/2725)'s
`eddsa-jcs-2022` cryptosuite instead uses EdDSA + SHA-256 + [JCS (RFC 8785)](https://www.w3.org/TR/vc-di-eddsa/)
canonicalization, which is essentially sorting JSON keys: a couple of hundred lines in any
language.

**We adopt `eddsa-jcs-2022`.** This is what makes an independent verifier cheap, and an
independent verifier is what makes the audit claim worth anything. It also matches where
the Fediverse is heading, so it costs nothing at P4.

*Spec consequence, already applied:* every `"signature": { "type": "Ed25519Signature2020" }`
example became `"proof": { "type": "DataIntegrityProof", "cryptosuite": "eddsa-jcs-2022" }`,
and signed documents carry `https://w3id.org/security/data-integrity/v1` in `@context`.

### 2. Runtime: TypeScript on Node 22+

The only ecosystem with both a mature ActivityPub server framework and a first-class LLM
SDK for the brains. Python has better brain ergonomics but no comparable server framework;
Go and Rust give a single static binary but cost prototyping speed while the design is
still moving.

### 3. ActivityPub layer: Fedify, adopted at P1 despite barely using it

[Fedify](https://fedify.dev/) handles actor dispatch, WebFinger, the inbox pipeline, key
management, and all four signature mechanisms — HTTP Signatures (draft-cavage and
RFC 9421, with double-knocking), Linked Data Signatures, and FEP-8b32 object integrity
proofs using exactly the cryptosuite chosen above.

P1 uses perhaps a tenth of that. We adopt it anyway because the alternative — a thin
hand-rolled layer now, a framework at P4 — defers the interop learning to the phase where
it is most expensive, and the Mastodon-quirk knowledge encoded in Fedify is not worth
re-deriving.

**Known friction, accepted deliberately:** Fedify's vocabulary is *code-generated*, and
extending it with custom types has historically been
[difficult](https://fedify.dev/manual/vocab) — `fedify generate-vocab` now exists for
exactly this. AFP is mostly `afp:` vocabulary, so this is the sharpest edge of the choice.
Mitigation: exercise `generate-vocab` in week one, on `afp:Task` / `afp:Result` /
`afp:Error`, before anything else is built on top. P1's custom surface is small — those
three ride *inside* standard `Offer` and `Create` activities — so if generate-vocab proves
unworkable, we find out while the sunk cost is still one week.

**Amended by [ADR-0017](0017-standards-conformance.md) (2026-08-22):** Fedify is
re-scoped from adopted dependency to **reference implementation to test against**. The
instance stayed zero-dependency through P5 on its own hand-rolled AS2/HTTP-Signature/
WebFinger layer, and earned the harder claim that follows: the conformance surfaces
ADR-0017 built — WebFinger, RFC 9421 native signatures with the cavage double-knock,
dereferenced delivery that fetches and validates every advertised URL — name Fedify as
the interop oracle those surfaces are checked against, not as code this project runs.
The mitigation above (`generate-vocab` in week one) accordingly never fired; there was no
Fedify vocabulary to extend.

### 4. State: SQLite, and no infrastructure at all

Outbox, seen-ids, pending-task table and roster in a single file, so "export the outbox" is
a file copy — which is also the sneakernet property in
[06](../06-deployment-profiles.md#keep-signing-everything--the-sneakernet-property).
Artifacts are digest-named files on disk; content addressing needs no database.

The delivery queue is a table with a `next_attempt_at` column. Backoff and dead-lettering
are a query. **No Redis, no message broker, no containers at P1** — "extremely simple" is
part of the phase's definition, and infrastructure is the first thing that quietly stops it
being demoable on a laptop.

### 5. The verifier is a second implementation, in Go, sharing no code

If the writer and the verifier canonicalize with the same buggy function, an invalid record
verifies clean. Replay passing *is* the product of P1, so a shared-code verifier would be
attesting to its own bug.

The verifier is therefore a separate codebase in a different language: roughly 200 lines of
RFC 8785 key-sorting, Ed25519 verification, SHA-256 digest checks, and a `prevActivity`
chain walk. **Go**, because the person receiving it — an auditor, a client, a sceptical
colleague — should get one static binary and no runtime to install.

It is also the cheapest possible interop test: two independent readings of the spec,
disagreeing early, long before P4 goes near another implementation.

## Options considered

| Option | Rejected because |
|---|---|
| Python + FastAPI + [apsig](https://github.com/fedi-libs/apsig) | Best brain ergonomics and apsig covers the signature suites, but no server framework — the P4 federation work would be hand-rolled at the point where interop bugs are most expensive |
| Go or Rust, hand-rolled | Single-binary distribution is genuinely valuable for the airgapped profile, but costs prototyping speed while the protocol is still changing. Revisit for the *instance* if airgapped deployment becomes the primary product; already chosen for the verifier |
| Elixir / OTP | Conceptually the best fit — an AP actor is close to a GenServer with a mailbox, and Pleroma proves the domain — but the weakest JSON-LD and data-integrity library support, and the smallest talent pool for a consultancy |
| Thin hand-rolled AP layer at P1, framework at P4 | Genuinely close. Rejected because it defers all interop learning to the most expensive phase and risks a P4 adapter rewrite; and because gate check 11 ("the wiring is invisible") is more credible when a real AP framework produces the bytes |
| `Ed25519Signature2020` / `eddsa-rdfc-2022` | RDF canonicalization is a heavy dependency available in few languages — it would make the independent verifier expensive, which is the one thing P1 cannot afford |
| Postgres at P1 | Operational cost with no P1 benefit, and it breaks "the export is a file copy" |

## Consequences

**Positive**

- The verifier is portable, so the audit claim is checkable by anyone — including on an
  airgapped machine.
- P1 runs from `npm start` with one data file. Demoable on a laptop, in front of a client.
- P4 federation is mostly configuration rather than construction.
- Two independent implementations of the record format exist before any external party
  sees it.

**Negative / accepted risks**

- Fedify's code-generated vocabulary is the sharpest edge; if `generate-vocab` cannot carry
  AFP's `afp:` terms comfortably, we fall back to the thin hand-rolled layer. Decided in
  week one, not at P4.
- Maintaining a second implementation in a second language is real ongoing cost. It is the
  cost of the guarantee, not an accident.
- Node is not a single binary. If airgapped distribution becomes primary, revisit — `bun
  build --compile` or a Go rewrite of the instance are both open.

**Revisit triggers**

| Trigger | Reconsider |
|---|---|
| `generate-vocab` cannot express AFP vocabulary workably | Decision 3 — drop to a thin hand-rolled AP layer |
| Airgapped deployment becomes the primary delivery mode | Decision 2 — single-binary runtime for the instance |
| P5 multi-hub cross-operator sync | Decision 4 — SQLite → Postgres for the state store |

## Revised under contact

P1 was implemented immediately after this ADR was accepted. Two decisions did not
survive, and one turned out better than assumed. The week-one experiment the ADR
called for took about an hour.

### Decision 3 (Fedify) — **reversed**. P1 uses the thin hand-rolled layer.

The experiment was exactly the one specified: generate `afp:Task` alongside AS2
and see what comes out. It runs, and the output is the problem.

| Observation | Consequence |
|---|---|
| `fedify generate-vocab` requires *all* 81 AS2 schema files in its input directory and emits **one 103,585-line module** | It does not extend the vocabulary; it regenerates it |
| The generated module declares its own `Object`, `Activity`, `Create` … alongside `Task` | A **parallel class hierarchy**, not an addition to Fedify's |
| `@fedify/fedify` imports its vocabulary from `@fedify/vocab`, a hard dependency pinned at `2.3.4` | To use AFP types with `Federation`, you must alias the vendor's internal package to your generated module, and regenerate on every Fedify upgrade |

That is the wrong dependency direction for a protocol that is ~90% custom
vocabulary and whose product is the exact bytes of a record: **AFP's vocabulary
would become version-locked to a framework's internal package.** The ADR
pre-authorized this fallback, and P1 uses it — actor documents, the roster,
activity builders and the inbox pipeline are about 400 lines of plain TypeScript.

*This is not a reversal at P4.* Fedify remains the right choice for federation
*transport* — HTTP Signatures with double-knocking, Mastodon quirks, SSRF guards,
authorized fetch — and the nuance that makes it work is that AFP objects ride
*inside* standard AS2 activities. Use it for the envelope, not the payload; then
its vocabulary and ours never need to be the same classes.

### Decision 5 (Go verifier) — **language changed to Python**, principle intact

No Go toolchain was available in the build environment, and an acceptance gate
that cannot actually run is worthless. The verifier is Python 3 (`cryptography`
for Ed25519, standard library for everything else), ~250 lines.

What survives: a different language, zero shared code, written from the algorithm
rather than ported. What is lost: the single static binary an auditor could run
with nothing installed. A Go port stays open and is a small job — the algorithm
is now written down in `src/verifier/README.md` precisely so a third
implementation is cheap.

### Decision 2 (runtime) — **better than assumed: no dependencies at all**

Node 22.5+ ships `node:sqlite`, and Node 23+ strips TypeScript types natively.
With Fedify dropped and `node:crypto` covering Ed25519, the P1 instance has **no
dependencies and no build step** — `npm run demo` on a clean checkout.

### Decision 2b (brains) — Anthropic SDK replaced by an OpenAI-compatible endpoint

The reference deployment now runs a **local Lemonade server** (Qwen3.6-35B-A3B-NoThinking
at `http://localhost:13305/api/v1`), reached with plain `fetch` against the
chat-completions wire protocol rather than a vendor SDK. That keeps the
dependency count at zero, makes any compatible endpoint — local or hosted — a
two-variable change, and means model inference costs nothing during development.

This is the ports-and-adapters boundary paying out earlier than expected:
swapping the model provider touched `brains/` and `config.ts` and **changed
nothing about the record**. The acceptance gate pins `AFP_BRAIN=stub` and still
passes with a dead endpoint configured, because a model in the loop would make
"did the record verify" depend on sampling.

One addition it motivated: `afp:producedBy` on a `Result`, naming what generated
the content. Provenance otherwise stops at the agent–instance port (04 §
Rationale externalization) — an auditor can see that an agent made a claim but
not what made it.

One sharp edge worth recording: Node's strip-only TypeScript mode rejects
*parameter properties* (`constructor(private readonly db: Db)`). Declare the
fields explicitly.

### What the gate says

All eleven checks in
[05 § Acceptance gate](../05-roadmap.md#acceptance-gate) pass, including check 10
— the independent verifier accepts the clean export and rejects both deliberate
mutations, naming the mismatched digest and the broken chain link respectively.

## References

- [Fedify](https://fedify.dev/why) · [Fedify vocabulary](https://fedify.dev/manual/vocab)
- [FEP-8b32: Object Integrity Proofs](https://socialhub.activitypub.rocks/t/fep-8b32-object-integrity-proofs/2725)
- [Data Integrity EdDSA Cryptosuites v1.0](https://www.w3.org/TR/vc-di-eddsa/) (RFC 8785 JCS)
- [apsig](https://github.com/fedi-libs/apsig) — Python signature implementation, evaluated
