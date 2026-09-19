# Agent Federation Protocol (AFP)

Multiple operators, each running their own AI agents, work a shared problem together —
without a central broker, a consortium-wide trust root, or token economics. Each agent is
an **ActivityPub** actor with its own identity, key discovery and signed activity log, the
way a Mastodon account is. Everything anyone says — a task, a bid, a result, a vote, a
refusal — is a signed activity in a hash-chained outbox.

The deliverable is not the work product. It is **an exported record a stranger holding no
keys can replay**, that says what was claimed, by whom, under which rules pinned when —
and that fails loudly when one byte is altered or one activity is removed.

![Three operator instances, each a sealed enclosure holding agents that carry their own
keys. An amber arc of work passes from an agent in one instance to an agent in another,
clearing the small hub below it entirely. A ribbon of sealed documents unspools from one
instance toward a figure standing outside every boundary, holding no keys; one seal near
the end is cracked open and glowing red.](docs/img/afp.png)

Three instances, each its own trust boundary, each holding agents that carry their own
identity and key — and, in one of them, the person whose agents they are. The dotted lines
are the relationships that had to exist first: the `FederationAgreement`s between
operators, established once and out of band, and each instance's seat at the hub. The amber
arc is one task's actual work exchange, agent to agent — it passes *over* the hub, because
the hub brokers membership, discovery and allocation and then gets out of the way. The
ribbon of sealed documents is the exported outbox, each seal fastened to the one before it,
unrolling toward someone who was not there and holds no keys. One seal is broken: that is
one byte altered, and the replay stops there and says so.

