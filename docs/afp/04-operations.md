# 04 — Accounting, audit, reliability, security, Mastodon interop

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
  "proof": { "type": "DataIntegrityProof", "cryptosuite": "eddsa-jcs-2022", "proofValue": "..." }
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

## Audit & provenance

Every coordination flow leaves a chain of evidence by construction — signed, immutable,
independently fetchable activities. Worked example: the 30-agent local policy swarm
reaching a decision. What an auditor asks, and the record that answers it:

| Audit question | Record |
|---|---|
| Who was eligible to vote, at what weight? | `afp:quorumSnapshot` + explicit voter list in the signed proposal; weights recomputable from liveness registers + the reputation `G-Set` of signed events |
| How did each voter join? | `afp:Enroll` activities, join-epoch-tagged in the membership OR-Set |
| Who voted, and what? | Signed `Create{Vote}` per voter outbox, correlated by round id; `afp:actingAs` attributes instance-custody votes to the specific agent |
| Is the vote set preserved? | `G-Set` of signed vote receipts in the hub CRDT, replicated to every participant |
| What was decided? | `afp:DecisionRecord` (below) |
| What was answered, and how sure were we? | `afp:Synthesis` — answer, method, contributing Results, assumptions, dissent |
| Did the estimate prove right? | `afp:Settlement`, if and when actuals exist |
| Human-readable trail? | Dual-publish shadow Notes, followable from Mastodon |

### Federated replay & lawful redaction (ADR-0009)

When an engagement spans trust domains, the audit takes **every party's export at
once** and stays one verifier: N single-domain replays — each bundle answering for its
own roster, every finding labelled with its domain — plus a cross-check over the set.
Three rules carry the join:

- **Authority is partitioned by `afp:operatedBy`.** The keys that verify a domain's
  actors are believed only from that domain's own export. A copy of the counterparty's
  actor document found in the other bundle is evidence it was fetched, never authority
  — else one operator smuggles forged keys and re-signs "received" history.
- **The agreement must be digest-equal in every party's bundle.** Each side's signed
  `Create{afp:FederationAgreement}` wraps the byte-identical object; a pair of exports
  whose agreements differ is not one engagement but two stories.
- **A received activity must be the same bytes its sender recorded.** Each bundle
  carries what crossed its boundary inbound (`received.jsonld`), and every entry must
  resolve by digest to the same activity in the sender's export — a mismatch is a
  named divergence, an absence is attributed to the sender. Obligation this creates:
  **store what you verified, not a re-serialization.**

Lawful redaction is an **export-time transform** — the record is never mutated, an
export is a view of it. A scoped export replaces each withheld activity, 1:1, with a
digest-only stub in chain position:

```json
{ "type": "afp:Redacted", "afp:digest": "sha256:…", "afp:visibility": "internal" }
```

The chain check accepts a stub as a link (the neighbours' digests must agree with what
it declares), and the chain-wide `published` monotonicity backstop brackets across stub
runs. The manifest's `afp:exportScope` declares the threads the bundle answers for and
the roster entries it deliberately omits; completeness checks the declared scope. An
undeclared gap remains what it always was — tampering. The line this draws is the
point: **discretion is declared; deletion is detected.**

### Decision records (`afp:DecisionRecord`)

Every voting round — L0 or L1 — closes with a first-class outcome artifact. Without it, an
L0 outcome is *derivable* (recompute the tally from the vote set) but never *recorded*.
The proposer emits it; participants MAY co-sign by `Accept`-ing it, and any verifier can
check it by recomputing the tally over the referenced votes:

```json
{
  "@context": ["https://www.w3.org/ns/activitystreams", "https://afp.example/ns/v3"],
  "id": "https://hub.local/rounds/round-42/decision",
  "type": "afp:DecisionRecord",
  "afp:hub": "https://hub.local/actor",
  "afp:round": "urn:afp:round:42",
  "afp:outcome": "policy-candidate-7",
  "afp:quorumSnapshot": "sha256:mem-4a71c9...",
  "afp:countedVotes": ["sha256:vote-a01...", "sha256:vote-a02...", "..."],
  "afp:weightTally": { "policy-candidate-7": 21.5, "policy-candidate-2": 6.0, "abstain": 2.5 },
  "attributedTo": "https://hub.local/agents/proposer",
  "proof": { "type": "DataIntegrityProof", "cryptosuite": "eddsa-jcs-2022", "proofValue": "..." }
}
```

At L1 the DecisionRecord embeds or references the 2f+1 commit certificate; at L0 it *is*
the closing artifact. Either way, `afp:countedVotes` (hashes of every counted signed vote)
binds the outcome to its exact evidence set.

### Synthesis: answers that are not decisions

