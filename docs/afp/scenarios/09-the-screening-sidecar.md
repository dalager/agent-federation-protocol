# Scenario 09 — The screening sidecar: an auditable agentic subsystem inside someone else's workflow

> Spec-test scenario. Exercises: the solo profile deployed *inside* an external system's
> pre-existing actuation boundary — a caseworker sidecar with scoped read/write/transition
> rights; external system as initiator over AMQP; a fixed screening panel routed by
> deterministic fan-out; brains in another language (pydantic-ai) behind the port;
> `afp:Synthesis` with first-class dissent ratified into the verdict; checkable actuation
> (ADR-0006) against the caseworker API; and the audit demand that motivates the whole
> deployment — an EU AI Act trace of how a screening verdict came to be, served as a
> subject-scoped export under ADR-0009 redaction. The initial walkthrough surfaced
> three findings; a full spec pass corrected two of the scenario's own claims and
> raised the count to twelve — the corrections are folded into the beats they touch.
> Verdict at the end.

| **Support status** | **Supported — all findings closed** |
|---|---|
| Findings raised | 12 · finding 32's remainder closed last, 2026-08-22 ([06 — per-subject disclosure](../06-deployment-profiles.md#designing-for-per-subject-disclosure)) |
| Resolved by | [ADR-0010](../adr/0010-pinning-without-an-auction.md), [ADR-0011](../adr/0011-supersession-meets-the-irreversible-world.md), [ADR-0012](../adr/0012-the-long-horizon.md), spec v3.22 and v3.28 |
| See it run | no standalone demo — covered by the gate(s) below ([why](README.md#is-this-workload-supported)) |
| Gated by | `adr0010.test.ts`, `adr0010-parity.test.ts`, `adr0011.test.ts`, `adr0012.test.ts` |

**Read the walkthrough below as history.** It records what strained when this workload was
first walked, and is deliberately left as written — that is what makes a scenario evidence
rather than a brochure. Every strain it names is now built; the
[support index](README.md#is-this-workload-supported) is the current-status view, and the
ledger there names the decision that closed each finding.


## User story

**As** the platform owner of a public agency's caseworker system — where citizen
applications traverse a workflow into terminal states (accepted, rejected, cancelled),
and one complex flow carries an "AI Screening" step performed by autonomous agents —
**I want** the screening step to run as an AFP instance inside the flow's existing
sidecar, with every agent's input, verdict, and disagreement on a signed record,
**so that** when an applicant or an auditor demands a trace on the screening verdict for
one application — a duty the EU AI Act makes statutory, not aspirational — we hand over
a record a stranger can replay, not a PDF we reconstruct from memory.

## Cast

The caseworker system already has the isolation pattern: a complex workflow gets a
**sidecar**, a custom subsystem with scoped access — for this flow, read four properties
of an application in the `AI Screening` state, write two (the verdict and its
classification), and move the application into one of two states (`screen-ok`,
`flagged-for-review`). The sidecar speaks OIDC/REST/AMQP to the caseworker system. That
part exists and does not change. **AFP never touches the caseworker system**; the
sidecar remains the sole holder of the OIDC client and the sole actuator.

One `afp:Instance`, solo profile ([06](../06-deployment-profiles.md)), co-located with
the sidecar; one standing local hub, `screening`. Agents are `instance`-custody. Brains
run in a separate Python process (FastAPI hosting pydantic-ai agents) behind the port —
the instance is the adapter stack; the brains never learn AFP exists.

| Actor | Capability | What it examines |
|---|---|---|
| `screening-coordinator` | coordination, round proposer, synthesizer | — |
| `financial-screener` | `screen:financial` | budget plausibility, declared amounts vs. thresholds |
| `past-history-interactions` | `screen:history` | the applicant's prior applications and outcomes |
| `project-description-assessor` | `screen:description` | coherence and completeness of the free-text description |
| `schedule-verifier` | `screen:schedule` | are the application's dates realistic |
| `sidecar-port` | — (the port made into an agent) | initiator, evidence source, sole actuator — see beat 2 for why it must be rostered |
| The compliance officer | auditor | via scoped export, years later |

Capability ids are the agency's own registry, namespaced, small, and versioned in one
place. The scenario's first draft cited the spec for "machinery, not a catalogue" — and
the citation does not land: no spec text states the vocabulary is open, and
[03](../03-coordination.md)'s one worked example (`afp:cap:image-classification`) even
implies an `afp:cap:` prefix these ids do not follow. The openness is real in the
implementation and unstated in the spec; the scenario proceeds on it and notes the drift.

## Walkthrough

**1. The panel is declared once and enacted on the record.** Each screener is one
profile declaration — name, capability, brain binding — from which everything derives:
a signed `afp:Vouch` onto the roster, an `Enroll` into the `screening` hub's OR-Map, and
the port-side binding `financial-screener → POST /agents/financial` on the Python
service. Membership is a recorded act, not a config entry: the auditor's later question
*"which agents were eligible to screen this application, and since when"* is answered
from the exported Vouch/Enroll trail, not from a deployment manifest that may have
changed since. Two disciplines hold the seam: a startup assertion fails the deployment
if a declared screener has no reachable brain (a dead panel should fail at boot, not as
a dead task at 2 a.m.), and the Python agents **never self-register** — dynamic
capability announcement over a side channel would put what an agent claims and what it
is into two systems with no recorded reconciliation. If the panel changes, the
declaration changes, and the new Vouch/Unenroll is itself a signed, dated activity.

**2. An application enters — as evidence, not as text.** The caseworker system moves
application `APP-2026-4711` into `AI Screening` and the sidecar receives the AMQP event.
It reads the four permitted properties over its OIDC-scoped REST access and opens thread
`urn:afp:thread:app-2026-4711` with an `Offer{afp:Task}` per screener. The four
properties enter the record as **hash-addressed attachments** on the signed Offers — the
record proves *which bytes* every screener saw. But pause on the signature: the Offers
are signed activities, and this scenario's first draft cast the sidecar as *not an
agent* — an author with no actor. The spec
models ports only as agents — scenario 06 split its tracker port into two rostered
agents precisely to contain hostile input, and [04](../04-operations.md)'s rule is
blunt: a valid signature from a key with no authority over its actor is a forgery.
Either the sidecar is modeled as one or more instance-custody port agents on the
roster, or its activities have no author the replay can account for. The scenario
models it as a `sidecar-port` agent and flags that the spec never states the rule
(finding 36). And finding 19's ingestion duty applies
at full strength before any protocol machinery does: the project description is
applicant-authored free text, a stranger's prose that four LLM-backed brains will reason
over. It enters as evidence; the task `content` is the port's own bounded summary
("assess the project description of APP-2026-4711 for coherence and completeness"),
never a splice of the applicant's words.

**3. Routing is deterministic fan-out, and the record shows the ceremony that was
skipped.** Four screeners, four disjoint concerns, every application needs all four —
the target of each workstream is known, so the degenerate flow applies (bidding only
when the target is unknown, as scenario 01 exercised): four direct Offers, one
`correlationId` per concern, each matched to the single registered brain advertising the
capability. No announce, no sealed bids, no award — and here the walkthrough's first
draft wrote "nothing lost, because there was no decision to record," which the spec pass
proved wrong on three counts. The Announce is not just an auction opener; it is where
`afp:actionPolicy` is pinned (ADR-0006), where `afp:answerSufficiency` is declared, and
the root of the chain (`Synthesis → afp:award → Award → afp:task → Announce`) the
verifier walks to find the governing policy. Skip the Announce and all three silently
disarm: the policy has no carrier, sufficiency has no home, and the synthesizer —
"named in the Award" per [04](../04-operations.md) — is named by nobody. What the
degenerate flow loses is not ceremony; it is the pin points (finding 34). The growth
path is real and additive: the day the agency runs
*two* financial screeners (a cheap fast model and an expensive careful one), the fan-out
for that concern becomes an `Announce` against the `screening` hub with a published
selection rule, and routing becomes a recorded, recomputable decision with
estimate-vs-actual settlement tuning it over time (P3). Until then, an auction with one
bidder is ceremony.

**4. The work happens behind the port, in another language.** Each Offer dispatches
through the brain port to the FastAPI service; a pydantic-ai agent runs with the
digest-verified attachments as its inputs and returns a typed verdict, which the adapter
signs into `Create{afp:Result}`. The port is the entire contract — capability in,
content and attachments in, outcome out — so the developers' pydantic-ai skills carry
over whole, and the brains are swappable without the record changing shape. Each Result
carries `afp:producedBy`; the agency's port convention stamps it with a *versioned*
identifier — model id plus prompt-pack revision — because "what made this claim" asked
under the AI Act is not answered by a bare model name (this strains; finding 33).

**5. One screener disagrees, and the disagreement is the point.** Three Results come
back clean. `schedule-verifier` returns a flag: the application promises delivery in
eleven weeks of work scheduled across nine calendar weeks including a construction
holiday. `screening-coordinator` emits `Create{afp:Synthesis}` binding the four Results
by digest — method stated, assumptions listed, and the schedule flag as **first-class
dissent** ([04](../04-operations.md#synthesis-answers-that-are-not-decisions)), not a
number averaged into a score. Note what authorizes the coordinator to synthesize:
nothing on the record. With no Award to name it, the synthesizer's mandate is
configuration — exactly the claim-without-a-record this scenario's beat 1 refused for
panel membership (part of finding 34). This is the interpretability answer in one field: when
the verdict is questioned, the record does not show a confidence value that emerged
from somewhere; it shows *which* screener objected, to *what*, resting on *which* bytes.

**6. The verdict is ratified, not trusted.** An L0 round over the pinned panel snapshot
closes with `Create{afp:DecisionRecord}` whose outcome names the Synthesis:
**flagged-for-review**. The coordinator's discretion in combining four partial views is
exactly what the round exists to catch — the reference implementation's own P3 runs
demonstrated a synthesizer occasionally combining partials wrongly, and that is what
dissent and ratification are *for*.

**7. Actuation is the sidecar-port's, and it wants to be checkable — the spec half
lets it.** The port agent writes the two permitted properties and calls the caseworker
API to move APP-2026-4711 to `flagged-for-review`. The pieces that land cleanly are
03's: the API call carries an idempotency key derived from the `correlationId` — a
crash between doing and recording is retried, not doubled (finding 21's rule) — and the
port reconciles, reading the application's state back and recording the confirmation,
because an external write that was never confirmed is a claim, not an outcome
([03](../03-coordination.md#external-systems-keep-the-firehose-behind-the-port)). The
pieces that strain are ADR-0006's own: the action policy the deployment pins "up front"
has no spec-sanctioned carrier without an Announce (finding 34), and `afp:actsOn` is
defined to resolve to a *Synthesis* — while the artifact this deployment actually acts
on is the ratified *DecisionRecord*, which `actsOn` cannot name (finding 35). The
scenario binds to the Synthesis and lets the DecisionRecord ride alongside, which works
and is exactly backwards: the checkable link attaches to the unratified artifact. The
scoped access the caseworker system already enforces — four properties readable, two
writable, two transitions — is the outer wall; AFP adds the inner record of *why* the
wall was exercised as it was.

**8. Two years later, the trace is demanded.** The applicant contests the flag; the
agency's auditor asks how the verdict came to be. The export is scoped under ADR-0009:
the application's thread, the roster thread, and nothing else — every other applicant's
thread appears as digest-only `afp:Redacted` stubs holding the chains linkable, and the
scope is declared in the manifest. Discretion is declared, deletion is detected: a
GDPR-clean answer to an audit that would otherwise force a choice between completeness
and other applicants' privacy. The verifier replays the bundle — enrollments, four
Offers with evidence digests, four signed Results with `afp:producedBy`, the Synthesis
with its dissent, the DecisionRecord, the actuation binding — and what the auditor
*reads* is a rendering derived from that verified record: "the sidecar asked four
screeners; three cleared; the schedule verifier objected, citing these dates; the panel
ratified flagged-for-review 4–0; the application was moved accordingly, confirmed."
The rendering is honest only because the bundle underneath it verifies (this seam
strains; finding 31). And one sentence the auditor must hear said plainly, because the
spec never says it in one place: replay proves *these four brains said this, on these
exact bytes, and the recorded verdict is internally consistent* — it does not prove a
rerun would say the same. Provenance stops at the port; the brains are non-deterministic
by nature, and the record is the thing that holds still (finding 42).

## Acceptance criteria → spec mapping

| Criterion | Spec mechanism |
|---|---|
| Screening decisions documented per the EU AI Act, replayable by a third party | Signed, hash-chained record; independent verifier replay; `afp:producedBy` |
| The caseworker system's access model is not widened | The sidecar stays the only OIDC client and sole actuator; AFP sits behind it |
| Every screener's eligibility and tenure on the panel is provable | Vouch → roster, Enroll trail — membership as recorded acts |
| One application's trace can be produced without exposing others | ADR-0009 scoped export: thread scoping, digest-only stubs, declared omissions |
| Disagreement between screeners survives into the verdict | `afp:Synthesis` dissent as a first-class field; ratification round |
| The state transition is bound to the verdict that justified it | ADR-0006: `afp:actsOn`, idempotency key, reconciliation — **strains**: the policy pin and the ratified target are findings 34/35 |
| Applicant free text cannot steer the agents | Finding 19's port duty: evidence by hash, task text is the port's summary |
| Developers keep their pydantic-ai stack | The brain port: language-agnostic, protocol-blind, `producedBy` crossing it |

## Spec verdict

**Held.** The solo profile drops into a pre-existing actuation boundary with no protocol
change to the *record-keeping core*: evidence by digest, deterministic fan-out, dissent,
ratification, ADR-0009's scoped export — these compose into an auditable screening step
without the caseworker system learning AFP exists. The company's fit question still
answers itself mid-walkthrough: a small, bounded, decision-producing subsystem with a
statutory documentation duty is close to the protocol's best case, and the line to keep
crisp is the one the walkthrough drew — the caseworker system remains the system of
record for the *application*; AFP for *how the verdict was produced*.

But this scenario's spec pass cut deeper than its first draft, and the verdict must
carry it: **the degenerate flow this deployment naturally chooses — direct fan-out, no
auction — is the flow where the spec's checkability machinery quietly falls off.**
Profile 06 promises the solo case is "a degenerate case, never a fork"; findings 34–36
say the promise is not yet kept for actuation, synthesis authority, and the port's own
identity. A scenario that found nothing would have been written to flatter the spec;
this one found twelve.

**Strained — twelve findings:**

31. **The audit deliverable ends at the verified bundle; the human starts after it —
    and the one presentation duty the spec has is aimed at the wrong channel.** The
    auditor and the applicant read a *rendering*, and the spec's only human-facing
    surfaces are the Mastodon shadow Note (operational, integrity-tied by nothing but a
    drill-down link) and the verifier's pass/fail. One normative seed exists — 04:
    dissent "SHOULD travel with the answer all the way to any human notification, not
    be summarized away en route" — and it is exactly the anti-omission rule needed,
    stated only for notifications. Candidate: generalize it into a presentation
    convention — a rendering SHOULD be derived mechanically from a verified export and
    carry the bundle digest and verifier result, so the narrative is checkable against
    the record it narrates.

32. **Subject-scoped disclosure rides on a convention the spec never states — and
    cross-thread state has no seam to cut at all.** ADR-0009's scope grammar is thread
    / visibility floor / agreement; auditor grants add hub and period. No axis names a
    *data subject*; the alignment here holds only because the deployment chose
    thread-per-application. Sharper: 02 explicitly invites application state into hub
    CRDTs, which are keyed `(hubId, crdtType)` and have **no thread** — and no spec text
    says whether CRDT state is even in the export bundle, let alone how it is redacted.
    Settlement and reputation registers are the same shape. The spec body contains no
    occurrence of "GDPR", "data subject", or "personal data". Candidate: deployment
    guidance — where disclosure duties are per-subject, the thread SHOULD be the
    subject-scoped unit; application CRDT stores, settlement registers, and
    contribution roll-ups SHOULD carry no subject content; and the export's content
    inventory (does it include CRDT state?) needs stating either way.

33. **`afp:producedBy` has no prose definition anywhere in the spec body.** It exists
    as an optional field in 03's class diagram and a rationale paragraph in ADR-0001 —
    no vocabulary-table row, no format, no content requirement. Under a regulatory duty
    the field must carry the versioned identity of the whole brain — model, prompt
    pack, tooling, guardrails — and the spec's own habit elsewhere is *pin it by hash*
    (snapshot pinning, asset identity, the attachment triple). Candidate: define the
    field in 04 § Rationale externalization as convention-not-machinery — `producedBy`
    SHOULD identify a resolvable, versioned brain configuration — kept non-normative
    for replay, since ADR-0001 deliberately keeps verification independent of sampling.

34. **The direct-delegation flow has no pin points: `afp:actionPolicy`,
    `afp:answerSufficiency`, and the synthesizer's mandate are all anchored to an
    Announce/Award that this flow deliberately lacks.** ADR-0006 pins the policy "in
    the Announce" and resolves it at replay through `Synthesis → afp:award → Award →
    afp:task → Announce`; 04 has the Synthesis "emitted by the synthesizer named in
    the Award". Skip the auction — as the spec itself instructs when the target is
    known — and the chain has no root: the policy has no carrier, sufficiency has no
    home, the synthesizer is appointed by configuration, and three verifier checks
    become silent no-ops. The deployment's headline claim — *the transition was the
    one the verdict permitted, recomputably* — currently has no mechanism at the flow
    shape it chose. Candidate: let a thread-opening activity (or the direct
    `Offer{Task}` itself) pin policy, sufficiency, and synthesizer, and give the
    verifier's governing-Announce lookup a fallback to it.

35. **`afp:actsOn` can name a Synthesis, never the ratified DecisionRecord.** ADR-0006
    requires the digest to "resolve to a present Synthesis" — written before ADR-0003's
    ratification option, and never revisited for it. A deployment that ratifies (the
    whole point here) must bind its action to the *unratified* artifact and let the
    DecisionRecord ride alongside, unchecked. Candidate: `actsOn` MAY name a
    DecisionRecord whose outcome names a Synthesis; the verifier follows the one hop.

36. **The external initiator has no actor model.** The sidecar emits signed activities
    (the opening Offers, the actuation record), and 04's rule is absolute: a valid
    signature from a key with no authority over its actor is a forgery, and replay
    accounts for every rostered agent. The spec models ports only as agents — scenario
    06 rostered its tracker port as *two* agents, split for blast radius, under
    ADR-0004's requester role — but nowhere states the rule. This scenario rosters a
    `sidecar-port` agent holding read, write, and actuation in one seat, exactly the
    concentration 06 argued against, and nothing in the spec takes a position.
    Candidate: state it — an external system that emits activities is modeled as one
    or more instance-custody port agents, rostered and vouched, with the read/write
    split RECOMMENDED where input is hostile.

37. **There is no panel-level "could not screen" that actuates.** Per-task terminality
    is covered (`afp:err:brain-failed`, `deadline-missed`, `insufficient-information`),
    but three Results plus one Error is four terminal legs and no answer: nothing says
    whether a Synthesis may cover a partial input set, and ADR-0006's category set is
    closed over the policy's keys — there is no category for "no verdict", so the AFP
    side can reach terminality while the application sits in `AI Screening` forever. An
    unscreened citizen application parked indefinitely is an availability failure that
    reads as a rights failure. Candidate: a reserved non-answer terminal that is still
    an actuation with an admissible action, so the external state machine is always
    released.

38. **Supersession assumes the world can be un-acted-on.** ADR-0007's disposition duty
    — the actuation loop "runs once more, under the same pinned policy" — presumes the
    disposing action is still admissible. Two years on, the application is in a
    terminal workflow state the sidecar's scoped rights cannot touch: the spec has no
    notion of an irrevocable action, no requirement to declare irreversibility when
    the policy is pinned, and no disposition form for "cannot be undone, only
    annotated". And ratification parity ("a new DecisionRecord by the current quorum")
    silently assumes the current quorum is a meaningful successor — a re-vote by four
    different model versions is a *different screening*, not a correction, and nothing
    marks the difference. Candidate: an `annotate-only` disposition for irrevocable
    actions, declared at policy-pin time; and supersession records naming the panel
    delta when the ratifying membership has materially changed.

39. **"A new ask with the closed thread as prehistory" is an idiom with no property —
    and it collides with supersession's same-`context` rule.** 03 prescribes the new
    thread; ADR-0007 Decision 1 requires a superseding Synthesis to share `context`
    with what it retracts. An applicant contestation is plausibly both (new information
    *and* a challenge to the verdict), the spec never says which fork governs, and
    choosing the new-thread fork makes the retraction machinery silently inapplicable.
    Candidate: an `afp:priorThread` property making prehistory followable, and one
    paragraph ruling the fork: revision of the answer reopens the thread; a new ask on
    new information opens a new one that names its predecessor.

40. **Nothing supports verifying a five-year-old export.** 01's rotation guidance
    treats a rotated key as *revoked*; the actor document is current-state, so an old
    bundle's signatures verify against keys the document no longer carries — and
    `instance` custody means one rotation strands the whole corpus for a naive
    verifier. No key-validity windows, no key history in the manifest, external
    anchoring only a SHOULD, and artifact retention scoped to federation lifetime
    ("the digest still proves what was claimed even when bytes are gone" — but the
    applicant is entitled to the bytes). Quiet today, fatal in year four. Candidate:
    the manifest carries the signing-key history with validity intervals; statutory
    deployments MUST anchor chain heads externally and retain artifact bytes for the
    retention horizon.

41. **Human oversight ends outside the record, and the one mechanism for recording a
    human decision is out of profile.** The verdict here is `flagged-for-review` — the
    AI Act's Article-14 moment is the caseworker's decision, and it never enters the
    record. Scenario 01's partner approval rode the Mastodon command mapping, which 04
    places at P4 and warns against pulling forward; the solo profile stops at P3.
    What nearly fits is 03's reconciliation duty, written for effects the swarm caused
    rather than outcomes downstream of it. Candidate: extend the duty one notch —
    where a flagged outcome hands off to a human, the port SHOULD reconcile the
    human's disposition onto the same `context`, so the record shows oversight
    occurred and whether it overrode.

42. **What replay proves is never said in one place, and an AI-Act audience will
    assume more.** Replay recomputes signatures, chains, digests, tallies, selection
    rules, policy branches — never a `Result`'s `content`. The honest sentence exists
    scattered ("provenance stops at the agent–instance port"; visibility does not
    scope what a brain has seen) but the composite — *replay proves what was said over
    which bytes under which pinned rules, not that a rerun would agree* — is exactly
    the claim a regulator will probe, and the dedupe rule (a retried task replays the
    cached Result) is quietly load-bearing as a verdict-consistency control, framed
    only as a duplicate-execution control. Candidate: one paragraph in 04's replay
    procedure stating the guarantee's boundary, and the dedupe rule cross-referenced
    as what makes a non-deterministic brain's verdict single-valued.
