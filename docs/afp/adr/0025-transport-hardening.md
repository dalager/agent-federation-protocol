# ADR-0025 — Transport hardening: the process that carries the record survives a hostile network

- **Status:** Built (2026-09-04) — program claim **C1** of
  [ADR-0024](0024-the-road-to-production.md); group: **Security**
- **Date:** 2026-09-02
- **Applies to:** every HTTP surface the instance exposes or calls — the inboxes, the
  authorized-fetch read side, actor-document and hub-document resolution, delivery,
  artifact fetch
- **Builds on:** [ADR-0008](0008-p4-federation-stack.md) (the boundary gate, its log,
  and a rate-limiting row marked built), [ADR-0013](0013-authorized-fetch.md) (the read
  gate), [ADR-0017](0017-standards-conformance.md) Decisions 2–3 (RFC 9421 native,
  dereferenced delivery), [ADR-0001](0001-p1-stack.md) as amended (no Fedify, so no
  borrowed fetch policy)
- **Driven by:** the 2026-09-02 review's transport table — eight gaps, each verified in
  the code named below

## Context

The record's cryptography is sound and gated. The process that carries it is a demo
transport, and the review could point at each gap:

| Gap | Where | What the code does today |
|---|---|---|
| No TLS enforcement | `src/instance/src/config.ts`, `federation/transport.ts` | `AFP_ORIGIN` defaults to https but nothing refuses http; every demo and the README's two-terminal example run http origins |
| Unbounded, unpoliced fetch | `federation/inbox.ts` `fetchActorDocument` | A bare `fetch(url)`: no timeout, follows redirects, no content-type check, no size cap. The function's own comment says a change here is security-relevant |
| No SSRF guard | same, and `transport.ts` | A signed POST whose `keyId` names an internal address makes the server fetch it; artifact and inbox URLs are trusted as given |
| No body cap | `ap/server.ts` inbox handler | Chunks are concatenated without limit before parsing |
| No rate limiting | anywhere | [ADR-0008](0008-p4-federation-stack.md) row F3 records "rate limiting in front" as built; no limiter exists |
| Retries burst | `store/queue.ts` `drain` | Backoff is honoured by advancing a virtual clock, so a served instance makes its five attempts immediately and dead-letters a peer that was down for two seconds |
| Key id unbound to document | `federation/inbox.ts` key resolution | The document fetched for a `keyId` is not required to carry that controller's `id` |
| Signed-request replay | `federation/httpSig.ts` | Bounded only by the date-skew window; no replay cache for signed GETs |

None of these is a spec defect; 04's reliability and security sections already name
rate limiting, backpressure and sandboxing. They are the difference between a reference
instance that proves a protocol and a process an operator can expose.

## Decisions

### 1. TLS-only outside a declared development mode

`AFP_ORIGIN` MUST be `https:` unless `AFP_DEV=1` is set, in which case the instance logs
one unmistakable line at startup and again on every inbound request from a non-loopback
address. Outbound delivery, actor-document resolution and artifact fetch refuse `http:`
targets in production mode; an inbound `keyId` whose controller is `http:` is refused at
signature verification with a boundary-log entry of class `insecure-origin`. The two
demo `127.0.0.1` origins keep working under `AFP_DEV=1`, which the demo scripts set.

### 2. One fetch policy, applied to every server-side fetch

A single `policedFetch(url, kind)` replaces every bare `fetch` in `federation/*` and
`ap/*`. Its policy, per `kind` (`document` | `inbox` | `artifact`):

- **Address policy.** Resolve the host first; refuse loopback, link-local, RFC 1918, ULA,
  multicast, and cloud-metadata ranges unless `AFP_DEV=1`. Refuse literal IP hosts in
  production. This is the fediverse's standard SSRF discipline, reimplemented rather than
  borrowed (ADR-0001's amendment: no Fedify).
- **Redirects.** None followed. A 3xx is a refusal with the target logged. (An actor
  document that moves is a key-rotation event under ADR-0012, not a redirect.)
- **Timeouts.** Connect 5 s, total 15 s for documents and inboxes; total 60 s for
  artifacts, which are size-capped anyway.
- **Content type.** `document` accepts `application/activity+json` and
  `application/ld+json` only; `artifact` must match the declared `mediaType` and passes
  through `federation/ingest.ts`'s magic-byte check.
- **Size.** 256 KB for documents; the existing 10 MB ingest cap for artifacts; both
  enforced while streaming, not after buffering.

### 3. A key id is bound to the document that answers for it

The document fetched for `keyId` MUST have `id` equal to the `keyId`'s controller (the
part before `#`), and the key found MUST declare `controller` equal to the same. A
document that answers at one URL while claiming another `id` is refused with class
`key-controller-mismatch`. This closes the substitution the current resolver permits.

