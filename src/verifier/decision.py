"""ADR-0002 Decision 3 — the three-check `afp:DecisionRecord` verifier extension.

Kept apart from `afp_verify.py` for the same reason `proof.py` is kept apart:
a reader auditing "what does the P2 extension actually check" should not have
to wade through the rest of the replay procedure to find it.

Per 04 "Replay procedure" step 7: recompute the tally from the referenced
votes, confirm every counted vote is actually producible, and confirm every
counted voter was inside the pinned quorum snapshot. All three are
set-membership and arithmetic over already-verified signatures — no new
cryptography, no consensus protocol.

Runs only when an export contains an `afp:DecisionRecord`; an export with
none (all of P1) runs none of this — backward compatible by construction.
"""

from __future__ import annotations

from datetime import datetime, timezone
from math import lcm

from proof import digest_of, verify_proof

_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def instant_millis(published) -> int:
    """`published` as epoch milliseconds — never as a raw string.

    Ordering timestamps by string comparison only matches chronological order
    when every writer happens to use one representation. It does not: the same
    instant is legally `2026-01-01T00:00:00Z` or `2026-01-01T00:00:00.000Z`
    ('.' < 'Z', so the string sort inverts the tie-break), and a negative UTC
    offset sorts before 'Z' while being chronologically *later*. The writer
    orders by `Date.parse` instants, so the verifier must too, or the two
    replay the same trail to different state.

    Mirrors JS `Date.parse(x) || 0`: unparseable -> 0, sub-millisecond
    precision truncated (integer arithmetic, no float rounding).
    """
    if not isinstance(published, str):
        return 0
    try:
        parsed = datetime.fromisoformat(published.replace("Z", "+00:00"))
    except ValueError:
        return 0
    if parsed.tzinfo is None:  # naive: JS Date.parse reads bare ISO as UTC
        parsed = parsed.replace(tzinfo=timezone.utc)
    delta = parsed - _EPOCH
    return delta.days * 86_400_000 + delta.seconds * 1000 + delta.microseconds // 1000


def afp_object(activity: dict, afp_type: str) -> dict | None:
    """The `afp:*` payload of an activity, whether it travels bare or wrapped.

    03 wraps payloads in standard AS2 activities — `Offer{afp:Proposal}`,
    `Create{afp:Vote}`, `Create{afp:DecisionRecord}` — while a bare activity
    typed `afp:*` is also accepted. Either way the fields live on the payload.
    """
    if activity.get("type") == afp_type:
        return activity
    obj = activity.get("object")
    if isinstance(obj, dict) and obj.get("type") == afp_type:
        return obj
    return None


def enrolled_roles(hub_actor: str, all_activities: list[dict]) -> dict[str, str]:
    """agent -> role for the hub's currently enrolled agents (ADR-0004 Decision 1).

    Replayed from the Enroll/Unenroll trail: role is per-agent last-writer-wins
    — latest `published` wins, equal timestamps break by higher activity digest.
    An Enroll without `afp:role` reads as `member`, so every pre-ADR-0004
    record is unchanged.
    """
    roles: dict[str, str] = {}
    trail = [
        a
        for a in all_activities
        if a.get("type") in ("afp:Enroll", "afp:Unenroll") and a.get("target") == hub_actor
    ]
    for activity in sorted(trail, key=lambda a: (instant_millis(a.get("published")), digest_of(a))):
        agent = activity.get("object")
        if not isinstance(agent, str):
            continue
        if activity.get("type") == "afp:Enroll":
            roles[agent] = activity.get("afp:role", "member")
        else:
            roles.pop(agent, None)
    return roles


def enrolled_instances(hub_actor: str, all_activities: list[dict]) -> dict[str, str]:
    """agent -> the instance that enrolled it (ADR-0005 Decision 2).

    Replayed from the same trail and with the same last-writer-wins rule as
    `enrolled_roles`. ADR-0005 binds the Enroll's actor to the agent's own
    `afp:operatedBy` — checked separately in `check_enroll_authority` — so
    this trail is what says which operator an agent counts for when a round is
    weighted per instance.
    """
    instances: dict[str, str] = {}
    trail = [
        a
        for a in all_activities
        if a.get("type") in ("afp:Enroll", "afp:Unenroll") and a.get("target") == hub_actor
    ]
    for activity in sorted(trail, key=lambda a: (instant_millis(a.get("published")), digest_of(a))):
        agent = activity.get("object")
        if not isinstance(agent, str):
            continue
        if activity.get("type") == "afp:Enroll":
            actor = activity.get("actor")
            if isinstance(actor, str):
                instances[agent] = actor
        else:
            instances.pop(agent, None)
    return instances


