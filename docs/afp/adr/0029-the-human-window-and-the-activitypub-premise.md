# ADR-0029 — The human window and the ActivityPub premise, re-examined

- **Status:** Accepted (2026-09-02), **built** (2026-09-13) — program claim **C5** of
  [ADR-0024](0024-the-road-to-production.md); group: **Scenario coverage**. Depends on
  [ADR-0027](0027-the-port-is-a-security-boundary.md)
- **Date:** 2026-09-02
- **Applies to:** 01 § the premise, 04 § Mastodon interop, the P4 roadmap row, the root
  README's claims, and the wiring of `src/instance/src/federation/visibility.ts`
- **Builds on:** [ADR-0017](0017-standards-conformance.md) Decision 6 (deviations from
  ActivityPub are normative text), [ADR-0008](0008-p4-federation-stack.md) Decision 6
  (the shop window, marked built at representation level), 04 § Renderings (a rendering
  is derived from a verified export and carries its verdict),
  [ADR-0013](0013-authorized-fetch.md) (the read gate)
- **Driven by:** the review's second answer — ActivityPub buys identity, discovery and
  vocabulary conventions, not security and not behavioural interop — and
  [ADR-0023](0023-loose-ends-triaged.md) rows L16, L17, L18: `shadowNote`,
  `parseCommand` and `politeReply` exist and have no callers; delivery to a Mastodon inbox
  needs an RSA shim that is recorded as a wart

## Context

The root README's first sentence federates "over ActivityPub, the W3C protocol behind
Mastodon", and the roadmap's P4 demo promises that "an operator follows an agent from a
stock Mastodon account and watches the thread". The first is true at the level of
actors, documents, signatures and vocabulary — ADR-0017 made it true. The second is not
demonstrated by anything: a stock Mastodon server drops every `afp:` object, the shadow
timeline that would give it something to show is a function nobody calls, and delivering
even that needs a signature scheme and key type the instance does not have.

The review's observation is sharper than "unwired": *the federation story would lose
little if the envelope were plain signed JSON over HTTPS.* What AP genuinely earns is the
identity model (actor URLs, key discovery, WebFinger), the vocabulary discipline (AS2 core
types with a published extension context), and a shape other implementers recognise.
What it does not earn is the impression that fediverse software participates, or that
building on it inherited a hardened architecture. ADR-0017 Decision 6 already says where
AFP departs from AP; this ADR says what AP was for, so the claim is precise in both
directions.

Separately, the scenarios need a *human window* — a way for a person to watch, approve
and command — and the spec's only answer is the Mastodon projection. Scenario 01's
approval, scenario 08's "the operator can watch without joining", scenario 11's
"nobody has to take another school's word" all want a human surface that today exists
only as `afp:AuditGrant` on the read gate.

## Decisions

### 1. The premise is stated precisely, and the README says the same

01 gains a normative paragraph: AFP is ActivityPub-compatible at the level of actors,
actor documents, key discovery, signatures and vocabulary. Behavioural interoperability
with fediverse software is limited to `Follow`/`Accept`, WebFinger, NodeInfo, and the
optional shadow timeline of Decision 3. AFP objects are not consumable by fediverse
software, by design: a closed federation with a two-tier gate has no public to fan out
to. Building on ActivityPub provides conventions; every security property in this
protocol is AFP's own and is listed where it is specified. The README's first paragraph
and the P4 roadmap row are reworded to match; the Mastodon-follows-an-agent demo line
moves to the optional profile of Decision 3.

### 2. Humans watch, approve and command through a first-class AFP surface

- **Watch.** `GET /threads/:id/rendering` and `GET /agents/:name/timeline` serve
  renderings derived from the record under the authorized-fetch gate (ADR-0013) — the
  same classes, the same 404 — built by the rendering convention 04 already states:
  derived from verified activities, carrying the bundle digest and the verifier's verdict
  where an export exists. An auditor holds an `afp:AuditGrant`; a member holds
  enrollment; a stranger sees `public`.
- **Approve.** [ADR-0028](0028-port-agents.md)'s `ApprovalPort` is the primary path. The
  controller is bound by the instance's policy document ([ADR-0033](0033-operator-obligations.md)):
  a list of controller actor URLs — humans hold an actor too, under instance custody —
  and the approval enters the record as a signed actuation.
