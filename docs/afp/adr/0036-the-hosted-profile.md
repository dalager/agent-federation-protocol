# ADR-0036 — The hosted profile: one operator, one object

- **Status:** Proposed (2026-09-15); **WP-1 built (2026-09-19)** — the store port and its
  `node` adapter, and **WP-2 built (2026-09-19)** — the request port and its `node`
  adapter, both landed as refactors with the suite green, per the build order below.
  WP-3 to WP-5 unbuilt, and no `actor` adapter exists. Extends program claim **C8** of
  [ADR-0024](0024-the-road-to-production.md) with a second hosting profile; group:
  **Operations**
- **Date:** 2026-09-15
- **Applies to:** how an instance is put on the internet when the operator does not run a
  server — the store port, the request port, and what a platform's actor model buys and
  costs
- **Builds on:** [ADR-0032](0032-deployment-profile.md) (the self-hosted profile this one
  is the second of), [ADR-0031](0031-the-resident-process.md) Decisions 1 and 4 (the
  scheduler; one writer, enforced), [ADR-0027](0027-the-port-is-a-security-boundary.md)
  (one door, one schema), [ADR-0026](0026-key-custody-and-the-signer-port.md) Decision 1
  (the signer port, and the adapter pattern this ADR copies twice), [ADR-0035](0035-remote-custody-and-the-asynchronous-port.md)
  Decision 4 (the asynchronous port), [ADR-0034](0034-release-conformance-and-disclosure.md)
  Decision 3 (the conformance kit), [ADR-0001](0001-p1-stack.md) Decision 4 (SQLite, no
  infrastructure, the export is a file copy)
- **Driven by:** a reading of ADR-0032 that noticed its profile — one process, one file,
  one writer, a scheduler, a proxy in front, a self-check behind — describes a platform
  actor without naming one; and the observation that the self-hosted profile has no
  answer for an operator who wants an instance without wanting a server; confirmed by
  [scenario 15](../scenarios/15-the-production-tuesday.md) finding **99** — the served
  Tuesday leans on four things outside the checkout (a proxy, a unit, a backup cron, a
  key runbook), and this profile is the one in which all four are the platform's

## Context

ADR-0032 put an instance on the internet as one Node process behind a proxy the operator
runs, holding one SQLite file under a pid lock, with ADR-0031's scheduler ticking inside
it. That profile is right for the operator it was written for: a firm that runs servers.
It is silent about the operator that does not — a solo practitioner, a small consortium
member, a port agent's owner ([ADR-0028](0028-port-agents.md)) whose whole deployment is
one actor and its store — and silent about the host who would like to offer an instance
to each of them without operating one process per customer.

The shape of the self-hosted profile is what makes a second one cheap to describe.
Strip ADR-0032 to its invariants and they read: **one store, one writer, one clock,
one origin, and a proxy that terminates TLS.** A single-threaded platform actor with
attached SQLite storage, an alarm, and a fetch handler *is* that list — the pid lock,
the WAL pragma, the online-backup call and the `node:http` server are the self-hosted
profile's ways of obtaining properties such a platform provides. Cloudflare's Durable
Objects are the concrete case this ADR was written against; the profile is stated so
that any actor-with-storage runtime satisfying the same list qualifies.

What the codebase depends on today, measured rather than assumed:

| Dependency | Where | Count |
|---|---|---|
| `node:sqlite` `prepare()` | 19 files, `hub/store.ts` and `allocation/store.ts` heaviest | 99 call sites |
| `node:http` types and `createServer` | `ap/server.ts`, `ports/command.ts`, `ports/webhook.ts`, `runtime/shutdown.ts` | 4 files |
| `node:fs` | keys, secrets-as-files (ADR-0032 D3), the lock, export, backup | 18 imports |
| `node:dns/promises` + `node:net` | `federation/fetchPolicy.ts`, the private-range refusal of ADR-0025 D2 | 1 file |
| `node:crypto` Ed25519 | `crypto/keys.ts`, `crypto/signer.ts` | 2 generators, 1 signer |
| timers | none outside demos and tests (ADR-0031 verified this); the scheduler owns the clock | 0 |