def voter_weights(voters: list[tuple[str, str]]) -> dict[str, int]:
    """`agent -> weight` for one round's pinned voters, per instance.

    ADR-0005 Decision 1: each seated instance carries the same total, divided
    among its pinned voters. With `n_I` the count of instance `I`'s voters and
    `L` their least common multiple, each of `I`'s voters carries `L / n_I`, so
    every instance sums to `L` and every weight is a whole number — fractions
    being unrepresentable in a signed AFP document, whose numeric profile
    forbids non-integer numbers.

    Deliberately reimplemented from the spec description rather than shared
    with `src/instance/src/hub/weights.ts`; the gate diffs the two on the same
    inputs.
    """
    if not voters:
        return {}
    counts: dict[str, int] = {}
    for _, instance in voters:
        counts[instance] = counts.get(instance, 0) + 1
    total = 1
    for instance in sorted(counts):
        total = lcm(total, counts[instance])
    return {agent: total // counts[instance] for agent, instance in voters}


def check_enroll_authority(report, authority, all_activities: list[dict]) -> None:
    """ADR-0005 Decision 2 — an Enroll is issued by the enrolled agent's own instance.

    A valid signature proves only that the actor wrote these bytes; it says
    nothing about whether that actor may enroll anyone. Unchecked, an agent
    publishes `Enroll{object: self, afp:role: member}` and both implementations
    agree it belongs — and since the same trail says which operator an agent
    counts for, a forged issuer forges a seat as well as a role.

    The agent's own actor document names its operator, so this resolves from
    evidence the replay already loads. An agent whose document names no
    operator cannot be enrolled by anyone: unbound is not a licence.
    """
    for activity in all_activities:
        if activity.get("type") != "afp:Enroll":
            continue
        agent = activity.get("object")
        if not isinstance(agent, str):
            continue
        actor = activity.get("actor")
        operator = authority.operated_by.get(agent)
        ok = operator is not None and actor == operator
        report.record(
            f"enroll: {agent.split('/')[-1]} enrolled by its own instance",
            ok,
            "" if ok else
            (f"enrolled by {actor!r} but {agent} is operated by {operator!r} (ADR-0005)"
             if operator is not None else
             f"{agent} publishes no afp:operatedBy, so no actor is entitled to enroll it"),
        )


def check_decision_record(
    report,
    decision_activity: dict,
    all_activities: list[dict],
    keys: dict[str, bytes],
) -> None:
    decision = afp_object(decision_activity, "afp:DecisionRecord") or {}
    label = decision.get("id", "<no id>")
    round_id = decision.get("afp:round")

    proposal = next(
        (
            obj
            for a in all_activities
            if (obj := afp_object(a, "afp:Proposal")) is not None
            and obj.get("afp:round") == round_id
        ),
        None,
    )
    if not report.record(
        f"decision: {label} has a matching afp:Proposal",
        proposal is not None,
        "" if proposal is not None else
        f"no afp:Proposal for afp:round {round_id!r} — voter weights and the pinned "
        f"voter set are unrecoverable",
    ):
        return

    declared_weights: dict[str, float] = proposal.get("afp:voterWeights", {})
    # The pinned set is the explicit voter list (02 "Snapshot-pinning"); the
    # weight map's keys are the fallback when a proposal omits it.
    pinned_voters = set(proposal.get("afp:voters", []) or declared_weights)
    by_digest = {digest_of(a): a for a in all_activities}

    # ADR-0004 Decision 1 — only member-role agents may ever be pinned into a
    # quorum snapshot; a requester or observer in afp:voters is a failure the
    # Enroll trail proves.
    hub_actor = decision.get("afp:hub") or proposal.get("afp:hub") or decision_activity.get("actor")
    roles = enrolled_roles(hub_actor, all_activities)
    # ADR-0005 Decision 1 — the pinned weights are recomputed, not trusted.
    # Recorded-so-a-verifier-can-see is not the same as checkable: without
    # this a hub simply writes the numbers it wants into its own proposal, and
    # the tally recomputation below would faithfully confirm them.
    instances = enrolled_instances(hub_actor, all_activities)
    recomputed = voter_weights(
        [(v, instances.get(v, v)) for v in sorted(proposal.get("afp:voters", []) or declared_weights)]
    )
    weights_match = all(
        recomputed.get(v, 0) == declared_weights.get(v, 0)
        for v in set(recomputed) | set(declared_weights)
    )
    report.record(
        f"decision: {label} voter weights recompute per instance",
        weights_match,
        "" if weights_match else
        f"recomputed {recomputed!r} but afp:Proposal declares {declared_weights!r} — each "
        f"seated instance carries the same total, divided among its pinned voters (ADR-0005)",
    )

    non_member_pinned = sorted(v for v in pinned_voters if roles.get(v, "member") != "member")
    report.record(
        f"decision: {label} pinned voters are member-role agents",
        not non_member_pinned,
        "" if not non_member_pinned else
        "afp:voters pins non-member-role agent(s) (ADR-0004): "
        + ", ".join(f"{v} ({roles.get(v)})" for v in non_member_pinned),
    )

    missing: list[str] = []
    counted_voters: set[str] = set()
    outside: list[tuple[str, str]] = []
    unsigned: list[str] = []
    tally: dict[str, float] = {}

    for vote_hash in decision.get("afp:countedVotes", []):
        vote_activity = by_digest.get(vote_hash)
        vote_obj = afp_object(vote_activity, "afp:Vote") if isinstance(vote_activity, dict) else None
        if vote_activity is None or vote_obj is None:
            # Check 2 — evidence-set completeness. A hash the export cannot
            # resolve to a present, signed afp:Vote is a failure by itself,
            # per 04: "a counted vote you cannot produce is a failure."
            missing.append(vote_hash)
            continue

        reason = verify_proof(vote_activity, keys)
        if reason is not None:
            unsigned.append(f"{vote_hash[:24]}… ({reason})")
            continue

        voter = vote_activity.get("actor")
        if voter not in pinned_voters:
            # Check 3 — snapshot discipline. Valid signature, wrong ballot:
            # the vote comes from outside the pinned afp:quorumSnapshot voter
            # set, e.g. a mid-round enrollment. Rejected even though it
            # verifies, per 02 "Snapshot-pinning."
            outside.append((vote_hash, voter))
            continue

        value = vote_obj.get("value")
        tally[value] = tally.get(value, 0) + declared_weights.get(voter, 0)
        counted_voters.add(voter)

    report.record(
        f"decision: {label} evidence-set completeness",
        not missing,
        "" if not missing else
        "afp:countedVotes names a hash with no present, valid afp:Vote to back it: "
        + ", ".join(h[:24] + "…" for h in missing),
    )
    report.record(
        f"decision: {label} counted votes are validly signed",
        not unsigned,
        "" if not unsigned else "counted vote fails signature verification: " + "; ".join(unsigned),
    )
    report.record(
        f"decision: {label} snapshot discipline",
        not outside,
        "" if not outside else
        "counted vote from outside the pinned quorum snapshot: "
        + ", ".join(f"{voter} ({h[:24]}…)" for h, voter in outside),
    )

    # Check 1 — tally recomputation, over whatever votes survived checks 2/3.
    # A pinned voter with no counted vote abstains by omission, and its weight
    # lands under "abstain" (04's DecisionRecord example carries that key).
    # Zero-weight entries on either side (an option nobody chose, an explicit
    # abstain: 0) are not a mismatch — compare over the union with default 0.
    abstain = sum(declared_weights.get(v, 0) for v in pinned_voters - counted_voters)
    if abstain:
        tally["abstain"] = tally.get("abstain", 0) + abstain
    declared_tally = decision.get("afp:weightTally", {})
    values_match = all(
        abs(tally.get(k, 0) - declared_tally.get(k, 0)) < 1e-9
        for k in set(tally) | set(declared_tally)
    )
    report.record(
        f"decision: {label} weightTally recomputes from countedVotes",
        values_match,
        "" if values_match else
        f"recomputed {tally!r} but afp:DecisionRecord declares {declared_tally!r}",
    )
