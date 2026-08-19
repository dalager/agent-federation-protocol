# Scenario 05 — The integration practice: domain intelligence as an internal service

> Spec-test scenario. Exercises: a **standing single-operator instance serving other
> teams with domain intelligence** — shape/size/effort guidance on integrations the
> practice has built before — requester participation with narrow scope (untested until
> now), **reuse of concrete assets** (component repositories) across team boundaries,
> estimation grounded in the team's own replayable history, settlement on
> requester-reported actuals, and staffing as allocation.
> First scenario written *after* the P1–P3 reference implementation, so the mapping
> distinguishes "runs on the built stack today" from "needs a later phase." Verdict at
> the end.

## User story

**As** the lead of an IT consultancy's integration practice — a team with a portfolio of
integration projects across public registries, national identity services, GIS and
property records, messaging and iPaaS platforms —
**I want** a team-operated AFP instance whose agents cover every aspect of building and
running system integrations, with access to our component repositories and our project
history (requirements, specifications, time spent, plans, economy),
**so that** the instance (a) helps us staff, estimate, build and run new projects on
evidence rather than folklore, and (b) serves other teams in the consultancy as
**intelligence about technical domains we have already paid to learn**: a team about to
onboard an integration — the Danish CVR company registry, the MitID national identity
service, a public GIS-record system — pushes its requirements onto the shared hub and
asks for guidance on the *shape, size and effort* of that integration, answered from our
portfolio, without joining the practice.

## Cast

One instance, `integration.consultancy.example` — solo profile (06), the practice is one
operator and one trust boundary. One **standing** practice hub plus one **case hub per
project**, archived at project close.

Coverage domains are **concrete services and platforms**, not generic tech areas — the
practice's edge is "we have integrated MitID four times," and per-service confidence is
portfolio depth, a number the settlement trail can be asked to back.

| Agent | Capability | Coverage / role |
|---|---|---|
| `i-registries` | `afp:cap:integrate`, `afp:cap:estimate` | public business registries: CVR, VAT/VIES, EU business registers |
| `i-identity` | `afp:cap:integrate`, `afp:cap:estimate` | national identity & signing: MitID, NemLog-in, eIDAS brokers |
| `i-gis` | `afp:cap:integrate`, `afp:cap:estimate` | public GIS and property records: Datafordeler, DAWA, cadastral services |
| `i-ipaas` | `afp:cap:integrate`, `afp:cap:estimate` | messaging and iPaaS runtimes; moderate coverage of most services |
| `i-archivist` | `afp:cap:recall` | reads the portfolio: archived case hubs, settlements, component registry |
| `i-presales` | `afp:cap:estimate` | frames budgets with clients — **estimator-flagged** on any task it scoped |
| `t-web-req` | `afp:cap:request` | the *web team's* agent: announces, reads, receives — does not bid or vote |

The portfolio the agents read is not a side database: it is the pile of **archived case
hubs** (07 — `afp:Archive` as canonical case file) plus the accumulated `afp:Settlement`
trail. Requirements, specs, plans are hash-addressed artifacts in those records; time
spent and economy are settlement entries linking estimates to actuals. The team's history
is *replayable evidence*, not a wiki.

## Walkthrough