Everything else — JCS, proofs, activities, CRDTs, the hub, allocation, federation logic,
the verifier — is platform-free already.

## Decisions

### 1. Two hosting profiles, one architecture, and the same rule 06 already states

06 § Deployment profiles distinguishes profiles by *trust topology*: federated, solo,
pairwise. This ADR adds a second axis, *hosting*, with two values:

| Hosting profile | Process | Store | Writer | Clock | TLS |
|---|---|---|---|---|---|
| **Self-hosted** (ADR-0032) | one Node process, `npm run serve` | one SQLite file | pid lock beside the file | in-process scheduler | operator's proxy |
| **Hosted** (this ADR) | one platform actor per instance | the actor's attached SQLite | the actor's single thread | the actor's alarm | the platform's edge |

06's rule for trust-topology profiles applies verbatim here: *degenerate means fewer
mechanisms, never fewer checks.* A hosted instance runs every check a self-hosted one
does — signature verification, dedupe, the fetch policy, the seat gate, the self-check —
and where the platform makes a check unnecessary (Decision 5), the profile says so in
writing rather than letting the check silently become a no-op.

### 2. A store port, so the 99 call sites do not become 198

`store/db.ts` is already the one door (ADR-0027). It becomes a port: a `Store`
interface with `exec`, `get`, `all`, `run` and `transaction`, over bound parameters and
plain SQL, and no cursor, statement or pragma type from either runtime leaking through
it. Two adapters: `node` over `node:sqlite` (the existing behaviour, byte for byte) and
`actor` over the platform's SQL API. Every `prepare()` call site moves to the port once;
the migrations (ADR-0032 D4) run unchanged through it, since they are plain DDL already.
The pragmas the self-hosted adapter sets — WAL, foreign keys — are the adapter's business:
WAL is meaningless on attached storage and foreign-key enforcement is set the platform's
way.

The signer port (ADR-0026) is the precedent and the proof that this codebase can carry a
port at 158 sites without the port becoming a leak; the store port is smaller.

### 3. A request port, so the server is an adapter

The four `node:http` files become one `Handler` type — `(request: Request) =>
Promise<Response>` over the standard `Request`/`Response` — with the routing, the inbox
paths, the actor documents, the human window and the two port endpoints written against
it. The `node` adapter wraps the handler in `createServer`; the `actor` adapter *is* the
actor's fetch method. `runtime/shutdown.ts`'s drain-then-close becomes the node adapter's
concern alone; the hosted profile has no process to drain.

### 4. The scheduler folds four loops into one alarm

ADR-0031 D1's four loops keep their intervals, jitter and idempotence. Under the hosted
profile a single alarm fires at the earliest next-due loop, runs every loop that is due,
and re-arms for the next. `lastTick` per loop is unchanged, so `/readyz`'s "the scheduler
has ticked" reads the same. Two consequences the self-hosted profile never had:

- **Eviction is normal.** An actor is unloaded when idle and re-instantiated on the next
  request or alarm. ADR-0004 H5 (the hub rehydrates from its store) is what makes this
  free; anything held only in memory across ticks is a bug under this profile, and the
  gate (WP-5) evicts between every tick to prove it.
- **The flush loop keeps the actor warm.** At the 10-second default an instance is never
  idle. That is correct for a federating instance with a non-empty queue and wasteful
  for one with nothing to send; the hosted adapter re-arms flush only while the queue is
  non-empty, and the sweep and converge loops set the floor. Priced in Consequences.

### 5. The fetch policy names what the platform does for it

ADR-0025 D2's private-range refusal resolves a target with `node:dns` before connecting.
A platform actor cannot resolve, and does not need to: its egress cannot reach private
ranges at all. The hosted adapter of `fetchPolicy` records the decision as
`refused-by-platform` rather than skipping the check, so the log line an operator reads
still names the reason (ADR-0031 D1: every scheduled act is an activity or a log line).
A platform that *can* reach private ranges does not qualify for the profile.

### 6. Custody under the hosted profile is `remote-issued`, and the port is asynchronous

