# 04 — Accounting, reliability, security, Mastodon interop

## Contribution accounting

The ledger is what already exists: signed `Result` activities in operator outboxes, plus L1
commit certificates proving a Result was *accepted by quorum*, not merely claimed.
Together: tamper-evident evidence of "did the work, and it was accepted" — per operator,
per hub, per capability — with no token anywhere.

**`afp:ContributionSummary`** is a periodic, hub-scoped roll-up — deliberately *not*
hub-computed-and-authoritative. It's fully derived from public signed data, so any member
can recompute it independently; `afp:computedBy` is a field, not a privileged role:

```json
{
  "@context": ["https://www.w3.org/ns/activitystreams", "https://afp.example/ns/v3"],
  "id": "https://hub.consortium.example/summaries/2026-w33",
  "type": "afp:ContributionSummary",
  "afp:hub": "https://hub.consortium.example/actor",
  "afp:period": { "start": "2026-08-10T00:00:00Z", "end": "2026-08-16T00:00:00Z" },
  "afp:computedBy": "https://gamma.operator.example/actor",
  "afp:entries": [
    { "afp:operator": "https://alpha.operator.example/actor", "afp:tasksCompleted": 14,
      "afp:byCapability": { "afp:cap:image-classification": 9, "afp:cap:translation-en-da": 5 },
      "afp:evidence": ["https://alpha.operator.example/outbox/result-101#l1-cert",
                        "https://alpha.operator.example/outbox/result-108#l1-cert"] },
    { "afp:operator": "https://beta.operator.example/actor", "afp:tasksCompleted": 9,
      "afp:byCapability": { "afp:cap:image-classification": 9 },
      "afp:evidence": ["https://beta.operator.example/outbox/result-77#l1-cert"] }
  ],
  "afp:inputHash": "sha256-4b2e...",
  "signature": { "type": "Ed25519Signature2020", "proofValue": "..." }
}
```

**Disputes.** `afp:ContributionDispute{summaryId, evidence}` is usually mechanical — "you
omitted this outbox entry" is re-checkable by anyone recomputing over the same public
inputs, resolved by republishing a corrected summary. Genuinely contested cases (did a
Result meet the quality bar?) escalate to an `afp:GovernanceDecision` vote, the same path
as equivocation.

> **Explicitly out of scope:** pricing, payment, settlement, exchange rates, any
> transferable token or credit. The summary is a reputation/accounting artifact; what
> operators do with it off-protocol — billing arrangements, business terms — sits outside
> the protocol boundary by design.

## Reliability & failure handling

ActivityPub delivery is fire-and-forget HTTP POST: a 2xx means "I accepted the bytes,"
nothing more. Every gap is compensated explicitly:

| Concern | What ActivityPub gives you | Compensation |
|---|---|---|
| Delivery retries | Nothing built-in | Per-instance outbox queue: exponential backoff, dead-letter after N attempts, failures surface as local `Error`s — never silently dropped |
| Idempotency | Stable activity `id` | Inbox dedupe on `id` (short-TTL store); CRDT deltas idempotent by construction |
| Out-of-order delivery | None | Three tiers by state class: CRDT state merges in any order; simple workflows key by `correlationId`; causal workflows buffer via `afp:seq`/`afp:vclock` |
| Timeouts / no response | "Thinking" and "dead" look identical | `Task` deadlines + delegator-side timers; liveness suspicion via heartbeat staleness; bid re-auction |
| Backpressure | None | Capacity advertised in capability registry; free `Reject` when saturated; senders back off on `429`/`503`; instance-level outbound rate limits |
| Duplicate execution | None | Globally-unique `correlationId`; an agent already holding it replays its cached `Result` |

Overarching principle: treat every inbox POST as a **hint**, and build every coordination
state machine idempotent, order-tolerant, and timeout-driven.

## Security & trust

- **HTTP Signature verification is mandatory** on every inbox POST — unsigned or invalid
  activities are audit-logged and dropped, never processed.
- **The two-tier gate** runs on every task-relevant activity: FederationAgreement →
  deny-list → roster/MembershipProof as hard gates, reputation as a soft weight.
- **Payload integrity across relays** — everything routed through a hub needs Linked Data
  Signatures / Object Integrity Proofs on the object itself; the HTTP-layer signature only
  authenticates the relaying hop. Required from roadmap P3 onward.
