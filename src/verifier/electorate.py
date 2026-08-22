"""ADR-0021 Decision 2 — the pinned electorate, recomputed.

Kept apart from `decision.py` for the reason `equivocation.py` is:
`electorate_of` is the parity twin of TypeScript's snapshot-pinning in
`Hub.proposeRound`, and an auditor comparing the two should find the pair
self-contained in one file, mirrored from the ADR's pseudocode alone — never
from the TypeScript internals.

The defect this closes is older than L1 and applies at every level: nothing
ever compared `afp:voters` against the Enroll trail, so a member omitted from a
round's electorate was indistinguishable from one that was never enrolled. Half
of the comparison is not recomputable and never will be — liveness is hub-local
CRDT state that is deliberately not exported — so the rule is not "recompute the
electorate" but "account for it": voters plus declared exclusions must be
exactly the member-role trail, and the two unfalsifiable statuses must at least
be *said* rather than left as an absence nobody can see.
"""

from __future__ import annotations

from decision import afp_object, enrolled_roles_at, instant_millis
from proof import digest_of

#: Closed registry (ADR-0021 W1). An unrecognised status fails; it never
#: falls through to a default.
EXCLUSION_STATUSES = ("not-live", "not-pinned", "recused")


def electorate_of(hub_actor: str, all_activities: list[dict], at_millis: int) -> set[str]:
    """The member-role agents enrolled at `at_millis` — the same fold the role
    checks already use, filtered to the one role a quorum snapshot may pin
    (ADR-0004 Decision 1)."""
    roles = enrolled_roles_at(hub_actor, all_activities, at_millis)
    return {agent for agent, role in roles.items() if role == "member"}


def excluded_entries(proposal: dict) -> list[dict]:
    """`afp:excluded` as a list of dicts, or `[]` — never `None`, so callers
    need no second shape check."""
    excluded = proposal.get("afp:excluded")
    return [e for e in excluded if isinstance(e, dict)] if isinstance(excluded, list) else []


def snapshot_matches(proposal: dict) -> bool:
    """ADR-0021 Decision 2a — `afp:quorumSnapshot` is the digest of the sorted
    voter list it travels with. Decorative since P2: the writer computes it,
    every vote echoes it, and no replay ever recomputed it."""
    voters = proposal.get("afp:voters")
    if not isinstance(voters, list):
        return False
    return proposal.get("afp:quorumSnapshot") == digest_of(sorted(voters))


def partition(proposal_activity: dict, all_activities: list[dict]) -> tuple[set[str], set[str], set[str]]:
    """`(missing, overlapping, enrolled)` for one proposal against the trail.

    `missing` is the finding: a member-role agent that is neither pinned nor
    declared. `overlapping` is an agent claimed on both sides. `enrolled` is
    returned so a caller can tell "the trail resolved and was empty" from "no
    trail is present in this replay" — the difference between a check that
    holds and one that is unresolvable.
    """
    proposal = afp_object(proposal_activity, "afp:Proposal") or {}
    hub_actor = proposal.get("afp:hub") or proposal_activity.get("actor")
    at = instant_millis(proposal_activity.get("published"))
    enrolled = electorate_of(hub_actor, all_activities, at)
    voters = {v for v in (proposal.get("afp:voters") or []) if isinstance(v, str)}
    excluded = {
        e["agent"] for e in excluded_entries(proposal) if isinstance(e.get("agent"), str)
    }
    return enrolled - (voters | excluded), voters & excluded, enrolled
