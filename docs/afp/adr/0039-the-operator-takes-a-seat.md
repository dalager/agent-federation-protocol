# ADR-0039 — The operator takes a seat: the hub commands an operator can actually run

- **Status:** Built (2026-09-19) — not a program claim of
  [ADR-0024](0024-the-road-to-production.md); what makes
  [ADR-0037](0037-the-served-hub.md) reachable by the operator who runs it, the way
  [ADR-0038](0038-the-operators-own-work.md) did for a served instance's agents; group:
  **Operations**
- **Date:** 2026-09-19
- **Applies to:** `cli.ts`'s command list, `ports/command.ts`, `federation/visibility.ts`'s
  grammar, `instance/following.ts`, and the operator at a terminal
- **Builds on:** [ADR-0037](0037-the-served-hub.md) Decision 2 (a served instance hosts
  the hubs its policy names) and its Build status (the self-operated waiver at the inbox),
  [ADR-0038](0038-the-operators-own-work.md) Decision 4 (a CLI that signs as a controller
  and never opens the store), [ADR-0029](0029-the-human-window-and-the-activitypub-premise.md)
  Decision 2 (the controller binding and the polite reply),
  [ADR-0031](0031-the-resident-process.md) Decision 4 (one writer, enforced by a lock),
  [ADR-0017](0017-standards-conformance.md) Decision 4 (R2/R3: the seat, and Follow/Undo
  as the door-knock class)
- **Driven by:** a walkthrough of ADR-0037 the day it landed. `serve` hosts the hub its
  policy names and the hub's inbox is the only door to it — and no command opens that
  door. An operator can host a hub they cannot join.

## Context

ADR-0037 built the served hub and proved it with a gate that had to construct its own
`Follow` and `afp:Enroll` from an in-process `AfpInstance`, before `serve` took the store
lock, because nothing on the command line emits either. That was read at the time as a
property of the test harness. It is not: it is the operator's whole situation.