`afp:DecisionRecord` answers *"what did we decide"* — a discrete outcome selected by
votes. Some tasks instead produce *"what do we know, and how sure are we"*: an estimate, a
forecast, an assessment, assembled from several agents' partial answers. Collapsing that
into a single figure destroys the uncertainty and disagreement a requester most needs.

`afp:Synthesis` is the artifact for those. It is emitted by **the synthesizer the record
names** — derived from the Award where an auction ran (03 — Selection rules), or pinned
as `afp:synthesizer` on the task-bearing activity where none did (ADR-0010) — and binds
the answer to its inputs. A Synthesis from any other actor fails replay by name; a
mandate held only in configuration is the claim-without-a-record the roster machinery
exists to prevent, and it should not become admissible merely because the deployment
skipped an auction it was told to skip.

Where the thread's governing pins include an `afp:actionPolicy` (ADR-0006), the Synthesis
MUST also carry `afp:category` — one of the policy's keys — because downstream *actions*
are checked against `policy[category]`, and an answer outside the closed set would
constrain nothing. One key is always available: the reserved `afp:no-verdict`, for the
panel that could not answer. Answering short of the pinned `afp:answerSufficiency` is
permitted only under that category, and only with the missing legs declared in
`afp:absentInputs` — a partial answer is a stated one, never a quiet one.

The activity that then acts on the answer hash-binds itself to it (`afp:actsOn`,
`afp:action`) — naming either the Synthesis or, where a round ratified it, the
`DecisionRecord` whose `afp:outcome` names it, which the verifier follows in exactly one
hop. So a replay can ask of any consequence: was this what the answer permitted? Its
fields:

```json
{
  "type": "afp:Synthesis",
  "context": "urn:afp:question:q-88",
  "afp:method": "sum-of-disjoint-ranges",
  "afp:answer": { "unit": "kDKK", "low": 9000, "high": 11700 },
  "afp:confidence": 72,
  "afp:contributingResults": ["sha256:res-a-infra-rev2...", "sha256:res-a-data...",
                              "sha256:res-b-compliance...", "sha256:res-b-licensing..."],
  "afp:assumptions": ["dual-run parallel period", "network segmentation contains PCI scope"],
  "afp:dissent": [{ "actor": "https://bravo.example/agents/b-licensing",
                    "summary": "Q3 deadline unachievable at any cost: 14-week licensing lead time",
                    "result": "sha256:res-b-licensing-feasibility..." }],
  "afp:supersededInputs": ["sha256:res-a-infra-rev1..."]
}
```

Required properties and why each exists:

| Property | Purpose |
|---|---|
| `afp:method` | Names the combination performed (sum of disjoint parts, median, weighted mean, negotiated) so the arithmetic is independently checkable |
| `afp:contributingResults` | Hashes of every input Result — binds the answer to its exact evidence, as `countedVotes` does for decisions |
| `afp:assumptions` | The premises the answer rests on; two partial answers built on contradictory assumptions must be reconciled before combination, not summed |
| `afp:dissent` | **First-class, never a footnote.** An objection that cannot be expressed numerically — "infeasible at any price" — survives to the reader intact |
| `afp:supersededInputs` | Revisions made during reconciliation stay in the record rather than vanishing — **input-level** only: a Result was updated, the conclusion stands |
| `afp:supersedes` | **Answer-level** retraction (ADR-0007): the digest of the Synthesis activity this one withdraws. A ratified answer is superseded only by a ratified one — a quorum is not un-decided by a signature — and every activity that acted on the withdrawn answer (`afp:actsOn`, ADR-0006) must be disposed of on the record (`afp:disposes`, acting on the superseding answer). Supersession is an edge, never an erasure |
| `afp:absentInputs` | The legs that contributed no Result, declared rather than dropped — see 03 (ADR-0010) |

Two things the world imposes on that discipline (ADR-0011). **A consequence may not be
recallable.** Where the pinned `afp:irrevocableActions` names the action that was taken,
its disposition MAY be an `afp:disposition: "annotate"` — binding the withdrawn
justification to the standing consequence and commanding nothing. The disposition duty is
unchanged; what changes is that the honest answer *"we cannot undo this, and here is the
record saying so"* can now satisfy it, where before only a re-actuation could. Annotation
is available only where irreversibility was declared in advance, by someone who did not
yet know they would want it.

**And the panel may have changed.** A `DecisionRecord` ratifying a superseding Synthesis
carries `afp:priorQuorumSnapshot`, the electorate of the ratification it overturns — so a
re-decision by the same panel and one by a materially different panel stop being
indistinguishable. What that difference *means* is hub policy, not protocol; the record's
job is that it shows. It also settles who may answer a thread after the panel moves: the
pinned `afp:synthesizer` (ADR-0010) binds every Synthesis on the thread **unless the
superseding one is ratified**, where the convened quorum is the stronger authority — an
unratified answer keeps its pin, or anyone could supersede by being someone else.