- **Command.** The three-form grammar in `visibility.ts` is wired to a local endpoint
  `POST /agents/:name/command` under the same controller binding, with the fixed polite
  reply for everything else. Mastodon mentions become one carrier for the same grammar
  (Decision 3), never the only one.

  **Amended by [ADR-0038](0038-the-operators-own-work.md) (2026-09-18), and the amendment
  splits the carriers.** The grammar is four forms now, not three: `task` opens work,
  which the three older forms — `status`, `pause`, `approve` — deliberately could not do.
  But ADR-0038 Decision 3 refuses `task` on the mention carrier by a named branch, so the
  two carriers no longer run the same grammar. The HTTP route runs all four; a mention
  runs the three that carry no free text. The reason is custody, not caution: a
  `Create{Note}` is the one inbound shape a stock fediverse account can author, and under
  instance custody it arrives at the boundary signed by the *sender's* operator on the
  controller's behalf (`afp:actingAs`) — so a brief carried by a mention would reach a
  brain on the strength of another operator's key. One grammar, two carriers, and the one
  form that carries content has exactly one door.

  What this costs is worth naming rather than leaving a reader to discover: a human who
  lives in a normal fediverse client can watch, approve, pause and query from it, and
  cannot start work from it. Opening a case from a client app is a port concern
  (`ports/webhook.ts`'s shape) or a signed call from the controller's own key
  (`npm run task`), never a mention. This closes the substance of
  [scenario 01](../scenarios/01-client-due-diligence.md)'s finding 75 — the grammar's
  missing kickoff verb — and states the narrowing that replaced it.

### 3. The Mastodon projection is an optional profile, off by default

`AFP_FEDIVERSE_WINDOW=1` enables dual-publish: every event 04 lists as operator-visible
emits a `public` `Create{Note}` shadow to followers, built by the existing `shadowNote`
(summary only, chain head, link to the machine activity), and inbound mentions are
parsed by the existing grammar. Delivery to a real Mastodon inbox — the RSA key and the
draft-cavage path — stays parked behind ADR-0023 L18's trigger; until it lands the
window is "followable by AFP-aware software and by anything that can read a public
outbox", and the docs say so. Closes L16 and L17; leaves L18 parked with its trigger
written down.

### 4. The envelope stays

The AS2 envelope, `https:` ids, `eddsa-jcs-2022` proofs and the published context are
sunk cost that works and that ADR-0017 just made conformant. Re-platforming to plain
signed JSON would change no security property and would cost every shipped bundle. What
changes is the claim, not the bytes.

## Options considered

| Option | Rejected because |
|---|---|
| Keep Mastodon as the human window and build the RSA shim | It ties the one surface humans need to the one interop path that is a recorded wart, and to a key type AFP does not otherwise use |
| Drop ActivityPub compatibility to "inspired by" | ADR-0017 spent seven decisions making the compatibility claim true at the document level; that work is worth keeping and worth stating precisely |
| A full web UI | Out of scope for a reference instance. Renderings over the read gate are the protocol's surface; a UI is a deployment's |

## Consequences

**Positive** — the README stops promising what Mastodon cannot do; humans get a surface
that is gated like everything else and renders from verified bytes; the three unwired
functions get wired where they are useful.

**Negative** — a deployment that wanted "just follow it from Mastodon" gets a profile
flag and a caveat.

**Accepted** — the premise, re-stated, is smaller. That is the point.

## Implementation architecture

### W1. Files

| Package | Touches | Content |
|---|---|---|
| **WP-1 · claim** | 01 § the premise, root README, 05 P4 row, 04 § Mastodon interop | Decision 1 |
| **WP-2 · window** | `ap/server.ts` (rendering routes under the read gate), `render/` (new; the 04 convention as code), `federation/readGate.ts` | Decision 2 |
| **WP-3 · approve + command** | `ports/approval.ts` (with ADR-0028), `ap/server.ts` command route, `visibility.ts` grammar wired | Decision 2 |
| **WP-4 · projection** | `instance.ts` (shadow emit under the flag), `config.ts` | Decision 3 |
| **WP-5 · gate** | `test/adr0029.test.ts` | W2 |

### W2. Gate matrix — `test/adr0029.test.ts`

| # | Case | Asserts |
|---|---|---|
| G1 | A rendering fetched anonymously for a `parties` thread | `404`; for a `public` thread, a rendering carrying the digest of what it rendered |
| G2 | The same under an `afp:AuditGrant` | served; the fetch is recorded (ADR-0013 A5) |
| G3 | A command from an unlisted controller | the fixed polite reply; from a listed one, the action |
| G4 | The fediverse window off | no shadow Notes emitted; every shipped bundle byte-identical |
| G5 | The window on, a `parties` event | the shadow carries no gated content (ADR-0008b's check, now on the real path) |
| G6 | Every shipped bundle replayed | unchanged |

## Build status

**Built (2026-09-13).** All five work packages, and the gate matrix passes G1–G6
(`test/adr0029.test.ts`, 14 cases — G1–G6 plus two primitive checks carried over from the
WP-2 unit gate). The full suite is 320 tests, all green. `npm run demo` and `npm run
demo:p8` both run offline and deterministic with the window off (the default), and their
exports pass the independent Python verifier clean.

Notes on what was built versus what the ADR wrote:

- **The verdict field is read back, never computed.** `render/rendering.ts`'s
  `bundleInfoFor` reads a stored `VERDICT.json` next to the export's `MANIFEST.json` and
  reports its `verdict` string verbatim, or the literal `"unverified"` when nothing was
  stored — this instance runs no in-process verifier (that is the Python tool), so a
  rendering never fabricates a pass.

  **Amended 2026-09-19 — the verdict is bound to a manifest**
  ([scenario 01](../scenarios/01-client-due-diligence.md) finding 77). Writing this up
  found something the finding had not: *nothing in the repository wrote `VERDICT.json`*.
  The verifier had no flag for it and no script produced one, so the read-back path read
  a file only a human could have written by hand, and every rendering this build has ever
  served said `"unverified"`. The finding asked for operational guidance — "run the
  verifier in the same session" — but there was no command to run.

  So two small changes, and the duty they leave behind:

  - `afp_verify --verdict-out` writes `VERDICT.json` into each export directory it
    verified, carrying the verdict (`passed`/`failed`), the check and failure counts, the
    verifier version, and **the sha256 of the `MANIFEST.json` it actually read**.
  - `bundleInfoFor` compares that digest against the manifest it is serving. A verdict
    bound to a different manifest is a verdict for a record this export has moved on
    from, and is refused back to `"unverified"`. A file carrying no digest predates the
    flag and is still taken at its word.

  This turns the finding's discipline into a mechanism: a stale pass is no longer
  something an operator must remember not to cause, because the read path will not report
  one. What remains genuinely operational is *producing* a fresh verdict at all — the
  instance runs no in-process verifier (that is the Python tool, deliberately), so an
  operator who wants a rendering to say `passed` must export, verify with the flag, then
  serve. The production checklist carries that line, and the stronger answer is still to
  hand the auditor the export so they verify it themselves, which is what the grant is
  for. Gated in `test/adr0029.test.ts` G2: bound-and-matching is reported, bound-and-stale
  is refused, unbound is honoured.
- **`afp:chainHeads` are heads among *admitted* entries,** not an actor's true chain head.
  `render/rendering.ts`'s `chainHeadsOf` takes the last entry it sees per actor in the
  entries the read gate already filtered — for a reader whose grant or membership does not
  admit an actor's later activities, the head reported is the last one that reader can
  verify against, which the module documents rather than silently overstates.
- **Controllers authenticate by HTTP signature; `AFP_CONTROLLERS` stands in for
  ADR-0033.** `ports/command.ts`'s `commandRoute` resolves the requester through
  `authorizeRead`'s signature verification (extended with `method`/`body` for a signed
  `POST`) before checking `isAuthorizedController` — exactly the binding ADR-0028 Decision
  4 anticipated, carried forward rather than re-decided here.
- **`pause` has no `resume` in the grammar.** `instance/pause.ts`'s `PausedAgents` exposes
  `resume`, and `AfpInstance.resumeAgent` calls it, but no mention or command form reaches
  it — an operator's own program is the only caller, exactly as Decision 2 states. A
  durable stop is `disownAgent`, on the record; a pause is not.
- **The operator-visible set is pinned in code, not read from 04 at runtime.**
  `instance/window.ts`'s `OPERATOR_VISIBLE_OBJECT_TYPES`/`OPERATOR_VISIBLE_ACTIVITY_TYPES`
  are the object types `{afp:Task, afp:Award, afp:Result, afp:Synthesis,
  afp:DecisionRecord, afp:Vouch, afp:Disown, afp:Error, afp:Act}` and the activity types
  `{afp:Award, afp:Vouch, afp:Disown}` 04 lists — a shadow's own object type (`"Note"`) is
  in neither set, which is what keeps a shadow from ever shadowing a shadow, by
  construction rather than by a runtime check.
- **Shadows publish to `to: []`; Mastodon delivery stays parked.** `maybeShadow` signs and
  chains the shadow through the instance's own `publish`/`publishAsInstance` with nothing
  addressed — "followable by AFP-aware software and by anything that can read a public
  outbox," per Decision 3. The RSA keypair and draft-cavage shim a real Mastodon inbox
  needs is still ADR-0023 L18, and its trigger is unchanged: a real Mastodon follower is
  wanted.
- **`authorizeRead` grew `method`/`body`,** defaulting to `"GET"`/`""` so every existing
  caller — a bare `GET` — is unaffected; a signed `POST`'s `Content-Digest` now covers the
  same bytes an inbox POST already binds.
- **The polite reply is recorded in the audit log, never on the chain — but only for a
  *verified* signer** (ADR-0013 Decision 5, unchanged by this ADR): `ports/command.ts`'s
  `commandRoute` calls `Inbox.dropDelivery("polite-reply", …)` for an unlisted controller,
  an unparseable/misdirected command, and an inadmissible `approve`, but an anonymous or
  non-verifying request is answered and never logged — a free, unbounded refusal logged
  would be a pen any stranger could write into the operator's store with, and the
  rate limiter, not the audit log, is what bounds the asking. G3(d) checks both halves: the
  three verified refusals each add one `"polite-reply"` row, the anonymous one adds none.
- **One audit outcome for both carriers.** `inbox.ts`'s `onMention` records the same
  `"polite-reply"` outcome `commandRoute` does for its own three refusal paths (no local
  agent addressed, unauthorized controller, unparseable/misdirected command) and for
  `executeCommand`'s own inadmissible-`approve` fallback — one outcome value a reader
  checks regardless of which carrier the attempt arrived on, which is what G3(e) asserts.
- **A shadow's `publicSummary` is bounded, the same 120-character excerpt limit
  `render/rendering.ts` puts on a rendering's `public` narrative line** — `instance/window.ts`'s
  `publicSummaryOf` truncates with an ellipsis rather than re-surfacing an unbounded public
  string verbatim, so the one field a shadow may legitimately carry from an already-`public`
  activity stays a summary, never a full copy.
- **No narrowing of the G-rows.** G1–G6 are exactly the matrix below; nothing was demoted
  to a primitives-only check.

**Revised under contact (2026-09-18).** Decision 2's "three-form grammar" is four forms:
[ADR-0038](0038-the-operators-own-work.md) adds `@<name> task <brief>` — the controller's
one-line brief, executed as an `Offer{afp:Task}` from the controller's *held* actor through
`instance.delegate`, so the record shows what a program would have produced and no new wire
vocabulary appears. The additions this ADR's G3 relies on hold: the same `parseCommand`,
the same `executeCommand`, the same polite reply for every refusal, and "no other path
parses stranger free text" is still true by construction. One deliberate asymmetry: the
mention carrier (Decision 3) refuses `task` by name, because it is the one form that hands
a brain free text and a Note arrives on another operator's signature — ADR-0038 Decision 3
records why. Scenario 15 could not name a command that hands a served instance's agent a
job; `npm run task` is now that command.

## Build status — gate matrix

| # | Case | Result |
|---|---|---|
| G1 | Anonymous fetch: `parties` 404, `public` renders with the digest of what it rendered | pass |
| G2 | The same under an `afp:AuditGrant`: served, and the fetch is recorded | pass |
| G3 | A command from an unlisted controller: the fixed polite reply; from a listed one, the action — `status`, `pause` (+ idempotent, + a paused performer's Reject), `approve` (+ reconciliation naming the controller), every refusal shape (verified refusals logged, an anonymous one not), and the inbox mention carrier | pass |
| G4 | The fediverse window off: no shadow Notes emitted; every shipped bundle byte-identical | pass |
| G5 | The window on, a `parties` event: the shadow carries no gated content | pass |
| G6 | Every shipped bundle replayed, window off by default: `demo:p1` and `demo:p8` both PASSED | pass |

## References

- 01 § Deviations from ActivityPub; 04 § Mastodon interop; 04 § Renderings
- [ADR-0008](0008-p4-federation-stack.md) Decision 6; `src/instance/src/federation/visibility.ts`
- [ADR-0023](0023-loose-ends-triaged.md) rows L16, L17, L18
- Scenarios [01](../scenarios/01-client-due-diligence.md), [08](../scenarios/08-the-subcontract.md), [11](../scenarios/11-the-snow-day.md)
