# Scenario 02 — Observability-to-fix pipeline

> Spec-test scenario. Exercises: standing (non-case) hubs, the ports/adapters boundary
> against external systems, bidding as specialist selection, multi-step pipelines,
> DecisionRecord as a risk gate, ContributionSummary as an ops report, audit replay of an
> incident. Provider-agnostic throughout — no tracker or repo-host product named, by
> design. Verdict at the end.

| **Support status** | **Supported — 2 findings open (campaign 11, the re-walk)** |
|---|---|
| Findings raised | 3 · closed + 2 · open |
| Resolved by | spec v3.4 — the `correlationId`/`context` split and the port boundary ([03](../03-coordination.md)) |
| See it run | `npm run demo:offline` · `npm run demo:p8` |
| Gated by | `gate.test.ts`, `adr0028.test.ts`, `adr0029.test.ts` |

**Read the walkthrough below as history.** It records what strained when this workload was
first walked, and is deliberately left as written — that is what makes a scenario evidence
rather than a brochure. Every strain it names is now built; the
[support index](README.md#is-this-workload-supported) is the current-status view, and the
ledger there names the decision that closed each finding.


## User story

**As** the operator of a software system,
**I want** an agent swarm that watches my observability signals, triages anomalies against
known issues in my bug tracker, analyzes the codebase, and proposes fix PRs in my
repository —
**so that** incidents move from signal to reviewed fix without me driving every step, and
every automated action is recorded, attributable, and replayable when I ask "why did this
change land?"

## Cast

One `afp:Instance` (solo profile), one **standing** hub `ops-myapp` — unlike scenario 01's
hub-per-case, this hub never closes; it accumulates incident threads. All agents
`instance`-custody except where noted.

| Actor | Capability | External system behind its port |
|---|---|---|
| `signal-agent` | `obs.watch` — anomaly detection | Metrics/logs/traces backend |
| `triage-agent` | `obs.triage` — dedupe, severity, known-issue matching | — |
| `tracker-agent` | `tracker.search`, `tracker.file` | Bug tracker (any) |
| `analysis-frontend` | `code.analyze` (UI code specialty) | Repo checkout |
| `analysis-backend` | `code.analyze` (services specialty) | Repo checkout |
| `verifier-agent` | `code.verify` — test execution in isolation | Sandbox runner |
| `repo-agent` | `repo.propose-change` | Repository host (any) |
| Christian (operator) | Authorized controller; follows `#ops-myapp` | Via Mastodon |

**Provider-agnosticism falls out of the architecture, not out of effort:** the tracker and
repo host live entirely *behind* `tracker-agent`'s and `repo-agent`'s ports (§03). What
crosses agent-to-agent is neutral, typed AFP objects — a search Task, a Result carrying a
diff hash — never a provider API shape. Swapping trackers is an adapter change inside one
agent's brain; no other agent notices.

## Walkthrough

**1. Telemetry stays behind the port.**
`signal-agent`'s brain subscribes to the metrics/log stream via its adapter and
aggregates. The firehose never becomes activities — only a *detected anomaly* crosses the
port as a signed activity. (AFP is a coordination protocol, not a telemetry bus; modeling
every datapoint as an activity would be an anti-pattern.)

**2. An incident is born.**
p95 latency spike + error burst in the checkout service. `signal-agent` emits
`Offer{Task}` to `triage-agent`: capability `obs.triage`, evidence attachment (metric
snapshot + the query that produced it, content-hashed), deadline 15m. The activity sets
AS2 **`context: "urn:afp:incident:inc-4471"`** — the incident thread id that every
subsequent activity in this pipeline will carry. (`correlationId` stays per-task-unique;
see verdict, finding 3.)

**3. Known-issue matching.**
`triage-agent` delegates `Offer{Task tracker.search}` with the anomaly signature.
`tracker-agent`'s Result: nearest known issue matches at confidence 0.62 — related but
not identical. Triage classifies: new incident, severity high, fix-worthy, links the
tracker reference (opaque provider URL + record hash) into its Result.

**4. Specialist selection — bidding earns its keep.**
Two analysis agents share `code.analyze`. Triage doesn't know which fits, so this is the
non-degenerate case (§09): `afp:Announce{Task}` to the hub, commit-reveal window of 60s,
both bid with `capabilityMatch` against the anomaly's service path. `analysis-backend`
wins (0.91 vs 0.34); `afp:Award` is recorded and independently checkable against the
published scoring function. Solo-profile bidding is exactly the load-balancing/routing
scheduler §20 promised.

**5. Analysis and patch.**
`analysis-backend`'s brain checks out the repo via its adapter, localizes the fault (a
connection-pool exhaustion under retry storms), produces a patch. Its Result carries: the
diff as an attachment with content hash, affected-files list, rationale in `content`, and
`context: inc-4471`. Pipeline steps 2→5 carry `afp:seq` (§14) so a delayed Result can't
be applied out of order.

