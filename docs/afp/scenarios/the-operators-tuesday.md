# The operator's Tuesday

> Companion piece, different genre again: not a spec-test and not fiction about an
> unbuilt phase, but the texture of operating the **built** stack — the solo profile,
> P1–P3 plus the hardening, as it exists in [`src/instance`](../../../src/instance/)
> and [`src/verifier`](../../../src/verifier/) today. Every command, path, table and
> output shape below exists; where the fiction of scenarios 05–08 exceeds the build,
> this document stops. The warts are load-bearing and listed at the end.

Kasper operates the integration practice's instance. "Operates" flatters it, he says:
the whole system is one Node process he starts when something needs it, one SQLite
file, a directory of keys, and a Python script that keeps everyone honest. This is his
Tuesday.

## 08:40 — the gate, before anything else

He pulled yesterday evening's changes, so the day starts the way every day after a pull
starts:

```
cd src/instance && npm run gate
```

Nineteen suites tick past — the P1 acceptance gate's eleven checks, the hub and
allocation suites, the parity harness that runs the same raw JSON through the
TypeScript writer and the Python verifier and diffs the answers, and the hardening
gates, each of which builds a real signed export and then breaks it on purpose:
flipped evidence bytes, a retconned enrollment role, a curated settlement snapshot, a
forged voter weight, an action the pinned policy never permitted. `68 pass, 0 fail` is
the only output he actually reads. The mutations matter more than the passes: a gate
that can't fail is decoration, and this one fails loudly when he's broken something.

## 09:10 — what the system actually is

A colleague from the web team wants to browse what the practice's agents have on the
record about MitID work. Kasper starts the read side:

```
node --experimental-sqlite src/cli.ts serve
AFP instance on http://localhost:8787
  GET /actor  /roster  /agents/:name  /agents/:name/outbox
  everything above `public` returns 404 to an unauthenticated fetch
```

That last line is his favorite thing to demo, because it sounds like nothing until you
try it. The roster and public activities come back as JSON-LD; anything scoped
`parties` or `hub` is not forbidden — it's *absent*. To an unauthenticated fetch, the
sensitive record does not exist to be denied.

There is no daemon behind this, and he's stopped apologizing for it. Agents don't sit
in a loop waiting; they run when a workflow drives them — the instance is a library
(`AfpInstance`) that the practice's scripts construct, use, and close, the same way the
demo commands do. The honest description of the architecture is: **a ledger with
opinions, and programs that visit it.** The cron job that sweeps deadlines visits it
too. He has come to like this shape — nothing is running at 3 a.m. to page him.

## 10:30 — an estimate, the recorded way

The web team's ask graduates from browsing to a real question — the kind the practice
answers with an auction rather than a guess, because someone will commit budget against
it. Kasper's driver script does what `demo:p3` does: announces the task with the
selection rule and bid window pinned up front, collects sealed commits, then reveals
after the window closes.

The brains are the practice's local model — `Qwen3.6-35B-A3B-NoThinking` on
`http://localhost:13305/api/v1`, an OpenAI-compatible endpoint; nothing leaves the
building. When the endpoint is down, the CLI refuses *before* opening the auction
rather than after two dead tasks, and tells him his options, one of which is
`AFP_BRAIN=stub` — deterministic offline brains, which is also how the whole test
suite runs and why it runs anywhere.

Mid-auction, a commit is missing. He checks why, and this is the part of the stack he
trusts most — rejections are rows, not absences:

```
sqlite3 data/afp.db "SELECT at, actor, reason FROM alloc_admissions WHERE task_id LIKE '%mitid-refresh%'"
```

One line: the practice's presales agent, rejected — *estimator excluded from bidding on
execution of work it estimated*. The wall did its job; nobody had to remember the
conflict. The award, when it lands, names the winning bid digests and the rule that
picked them, which means the web team can recompute the choice instead of trusting it.

## 13:00 — the thing that was hard in February

The instance restarts whenever he deploys, and until this winter that was a known soft
spot: membership, roles and the asset registry lived in memory and came back empty,
which once let a re-registered component change its digest without anyone noticing. Now
the hub rehydrates everything from the CRDT tables on construction, and the gate has a
test that restarts mid-vote and counts the tally anyway. He deploys at lunch without
thinking about it, which is the whole point. The pending-task sweep runs from cron
after; anything overdue becomes a recorded `afp:Error` with a code the spec actually
names, not a shrug.

