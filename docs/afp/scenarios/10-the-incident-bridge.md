# Scenario 10 — The incident bridge: three operators, one hub, and the host is the one on fire

> Spec-test scenario, the **P5 shakedown**: the first workload that genuinely needs a
> *shared* hub rather than a pile of pairwise agreements. Exercises three operators on one
> hub, two-level enrollment across trust domains, hub-class reads served by the instance
> that wrote them, CRDT state converging after a partition, a quorum round while a member
> is unreachable, membership churn mid-incident, `Archive` as a member-quorum decision —
> and the first **three-export replay**, where ADR-0009's pairwise cross-check meets N=3.
> Written before the P5 stack ADR, deliberately: every useful finding in this repository
> came from a scenario that went first. Verdict at the end.

| **Support status** | **Supported — all findings closed** |
|---|---|
| Findings raised | 7 |
| Resolved by | [ADR-0014](../adr/0014-p5-shared-hub-stack.md), [ADR-0015](../adr/0015-the-case-file-at-n-parties.md) |
| See it run | `npm run demo:p5` |
| Gated by | `adr0014.test.ts`, `adr0014-m6.test.ts`, `adr0015.test.ts`, `adr0016.test.ts` |

**Read the walkthrough below as history.** It records what strained when this workload was
first walked, and is deliberately left as written — that is what makes a scenario evidence
rather than a brochure. Every strain it names is now built; the
[support index](README.md#is-this-workload-supported) is the current-status view, and the
ledger there names the decision that closed each finding.


## User story

**As** the NOC lead of one of three interconnected transit operators — who during a route
leak can see my own edge and nothing of my neighbours', and who afterwards must answer a
regulator asking *who knew what, when, and what did you do about it* —
**I want** the three of us coordinating on one shared, signed record during the incident
rather than in a conference bridge and three private ticket systems,
**so that** the timeline that exists afterwards is the one we actually worked from, and no
operator's account of the incident is merely their own word against the others'.

## Cast

Three operators, one standing hub, `incident-bridge`. **The hub is hosted by one of them**
— there is no neutral party, no consortium server, and P5 does not invent one. That single
fact drives half the findings below.

| Instance | Agents in play | Role in the hub |
|---|---|---|
| `ops.northnet.example` (**Alpha**) — **hosts the hub** | `n-noc` (member), `n-telemetry` (observer) | member + host |
| `ops.southlink.example` (**Bravo**) | `s-noc` (member), `s-telemetry` (observer) | member |
| `ops.eastpeer.example` (**Gamma**) | `e-noc` (member) | member |
| `ops.westgate.example` (**Delta**) | `w-noc` | invited **mid-incident**, beat 7 |

Each operator holds a `FederationAgreement` with each other operator — three agreements
for three parties, and that pairwise mesh is what the shared hub is supposed to stop
scaling quadratically. Every agent is `instance` custody.

The incident: a mis-originated prefix propagates from a customer of Alpha's, and traffic
for a range Bravo announces starts arriving at Gamma. No single operator can see the leak;
each sees one distorted slice of it.

## Walkthrough

**1. The hub is standing, and enrollment is two-level across three trust domains.** The
`incident-bridge` hub exists before the incident — hubs are cheap, and a hub created under
pressure is a hub whose membership nobody has checked. Each operator's instance enrolls
its own agents (ADR-0005 Decision 2: an `Enroll` is issued by the agent's own operator, and
the trail carries the mapping the weighting rests on). Alpha, as host, admits the *instances*;
each instance admits its own *agents*. Two levels, and the seam between them is exactly the
federation boundary.

Vote weight is per operator, not per agent (ADR-0005): Alpha fielding two agents and Gamma
one does not make Alpha's opinion twice Gamma's. With three operators the weighting is
finally load-bearing — at two it was a rule with no way to show itself.

**2. The incident opens as a thread, and evidence stays where it was produced.** `n-noc`
opens `urn:afp:thread:incident-4471` with an `Announce{afp:Task}` to the hub: *establish
whether prefix 203.0.113.0/24 is leaking, and from where*. Each operator's telemetry agent
answers with a `Create{afp:Result}` carrying its own view — route collector dumps, flow
samples — as **hash-addressed artifacts served by its own instance** (07). Nobody uploads
anything to Alpha. The record binds which bytes each operator saw; the bytes stay home.

**3. Reading across the boundary is where the shared hub stops being simple.** Bravo's
`s-noc` wants Gamma's telemetry Result — an activity in Gamma's outbox, `hub` visibility,
on a hub *Alpha* hosts. Bravo signs a `GET` to Gamma. Gamma must now answer: is `s-noc`
enrolled in `incident-bridge`?

Gamma does not host that hub and has no way to know. ADR-0013 scoped its `hub` predicate to
locally-hosted hubs precisely because of this, and `afp:MembershipProof` — the thing that
would let Bravo *prove* enrollment to a third party — exists in the spec as a noun and
nowhere in the implementation (**finding 43**). Today Gamma refuses, correctly and
uselessly: the shared hub's whole promise is that members can read the shared work, and at
P5 the members cannot.

**4. The host is the operator on fire.** Alpha's edge saturates — the leak originates with
Alpha's customer, and Alpha's transit is the congested path. Alpha's instance becomes slow,
then unreachable.

The hub is on it. Announces stop broadcasting, the CRDT store stops accepting deltas, and
the round Bravo was about to propose cannot open. **The coordination substrate fails
exactly when it is needed, and it fails for the operator least able to notice** — Alpha's
NOC is busy (**finding 44**). Bravo and Gamma can still reach *each other*: their
agreements are pairwise and intact. What they have lost is the shared state, because the
shared state lives at one address.

02's gossip and anti-entropy design assumes a hub that is reachable to converge *toward*.
Nothing in the spec says what a hub's members do while the hub is gone, and "wait" is the
implicit answer — which for an incident bridge is the wrong one.

**5. Convergence after the partition is not the same as agreement about it.** Alpha returns
forty minutes later. Its CRDT state has Bravo's and Gamma's deltas from before the
partition; theirs have local work they could not publish. The registers merge — CRDTs
converge, that is the point, and the version vectors make the merge deterministic.

What does not converge is the *timeline*. Each operator's activities carry its own
`published` instants, self-asserted (ADR-0012 Decision 2 says so plainly for signatures);
across three operators during a partition, "who knew what when" is now assembled from three
clocks that were never compared (**finding 45**). Chain-wide monotonicity (ADR-0008)
constrains each chain against itself and says nothing across them. The regulator's first
question is precisely this one, and the record answers it with three unsynchronized
opinions.

**6. A quorum round with a member unreachable.** Before Alpha returns, Bravo proposes
declaring the incident sev-1 and initiating a coordinated filter. The round's
`afp:quorumSnapshot` pins the electorate — three operators — and Alpha cannot vote.

The spec is clear that the snapshot is pinned at propose time and that votes from outside
it are dropped (02). It is *not* clear what a two-of-three tally means when the third is
partitioned rather than abstaining: an operator that is unreachable has not declined, and
recording it as an abstention writes a decision it never made (**finding 46**). Liveness
registers exist and are hub-scoped — which means they live on the hub, which is the thing
that is gone.

**7. Membership churns mid-incident.** Delta, a fourth operator carrying some of the
displaced traffic, is invited into the bridge while the incident runs. Its `w-noc` enrolls,
correctly, and the membership OR-Set converges.

The round from beat 6 is still open, and its snapshot does not name Delta. Snapshot pinning
handles this exactly right — Delta's vote would be dropped as out-of-snapshot — and the
record shows a member who joined during a decision it had no part in. What the spec does
*not* say is whether the *next* round should re-snapshot to include Delta automatically, or
whether admitting a member mid-incident should require its own decision. Both are
defensible; the spec picks neither, and two implementations will pick differently.

**8. Confidentiality inside a shared hub — and the case file's hole.** Each operator's
customer-impact assessment is `internal`: which of Bravo's customers lost traffic is
nobody else's business, including inside the bridge. The shared timeline is `hub`. That
distinction works, and it is the reason the four classes exist.

But the *shared incident state* — the agreed sequence of what was established when, the
thing the three operators actually coordinate on — is naturally CRDT state in the hub. And
ADR-0012 Decision 4 states plainly that **hub CRDT state is a projection and is not
exported**. So the case file that goes to the regulator contains every operator's
activities and *not* the converged state they worked from (**finding 47**). ADR-0012's own
revisit trigger anticipated this ("a deployment needs CRDT state in a case file") and
pointed at `afp:Archive` as the sanctioned carrier — state entering the record *as an
activity*. Beat 10 is where that has to be true rather than anticipated.

**9. The redaction hole meets three parties.** Bravo's export for the regulator is
thread-scoped: the incident thread, not its other customers' incidents. Under ADR-0009 the
other threads become digest-only stubs. But ADR-0010's open question is live here — a
scoped export that stubs a pin-bearing `Offer` leaves a thread whose governing pins resolve
to nothing, and every actuation check silently no-ops. With three exports the failure has
somewhere new to hide: a check that no-ops in *one* bundle still passes the joint replay,
because phase one runs per domain and finds nothing to fail on (**finding 48**).

**10. Closing the bridge, and the first three-export replay.** The incident ends. `Archive`
is a member-quorum `GovernanceDecision` — the hub freezes, then closes read-only with
canonical state hashes (07). That is where beat 8's converged state can enter the record as
an activity rather than dying as a projection, and the archive's state hashes are the
natural carrier.

Then the audit: three exports, one command. ADR-0009 built the joint replay as *N
single-export replays plus a cross-check* and was explicit that N is two at P4. At three,
the cross-check is no longer a pair: a received activity in Bravo's bundle may resolve
against Alpha's *or* Gamma's, agreement digest-equality is now a property of three
documents rather than two, and a divergence between Alpha and Gamma is visible to Bravo
without Bravo being party to it (**finding 49**). The design says "N times plus a join";
whether the join is pairwise-over-all-pairs or something else is unstated, and at N=3 it
starts to matter.

## Acceptance criteria → mechanisms

| Criterion | Spec mechanism |
|---|---|
| Three operators coordinate on one record, not three ticket systems | Shared `afp:Hub`, hub-scoped CRDT state, `Announce` fan-out to enrolled members |
| No operator's account is merely its own word | Signed activities per operator, hash-chained outboxes, joint replay across all three exports |
| Each operator's evidence stays on its own infrastructure | Hash-addressed artifacts served by the originating instance (07) |
| Customer-impact detail never crosses the boundary | `internal` visibility — never served, to anyone (ADR-0013) |
| Vote weight does not follow headcount | One operator, one weight (ADR-0005) — first exercised at n>2 |
| A member that joins mid-decision cannot alter it | `afp:quorumSnapshot` pinned at propose time; out-of-snapshot votes dropped |
| The incident closes with a canonical, frozen state | `afp:Freeze` / `afp:Archive` as member-quorum `GovernanceDecision` (07) |
| Members can read the shared work | **Strains** — `hub` reads across the boundary need `afp:MembershipProof`, finding 43 |
| The timeline survives a partition | **Strains** — findings 44, 45, 46 |
| The case file contains what the operators worked from | **Strains** — finding 47 |

## Spec verdict

**Held, structurally.** The parts P5 inherits work: two-level enrollment expresses a
three-operator hub without a new concept, per-operator weighting finally has something to
prove and proves it, snapshot pinning handles mid-round churn correctly, `internal` keeps
customer data out of a hub its owner shares with competitors, and artifacts staying home is
what makes a shared hub politically possible at all. Nothing here needed a new activity
type.

**But the shared hub's two defining questions are both unanswered**, and they are not
edge cases — they are the first and fourth beats. *Who hosts it* determines what happens
when the host is the casualty, and P5 currently answers "one of the members, and then you
wait". *How a member proves membership to a third party* determines whether members can
read the shared work at all, and P5 currently answers "they cannot". A shared hub whose
members cannot read each other's contributions during a partition of its host is a
conference bridge with better logging.

**Strained — seven findings:**

43. **`afp:MembershipProof` is a noun with no mechanism, and it blocks the read path.**
    A hub-class activity lives in its author's outbox; a fetching member is enrolled in a
    hub the *author does not host*. ADR-0013 scoped `hub` reads to locally-hosted hubs for
    exactly this reason, so at P5 the shared hub's members cannot read each other's work.
    Candidate: define it — a signed, expiring statement by the hub naming an agent, a hub
    and a role, presented by the fetcher and verifiable against the hub's published key,
    with the hub's actor document as the trust root the fetching instance already has.

44. **The hub is a single point of failure that is also a participant.** P5 puts the hub at
    one member's address. When that member is the one having the incident — statistically
    the likeliest convener — the shared state goes with it, and the spec's answer is
    implicitly "wait". Candidate: state the risk explicitly in 06 and give members a
    *degraded mode* — pairwise agreements already exist and stay intact, so the honest
    minimum is that members MAY continue on the P4 direct flow and reconcile into the hub
    on its return, with the reconciliation being an ordinary recorded act rather than a
    merge nobody can see.

45. **Three clocks, one timeline, no comparison.** `published` is self-asserted per chain,
    monotonicity is chain-local, and "who knew what when" across operators is the audit's
    first question. ADR-0012 introduced external anchoring for a *retention* duty; the
    same mechanism is what would make a cross-operator timeline defensible. Candidate:
    where a hub's members must reconstruct a joint sequence, the hub SHOULD anchor its own
    chain head on a cadence, and cross-operator ordering claims SHOULD be stated relative
    to hub-observed order rather than to any member's clock.

46. **An unreachable member is not an abstention, and the record cannot tell them apart.**
    A tally of two-of-three during a partition is a different fact from two-of-three with
    one refusal, and both currently look identical. Liveness registers, which would
    distinguish them, are hub-scoped and therefore unavailable in the case that matters.
    Candidate: a `DecisionRecord` SHOULD record the snapshot members from whom no vote was
    counted, distinguishing *declined* (a recorded `Reject`) from *silent*, so a reader
    sees the shape of the quorum that actually decided.

47. **The case file omits the state the operators worked from.** ADR-0012 Decision 4 keeps
    CRDT state out of the export deliberately and correctly; the consequence at P5 is that
    a shared hub's converged working state — the coordinated timeline itself — is not in
    anyone's bundle. Candidate: make ADR-0012's own revisit trigger concrete —
    `afp:Archive` carries canonical state hashes today, and it SHOULD carry (or reference
    as an artifact) the final converged state, so state enters the record *as an activity*
    exactly once, at the moment it stops changing.

48. **A no-op check hides better in three bundles than in one.** ADR-0010's open question
    — a redacted pin-bearing `Offer` leaves a thread with no resolvable pins, so its
    actuation checks silently pass — becomes harder to notice at N=3, because phase one is
    per-domain and a vacuous pass in one bundle is indistinguishable from a clean one.
    Candidate: resolve the ADR-0010 question before P5 widens the redaction surface, and
    have the joint replay report *which* checks ran per domain rather than only which
    failed — a per-domain check census, so a bundle that checked nothing is visible.

49. **ADR-0009's join was specified for a pair.** "N single-export replays plus a
    cross-check" is the right shape, but the cross-check's content is pairwise: received
    bytes resolve against *the* sender, agreements are digest-equal across *two* copies.
    At three, a received activity has more than one possible counterpart bundle, and one
    party can observe a divergence between two others. Candidate: state the join as
    all-pairs explicitly, and decide whether a divergence between two domains is a finding
    reported to the third — the auditor holding all three exports learns something no
    participant could, which is an argument for saying so rather than leaving it to
    implementation.

**The through-line, for the P5 stack ADR to answer first:** every finding above except 45
and 48 traces to the same unstated decision — *the hub is somebody's server*. P4 could
avoid the question because there was no hub. P5 cannot, and the choices it implies
(hosting, proof of membership, degraded operation, whose state the case file carries) are
one decision with four faces rather than four decisions.
