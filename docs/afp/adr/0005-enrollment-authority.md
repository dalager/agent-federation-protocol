# ADR-0005 — Who may enroll an agent in a hub

- **Status:** Proposed
- **Date:** 2026-08-20
- **Applies to:** the solo profile now (P1–P3), and the federation handshake it precedes
  ([P4](../05-roadmap.md#p2p7))
- **Builds on:** [ADR-0002](0002-p2-hub-and-crdt-stack.md) (the hub and its CRDT state),
  [ADR-0004](0004-solo-foundation-hardening.md) (roles on the Enroll trail) — both
  inherited unchanged
- **Driven by:** [ADR-0004 H14](0004-solo-foundation-hardening.md#build-status), and its
  revisit trigger "whether foreign-instance agents enroll with non-member roles by
  default"

## Context

The hub's membership — and, since ADR-0004, every agent's *role* — is replayed from the
`afp:Enroll` trail. A replay admits any validly signed activity typed `afp:Enroll` whose
`target` is the hub. It never asks whether the **actor** was entitled to issue it.

Signature verification does not close this. `check_authority` establishes that a signing
key may speak for its activity's actor; it says nothing about whether that actor may
enroll anyone. So a rostered agent can publish `Enroll{object: self, afp:role: member}`
and appear, to both implementations equally, as a member the hub admitted.

**This hole predates ADR-0004** — the membership replay it replaced had the identical
trust model, and at P1–P3 the blast radius was one operator enrolling agents into its own
hub. ADR-0004 changed the stakes rather than the hole: bid admission, announce authority,
asset registration and quorum pinning now all resolve through that same trail. A
self-issued Enroll is now a self-issued seat at the table.

Two things already in the spec make this narrower than it looks, and both are
*specified but unenforced*:

1. **02 says enrollment is two-level**: `Follow`/`Accept` seats the *instance* in hub
   governance, and then "the instance issues a signed `afp:Enroll` per agent." The
   issuer is already named in the design. Nothing checks it.
2. **02 already refuses hub-key admission**: `afp:MemberAdmit`/`afp:MemberExpel` require
   "a weighted quorum vote among current instance members — *never* a signature from the
   hub's own key." A governance path for admission exists; enrollment simply does not
   use it.

So this ADR mostly makes two existing rules checkable, and decides the one genuinely open
question: who may confer the `member` role once more than one operator shares a hub.

## Decisions

### 1. An Enroll is issued by the enrolled agent's own instance, and by nobody else

The `actor` of an `afp:Enroll` MUST be the instance whose signed roster vouches the agent
in `object`. An agent enrolling itself is refused; an instance enrolling another
operator's agent is refused.

This is checkable from data a replay already loads: the roster binds agent → instance,
and `build_authority` reads it before any activity is walked. Enforced at hub admission
and mirrored as a named verifier failure, in the established mold.

**No migration.** Every `afp:Enroll` in the record today is instance-issued — the
instance is the only thing that has ever called the builder — so this rule is
retroactively satisfied by existing exports. It costs nothing now and is unbuyable later,
which is the same reason signing and visibility went into P1.

### 2. The instance's seat is published, not assumed — enforced from P4

An `afp:Enroll` into hub H is admissible only where H has published an `Accept{Follow}`
seating that instance, resolvable in the export. This is 02's level 1, made evidence.

**Enforced from P4, specified now.** At solo scale the check is vacuous — one instance,
one hub, one operator — and demanding it retroactively would invalidate every P2/P3
export to prove something no one doubts. It becomes load-bearing the moment a second
operator can address the hub, which is exactly P4's handshake. Specifying it now means
the seat is a thing instances already publish when federation starts needing it, rather
than a field retrofitted into a live membership CRDT.

### 3. `member` is conferred by the hub's members; `requester` and `observer` by the instance

Below P4, an instance grants roles to its own agents and that stands: one operator, no
one to defraud. From P4:

| Role | Conferred by | Why |
|---|---|---|
| `observer` | the agent's instance | reads at `hub` visibility; changes no outcome |
| `requester` | the agent's instance | announces and reports actuals on its own threads; cannot bid, vote, or be pinned |
| `member` | `afp:MemberAdmit` — weighted quorum among current instance members (02) | bids, votes, and is pinned into `afp:quorumSnapshot` |

The asymmetry is the point. A `member` is a vote and a bid; if each operator mints its
own, quorum is whatever the most prolific operator says it is — spin up a hundred agents
and own every round. `requester` and `observer` confer no such leverage, so routing them
through governance would buy nothing and slow every onboarding.

This answers ADR-0004's revisit trigger directly: foreign-instance agents enroll as
`requester` or `observer` on their instance's own signature, and become `member` only by
a recorded quorum decision the record can replay.

## Options considered

| Option | Rejected because |
|---|---|
| Leave the trail trusted by issuer, as today | A rostered agent self-promotes to `member` and both implementations agree it belongs — the failure is invisible precisely where ADR-0004 put the most weight |
| The hub key admits members | Contradicts 02's standing rule that the hub key signs only transport-level things; it would hand the server operator the unilateral power 02 exists to deny |
| Every enrollment through quorum | Buys nothing for roles that cannot shift an outcome, and makes onboarding an observer a governance event — the kind of ceremony that gets worked around |
| An enrollment capability token issued by the hub | A bearer credential is state outside the record; the roster already binds agent to instance, and a rule over evidence beats a rule over secrets |
| Defer all of it to P4 | Decision 1 is free today and retroactively satisfied; deferring it means migrating a membership CRDT two operators already share — the exact trap ADR-0004 was written to avoid |

## Consequences

**Positive**

- Self-promotion stops being replayable-as-legitimate, in the trail that ADR-0004's bid
  admission, announce authority, asset registration and quorum pinning all resolve
  through.
- 02's two-level enrollment becomes a checkable property instead of a description of
  intent.
- P4 inherits a settled answer to "what role does a foreign agent start in," rather than
  discovering it during handshake design.

**Negative / accepted risks**

- Admitting a voting agent at P4 costs a quorum round. Accepted: that is what admitting a
  voter *is*, and 02 already priced it for `afp:MemberAdmit`.
- Decision 2 adds an obligation instances must satisfy before P4 — publishing a seat they
  currently hold implicitly. Accepted, and cheaper now than as a retrofit.
- A hub whose members never convene cannot admit new members. Accepted at consortium
  scale; a hub with no quorum has larger problems than onboarding.

**Revisit triggers**

| Trigger | Reconsider |
|---|---|
| P4 federation handshake design | Whether `Accept{Follow}` is the right seat evidence, or the `afp:FederationAgreement` subsumes it |
| An operator needs to promote an agent faster than its hub convenes | A delegated admission grant, bounded and recorded — not a hub-key shortcut |
| Role changes become frequent enough to churn the Enroll trail | Whether role belongs in its own CRDT rather than replayed from enrollment |

## References

- [02 — Enrollment is two-level](../02-hubs-and-state.md#enrollment-is-two-level-deliberately) ·
  [02 — Governance concentration, kept accountable](../02-hubs-and-state.md#governance-concentration-kept-accountable)
- [ADR-0004](0004-solo-foundation-hardening.md) — Decision 1 (roles) and H14
- [ADR-0002](0002-p2-hub-and-crdt-stack.md) — the hub's state and its trust boundaries
