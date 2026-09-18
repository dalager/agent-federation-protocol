# ADR-0038 — The operator's own work: the collection from a file, and `task` as the fourth form

- **Status:** Built (2026-09-18) — Decisions 1–4 built and gated; program claim **C7** of
  [ADR-0024](0024-the-road-to-production.md) for the operator who runs one instance and
  wants to hand it work; group: **Operations**
- **Date:** 2026-09-18
- **Applies to:** `cli.ts`'s `serve`/`keys`/`export`/`config check`, `demo.ts`'s
  `agentRegistrations`, `federation/visibility.ts`'s grammar, `ports/command.ts`,
  `inbox.ts`'s mention carrier, and the operator at a terminal
- **Builds on:** [ADR-0029](0029-the-human-window-and-the-activitypub-premise.md)
  Decision 2 (the three-form grammar, the controller binding, the polite reply) and
  Decision 3 (mentions as one carrier, never the only one),
  [ADR-0027](0027-the-port-is-a-security-boundary.md) Decisions 2–3 (what a brain may be
  handed; `localProvenance` — the operator is not a stranger to their own instance),
  [ADR-0033](0033-operator-obligations.md) Decision 1 (`afp:controllers` on the policy
  document), [ADR-0031](0031-the-resident-process.md) Decisions 1 and 4 (the flush loop;
  one writer, enforced by a lock), [ADR-0032](0032-deployment-profile.md) Decision 3 (the
  configuration schema), `profiles.ts` (one declaration per agent)
- **Driven by:** [scenario 15](../scenarios/15-the-production-tuesday.md) — its beats
  read the record, rotate a key, back up, export; nothing in it, or in its postscript, can
  name the command that hands a served instance's agent a job, because none exists. And
  `serve` boots `demo.ts`'s collection: a production Tuesday runs the demo's writer and
  reviewer, whatever the operator meant to run

## Context

Two gaps, one shape. A served instance ([ADR-0031](0031-the-resident-process.md)) is a
resident process with a store, a scheduler, a read gate and a command endpoint — and the
only way to make it *do* anything is to write a program against `AfpInstance.delegate`.
Every demo is such a program. An operator is not.

**The collection is hardcoded.** `cli.ts`'s `serve` calls `agentRegistrations(config)`,
which lives in `demo.ts` and always returns the demo's `writer` and `reviewer`.
`profiles.ts` already states the right recipe — one `AgentProfile` per agent, every
derivation from it — but `serve` never reads one. An operator who wants a different agent,
a different persona, or an actor of their own on the roster has to edit source.

**There is no way to hand an agent work.** [ADR-0029](0029-the-human-window-and-the-activitypub-premise.md)
built `POST /agents/:name/command` and bound it to the policy's controllers, with a grammar
of exactly three forms: `@name pause`, `@name status`, bare `approve`. Watching, stopping
and approving are covered; *asking* is not. The primitive it needs already exists —
`instance.delegate` publishes an `Offer{afp:Task}` from one held actor to another, and a
locally addressed Offer on a served instance is performed by the local brain on the
scheduler's next flush (`httpTransport`'s `isLocal` short-circuit into
`instance.localTransport()`, then `inbox.ts`'s `onTaskOffered`). What is missing is a
carrier: a signed request that becomes that call, and a command a person can type.

Both gaps close inside surfaces that exist. Neither needs new wire vocabulary.

## Decisions

### 1. The collection is a file, one declaration per agent, and `brain: none` is how a human holds an actor

`AFP_AGENTS_FILE` (kind `file`, optional) names a JSON array of entries shaped on
`AgentProfile`: `name`, `capabilities`, `persona`, `brain`, `consumes`, `keyCustody`,
`since`. `src/agents.ts`'s `agentCollection(config)` builds registrations from it; every
`cli.ts` call site that booted `agentRegistrations(config)` — `serve`, `keys list`, `keys
revoke --claim`, `export` — now boots this. Unset, the answer is byte-for-byte the demo's
writer and reviewer, so every demo, fixture and gate written before this ADR is unchanged.