## 15:00 — the deliverable is a directory

The quarter's engagement for a client closes, and the deliverable is not a PDF:

```
node --experimental-sqlite src/cli.ts export
exported 214 activities to ./export
```

The bundle is ordinary files — `MANIFEST.json` declaring the `eddsa-jcs-2022`
cryptosuite, `roster.jsonld`, `instance.jsonld`, one outbox per actor, `artifacts/` as
hash-named blobs. He zips it and, before sending, does what he tells the client's
auditor to do — runs the second implementation, the one that shares no code with his:

```
python3 ../verifier/afp_verify.py ./export --thread urn:afp:thread:q3-mitid-refresh
PASSED — 214 checks, no gaps
Every signature verifies, every chain is unbroken, every artifact matches its digest.
```

The client's side needs Python and nothing else: no keys, no account, no call to the
practice. Once, a client's security officer changed one byte of an attachment to see
what would happen. The verifier named the exact artifact and check. That officer is now
the practice's best reference.

## 16:45 — custody, backup, and going home

Backup is `cp` — the SQLite file and the `data/keys/` directory, versioned, offline.
Which is also the day's uncomfortable truth: key custody is currently *file custody*.
Every agent key the instance holds is a file in that directory, and the honest security
statement is that the record's guarantees are cryptographic while the keys' protection
is a directory permission and a careful operator. He knows the roster supports
`self`-custody agents that hold their own keys; the practice hasn't needed one yet.
It's on the list, right under the day he has to rotate anything.

## The warts, because a Tuesday without them is fiction

- **`--experimental-sqlite`** in every invocation: the storage layer rides a Node flag
  that says "experimental" out loud. It has been fine. It is still a flag.
- **No daemon** cuts both ways: nothing pages him at night, and nothing *notices*
  anything at night either — liveness is whatever the last sweep saw. The
  cron-drives-a-library shape is honest, and it is also why "the agents noticed X" is
  never true unless a script ran.
- **One writer.** One SQLite file means one process at a time; the second concurrent
  workflow queues behind the first. At the practice's scale this has never mattered.
  He knows the day it matters is the day this document gets a successor.
- **Keys are files.** Said above; repeated here because it belongs on this list.
- **The record is only as good as what crosses the port.** The instance will faithfully
  sign, chain and preserve whatever a brain produced — including a bad answer.
  Verifiability is not correctness; it's the ability to establish *what happened*.
  Every claim in the export is checkable; whether it was *wise* is still Tuesday's
  human question.

What P4 adds to this Tuesday — a counterparty, an agreement with an expiry, a boundary
gate, a two-export audit — is exactly the part [the subcontract
story](08-the-subcontract-story.md) could only tell in soft focus. This document is the
hard-focus baseline it will be measured against: when the federation build lands, the
test is whether *its* Tuesday can be written like this one, with every noun pointing at
a file.

## Postscript: a Tuesday, three months later

P4 landed, and Kasper's day changed in exactly one structural way: something *listens*
now. The inbox — `POST /actor/inbox` on the same server `serve` always ran — is the
first resident process in the stack's life, which means it is also the first thing that
can page him; the no-daemon wart traded itself for an on-call wart, and he is not sure
he got the better end. What he got in exchange is queryable: `fed_agreements` holds the
one row that says who the practice federates with and until when, and after the week a
stranger's validly-signed probes bounced off the gate, "were we probed" stopped being a
feeling — `sqlite3 data/afp.db "SELECT at, actor, step, reason FROM fed_boundary_log"`
answers it, each row hash-chained to the last so the log can't be quietly thinned. The
probes themselves cost the stranger a 401 unsigned and a 403 signed, and cost Kasper
nothing but the query. The two-bundle audit seam got fixed the way everything here gets
fixed — it became a command: `afp_verify.py export-a export-b` runs each firm's replay
and then checks the pair against each other, findings labelled with whose domain they
belong to. Kasper's contribution to that was one flag on the export and a list of thread
IDs; the redactions come out as digest-only stubs and the manifest says what was left
out on purpose, so his other clients stay his business without his export looking
tampered with.