There is no file and no agent socket inside an actor, so ADR-0026's `file` and `agent`
adapters do not apply. The hosted profile's baseline custody is ADR-0035 D2's
`remote-issued`: the platform's secret store or a KMS issues the key; the actor holds
the signing half in its attached storage, encrypted under a secret the platform injects
as a binding rather than a file. ADR-0035 D4's asynchronous port, "if and when it is
built", is therefore built by this profile — the actor's fetch handler is asynchronous
already, and the cost ADR-0035 measured (a third less than ADR-0026 feared) is paid once,
by the one adapter that needs it.

Secrets-as-files (ADR-0032 D3) becomes secrets-as-bindings: the schema and `validate()`
are unchanged, the loader is the adapter's.

### 7. Backup is point-in-time recovery, and the export is the export

ADR-0032 D5's `afp backup` uses SQLite's online backup API; the hosted profile has no
file to copy and uses the platform's point-in-time recovery for the store. The signed
bundle export ([ADR-0009](0009-federated-replay.md), [ADR-0012](0012-the-long-horizon.md)
D4) is untouched, because it never depended on the file: it is produced through the
store port and verified by a verifier that shares no code. `afp restore` under this
profile is a point-in-time rewind, and it logs the restore point exactly as ADR-0020 D2
requires, since a rewound instance is the same duplicate-vote case.

The consequence for ADR-0001 D4 is stated plainly in Consequences: under this profile
the export is not a file copy.

### 8. The origin is the route, the self-check stands

`AFP_ORIGIN` is the platform route the actor is bound to, `https:` by construction. The
self-check of ADR-0032 D2 — fetch your own `/actor` through the edge and require its
`id` to equal the origin — runs unchanged and is worth more here, because the commonest
misconfiguration is now a route bound to the wrong object.

### 9. One conformance kit, two profiles

ADR-0034 D3's conformance kit gates both profiles with the same fixtures: every shipped
demo runs against the `actor` adapters in a local platform emulator in CI, every shipped
bundle replays, and every shipped demo store opens and migrates through the store port.
The kit gains one axis, not a second kit. A release (ADR-0034 D6) names which profiles it
was gated on.

### 10. The hosted profile is a platform dependency, and the record says so

ADR-0001's zero-dependency stance is about libraries in the process; a hosting platform is
a dependency of a different kind and the profile does not pretend otherwise. The
deviation is recorded here, in the policy document's `afp:terms`
([ADR-0033](0033-operator-obligations.md)), and in NodeInfo's software block, so a
counterparty can see which profile an instance runs. The self-hosted profile remains the
reference: a claim the hosted profile cannot honour is a claim the program does not make.

## Options considered

| Option | Rejected because |
|---|---|
| Port the instance to the platform outright | A second codebase for the same protocol; every ADR from 0025 on would need building twice, and the verifier's "shares no code" would be the only thing keeping them honest |
| Run the Node process in a container on the platform | Keeps every file-shaped assumption and buys only the edge; the operator still operates a process, the host still runs one per customer, and the one-writer lock is still a pid in a file |
| A store port only, keep `node:http` | Half the profile; the actor's fetch method cannot host a `node:http` server, so the request port is not optional |
| Make the hosted profile the reference | It cannot be run from a clean checkout with no account; ADR-0032's "worth keeping" property stays with the self-hosted one |
| WebSockets for inbox delivery to the actor | AFP delivery is ActivityPub HTTP POST with signatures (ADR-0025); a second transport is a second thing to verify for no property the record needs |

## Consequences

**Positive** — one instance per operator becomes one object per operator, and a host can
hold thousands with no new isolation code; the one-writer invariant is the platform's,
not a lock file's; the scheduler survives eviction because the hub was already built to
rehydrate; two ports (store, request) make the runtime an adapter in the way the signer
already is, and the ADR-0035 asynchronous port gets built because a real adapter needs it.

**Negative** — the export is no longer a file copy (ADR-0001 D4 deviates under this
profile); a hosting platform is a hard dependency the self-hosted profile does not have;
the attached-storage ceiling (10 GB per object on the platform this was written against)
is a retention bound ADR-0012's `afp:retentionDuty` must be checked against, and the
runbook says what an instance does at that bound — archive and rotate, never silently
drop; `agent` custody is unavailable; the 99-site store migration and the 4-file request
migration are real work, sized in WP-1 and WP-2.

