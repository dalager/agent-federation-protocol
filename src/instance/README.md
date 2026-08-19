# AFP reference instance — P1 + P2 + P3

**P1**: one instance, two agents, one verifiable record — no network
([05 § P1](../../docs/afp/05-roadmap.md#p1--one-instance-two-agents-one-verifiable-record)).
**P2**: a local hub beside the agents — enrollment, hub-scoped CRDT state, and
L0 weighted-quorum deliberation closing with a signed `afp:DecisionRecord`
([ADR-0002](../../docs/afp/adr/0002-p2-hub-and-crdt-stack.md)).
**P3**: local allocation — sealed commit-reveal bidding, a published
deterministic selection rule (ranking or coverage set-selection), a
recomputable `afp:Award` with coalition + synthesizer, ratified `afp:Synthesis`,
and `afp:Settlement` ([ADR-0003](../../docs/afp/adr/0003-p3-allocation-stack.md)).

```bash
npm run demo          # P1: writer drafts, reviewer critiques, bundle exported
npm run demo:offline  # the same, against deterministic brains
npm run demo:p2       # P2: 30 agents agree on the best policy (-> ./export-p2)
npm run demo:p3       # P3: two auctions, coalition award, synthesis (-> ./export-p3)
npm run gate          # the acceptance gate: P1's 11 checks + CRDT + hub + auction
npm run serve         # the public HTTP surface
```

Requires **Node 22.5+** (24+ recommended). No build step — Node runs the
TypeScript directly — and **no dependencies at all**: `node:crypto` covers
Ed25519, `node:sqlite` covers the store, and the model endpoint is plain
`fetch` against an OpenAI-compatible API rather than a vendor SDK.

## The demo

```
thread urn:afp:thread:doc-1 — 6 activities

   1  writer    Offer{afp:Task}      parties     review the draft
   1  reviewer  Accept               parties
   2  reviewer  Create{afp:Result}   parties     "Rejected: …optimistic performance estimates"
   2  writer    Offer{afp:Task}      parties     review the revision
   3  reviewer  Accept               parties
   4  reviewer  Create{afp:Result}   parties     "Approved: …"
```

The writer drafts from the brief, delegates the review, **revises against the critique**,
and delegates again. Its own drafting is not a delegated task — nobody asked for it over
AFP — so it enters the record as a hash-addressed attachment on the writer's signed Offer,
alongside the brief it was working from.

A third outbox, `instance.jsonld`, carries the `afp:Vouch` trail the roster is derived from:
membership is a recorded act, not a config entry.

Then hand `export/` to someone who was not there:

```bash
python3 ../verifier/afp_verify.py export --thread urn:afp:thread:doc-1
# PASSED — 62 checks, no gaps
```

The deliverable is not the finished document. It is a record a stranger can
verify and a forger cannot quietly edit — produced by a system with two agents
and no network.

## The P2 demo

The roadmap's own scenario: *"30 agents agree on the best policy for codebase
integrity."* Thirty voters enroll in a local `afp:Hub` (same process, same
dispatch port — the wiring stays invisible in the record), an L0 round runs
over a pinned membership snapshot with explicit per-voter weights, three
agents abstain by omission, and the hub closes the round with a signed
`Create{afp:DecisionRecord}`:

```
hub https://alpha.operator.local/hubs/policy-hub
round urn:afp:round:codebase-integrity — 30 enrolled, 27 votes counted

  signed-commits   ███████████████ 15
  review-quorum    █████████ 9
  trunk-freeze     ███ 3
  abstain          ███ 3

outcome:  signed-commits
```

The hub is vouched onto the roster like any agent (self-custody), so the
export replays with no special case:

```bash
python3 ../verifier/afp_verify.py export-p2 --thread urn:afp:thread:codebase-integrity
# PASSED — 466 checks, no gaps
```

The verifier recomputes the tally from `afp:countedVotes`, demands every
counted vote be producible, and rejects any vote from outside the pinned
snapshot — and fails loudly, with a specific pointer, when the record is
mutated any of those three ways.

## The P3 demo

Two auctions on one hub — scenario 04's federated estimation, at one operator.
A `ranking` auction picks a single load-test performer by published linear
weights; a `coverage` auction over four estimation domains awards a two-agent
coalition and deterministically names the synthesizer. Bids are sealed
commit-reveal (`afp:bidCommit` → `afp:BidReveal`, commitment =
`sha256(JCS(bid payload))` with a mandatory nonce), one agent declines on the
record, and the estimator who framed the budget is rejected at bid admission
under `afp:estimatorPolicy: exclude` — audit-logged, and checkable at replay:

```
ranking  auction load-42: winner a-data
coverage auction q-88:    coalition [c-generalist, b-licensing], synthesizer c-generalist
  declined: d-secops — not my domain: security operations, not estimation
  admission rejected: e-estimator — estimator excluded from bidding …
```

The coalition's partial answers land as ordinary `Create{afp:Result}`s; the
synthesizer emits `Create{afp:Synthesis}` binding them by digest, with method,
assumptions, and first-class dissent; ratification is an ordinary P2 L0 round
whose `DecisionRecord` outcome literally names the Synthesis; and an
`afp:Settlement` links each winning bid's estimates to observed actuals —
recorded signals, never a live score (ADR-0003 Decision 5).

```bash
python3 ../verifier/afp_verify.py export-p3 --thread urn:afp:thread:q-88-migration-estimate
# PASSED — 324 checks, no gaps
```

For each `afp:Award` the verifier rebuilds the admitted bid pool from the
record alone (enrollment trail, one commitment per bidder, commit inside the
window, reveal after it, payload naming its signing actor, estimators out,
reauction exclusions bound to the prior award), reruns the announced selection
rule with its own independent implementation, and demands the recomputed
performers, synthesizer, *and* winning-bid digests equal the Award's — plus
the announced answer-sufficiency threshold, the synthesis binding, and the
estimator wall. An award timeout is swept into a recorded `afp:Reauction`
whose fast-path award names the excluded failed winners.

## Layout

```
src/
  config.ts          environment abstraction; no secrets, no direct process.env elsewhere
  crypto/
    jcs.ts           RFC 8785 canonicalization
    proof.ts         eddsa-jcs-2022 sign/verify — the only signature that survives export
    keys.ts          Ed25519 via node:crypto; keys on disk, never in the record
    multibase.ts     base58btc + Multikey
  store/
    db.ts            SQLite schema — outbox, both dedupe layers, tasks, queue, audit log
    outbox.ts        append-only, per-actor hash chain
    dedupe.ts        layer 1: transport dedupe on activity id
    tasks.ts         layer 2: correlationId replay + pending-task table
    queue.ts         delivery with backoff and dead-lettering; no broker
    artifacts.ts     digest-addressed blobs
  ap/
    documents.ts     instance actor, agent actors, signed roster
    activities.ts    Offer{Task} / Accept / Reject / Create{Result} / Create{Error}
    server.ts        public HTTP surface; everything above `public` returns 404
  brains/
    port.ts          the entire agent contract — mentions no protocol at all
    stub.ts          deterministic brains, so the gate is reproducible offline
    openai.ts        the same port, an OpenAI-compatible endpoint behind it
  crdt/              P2: the four hand-rolled CRDTs (G-Set, LWW, OR-Set, OR-Map)
                     + the keyed SQLite store with per-actor version vectors
  hub/
    hub.ts           the afp:Hub actor — enrollment, L0 rounds, DecisionRecord,
                     Freeze/Archive; reaches agents only through the shared port
    activities.ts    Enroll/Unenroll, Offer{Proposal}, Create{Vote/DecisionRecord}
    crdtAdapter.ts   class-shaped view over crdt/ for the hub's call sites
    store.ts         rounds + vote receipts (CRDT state lives in crdt/)
    transport.ts     the shared delivery port routing by URL alone
  allocation/        P3: allocation beside the hub (ADR-0003)
    rules.ts         the selection-rule registry — ranking + coverage, pure,
                     tie-broken by the protocol constant
    activities.ts    Announce{Task}, bidCommit/BidReveal, Award, Reauction,
                     Create{Synthesis}, Settlement
    allocator.ts     admission gate, award/reauction sweep, settlements
    store.ts         auctions, bids, declines, admission audit log,
                     pending accepts, settlements — same SQLite file
  instance.ts        the adapter stack: signing, chain, gate, dedupe, dispatch
  export.ts          the bundle you hand to a third party — hub outboxes included
  demo.ts, demoP2.ts, demoP3.ts, cli.ts
test/gate.test.ts    the 11 P1 acceptance checks
test/crdt.test.ts    P2: merge property tests (commutative/associative/idempotent)
test/hub.test.ts     P2: enrollment, a full L0 round, lifecycle, and the
                     end-to-end replay through the Python verifier
test/allocation.test.ts  P3: rule determinism, sealed-bid admission, reauction
                     sweep, and the end-to-end replay incl. three mutations
```

## The boundary

Agent brains implement `brains/port.ts` and nothing else. That file mentions no
ActivityPub, no signatures, no SQLite, no HTTP — the instance is the adapter
stack that implements the ports (01 § ports & adapters). **A brain that grows an
import from `../ap/` has broken the boundary**, and the design stops being
portable across instance implementations.

Two consequences worth keeping:

- Brains are swappable by configuration. The default runs a real model against
  an OpenAI-compatible endpoint; `AFP_BRAIN=stub` swaps in deterministic ones.
  **The record is identical in shape either way** — which is the port earning
  its keep, and why the acceptance gate can stay reproducible and offline while
  the demo talks to a model.
- Attachments are digest-verified by the adapter *before* a brain sees them. A
  brain never handles unverified evidence.

## Configuration

Environment variables, all optional (see `src/config.ts`):

| Variable | Default | Notes |
|---|---|---|
| `AFP_ORIGIN` | `https://alpha.operator.local` | The origin the instance publishes itself under |
| `AFP_DATA_DIR` | `./data` | SQLite file, keys, artifacts |
| `AFP_EXPORT_DIR` | `./export` | Where the bundle is written |
| `AFP_BRAIN` | `llm` | `llm` or `stub` |
| `AFP_LLM_BASE_URL` | `http://localhost:13305/api/v1` | Any OpenAI-compatible endpoint |
| `AFP_LLM_MODEL` | `Qwen3.6-35B-A3B-NoThinking` | |
| `AFP_LLM_MAX_TOKENS` | `900` | |
| `AFP_LLM_TIMEOUT_MS` | `120000` | |
| `AFP_MAX_DELIVERY_ATTEMPTS` | `5` | Before dead-lettering |
| `AFP_PORT` | `8787` | `npm run serve` |

`AFP_LLM_API_KEY` is read at the point of use and never stored, logged, or
written into the record. A local endpoint generally needs none.

## Model provenance

A `Result` produced by a model carries `afp:producedBy`:

```json
"afp:producedBy": "Qwen3.6-35B-A3B-NoThinking @ http://localhost:13305/api/v1"
```

Provenance otherwise stops at the agent–instance port (04 § Rationale
externalization) — an auditor can see *that* an agent made a claim but not what
made it. Naming the producer is the cheapest useful externalization available,
and it costs one field. A brain that is a rule engine or a human queue puts its
own identifier there.

## What this instance deliberately does not do yet

Federation agreements, real HTTP transport between instances, HTTP Signatures,
gossip anti-entropy, cross-operator bidding, Mastodon visibility. Those are
P4–P7. What P1 *does* carry is the whole integrity floor —
signing, hash-chained outboxes, visibility classes and hash-addressed evidence —
because those four are nearly free at two agents and cannot be backfilled later.

The HTTP surface is deliberately thin: actor documents and the roster are
`public` because verifying a signature requires fetching a key. Everything else
returns **404, not 403** — non-existence and non-authorisation have to be
indistinguishable, or probing yields a map of what exists.
