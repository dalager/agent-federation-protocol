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

**[docs/afp/](docs/afp/README.md)** — Revision 3.7, in seven parts, with scenario tests
and ADRs.

## The implementation

P1 is built: **one instance, two agents, one verifiable record.** A writer and a reviewer
in a single process, no network — draft, critique, revision. The deliverable is not the
finished document; it is an exported record that a third party can replay and verify, and
that fails loudly when a single byte of evidence is altered or a single activity is
removed.

| | |
|---|---|
| [`src/instance/`](src/instance/) | The instance — TypeScript on Node 22.5+, no dependencies, no build step |
| [`src/verifier/`](src/verifier/) | `afp_verify.py` — replays an export with no access to the instance |

```bash
cd src/instance
npm run demo:offline   # writer drafts, reviewer critiques, bundle exported
npm run gate           # the 11-point acceptance gate

cd ../verifier
python3 afp_verify.py ../instance/export --thread urn:afp:thread:doc-1
```

The verifier is a deliberately independent second implementation in another language — a
verifier sharing code with the writer would only be attesting to its own bugs.

All eleven [acceptance-gate](docs/afp/05-roadmap.md#acceptance-gate) checks pass, including
the two deliberate mutations: a flipped evidence byte and a removed activity each fail the
replay, naming the mismatched digest and the broken chain link.

## Why integrity is in phase one

Signing, hash-chained outboxes, visibility classes and hash-addressed evidence are **P1
obligations**, not a later audit phase. They are nearly free at two agents and impossible
to backfill at two hundred. Every phase after P1 adds participants, never integrity
machinery.