The commands are `demo`, `p2`–`p8`, `export`, `keys`, `config`, `backup`, `restore`,
`task`, `show`, `serve`. Between them they can run a workload, hand an agent a brief, read
an answer, rotate a key and ship a bundle. None of them can take a seat at a hub, give one
up, enroll an agent, or withdraw one — the four acts 02 has described since P2 and
[ADR-0017](0017-standards-conformance.md) Decision 4 made explicit with
`follow-required`. Every one of them exists as a builder (`instance/following.ts`'s
`followHub`/`unfollowHub`, `hub/activities.ts`'s `enroll`/`unenroll`), is exercised by
demos and gates, and is reachable only from a program that embeds the instance.

So ADR-0037 retired "a hub is a library a script embeds" on the hosting side and left it
standing on the joining side. The shape is the same one ADR-0038 found for agents: the
mechanism is built, gated and correct, and the operator has no way to reach it without
writing TypeScript.

The store lock is what makes this more than a missing subcommand. `serve` holds one writer
(ADR-0031 Decision 4), so a second process pointed at the same `AFP_DATA_DIR` cannot
publish; a `hub follow` that opened the store would work exactly when the instance was
*not* running, which is the opposite of when an operator wants it. ADR-0038 answered the
same problem for `task` by making the CLI a signed client of the running instance, and
that answer applies here unchanged.

One thing has to be true for it to work, and as of ADR-0037 it is: a self-operated sender
waives the agreement stage at the inbox. An instance Following its own hosted hub crosses
its own boundary gate, and until ADR-0037's Build status recorded that waiver it was
refused there — an instance holds no agreement with itself. The door this ADR opens is a
door that only just became passable.

## Decisions

### 1. The instance actor gets a command port of its own

`POST /actor/command`, the sibling of `POST /agents/:name/command`
([ADR-0029](0029-the-human-window-and-the-activitypub-premise.md) Decision 2's carrier).
The existing route is agent-scoped because its commands act on an agent: `pause`, `status`,
`approve`, `task`. These four act on the *instance* — it is the instance that holds a seat,
and `followHub`/`enroll` publish as the instance actor — so the route is addressed to the
instance actor, and the same authorization runs on it: a verifying signature, resolved
through the read gate, whose actor is on the policy's `afp:controllers`.

The refusal is `politeReply`, unchanged and for the same reason: identical shape whichever
reason applies, so the endpoint is not an oracle for the controller list.

### 2. A typed body, because this carrier has no stranger in it

The three-form grammar in `federation/visibility.ts` is narrow because a `Create{Note}`
mention carries a stranger's free text, and `parseCommand` is the one place that text is
given a meaning. No mention can reach `/actor/command`: `inbox.ts`'s `onMention` dispatches
to the agent-scoped route alone, and this ADR does not change that.

So the hub commands take a typed body and `parseCommand` does not learn a fifth form:

```json
{ "verb": "follow" | "unfollow" | "enroll" | "unenroll",
  "hub": "<hub actor url>",
  "agent": "<local agent name>",      // enroll, unenroll
  "capabilities": ["afp:cap:…"],      // enroll, optional
  "role": "member" | "observer",      // enroll, optional
  "reason": "<one line>" }            // unenroll, optional
```

Every field is validated by shape before anything is published, and an unknown verb, a
`hub` that is not an absolute URL, or an `agent` this instance does not hold is the polite
reply with nothing on the record. This is strictly narrower than the grammar it sits
beside: there is no free text to parse at all.

### 3. What each verb publishes, and what it does not

| Verb | Publishes | Notes |
|---|---|---|
| `follow` | `Follow{actor: instance, object: hub}` | `instance/following.ts`'s `followHub`, unchanged |
| `unfollow` | `Undo{Follow}` | refuses by name when there is no live Follow to undo |
| `enroll` | `afp:Enroll{object: agent, target: hub}` | capabilities default to the agent's own declared list; the per-`(agent, hub)` key is minted by `serve`, which owns the key directory |
| `unenroll` | `afp:Unenroll{object: agent, target: hub}` | `reason` rides as `summary` |

Delivery is the scheduler's, not the command's: the activity lands in the outbox and the
flush loop delivers it as a signed HTTP hop to `${hub}/inbox` — the same path a foreign
hub's activity takes, because for a hub this instance hosts that hop arrives at its own
server and is admitted by ADR-0037's self-operated waiver. The command answers with the
activity id it published, never with the hub's answer: what the hub decides is the hub's
business, on the record, and `show` is how an operator reads it.

`enroll` does not wait for a seat, and does not check for one. The seat gate is the hub's
(`follow-required`, ADR-0017 Decision 4 R2), and an `afp:Enroll` from an instance holding
no seat is refused *there*, on the record, with a reason. A client-side pre-check would be
a second implementation of the rule and would disagree with the hub the day they drifted.

### 4. `npm run hub` is a signed client, like `task` and `show`

```
npm run hub -- follow   <hub-url>
npm run hub -- unfollow <hub-url>
npm run hub -- enroll   <agent> <hub-url> [--capability <c>]… [--role observer]
npm run hub -- unenroll <agent> <hub-url> [--reason <text>]
npm run hub -- list
```

`ports/hubCli.ts` over `ports/clientCli.ts`'s `signedClient` — the controller resolved by
`--as` or the policy's first local entry, its key loaded from the key directory, never
minted, the store never opened (ADR-0038 Decision 4). `list` is a read: the hubs this
instance follows (`followingIds`) and, for each hub it hosts, whether the instance holds a
seat on it — one signed `GET` per hub against `/hubs/:id/followers`, which ADR-0037 made
live.

## Options considered

| Option | Rejected because |
|---|---|
| A fifth form in the mention grammar (`@<hub> follow`) | The grammar is narrow because a mention carries stranger text; hub ids are not agent names, and widening the parser to carry a capability list would put a stranger's tokens one regex away from membership |
| `hub follow` opens the store directly | It would work only while `serve` is down — ADR-0031 Decision 4 has one writer, and the operator wants this while the instance is running |
| Reuse `POST /agents/:name/command` with the controller's held actor as `:name` | The acting actor is the instance, not the controller's agent; the route's `:name` would be a fiction the record does not carry |
| Have `enroll` block until the hub answers | The hub's answer is an activity on the record, not a response body; `show` already reads answers, and a command that waited would invent a second way to learn the same fact |

## Consequences

**Positive** — the four acts 02 has described since P2 are reachable by the operator who
runs the instance; ADR-0037's hosted hub can be joined by its own host; a foreign hub can
be joined by anyone who can reach it and holds an agreement with its operator.

**Negative** — one new route and one new CLI. The typed body is a second command shape
beside the grammar, which is a cost paid to avoid widening the grammar itself.

**Accepted** — the agreement a foreign hub's operator must hold with this one is still
concluded outside the CLI (ADR-0037's Build status records it). `hub follow` against a
stranger's hub therefore works only where an embedding program or a demo established the
agreement; the operator's own hub, which needs none, works today.

## Implementation architecture

| Package | Touches | Content |
|---|---|---|
| **WP-1 · the port** | `ports/hubCommand.ts` (new: validation + the four verbs), `ports/command.ts` (route dispatch), `ap/server.ts` (`POST /actor/command`) | Decisions 1–3 |
| **WP-2 · the CLI** | `ports/hubCli.ts` (new), `cli.ts` (`hub` case), `package.json` (`npm run hub`) | Decision 4 |
| **WP-3 · gate + docs** | `test/adr0039.test.ts`, instance README § the operator's commands, 02 § Hub-level Follow/Accept, ADR-0037's Build status (its recorded gap, closed) | all |

Gate: a served instance hosting one hub is Followed by its own operator through
`npm run hub -- follow`, and `/hubs/:id/followers` names it; `enroll` puts an agent in the
hub's membership and `show` reads the trail; `unenroll` and `unfollow` reverse both; an
unauthorized requester, an unknown verb, a foreign `agent` and a malformed `hub` each get
the polite reply with nothing on the record; the CLI opens no store while `serve` holds
the lock; the bundle replays clean.

## Build status

**Built (2026-09-19).** All three work packages; `test/adr0039.test.ts` G1–G4, 5/5. `npm
test` (`src/instance`) — 596 tests, 594 pass, 2 pre-existing skips, 0 failures, every
pre-existing gate, demo and fixture untouched. No wire vocabulary is added: all four verbs
publish activities 02 and ADR-0017 already define, so the spec revision does not move.

Notes on what was built versus what the ADR wrote:

- **`hub list` needed a read route, and got a public one.** Decision 4 describes the
  command as two reads without saying where the first comes from: the instance's own
  Follow/Undo trail lives in its outbox, which the CLI cannot open. `GET /afp/following`
  serves `followingIds()`, unauthenticated for the reason the trail itself is —
  `followHub` publishes at `public` visibility, so the route discloses nothing the outbox
  does not already serve and only saves a reader replaying the trail themselves.
- **`list` reports `seated` per hub, and `unknown` is an answer.** A hub this instance
  follows but cannot reach is not an error; the honest report is that the seat's state is
  unknown, which is what an operator needs to see when a Follow is in flight or was
  refused. The two reads disagreeing is the whole value of the command.
- **The never-mint rule is the first gate on `--as`.** A controller name the policy does
  not list has no key in the key directory, so `signedClient` refuses before anything is
  signed (ADR-0038 Decision 4). G4 checks it there rather than at the port, which is the
  stricter of the two answers and the one an operator meets first.
- **`unfollow` with nothing to undo answers politely.** `unfollowHub` throws a real
  message about this instance's own trail; the port turns it into the polite reply, and
  the reason goes to the delivery log. An operator's own instance may say more to its
  log than it says to a requester, and the endpoint stays a non-oracle either way.

## References

- [ADR-0037](0037-the-served-hub.md) § Build status — "a foreign follower still needs an
  agreement, and no command concludes one", and the self-operated waiver this ADR depends on
- [ADR-0038](0038-the-operators-own-work.md) Decision 4 — the signed client that never
  opens the store
- [ADR-0029](0029-the-human-window-and-the-activitypub-premise.md) Decision 2 — the
  controller binding and the polite reply