**6. Verification before proposal.**
`Offer{Task code.verify}` to `verifier-agent`: run the test suite + a reproduction probe
against the patched build, in isolation (§18's sandboxing posture applies even
intra-trust-domain). Result: tests pass, reproduction no longer fires; evidence = test
log hash. On failure, triage would emit `afp:Reauction` — next-ranked analyst gets the
task, failed bidder's estimate accuracy takes the reputation hit (§09).

**7. Risk gate — DecisionRecord reused.**
Policy: patches touching payment/checkout paths need a recorded go/no-go before any PR.
`triage-agent` proposes a 3-voter L0 round (triage, analysis-backend, verifier — pinned
snapshot): *propose-PR / hold*. 2.6 : 0.4 for propose. The round closes with
`afp:DecisionRecord` binding the go-decision to the patch hash and verification evidence.
Low-risk paths skip the vote by policy — the gate is proportionate, not ceremonial.

**8. The PR — an external action, reconciled.**
`Offer{Task repo.propose-change}` to `repo-agent`, which opens a branch + PR via its
adapter. Its Result records: branch name, PR reference (opaque provider URL), diff hash,
tracker cross-reference. `tracker-agent` files/updates the issue with the same
cross-links. **The merge decision happens outside AFP** — in the repo host's normal
review flow, by a human. When it lands (or is rejected), `repo-agent` *observes* that via
its adapter and emits a closing `Result` into the thread: outcome, merge commit hash,
reviewer identity as reported by the host. The AFP trail closes even though the final
action executed elsewhere.

**9. Operator's view, throughout.**
Christian's Mastodon timeline (`#ops-myapp`): anomaly Note → triage verdict → award →
"PR proposed" with link → "merged." He can interject at any point from his authorized
account: `@signal-agent mute checkout-latency 2h`, or reply `hold` on the risk-gate Note.

**10. The ops report is free.**
The weekly hub `afp:ContributionSummary` doubles as the ops report: anomalies triaged,
incidents opened, PRs proposed/merged per agent, estimate accuracy — recomputable from
the signed record, not hand-assembled.

**Audit replay:** "why did this change land?" → follow `context: inc-4471`: signal
evidence → triage classification → known-issue match → bid/award → patch + rationale →
verification evidence → DecisionRecord → PR reference → observed merge. Every hop signed,
hash-chained (§16), threaded by one incident id.

## Acceptance criteria → spec mapping

| Criterion | Spec mechanism |
|---|---|
| Only significant signals become protocol traffic | §03 ports boundary — telemetry aggregates behind the port |
| Provider-agnostic tracker/repo integration | §03 adapters; neutral typed objects cross agents |
| Right specialist per fix, no static routing | §09 announce/bid/award, §20 solo bidding |
| Risky changes gated by a recorded decision | §8c + §16 DecisionRecord as policy-triggered risk gate |
| No unreviewed code lands | PR-not-merge autonomy split; merge stays in host review |
| External outcomes appear in the trail | Port-agent reconciliation Results (verdict, finding 1) |
| Incident fully replayable end to end | AS2 `context` threading + §16 chains |
| Ongoing ops reporting without extra work | §15 ContributionSummary on a standing hub |

## Spec verdict

**Held.** The ports/adapters boundary (§03) is what makes provider-agnosticism free — the
scenario needed zero provider-shaped vocabulary. Standing hubs, bidding-as-routing,
deadlines/Reauction, causal ordering, the DecisionRecord risk gate, ContributionSummary
as ops report: all existing machinery.

**Strained — three findings:**

1. **External action reconciliation needs to be a stated convention.** For side effects
   executed in external systems (PR opened, merged, issue filed), AFP records the
   proposal and the artifact hash — but the *authoritative outcome* lives outside. The
   trail only closes because this scenario made `repo-agent` emit follow-up Results
   reflecting observed external state. The spec should require it: port agents MUST
   reconcile observed external outcomes back into the thread (external ref + hash +
   observation timestamp). Generalizes scenario 01's finding 3 from fetched *evidence* to
   executed *actions*.
2. **The telemetry anti-pattern should be stated.** AFP is a coordination protocol, not
   an event bus — high-frequency signals belong behind the port, aggregated by the brain,
   with only decisions-worthy events crossing as activities. Obvious once said; the spec
   never says it, and someone will pipe a log stream into an inbox.
