# Scenario 03 — Two consultancies co-staffing a project

> Spec-test scenario. The first genuinely **federated** one: exercises
> FederationAgreement, two-tier trust, cross-operator hub governance, L1 voting,
> LD-Signatures, hub-relayed gossip, cross-operator bidding, contribution accounting as a
> billing substrate, equivocation rollup — and deliberately walks into the confidentiality
> and hub-lifecycle gaps found in scenario 01. Verdict at the end.

| **Support status** | **Supported — all findings closed** |
|---|---|
| Findings raised | 4 + 2 recurring |
| Resolved by | spec v3.4, then [ADR-0005](../adr/0005-operators-are-equal.md) for per-operator weight |
| See it run | `npm run demo:p2` |
| Gated by | `hub.test.ts`, `adr0005.test.ts` |

**Read the walkthrough below as history.** It records what strained when this workload was
first walked, and is deliberately left as written — that is what makes a scenario evidence
rather than a brochure. Every strain it names is now built; the
[support index](README.md#is-this-workload-supported) is the current-status view, and the
ledger there names the decision that closed each finding.


## User story

**As** the managing partners of two consultancies (Alpha and Bravo) co-staffing project
*Nordbook* for a shared client,
**we want** our two agent workforces to divide responsibilities, run a common backlog,
build a shared knowledge base, do real joint work on the same tasks, and account for each
firm's contribution —
**so that** the project runs as one team across two companies, while each firm keeps its
own systems private, gets verifiable credit for its work, and can walk away cleanly when
the contract ends.

## Cast

Two `afp:Instance`s (Alpha and Bravo, each behind its own firewall), one shared hub
`proj-nordbook` hosted on Alpha's infrastructure. The client is **not** on AFP (growth
path: they could join later as an observer instance with a scoped agreement).

| Firm | Enrolled agents | Capabilities |
|---|---|---|
| Alpha | `a-backend-1`, `a-backend-2` | `impl.backend` |
| Alpha | `a-feedback` | `analysis.feedback` |
| Bravo | `b-spec-1`, `b-spec-2` | `spec.upstream`, `spec.api` |
| Bravo | `b-frontend` | `impl.frontend` |
| Both | partners | Authorized controllers via Mastodon, following `#proj-nordbook` |

## Walkthrough

**1. The handshake is the contract's shadow.**
`Offer{afp:FederationAgreement}` Alpha→Bravo: scoped to hub `proj-nordbook`, **expiry set
to the project contract's end date**. Bravo countersigns; the co-signed agreement lands in
both outboxes (§04). The agreement's scope/expiry mapping onto commercial contract terms
is exact — renewal is a re-sign, early exit is `afp:Defederate` (unilateral, advisory to
the hub).

**2. Hub governance with n=2.**
Alpha hosts the hub, but hosting confers no authority: the hub key signs transport only
(§05), and every `afp:GovernanceDecision` needs the member quorum — which at two instances
means **both firms**. Neither can outvote the other; deadlock resolves off-protocol
(commercially), which is honest for a two-party project.

**3. Division of responsibilities = capability-scoped enrollment.**
Each firm `afp:Enroll`s only the agents (and capabilities) it's responsible for. The hub's
capability registry *is* the responsibility matrix — machine-readable, signed, and
auditable. Rebalancing responsibilities mid-project is an Unenroll/Enroll pair, recorded.

**4. The common backlog is an application CRDT.**
Backlog = a hub-scoped CRDT store (`crdtId: "backlog"`): an `OR-Map<itemId,
LWW-Register<{status, assignee, priority}>>`. Both firms' agents mutate it via
`Update{afp:CRDTDelta}` — order-tolerant, merge-safe across the federation boundary,
synced by hub-relayed digest exchange (§12, the NAT-reality default). Each backlog item's
actual work is threaded by AS2 `context: "urn:afp:item:NB-217"`. The generic
`crdtId`/`crdtType` machinery (§11) accommodated an application-defined store without any
new protocol — though the spec only *enumerates* protocol-internal state types (see
verdict, finding 4).

**5. Upstream spec work + the shared knowledge repository.**
Bravo's spec agents produce design documents as `Create{Document}` / `Create{Article}` —
standard AS2 object types — into the hub, LD-signed (mandatory across the boundary, §06).
A CRDT index (`crdtId: "knowledge"`, OR-Map of tags → entry ids) makes the repository
navigable. Every entry is attributable and immutable; superseding a document is a new
version referencing the old, never an edit-in-place. *But*: the actual document blobs
have to live somewhere each firm can fetch — see verdict, finding 2.