**1. The standing practice hub.** `hub-integration-practice` is long-lived: every
practice agent enrolls with its coverage-bearing profile (the reference implementation's
`AgentProfile` recipe — one declaration drives roster, enrollment, bid coverage, and the
brain's persona). The component registry lives here as hub-scoped CRDT state: an OR-Map
of `component-id → {afp:digest, afp:sourceUrl, version, source project}`, maintained by
`i-archivist` as components graduate out of case hubs.

**2. Another team asks for guidance.** The web team's next project must onboard MitID
login and enrich customer records from the CVR registry. They are not commissioning the
practice to build it — they want to know **what shape the integration should take, how
big it is, and what it will cost them to build and run**. Their agent `t-web-req` is
enrolled on the practice hub as a **requester**: it announces and reads at `hub`
visibility, but hub policy bars it from bidding and voting. It announces a guidance
task: capability `afp:cap:estimate`, their requirements hash-addressed with
`afp:sourceUrl` provenance, selection rule published up front — coverage set-selection
over service domains `{mitid, cvr}` at confidence ≥ 60, answer sufficiency: both
services covered, at least two independent assessments. Sealed bidding earns its keep
differently inside one team than between firms: the sealing is not protection from
rivals but **independence of assessments** — nobody's coverage claim or cost figure
anchors anybody else's before the window closes, which is exactly what "two independent
assessments" is worth paying a two-phase window for.

**3. Guidance, grounded.** `i-presales` framed the web team's expectations when the ask
came in — and if the engagement later escalates into joint work (step 4), the practice
may bid to perform what it is now sizing. That is 03's estimator conflict one step
early, so the announce lists `i-presales` under `afp:estimators` with policy `exclude`;
its commit is rejected at admission, on the audit log. Sealed bids reveal coverage; the
rule awards `{i-identity, i-registries}` — each covers exactly one of the two domains,
so the synthesizer falls to the protocol tie-break constant, not to anyone's judgment.
Before answering,
each performer delegates a recall task to `i-archivist` (ordinary Offer/Result on the
same `context`), which returns *evidence, not opinion*: the practice's past MitID and
CVR integrations as references into their archived case hubs — estimate-vs-actual deltas
from settlements, the components reused, the certification and test-environment lead
times that dominated the schedule. The `afp:Synthesis` is the deliverable — guidance,
not a bid: the recommended **shape** (broker-mediated MitID via the existing
`mitid-broker-adapter@3.1` rather than direct integration; CVR as a nightly sync plus
on-demand lookup, component `cvr-lookup@2.0`), the **size and effort** as a range with
per-service breakdown, assumptions (the client qualifies for the broker's standard
agreement), and `i-identity`'s dissent that the MitID test-environment queue alone makes
the web team's target quarter unrealistic. Ratified by an L0 round; the DecisionRecord
names the Synthesis. `t-web-req` reads the whole thread; the economy artifacts the
archivist consulted stay `parties`-scoped inside the practice — the record shows *that*
history grounded the number without leaking day rates or client terms.

**4. Reuse crosses the team boundary.** The web team builds it themselves — that was the
point of asking for shape rather than for staff. The Synthesis referenced the two
registry components by digest, version and `afp:sourceUrl`; the web team's onboarding of
`mitid-broker-adapter@3.1` is a recorded reuse of a practice asset by an outside team.
When their questions during the build outgrow guidance — the broker agreement turns out
not to apply — the escalation is an ordinary follow-up task on the same `context`, and
if it becomes real joint work, a case hub with practice staffing (use (a)) opens with
the guidance thread as its recorded prehistory.

**5. Settling on someone else's actuals.** Guidance is an estimate whose actuals land in
*another team's* project. Two quarters later `t-web-req` reports observed effort and
calendar time back onto the thread (a Result carrying the actuals — the same duty 03
imposes on port agents reconciling external outcomes, applied to a requester); the
practice records `afp:Settlement` against each contributing
assessment, dissent vindication noted — `i-identity`'s test-queue warning proved out:
MitID go-live slipped six weeks, effort held. Requester-supplied actuals are exactly the
"unsettled until evidence exists" case 04 anticipates: if the web team never reports,
the guidance stays honestly unsettled rather than assumed right. `i-archivist` links the
settlement into the registry entries' provenance — component reuse by other teams is now
part of each asset's track record.

**6. Serving more teams.** Other teams repeat step 2 — a GIS-record onboarding, a VAT
validation flow. Each ask is a thread; the requesting team's read scope is its own
threads plus what the practice publishes at `hub` visibility. The practice's coverage
map *is* its service catalogue, and every answered ask either confirms a confidence
number or — through settlement — corrects it. If a served team someday runs its own
instance, the boundary shifts from a requester role on this hub to federation (P4/P5) —
the deployment profiles are prefixes, so nothing recorded so far changes shape.

## Acceptance criteria → mechanisms

| Criterion | Mechanism | On the built stack today? |
|---|---|---|
| Team knowledge is queryable evidence, not folklore | Archived case hubs (07) + settlements as the corpus; recall tasks return hash-addressed references | Yes — P1 artifacts + P2 archive + P3 settlements |
| Estimates grounded in past estimate-vs-actual | `afp:Settlement` trail read at estimation time | Yes (P3) |
| Guidance to another team is shape + size + effort, with dissent intact | `afp:Synthesis` as the deliverable, component references by digest/version | Yes (P3) |
| Guidance is eventually scored on the *requester's* actuals | Requester reports actuals (03 reconciliation duty) → `afp:Settlement`; unsettled until then | Yes (P3), leaning on finding 2's role |
| Staffing/estimating by coverage, not by loudest voice | Sealed bids + coverage set-selection + recomputable Award | Yes (P3) |
| The deal-scoper cannot bid on the work it scoped | `afp:estimatorPolicy: exclude` at admission, audit-logged, verifier-checked | Yes (P3) |
| Component reuse is a recorded, verifiable outcome | Bid claims + Result attachments with `afp:digest` / `afp:sourceUrl` / version | Yes (P1 artifacts; registry convention) |
| Other teams can ask without joining the practice | Requester-scoped enrollment + `hub`/`parties` visibility | **Strained — finding 2** |
| Cross-project component discovery | Registry OR-Map on the standing hub | **Strained — finding 1** |
| Past accuracy influences future selection | Recorded settlements → selection policy | **Strained — finding 3** |
| Economy data serves estimates without leaking | `parties` visibility + artifact visibility inheritance | Yes, with the port-boundary caveat below |
| A served team can audit "why this number" | Export + independent verifier replay incl. auction recomputation | Yes (P1–P3 verifier) |

## Spec verdict

**Held.** The striking result is how much of this scenario is *already* the built P1–P3
stack doing its job: sealed allocation, estimator separation, synthesis with dissent,
settlements, archives-as-portfolio, and third-party replay cover use (a) essentially in
full at one operator. The scenario's best idea costs the spec nothing: making the
portfolio *be* the accumulated record — archived hubs plus settlements — instead of a
parallel knowledge base, so the corpus that grounds estimates is itself verifiable.

**Strained — three findings:**

1. **Assets have no identity; capabilities describe agents, not components.** The
   vocabulary can say what an *agent* can do, and an artifact is bytes with a digest —
   but a reusable component ("`mitid-broker-adapter@3.1`, born in project X, hardened in
   Y") is a third thing: an asset with identity, versions, and provenance across hubs. The
   registry OR-Map convention works at one operator, but nothing names its entry shape,
   and cross-hub (later cross-operator) asset reference is unspecified. Candidate: an
   `afp:Asset` object — id, version, digest, `afp:sourceUrl`, originating context —
   referenceable from Bids ("I will reuse this") and Results ("I did, adapted, here is
   the delta"), so reuse claims are checkable at replay.
2. **Enrollment is binary; serving other teams needs roles.** A requester should
   announce, read its threads, receive answers, and later report actuals back (step 5
   depends on that write) — without joining selection rules, quorum snapshots, or vote
   weight. Today membership is all-or-nothing: enrolling `t-web-req` puts it in every
   pinned voter list and bid pool unless workflow code remembers to exclude it.
   `afp:AuditGrant` is close but read-only and audit-flavored. Needs: a role on the
   Enroll (`afp:role: member | requester | observer`), recorded in the membership CRDT,
   enforced at bid admission and at snapshot-pinning — so "who could ask," "who could
   answer," and "who could decide" are distinguishable in the record.
3. **The reputation trigger has fired.** ADR-0003 Decision 5 deferred computing a score
   until "a hub policy actually consumes reputation." Staffing is that policy: a practice
   lead choosing between two coverage-equivalent coalitions *should* prefer the one whose
   settlement history diverges less — and wants the selection to remain recomputable. That
   requires the deferred work: a named, published score derivation (inputs: settlement
   deltas, dissent vindications; window; decay) that is itself a pure function of the
   record, pinned in the Announce like a selection rule — never a live number smuggled
   into an otherwise recomputable Award.

**Minor precision:** confidentiality of economy data ultimately rests at the
port boundary, not in the protocol — the archivist's *brain* sees rate cards even when
its published Results only cite them. Visibility classes scope the record; what a brain
may say about what it read is operator policy, and worth stating as such in 06.

**Where AFP is the wrong tool here, stated plainly.** A casual "roughly how big is a
MitID integration?" deserves a search over the portfolio and a paragraph back — cheaper,
faster, no ceremony. The full machinery earns its cost only when the answer is one
**someone will commit resources against**: then the auction buys independence of
assessments, the Synthesis buys dissent that survives to the decision-maker, the
estimator wall buys a defensible process, and the settlement buys a practice that gets
measurably better at guidance. A sensible deployment runs both — a free-form query port
for questions, the recorded flow for *answers with consequences* — and the hub policy's
real job is knowing which one an ask is. Likewise, ratification-by-vote among four
agents of one team is theater unless policy makes it conditional (multi-performer
syntheses, or effort above a threshold), which is exactly the "MAY require" latitude 04
already grants.