**Priced** — a warm actor at the default flush interval is roughly 8,600 alarm
invocations per instance per day, each short; at one instance that is noise, at a
thousand it is a line item, which is why Decision 4 re-arms flush only while the queue is
non-empty.

**Accepted** — the platform emulator in CI is a test dependency, not a runtime one, and
the first to appear in this codebase; it is confined to the gate for this profile.

## Implementation architecture

| Package | Touches | Content |
|---|---|---|
| **WP-1 · store port** | `store/db.ts` (the `Store` interface), `store/adapters/node.ts` (extracted, unchanged behaviour), `store/adapters/actor.ts` (new), all 99 `prepare()` sites across 19 files | Decision 2 |
| **WP-2 · request port** | `ap/server.ts` (handler extracted; `createServer` becomes `runtime/adapters/node.ts`), `ports/command.ts`, `ports/webhook.ts`, `runtime/shutdown.ts` | Decision 3 |
| **WP-3 · alarm scheduler + fetch policy** | `runtime/scheduler.ts` (next-due fold), `federation/fetchPolicy.ts` (`refused-by-platform`) | Decisions 4–5 |
| **WP-4 · custody + config** | `crypto/signer.ts` (the async port per ADR-0035 D4), `configSchema.ts` (bindings loader), `instance/keyOps.ts` | Decision 6 |
| **WP-5 · backup, origin, gate** | `store/backup.ts` (profile-conditional), `cli.ts` (`restore` as rewind), `test/adr0036.test.ts`, the conformance kit's profile axis, instance README § Hosted profile | Decisions 7–10 |

Gate: every existing test passes against the `node` adapters with no case changed (WP-1 and WP-2
are refactors, and the suite is the proof); every shipped demo runs against the `actor`
adapters in the emulator and produces a byte-identical bundle to its `node` run; the
scheduler gate evicts the actor between every tick and every loop's `lastTick` still
advances; `config check` under the hosted profile fails on each named misconfiguration
and passes on the reference binding set; a point-in-time rewind logs its restore point
and the D4 duplicate-vote case reads as explained.

Order: WP-1 and WP-2 first and alone, landed as refactors with the suite green under the
`node` adapters, before any `actor` adapter exists. If the ports cannot be landed
without changing a test, that is the finding, and this ADR stops there.

## Build status

### WP-1 · the store port — built 2026-09-19

`store/port.ts` states the port: `exec`, `run`, `get`, `all`, `transaction`, `close`, over
plain SQL and bound values. `store/adapters/node.ts` implements it over `node:sqlite` with
the behaviour `store/db.ts` already had — the same pragmas, the same one-writer lock,
released now by the adapter's `close` rather than by a monkey-patched `db.close`.
`Db` is an alias for `Store`, so every module that names it kept its signature. All 105
call sites moved: 94 by codemod across 20 files, 9 in one file the codemod could not see
(below), one reused statement by hand, and one in `store/backup.ts`.

`node:sqlite` now appears in four files — the adapter, `db.ts` (which constructs it),
`backup.ts` (Decision 7's profile-conditional online-backup API, which has no hosted
counterpart and is documented as staying), and a comment in `port.ts`. It appeared in
`store/inboxLog.ts` too, as the declared type of a field; that was the one real leak and
it is closed.

**The ADR's gate was "every existing test passes with no case changed", and three cases
changed.** They are fixture constructors, not assertions: `test/adr0032.test.ts` (two) and
`test/adr0037.test.ts` (one) each build a legacy store with `new DatabaseSync(path)` and
hand it to `migrateWith`, which takes the port. Each is now
`new NodeStore(new DatabaseSync(path))`, with every assertion untouched and the suite's
counts unchanged but for the new gate file. The literal reading of the gate says this ADR
should have stopped; the reading taken is that the gate exists to catch a port that
changes *behaviour*, which would show as an expectation needing revision, and that a
fixture's constructor is not an expectation. The alternative considered and rejected was
to have `migrate` sniff its argument and wrap a raw handle — which would put a
runtime-type check in production code to protect a test, and is the leak the port exists
to prevent. **This paragraph is the record of that call, so a later reader can disagree
with it.**