3. **`correlationId` is overloaded — real inconsistency found.** The reliability table
   uses `correlationId` as the *task-unique* dedupe/replay key ("an agent already holding
   it replays its cached Result"), but multi-task workflows need a *shared* thread id —
   two different tasks in incident inc-4471 must not collide on the dedupe key. Fix is
   cheap and standard: keep `afp:correlationId` strictly per-task, and adopt AS2's native
   **`context`** property (which exists precisely for grouping related activities) as the
   thread/incident id. No new vocabulary needed — but the spec must say it, because
   scenario 01 informally used `correlationId` per workstream while this scenario needed
   a thread id spanning seven tasks.

## Coverage as of 2026-09-13

This is ADR-0030 Decision 1's coverage section. ADR-0028's `demo:p8` runs this scenario's pipeline shape almost directly — webhook ingestion, sealed bidding for the specialist, pinned action policy, PR opened on a fake forge, reconciliation, crash/retry idempotence, and merge refused by contract — so five of eight criteria are workload-demonstrated; the risk-gate vote and the "only significant signals" filter are judgement the port/brain makes with no protocol check on it, and ContributionSummary is gated but not exercised by `p8`.

| Criterion | Class | Evidence |
|---|---|---|
| Only significant signals become protocol traffic | edge not built | the aggregation/anomaly threshold lives in the signal agent's own adapter logic, with no AFP mechanism checking what counts as "significant" |
| Provider-agnostic tracker/repo integration | workload demonstrated | `npm run demo:p8` · `test/adr0028.test.ts` G3 — actuation completes against the fake forge behind the port, adapter swappable |
| Right specialist per fix, no static routing | workload demonstrated | `npm run demo:p8` · `test/adr0028.test.ts` G1/G8 — sealed bid, award, exported and replayed |
| Risky changes gated by a recorded decision | narrowed | `test/adr0028.test.ts` demo:p8 pins an `afp:actionPolicy`, not a voted `DecisionRecord` risk gate for risky paths |
| No unreviewed code lands | workload demonstrated | `npm run demo:p8` · `test/adr0028.test.ts` G6 — merge refused by contract, recorded, never reaches the forge |
| External outcomes appear in the trail | workload demonstrated | `npm run demo:p8` · `test/adr0028.test.ts` G3/G4 — reconciliation Result, crash-then-retry stays idempotent |
| Incident fully replayable end to end | workload demonstrated | `npm run demo:p8` · `test/adr0028.test.ts` G8/G9 — exported bundle replays clean, mutation fails by name |
| Ongoing ops reporting without extra work | mechanism gated | `test/adr0022.test.ts` — ContributionSummary built and gated, not produced by `demo:p8` |

**Counts:** 5 demonstrated · 1 gated · 1 narrowed · 1 not built.

## Coverage as of 2026-09-13 (re-walk)

ADR-0030 Decision 2's re-walk. `npm run demo:p8` still carries five of eight criteria
end to end — its header runs this scenario's pipeline shape directly: `ports/webhook.ts`'s
initiator for the anomaly/tracker step, sealed bidding for `analysis-backend`, the pinned
action policy opening a pull request on the fake forge, and `repo-agent`'s reconciliation
Result. Two things the re-walk surfaces that the first pass did not reach because it
predates the port build. First: `instance.actuate` is a P1-level call that never consults
the hub's role registry — `forge-out`'s `actuator` enrollment in `demoP8.ts` is the
record's own account of who acted, not what admitted the act, exactly as ADR-0028's own
build notes say; the risk-gate vote this scenario wanted (step 7, a 3-voter L0 round) would
close through `test/hub.test.ts`'s machinery, but nothing ties the round's outcome to
`instance.actuate`'s admission the way the pinned `afp:actionPolicy` does. Second: step 9's
`@signal-agent mute checkout-latency 2h` assumed a timed, reversible mute — the built
`pause` verb (`ports/command.ts`, ADR-0029 Decision 2) takes no duration and the grammar
has no `resume`; `AfpInstance.resumeAgent` exists only for the operator's own program, not
for a command a mention or a signed POST can reach, so the two-hour mute Christian sends in
the walkthrough has nowhere to land as written.

| Criterion | Class | Evidence |
|---|---|---|
| Only significant signals become protocol traffic | edge not built | the aggregation/anomaly threshold lives in the signal agent's own adapter logic (unchanged) |
| Provider-agnostic tracker/repo integration | workload demonstrated | `npm run demo:p8` · `test/adr0028.test.ts` G3 (unchanged) |
| Right specialist per fix, no static routing | workload demonstrated | `npm run demo:p8` · `test/adr0028.test.ts` G1/G8 (unchanged) |
| Risky changes gated by a recorded decision | narrowed | `test/adr0028.test.ts` demo:p8 pins an `afp:actionPolicy`, not a voted `DecisionRecord`; and `instance.actuate` admits by policy alone, never by consulting the hub role that recorded who actuated (was: narrowed — sharper now) |
| No unreviewed code lands | workload demonstrated | `npm run demo:p8` · `test/adr0028.test.ts` G6 (unchanged) |
| External outcomes appear in the trail | workload demonstrated | `npm run demo:p8` · `test/adr0028.test.ts` G3/G4 (unchanged) |
| Incident fully replayable end to end | workload demonstrated | `npm run demo:p8` · `test/adr0028.test.ts` G8/G9 (unchanged) |
| Ongoing ops reporting without extra work | mechanism gated | `test/adr0022.test.ts` — ContributionSummary built and gated, not produced by `demo:p8` (unchanged) |

**Findings raised:** 78, 79 ([ledger](README.md#campaign-11--open-the-re-walk-of-01-02-06-and-09-under-adr-002700280029)).

**Counts:** 5 demonstrated · 1 gated · 1 narrowed · 1 not built.
