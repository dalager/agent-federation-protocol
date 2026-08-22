# AFP reference instance — P1 + P2 + P3 + P4

**P1**: one instance, two agents, one verifiable record — no network
([05 § P1](../../docs/afp/05-roadmap.md#p1--one-instance-two-agents-one-verifiable-record)).
**P2**: a local hub beside the agents — enrollment, hub-scoped CRDT state, and
L0 weighted-quorum deliberation closing with a signed `afp:DecisionRecord`
([ADR-0002](../../docs/afp/adr/0002-p2-hub-and-crdt-stack.md)).
**P3**: local allocation — sealed commit-reveal bidding, a published
deterministic selection rule (ranking or coverage set-selection), a
recomputable `afp:Award` with coalition + synthesizer, ratified `afp:Synthesis`,
and `afp:Settlement` ([ADR-0003](../../docs/afp/adr/0003-p3-allocation-stack.md)).
**P4**: federation — two instances, real HTTP, HTTP-Signature-authenticated
inboxes, `afp:FederationAgreement` handshakes, a grant-checking boundary gate
with a hash-chained refusal log
([ADR-0008](../../docs/afp/adr/0008-p4-federation-stack.md)), and the
federated joint replay with lawful redaction
([ADR-0009](../../docs/afp/adr/0009-federated-replay.md)).

```bash
npm run demo          # P1: writer drafts, reviewer critiques, bundle exported
npm run demo:offline  # the same, against deterministic brains
npm run demo:p2       # P2: 30 agents agree on the best policy (-> ./export-p2)
npm run demo:p3       # P3: two auctions, coalition award, synthesis (-> ./export-p3)
npm run demo:p3:llm   # the same auction, answers written by a real local model
npm run demo:p4       # P4: three instances over real HTTP, one boundary (-> ./export-p4)
npm run demo:p5       # P5: a shared hub with a real inbox, replica sync (-> ./export-p5)
npm run gate          # the acceptance gate: P1's 11 checks + CRDT + hub + auction + boundary
npm run serve         # the public HTTP surface + the federation inbox
```

Requires **Node 22.5+** (24+ recommended). No build step — Node runs the
TypeScript directly — and **no dependencies at all**: `node:crypto` covers
Ed25519, `node:sqlite` covers the store, and the model endpoint is plain
`fetch` against an OpenAI-compatible API rather than a vendor SDK.

## The demo

```
thread https://alpha.operator.local/threads/doc-1 — 6 activities

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
python3 ../verifier/afp_verify.py export --thread https://alpha.operator.local/threads/doc-1
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
round https://alpha.operator.local/rounds/codebase-integrity — 30 enrolled, 27 votes counted

  signed-commits   ███████████████ 15
  review-quorum    █████████ 9
  trunk-freeze     ███ 3
  abstain          ███ 3

outcome:  signed-commits
```

The hub is vouched onto the roster like any agent (self-custody), so the
export replays with no special case:

```bash
python3 ../verifier/afp_verify.py export-p2 --thread https://alpha.operator.local/threads/codebase-integrity
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
commit-reveal (`afp:BidCommit` → `afp:BidReveal`, commitment =
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
python3 ../verifier/afp_verify.py export-p3 --thread https://alpha.operator.local/threads/q-88-migration-estimate
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

### Running it with a real model

`npm run demo:p3:llm` runs the same estimation auction with the coalition's
partial answers and the Synthesis produced by a local model (any
OpenAI-compatible endpoint; see Configuration). The machinery — bids, sealing,
selection, ratification — is byte-for-byte the deterministic path; only the
words change, and the export passes the identical verifier checks. Runs so far
have also demonstrated *why* Synthesis is ratified rather than trusted: a
small model occasionally combines the partial ranges wrongly, and that
discretion is exactly what the L0 round and the recorded dissent exist to
catch.

## The P4 demo

Three instances come up on real localhost ports, each its own trust boundary —
Alpha (`a-lead`), Beta (`b-assessor`, `b-private`), and Mallory (`m-probe`).
Nothing is mocked: real HTTP, real Ed25519 HTTP Signatures on every inbox POST,
real SQLite state per operator (under `./data-p4/`).

```
agreement: alpha <-> beta, direct-delegation grant for afp:cap:assess
           dual-Create, expires 2026-08-17T10:00:05.000Z

mallory's signed probe:   inbox POST … refused: 403
mallory's unsigned POST:  401 before the gate ever runs

delegation https://alpha.operator.local/threads/sub-1 — alpha's record:
   1  a-lead     Offer{afp:Task}  (own outbox)
   -  b-assessor Accept  (received across the boundary)
   -  b-assessor Create{afp:Result}  (received across the boundary)

beta's boundary log (1 entries, hash-chained):
  agreement  no agreement with http://…/actor — hard reject, unopened
```

The story, in order:

1. **Handshake** — Alpha and Beta each publish a signed
   `Create{afp:FederationAgreement}` over one byte-identical object
   (dual-Create). One Create is an offer on the record, not a permission;
   nothing is active until both exist.
2. **The gate** — Mallory's Offer is validly signed but party to no agreement:
   hard 403, and the refusal lands in Beta's hash-chained boundary log. An
   unsigned POST gets 401 before the gate even runs. A read of a
   `parties`-scoped record gets **404, not 403** — while actor documents stay
   public, because fetching a counterparty's key is the bootstrap.
3. **Delegation** — the P1 Offer/Accept/Result flow, with a firewall in it.
   Beta's Accept and Result cross back through Alpha's signed inbox; admitted
   foreign activities live in Alpha's *received* store, never in its own chain.
4. **Two exports, one engagement** — Alpha exports in full. Beta exports
   *scoped*: only the handshake and engagement threads, with another client's
   work replaced in chain position by digest-only `afp:Redacted` stubs and an
   uninvolved agent (`b-private`) listed as a declared omission in the
   manifest. Discretion is lawful; deletion is not.

The auditor's two folders become one command:

```bash
python3 ../verifier/afp_verify.py export-p4/alpha export-p4/beta --verbose
# PASSED — 100 checks, no gaps
```

The joint replay checks what neither bundle can prove alone: the agreement
object is digest-equal in both exports (no two-story agreements), every
received activity matches the sender's own record byte for byte (no
divergence), every redaction stub declares the digest it stands in for (no
silent deletion), and every cross-boundary activity was admitted by a named
grant. `test/adr0009.test.ts` breaks each of these one at a time and asserts
the verifier fails by name.

## The P5 demo

Three operators, one shared hub. Alpha hosts the `bridge` and serves it at a real
inbox (`POST /hubs/bridge/inbox` — the same boundary implementation as every other
inbox, ADR-0016 Decision 1); Bravo and Gamma enroll their agents across the boundary
through it. Real HTTP, real signatures, real SQLite per operator (under `./data-p5/`).

```
the write door (ADR-0016 Decision 2):
  unenrolled agent, valid operator      403 {"error":"refused"}
  same write, valid membership proof    403 — identical: the proof is a read credential
  enrolled observer's vote              202 at the door, dead in the handler
replica convergence:  seats 0 bare -> 5 after one pull -> 5 after a second (idempotent)
the kill criterion:   in-flight mesh work completes; a new hub write gets ECONNREFUSED
```

The story, in order:

1. **The hub gets an inbox** — foreign enrollments and votes arrive as signed POSTs
   through the P4 boundary, then meet one extra check: the write door. Enrollment is
   admission, from the hub's own record; role is authority, enforced in the handlers
   — which is why the observer's vote is admitted at the door and never tallied.
2. **The proof stays a read credential** — a valid `afp:MembershipProof` on a write
   changes nothing. It exists for a third party that cannot ask the hub; on a write,
   the hub is the one being asked.
3. **Replica sync carries activities** — Bravo's bare replacement bridge
   (`replicaOf`) converges from nothing: `Offer{afp:Digest}` of per-store version
   vectors, answered by `Accept{afp:StateDeltas}` carrying the signed activities that
   moved the stores — governing activities for protocol stores, an explicit
   `Update{afp:CRDTDelta}` for the demo's `app:backlog` — re-derived through the same
   `receive`. A second pull is a no-op; liveness never syncs.
4. **The kill criterion** — in-flight mesh work completes (payload runs member to
   member), and a new write toward the dead hub fails to its caller — visible
   degradation (ADR-0014 Decision 2), never a queue's silence.

Three case files, one auditor command — the first joint replay whose counted votes
genuinely crossed a boundary: the foreign votes are received bytes in the hub host's
bundle, resolved from the thread pool and signature-verified in phase two against
each sender's own bundle (ADR-0016's T8 amendment):

```bash
python3 ../verifier/afp_verify.py export-p5/alpha export-p5/bravo export-p5/gamma \
    --thread https://alpha.operator.local/threads/incident-9 --verbose
# PASSED — 365 checks, no gaps
```

## Using a running instance

`npm run serve` starts the real HTTP surface — the same one the P4 demo runs
three of. What it exposes:

```
GET  /actor                     the instance actor document (public — carries the key)
GET  /roster                    the signed roster, derived from the Vouch trail
GET  /agents/:name              an agent's actor document (public)
GET  /agents/:name/outbox       that agent's outbox — public activities only
POST /actor/inbox               the federation inbox (instance-level)
POST /agents/:name/inbox        the federation inbox (agent-level)
```

Reads are open but filtered: an unauthenticated fetch sees only `public`
activities, and anything above that returns 404 — non-existence and
non-authorisation are indistinguishable by design.

Writes are the boundary. Every inbox POST passes, in order:

1. **HTTP Signature verification** (`(request-target) host date digest`,
   Ed25519) — the signer's key is resolved by unauthenticated fetch of its
   actor document. Fails → 401.
2. **The agreement gate** — the sender's instance must hold an active
   `afp:FederationAgreement` with this one, carrying a grant that admits this
   activity's type/capability. Handshake traffic (`Offer`/`Create` over an
   `afp:FederationAgreement` object) bypasses the grant check — it is the
   door-knock — but never the signature check or the deny-list. Fails → 403,
   and an entry in the hash-chained boundary log.
3. **The same dispatch local delivery feeds** — dedupe, task table, brains.

### Wiring two instances together

Each operator sets an origin and a port, then serves:

```bash
# terminal 1 — Alpha
AFP_ORIGIN=http://127.0.0.1:8787 AFP_PORT=8787 AFP_DATA_DIR=./data-alpha npm run serve

# terminal 2 — Beta
AFP_ORIGIN=http://127.0.0.1:8788 AFP_PORT=8788 AFP_DATA_DIR=./data-beta npm run serve
```

`AFP_ORIGIN` must be the URL the *other* side can actually reach — it is baked
into every actor id and key id, so signature verification resolves keys through
it. (In production it is your public HTTPS origin; the two `127.0.0.1` origins
above are the local two-terminal case.)

A cold instance answers GETs immediately:

```bash
curl -s http://127.0.0.1:8787/actor | python3 -m json.tool   # the key is in assertionMethod
curl -s http://127.0.0.1:8787/roster | python3 -m json.tool
curl -s http://127.0.0.1:8787/agents/writer/outbox
```

But its inbox admits nothing yet — there is no agreement. Establishing one is
a *recorded act by both operators*, not a config entry: each side publishes a
signed `Create{afp:FederationAgreement}` over the byte-identical object and
delivers it to the other's inbox. There is deliberately no
`afp federate <url>` one-shot command — an agreement that one side could
manufacture alone would not be an agreement. The programmatic sequence is:

```ts
const object = agreementObject({ parties: [selfActorId, otherActorId], grants, expires });
const create = instance.publishAsInstance([otherActorId], thread, "parties",
  (envelope) => createAgreement(envelope, object));
federation.recordOwnCreate(object, create.activity);
await instance.run(transport);   // your Create crosses; theirs activates the row on arrival
```

`src/demoP4.ts` is the working reference for the full wiring — operator setup
(~40 lines), handshake, delegation, and the scoped export. Adapt it rather
than reinventing it; `test/adr0008.test.ts` additionally exercises expiry,
deny-listing, and the in-flight-work exception. `src/demoP5.ts` extends the
same wiring with a hosted hub (the `hubs` server option), the hub-inbox write
path, and replica sync; `test/adr0016.test.ts` is its gate.

Once an agreement is active, cross-boundary work is the ordinary P1 flow:
publish an `Offer{afp:Task}` addressed to the counterparty's agent and run the
HTTP transport; their Accept/Result arrive back through your inbox, verified
and gate-checked, into your received store. At any point, export
(`npm run export`, or `exportBundle(...)` with a scope) and hand the folder —
or both operators' folders together — to the Python verifier.

## Defining the agent collection

`src/profiles.ts` is the recipe: **one `AgentProfile` per agent, from which
everything the record carries about it is derived** — the Vouch/roster
capabilities, the hub enrollment, the sealed bid's `afp:coverage` and cost
posture, and (in LLM mode) the persona woven into the system prompt. A fact
stated twice — what the agent claims vs. what its prompt says it is — is a
place where claim and behavior drift; deriving both from one declaration is
what keeps the record honest.

Three layers, because the protocol consumes them differently:

| Layer | Granularity | Where it lands | Who checks it |
|---|---|---|---|
| `capabilities` | coarse, stable (`afp:cap:estimate`) | Vouch → roster, Enroll → hub OR-Map, Announce filter | routing only — an open vocabulary, nothing verifies it |
| `coverage` | domain → integer-percent confidence | inside the sealed bid payload | the selection rule at award, and `afp:Settlement` after actuals — declare only confidences you are willing to be graded on |
| `persona` | one sentence of free text | the LLM system prompt | the ratification round, when its Synthesis exercises discretion |

Collection-level rules enforced or exercised by the panel:

- `assertCoverage()` runs at demo start: the non-estimator profiles must
  jointly cover every announced domain at the confidence floor, or the run
  fails at build time instead of as a dead auction.
- Overlap is a feature — two profiles claiming `compliance` gives the coverage
  rule real choices and the synthesizer a cross-check.
- A profile with an **empty coverage map** is the on-record decliner: capable
  of the task class, covering none of these domains, so it `Reject`s within
  the bid window instead of staying silent.
- A profile flagged `estimator: true` is listed in the announce's
  `afp:estimators` and rejected at bid admission under the `exclude` policy —
  the separation is data in the record, so a verifier checks it was applied.

Capability ids are **not** protocol vocabulary: AFP defines the machinery
around capability strings (declaration, matching, settlement) but no catalogue
of names. Keep your own registry small and namespaced.

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
  federation/        P4: the boundary (ADR-0008/0009)
    federation.ts    agreements (dual-Create), gate outcomes, boundary log,
                     received store, deny-list — all in the same SQLite file
    httpSig.ts       HTTP Signatures ((request-target) host date digest, Ed25519)
    transport.ts     the delivery port over real HTTP; local targets short-circuit
    inbox.ts         the receiving half: verify, then gate, then dispatch
    grants.ts        which grant admits which activity — and summarize() for logs
    ingest.ts        what crosses is sandboxed and summarized, never trusted
    visibility.ts    what an authenticated counterparty may read
  profiles.ts        agent profiles: one declaration per agent — roster
                     capabilities, bid coverage, cost posture, persona — plus
                     the collection-level coverage assertion
  instance.ts        the adapter stack: signing, chain, gate, dedupe, dispatch
  export.ts          the bundle you hand to a third party — hub outboxes included
  demo.ts, demoP2.ts, demoP3.ts, demoP4.ts, demoP5.ts, experimentP3.ts, cli.ts
test/gate.test.ts    the 11 P1 acceptance checks
test/crdt.test.ts    P2: merge property tests (commutative/associative/idempotent)
test/hub.test.ts     P2: enrollment, a full L0 round, lifecycle, and the
                     end-to-end replay through the Python verifier
test/allocation.test.ts  P3: rule determinism, sealed-bid admission, reauction
                     sweep, and the end-to-end replay incl. three mutations
test/adr0008.test.ts P4: two instances over real HTTP — handshake, probe,
                     delegation, expiry, deny-list, boundary-log chain
test/adr0009.test.ts P4: the federated joint replay, plus four named breakages
                     (silent deletion, divergence, two-story agreement, blank stub)
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

Gossip anti-entropy, cross-operator hubs and bidding, Mastodon visibility.
Those are P5–P7. Federation agreements, real HTTP transport, and HTTP
Signatures landed with P4. What P1 *does* carry is the whole integrity floor —
signing, hash-chained outboxes, visibility classes and hash-addressed evidence —
because those four are nearly free at two agents and cannot be backfilled later.

The HTTP surface is deliberately thin: actor documents and the roster are
`public` because verifying a signature requires fetching a key. Everything else
returns **404, not 403** — non-existence and non-authorisation have to be
indistinguishable, or probing yields a map of what exists.