Three brains: `llm` (`makeLlmBrain` against the configured endpoint, the entry's persona
framed the way `WRITER_PROMPT` frames the demo's writer), `stub` (`makeEchoBrain`,
deterministic, offline, `afp:producedBy: "stub"` — the value the default policy already
lists), and `none`: an actor the instance **holds** — key minted under instance custody,
`Vouch`ed onto the roster — and nothing performs for. That is what ADR-0029 Decision 2
meant by "humans hold an actor too, under instance custody", now writable without a
program. An Offer addressed to a `none` actor is `Reject`ed on the record by `inbox.ts`,
exactly the way a paused agent's is; it never hangs and never reaches a brain.

`keyCustody` defaults to `"instance"` and is the only value admitted: `"self"` means the
agent supplies its own signer ([ADR-0026](0026-key-custody-and-the-signer-port.md)'s
`agent` adapter), which a JSON file cannot carry — refused by name rather than silently
downgraded. `since` defaults to the demo's fixed instant, so a file-built roster is as
deterministic as the demo's. Validation is the boundary (`validateAgentEntries`, in
`policySpec.ts`'s style): names unique and `^[a-z][a-z0-9-]*$`, capabilities strings,
brain in the enum, `consumes` strings, no unknown keys, every problem named at once.
`config check` gains an `agents` line: `FAIL` naming every problem, or `ok agents — N from
AFP_AGENTS_FILE` / `ok agents — demo collection (AFP_AGENTS_FILE unset)`.

### 2. `task` is the fourth form of the grammar, delegated from the controller's held actor

`@<name> task <brief>` joins `parseCommand`: the controller's brief on one line (the
no-newline rule stands; the polite reply for anything else stands). `executeCommand` turns
it into `instance.delegate({ from: <controller's local name>, to: <agent>, … })` — the
same call every demo makes. The response is `{ task: <Offer id>, thread, correlationId }`,
and the served instance's own flush loop performs the Offer; `Accept` and `Result` land on
the thread with no further call from anyone.

Two conditions beyond the carrier's controller check. The requester must **resolve to an
actor this instance holds** (`instance.nameOf(by)` is a registered name): the Offer is
signed *as* the delegator, and only a held actor can be signed for. A listed controller on
another instance may `pause`, `status` and `approve` — none of which publishes as them —
but cannot delegate from here, and gets the polite reply like everything else refused; the
endpoint is not an oracle for which controllers are local. And the capability must be one
the agent advertises: `capability` in the body, defaulting to the agent's first, refused
otherwise. `thread` defaults to `${origin}/threads/<slug>` with slug `task-` + the first
12 hex of sha256(controller \0 brief \0 instant), derived the way `approveCorrelationId`
is; the slug is also the `correlationId`. `deadline` (ISO) and `visibility` (default
`parties`) are optional. The brief enters the brain as `delegator` material by
construction — `inbox.ts`'s `provenanceOf` sees an Offer from an actor under this origin,
which is ADR-0027's `localProvenance`.

No new wire vocabulary: the record shows an `Offer{afp:Task}` from a held actor, which is
what it would show if the operator had written the program.

### 3. The mention carrier does not carry `task`

ADR-0029 Decision 3 makes a `Create{Note}` mention one carrier for the same grammar, and
`inbox.ts`'s `onMention` still runs `parseCommand` and `executeCommand` for the three
older forms. `task` it refuses, explicitly, with the polite reply — logged with the reason.

The three older forms carry nothing past the parse: a verb, or a digest the body names.
`task` hands a brain free text. A Note is the one inbound shape a stock fediverse account
can author, and under instance custody it arrives at the boundary signed by the *sender's
operator* on the controller's behalf (`afp:actingAs`) — so a listed controller's brief
would reach a brain on the strength of another operator's key, and the requester would in
any case fail Decision 2's "held here" test. Rather than let that fall out implicitly, the
refusal is a named branch: one grammar, two carriers, and the one form that carries
content has exactly one door — the HTTP route, signed by the controller's own held key.