### 4. Bodies are capped and parsed defensively

Inbox POST bodies are capped at 1 MB (configurable) with `413` on overflow, before
parsing. The content type MUST be an ActivityStreams type. JSON parsing rejects depth
beyond 64 and any document whose canonicalisation would exceed the cap. The response to
every refusal stays the existing one-body discipline of ADR-0013 Decision 6: nothing
about the refusal reason leaks to an unauthenticated caller.

### 5. Rate limiting is real, and refusals are on the record

Two token buckets in front of every inbox and every non-`public` read: per source
address (unauthenticated, cheap) and per authenticated actor after signature
verification. Overflow answers `429` with `Retry-After`, and — because ADR-0008 made the
boundary a place that leaves a trace — writes a boundary-log entry of class
`rate-limited` naming the actor where one was authenticated. Limits are configuration
with conservative defaults; a hub host may raise them per agreement. ADR-0008's row F3 is
corrected to say "built by ADR-0025".

### 6. Backoff is real time in production, virtual time under test

`queue.drain` keeps its virtual clock only when an injected clock is supplied (the gate
and the demos). A served instance's queue flush is driven by the scheduler of
[ADR-0031](0031-the-resident-process.md) on real intervals, with the existing
exponential schedule (base × 2ⁿ) capped at a configurable ceiling, and dead-letters only
after the configured attempts have been spread over real minutes. A peer's `429`/`503`
with `Retry-After` is honoured as a minimum delay — 04's reliability table already says
so; the code now does.

### 7. Signed requests cannot be replayed inside the skew window

A replay cache keyed by (`keyId`, `created`, signature bytes) with a TTL equal to the
skew window refuses a second presentation of the same signature. Cheap, bounded, and it
closes the one hole the method-derived covered set (ADR-0013 Decision 1) leaves open for
GETs.

## Options considered

| Option | Rejected because |
|---|---|
| Adopt Fedify for its SSRF guards and fetch policy | ADR-0001's amendment settled this: the instance is zero-dependency and Fedify is the interop oracle. The policy above is a few hundred lines and copies its discipline, not its code |
| Leave TLS to the reverse proxy | The proxy terminates inbound TLS; it does nothing for outbound fetches, and an `http:` `keyId` is the attacker's choice, not the operator's |
| Rate-limit at the proxy only | The proxy cannot see the authenticated actor, and the boundary log would then miss the refusals ADR-0008 built it to record |
| Keep the virtual clock and document it | A retry policy that cannot wait is not a retry policy; the record would say "retried with backoff" about five attempts in one second |

## Consequences

**Positive** — the eight review findings each close in one decision. Every refusal a
hostile network provokes lands in the boundary log, which is the discipline the gate
already had.

**Negative** — a real consortium behind corporate networks will hit the address policy
(RFC 1918 hubs on a VPN); `AFP_TRUSTED_NETS` allows named ranges, and using it is a
recorded configuration under [ADR-0033](0033-operator-obligations.md).

**Accepted** — the demos and the gate run under `AFP_DEV=1`; the one thing that must
never happen is a production instance running that way silently, hence the loud log line.

## Implementation architecture

### W1. Files

| Package | Touches | Content |
|---|---|---|
| **WP-1 · policy** | `federation/fetchPolicy.ts` (new), `federation/inbox.ts`, `federation/transport.ts`, `ap/server.ts` | Decisions 1–4 |
| **WP-2 · limits** | `federation/rateLimit.ts` (new), `ap/server.ts`, `federation/federation.ts` (log classes) | Decision 5 |
| **WP-3 · time** | `store/queue.ts`, hook from ADR-0031's scheduler | Decision 6 |
| **WP-4 · replay** | `federation/httpSig.ts`, `store/dedupe.ts` (a second table) | Decision 7 |
| **WP-5 · gate + docs** | `test/adr0025.test.ts`, 04 § Security, ADR-0008 F3 row, instance README | W2 |

### W2. Gate matrix — `test/adr0025.test.ts`

