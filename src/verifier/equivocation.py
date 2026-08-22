"""ADR-0020 — the L1 round hardening: the equivocation predicate, succession,
and doom, recomputed from the record alone.

Kept apart from `decision.py` for the reason `keys.py` and `pins.py` are:
`vote_tuple_of`/`convicts` is the parity twin of TypeScript
`src/instance/src/hub/equivocation.ts` (`thresholdOf`/`threshold_of`'s
convention), and an auditor comparing the two implementations should find the
pair self-contained in one file, mirrored from the ADR's pseudocode alone —
never from the TypeScript internals.

Every function here is L1-conditional in effect, if not always in signature:
a pre-ADR-0020 bundle carries no `afp:Vote` with L1 fields, no
`afp:EquivocationProof`, no `afp:successionRule`, and no `afp:quorumImpossible`
close, so every caller in `decision.py` / `afp_verify.py` gates on that
material being present before calling in here — nothing below fires on its
own for a shipped pre-P6 export.
"""

from __future__ import annotations

from decision import afp_object, threshold_of, wrapped_payload


def vote_tuple_of(activity: dict) -> tuple[str, str, str, int] | None:
    """`(actor, afp:round, afp:phase, afp:seqNo)` off an `afp:Vote` activity,
    or `None` when any L1 field is missing or malformed (03 § Consensus
    hardening — Level 1): `afp:seqNo` must be an integer `>= 1` (a bool is
    not an integer here, the same convention `threshold_of` uses)."""
    vote = afp_object(activity, "afp:Vote")
    if vote is None:
        return None
    actor = activity.get("actor")
    round_id = vote.get("afp:round")
    phase = vote.get("afp:phase")
    seq_no = vote.get("afp:seqNo")
    if not isinstance(actor, str) or not isinstance(round_id, str) or not isinstance(phase, str):
        return None
    if isinstance(seq_no, bool) or not isinstance(seq_no, int) or seq_no < 1:
        return None
    return (actor, round_id, phase, seq_no)


def convicts(a: dict, b: dict) -> bool:
    """ADR-0020 Decision 2 / W2 — two `afp:Vote` activities are an
    equivocation pair iff they share `(actor, round, phase, seqNo)` and
    differ in `value` or `afp:proposalHash`.

    Signature validity of each vote is a separate leg, checked by the V2
    caller (`decision.check_equivocation_proof`) against the actor's
    published key — never folded in here, so this predicate stays exactly
    what the ADR states: recomputable from the tuple and the value alone.
    """
    tuple_a, tuple_b = vote_tuple_of(a), vote_tuple_of(b)
    if tuple_a is None or tuple_b is None or tuple_a != tuple_b:
        return False
    vote_a = afp_object(a, "afp:Vote") or {}
    vote_b = afp_object(b, "afp:Vote") or {}
    return (
        vote_a.get("value") != vote_b.get("value")
        or vote_a.get("afp:proposalHash") != vote_b.get("afp:proposalHash")
    )


def equivocation_proof_votes(activity: dict) -> tuple[dict, dict] | None:
    """The two embedded `afp:Vote` activities carried verbatim inside an
    `afp:EquivocationProof`, or `None` when it does not carry exactly two."""
    proof = wrapped_payload(activity, "afp:EquivocationProof")
    if proof is None:
        return None
    votes = proof.get("afp:votes")
    if not isinstance(votes, list) or len(votes) != 2:
        return None
    vote_a, vote_b = votes
    if not isinstance(vote_a, dict) or not isinstance(vote_b, dict):
        return None
    return vote_a, vote_b


def proof_round(activity: dict) -> str | None:
    """The `afp:round` an `afp:EquivocationProof` names, or `None`."""
    proof = wrapped_payload(activity, "afp:EquivocationProof")
    return proof.get("afp:round") if isinstance(proof, dict) else None


