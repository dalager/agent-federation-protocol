# AFP P1 — reference instance

One instance, two agents, one verifiable record. No hub, no agreements, no
bidding, no voting, no network — see
[05-roadmap.md § P1](../../docs/afp/05-roadmap.md#p1--one-instance-two-agents-one-verifiable-record).

```bash
npm run demo    # writer drafts, reviewer critiques, bundle exported
npm run gate    # the 11-point acceptance gate
npm run serve   # the public HTTP surface
```

Requires **Node 22.5+** (24+ recommended). No build step — Node runs the
TypeScript directly — and no runtime dependencies: `node:crypto` covers Ed25519
and `node:sqlite` covers the store. The Anthropic SDK is optional and only
needed to put a real model behind the agent port.

## The demo

```
thread urn:afp:thread:doc-1 — 6 activities

   1  reviewer  Offer{afp:Task}      parties
   1  writer    Accept               parties
   2  writer    Create{afp:Result}   parties
   3  writer    Offer{afp:Task}      parties
   2  reviewer  Accept               parties
   3  reviewer  Create{afp:Result}   parties
```

Then hand `export/` to someone who was not there:

```bash
python3 ../verifier/afp_verify.py export --thread urn:afp:thread:doc-1
# PASSED — 30 checks, no gaps
```

The deliverable is not the finished document. It is a record a stranger can
verify and a forger cannot quietly edit — produced by a system with two agents
and no network.

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
    anthropic.ts     the same port with a real model behind it
  instance.ts        the adapter stack: signing, chain, gate, dedupe, dispatch
  export.ts          the bundle you hand to a third party
  demo.ts, cli.ts
test/gate.test.ts    the 11 acceptance checks
```

## The boundary

Agent brains implement `brains/port.ts` and nothing else. That file mentions no
ActivityPub, no signatures, no SQLite, no HTTP — the instance is the adapter
stack that implements the ports (01 § ports & adapters). **A brain that grows an
import from `../ap/` has broken the boundary**, and the design stops being
portable across instance implementations.

Two consequences worth keeping:

- Brains are swappable by configuration. `AFP_BRAIN=anthropic` puts a real model
  behind the same port; the record is identical in shape either way.
- Attachments are digest-verified by the adapter *before* a brain sees them. A
  brain never handles unverified evidence.

## Configuration

Environment variables, all optional (see `src/config.ts`):

| Variable | Default | Notes |
|---|---|---|
| `AFP_ORIGIN` | `https://alpha.operator.local` | The origin the instance publishes itself under |
| `AFP_DATA_DIR` | `./data` | SQLite file, keys, artifacts |
| `AFP_EXPORT_DIR` | `./export` | Where the bundle is written |
| `AFP_BRAIN` | `stub` | `stub` or `anthropic` |
| `AFP_ANTHROPIC_MODEL` | `claude-sonnet-5` | |
| `AFP_MAX_DELIVERY_ATTEMPTS` | `5` | Before dead-lettering |
| `AFP_PORT` | `8787` | `npm run serve` |

`ANTHROPIC_API_KEY` is read at the point of use and never stored, logged, or
written into the record.

## What P1 deliberately does not do

Hubs, federation agreements, bidding, voting, CRDTs, gossip, HTTP Signatures,
Mastodon. Those are P2–P7. What P1 *does* carry is the whole integrity floor —
signing, hash-chained outboxes, visibility classes and hash-addressed evidence —
because those four are nearly free at two agents and cannot be backfilled later.

The HTTP surface is deliberately thin: actor documents and the roster are
`public` because verifying a signature requires fetching a key. Everything else
returns **404, not 403** — non-existence and non-authorisation have to be
indistinguishable, or probing yields a map of what exists.
