# ADR-0033 — Operator obligations: the policy set a production deployment publishes, signed

- **Status:** Accepted (2026-09-02), **built** (2026-09-13) — program claim **C9** of
  [ADR-0024](0024-the-road-to-production.md); group: **Operator obligations**
- **Date:** 2026-09-02
- **Applies to:** the instance's policy document (`/afp/policy`, ADR-0017 Decision 5),
  the export manifest, and the verifier
- **Builds on:** 01 (the instance actor's `afp:policy` link), 04 § Participation
  inbound (the policy names authorized controllers), [ADR-0012](0012-the-long-horizon.md)
  Decision 3 (a declared retention duty turns its checks on), 06 § Designing for
  per-subject disclosure (the thread layout is a design-time decision; "state the layout
  you chose, and why, next to your retention duty"), [ADR-0017](0017-standards-conformance.md)
  Decision 6 (deviations are normative text), 05 § Open questions (collusion and
  undeclared common control are consortium-terms matters), [ADR-0021](0021-conviction-to-consequence.md)
  open questions 2 and 3
- **Driven by:** the review: the protocol repeatedly and correctly says "this is a
  deployment's decision" — the thread layout, the retention horizon, the seat policy, the
  controllers, the custody mode, the brains — and provides no place where a deployment
  says what it decided. Scenario 09's regulator, scenario 03's two firms and scenario
  13's four desks all need that place

## Context

`/afp/policy` exists as a URL the instance actor links to and the P4b command grammar
reads for `controllers`. Nothing else reads it, nothing signs it, and nothing an auditor
receives references it. Meanwhile the spec has accumulated a list of things it declines
to decide because they are the operator's: which visibility class is the default, how
long artifacts are retained and where they are anchored, whether threads are per subject,
which seat policy the hub runs, who may approve, which models produce Results, what the
consortium's terms say about collusion and common control. Each is a good decision to
leave to the operator. Leaving it *unstated* is what turns a regulator's question into an
email thread.

## Decisions

### 1. The policy document is a signed, versioned AFP object

`/afp/policy` serves an `afp:Policy` object carrying a `DataIntegrityProof` under the
instance key and a `published` instant, with these properties, every one optional in the
schema and every one a stated obligation once present:

| Property | States |
|---|---|
| `afp:seatPolicy` | `follow-required` \| `enroll-implies-seat` for hubs this instance hosts |
| `afp:controllers` | actor URLs authorized to approve and command ([ADR-0028](0028-port-agents.md), [ADR-0029](0029-the-human-window-and-the-activitypub-premise.md)) |
| `afp:defaultVisibility` | the class an activity gets when a workflow states none — the record still requires a declaration; this says what the adapter will write |
| `afp:retentionDuty`, `afp:anchors` | the declared duty and its anchors, as the export manifest already carries them (ADR-0012), stated here at the source |
| `afp:threadLayout` | `per-subject` \| `per-case` \| `per-engagement` \| `other`, with a sentence — 06's design-time disclosure decision, written down |
| `afp:custody` | the key custody mode per key kind ([ADR-0026](0026-key-custody-and-the-signer-port.md)) |
| `afp:brains` | the models and endpoints in use, matching the `afp:producedBy` values Results will carry |
| `afp:governance` | the hub-policy answers to ADR-0021's open questions: who may pin `afp:governanceSubject` (any member \| a member citing a proof or dispute on record), and the floor rule when recusal empties an electorate (`refuse` \| `no-decision:electorate-exhausted`) |
| `afp:terms` | a URL and digest of the consortium terms this instance federates under — collusion, undeclared common control, dispute venue — which the protocol leaves to contract |
| `afp:deviations` | any accepted deviation from the spec this deployment runs with, by section, in ADR-0017 Decision 6's form |
| `afp:disclosure` | a contact for security reports ([ADR-0034](0034-release-conformance-and-disclosure.md)) |
| `afp:hostedHubs` | the hubs this instance hosts — `{ afp:hubId, afp:seatPolicy?, afp:replicaOf?, afp:peers? }` per entry ([ADR-0037](0037-the-served-hub.md) Decision 1, added 2026-09-19). `serve` builds exactly these; the verifier holds every hub actor in a bundle whose `afp:operatedBy` is this instance to being named here |

### 2. The export manifest names the policy it was produced under

The manifest gains `afp:policy: { id, digest }` — the policy document's URL and the
digest of the signed object at export time — and the bundle carries the document itself
under `policy.jsonld`, declared in `afp:members`. A stranger replaying the bundle sees the
operator's stated obligations beside the record; a regulator asking "under what retention
duty, what thread layout, which models" reads one file.

On `afp:controllers`: the record shows that an authorized controller decided, not who the
controller was as a protocol-level identity — an approval's actor on the record is a
generic port agent (`actuatorName`), and the approving human is carried only as
`by`/`afp:externalRef` on the reconciliation Result, deliberately never as their own
rostered actor (scenario 01, finding 76).

### 3. The verifier checks what a policy makes checkable

`check_policy`, conditional on `afp:policy` being present: the carried document verifies
under the instance key in the bundle; the manifest's `afp:retentionDuty` equals the
policy's; every `afp:producedBy` in the bundle names a brain the policy lists; every
approval or command actuation's actor is a listed controller; the hub's seat policy
matches the Enroll trail's shape (a `follow-required` policy with an Enroll preceding any
`Accept{Follow}` for that instance is a named failure). Nothing here adjudicates the
policy's wisdom; it checks that the record matches what the operator said it would do.

### 4. The governance answers are enforced where the record already has hooks

The two ADR-0021 open questions become hub configuration read from the policy, with the
verifier recomputing them from the pinned proposal: a governance round whose subject has
no proof or dispute on record, under a policy that requires one, fails by name; a round
whose electorate after exclusions cannot reach any quorum form, under `refuse`, is never
opened, and under `no-decision:electorate-exhausted` closes with that reason, which the
verifier recomputes as ADR-0020 recomputes `quorum-impossible`. Closes
[ADR-0023](0023-loose-ends-triaged.md) L4 and L5 as operator obligations with verifier
checks, which is where a hub-policy question belongs.

## Options considered

| Option | Rejected because |
|---|---|
| Keep the policy as an unsigned convenience document | A document nothing verifies is documentation pretending to be a mechanism — the `afp:hubKey` shape ADR-0021 named |
| Decide the governance questions protocol-wide | Whether "convene a round about you" needs a precondition is a consortium's values question; the protocol's job is to make the chosen answer checkable |
| Put the consortium terms into the protocol | 05's open questions ruled twice that collusion and undeclared control are contract matters; a digest of the contract is the most the record should hold |

## Consequences

**Positive** — the questions the protocol correctly leaves to operators get a place to be
answered, the answer travels with every export, and the verifier holds the record to it.

**Negative** — an operator who publishes a policy is held to it. That is the mechanism.

**Accepted** — most properties are optional; a solo operator's policy may be three lines.
The manifest reference is what matters, and it is one field.

## Implementation architecture

| Package | Touches | Content |
|---|---|---|
| **WP-1 · object** | `ap/documents.ts` (`afp:Policy`, signed), `ap/server.ts` (`/afp/policy`), `docs/ns/v3.jsonld` (the new terms), 01 and 04 prose | Decision 1 |
| **WP-2 · manifest** | `export.ts` | Decision 2 |
| **WP-3 · verifier** | `src/verifier/policy.py` (new), `afp_verify.py` | Decision 3 |
| **WP-4 · governance** | `hub/hub.ts` (`proposeRound`), `src/verifier/decision.py` | Decision 4 |
| **WP-5 · gate** | `test/adr0033.test.ts` | below |

Gate: a bundle with a policy replays clean and `policy:` runs; a Result whose
`afp:producedBy` names an unlisted brain fails by name; an approval by an unlisted
controller fails by name; a governance round about an agent with nothing on record, under
a policy requiring it, is refused at the hub and fails at replay when spliced in; an
electorate emptied by recusal closes `electorate-exhausted` and the reason recomputes;
every shipped bundle — none carries a policy — replays unchanged.

## Build status

Built, all four decisions. `npm test` (`src/instance`): 496 passing, including this ADR's
own gate (`test/adr0033.test.ts`, 23 cases: G1–G6 plus the primitives block folding in
every WP's assertion). `python3 src/verifier/test/parity/run_parity.py cases.json` is
clean, including a five-case `governance` key pinning `electorate_exhausted`'s arithmetic
against `hub/governance.ts`'s `electorateExhausted` byte for byte.

**G1–G6**, the gate paragraph, each a case in `test/adr0033.test.ts`:

- **G1** — a bundle with a policy replays clean and `policy:` runs (census > 0).
- **G2** — a Result whose `afp:producedBy` names an unlisted brain fails by name.
- **G3** — an approval by an unlisted controller fails by name (the mutated
  `afp:externalRef`).
- **G4** — a governance round about an agent with nothing on record is refused at the hub
  (`GovernanceRefused`), and fails at replay when spliced in with its supporting dispute
  removed.
- **G5** — an electorate emptied by recusal closes `electorate-exhausted` and the reason
  recomputes; a genuinely `quorum-impossible` close relabeled `electorate-exhausted` fails
  by name.
- **G6** — every shipped bundle replays unchanged: `freshDemo()` and `runP8Demo()` PASSED —
  every export now carries a policy, so "unchanged" means the verifier still passes, not
  that the bytes are identical to before this ADR.

**What was built versus what the ADR wrote**, worth a reader's attention:

- **`policySpec.ts` is a dependency-free leaf**, apart from `ap/policy.ts`. `config.ts`
  needs the `PolicySpec` shape and `validatePolicySpec` to assemble and validate
  `Config.policy`, and `config.ts` sits underneath `crypto/keys.ts`
  (`keyPassphraseFromEnv`), which `crypto/proof.ts` depends on — so a policy-spec file
  that imports nothing from `ap/documents.ts` or `crypto/proof.ts` is what keeps
  `config.ts` from closing an import cycle. `ap/policy.ts` re-exports everything from it,
  so every other caller reaches both from one place.
- **Config precedence, and `AFP_CONTROLLERS` demoted to a convenience.** `assemblePolicy`
  merges `AFP_POLICY_FILE` over instance-derived defaults, property by property — a
  property the file states wins, one it omits falls back to the default. `AFP_CONTROLLERS`
  populates `afp:controllers` only when the file names none: the policy file is the source
  of record now, the env var the pre-ADR-0033 convenience it always was (ADR-0028
  Decision 4).
- **The three controller readers switched** — `ApprovalPort`, the command grammar
  (`POST /agents/:name/command`), and the inbox's mention handler — all now read
  `instance.policy.controllers` rather than `config.controllers` directly.
- **`afp:custody.instance` is pinned from config** (`{ instance: "file" }`, today's only
  signer adapter), never left to the policy file to restate, because agent custody is a
  per-registration fact config cannot see — a policy claiming otherwise would be asserting
  something it has no way to check.
- **The electorate floor is gated on recusal**, not on unreachability alone: `Hub
  .proposeRound` only considers `electorate-exhausted` when `recused.size > 0` — a bar that
  was unreachable from the start, with nobody excluded, is deliberately left as
  ADR-0018/ADR-0020's ordinary `quorum-impossible`/`threshold-not-met` (the same
  deliberately-unreachable-bar case ADR-0020's own gate G7/G8 already covers). Mirrored
  exactly in `decision.py`'s `electorate_exhausted`, which requires at least one
  `afp:excluded` entry with `afp:status: "recused"` before it even looks at the arithmetic.
- **The verifier's `afp:producedBy` matching rule** accepts either an exact `afp:model`
  match (the stub brain's own `afp:producedBy`) or a `"<model> @ <endpoint>"` prefix match
  (the llm brain's `producedByLine`, whose `"; template sha256:…"` suffix is not itself
  matched against the policy).
- **The controllers check's shape** follows finding 76's reading, stated in this ADR's
  Decisions above: an approval's actor on the record is a generic port agent
  (`actuatorName`), so the check resolves the reconciliation Result's `afp:externalRef` —
  the human as carried, never as their own rostered actor — against `afp:controllers`.
- **The seat-policy check skipping replicas** — an actor document carrying
  `afp:replicaOf` is never examined, because a replica's bundle only relays Enrolls it
  never itself admitted. Live-fire in the demos: this check caught two `demoP2`/`demoP3`/
  `demoP8` bugs the seat-policy default flip (ADR-0032 Decision 6) had left latent — an
  Enroll's `published` instant could land before its own preceding `Accept{Follow}` purely
  from clock-tick timing (`instance.followHub` queued, but not flushed, before the first
  Enroll), fixed at the root by flushing the Follow's own `run()` before any Enroll
  publishes; and `demoP3`'s no-Result fallback narrative wrote
  `producedBy: "stub-brain/1"`, which the config's default `afp:brains` (`[{ model: "stub"
  }]`) does not list — changed to `"stub"`, matching what the stub brain actually writes
  everywhere else.
- **The subject-precondition check lives in `policy.py`**, not beside
  `check_proposal_electorate` in `decision.py` — its trigger,
  `afp:governance.afp:subjectPrecondition`, is a field on the policy document
  `check_policy` already loaded, so a reader asking "what does the policy make checkable"
  finds both governance answers (this one, and `electorate_exhausted`, wired into
  `decision.py` where the no-decision reason it justifies already lives) from one entry
  point, one hop each.
- **`readPolicyFile` names its error.** A malformed `AFP_POLICY_FILE` first surfaced as
  a bare `SyntaxError` — "Unexpected token", naming no file; the review made it
  `AFP_POLICY_FILE <path> is not valid JSON: …`, since the operator wrote that file by
  hand and the error is the only thing that will tell them which one.
- **Every export now carries a policy.** "Every shipped bundle replays unchanged" (the
  ADR's gate, G6) means what it can mean once every export gains `policy.jsonld`:
  previously exported bundles (none of which carry `afp:policy`) still replay exactly as
  before — `check_policy` is a no-op, recorded as `policy:0` rather than silently skipped —
  and every bundle exported from here on carries the signed document and the twelve checks
  that go with it.

## References

- 06 § Designing for per-subject disclosure; 05 § Open questions; 04 § Participation inbound
- [ADR-0012](0012-the-long-horizon.md) Decision 3; [ADR-0017](0017-standards-conformance.md) Decisions 5–6
- [ADR-0021](0021-conviction-to-consequence.md) § Open questions, 2 and 3; [ADR-0023](0023-loose-ends-triaged.md) rows L4, L5