### 4. The CLI never opens the store

`npm run task -- <agent> "<brief>" [--as <controller>] [--capability <id>] [--thread <url>]
[--deadline <iso>] [--url <base>]` (`ports/taskCli.ts`). `serve` holds the store lock
(ADR-0031 Decision 4), so this command constructs no `AfpInstance` and touches no SQLite
file: it loads the controller's key from `config.keyDir`, signs `POST
/agents/<agent>/command` with `signRequest` + `fileSigner` — the adr0029 harness's own
shape — and sends it to `AFP_ORIGIN` (loopback in dev mode) or `--url`, printing the
response. It never mints: an absent key fails by name (`keyExists` before
`loadOrCreateKeyPair`), because a client tool that quietly minted a fresh identity would
put an actor on disk the roster never vouched for. `--as` defaults to the first
`afp:controllers` entry under this origin — the same "held here" test, resolved without
the store.

## Options considered

| Option | Rejected because |
|---|---|
| A workflow engine — a file of steps the instance runs | [ADR-0024](0024-the-road-to-production.md) D4: this is a protocol reference, not an orchestrator. A brief handed to one agent is the protocol's own `Offer`; what happens next is the record's business |
| `publishAsInstance` with an `afp:commandedBy` field naming the controller | New wire vocabulary for a fact the signer already states. An Offer *from* the controller's held actor is signed as them, `afp:actingAs` binds it, and the verifier already checks that binding; a second field would be a second place to state one fact |
| A REST `POST /tasks` outside the command grammar | A second path parsing controller free text — the shape ADR-0029's G3 ("no other path parses stranger free text") forbids by construction. One grammar, one `executeCommand`; a new verb is a new form, not a new endpoint |
| Let mentions carry `task` too, for symmetry | Decision 3. Symmetry would put a brief in front of a brain on another operator's signature |
| Mint the controller's key from the CLI when absent | Decision 4. Convenience that creates an unvouched actor on disk |

## Consequences

**Positive** — an operator runs `serve` with a file that says who their agents are, and
hands one of them a job from a terminal; the record is the same `Offer`/`Accept`/`Result`
the demos produce, and it replays under the verifier unchanged. A human's actor is a
two-line entry, not a program.

**Negative** — the grammar is four forms, not three, and the mention carrier now has a
form it deliberately does not carry; both are stated here and in the module docstrings.
`brain: llm` entries reach the same one endpoint `AFP_LLM_BASE_URL` names — per-agent
endpoints are not this ADR's claim.

**Accepted** — `task` addresses one agent with one brief. Fan-out, attachments and pins
stay with a program; the CLI is the operator's hand, not their workflow.

## Implementation architecture

### W1. Files

| Package | Touches | Content |
|---|---|---|
| **WP-1 · collection** | `agents.ts` (new), `config.ts`/`configSchema.ts` (`AFP_AGENTS_FILE`), `brains/stub.ts` (`makeEchoBrain`), `instance.ts` (`AgentRegistration.held`, `isHeld`), `inbox.ts` (Reject for a held actor), `runtime/configCheck.ts` (`agents` line), `cli.ts` call sites | Decision 1 |
| **WP-2 · grammar** | `federation/visibility.ts` (`task` form), `ports/command.ts` (`executeTask`, body fields) | Decision 2 |
| **WP-3 · carriers** | `inbox.ts` `onMention` (refuses `task`) | Decision 3 |
| **WP-4 · CLI** | `ports/taskCli.ts` (new), `crypto/keys.ts` (`keyExists`), `cli.ts` `task`, `package.json` | Decision 4 |
| **WP-5 · gate + docs** | `test/adr0038.test.ts` (G6, G8–G10 in `test/adr0038-cli.test.ts`; the shared harness is `test/adr0038-harness.ts`), instance README, this ADR, ADR-0029's revision note | W2 |

### W2. Gate matrix — `test/adr0038.test.ts` (G6, G8–G10 in `test/adr0038-cli.test.ts`)

| # | Case | Asserts |
|---|---|---|
| G1 | `AFP_AGENTS_FILE` unset | `agentCollection` is the demo's specs; the P1 bundle replays clean |
| G2 | A three-entry file (llm/stub/none) on a served instance | `/roster` names all three; the `none` actor has an instance-custody key; an Offer to it is `Reject`ed on the record |
| G3 | Every named validation failure | reported by `config check` by name, all at once (duplicate, bad name, unknown key, `keyCustody: "self"`, unknown brain, missing file) |
| G4 | `@worker task <brief>` from a listed, held controller | 200 with the Offer; after the next flush `Accept` and `Result` are on the thread, `afp:producedBy` is `stub`, the thread replays clean; explicit capability/thread/deadline honoured |
| G5 | Foreign-but-listed controller, unlisted signer, anonymous, newline, unadvertised capability, bad deadline, and a `task` mention | the identical polite reply; chain heads unchanged; verified refusals logged, the anonymous one not |
| G6 | `npm run task` against a served instance | signs as the controller and gets the same 200; `--as` defaults to the held controller; with the key absent it fails by name and no store/lock appears |
| G7 | Every shipped bundle replayed | unchanged |

## Build status

**Built (2026-09-18).** All five work packages; `test/adr0038.test.ts` G1–G7, 7/7 (the CLI
cases G6 and G8–G10 have since moved to `test/adr0038-cli.test.ts`). `npm
test` (`src/instance`) at the last addition below — 582 tests, 580 pass, 2 pre-existing skips, 0 failures, every
pre-existing gate, demo and fixture untouched.

Notes on what was built versus what the ADR wrote:

- **The roster entry carries no capabilities; the Vouch and the agent document do.** G2
  asserts the roster names all three actors and reads each `/agents/:name` for
  `afp:capabilities`/`afp:consumes` — the record's own layout, not a new field.
- **A held actor's `Reject` reads `held actor: nothing performs for it`.** The same branch
  in `onTaskOffered` answers a paused agent (`paused by controller`); the reason text is
  the only difference, so a delegator can tell the two apart on the record.
- **The `task` slug includes the instant.** `approveCorrelationId` is a pure function of
  its inputs so a replayed approve reuses one intent; a repeated brief is a new task, so
  the instant is part of the hash. The Offer's own `published` is the clock's next read.
- **`task` takes attachments by reference, never bytes** (Decision 2, extended on
  review). `attachments: [<sha256:digest>, …]` in the body, `--attach <digest>` on the CLI,
  each resolved through `instance.artifacts.lookup` and passed to `delegate` in the shape
  `demo.ts` uses for the draft; a malformed or unknown digest is the polite reply, chain
  unchanged. This is ADR-0027's boundary at the command port: the operator may point a
  brain at evidence already on the record — the draft `show result` names — but cannot
  smuggle new bytes past `artifacts.put`'s provenance through a command. `inbox.ts`'s
  `materialize` then hands bytes or an excerpt per the performer's `afp:consumes`, so the
  demo's writer → reviewer loop runs by hand: G10 checks the reviewer receives the draft
  as bytes, the review lands on the draft's thread, and the thread replays clean.
- **The published policy's `brains` are derived from the collection** (found by
  walkthrough, after the first build). `config.ts`'s default `PolicySpec` derived
  `afp:brains` from the single global `AFP_BRAIN`, which predates this ADR; a stub
  collection under the operator's default `AFP_BRAIN=llm` therefore published the LLM
  model while its Results carried `afp:producedBy: "stub"`, and ADR-0033's `check_policy`
  rightly failed the instance's own export. Now, with `AFP_AGENTS_FILE` set, the default
  is the union the collection runs (`agentsSpec.ts` `derivedBrains`: `stub` →
  `{model: "stub"}`, `llm` → the configured model and endpoint, `none` → nothing;
  deduplicated, first-appearance order); an all-`none` collection yields `[]`, which the
  verifier reads as "not declared" — the honest statement for an instance that runs no
  brain and produces no Result, where naming a model would be the very mismatch. A file
  with problems falls back to the `AFP_BRAIN` default so `loadConfig` never throws for it
  (`config check`'s `agents` line is where it is reported); unset, nothing changes; an
  explicit `brains` in the policy file still wins. The file's shape moved to a leaf
  `agentsSpec.ts` (mirroring `policySpec.ts`) so `config.ts` can read it without a cycle
  through `agents.ts`. G11 in both gate files: the derivation, and the end-to-end export of
  a served stub collection under `AFP_BRAIN=llm` replayed clean.
- **The CLI's `fetch` is not `policedFetch`.** The operator's tool addressing the
  operator's instance is outside ADR-0025's threat (what the *instance* fetches on a
  stranger's say-so); the module says so.
- **The read CLI, and the CLI never opens the store — now for reads too.** `npm run show
  -- thread <url-or-slug> | agent <name> | status <name>` (`ports/showCli.ts`) signs `GET
  /threads/:id/rendering`, `GET /agents/:name/timeline` and `@name status` as the
  controller, `text/plain` by default and `--json` for the document, and reports a refusal
  as one line — `not served to <controller> (404)` — with no speculation, because the gate
  is deliberately not an oracle. The controller resolution, never-mint refusal and
  `signRequest`/`fileSigner` signing moved into `ports/clientCli.ts`, shared by `task` and
  `show`, so the store-lock discipline of Decision 4 is written once. G8 covers it. `show
  result <url-or-slug> [--agent <name>] [--all]` is the fourth form and the one that prints
  what the agent actually answered: no new server route — it reads the thread rendering
  (the trail) to find the performer, then that agent's `GET /agents/:name/outbox`, paged
  through `first`/`next`, and selects the `afp:Result` entries whose `context` is the
  thread; header, verbatim `content`, attachments named by media type and digest and never
  fetched; `no result yet on <thread>` (exit 1) while the task is still running. G9. **A
  finding, resolved upstream:** as first built, `readGate.ts`'s `admitsParties` admitted a
  `parties` activity only when the requester was named in `to`/`cc` *and* held an active
  agreement — so a controller held on the instance it reads from (whose operator is that
  instance, which holds no agreement with itself) was 404'd on the very task it delegated,
  and the Offer named it as `actor`, not in `to`. Rather than patch around it here,
  [ADR-0013](0013-authorized-fetch.md)'s Build status records a revision under contact: a
  self-operated requester waives the agreement stage (never the party rule), and the author
  of an activity is a party to it. G8(b) is the end-to-end case — `show thread` as the
  controller renders Offer, Accept and Result — and `test/adr0013.test.ts` pins both
  boundaries.
- **G6 spawns the CLI asynchronously.** The served instance lives in the test process, so a
  synchronous exec would block the loop that has to answer the child's POST — the first
  draft did exactly that and waited out undici's 300 s headers timeout.

## References

- [ADR-0029](0029-the-human-window-and-the-activitypub-premise.md) Decisions 2–3 and its
  Build status — the grammar this ADR extends; revised there under contact
- [ADR-0027](0027-the-port-is-a-security-boundary.md) Decisions 2–3 — provenance, and why
  the brief is `delegator` material
- [ADR-0031](0031-the-resident-process.md) Decisions 1, 4 — the flush that performs the
  Offer; the lock the CLI must not contend for
- [ADR-0024](0024-the-road-to-production.md) D4 — why not a workflow engine
- `src/instance/src/agents.ts`, `ports/command.ts`, `ports/taskCli.ts`, `profiles.ts`