`test/adr0036.test.ts` is new, six cases, and covers what the suite cannot: the port as a
contract. It exists mainly for `transaction`, which the codebase declares and does not yet
call — an unused verb that shipped untested is the part of a port most likely to be wrong
when the second adapter copies the first one's behaviour. Two facts it pins down:
nesting reuses the outer transaction rather than opening a second, and a row's prototype
is unspecified (the node adapter returns `node:sqlite`'s null-prototype objects and the
port says consumers may only read columns off them — normalising would cost an allocation
per row to buy a property nothing uses).

**Found on the way, unrelated and now fixed:** `src/crdt/store.ts` contained a literal NUL
byte — a composite map key written as `${a}<NUL>${b}` rather than `${a}\0${b}` — which
made the whole file *binary* to every `grep -I`-based tool, including the one that built
this refactor's file list. Nine call sites in it were silently missed and only surfaced at
runtime. The byte is now the `\0` escape: behaviour-identical, and the file is searchable
again. It had been invisible since ADR-0032 landed it.

**Cleanup pass, same day.** A review of the landed refactor found four things worth
fixing before WP-2 builds on it, and one thing worth leaving alone:

- **`openNodeStore(path, { readOnly, onClose })`** now owns every construction of the
  adapter. Four call sites had been writing `new NodeStore(new DatabaseSync(path))` by
  hand — `db.ts`, `backup.ts` and three test fixtures — which put the runtime's handle
  type back on the far side of the port one site at a time, in exactly the places the
  port was built to clear. A consequence worth stating: **`db.ts` no longer imports
  `node:sqlite` at all.** The lock, the pragmas and `migrate` still live there, so the
  WP-5 note below stands, but the runtime type is gone from it, and `node:sqlite` is now
  imported by exactly two files — the adapter and `backup.ts`.
- **`NodeStore.depth` was a counter doing a boolean's work** (set to 1, compared to 0,
  never incremented) and is now `inTransaction`, which is what the transaction contract
  actually says. The `onClose` field also cleared itself after firing, guarding a second
  `close()` that the port does not permit and `DatabaseSync` would refuse first; it is
  `readonly` now.
- **The codemod's formatting damage is undone.** Splicing arguments onto the closing
  backtick of a template literal took the touched files from 19 lines over 140 characters
  to 42; they are back to 20, with SQL on its own line and bound parameters below it, and
  63 now-pointless `db\n  .run(` chains — residue of `.prepare().run()` — collapsed.
- **A gate against the NUL byte's recurrence**, in `test/adr0034.test.ts` beside the other
  repo-hygiene cases: no tracked source file may contain a NUL, because one makes the
  whole file invisible to every `grep -I` and that is how nine call sites went missing
  here. Verified against the pre-fix file, which it catches.

**One real regression the port introduced, found and fixed the same day.**
`queue.ts`'s `ready()` — the delivery loop's polling call — built
`… WHERE target IN (${placeholders})` with one placeholder per pending target.
Before the port that was a one-shot `prepare()` that the collector took back
afterwards; through the port it became a cache key, and the adapter's cache is
keyed by SQL text and never evicts. So the process retained one prepared statement
per distinct number-of-pending-targets it had ever seen. The fix is at the cause
rather than the cache: `peer_backoff` holds at most one row per peer, so the query
is now static (`SELECT target, not_before FROM peer_backoff`) and the filtering is
in memory — smaller *and* fixed-shape. `test/adr0036.test.ts` G7 asserts the
invariant that catches the next one: growing the data twentyfold must not grow the
cache, because the SQL texts are the same two.

Worth recording how it was nearly missed. A scan for interpolated SQL at port call
sites reported only two, both bounded, and concluded the cache was safe. The scan's
pattern required `db.all(` to be contiguous, and this call site was still in the
`this.db\n  .all(` shape the old `.prepare().all()` chain had left — so the one site
that mattered was the one the check could not see. That is the same failure as the
NUL byte three paragraphs up, arriving by a different route: **a search that
silently skips is worse than no search, because it answers.**

