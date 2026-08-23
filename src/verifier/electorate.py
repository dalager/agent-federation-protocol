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

#: Closed registry (ADR-0021 Decision 3). Both forms resolve from the record
#: alone, which is the whole security property: the excluded set is
#: *recomputed* from prior signed evidence rather than trusted, so a proposer
#: cannot recuse its opponents by declaring them recused. An unrecognised form
#: fails; it never falls through to a default (W0.7, the `REPUTATION_RULES`
#: precedent).
CAUSE_FORMS = ("equivocation-proof", "governance-subject")

#: 03's membership vocabulary, actuated for the first time by ADR-0021
#: Decision 4b. Dual-typed `["Remove", "afp:MemberExpel"]` /
#: `["Add", "afp:MemberAdmit"]`, so the AS2 verb travels beside the AFP one.
MEMBERSHIP_ACTIONS = ("afp:MemberExpel", "afp:MemberAdmit")


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


def membership_actuation(activity: dict) -> str | None:
    """`"afp:MemberExpel"` / `"afp:MemberAdmit"` for a membership actuation, or
    `None` for anything else (ADR-0021 Decision 4b).

    The `type` is a list — 03's vocabulary is dual-typed so an AS2 reader sees
    `Remove`/`Add` and an AFP reader sees the membership act — but a bare
    string is read too, because nothing in the protocol forbids one and a
    reader that only understands the list shape would silently ignore an
    actuation it ought to be checking.
    """
    kind = activity.get("type")
    names = kind if isinstance(kind, list) else [kind]
    return next((n for n in MEMBERSHIP_ACTIONS if n in names), None)


def proofs_convicting(agent: str, all_activities: list[dict], hub_actor: str | None = None) -> list[dict]:
    """Every on-record `afp:EquivocationProof` activity whose embedded pair
    convicts `agent` — optionally narrowed to one hub's proofs.

    `convicts` is recomputed rather than trusted, for the same reason
    `cause_resolves` recomputes it: an announcement typed
    `afp:EquivocationProof` is a claim until its two votes are read. The
    signatures on those votes are deliberately *not* re-verified here — that
    is V2's job in the replay-wide layer, and duplicating it would give two
    answers to one question (ADR-0021 W2's note on the same asymmetry).
    """
    from equivocation import equivocation_proof_votes

    from decision import wrapped_payload

    found: list[dict] = []
    for activity in all_activities:
        proof = wrapped_payload(activity, "afp:EquivocationProof")
        if proof is None:
            continue
        if hub_actor is not None and proof.get("afp:hub") != hub_actor:
            continue
        votes = equivocation_proof_votes(activity)
        if votes is None:
            continue
        if any(v.get("actor") == agent for v in votes):
            found.append(activity)
    return found


def cause_resolves(
    cause: dict, agent: str, proposal: dict, all_activities: list[dict]
) -> bool:
    """ADR-0021 Decision 3 / W2 `causeResolves` — does this recusal's declared
    cause actually resolve on the record, against this agent?

    This is the estimator wall of ADR-0004, transplanted one layer up. A
    proposer may recuse, but only the convicted and the accused: an
    `equivocation-proof` cause must name a proof that is present and that
    convicts *this* agent (not somebody else), and a `governance-subject`
    cause is only true on a round that pins this agent as its subject. Neither
    leg consults anybody's judgement, so neither can be argued with.

    Deliberate asymmetry, mirrored from the ADR: the cited proof must
    **convict**, but its signatures are not re-verified here — V2
    (`check_equivocation_proof`, replay-wide) owns that question and owning it
    twice would let the two answers drift.
    """
    if not isinstance(cause, dict):
        return False
    form = cause.get("afp:form")
    if form == "equivocation-proof":
        from equivocation import convicts, equivocation_proof_votes

        digest = cause.get("afp:proof")
        if not isinstance(digest, str):
            return False
        proof_activity = next(
            (a for a in all_activities if digest_of(a) == digest), None
        )
        if proof_activity is None:
            return False
        votes = equivocation_proof_votes(proof_activity)
        # `votes[0]["actor"] == agent` per W2: the pair shares one actor by
        # `convicts`'s own tuple rule, so the first vote's actor IS the
        # convicted party — reading it off one vote is not a shortcut.
        return (
            votes is not None
            and votes[0].get("actor") == agent
            and convicts(*votes)
        )
    if form == "governance-subject":
        return proposal.get("afp:governanceSubject") == agent
    return False  # closed registry (W0.7) — an unknown form never defaults


