# Scenario 15 — The production Tuesday: the same operator, on a served instance

> Spec-test scenario, written under [ADR-0030](../adr/0030-scenario-re-walks-and-the-coverage-index.md)
> Decision 3, which scoped it to *after* [ADR-0031](../adr/0031-the-resident-process.md)
> and [ADR-0032](../adr/0032-deployment-profile.md) landed — both built 2026-09-13. It is
> [ADR-0024](../adr/0024-the-road-to-production.md) Decision 3's definition of done: an
> operator's day on a served instance on the public internet, in the genre of
> [the operator's Tuesday](the-operators-tuesday.md) — every noun a file, every command
> one that runs, warts listed at the end. That baseline stays as written; this is the
> successor its last wart promised. Where the build stops, this document stops.

| **Support status** | **Supported — findings 96–100** |
|---|---|
| Findings raised | 5 |
| Resolved by | 96, 97 → [ADR-0037](../adr/0037-the-served-hub.md) (**built 2026-09-19**); 98 → [ADR-0035](../adr/0035-remote-custody-and-the-asynchronous-port.md) (**Decisions 2, 3, 5 built 2026-09-18**; Decision 4 costed, unscheduled); 99 → [ADR-0036](../adr/0036-the-hosted-profile.md) (**WP-1–3 built 2026-09-19**, WP-4/5 partly; no `actor` adapter yet); 100 → operational, a production-checklist line |
| See it run | `npm run demo:p8` — the served surface itself has no demo; the gate boots it |
| Gated by | `adr0031.test.ts`, `adr0032.test.ts`, `adr0033.test.ts`, `adr0034.test.ts`, `adr0026.test.ts`, `adr0035.test.ts`, `adr0037.test.ts` |
| Succeeds | [the operator's Tuesday](the-operators-tuesday.md) — the 2026-08 baseline, kept unedited |

**Read the walkthrough below as history**: what ran on 2026-09-15, against the build that
existed that day (`afp-instance` 0.9.0, spec revision 3.34). The
[support index](README.md#is-this-workload-supported) carries the current-status view.

## User story

**As** the operator of a small practice whose instance now federates with a partner and
holds a seat at a hub the partner hosts,
**I want** the instance to run without me — noticing overdue work, retrying a peer that
is down, refusing a second writer, saying why it is not ready — and to leave a record
of every one of those acts,
**so that** "the agents noticed X" can be true at 3 a.m., and I can prove it the next
morning from files rather than memory.

## Cast

Kasper, from the baseline. The practice's instance, once "one Node process he starts
when something needs it", is now a `systemd` service on a small host, behind Caddy,
at an `https:` origin, with a partner firm on the other end of one
`FederationAgreement` and a seat at the partner's standing hub. The verifier is still the
Python script that shares no code — now also a package. Nothing else has joined the cast.
The counterparty is off-stage for the whole day, which is the point of one beat.

## Walkthrough

### 07:50 — the gate, still first

The day after a pull still starts the same way, and the number is bigger:

```
cd src/instance && npm test
ℹ tests 549
ℹ suites 130
ℹ pass 547
ℹ fail 0
ℹ skipped 2
```

The suites he now reads past are the operations ones: `adr0031` boots a served instance
and checks that an overdue task becomes one `afp:Error` on the first tick and nothing on
the second; `adr0032` feeds `config check` every misconfiguration it names and requires
each to be named back; `adr0034` builds the release archive, installs it into a clean
virtualenv, and verifies a fixture with the installed script. The mutations still matter
more than the passes. The one flag that survives is `--disable-warning=ExperimentalWarning`
in every npm script — the storage layer no longer needs a flag to *work*, it needs one to
be quiet.

### 08:20 — what the system is now

There is a daemon. He is still not sure he got the better end of that trade, but it is
queryable:

```
systemctl status afp
● afp.service - AFP reference instance
     Active: active (running) since Mon 2026-09-14 03:16:02 CEST; 1 day 4h ago
```

Logs are JSON lines on stderr, one per event, with a level and a component:

```
{"t":"2026-09-14T01:16:02.311Z","level":"info","component":"cli:serve","msg":"listening","url":"http://localhost:8787","origin":"https://afp.the-practice.example"}
{"t":"2026-09-14T01:16:02.312Z","level":"info","component":"cli:serve","msg":"routes","read":"GET /actor /roster /agents/:name /agents/:name/outbox","inbox":"POST /actor/inbox /agents/:name/inbox   (HTTP Signature + agreement gate)","gate":"GET above `public`: signed + gated (ADR-0013); unsigned sees `public` only, 404 otherwise"}
```

The process listens on loopback; Caddy owns the certificate and forwards the inbox
paths, the read surface and three endpoints that answer for the process itself. The
one he checks from his phone:

```
curl -s https://afp.the-practice.example/readyz
{"ok":true}
```

`/readyz` walks four things in order — the store answers, the signer signs and verifies a
fixed byte string, the instance fetches its own `/actor` back through Caddy and requires
the document's `id` to be its own origin, and the scheduler has ticked — and a failure
names the line, not "unhealthy". The self-check is the one he values: a misrouted origin
used to be a signature mystery a week later, and is now a `503` with
`"reason":"self-check-mismatch"` before anyone federates with the mistake.

The version is a fact a counterparty can fetch rather than a branch name he remembers:

```
curl -s https://afp.the-practice.example/nodeinfo/2.1 | jq -r '.software.version, .metadata["afp:specRevision"]'
0.9.0
3.34
```

### 09:10 — the check that runs beside a live process

He wants to know the configuration is still sane after yesterday's edit to the policy
file. `config check` never minted a key and never collides with a running process, and
it says so rather than pretending:

```
npm run config:check
ok    store — store-locked (pid 4121)
ok    signer — skipped — store held by pid 4121
ok    self-check — skipped — store held by pid 4121
```

Exit status zero, three honest lines. The signer and self-check probes that were skipped
here are the same two `/readyz` ran live at 08:20, so nothing went unchecked — it was
checked by the process that could. A bad enum in the policy file would have come back as
`FAIL  policy.seatPolicy (AFP_POLICY_FILE): …` on its own line, and every problem at
once.

### 10:30 — what happened at 02:14

A task delegated to the partner's estimator yesterday afternoon carried a deadline of
02:00. Nobody ran anything at 02:00. The sweep loop did, at its next tick, and the record
shows it:

```
journalctl -u afp --since 02:00 --until 02:30 | grep '"component":"scheduler"'
```

is quiet — a successful tick is not a log line — but the counter moved and the outbox has
the activity:

```
curl -s http://127.0.0.1:8787/metrics | grep -E '^afp_(sweep_overdue|scheduler_ticks)_total'
afp_sweep_overdue_total 1
afp_scheduler_ticks_total{loop="sweep"} 3611
afp_scheduler_ticks_total{loop="flush"} 10832
```

The overdue task is an `afp:Error` with `afp:err:deadline-missed` on the record — the
code 04 names, published by the instance on its own behalf, signed like anything else.
ADR-0031 Decision 1's rule is what makes this legible: a scheduled act that the spec says
is an activity *is* an activity; the rest is a log line; nothing is a third thing.

### 11:00 — the partner is down, and nothing is his to do

Mid-morning the partner's instance stops answering. Yesterday's baseline would have
retried five times in a second and given up when the driver script exited. Today the
flush loop owns the retry: attempts spaced by ADR-0025's backoff schedule, capped at
`AFP_BACKOFF_CEILING_MS`, and when the partner comes back answering `503` with a
`Retry-After` header while it catches up, no attempt lands inside the window — the
`peer_backoff` table holds the instant the peer asked for, and only that peer is delayed.
He watches one number:

```
curl -s http://127.0.0.1:8787/metrics | grep '^afp_queue_depth'
```

It rises, then falls, and he did nothing. Had the partner stayed down past
`AFP_MAX_DELIVERY_ATTEMPTS`, the deliveries would have dead-lettered, and that is the one
outcome that *does* page him: a `warn` line, `"msg":"dead-lettered deliveries"`, and
`afp_dead_letters_total` moving. He has an alert on that counter and nothing else.

### 13:00 — a deploy is a release, and a restart is a drain

He no longer deploys a branch tip. The version on the host was cut with
`scripts/release.sh 0.9.0` from the repository root: it refuses unless every gate is
green and a signing key is configured, and its tag names the spec revision, the
conformance-kit version, and the digests of the fixture bundles it was gated against.
The tag is signed. The restart itself:

```
systemctl restart afp
```

sends `SIGTERM`; the service stops accepting inbox POSTs, lets in-flight handlers finish,
runs one final flush, stops the scheduler and releases the store's lock —
`{"level":"info","component":"shutdown","msg":"draining"}` then `"drained"` in the
journal — and the unit's `TimeoutStopSec=30` is sized above that drain. The hub rehydrates
from its tables on the way back up, the gate that restarts mid-vote and counts the tally
anyway still runs, and February's soft spot stays closed.

The wrong shape now fails loudly. A colleague who once ran a driver script against the
live data directory "just to look" got this, and nothing else happened:

```
StoreLocked: store at /var/lib/afp/afp.db is locked by pid 4121 — a resident process already holds it (ADR-0031 Decision 4)
```

The lock names a pid; a lock naming a dead pid is stale and taken over, so a crashed
process cannot brick the directory either.

### 15:00 — the deliverable is a directory, and now it carries the policy

The quarter's export is the same command and the bundle has one more file:

```
npm run export
exported 341 activities to ./export
```

`policy.jsonld` — the signed `afp:Policy` the instance also serves at `/afp/policy`,
named in `MANIFEST.json`'s `afp:policy` with its digest. It states what the protocol
correctly left to him and he had, until this month, stated nowhere: `follow-required`
as the seat policy, the two actor URLs authorized to approve, `per-case` as the thread
layout, a retention horizon of five years and the anchor that backs it, `file` as the
instance key's custody, the local model as the only brain, and a disclosure contact. The
verifier now holds the record to it — a `Result` whose `afp:producedBy` names a brain the
policy does not list fails by name.

The client's side needs less than it did:

```
pip install afp-verify
afp-verify ./export --thread urn:afp:thread:q3-mitid-refresh
```

`cryptography` is its only dependency. For the auditor who installs nothing, there is a
checksummed source archive, and for the auditor who trusts neither implementation there
is `conformance/`: every phase's clean bundle and its named mutations, each with the
verdict and the check name it must fail, versioned with the spec revision, run in CI
against the Python verifier on every commit. A third implementation is conformant when it
agrees with the kit on every bundle. Nobody has written one. The kit is what would prove
it if they did.

### 16:45 — custody, backup, and going home

Backup is no longer `cp`. A cron line at 03:15 ran this morning:

```
npm run backup -- /backups/afp-2026-09-15
backup written to /backups/afp-2026-09-15
  212 artifacts, schema version 2, taken 2026-09-15T01:15:03.870Z
  keys were NOT included — back those up separately (README § Backup, ADR-0026 Decision 6)
```

SQLite's online backup API against the live WAL-mode store, safe while `serve` is up, with
`BACKUP.json` beside `afp.db` and `artifacts/`. `schema version 2` is the first forward
migration this binary shipped — `restore_points`, the table `afp restore` writes one row
to after a restore, so that a same-value duplicate vote observed after that instant is
explained by the log rather than mistaken for equivocation. He has run the restore once,
into a scratch directory, to know that it refuses a live target and verifies the backup
opens and migrates before it touches anything.

The keys are a separate runbook because they are a secret. Every PEM under
`/var/lib/afp/keys/` is `0600` and encrypted at rest under the passphrase in
`AFP_KEY_PASSPHRASE_FILE`; the process gets a `Signer` that can sign and cannot export;
rotation is `npm run keys -- rotate writer` and the retired key keeps its interval so
everything it signed still verifies. The uncomfortable truth has moved, not gone: the
policy document says `custody.instance: "file"` because that is the only signer adapter
built, and the passphrase file lives on the same host as the files it protects. The
honest security statement is now "a directory permission, a passphrase, and a careful
operator" — one word longer than August's. The `remote` adapter that would change the
sentence is [ADR-0035](../adr/0035-remote-custody-and-the-asynchronous-port.md), and
since 2026-09-18 it is half of one: `remote-issued` custody is built — the root key lives
in the KMS, signs one `afp:KeyDelegation` per rotation, and the short-lived successor it
introduces signs everything else, so a stolen host signs for a configured hour rather than
forever. What is still unbuilt is Decision 4, the `remote` mode in which the private key
provably never enters host memory; it is costed — ~300 call sites and a `Signer.sign` that
returns a promise — and deliberately unscheduled.

## The warts, because a Tuesday without them is fiction

- **The flag renamed itself.** `--experimental-sqlite` is gone; `--disable-warning=ExperimentalWarning`
  is in every script instead. The storage layer works without a flag and warns without
  one. It is still a flag.
- **`serve` hosts no hub.** The converge loop on the practice's own served instance has
  no replicas to converge, because `serve` builds none — a hub the practice hosted itself
  would still be a library a program embeds. The seat at the partner's hub works because
  the partner's program embeds theirs. Finding 96.
- **Four things live outside the checkout.** Caddy, the unit file, the backup cron line
  and the key runbook. The README's production checklist names all four and every line
  is a command or a file, and they are still four things a solo practitioner has to own
  before the first federation. Finding 99.
- **Keys are files, with a passphrase.** Said above; repeated here because it belongs on
  this list until ADR-0035 Decision 4 builds. `remote-issued` (Decision 2, built) shortens
  the window the passphrase has to survive; it does not move the key out of host memory.
  Finding 98.
- **The retention horizon is declared, not acted on.** `afp:retentionDuty` travels in the
  policy and the manifest and the verifier turns checks on for it; nothing in the runtime
  reads the horizon. Exports under `AFP_EXPORT_DIR` are the operator's own, and
  `afp restore` prints that reminder every time. Finding 100.
- **The record is only as good as what crosses the port.** Unchanged from August, and now
  sharper: ADR-0027 records *what a brain was told and by which fixed framing*, so the
  question "was it wise" is still Tuesday's human question, but "what was it asked" is no
  longer.

## Acceptance criteria → mechanisms

| Criterion | Mechanism | Status |
|---|---|---|
| The deployed version is identifiable from outside, by a counterparty | NodeInfo `software.version` + `metadata["afp:specRevision"]` from `package.json`; `afp-verify --version` reports both | Yes (08:20) |
| The gate runs before anything ships, on every commit | `gate.yml`: `npm test`, every shipped fixture verified, the conformance kit, the release archive installed and exercised | Yes (07:50) |
| A misconfigured origin fails at startup, by name | `loadConfig` refuses `http:` outside dev mode; `config check` reports every problem at once; `/readyz` self-check names a mismatch | Yes (08:20, 09:10) |
| An overdue task becomes a recorded error with no script running | sweep loop → `afp:Error` `afp:err:deadline-missed` | Yes (10:30) |
| A peer briefly down is retried with backoff, and its `Retry-After` is honoured | flush loop, `peer_backoff`, ceiling; dead-letter past attempts | Yes (11:00) |
| Two processes cannot share the store | pid lock beside the file; `StoreLocked`; stale-pid takeover | Yes (13:00) |
| The instance says why it is not ready | `/readyz` walks store, signer, self-check, scheduler; `503` names the line | Yes (08:20) |
| A backup cannot corrupt a live store, and a restore explains itself | online backup API; `restore_points` row (ADR-0020 D2) | Yes (16:45) |
| A restart drains rather than drops | `SIGTERM` → stop accepting, finish in-flight, final flush, release lock | Yes (13:00) — **drain proven in-process, not under a real unit's `SIGTERM`; narrowed** |
| Keys sit behind a port, encrypted at rest, rotatable without a running instance | signer port; `0600` PEMs under `AFP_KEY_PASSPHRASE_FILE`; `keys rotate`/`revoke` | Yes (16:45) |
| The operator's obligations are published, signed, and the record is held to them | `/afp/policy`, `policy.jsonld` in every export, verifier `check_policy` | Yes (15:00) |
| A counterparty verifies the export with nothing but Python | `pip install afp-verify`; the archive; the conformance kit | Yes (15:00) |
| A hub the practice hosts converges while it sleeps | converge loop; `serve` builds the hubs `afp:hostedHubs` names | Yes — **closed 2026-09-19 by [ADR-0037](../adr/0037-the-served-hub.md)**, finding 96 |
| Key custody survives the host being taken | `remote-issued` custody: KMS root, `afp:KeyDelegation`, short-lived successor; the `remote` adapter for the full property | **Narrowed (16:45) — the compromise window is bounded, not eliminated; ADR-0035 D4 unscheduled; finding 98** |
| The declared retention horizon is acted on | `afp:retentionDuty` in policy and manifest | **Declared, checked at replay, not acted on — finding 100** |

## Spec verdict

**Held: the Tuesday can be written with every noun pointing at a file, on a served
instance, on the public internet.** That was ADR-0024 Decision 3's test and the baseline's
closing sentence, and it passes: every command above runs, every output shape is the
build's, and the three warts the baseline promised a successor for — the flag, the
daemon, the writer — are answered by ADR-0032 Decision 1, ADR-0031 Decision 1 and
ADR-0031 Decision 4, each with a gate that fails on purpose. The one the baseline
repeated twice, keys, is answered by half: the port and the encryption are built, the
custody mode that would change the sentence is not.

**What strained:**

- **Finding 96 — `serve` hosts no hub, so the converge loop on a served instance has
  nothing to converge.** The README says it plainly ("`serve` hosts none of its own unless
  an embedding program supplies them"), and the scheduler is built and gated for replicas
  a program hands it. But the baseline's "cron drives a library" shape, which ADR-0031
  set out to retire, survives for exactly the case where it costs most: an operator who
  *hosts* a hub. Candidate: `serve` builds the hubs the policy document says this instance
  hosts, and hands them to the scheduler as replicas. **Closed 2026-09-19:**
  [ADR-0037](../adr/0037-the-served-hub.md) Decisions 1–2 are built — `afp:hostedHubs` on the
  policy document, `serve` constructing and serving each one and handing it to the
  converge loop, gated end-to-end against a real `serve` (`test/adr0037.test.ts` G2).
- **Finding 97 — seat state does not converge across replicas.** ADR-0032's own build
  status records it: a relayed `Enroll` is re-derived by a replica rather than
  re-admitted, because `hub_seats` is not CRDT-tracked and a replica that never saw the
  `Follow` would otherwise refuse every synced `Enroll` under the new default. The
  walkthrough did not hit it — the practice holds one seat at one hub — and it will the
  day the partner's hub is replicated. Narrowed: recorded, gated by the case that caught
  it, not fixed. **Closed 2026-09-19:** [ADR-0037](../adr/0037-the-served-hub.md)
  Decision 3 makes seats an OR-Set in `crdt_state` tagged by the `Follow`, drops
  `hub_seats`, and narrows `relayed` from "skip the seat gate" to "the seat-moving
  activities in a delta are applied first" — so an `Enroll` whose seat never arrives is
  refused and logged rather than admitted (`test/adr0037.test.ts` G4: `followers`
  byte-equal across replicas within two converge ticks).
- **Finding 98 — custody improved by one word.** File custody with a passphrase on the
  same disk is better than file custody, and is still the thing the baseline called
  uncomfortable. ADR-0035 is the answer and is now built in part: `remote-issued` custody
  bounds the window a stolen host can sign in (Decisions 2, 3, 5, built 2026-09-18), and
  the `remote` mode that would take the key out of host memory altogether is Decision 4 —
  costed and unscheduled. The finding stays open at the width of that decision.
- **Finding 99 — the profile needs four things that are not in the checkout.** The
  self-hosted profile is honest about them and a solo practitioner still has to own a
  proxy, a unit, a cron and a key runbook before their first federation.
  [ADR-0036](../adr/0036-the-hosted-profile.md) proposes the profile in which all four
  are the platform's, and it has begun to build: WP-1 (the store port and its `node`
  adapter), WP-2 (the request port) and WP-3 (the alarm schedule and the resolver seam)
  landed 2026-09-19 as refactors with the suite green, WP-4 and WP-5 in part. No `actor`
  adapter exists, so no operator has yet been spared any of the four things; this scenario
  is what the profile is re-walked against when one does.
- **Finding 100 — retention is declared and checked, never acted on.** The policy states
  a horizon, the manifest carries it, the verifier turns checks on for it, and the
  runtime has no loop that reads it. Whether the runtime *should* — an export schedule,
  an archive-and-rotate at the store's bound — is an operational question this scenario
  names and does not claim as the protocol's to answer.

Not every observation from the day is a finding. That `config check` says `skipped` beside
a live process instead of failing or lying, that a dead pid's lock is taken over, and that
the self-check catches a misrouted origin before federation does, are held results — the
build behaving as its ADRs said — and are recorded above rather than numbered here.

## Coverage as of 2026-09-15

Per ADR-0030 Decision 1. The served surface has no demo of its own — `serve` is booted by
the gates, not by any `demo:*` script — so most rows are mechanism gated by construction.
The two demonstrated rows are the export side, which every demo exercises end to end
through the Python verifier.

| Criterion | Class | Evidence |
|---|---|---|
| The deployed version is identifiable from outside, by a counterparty | mechanism gated | `test/adr0034.test.ts` "package.json carries an afp.specRevision", "afp_verify.py --version reports both values", "ap/nodeinfo.ts no longer hand-carries the version" |
| The gate runs before anything ships, on every commit | mechanism gated | `test/adr0034.test.ts` "gate.yml names at least one run: step per job", "conformance/run.py exits 0 against afp_verify.py" |
| A misconfigured origin fails at startup, by name | mechanism gated | `test/adr0032.test.ts` "AFP_ORIGIN not https: outside dev mode is named", "a mismatched self-check id FAILs that line only", "several misconfigurations at once are ALL named in one call" |
| An overdue task becomes a recorded error with no script running | mechanism gated | `test/adr0031.test.ts` G1 "an overdue task with no run() becomes one afp:Error on the first tick; a second tick adds nothing" |
| A peer briefly down is retried with backoff, and its `Retry-After` is honoured | mechanism gated | `test/adr0031.test.ts` G2 "a peer down for one tick delivers on the next…", G8 "a peer answers 429 Retry-After for one target — no attempt inside the window; another peer is unaffected" |
| Two processes cannot share the store | mechanism gated | `test/adr0031.test.ts` G6 "a live foreign pid holding the lock refuses a second open; a stale (dead) pid is taken over…" |
| The instance says why it is not ready | mechanism gated | `test/adr0031.test.ts` G5 "/healthz is always 200 ok; /readyz walks store, signer, self-check, scheduler in order; /metrics carries the pinned series and no data" |
| A backup cannot corrupt a live store, and a restore explains itself | mechanism gated | `test/adr0032.test.ts` G3 (backup/restore round-trip, byte-identical replay) and the `restore_points` primitives block |
| A restart drains rather than drops | narrowed | `test/adr0031.test.ts` G7 "(narrowed): drain() closes the server, flushes, releases the lock, and exits 0" — the drain is driven in-process; no gate sends a real `SIGTERM` through a unit |
| Keys sit behind a port, encrypted at rest, rotatable without a running instance | mechanism gated | `test/adr0026.test.ts` "PEMs are written 0600", "with AFP_KEY_PASSPHRASE_FILE set, PEMs are encrypted at rest and still load", "key operations do not need a bootable instance…" |
| The operator's obligations are published, signed, and the record is held to them | workload demonstrated | `npm run demo:p8` — `test/adr0033.test.ts` G6 "every shipped bundle replays unchanged… now carrying policy.jsonld"; G2 "a Result whose afp:producedBy names an unlisted brain fails by name" |
| A counterparty verifies the export with nothing but Python | workload demonstrated | `npm run demo:p8` — every demo's bundle is replayed by `afp_verify.py` in `test/demos.test.ts`; `test/adr0034.test.ts` "build the archive, install into a clean venv, run afp-verify over a real fixture" |
| A hub the practice hosts converges while it sleeps | mechanism gated | `test/adr0037.test.ts` G2 — a real `serve` builds the hubs `afp:hostedHubs` names, serves them and hands them to the converge loop; G4 converges seats with the membership they authorize — finding 96 closed |
| Key custody survives the host being taken | narrowed | `test/adr0035.test.ts` G1 "rotation with a remote root calls /sign exactly once…", G3 "a delegated key signing outside its declared interval fails keys: by name at replay", G5 "signer unreachable at rotation time — the current key keeps signing" — the window is bounded; the key is still in host memory for its lifetime, which is ADR-0035 Decision 4, unscheduled — finding 98 |
| The declared retention horizon is acted on | narrowed | `test/adr0033.test.ts` "fills the manifest's retentionDuty/anchors from the policy when extras names none" — the declaration travels and is checked at replay; nothing in the runtime reads the horizon — finding 100 |

**Counts:** 2 demonstrated · 10 gated · 3 narrowed · 0 not built.

## Postscript: the Tuesday that has no host

The four things outside the checkout are the whole difference between this Tuesday and
one a solo practitioner could have. [ADR-0036](../adr/0036-the-hosted-profile.md) — proposed
the same day this was written, and building since 2026-09-19 — notices that ADR-0032's invariants (one store, one writer,
one clock, one origin, a proxy that terminates TLS) describe a platform actor with attached
storage, and proposes a store port and a request port so the Node runtime becomes one
adapter and the actor another. Three work packages in, the ports exist and the `node`
adapter is one of them; the `actor` adapter that would make the second noun real is not
written. When it is, this scenario is re-walked with the same beats and different nouns: no unit, no Caddy, no cron, no key directory — and the test is
the same as the baseline's, whether *that* Tuesday can be written with every noun
pointing at a file.