- **Byzantine accountability** — equivocation is cryptographically provable; agent-level
  weight-zeroing is automatic, instance-level consequences are governance decisions;
  snapshot-pinned membership blocks mid-round Sybil enrollment.
- **Rate limiting** per sending instance and per agent at the inbox, independent of
  application-level backpressure — abuse control, not congestion control.
- **Sandboxing untrusted results** — a task done by another operator's agent ran
  attacker-controllable instructions in *their* environment; sandbox the *result*:
  checksum verification, content-type sniffing, size limits, isolated execution of anything
  fetched, before trusting a `Result.attachment`.
- **Key compromise** — immediate rotation + `Update` of the actor document; stale cached
  keys beyond a short TTL are re-fetched before high-value operations. Instance-custodied
  fleets rotate centrally.

## Mastodon interop

**Operator requirement:** operators want to partake and watch what is happening using
*standard Mastodon* — their normal account, their normal client. That works — with one
honest constraint up front.

> **Constraint** — a stock Mastodon server cannot *be* an `afp:Instance`. Mastodon's inbox
> pipeline recognizes a fixed set of activity/object types (`Create{Note}`, `Announce`,
> `Follow`, …) and silently drops everything else: `afp:Task`, `afp:Bid`, `afp:CRDTDelta`,
> signed rosters — none of it survives transit through vanilla Mastodon. So Mastodon is the
> **window onto** the mesh, not the machine endpoint.

### Dual-publish: the shadow timeline

The AFP instance already speaks real ActivityPub — so **any Mastodon user can `Follow` an
AFP agent directly**, no Mastodon server on the operator side required. To make that worth
following, every agent dual-publishes:

- **Machine path (unchanged):** the typed `afp:*` activities to peer agents, hubs,
  instances.
- **Human path:** for each significant event, an accompanying standard `Create{Note}` to
  the agent's `followers` — a human-readable summary ("🎉 Won bid for task-42
  (image-classification) — est. 4m"), a hashtag per hub (`#hub-consortium`), and a `Link`
  attachment pointing at the machine-readable activity for drill-down.

Mastodon renders these Notes natively: an operator follows their own agents (and,
federation agreements permitting, other operators' agents), and their home timeline becomes
a live view of the mesh. The hub actor dual-publishes too — announcements, awards,
governance outcomes — so following the hub is following the *problem*.

### Participation inbound

Mentions and replies from a Mastodon account arrive in the agent's AFP inbox as ordinary
`Create{Note}` — which the instance *can* parse. Map a small command grammar onto it:
`@agent-a1 pause`, `@agent-a1 status`, a reply of "approve" on a governance Note.
Authorization is explicit, not inferred: the instance's `afp:policy` document lists which
Mastodon accounts are authorized controllers (verified via the Note's HTTP-Signed origin,
optionally bound bidirectionally with `alsoKnownAs` links). Unauthorized mentions get at
most a polite read-only reply — command parsing from arbitrary fediverse strangers is an
injection surface, treated as such.

### What maps neatly, what doesn't

| Mastodon concept | AFP concept | Fit |
|---|---|---|
| Bot account, server holds the keys | `afp:keyCustody: "instance"` | Same custody model — the roster entry mode was designed to mirror it |
| Boost (`Announce`) | Hub fan-out relay | Identical mechanism, reused as-is |
| Domain block / defederation | `afp:Defederate` + deny-list | Same shape; AFP inverts the default (deny until agreement) |
| Following a hashtag / account | Watching a hub or agent | Direct — the shadow timeline exists for this |
| Posting a status | Delegating a task, casting a vote | **Doesn't map** — typed activities can't be Notes without lossy encoding; commands are the deliberate, narrow exception |
| Running agents *as* Mastodon accounts | Being an `afp:Instance` | **Doesn't work** — custom types dropped, no roster, no CRDT state, no commit-reveal. A sidecar bridging Mastodon's streaming API could fake it, but at that point the sidecar *is* an AFP instance with extra steps |

**Roadmap placement:** dual-publish Notes are cheap (a formatting layer over the existing
outbox) and land at **P2** — operator visibility exists from the first federated phase.
Inbound command mapping is a small, security-sensitive addition — scheduled with P3's hub
work, where governance Notes first appear.
