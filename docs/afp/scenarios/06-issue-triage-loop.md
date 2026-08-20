# Scenario 06 — The issue triage loop: from bug tracker to reviewed fix

> Spec-test scenario. Exercises: an **external system as the initiator** rather than a
> destination, **third-party content entering the record** and being reasoned over,
> triage as coalition classification, **acting on your own answer inside someone else's
> system**, idempotent external writes, author/reviewer separation, and **supersession of
> a published Synthesis** when review overturns the triage that produced it. The first
> scenario where the swarm changes the outside world on the strength of a conclusion it
> reached itself. Runs on the P1–P3 stack plus ADR-0004/0005. Verdict at the end.

## User story

**As** the operator of OurAwesomeProduct's software lifecycle,
**I want** newly reported issues investigated from every angle my team would investigate
them from — the source, what production actually did, and what we documented — before
anyone decides whether they are bugs,
**so that** mechanical fixes reach a reviewed pull request without a human triaging them,
everything else is routed honestly rather than optimistically, and when the triage turns
out to be wrong I can see *that it was wrong, when we learned it, and what we had already
done about it.*

## Cast

One instance, `sdlc.ourawesomeproduct.example` — solo profile (06), one operator, one
trust boundary. One **standing** hub `hub-sdlc-oap`, never archived: it accumulates one
thread per reported issue, and the pile of those threads is the product's triage history.

Because every agent belongs to the one instance, ADR-0005's weighting is trivially
satisfied — one operator, one seat — and nothing here turns on it. It matters only if the
product's SDLC ever spans two operators, which is why it is worth having settled first.

| Agent | Capability | Coverage / role |
|---|---|---|
| `issue-watcher` | `afp:cap:tracker.watch` | **read-only** port onto the bug tracker; enrolled as **`requester`** — announces, reads its threads, reports actuals, never bids or votes |
| `issue-scribe` | `afp:cap:tracker.write` | the **write** port: comments, recategorizes, assigns. `member` |
| `analyst-code` | `afp:cap:analyze` | coverage: `source` — the codebase and its history |
| `analyst-telemetry` | `afp:cap:analyze` | coverage: `telemetry` — production logs, traces, error rates |
| `analyst-docs` | `afp:cap:analyze` | coverage: `documentation` — specs, public docs, changelogs |
| `fixer` | `afp:cap:fix` | port onto the repository host; opens branches and pull requests |
| `reviewer` | `afp:cap:review` | reviews a diff it did not write |

**The read port and the write port are separate agents on purpose.** One agent holding
`tracker.watch` and `tracker.write` is simpler and strictly worse: the component most
exposed to hostile input — it ingests whatever strangers file — would also hold the
credential that mutates the tracker. Capabilities are declared per agent and checkable at
replay, so the split is expressible, and the blast radius of a compromised ingest port
becomes "it can lie about what was reported," not "it can close every issue in the
backlog."

## Walkthrough

**1. An issue arrives, and nothing it says is trusted.** `issue-watcher` pulls a newly
filed issue. It does **not** paste the reporter's prose into a task. The issue body,
attachments and repro steps are stored as **hash-addressed artifacts** (07) with declared
content types; the `Announce{afp:Task}`'s `content` is a short, port-generated summary in
the watcher's own words — affected component, observed versus expected, whether a repro
was supplied — and the reporter's text rides as *evidence the record carries*, not as
instructions the swarm is asked to follow. The distinction is the whole ballgame: an
issue body is arbitrary text from anyone who can file a bug, and a swarm that splices it
into a task description has handed a stranger the prompt. `afp:correlationId` derives
from the tracker's own issue id, so the webhook firing twice replays the cached outcome
on P1's dedupe rather than opening a second investigation.

**2. Triage is a coalition, not a lookup.** The watcher announces with capability
`afp:cap:analyze`, coverage set-selection over `{source, telemetry, documentation}` at
confidence ≥ 60, and answer sufficiency demanding all three domains covered. Sealed
bidding earns its keep here the way scenario 05 found it does inside one team: not as
protection from rivals but as **independence of assessment** — the telemetry analyst's
read of severity must not be anchored by the code analyst's read of blame before the
window closes. The announce also pins two things the record will be asked to recompute
later: the closed set of categories the answer may take, and the **action policy** that
says what may be done about each.

**3. Three perspectives disagree, usefully.** `analyst-code` finds a null dereference on
a path reachable when an optional field is absent. `analyst-telemetry` finds it fires in
0.3% of sessions, all on one client version that shipped eleven days ago. `analyst-docs`
finds the documented contract has *always* said the field is optional and the server
should tolerate it — but also that the field was documented as required until a doc
change four months ago, which nobody implemented. So: a real crash, a small blast radius,
and a genuine question about whether the code or the documentation is the thing that is
wrong. The `afp:Synthesis` classifies it `mechanical-fix`, confidence moderate, carrying
`analyst-docs`'s **dissent** that this is a documentation error wearing a bug's clothes
and that fixing the code ratifies a contract change nobody agreed to.