| # | Case | Asserts |
|---|---|---|
| G1 | Production mode, `http:` origin | startup refuses with a named error |
| G2 | Dev mode, `http:` origin | starts, logs the warning, demos pass unchanged |
| G3 | A `keyId` whose controller resolves to a private address | refused, `insecure-origin`/`ssrf` in the boundary log, no request made (resolver stub) |
| G4 | A document fetch answered with a redirect | refused, not followed |
| G5 | A document larger than the cap | refused while streaming; memory bounded |
| G6 | A document at URL A carrying `id` B | refused, `key-controller-mismatch` |
| G7 | An inbox body over the cap | `413` before parsing |
| G8 | 30 unsigned POSTs in one second | `429` with `Retry-After`; then admitted after the window |
| G9 | The same signed GET presented twice inside the skew window | second refused |
| G10 | Queue flush with a real clock (fake timers) | attempts spaced by the schedule; dead-letter only after the last |
| G11 | Every shipped bundle replayed | unchanged — nothing here touches the record |

## Build status

Built, 2026-09-04: `federation/fetchPolicy.ts` (new) — TLS-only outside `AFP_DEV`, address
policy (loopback/link-local/RFC1918/ULA/multicast/metadata refused, `AFP_TRUSTED_NETS` the
named escape hatch), no redirects followed, per-kind timeouts, streamed size caps,
content-type check for `document`. Wired into `federation/inbox.ts`'s `fetchActorDocument`
and `federation/transport.ts`'s delivery and inbox-resolution fetches — the two call sites
the ADR named. `config.ts` refuses an `http:` origin unless `devMode` (`AFP_DEV=1`); `cli.ts`
sets it for every demo command (never `serve`) and `test/helpers.ts` for the gate, so every
existing demo and all 250 pre-existing tests are unchanged (Decision 1's compatibility
proof — see G1/G2 below). Decision 3's key-controller binding is enforced in
`handleInboxPost`. Decision 4's body cap (`AFP_MAX_INBOX_BODY_BYTES`, default 1 MiB) is
enforced in `ap/server.ts` before the body is buffered, answering `413`. Decision 5's two
token buckets (`federation/rateLimit.ts`, new) are live in `ap/server.ts` — per-address on
every request, per-authenticated-actor in `handleInboxPost` after signature verification —
answering `429` with `Retry-After` on the address bucket. Decision 6 ships as
`DeliveryQueue.startRealTimeFlush` (`store/queue.ts`): real-interval `flush()` against the
real clock, for whichever future scheduler drives a served instance's outbound queue
(`serve` does not yet drive one — that is [ADR-0031](0031-the-resident-process.md)'s scope,
not this one's); `drain()`'s virtual clock is untouched and stays what the demos and gate
use. Decision 7's replay cache (`store/dedupe.ts`'s `SeenSignatures`, new) is owned by
`AfpInstance` beside the activity-id dedupe it is the signature-level twin of, and wired
into `handleInboxPost`.

**Not built**: the boundary log does not yet gain a `rate-limited` log class (Decision 5's
last clause) — a rate-limit refusal is answered but not chained into `fed_boundary_log`.
The two refusal sites are not equally ready for it: the per-actor refusal in
`handleInboxPost` already has `federation` in scope and sits beside gate refusals that do
log, needing only the body parsed before the check rather than after; the per-address
refusal fires pre-parse, for every route rather than the inbox alone, with no actor,
claimed type or `Federation` in scope — logging that one means first moving the check (or
its log side-effect) down into the inbox branch. ADR-0008's row F3 is corrected to point
here.

Gate: `test/adr0025.test.ts` — G1, G2 (TLS-only / dev mode), the fetch policy's insecure-
origin, SSRF, redirect, size-cap and content-type refusals, G6 (key-controller mismatch),
G7 (body cap, 413), G8 (rate limiting, 429 + Retry-After, over real HTTP), G9 (replay
cache), and G11 (a full P4 run over real HTTP, with the policy live throughout, still
exports and both sides agree). `npm run gate` — 263/263, unchanged from before this ADR's
250.

## References

- 04 § Security & trust, § Reliability & failure handling
- [ADR-0008](0008-p4-federation-stack.md) Decision 3 (the boundary log) and row F3
- [ADR-0013](0013-authorized-fetch.md) Decisions 1 and 6
- The 2026-09-02 review, transport table