def zero_state(agent: str, hub_actor: str | None, all_activities: list[dict]) -> str:
    """ADR-0021 Decision 4 / W2 `zeroState` — which of the record's five states
    this agent is in: `clear`, `zeroed`, `zeroed-contested`,
    `zeroed-by-decision` or `restored`.

    The point of the table is what it refuses to do. Zeroing stays automatic
    and stays where ADR-0020 put it; a `afp:KeyCompromiseClaim` moves the
    state from `zeroed` to `zeroed-contested` and moves *nothing else* — it
    gates nothing, delays nothing and reverses nothing (W0.3). What the claim
    buys is that the record can finally tell a sanction from an incident,
    which is precisely as much as a protocol can offer and considerably more
    than one state could say.

    Restoration is a governance act and only a governance act: not time, not a
    key rotation (a new key is not a new party), and never retroactively — the
    caller scopes a restoration forward from the deciding activity's own
    `published` (Decision 4c), because a `DecisionRecord` is signed history.

    Whether a claim was published by the party entitled to publish it is V8's
    question, not this table's — the same one-answer-per-question discipline
    `cause_resolves` keeps with V2.
    """
    from decision import _decision_by_digest, find_proposal_for_round

    proofs = proofs_convicting(agent, all_activities, hub_actor)
    proof_digests = {digest_of(p) for p in proofs}

    claim = any(
        (claim_obj := afp_object(a, "afp:KeyCompromiseClaim")) is not None
        and claim_obj.get("afp:proof") in proof_digests
        for a in all_activities
    )

    decided: tuple[int, str] | None = None
    for activity in all_activities:
        kind = membership_actuation(activity)
        if kind is None:
            continue
        _, decision = _decision_by_digest(activity.get("afp:actsOn"), all_activities)
        if decision is None:
            continue
        proposal = find_proposal_for_round(decision.get("afp:round"), all_activities)
        if (proposal or {}).get("afp:governanceSubject") != agent:
            continue
        at = instant_millis(activity.get("published"))
        if decided is None or at >= decided[0]:
            decided = (at, kind)

    if decided is not None:
        return "restored" if decided[1] == "afp:MemberAdmit" else "zeroed-by-decision"
    if proofs and claim:
        return "zeroed-contested"
    if proofs:
        return "zeroed"
    return "clear"


def ratified_membership_acts(hub_actor: str, all_activities: list[dict]) -> list[dict]:
    """The `afp:MemberExpel` / `afp:MemberAdmit` activities this hub's members
    actually ratified — the half of the membership trail Enroll/Unenroll never
    carried (ADR-0021 Decision 4b).

    03 has said since v1 that these two *are* the membership decisions, and
    the fold simply never consumed them. Found the way this repository keeps
    finding this shape: an honest hub carried out an expulsion its own members
    ratified, `removeAgent` dropped the seat, `proposeRound` stopped pinning
    it — and `electorate_of`, reading only Enroll/Unenroll, still believed the
    expelled agent was a member, so every round pinned after a lawful
    expulsion failed V4 by name, forever. A mechanism attached to the wrong
    thing, invisible until something was built on top of it.

    **The hub cannot route around this with an `afp:Unenroll`.** Decision 1
    binds an Unenroll to the agent's own operating instance, and the hub is
    not the expelled agent's operator — so Decision 1 and Decision 4b have to
    interlock, and this is where they meet.

    **Only a ratified actuation edits the trail**, or Decision 1's hole
    reopens one door down: a bare `["Remove", "afp:MemberExpel"]` from anybody
    would become an unauthenticated membership-removal primitive again, which
    is precisely the defect that made this ADR necessary. So an act counts
    here only when V9 and V10 would hold for it — it binds to a real
    `afp:DecisionRecord`, that round pinned this very agent as its
    `afp:governanceSubject`, its `afp:action` is the one the round's own
    pinned `afp:actionPolicy` names for the outcome reached (without which an
    actuator could bind an expulsion to a round that decided to *retain*), and
    it is not signed by the hub's own key. A membership act that fails any leg
    is a finding under V9/V10 and is invisible here — it never silently edits
    the trail on its way to failing.

    Scoping, not authority: the `at_millis` cutoff belongs to the caller,
    which applies it to Enroll, Unenroll and these acts alike, so an expulsion
    at T moves no round pinned before T (W0.4).
    """
    from decision import _decision_by_digest, find_proposal_for_round

    # Every shipped bundle carries no membership actuation at all, and this
    # fold runs on every role lookup in the replay — so the cheap scan first.
    candidates = [a for a in all_activities if membership_actuation(a) is not None]
    if not candidates:
        return []

    ratified: list[dict] = []
    for activity in candidates:
        if activity.get("afp:hub") != hub_actor:
            continue
        # 02, with teeth: membership is decided by a weighted quorum among the
        # members, never by a signature from the hub's own key.
        if activity.get("actor") == hub_actor:
            continue
        _, decision = _decision_by_digest(activity.get("afp:actsOn"), all_activities)
        if decision is None:
            continue
        proposal = find_proposal_for_round(decision.get("afp:round"), all_activities) or {}
        if proposal.get("afp:governanceSubject") != activity.get("object"):
            continue
        policy = proposal.get("afp:actionPolicy")
        outcome = decision.get("afp:outcome")
        if not isinstance(policy, dict) or policy.get(outcome) != activity.get("afp:action"):
            continue
        ratified.append(activity)
    return ratified