Synthesis and DecisionRecord are complementary, not alternatives. Because a synthesizer
exercises discretion — choosing a method, adjudicating conflicting assumptions — hub
policy MAY require a ratification round whose `DecisionRecord` references the Synthesis
and records the split. Dissent recorded in the Synthesis SHOULD travel with the answer all
the way to any human notification (07/Mastodon), not be summarized away en route.

### Settlement: scoring answers that cannot be verified yet

§09's reputation feedback compares a bidder's estimates against actuals — which assumes
actuals arrive promptly. For estimation and forecasting they arrive months later, or
never. Estimates therefore enter an explicit **unsettled** state: they neither credit nor
penalize reputation until evidence exists.

`afp:Settlement` closes the loop when it does: it references the original estimate(s) or
Synthesis, records the observed actuals with their evidence, and releases the reputation
adjustment. Where a recorded dissent proves correct, settlement SHOULD raise the
dissenter's standing — a swarm that penalizes accurate minority objections will stop
producing them, which is the failure mode the `afp:dissent` field exists to prevent.

Unsettled forever is a legitimate terminal state: work that was never commissioned yields
no evidence, and inventing a score for it would be worse than leaving it open.

Settlements now have a recorded consumer (ADR-0004): an Announce may pin a named
reputation derivation plus an `afp:settlementSnapshot` — the digests of exactly the
settlements the score is computed over — so selection odds can reflect past accuracy
while the Award stays a pure function of the record
([03 — Consuming reputation, recomputably](03-coordination.md#consuming-reputation-recomputably)).
That consumer makes settlement's own preconditions load-bearing: a settlement **follows
an award** and is published **once per task**. Settling work nobody was awarded records
an outcome with nothing to settle, and a second settlement competes with the first for
the same snapshot — the exhaustive pinning that stops a hub cherry-picking history would
otherwise let a counterparty supply several accounts of what actually happened.

### Outbox integrity: hash-chained logs (`afp:prevActivity`)

Individually signed activities prove *authorship*, not *completeness* — omission of an
inconvenient activity from an outbox is silent. Optional, RECOMMENDED for audit-grade
deployments: a per-actor hash chain — each activity carries `afp:prevActivity`, the hash
of that actor's previous activity — making every outbox append-only-verifiable; a gap or
fork is detectable from the chain alone. (L1's `afp:observedVotes` already cross-references
votes within a round; the chain generalizes that protection to the whole log.)

**Solo-profile caveat, stated plainly:** one operator holds every key and every store.
Chained logs protect against bugs and accidental corruption, not against the operator
rewriting their own history. Audit-grade solo deployments should periodically **anchor
chain heads outside the trust domain**: write-once storage, a timestamping service, or
simply federating the shadow Notes (each carrying the current chain-head hash) to an
external Mastodon server.

### Rationale externalization (workflow convention)

Provenance stops at the agent–instance port: internal reasoning that led to a vote is not
captured. Where the audit requirement includes *why*, the workflow must externalize it —
convention, not machinery:

- Votes SHOULD carry a rationale in `content`.
- Policy evaluation SHOULD run as `Task`/`Result` pairs per candidate, so each agent's
  assessment becomes a signed `Result` entered into evidence *before* the vote.

### What closes the trail at the edges

Three conventions, each defined elsewhere, are what make a replay complete rather than
merely long. An audit that lacks them ends in "the agent said so":

| Edge | Requirement | Defined in |
|---|---|---|
| Evidence fetched from outside AFP | Attachment carries `afp:digest` + `afp:sourceUrl` + `afp:fetchedAt` | [07](07-visibility-and-artifacts.md#artifacts--attachments) |
| Side effects executed in external systems | Port agent MUST reconcile: follow-up Result with external ref, artifact hash, observation timestamp — and the effect itself carries an idempotency key derived from the `correlationId`, so a crash between acting and recording recovers by lookup, not retry | [03](03-coordination.md#external-systems-keep-the-firehose-behind-the-port) |
| Multi-task workflows | Threaded by AS2 `context`, never by reusing `correlationId` | [03](03-coordination.md#correlation-vs-threading--two-distinct-ids) |

### Signature is not authority

A valid signature proves *someone holding a published key* produced these bytes. It does not
prove that key was entitled to speak for the `actor` named in the activity. Those are
different questions, and a replay that only asks the first one can be fooled:

- **The tail of every chain is unprotected by the chain.** `afp:prevActivity` binds an
  activity to its predecessor, so altering a middle activity breaks the next link. The
  *last* activity in an actor's outbox has no successor to break — it rests on its
  signature alone. Re-sign it with any published key and a signature-only replay passes.
- **A missing participant leaves no gap.** Chains are per-actor. Delete an actor's outbox
  entirely and every surviving chain is still intact; nothing in the remaining record
  points at the hole.

The roster closes both, which is what it is *for*: it is the signed statement of which
agents exist and who may sign for each (`afp:keyCustody`). A replay that verifies the
roster's signature but never reads its contents has verified a document and then ignored it.

**Authority rule.** For every activity, the key that signed it MUST be authorized for its
`actor`:

| `afp:keyCustody` | Authorized signer | Additional requirement |
|---|---|---|
| `self` | The agent's own published key | — |
| `instance` | The key of the instance named in the agent's `afp:operatedBy` | `afp:actingAs` MUST equal `actor` |

An activity bearing a valid signature from a key with no authority over its actor is a
**forgery**, not a record, and MUST fail the replay.

### Replay procedure

1. **Resolve authority** from the signed roster and the actor documents: for each agent,
   which key may sign for it — and, where the manifest carries an `afp:keyHistory`, *which
   key was valid when* (below).
2. **Select** by `context`, ordering by `afp:seq` where present.
3. **Verify each activity**: its signature, *and* that the signing key was authorized for
   its `actor` under the rule above.
4. **Walk each actor's `afp:prevActivity` chain** — first activity starts it, every later
   one links to its predecessor's digest.
5. **Account for every rostered agent.** An agent on the roster with no outbox in the
   bundle is a missing participant.
6. **Verify attachment digests**, discarding bytes that do not match.
7. **Check the closing `DecisionRecord`'s `countedVotes`** against the votes present.

A gap in any chain, a digest mismatch, an activity signed by a key with no authority over
its actor, a rostered agent with no outbox, or a counted vote you cannot produce is a
failed audit.

### The manifest, and what a bundle contains (ADR-0012)

An export's manifest is a **signed document**, not a note attached to one: it carries the
export's self-description under the same `DataIntegrityProof` as everything else, so the
one part of a bundle that used to be freely editable no longer is.

- **`afp:keyHistory`** — every key that signed anything in the bundle, per actor, with its
  validity interval and how it left service (`afp:retiredBy: "rotation" | "revocation"`).
  A signature resolves against the key valid *at its `published` instant*, so a rotation
  stops stranding the corpus signed before it. An absent `afp:validFrom` means unbounded
  below — a first key's start was often never recorded, and inventing one would fail
  exactly the old exports this exists to keep verifiable. Intervals bind per key: a
  `verificationMethod` the history does not declare resolves from the actor documents as
  it always has.
- **`afp:members`** — every file the bundle contains, relative to its root. Checked both
  ways: an undeclared file is something that travelled without being admitted to, a
  declared-but-absent one is the hole ADR-0009 already names.
- **`afp:retentionDuty`** and **`afp:anchors`** — a declared duty (horizon and basis) and
  the external anchoring that backs it. Declaring the duty is what turns its obligations
  on; a verifier cannot know from bytes whether a statute applies. Anchors are checked for
  coherence — every anchored digest must be a chain head the bundle contains — and are
  never dereferenced: the verifier reaches no network by design, so confirming the
  timestamp itself is the auditor's step, not the replay's.

What a bundle contains is now exhaustive: instance document, roster, per-actor outboxes
(stubs included), hub outboxes, artifacts, received activities, manifest. **Hub CRDT state
is a projection and is not exported** — which makes a design rule out of what 02 already
implies: anything that must ever be disclosed, redacted, retained or replayed has to live
in activities, because activities are the only thing the export, the stub machinery and
the verifier can see. Subject content parked in application state sits where no audit view
can lawfully cut.

> **Found by building it.** Steps 1, 3 and 5 were absent from this procedure until a P1
> implementation was checked against it: a `Result` re-signed with a *different agent's*
> published key passed a full replay, as did a bundle with an entire agent's outbox
> deleted. Two independent implementations had agreed with each other — because both
> faithfully implemented an incomplete rule. Independent implementations catch coding
> mistakes, not specification mistakes.

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
- **Payload integrity across relays** — the `eddsa-jcs-2022` object-integrity proof every
  activity has carried since P1 *is* this requirement (ADR-0008: there is no second
  payload-signature suite); the HTTP-layer signature only authenticates the relaying
  hop. Load-bearing from roadmap P4 onward (P5 more so, when payloads start crossing a
  hub).
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

**Roadmap placement:** both land at **P4**, the phase where the instance first faces
anything outside itself — a peer instance and a human observer arrive through the same plain
ActivityPub door. Dual-publish Notes are cheap (a formatting layer over the existing outbox)
and, because publishing a Note to a follower needs no federation agreement, a solo
deployment MAY enable them earlier; carrying the current outbox chain head in each Note is
the cheapest external anchor available to an operator who holds every key
([04 — Outbox integrity](#outbox-integrity-hash-chained-logs-afpprevactivity)). Inbound
command mapping is the security-sensitive half and SHOULD NOT be pulled forward.
