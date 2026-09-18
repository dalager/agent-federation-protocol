# ADR-0037 — The served hub: `serve` builds what the policy says it hosts, and seats converge

- **Status:** Proposed (2026-09-15) — completes program claim **C7** of
  [ADR-0024](0024-the-road-to-production.md) for the operator who hosts a hub; group:
  **Operations**
- **Date:** 2026-09-15
- **Applies to:** `cli.ts`'s `serve`, `runtime/scheduler.ts`'s converge loop,
  `hub/hub.ts`'s seat state and sync set, `policySpec.ts`
- **Builds on:** [ADR-0031](0031-the-resident-process.md) Decision 1 (the converge loop,
  built for replicas "an embedding program supplies"), [ADR-0033](0033-operator-obligations.md)
  Decision 1 (the policy document as the source of record for what an instance runs),
  [ADR-0016](0016-p5-transport.md) Decisions 2–3 (the exchange; liveness excluded from
  it), [ADR-0017](0017-standards-conformance.md) Decision 4 and [ADR-0032](0032-deployment-profile.md)
  Decision 6 (explicit seats, `follow-required` as the default), [ADR-0004](0004-solo-foundation-hardening.md)
  H5 (the hub rehydrates from its store)
- **Driven by:** [scenario 15](../scenarios/15-the-production-tuesday.md) findings **96**
  and **97** — `serve` hosts no hub, so the converge loop on a served instance has
  nothing to converge; and seat state does not converge across replicas, which
  ADR-0032's build status recorded as its follow-up

## Context

ADR-0031 gave `serve` a pulse and scoped one thing out: "wiring a resident hub into
`serve` is not this ADR's claim" (`cli.ts`, the converge wiring). The scheduler's
converge loop is built and gated for `HubReplica`s a program hands it, and every demo
that hosts a hub is such a program. A served instance hands it an empty list. So the
shape ADR-0031 set out to retire — a hub is a library a script embeds — survives for
exactly the operator it costs most: the one who hosts. Scenario 15 walked it and could
not put a hosted hub on the served instance's Tuesday at all; the seat it walks is at the
partner's hub, which the partner's *program* embeds.

The pieces exist. `Hub` is constructed from an origin, an id, the instance's `Db`, key
directory, actor id and delivery settings; it rehydrates membership, roles, seats and
the registry from its tables on construction (H5). `createHttpServer` already takes
`hubs: [...]` and serves `GET /hubs/:id` and `POST /hubs/:id/inbox` for each. The
scheduler already takes `hubReplicas` with a peer set and a transport. What is missing
is the sentence that says *which* hubs a served instance hosts, and the code that reads
it.

The second finding is older. ADR-0032 Decision 6 flipped the seat default to
`follow-required`, and building it surfaced that `hub_seats` is not CRDT-tracked: a
replica that never saw the `Follow` would refuse every synced `Enroll`. The build's
answer was a `relayed` flag that skips the seat gate for activities carried inside a
replica's `Accept{afp:StateDeltas}` or a `pushSync`, and a note that converging seats
themselves is "the recorded follow-up, not built here." That flag is correct and is also
a hole: a replica's seat table is whatever it saw locally, so `GET /hubs/:id/followers`
on two replicas of one hub can disagree, and a round's electorate pinned on one replica
(ADR-0018 Decision 5) can name an instance the other replica does not know holds a seat.

## Decisions

### 1. The policy document names the hubs this instance hosts

`afp:hubs` joins the policy document's properties ([ADR-0033](0033-operator-obligations.md)
Decision 1's table): a list of `{ id, seatPolicy?, replicaOf?, peers? }`, one entry per
hub this instance hosts. `id` is the path segment under `/hubs/`; `seatPolicy` overrides
the document's `afp:seatPolicy` for that hub alone; `replicaOf` names the origin hub's
actor when this entry is a replica; `peers` lists the other replicas' actor URLs — 02's
peer set, stated where a counterparty can read it. `AFP_HUBS` (a comma-separated list of
ids) populates the property when the policy file names none, on the same convenience
terms as `AFP_CONTROLLERS`. The property is optional and its absence means what it means
today: this instance hosts no hub.

This is a wire-vocabulary addition and is recorded as one: an `afp:Policy` carrying
`afp:hubs` is still a valid policy to a verifier that does not know the property, and
the verifier gains one check — every hub actor the record shows *this instance*
emitting hub activities for is named in its policy, or the replay fails by name.

### 2. `serve` builds them, serves them, and hands them to the scheduler

At startup, for each `afp:hubs` entry, `serve` constructs a `Hub` on the instance's own
`Db`, key directory and actor id, passes the set to `createHttpServer` as `hubs` so
`GET /hubs/:id`, `/hubs/:id/followers` and `POST /hubs/:id/inbox` are live, and passes
each as a `HubReplica` — with its `peers` and the instance's signed HTTP transport — to
the scheduler. The converge loop then has something to converge, the urgent push on an
admitted `Enroll`/`Unenroll`/proof fires from a served process for the first time, and
`/readyz` gains nothing: a hub that failed to construct is a startup error, named, in the
same class as a misrouted origin. `afp:hubs` is validated by `config check`.