**4. What may be done about an answer is pinned, not improvised.** The classification is
a conclusion; the action is a consequence, and the two are different things the record
must connect. The `afp:actionPolicy` pinned in step 2 maps each category to an admissible
action — `mechanical-fix` → announce a fix task; `not-a-bug` → recategorize and comment;
`needs-elevation` → assign to the team; `insufficient-information` → comment asking for
what is missing, and close the thread. Because the policy was published up front and is a
pure function of the category, a replay recomputes it: *given this Synthesis, the
permitted action was to announce a fix, and a fix is what was announced.* Without that
pinning, a watcher that ignored triage entirely and a watcher that obeyed it are the same
two activities in the record.

**5. Changing the outside world, once.** `fixer` wins the fix task, writes the patch and
opens a pull request. The branch name is derived from the `correlationId`, which is the
only reason this is safe to retry: if the process dies between opening the PR and
recording that it did, the next attempt finds its own branch already there and reconciles
instead of opening a second pull request against the same issue. It then discharges 03's
port-agent duty — a follow-up `Result` on the same `context` carrying the external
reference, the diff's digest, and the observation timestamp — so the record's claim that
a PR exists is checkable against the world rather than merely asserted.

**6. The reviewer, and a wall that is the estimator wall wearing different clothes.** The
review task announces with `fixer` excluded: the agent that wrote a diff must not be the
agent that certifies it. This is ADR-0003 Decision 6's separation of duties with
different nouns — the mechanism there names *estimators* on the announce and rejects
their commits at admission, and what is wanted here is the same enforcement bound to a
*prior task's performers*. `reviewer` rejects: the patch makes the server tolerate the
missing field, which silently adopts the four-month-old documentation change as the
product's contract. `analyst-docs` was right.

**7. The triage was wrong, and the record says so.** A second `afp:Synthesis` lands on the
same `context` naming the first (via what ADR-0007 later carved out as `afp:supersedes` —
this scenario reached for `afp:supersededInputs`, which 04 scopes to input-level
revision, and that mismatch became part of finding 24) and reclassifying the issue as
`needs-elevation`: the question is not "is this a crash" but "which contract is the
product's," and no agent may decide that. The action policy admits assignment; `issue-scribe`
assigns the issue to the team and comments with the thread reference. **The pull request
is still open** — the answer was revised, but the world had already moved on the strength
of the first answer, and unwinding a side effect is not something the superseding record
can do by existing. The honest record is: a PR was opened for a reason that no longer
holds, and it says so.

**8. What the loop learns.** Two quarters of this and the settlement trail is the
product's triage accuracy. `issue-watcher` reports actuals as ADR-0004's requester
write-path allows — triage said mechanical and small, reality was an elevation and a
contract decision — and `afp:Settlement` records the divergence against each contributing
assessment, with `analyst-docs`'s vindicated dissent noted. Per ADR-0004 that standing
moves *selection odds* on future triage, and per ADR-0005 it moves nothing about votes:
being right about this issue does not buy a larger say in what the product decides.
Issues closed as `not-a-bug` settle against nothing and stay honestly **unsettled** —
04's legitimate terminal state, not a gap.

**9. The branch nobody enjoys.** When the three analysts cannot classify — no repro, no
telemetry, an ambiguous report — the answer is `insufficient-information`, the scribe
comments on the tracker asking for what is missing, and the thread **closes** with an
`afp:Error` coded `afp:err:insufficient-information`. It closes because the task, *as
posed*, cannot be completed: the alternative is a thread parked forever awaiting a human
who may never answer, and a replay procedure that demands a terminal outcome would have
to stop demanding one. If the reporter answers, that is a new ask with the old thread as
its recorded prehistory.

## Acceptance criteria → mechanisms

| Criterion | Mechanism | On the built stack today? |
|---|---|---|
| A duplicate webhook does not open two investigations | `afp:correlationId` from the issue id + P1 dedupe | Yes (P1) |
| Reporter-authored text never becomes an instruction | Issue body as hash-addressed artifact; Task `content` is port-generated | **Strained — finding 19** |
| Three perspectives, independently formed | Sealed commit-reveal + coverage set-selection over three domains | Yes (P3) |
| A minority objection survives to the decision-maker | `afp:dissent` first-class on the Synthesis | Yes (P3/04) |
| The action taken follows from the classification | `afp:actionPolicy` pinned in the Announce, recomputed at replay | **Strained — finding 20** |
| A crash mid-write does not open two pull requests | Idempotency key derived from `correlationId`; reconciling Result | **Strained — finding 21** |
| An unanswerable ask reaches a terminal outcome | `afp:Error` with a machine-readable class | **Strained — finding 22** |
| The author of a fix does not review it | Exclusion bound to a prior task's performers | **Strained — finding 23** |
| A revised answer supersedes the original, visibly | `afp:supersededInputs` on the replacement Synthesis | **Strained — finding 24** |
| Triage accuracy improves on evidence | Requester-reported actuals → `afp:Settlement` → `divergence-decay` | Yes (P3 + ADR-0004) |
| Being right does not buy governance power | Per-instance vote weight; reputation is selection odds only | Yes (ADR-0005) |
| "Why did this PR land?" answerable months later | Export + independent verifier replay | Yes (P1–P3 verifier) |