Left alone deliberately: `Db` stays an alias for `Store`. It earns its keep while WP-1's
no-behaviour-change constraint holds, but it is provisional — once WP-5 gives the port a
second concrete profile, two names for one type is redundant vocabulary, and the call
sites should migrate to `Store`. **That migration is WP-5's, and this sentence is the
tracking note for it.**

**What WP-1 deliberately did not do.** `openDb` still holds the lock, the pragmas and the
`migrate` call in `db.ts` — all of them node-profile concerns sitting above a
profile-neutral port. Splitting that into an adapter-owned opener is WP-5's business, not
a refactor's, and naming it here is cheaper than rediscovering it.

### WP-2 · the request port — built 2026-09-19

`runtime/httpPort.ts` states it: `Handler`, plus the two helpers every door
needs (`jsonResponse`, `readCappedBody`). `runtime/adapters/node.ts` holds
`createServer` and is now the only thing in the request path that knows
`node:http` exists — it converts an `IncomingMessage` into a `Request`, calls
the handler, and writes the `Response` back. `ap/server.ts` exports
`createHandler(instance, options)` and keeps `createHttpServer` at its old
name and signature as a two-line wrapper over the adapter, because
twenty-three call sites and every demo say it. `ports/command.ts` and
`ports/webhook.ts` take a `Request` and return a `Response`.

**This time the gate held literally: 605 passing, no test case changed.** The
three new cases are additions, not edits. Two things made it cheap. First,
`healthRoute` and `renderingRoute` already answered through a `send` callback
rather than a `ServerResponse`, so the routes that were hardest to move had
been half-ported for two ADRs without anyone calling it that. Second, the
headers the old code set on the response object before writing it
(`Cache-Control`, `Vary`, the WebFinger `Access-Control-Allow-Origin`) could
be accumulated and applied at send time, which is observably the same thing —
nothing could read them before the write either.

**The port takes two parameters, and Decision 3 above says one.** Decision 3
writes it as `(request: Request) => Promise<Response>`. It cannot quite be:
ADR-0025 Decision 5's rate limiter buckets by source address, and a standard
`Request` has no such field, because the address is a transport fact known to
whatever accepted the connection and to nothing above it. The alternatives
were a header the adapter injects or a parameter. A header is the worse one:
`x-forwarded-for`-shaped smuggling is a real attack, the adapter would have to
strip a client-supplied copy before setting its own, and a reader of the
handler could not tell a trustworthy header from a forged one. A parameter
cannot be spoofed by anyone who is not the adapter. So the port is
`(request, peer)`, `test/adr0036.test.ts` G9 proves a client cannot buy itself
a fresh bucket with `x-forwarded-for`, `x-real-ip` or `forwarded`, and this
paragraph amends Decision 3 rather than quietly differing from it.

**The body cap needed care, because it is the one place the old imperative
shape was load-bearing.** ADR-0025 Decision 4 says a hostile body is "capped
and refused before parsing, not after buffering", and the old code held that
by counting bytes in a `data` handler and destroying the socket mid-flight.
`request.arrayBuffer()` would have quietly inverted it — buffer first, measure
second — so `readCappedBody` reads the stream itself and cancels past the cap,
and a declared `content-length` over the cap is refused before a byte is read.
G10 proves the producer is stopped early rather than drained. The socket close
that used to sit beside the 413 is now the node adapter's, on seeing that
status: the sender may still be sending, and closing is still the only way to
stop it.

`runtime/shutdown.ts` stays node-only and now says why in its header — a
hosted actor has no process to drain, no signals to trap and no socket to stop
accepting on, so the request port says nothing about shutdown and a second
adapter leaves that file alone. What remains outside the port is the signer's
own HTTP surface (`tools/signer/server.ts`, ADR-0026's tool, not this
instance's public door) and the P4–P7 demos, which stand up their own servers.

## References

- 06 § Deployment profiles — § Hosting profiles
- [ADR-0032](0032-deployment-profile.md) build status (what the self-hosted profile
  actually depends on); [ADR-0031](0031-the-resident-process.md) D4
- [ADR-0035](0035-remote-custody-and-the-asynchronous-port.md) D4, the cost measurement
  this ADR's Decision 6 spends
- [ADR-0023](0023-loose-ends-triaged.md) row L8 (Postgres not adopted; the store held)