**6. Cross-operator bidding — sealed bids between commercial rivals.**
Backlog item NB-231 ("payment reconciliation service") could go to Alpha's backend agents
or, partially, Bravo's frontend+spec pairing. It's announced (§09); commit-reveal matters
*more* here than solo — the bidders bill by the hour, and open bids would invite
positional undercutting between partners. `a-backend-1` wins on capability match; the
`afp:Award` is verifiable against the pre-published scoring function, so Bravo can check
the selection wasn't rigged. Estimate-vs-actual feedback accrues per agent, per hub —
which both firms can see.

**7. Real co-work: the ping-pong thread.**
The API contract between Bravo's spec side and Alpha's implementation is genuine joint
work, not divisible. AFP has no joint-assignee Task (single performer per
Offer/Accept/Result — verdict, finding 1), so the co-work pattern is **alternating small
tasks in one thread**: `b-spec-1` drafts the contract (`Result`, context NB-217) →
`a-backend-1` implements against it and returns friction points (`Result`, same context)
→ `b-spec-1` revises → `a-feedback` validates the revision against user-feedback analysis
→ converged. Every hop is signed and attributed to exactly one agent, so contribution
accounting stays exact — like pair programming where each commit still has an author. The
thread *is* the co-work record.

**8. Decisions that cross the boundary run L1.**
A breaking-change decision on the public API (affects both firms' deliverables) runs an
L1 round (§10) across four voters, two per firm, pinned membership snapshot. Honest
precision for n=2 operators: **L1 here buys accountability, not tolerance** — with two
operators there is no honest majority to outvote a dishonest one; what you get is that
misbehavior produces portable cryptographic proof (see step 10). The round closes with an
`afp:DecisionRecord` referencing the RFC document in the knowledge repo.

**9. Contribution accounting becomes the invoice substrate.**
The weekly hub `afp:ContributionSummary` (§15) — tasks completed per firm, per
capability, with L1-certificate evidence — is independently recomputable by both sides.
Alpha's invoice references the summary id; when Bravo's ops disputes one week's count
(`afp:ContributionDispute`: an omitted `b-frontend` result), the recount is mechanical —
recompute over the same public inputs, republish corrected. No argument about who did
what, ever, because the ledger *is* the work record. (Pricing stays off-protocol, per
§15's scope line.)

**10. Misbehavior drill — the rollup works commercially.**
During a scheduling vote, a misconfigured Bravo agent equivocates (different votes to
different peers). Two Alpha agents produce the `afp:EquivocationProof` (§10); the agent's
vote weight zeroes **automatically** everywhere. The instance-level consequence is *not*
automatic (§04): before any governance action, Bravo self-issues `afp:Disown` on the
misbehaving agent and re-enrolls a fixed one — voluntary remediation heads off forced
action, the incident is on the record, and the partnership continues without drama.
Exactly the escalation ladder §04 designed.

**11. Project end.**
The FederationAgreement expires on contract end; the trust gate starts hard-rejecting at
the instance tier — no revocation ceremony needed. Each firm retains its own signed
outboxes and a full replica of hub state (CRDTs + threads) as its project archive; the
final ContributionSummary anchors the commercial close-out. What the spec *lacks* is a
formal hub archival act — scenario 01's lifecycle finding, now with contractual force
(verdict, recurring).

## Acceptance criteria → spec mapping

| Criterion | Spec mechanism |
|---|---|
| Trust bounded by the commercial contract | §04 FederationAgreement scope + expiry |
| Neither firm can dominate shared governance | §05 hub-key-signs-transport-only + member quorum |
| Responsibility split is explicit and auditable | §05 capability-scoped enrollment |
| One backlog, two firewalled firms | §11 app CRDT + §12 hub-relayed sync |
| Shared knowledge base, attributable and immutable | AS2 Document/Article + LD-Sigs + CRDT index |
| Contested tasks allocated fairly between rivals | §09 commit-reveal bidding, verifiable Award |
| Joint work with exact attribution | Ping-pong thread pattern (finding 1) |
| Cross-firm decisions accountable | §10 L1 + §16 DecisionRecord |
| Contribution == billing evidence | §15 ContributionSummary + dispute flow |
| Misbehavior handled without ending the partnership | §04 automatic weight-zeroing + governed rollup + Disown |

## Spec verdict

**Held.** The federation machinery earned its keep on first contact: agreement
scope/expiry mapped 1:1 onto contract terms; enrollment doubled as the responsibility
matrix; sealed bidding is *more* valuable between commercial parties than solo;
contribution accounting turned out to be the billing substrate; and the equivocation
ladder (automatic agent-level, governed instance-level, voluntary remediation) played out
exactly as designed.

**Strained — four new findings, two recurring:**

1. **Co-work is unmodeled.** Offer/Accept/Result assumes one performer. The ping-pong
   thread (alternating single-performer tasks in one AS2 `context`) works and keeps
   attribution exact — the spec should bless it as *the* co-work pattern, and note the
   AS2 escape hatch (`attributedTo` accepts an array) for genuinely joint Results, with a
   stated contribution-split convention if used.
2. **The blob/artifact layer is unspecified.** Spec examples attach `s3://` links —
   quietly assuming shared storage that doesn't exist across operators. Federated
   attachments need: each instance serves its own artifacts, hash-addressed, fetch
   authorized by the same two-tier gate as inboxes. Needs a section; the Link+hash
   convention is necessary but not sufficient.
3. **n=2 L1 needs a precision statement.** With two operators, Byzantine machinery
   provides *accountability* (portable proof of misbehavior) but not *tolerance* (no
   honest majority exists). The spec should state minimum operator counts for each
   guarantee so nobody reads "Byzantine-hardened" as more than it is at small n.
4. **Application-defined CRDT stores should be blessed explicitly.** The
   `crdtId`/`crdtType` machinery generalized to a backlog and a knowledge index without
   friction — but §11's text only enumerates protocol-internal state types. One paragraph
   fixes it.

**Recurring, now acute:**
- **Confidentiality / read-side visibility** (scenario 01, finding 1): each firm's
  internal data stays behind its port, but *hub* state and shadow Notes are visible to —
  whom, exactly? The agreement implies scope; the spec still has no visibility model.
  Cross-operator, this is no longer theoretical.
- **Hub lifecycle** (scenario 01, finding 2): contract end forces the question the spec
  doesn't answer — what formally freezes `proj-nordbook`, and what is the canonical
  archive both firms can rely on?

## Coverage as of 2026-09-13

This is ADR-0030 Decision 1's coverage section: it classifies each acceptance criterion
above against what actually runs, distinct from what the findings ledger marks closed.
`demo:p2` runs a single-instance, thirty-voter L0 round — it enrolls one flat set of
agents and closes a weighted-quorum round with a `DecisionRecord`, but it never
constructs the two firms/two-operator structure scenario 03's criteria are about, so no
row here reaches workload demonstrated. Federation, quorum weighting and misbehavior are
instead exercised end to end by the per-operator unit gates, and the joint-work
convention is narrower than the ping-pong pattern the walkthrough describes.

| Criterion | Class | Evidence |
|---|---|---|
| Trust bounded by the commercial contract | mechanism gated | `test/adr0005.test.ts` "a declared merger folds two seats into one operator's weight" — FederationAgreement scope, expiry |
| Neither firm can dominate shared governance | mechanism gated | `test/hub.test.ts` "enrolls agents, tallies a round" — weighted quorum round closes; `demo:p2` runs the round over one flat instance, not two firms, so the cross-firm dominance claim itself is not run |
| Responsibility split is explicit and auditable | mechanism gated | `test/hub.test.ts` "enforces roles: requester/observer never pinned or bidding" — capability-scoped enrollment |
| One backlog, two firewalled firms | mechanism gated | `test/crdt.test.ts` — generic OR-Map/CRDT delta merge, application-defined store |
| Shared knowledge base, attributable and immutable | mechanism gated | `test/crdt.test.ts` — same CRDT index machinery, no dedicated knowledge-repo demo |
| Contested tasks allocated fairly between rivals | mechanism gated | `test/allocation.test.ts` "rejects tampered reveals, out-of-window commits, strangers" — commit-reveal, verifiable Award |
| Joint work with exact attribution | narrowed | `test/adr0022.test.ts` "a co-authored Result with integer shares replays clean" — narrowed to: ordinary Offer/Result on one shared `context` carries the split, but no dedicated ping-pong or joint-assignee primitive |
| Cross-firm decisions accountable | mechanism gated | `test/adr0005.test.ts` "one agent weighs as much as three, when the three share an operator" — L1 round + DecisionRecord |
| Contribution == billing evidence | mechanism gated | `test/adr0022.test.ts` "a summary over a hub-observed period replays clean" — ContributionSummary + dispute flow |
| Misbehavior handled without ending the partnership | mechanism gated | `test/adr0021.test.ts` "an equivocator recused with its own proof as cause replays clean" — automatic weight-zeroing, governed recusal |

**Counts:** 0 demonstrated · 9 gated · 1 narrowed · 0 not built.