def convicted_actors_in_round(round_id: str, all_activities: list[dict]) -> set[str]:
    """Every actor with an on-record `afp:EquivocationProof` for `round_id` —
    the exclusion Decisions 3 and 4 both read: a convicted voter neither
    inherits a stalled round (`successor`) nor counts toward its reserve
    weight (`doomed`)."""
    convicted: set[str] = set()
    for activity in all_activities:
        if proof_round(activity) != round_id:
            continue
        votes = equivocation_proof_votes(activity)
        if votes is None:
            continue
        for vote in votes:
            actor = vote.get("actor")
            if isinstance(actor, str):
                convicted.add(actor)
    return convicted


def silent_actors_in_round(round_id: str, all_activities: list[dict]) -> set[str]:
    """Actors recorded `silent` in `round_id`'s `afp:DecisionRecord`'s
    `afp:uncounted` (ADR-0014 Decision 4) — the successor rule's second
    exclusion. A round with no DecisionRecord yet, or one carrying no
    `afp:uncounted`, excludes nobody on this ground."""
    for activity in all_activities:
        decision = afp_object(activity, "afp:DecisionRecord")
        if decision is None or decision.get("afp:round") != round_id:
            continue
        uncounted = decision.get("afp:uncounted")
        if not isinstance(uncounted, list):
            return set()
        return {
            str(entry.get("agent"))
            for entry in uncounted
            if isinstance(entry, dict)
            and entry.get("afp:status") == "silent"
            and isinstance(entry.get("agent"), str)
        }
    return set()


def successor(stalled_proposal_activity: dict, all_activities: list[dict]) -> str | None:
    """ADR-0020 Decision 3 / W2 — the pinned `afp:voters`, in their declared
    order, rotated to start after the stalled round's proposer, skipping any
    voter convicted or recorded silent for that round. The first survivor is
    the successor; `None` when the proposal pins no voters or every candidate
    is disqualified — "no sanctioned succession remains."

    "The stalled proposer" is the `actor` of the stalled `Offer{afp:Proposal}`
    ACTIVITY (the normative ruling on the W2 seam WP-2 flagged) — not
    necessarily a pinned voter itself. The hub actor signs proposals per
    ADR-0014, so the proposer is ordinarily outside `afp:voters` entirely;
    when it is not among them, rotation starts at the first pinned voter in
    declared order (`rotate(order, 0)`), rather than failing to resolve.
    """
    proposal = afp_object(stalled_proposal_activity, "afp:Proposal") or {}
    proposer = stalled_proposal_activity.get("actor")
    voters = proposal.get("afp:voters")
    if not isinstance(voters, list) or not voters:
        return None
    round_id = proposal.get("afp:round")
    convicted = convicted_actors_in_round(round_id, all_activities)
    silent = silent_actors_in_round(round_id, all_activities)
    start = (voters.index(proposer) + 1) if proposer in voters else 0
    order = voters[start:] + voters[:start]
    for candidate in order:
        if candidate in convicted or candidate in silent:
            continue
        return candidate
    return None


def doomed(
    proposal: dict,
    tally: dict[str, float],
    counted_voters: set[str],
    convicted: set[str],
) -> bool:
    """ADR-0020 Decision 4 — integer-only, recomputed from the pinned
    weights, the counted votes, and the on-record proofs alone:

        attainable(option) = tally[option]
                           + sum weight(v) for pinned v with no counted vote
                             and no on-record proof for this round
        doomed  <=>  every option's attainable < bar

    `bar` is `threshold_of` over the proposal's *declared* weights — the
    full pinned total, zeroed weight included, per Decision 4's ruling that
    the denominator moves only when the snapshot does. An unrecognised
    `afp:quorumRule` returns `False`: a bar the verifier cannot compute
    cannot justify an early close either.
    """
    declared_weights = proposal.get("afp:voterWeights", {})
    pinned_voters = set(proposal.get("afp:voters", []) or declared_weights)
    quorum_rule = proposal.get("afp:quorumRule")
    bar = threshold_of(quorum_rule, declared_weights) if isinstance(quorum_rule, dict) else None
    if bar is None:
        return False
    reserve = sum(
        declared_weights.get(v, 0)
        for v in pinned_voters
        if v not in counted_voters and v not in convicted
    )
    options = proposal.get("afp:options") or []
    if not options:
        return False  # no options is no arithmetic — an early close cannot be justified on it
    return all(tally.get(option, 0) + reserve < bar for option in options)