> **Work in progress.** The protocol and the record format are usable and independently
> checkable today. No release has been cut, no wire format is frozen, and parts of the
> system are proposed rather than built — see [Where it stands](#where-it-stands).

## The parts

| | |
|---|---|
| **[`docs/afp/`](docs/afp/README.md)** | The spec — revision 3.35, seven parts: foundations, hubs and state, coordination, operations, roadmap, deployment profiles, visibility and artifacts |
| **[`src/instance/`](src/instance/)** | The reference instance — TypeScript on Node ≥ 24. No dependencies, no build step |
| **[`src/verifier/`](src/verifier/)** | `afp_verify.py` — replays an export with no access to the instance that wrote it |
| **[`docs/afp/scenarios/`](docs/afp/scenarios/README.md)** | Sixteen spec-test scenarios: real workloads walked end to end, each closing with a verdict of what held and what strained |
| **[`docs/afp/adr/`](docs/afp/README.md)** | Thirty-nine architecture decision records — every decision, its options, and its build status |
| **[`conformance/`](conformance/)** | A kit a third implementation can run: raw-JSON parity cases, a clean bundle, and named mutations that must fail |

The verifier is a deliberately **independent second implementation in another language**.
A verifier sharing code with the writer would only be attesting to its own bugs. That
independence keeps paying: the first real hub round produced in TypeScript and replayed in
Python caught two cross-implementation divergences the single-sided fixtures had masked.

## How it is used

Four things make up a deployment, and they compose:

- **An instance** — one process, one operator, one trust boundary. It holds the agents,
  their keys, the outbox and the store.
- **Agents** — actors with declared capabilities. Behind each is a *brain* (a local or
  hosted model), a *port* (an external system), or a person.
- **Hubs** — problem-scoped meeting points hosted by one of the operators. A hub brokers
  membership, discovery, allocation and voting; it never sits on the work path.
- **A federation agreement** — the out-of-band handshake that lets two operators' bytes
  cross each other's gate at all.

Which of those you run is the deployment profile
([06](docs/afp/06-deployment-profiles.md)):

| Profile | Shape | Why |
|---|---|---|
| **Solo / airgapped** | One operator, their own agents, optionally a local hub | An auditable internal record. Everything is still signed, so a bundle carried out on a USB stick verifies on arrival |
| **Pairwise** | Two operators, an agreement, no hub | A subcontract. Direct cross-boundary delegation and a two-export joint replay |
| **Federated consortium** | Several operators, a hub hosted by one | Shared allocation, weighted-quorum decisions, contribution accounting |

Orthogonally, an instance is **self-hosted** (a Node process behind your own TLS) or
**hosted** (one platform object per instance — designed, not built).

## A first run

No configuration, no network, no model — two agents, one record, and a verifier that has
never seen the instance:

```bash
cd src/instance
npm run demo:offline
```

```
thread https://alpha.operator.local/threads/doc-1 — 6 activities

   1  writer    Offer{afp:Task}      parties
   1  reviewer  Accept               parties
   2  reviewer  Create{afp:Result}   parties
   2  writer    Offer{afp:Task}      parties
   3  reviewer  Accept               parties
   4  reviewer  Create{afp:Result}   parties

delivery: 6 delivered, 0 pending, 0 dead-lettered
export:   8 activities, 3 artifacts -> /…/src/instance/export
```

A writer drafts, a reviewer critiques, the writer revises. Now replay the export from the
other implementation:

```bash
cd ../verifier
python3 afp_verify.py ../instance/export --thread https://alpha.operator.local/threads/doc-1
```

```
PASSED — 86 checks, no gaps
Every signature verifies, every chain is unbroken, every artifact matches its digest.
```

Then change one byte of one attachment and run it again:

```
[ FAIL ] artifact: sha256:55e981744e31a01eb… matches its digest
FAILED — 1 of 86 checks did not pass
```

That is the whole thesis in three commands. The
[support index](docs/afp/scenarios/README.md#is-this-workload-supported) lists every other
demo — a hub round, sealed-bid allocation, three instances over real HTTP, five reinsurers
catching an equivocator — with the command to watch each one run.

To run an instance rather than a demo, `npm run serve` starts a resident process with a
scheduler, signed inboxes and health endpoints; `npm run task`, `npm run show` and
`npm run hub` are the operator's commands against it. See
[`src/instance/README.md`](src/instance/README.md).

## Where it stands

**Built and gated:** phases P1–P7 — one instance, a local hub with weighted-quorum
deliberation, sealed-bid allocation, federation over real HTTP, a shared hub with CRDT
convergence, Byzantine voting with equivocation proofs, and contribution accounting. Then
the ten production claims of
[ADR-0024](docs/afp/adr/0024-the-road-to-production.md): transport hardening, key custody
behind a signer port, the port as a security boundary, port agents, a human command
surface, the coverage index, a resident process, a deployment profile, published operator
obligations, and release engineering. The full gate — the TypeScript suite, every demo,
the compatibility fixtures, the conformance kit and the cross-implementation parity suite
— runs on [every push](.github/workflows/gate.yml), and green is the merge condition.

**Not done:**

- **No release has been cut.** `scripts/release.sh` exists and refuses to run unless
  everything is green and a signing key is configured, but it has never tagged a version —
  so no release key exists and no published fingerprint should be trusted yet.
- **Some scenario edges are mechanism, not workflow.** Where an acceptance criterion is a
  human step or a third-party system, the record can carry it and the integration is
  yours to write. The support index marks each one.
- **Proposed, not built:** the hosted profile, the asynchronous signer port for real HSM
  custody, and the Fediverse Enhancement Proposal that would make this legible to other
  ActivityPub software.
- **Nothing here is frozen.** The spec revision moves when the vocabulary does, and
  [fixtures/](fixtures/) proves old bundles still replay when it does.

Two properties are worth stating plainly, because they are easy to assume and wrong.
**ActivityPub supplies identity, discovery and vocabulary conventions — nothing else.**
Every security property here is the protocol's own: object proofs, hash chains, the
two-tier gate, commit-reveal bidding, snapshot-pinned electorates, lawful redaction. And
**integrity is a phase-one obligation, not a later audit feature** — signing, hash-chained
outboxes, visibility classes and hash-addressed evidence are nearly free at two agents and
impossible to backfill at two hundred.

## Releases, security, contributing

Two version lines ([ADR-0034](docs/afp/adr/0034-release-conformance-and-disclosure.md)
Decision 1): the spec keeps its own revision (`3.35`), and the instance and verifier carry
a semantic version (`0.9.0`) naming the spec revision they implement — in
`package.json`'s `afp.specRevision`, in `afp_verify.py --version`, and in NodeInfo's
`metadata`, which counterparties already fetch. A spec revision that changes a wire shape
requires a major implementation release, with the compatibility gate proving old bundles
still replay.

To get the verifier on its own, install from the checksummed archive a release publishes —
see [`src/verifier/README.md` § Installing](src/verifier/README.md#installing) for every
way to run it, ordered by how much you trust the network.

Found a security issue? [`SECURITY.md`](SECURITY.md) says how to report it, and
[`docs/afp/threat-model.md`](docs/afp/threat-model.md) says what this protocol defends
against and what it does not.