Enrollment is already answerable only for hubs this instance hosts (`cli.ts`); the set it
consults becomes this one rather than the empty list.

### 3. Seats converge: `Follow`, `Accept{Follow}` and `Undo{Follow}` join the sync set

`hub_seats` becomes replicated state. The seat activities — `Follow`, the hub's
`Accept{Follow}`, and `Undo{Follow}` — are carried in the exchange the converge loop
already runs (`Offer{afp:Digest}` → `Accept{afp:StateDeltas}` and `pushSync`), ahead of
any `Enroll` in the same delta, so a replica admits a synced `Enroll` against a real seat
rather than a skipped gate. Seat state is an OR-Set keyed by instance actor, the
`Follow` activity id as the tag, and `Undo{Follow}` as the remove — the same shape the
hub's membership set already uses, so `GET /hubs/:id/followers` on any replica answers
from converged state. Liveness stays excluded (ADR-0016 Decision 3); seats are not
liveness.

The `relayed` flag stays, narrowed to its honest job: ordering. A replica that receives an
`Enroll` whose `Follow` is in the same delta but later in it, or in a delta not yet
applied, admits the `Enroll` provisionally and re-checks it against the seat set once the
delta is applied; an `Enroll` whose seat never arrives is refused and logged as such.
The gate that caught the gap — `test/adr0016.test.ts` T7 and `test/adr0031.test.ts` G3 —
gains the case it could not express before: two replicas, a `Follow` seen by one, an
`Enroll` synced to the other, `followers` equal on both after two ticks.

### 4. What the pinned electorate already guarantees, and what this adds

ADR-0018 Decision 5 pins a round's electorate and weights at open, so seat convergence
changes no round already open. What this decision adds is that two replicas *opening*
the same round pin the same electorate — which is the property scenario 15's finding 97
named, and the one a Byzantine replica could otherwise exploit by opening against a seat
set only it had seen.

## Options considered

| Option | Rejected because |
|---|---|
| Keep hubs as an embedding program's concern; document it | Scenario 15 could not write a hosted hub's Tuesday with every noun a file, and ADR-0024 Decision 3 makes that the definition of done |
| `AFP_HUBS` only, no policy property | Which hubs an instance hosts is a fact counterparties federate against; ADR-0033 made the policy document the source of record for exactly such facts, and an env var alone is the convenience that predates it |
| Keep the `relayed` skip and call seats eventually consistent by construction | They are not: a replica's seat table is what it saw, and nothing converges it; `followers` can disagree indefinitely |
| Replicate `hub_seats` as an LWW register per instance | A `Follow` after an `Undo` on one replica and the reverse order on another must both converge to the same answer; add-wins OR-Set with the activity id as tag does, a timestamp race does not |

## Consequences

**Positive** — a served instance can host a hub, and the converge loop, the urgent push
and the followers endpoint do on a server what they did in demos; seat state is one
state across replicas; the policy document says which hubs an instance hosts, so a
counterparty can check it.

**Negative** — one new wire term (`afp:hubs`) and one new verifier check; the exchange
carries three more activity types; the sync-set ordering rule in Decision 3 is real
complexity that the `relayed` flag had hidden.

**Accepted** — a hub's own delivery queue and the instance's remain distinct
(`HubReplica.transport`); this ADR does not merge them.

## Implementation architecture

| Package | Touches | Content |
|---|---|---|
| **WP-1 · policy + config** | `policySpec.ts` (`hubs`), `config.ts`/`configSchema.ts` (`AFP_HUBS`, validation), `ap/policy.ts` (`afp:hubs`), `src/verifier/policy.py` (the hosted-hub check) | Decision 1 |
| **WP-2 · serve** | `cli.ts` `serve` (construct, route, schedule), `runtime/configCheck.ts` | Decision 2 |
| **WP-3 · seat convergence** | `hub/hub.ts` (seat OR-Set; sync set; `relayed` narrowed to ordering), `hub/store.ts` (`hub_seats` read from CRDT state), `store/migrations/003-*.ts` | Decision 3 |
| **WP-4 · gate + docs** | `test/adr0037.test.ts`, `test/adr0016.test.ts` T7, `test/adr0031.test.ts` G3, instance README § Running it as a resident process, 02 § Hub-level Follow/Accept, scenario 15's next coverage section | Decisions 2–4 |

Gate: a served instance whose policy names one hub answers `GET /hubs/:id` and admits a
signed `Enroll` at `POST /hubs/:id/inbox`; the same with two served instances, one a
replica of the other, converges an `Enroll` and a `Follow` seen on different replicas
within two converge ticks, with `followers` byte-equal on both; a policy naming a hub
that fails to construct is a named startup error; every shipped bundle still replays
unchanged, and a fresh export whose policy carries `afp:hubs` passes the verifier's new
check and fails it when a hub activity's actor is struck from the property.

## References

- [Scenario 15](../scenarios/15-the-production-tuesday.md) § The warts, findings 96–97
- [ADR-0032](0032-deployment-profile.md) § Build status, "Seat state does not converge
  across replicas"
- [ADR-0031](0031-the-resident-process.md) Decision 1; `cli.ts` `serve`'s converge
  comment
