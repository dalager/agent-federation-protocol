# ADR-0028 — Port agents: the external edge becomes code

- **Status:** Accepted (2026-09-02), **built** (2026-09-13) — program claim **C4** of
  [ADR-0024](0024-the-road-to-production.md); group: **Scenario coverage**. Depends on
  [ADR-0027](0027-the-port-is-a-security-boundary.md)
- **Date:** 2026-09-02
- **Applies to:** every point where an external system initiates work, receives an
  action, or reports an outcome — the seam 03 § External systems specifies and no code
  implements
- **Builds on:** 03 § External systems (the firehose stays behind the port; port agents
  MUST reconcile), 03 § the error vocabulary and idempotency key (v3.13),
  [ADR-0006](0006-checkable-actuation.md) (checkable actuation; the performer wall),
  [ADR-0019](0019-acting-on-a-decision.md) (the `actuator` role), [ADR-0004](0004-solo-foundation-hardening.md)
  Decision 1 (the `requester` role), 04 § Reliability
- **Driven by:** the review's scenario table — seven acceptance criteria not built and
  most of eleven narrowed sit at this edge: scenario 02 ("provider-agnostic tracker/repo
  integration", "no unreviewed code lands", "external outcomes appear in the trail"),
  scenario 06 ("a crash mid-write does not open two pull requests"), scenario 07 ("the
  correction did not post twice"), scenario 09 ("the caseworker system's access model is
  not widened"), scenario 01 ("kickoff and approval by a human"). Verified: no
  reconciliation, idempotency-key or port-agent code exists in `src/instance/src`

## Context

Every early scenario is a story about an external system. The observability pipeline
opens pull requests; the triage loop is driven by a bug tracker's webhook; the screening
sidecar is the only OIDC client of a caseworker system; the due-diligence case starts and
ends with a human in a client app. The spec answered each with a duty on a "port agent":
ingest external content as a hash-addressed artifact, act on the external system with an
idempotency key derived from the `correlationId`, and reconcile the external outcome back
into the thread as a `Result` carrying the external reference, a content hash, and an
observation timestamp.

Those duties are correct and they are prose. The record can *hold* a reconciliation
Result — nothing produces one, nothing derives an idempotency key, and the gates that
mark scenarios 02, 06 and 07 closed assert the record's shape, not that a second webhook
did not open a second investigation in a tracker. The support index is right that the
findings closed; the workloads have not run.

## Decisions

### 1. Two port-agent contracts, beside the brain port

`ports/external.ts` defines two interfaces, in the brain port's style — no ActivityPub, no
signatures, no SQLite:

- **`ExternalInitiator`** — turns an external event into a Task: the payload becomes a
  hash-addressed artifact through [ADR-0027](0027-the-port-is-a-security-boundary.md)'s
  ingestion, the Task's `content` is the port's own bounded summary, the
  `correlationId` is derived deterministically from the external id (so a redelivered
  webhook hits P1 dedupe), and the initiator is an enrolled `requester` (ADR-0004) —
  it may ask and report actuals, never bid or vote.
- **`ExternalActuator`** — executes an admitted action against an external system and
  reconciles. Its `act(action, justification)` receives the pinned action name and the
  digest it acts on (ADR-0006), MUST derive its idempotency key as
  `sha256(correlationId ‖ action)` and present it to the external system in whatever
  form that system honours (a branch name, a comment marker, a request token), and MUST
  return the external reference, the content hash of what it created, and the
  observation instant. The adapter publishes the reconciliation `Result` — the port agent
  never does — and the actuation activity carries `afp:actsOn`/`afp:action` exactly as
  today. The actuator is enrolled with the `actuator` role (ADR-0019): reads everything,
  votes nowhere.

### 2. Reconciliation is a duty the adapter enforces, not a convention the port remembers

An `ExternalActuator` that returns without an external reference and a content hash
produces a recorded `afp:Error` with code `afp:err:unreconciled`, never a silent success.
A crash between acting and reconciling is the case the idempotency key exists for: on
retry, the actuator presents the same key, the external system reports the existing
object, and the reconciliation names it. The gate proves the crash case with a fake
external system that counts objects.

### 3. Two reference adapters, tested against fakes, run by a demo

- **A webhook initiator** — an HTTP receiver behind the instance's own server, signed by
  a shared secret, feeding `ExternalInitiator`. Scenario 06's opening.
- **A git-forge adapter** — issue read, branch push, pull-request open as the actuation,
  and a `merge` action that the adapter refuses by contract, because 02's "no unreviewed
  code lands" is a human's act and the adapter must not be able to take it. Tested
  against `tools/fake-forge/`, an in-process fake with an object store keyed by
  idempotency key.

`npm run demo:p8` runs scenario 02 and 06's shape end to end: webhook → dedupe → sealed
triage panel → pinned action policy → pull request via the fake forge → reconciliation
Result → a forced crash and retry that opens no second PR → export → replay. With
`demo:p8:llm`, the triage judgements come from the local model.

### 4. The human is a port agent too

Scenario 01's kickoff and approval are an `ExternalInitiator` (the client app opens the
case) and an `ExternalActuator` whose "external system" is a person: `ApprovalPort`
presents the DecisionRecord to a human controller and returns their decision. The
controller is bound as [ADR-0029](0029-the-human-window-and-the-activitypub-premise.md)
specifies (the instance's policy names who may approve); the approval enters the record
as an actuation under a policy that pins `approve`/`reject` — the decision the humans
took is as checkable as the one the agents took, and distinct from it, which is the
scenario's own criterion.

### 5. The sidecar shape is documented as configuration, not protocol

Scenario 09's constraint — the sidecar stays the only OIDC client and sole actuator — is
an `ExternalActuator` deployment with one enrolled actuator and the caseworker system's
credentials held by the adapter alone. The instance README gets the shape; no new wire
term.

## Options considered

| Option | Rejected because |
|---|---|
| Ship real adapters for GitHub, GitLab, Jira, Linear | Each is a maintenance commitment against an API that moves; two reference adapters against fakes prove the contracts, and a deployment writes the third against its own system |
| A workflow engine that drives ports on triggers | ADR-0024 Decision 4: the operator's programs drive the library. The ports are what those programs call |
| Let the actuator publish the reconciliation Result itself | Then a port agent can forget; the adapter publishing it from the actuator's return value is what makes the duty enforced |
| Model the human approver as an ordinary agent with a brain | A human is an external system with latency; treating them as an actuator keeps the record honest about who decided |

## Consequences

**Positive** — scenarios 01, 02, 06, 07 and 09 get code where they had prose, a demo
where they had a claim, and gates for the two failure modes the spec named (double
execution, unreconciled action).

**Negative** — the fakes are fakes. A real forge behaves differently under rate limits and
partial failures; the reference adapters are contracts with proof, not products.

**Accepted** — merge stays human. The adapter refusing `merge` is a deliberate
inconvenience.

## Implementation architecture

### W1. Files

| Package | Touches | Content |
|---|---|---|
| **WP-1 · contracts** | `ports/external.ts` (new), `instance.ts` (adapter side: idempotency key, reconciliation publish, `afp:err:unreconciled`) | Decisions 1–2 |
| **WP-2 · adapters** | `ports/webhook.ts`, `ports/gitForge.ts` (new), `tools/fake-forge/` (new) | Decision 3 |
| **WP-3 · approval** | `ports/approval.ts` (new), with ADR-0029's controller binding | Decision 4 |
| **WP-4 · demo** | `demoP8.ts`, `cli.ts` | Decision 3 |
| **WP-5 · gate + docs** | `test/adr0028.test.ts`, 03 § External systems, instance README | W2, Decision 5 |

### W2. Gate matrix — `test/adr0028.test.ts`

| # | Case | Asserts |
|---|---|---|
| G1 | The same webhook delivered twice | one Task, one investigation; the second is dropped at dedupe |
| G2 | An initiator payload with instruction-shaped text | enters as an artifact with `external` provenance; the Task `content` is the port's summary |
| G3 | An actuation completes | the reconciliation Result carries external ref, content hash, observed-at; replay clean |
| G4 | The actuator crashes after the external write, before reconciling; retry | the fake forge holds exactly one object; the reconciliation names it |
| G5 | An actuator returns without a reference | `afp:err:unreconciled` on the record; no silent success |
| G6 | A `merge` action requested of the forge adapter | refused by contract, recorded |
| G7 | A human approval through `ApprovalPort` by an unauthorized controller | refused; by an authorized one, an actuation under the pinned policy referencing the DecisionRecord |
| G8 | `demo:p8` exported and replayed | passes; mutating the reconciliation's content hash fails by name |
| G9 | Every shipped bundle replayed | unchanged |

## Build status

**Built (2026-09-13).** All five work packages, and the gate matrix passes G1–G9
(`test/adr0028.test.ts`, 12 cases — G1–G9 plus three primitive checks carried over from
the WP-1 unit gate). The full suite is 306 tests green, `npm run demo:p8` runs offline
and deterministic, and its export is 243 checks PASSED against the independent Python
verifier.

Notes on what was built versus what the ADR wrote:

- **The `0x00` separator is spelled out, not left to the `‖` glyph.** `idempotencyKeyOf`
  computes `sha256(utf8(correlationId) ‖ 0x00 ‖ utf8(action))` as three explicit
  `hash.update` calls, so a verifier recomputing the same bytes from the spec's own prose
  has a concrete byte sequence to match rather than an ambiguous concatenation operator.
- **Intent before act, from the store, not memory.** `instance/external.ts`'s `actuate`
  publishes the `Create{afp:Act}` intent and looks up any prior one via
  `instance.outbox.byThread(...).find(...)` before ever calling `act()` — the lookup that
  makes a crash-then-retry a store read, never a guess, and G4 proves it against a fresh
  `AfpInstance` over the same `dataDir`.
- **`Forge`/`FakeForge` is one more port-and-fake pair,** in `brains/port.ts`'s own style:
  `tools/fake-forge/forge.ts` owns nothing `gitForgeActuator` doesn't need, and is
  idempotent by construction — `openPullRequest` keyed on the idempotency key, never a
  second object for the same key.
- **`AFP_CONTROLLERS` stands in for ADR-0029's signed policy document,** exactly as
  Decision 4 anticipated: a plain comma-separated list of authorized actor URLs on
  `Config`, read by `approveThroughPort` before anything is published. When ADR-0029
  lands its own controller-binding document, this list is the migration's starting set,
  not a competing mechanism.
- **`afp:err:refused-by-contract` is a code the ADR's prose never named** (Decision 3 says
  "refuses by contract"; the vocabulary had no error code for it). `instance/external.ts`
  mints it alongside the ADR's own `afp:err:unreconciled`.
- **The demo restructures nothing the roles forced, in the end.** `allocation/allocator.ts`
  checks the `member`/`requester` role split only on an `Announce{afp:Task}` *received*
  over the wire; `hub.allocation.announce` — what `demoP8.ts` calls — is the hub signing
  its own broadcast, so the webhook's `requester`-enrolled initiator needed no promotion to
  run the triage auction. The one real accommodation: `instance.actuate` never consults the
  hub's role registry (it is a P1-level call, not a hub-mediated one), so `forge-out`'s
  `actuator` enrollment in the demo's hub carries the record's own account of who acted,
  but does not admit the act — the demo says so where it happens.
- **G2 is narrower than the matrix wording** in the same way ADR-0027's G2 was: it drives
  one payload through `instance.initiate` and the real inbox dispatch and asserts the
  brain's own `TaskRequest` carries `external` provenance and the port's summary as
  `content`, rather than composing a `TaskRequest` by hand.
- **G7 uses WP-3's unit shape for `decisionRecordDigest`** (a bare `sha256:` digest), not a
  digest drawn from a real hub round — `demoP8.ts`'s own record does not run a
  human-approval round, so G3/G4/G8 are what exercise a real Synthesis digest as an
  `actsOn` target instead.

## References

- 03 § External systems: keep the firehose behind the port; 03 § the error vocabulary
- Scenarios [01](../scenarios/01-client-due-diligence.md), [02](../scenarios/02-observability-fix-pipeline.md), [06](../scenarios/06-issue-triage-loop.md), [07](../scenarios/07-the-retraction.md), [09](../scenarios/09-the-screening-sidecar.md)
- [ADR-0006](0006-checkable-actuation.md), [ADR-0019](0019-acting-on-a-decision.md), [ADR-0027](0027-the-port-is-a-security-boundary.md)
