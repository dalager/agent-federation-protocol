# Agent Federation Protocol (AFP)

Multiple operators, each running their own agents, join forces on a common problem —
federating through problem-scoped hubs over **ActivityPub**, the W3C protocol behind
Mastodon. No central broker, no consortium-wide trust, no token economics.

![Three operator instances, one problem hub. The work exchange runs directly between
instances; the hub sits on neither the task nor the result path. The signed, hash-chained
outbox unrolls toward someone who was not there.](docs/img/afp-hero-nanob.png)

Three instances, each its own trust boundary. Dotted lines are `FederationAgreement`s,
established once and out of band. The amber arc is one task's actual work exchange — it
passes *over* the hub, because the hub brokers discovery and allocation and then gets out
of the way. The chain of sealed blocks is the outbox export, ending in front of a stranger
holding no keys.

## The spec

**[docs/afp/](docs/afp/README.md)** — Revision 3.29, in seven parts, with scenario tests
and ADRs.

Eleven **spec-test scenarios** walk real workloads end to end and record what strained;
every finding they raised is closed, and the
[support index](docs/afp/scenarios/README.md#is-this-workload-supported) says which decision
closed it and what to run to watch it work. The scenarios themselves are never rewritten
when their findings land — a walkthrough is the record of what was true when it was walked,
which is what makes it evidence rather than a brochure.

## The implementation

**P1 is built** — one instance, two agents, one verifiable record. A writer and a reviewer
in a single process, no network — draft, critique, revision. The deliverable is not the
finished document; it is an exported record that a third party can replay and verify, and
that fails loudly when a single byte of evidence is altered or a single activity is
removed.

**P2 is built** — local hub & L0 deliberation. An `afp:Hub` beside the agents (same
process, same dispatch port), two-level enrollment, hub-scoped CRDT state with version
vectors, and weighted-quorum rounds pinned to a membership snapshot, each closing with a
signed `afp:DecisionRecord` whose tally any member — or stranger — recomputes from the
record alone. Stack: [ADR-0002](docs/afp/adr/0002-p2-hub-and-crdt-stack.md).

**P3 is built** — local allocation. `Announce{Task}` with the selection rule published up
front, sealed commit-reveal bidding (`sha256(JCS(bid))`, mandatory nonce), a small
registry of pure selection rules — ranking, and coverage set-selection naming a coalition
plus its synthesizer — an `afp:Award` any member recomputes, award timeout swept into a
recorded `afp:Reauction`, `afp:Synthesis` with first-class dissent ratified by an L0
round, `afp:Settlement` linking estimates to actuals, and the estimator/bidder wall
enforced at bid admission. Both rule families are independently reimplemented in the
Python verifier, which rebuilds the admitted bid pool from the record alone. Stack:
[ADR-0003](docs/afp/adr/0003-p3-allocation-stack.md).

**P4 is built** — federation. Two instances, each its own trust boundary, over real HTTP:
HTTP-Signature-authenticated inboxes, `afp:FederationAgreement` established by dual-Create
over one byte-identical object, a grant-checking gate whose refusals land in a hash-chained
boundary log, and lawful redaction at export — digest-only stubs in chain position, omitted
actors declared in the manifest. Both operators' bundles replay as one verifier command
that catches divergence, silent deletion, and two-story agreements by name. Stack:
[ADR-0008](docs/afp/adr/0008-p4-federation-stack.md),
[ADR-0009](docs/afp/adr/0009-federated-replay.md).

**P5 is built** — the shared hub. The hub becomes somebody's server with its own inbox:
`POST /hubs/:id/inbox` is the same boundary implementation every foreign byte crosses,
plus one write door — enrollment from the hub's own record, with `afp:MembershipProof`
deliberately not consulted (a proof is for whoever cannot ask the hub; on a write, the
hub is the one being asked). Members prove enrollment to third parties portably, degrade
to the P4 mesh when the host partitions, and reconcile back on the record. Cross-instance
CRDT sync carries the signed activities that moved the stores — never bare deltas — over
`Offer{afp:Digest}` / `Accept{afp:StateDeltas}`, answered from a provenance table of ids.
Kill the hub mid-task and new allocation stalls while in-flight work completes, because
the hub never sat on the payload path. Stack:
[ADR-0014](docs/afp/adr/0014-p5-shared-hub-stack.md),
[ADR-0015](docs/afp/adr/0015-the-case-file-at-n-parties.md),
[ADR-0016](docs/afp/adr/0016-p5-transport.md).

| | |
|---|---|
| [`src/instance/`](src/instance/) | The instance — TypeScript on Node 22.5+, no dependencies, no build step |
| [`src/verifier/`](src/verifier/) | `afp_verify.py` — replays an export with no access to the instance |

```bash
cd src/instance
npm run demo:offline   # P1: writer drafts, reviewer critiques, bundle exported
npm run demo:p2        # P2: 30 agents agree on the best policy — DecisionRecord + export
npm run demo:p3        # P3: two sealed auctions, a coalition award, a ratified Synthesis
npm run demo:p4        # P4: three instances over real HTTP — handshake, probe, delegation, joint export
npm run demo:p5        # P5: a shared hub with a real inbox — the write door, replica sync, the kill criterion
npm run demo:p5:llm    # the same hub, told as a snow day: three schools, one bus company, one decision
npm run demo:p6        # P6: five reinsurers at L1 — an equivocator convicted, a backup-restore acquitted
npm run demo:p6:llm    # the same pool, with the underwriters' verdicts written by a local model
npm run gate           # the acceptance gate: P1's 11 checks, CRDT property tests, hub, auction, boundary

cd ../verifier
python3 afp_verify.py ../instance/export --thread "https://alpha.operator.local/threads/doc-1"
python3 afp_verify.py ../instance/export-p2 --thread "https://alpha.operator.local/threads/codebase-integrity"
python3 afp_verify.py ../instance/export-p3 --thread "https://alpha.operator.local/threads/q-88-migration-estimate"
python3 afp_verify.py ../instance/export-p4/alpha ../instance/export-p4/beta --verbose
python3 afp_verify.py ../instance/export-p5/alpha ../instance/export-p5/bravo ../instance/export-p5/gamma --verbose
python3 afp_verify.py ../instance/export-p6/{atlas,meridian,pelican,anchor,harbor} --verbose
```

The verifier is a deliberately independent second implementation in another language — a
verifier sharing code with the writer would only be attesting to its own bugs. That
independence keeps paying: the P2 end-to-end (a real TypeScript-produced hub round
replayed by the Python verifier) caught two cross-implementation divergences the
single-sided fixtures had masked.

All [acceptance-gate](docs/afp/05-roadmap.md#acceptance-gate) checks pass, including the
four deliberate P1 mutations, P2's three DecisionRecord mutations, and P3's three award
mutations (a deleted winning reveal, a swapped performer set, mismatched winning-bid
evidence) — each fails the replay with a specific pointer.

## Why integrity is in phase one

Signing, hash-chained outboxes, visibility classes and hash-addressed evidence are **P1
obligations**, not a later audit phase. They are nearly free at two agents and impossible
to backfill at two hundred. Every phase after P1 adds participants, never integrity
machinery.
