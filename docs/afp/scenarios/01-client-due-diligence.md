# Scenario 01 — Agentic due diligence on a new client

> Spec-test scenario. Exercises: solo profile, hub-per-case scoping, direct delegation,
> deadlines, rationale externalization, L0 weighted voting, `afp:DecisionRecord`,
> Mastodon human-in-the-loop, audit replay. Verdict at the end.

| **Support status** | **Supported — 3 findings open (campaign 11, the re-walk)** |
|---|---|
| Findings raised | 3 · closed + 3 · open |
| Resolved by | spec v3.4 — [07 Audience & visibility](../07-visibility-and-artifacts.md), [03 External systems](../03-coordination.md) |
| See it run | `npm run demo:offline` |
| Gated by | `gate.test.ts`, `adr0029.test.ts` |

**Read the walkthrough below as history.** It records what strained when this workload was
first walked, and is deliberately left as written — that is what makes a scenario evidence
rather than a brochure. Every strain it names is now built; the
[support index](README.md#is-this-workload-supported) is the current-status view, and the
ledger there names the decision that closed each finding.


## User story

**As** the managing partner of an IT consultancy,
**I want** an agent swarm to run structured due diligence on every prospective client —
registry, finances, sanctions, adverse media, conflicts of interest, security posture —
**so that** we onboard fast without skipping checks, every engagement decision is backed by
recorded evidence, and a compliance review years later can replay exactly who checked
what, when, and why we decided as we did.

## Cast

One `afp:Instance` (the firm's — solo profile, no federation), one short-lived hub per
prospect. All agents are `instance`-custody, in-process wiring.

| Actor | Capability | Data it touches |
|---|---|---|
| `case-manager` | Coordination, round proposer | — |
| `registry-agent` | `dd.registry` — company registry (CVR), ownership chain, UBOs | Public registries |
| `finance-agent` | `dd.finance` — annual reports, credit score | Public filings, credit bureau |
| `sanctions-agent` | `dd.sanctions` — sanctions/PEP screening of UBOs & directors | Screening lists |
| `media-agent` | `dd.adverse-media` — adverse media sweep | News/web |
| `conflicts-agent` | `dd.conflicts` — conflict-of-interest vs. current portfolio | **Internal CRM (sensitive)** |
| `security-agent` | `dd.secposture` — breach history, DNS/TLS hygiene of prospect | Public scans |
| Christian (partner) | Authorized controller | Via personal Mastodon account |

## Walkthrough

**1. Kickoff — human in, via Mastodon.**
Christian mentions the case manager from his Mastodon account:
`@case-manager@afp.firm.example start dd "Northgate Logistics A/S" CVR:44556677 deadline:3d`.
The instance's inbound command mapping (§21) verifies the sender against `afp:policy`'s
authorized-controllers list and converts the mention into a signed `Offer{Task}` to
`case-manager`.

**2. Case hub.**
`case-manager` spins up hub `dd-northgate-2026-08` — a route on the same instance
(§20, consortium of one) — and `afp:Enroll`s the six specialist agents with their
capabilities. Hub-per-case gives clean state scoping: the hub's CRDT + activity record
*is* the case file.

**3. Fan-out — direct delegation, not bidding.**
Each workstream target is known (one specialist per capability), so the degenerate flow
applies (§09): six direct `Offer{Task}`s, each with `afp:deadline` (72h), `afp:hub`
pointing at the case hub, and `correlationId` per workstream. No announce/bid ceremony —
exactly what the spec prescribes when the announcer already knows who should do the work.

**4. Evidence comes back as signed Results.**
Each agent returns `Create{afp:Result}` with its assessment in `content` (rationale
externalization, §16) and evidence as attachments — registry extract, screening report,
media hits. Two notable returns:

- `sanctions-agent`: no direct hits, but one UBO traces to a holding company in a
  jurisdiction with opaque ownership — flagged in the Result with `confidence: 0.7`.
- `media-agent`: two minor adverse items (a 2023 payment dispute, resolved). Result
  includes source URLs + content hashes of the fetched articles.
- `conflicts-agent`: no conflict with current portfolio. Its Result contains only the
  *conclusion*, not CRM contents.

Progress rides the shadow timeline throughout — Christian watches
`#dd-northgate-2026-08` in his Mastodon client as Notes arrive (§21).

**5. The recommendation vote.**
When all six Results (or their deadlines) land, `case-manager` proposes an L0 weighted
round (§8c) on the pinned voter set — snapshot of the six enrolled agents
(`afp:quorumSnapshot`, §13): *engage / engage-with-conditions / decline*. Each
`Create{Vote}` carries its rationale in `content`, referencing the voter's own Result by
id. Outcome: **engage-with-conditions** at weight 4.4 vs. 1.6 (conditions: prepayment
for the first phase; no data-processing work until a DPA is executed and the UBO chain is
clarified).

**6. Decision record.**
The round closes with `Create{afp:DecisionRecord}` (§16): outcome, snapshot hash, hashes
of all six counted votes, weight tally. Dual-published as a Note.

**7. The human decision.**
The recommendation is not the decision. Christian replies `approve` to the
DecisionRecord's shadow Note from his authorized account; the instance maps that to a
signed activity recording partner approval, referencing the DecisionRecord. The
engagement proceeds under the stated conditions.

**8. Two years later — compliance review.**
A client-vetting audit asks: was Northgate screened, by what process, on what evidence?
Replay from the case hub's records: enrollments (§13), six Tasks with deadlines, six
signed Results with evidence hashes, six votes with rationale, the DecisionRecord binding
outcome to counted votes, and the partner's signed approval. Outbox hash chains
(`afp:prevActivity`) + chain heads anchored via shadow Notes federated to an external
Mastodon server (§16) make the record's completeness checkable — the firm can show the
trail wasn't pruned after the fact.

**Growth path (out of scope here, supported by the spec):** if the firm later contracts a
specialized KYC provider running their own agents, that's a `FederationAgreement` + the
provider enrolling their screening agent into case hubs — same flows, now cross-operator,
with L1 voting and LD-Signatures activating per the federated profile.

## Acceptance criteria → spec mapping

| Criterion | Spec mechanism |
|---|---|
| Kickoff and approval by a human, from a normal client app | §21 inbound command mapping, authorized controllers |
| Every check has an owner, a deadline, and a recorded outcome | §07 Task/deadline, §16 Results as evidence |
| Case isolation — one prospect's data never bleeds into another's state | §05 hub-per-case scoping, `(hubId, crdtType)` keys |
| Recommendation is multi-agent, weighted, and attributable | §8c L0 round, §13 snapshot + weights |
| Decision is a recorded artifact bound to its evidence | §16 `afp:DecisionRecord` + `countedVotes` |
| Human approval is distinct from agent recommendation | §21 command mapping; approval references DecisionRecord |
| Full replay under audit, completeness checkable | §16 hash chains + external anchoring |

## Spec verdict

**Held.** Solo profile, hub-per-case, direct delegation, deadlines, rationale
externalization, DecisionRecord, Mastodon HITL, audit replay — the scenario runs on
existing machinery end to end. Notably, the §09 rule "bidding only when the target is
unknown" correctly kept ceremony out of all six workstreams.

**Strained — three findings:**

1. **Confidentiality is unspecified (the big one).** The spec is strong on integrity and
   authenticity but silent on *read-side access control*. Outboxes are described as
   "independently auditable by anyone who can fetch it"; DD Results contain client PII,
   financials, and screening outcomes, and `conflicts-agent` touches internal CRM data.
   Solo profile masks this (everything is inside one trust domain), but the growth path —
   a federated KYC provider — makes it acute: AP addressing (`to`/`cc`) implies audience,
   but the spec never states visibility rules for outbox reads, hub state reads, or what
   an auditor may fetch vs. a stranger. **Needs a section: audience & visibility.**
2. **Hub lifecycle is unspecified.** Hubs-per-case means many short-lived hubs. The spec
   covers creation and enrollment but has no close/archive semantics — when is a hub
   read-only? What's the canonical "case file export"? A closing activity (e.g.,
   `afp:Archive` referencing the final DecisionRecord and a state snapshot hash) would
   pin the case file.
3. **External-evidence attestation is only implicit.** `media-agent` hashing fetched
   articles was invented by the scenario, not required by the spec. The rationale
   convention (§16) should extend: Results whose evidence is fetched from external
   sources SHOULD attach source URL + content hash + fetch timestamp, so evidence
   provenance doesn't stop at "the agent said so."

## Coverage as of 2026-09-13

This is ADR-0030 Decision 1's coverage section. None of this scenario's criteria are demonstrated by a demo running this scenario's own six-agent, Mastodon-driven due-diligence workload — `demo:offline` runs P1's generic draft/critique loop, not this shape — so most rows are mechanisms the ADR-0027/28/29 port work now gates rather than the workload itself; one row (audit replay) is generic enough that the export/verify machinery counts as demonstrating it, and hub-per-case isolation is narrower than tested.

| Criterion | Class | Evidence |
|---|---|---|
| Kickoff and approval by a human, from a normal client app | mechanism gated | `test/adr0029.test.ts` G3(c)/G3(e) — command mapping and approval built generically |
| Every check has an owner, a deadline, and a recorded outcome | mechanism gated | `test/gate.test.ts` case 8 — per-task context/correlationId, not six owners |
| Case isolation — one prospect's data never bleeds into another's state | narrowed | `test/hub.test.ts` enroll/tally test — hub keyed generically, no cross-case leakage test |
| Recommendation is multi-agent, weighted, and attributable | mechanism gated | `test/hub.test.ts` "enrolls agents, tallies a round, and rejects an out-of-snapshot vote" |
| Decision is a recorded artifact bound to its evidence | mechanism gated | `test/adr0010.test.ts` "afp:actsOn follows the DecisionRecord hop once, and never twice" |
| Human approval is distinct from agent recommendation | mechanism gated | `test/adr0029.test.ts` G3(c) — approve recorded as a distinct act from the panel's verdict |
| Full replay under audit, completeness checkable | workload demonstrated | `npm run demo:offline` · `test/gate.test.ts` it 10 — independent verifier passes export, fails four mutations |

**Counts:** 1 demonstrated · 5 gated · 1 narrowed · 0 not built.

## Coverage as of 2026-09-13 (re-walk)

ADR-0030 Decision 2's re-walk, against the surfaces ADR-0027, ADR-0028 and ADR-0029 actually
built. Christian's Mastodon mention still has nowhere to land: `ports/command.ts`'s
three-form grammar (`status`, `pause`, `approve`) is everything a mention or a signed
`POST /agents/:name/command` can do, and none of the three opens a case — kickoff would
still have to be a bespoke webhook route in `ports/webhook.ts`'s style, not the human
window this ADR trio built. The six-workstream fan-out and the L0 round are unchanged from
the first walk — `test/hub.test.ts`'s enroll/tally shape covers them exactly as before. The
recommendation vote closing into `Create{afp:DecisionRecord}` and Christian's `approve`
now has a concrete path: `POST /agents/case-manager/command` with body
`{"content": "@case-manager approve", "thread": "...", "actsOn": "<decision-record-digest>"}`,
checked against `AFP_CONTROLLERS` and run through `approveThroughPort`
(`test/adr0029.test.ts` G3(c)) — except the actuation this produces is authored by a
generic port agent (`actuatorName`), with Christian recorded only as `by`/`externalRef` on
the reconciliation, never as a rostered actor in his own right. And the two-years-later
audit still replays exactly as the first walk found — export and the independent
verifier, unchanged — with a second surface now sitting alongside it: `GET
/threads/:id/rendering` under an `afp:AuditGrant` (`test/adr0029.test.ts` G2) serves a
narrative naming the export bundle and a `verdict` string, but that string is read back
from a `VERDICT.json` the runtime never computes (`render/rendering.ts`'s
`bundleInfoFor`), so the rendering is honest only if a verifier run already happened in
the same session and wrote the file the reader is trusting — a limit on the rendering,
not on replay itself.

| Criterion | Class | Evidence |
|---|---|---|
| Kickoff and approval by a human, from a normal client app | narrowed | `test/adr0029.test.ts` G3(c) — narrowed to: approval is built and gated; kickoff has no verb in the three-form command grammar, so a case-opening mention still has no counterpart on the human-window surface (was: mechanism gated) |
| Every check has an owner, a deadline, and a recorded outcome | mechanism gated | `test/gate.test.ts` case 8 — per-task context/correlationId, not six owners (unchanged) |
| Case isolation — one prospect's data never bleeds into another's state | narrowed | `test/hub.test.ts` enroll/tally test — hub keyed generically, no cross-case leakage test (unchanged) |
| Recommendation is multi-agent, weighted, and attributable | mechanism gated | `test/hub.test.ts` "enrolls agents, tallies a round, and rejects an out-of-snapshot vote" (unchanged) |
| Decision is a recorded artifact bound to its evidence | mechanism gated | `test/adr0010.test.ts` "afp:actsOn follows the DecisionRecord hop once, and never twice" (unchanged) |
| Human approval is distinct from agent recommendation | narrowed | `test/adr0029.test.ts` G3(c) — narrowed to: approve is a distinct, recorded act, but its actor is a generic port agent with Christian carried only as `by`/`externalRef`, not his own rostered actor (was: mechanism gated) |
| Full replay under audit, completeness checkable | workload demonstrated | `npm run demo:offline` · `test/demos.test.ts` (bundle replays) · `test/gate.test.ts` — export replays under the independent verifier; the rendering surface's read-back verdict is finding 77, not a narrowing of replay (unchanged) |

**Findings raised:** 75, 76, 77 ([ledger](README.md#campaign-11--open-the-re-walk-of-01-02-06-and-09-under-adr-002700280029)).

**Counts:** 1 demonstrated · 3 gated · 3 narrowed · 0 not built.

## Coverage as of 2026-09-19 (after `task` joined the grammar)

Per ADR-0030 Decision 1. [ADR-0038](../adr/0038-the-operators-own-work.md) Decision 2 added
`task` as the fourth form of the command grammar — the kickoff verb the re-walk above found
missing. The counts do not move, for a reason worth stating rather than leaving a reader to
infer: Decision 3 refuses `task` on the mention carrier by a named branch, because a
`Create{Note}` is the one inbound shape a stock fediverse account can author, and under
instance custody it arrives signed by the sender's operator rather than the controller. This
scenario's criterion is kickoff *from a normal client app*, which is precisely the carrier
the build excluded. Only the kickoff row changes its evidence; every other row keeps the
prior section's class and evidence.

| Criterion | Class | Evidence |
|---|---|---|
| Kickoff and approval by a human, from a normal client app | narrowed | `test/adr0038.test.ts` (kickoff: `task` over `POST /agents/:name/command`, signed by the controller's own held key) · `test/adr0038-cli.test.ts` (`npm run task`) · `test/adr0029.test.ts` G3(c) (approval) — re-narrowed: the grammar now has a kickoff verb, but ADR-0038 Decision 3 refuses it on the mention carrier Christian actually uses; **was: narrowed, no kickoff verb at all** |
| Every check has an owner, a deadline, and a recorded outcome | mechanism gated | `test/gate.test.ts` case 8 — per-task context/correlationId, not six owners (unchanged) |
| Case isolation — one prospect's data never bleeds into another's state | narrowed | `test/hub.test.ts` enroll/tally test — hub keyed generically, no cross-case leakage test (unchanged) |
| Recommendation is multi-agent, weighted, and attributable | mechanism gated | `test/hub.test.ts` "enrolls agents, tallies a round, and rejects an out-of-snapshot vote" (unchanged) |
| Decision is a recorded artifact bound to its evidence | mechanism gated | `test/adr0010.test.ts` "afp:actsOn follows the DecisionRecord hop once, and never twice" (unchanged) |
| Human approval is distinct from agent recommendation | narrowed | `test/adr0029.test.ts` G3(c) — approve is a distinct, recorded act, but its actor is a generic port agent with Christian carried only as `by`/`externalRef` (unchanged; finding 76, closed as deliberate under ADR-0033) |
| Full replay under audit, completeness checkable | workload demonstrated | `npm run demo:offline` · `test/demos.test.ts` (bundle replays) · `test/gate.test.ts` — export replays under the independent verifier; the rendering surface's read-back verdict is finding 77 (unchanged) |

**Counts:** 1 demonstrated · 3 gated · 3 narrowed · 0 not built.

**Findings:** 75 narrows here rather than closing — the grammar gained its verb, the
mention carrier did not. 77 unchanged and open; 76 closed under ADR-0033
([ledger](README.md#campaign-11--open-the-re-walk-of-01-02-06-and-09-under-adr-002700280029)).