## Spec verdict

**Held.** The investigation half of this scenario is the built stack doing exactly what it
was built for: three coverage domains, sealed independent assessments, a recomputable
award, a Synthesis whose dissent turns out to be the most valuable thing in it, and a
settlement trail that scores triage against what actually happened. ADR-0004's requester
role fits the ingest port so precisely that the scenario needed no argument for it, and
ADR-0005 means a second operator joining this SDLC would change nothing recorded here.

**Strained — six findings.** The loop breaks new ground in one direction the spec has not
been pushed: everything so far has *recorded* outcomes, and this scenario *acts* on them.

19. **Content arriving through a port is untrusted in a way the spec does not name.** 04
    treats command parsing from fediverse strangers as an injection surface and says to
    sandbox untrusted *results* from other operators — but a task description ingested
    from an external system is neither, and it flows straight into the brains that reason
    over it. Candidate: state the port agent's duty positively — third-party content
    enters as hash-addressed evidence with a declared content type, and the task text an
    agent acts on is the port's own summary. Cheap to say now, and the thing an
    implementer will otherwise get wrong first.
20. **Nothing binds an action to the answer that justified it.** Selection has a pinned
    named rule; reputation has a pinned named derivation; *actuation has nothing*. A
    swarm that acts on its conclusions needs the same discipline it already applies to
    reaching them: an `afp:actionPolicy` in the Announce — a closed category set and a
    pure function from category to admissible action — so replay can ask whether what was
    done was what the answer permitted. Without it the branch logic lives in workflow
    code, which is the "enforcement that leaves no trace" ADR-0003 Decision 6 rejected,
    relocated from admission to consequence.
21. **The reconciliation duty stops one step short of idempotence.** 03 requires a port
    agent to reconcile an external side effect with a follow-up Result carrying the
    external reference — but says nothing about the window between doing the thing and
    recording it. A crash there leaves a record that cannot distinguish "not done" from
    "done, unrecorded," and a retry is a second pull request. Candidate: require the
    external side effect to carry an idempotency key derived from the `correlationId`, so
    reconciliation after a crash is a lookup rather than a guess.
22. **A task that cannot be answered as posed has no honest terminal outcome.** The replay
    procedure demands a `Result` or `afp:Error` per thread carrying a Task, and
    "waiting for a human who may never reply" is neither. Closing with a machine-readable
    `afp:err:insufficient-information` keeps the replay check's teeth and states the
    truth; a suspended state would cost the check its meaning. Small, but it wants naming
    rather than leaving each implementation to invent it.
23. **Separation of duties is specified once, for one pair.** `afp:estimatorPolicy` +
    `afp:estimators` enforce "the agent that scoped it may not bid on it," at admission
    and checkable at replay. "The agent that wrote it may not review it" is the identical
    shape and currently has no mechanism. Candidate: generalize the wall to an exclusion
    bound to a *named prior task's performers*, of which the estimator case becomes one
    instance rather than the only one.
24. **Supersession revises the answer; the world has already moved.** `afp:supersededInputs`
    exists and this is the first scenario to want it, which surfaces two gaps rather than
    one. Who may supersede a ratified Synthesis — does overturning a decision cost what
    making it cost? And the harder half: the superseded answer had already been *acted
    on*, so a replay should be able to see that an action's justification was later
    withdrawn. The record here is honest by accident (the PR is visibly still open);
    nothing makes it honest by construction.

**Ranking them, since six is more than a phase should swallow.** 20 and 23 are the ones
worth fighting for — both are the "make the policy recomputable" pattern this spec already
applies twice, and both get harder once implementations have grown workflow code around
the gap. 19 is the one an implementer gets bitten by first, and costs a paragraph. 21 and
22 are precision on existing duties. 24 is real but wants its own scenario: a workload
where the revision is the *point*, not a consequence of this one's review step.

**Where AFP is the wrong tool here, stated plainly.** Most issues in a real tracker are
not this. A typo in an error string does not need three sealed assessments, a synthesis
and a settlement — it needs one agent, one patch, and a human who can read a diff. The
machinery earns its cost when the *classification* is the expensive part: when getting it
wrong means shipping a contract change nobody agreed to, when the disagreement between
what the code does and what the docs promise is the actual finding, and when someone will
ask in six months why this PR landed. A sensible deployment triages the triage — a cheap
path for the obvious, this loop for issues whose category is genuinely in question — and
the hub policy's real job, as in scenario 05, is knowing which one an issue is. Running
every reported typo through a coalition is how a good mechanism acquires a bad reputation.
