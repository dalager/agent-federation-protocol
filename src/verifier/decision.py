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


def threshold_of(rule: dict, weights: dict[str, float]) -> int | None:
    """ADR-0018 W2 — the quorum bar, in integers, from the proposal alone.

    Mirrors TypeScript `thresholdOf` (`src/instance/src/hub/quorum.ts`) byte
    for byte: `T` is the pinned total (every seat in `afp:voterWeights`, not
    just the seats that voted), `//` throughout — never a ratio, a percentage
    or a float, because the JCS numeric profile a signed object rides on
    forbids non-integers. An unrecognised `afp:form` returns `None`
    (`UNKNOWN_FORM`) rather than a guess: a rule a verifier cannot compute is
    worse than no rule, because it reads like a bar was set.
    """
    if not isinstance(rule, dict):
        return None
    total = sum(weights.values())
    form = rule.get("afp:form")
    if form == "majority-of-total":
        return total // 2 + 1
    if form == "two-thirds-of-total":
        return (2 * total) // 3 + 1
    if form == "explicit":
        threshold = rule.get("afp:threshold")
        # Same convention as `reputation._usable_cost`: a bool is an int in
        # Python but never a threshold, and an integer-valued float (legal on
        # the wire — JCS forbids only non-integers) is accepted like one.
        if isinstance(threshold, bool):
            return None
        if isinstance(threshold, int) and threshold >= 1:
            return threshold
        if isinstance(threshold, float) and threshold.is_integer() and threshold >= 1:
            return int(threshold)
        return None
    return None


def quorum_reachable(voters: list, weights: dict, quorum_rule: dict | None) -> bool:
    """ADR-0033 Decision 4's arithmetic — mirrors TypeScript `electorateExhausted`
    (`src/hub/governance.ts`) byte for byte, and is what parity pins: a round
    with no quorum rule is exhausted only when it has zero voters (the same
    "doom is meaningless without a bar" reading `doomed` uses); otherwise the
    pinned total (every seat in the weights, zeroed weight included, per
    `threshold_of`'s own convention) is compared against the bar. Named for
    what it returns — `True` means the electorate CAN still reach the bar —
    so `electorate_exhausted` below reads as its negation, not a double
    negative.
    """
    if not isinstance(quorum_rule, dict):
        return bool(voters)
    bar = threshold_of(quorum_rule, weights)
    if bar is None:
        return True  # an unresolvable rule fails its own named check elsewhere
    total = sum(weights.values())
    return total >= bar


def electorate_exhausted_of(voters: list, weights: dict, quorum_rule: dict | None) -> bool:
    """`electorate_exhausted`'s arithmetic leg alone, at the exact TypeScript
    `electorateExhausted(voters, weights, quorumRule)` call shape — kept
    separate so the parity harness (`run_parity.py`) can pin the arithmetic
    against `src/hub/governance.ts`'s function of the same name without also
    supplying a whole proposal shape on the TypeScript side, which that
    function never takes."""
    return not quorum_reachable(voters, weights, quorum_rule)


def electorate_exhausted(proposal: dict) -> bool:
    """ADR-0033 Decision 4's floor, recomputed from the pinned proposal alone:
    can the electorate, after *recusal*, still satisfy its pinned quorum
    rule at all?

    Two legs, both required — the same pair `Hub.proposeRound` gates
    `no-decision:electorate-exhausted` on (`hub/hub.ts`: `recused.size > 0 &&
    electorateExhausted(...)`): the proposal names at least one exclusion
    whose `afp:status` is `"recused"` (shrinkage by recusal, not by mere
    absence — a round nobody joined is `quorum-impossible` territory, not
    this), AND the pinned electorate cannot reach the pinned bar
    (`quorum_reachable` above, integers only per `threshold_of`).
    """
    excluded = [e for e in (proposal.get("afp:excluded") or []) if isinstance(e, dict)]
    recused = any(e.get("afp:status") == "recused" for e in excluded)
    if not recused:
        return False
    voters = proposal.get("afp:voters") or []
    weights = proposal.get("afp:voterWeights") or {}
    quorum_rule = proposal.get("afp:quorumRule")
    return electorate_exhausted_of(voters, weights, quorum_rule)


def find_proposal_for_round(round_id, all_activities: list[dict]) -> dict | None:
    """The `afp:Proposal` payload for a round id, or `None`.

    Factored out of `check_decision_record` so the ADR-0018 W5 V7-V14
    functions (`check_departure`, `check_decision_settlement`) can resolve a
    round's proposal the same way, without a second lookup convention.
    """
    return next(
        (
            obj
            for a in all_activities
            if (obj := afp_object(a, "afp:Proposal")) is not None
            and obj.get("afp:round") == round_id
        ),
        None,
    )


def proposal_activity_for(round_id, all_activities: list[dict]) -> dict | None:
    """The `Offer{afp:Proposal}` ACTIVITY for a round id, or `None`.

    `find_proposal_for_round` returns the payload, which carries no
    `published` — the envelope does. Anything that needs the instant a round
    was pinned (ADR-0021 Decision 1's membership cutoff, ADR-0005's effective
    operator) must read it here rather than off the payload.
    """
    return next(
        (
            a
            for a in all_activities
            if (obj := afp_object(a, "afp:Proposal")) is not None
            and obj.get("afp:round") == round_id
        ),
        None,
    )


def _decision_by_digest(digest, all_activities: list[dict]) -> tuple[dict | None, dict | None]:
    """`(activity, payload)` for the `afp:DecisionRecord` matching `digest`, or `(None, None)`."""
    for activity in all_activities:
        obj = afp_object(activity, "afp:DecisionRecord")
        if obj is not None and digest_of(activity) == digest:
            return activity, obj
    return None, None


def wrapped_payload(activity: dict, afp_type: str) -> dict | None:
    """An `afp:*` payload, preferring the wrapped `object` over the wrapper.

    Like `afp:Award` (see `allocation.py`), `afp:Settlement` and
    `afp:Departure` type their outer activity the same as their payload, so
    `afp_object`'s bare-or-wrapped preference for the outer shape would return
    the wrapper — which carries none of the fields being checked. Every
    double-typed activity must read through here; reading one through
    `afp_object` yields an empty payload and a check that passes on nothing.
    """
    obj = activity.get("object")
    if isinstance(obj, dict) and obj.get("type") == afp_type:
        return obj
    return afp_object(activity, afp_type)


def settlement_payload(activity: dict) -> dict | None:
    """An `afp:Settlement`'s payload — see `wrapped_payload`."""
    return wrapped_payload(activity, "afp:Settlement")


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


# A sentinel later than any instant a record can carry, so `enrolled_roles`
# can be `enrolled_roles_at`'s zero-argument-equivalent caller without a
# second fold — ADR-0019 W5 V3's note: "no existing check shifts."
_MAX_MILLIS = 2**62


def enrolled_roles_at(hub_actor: str, all_activities: list[dict], at_millis: int) -> dict[str, str]:
    """agent -> role for the hub's enrolled agents as of `at_millis` (ADR-0019
    W5 V3), replayed from the Enroll/Unenroll trail.

    The same last-writer-wins fold `enrolled_roles` uses — latest `published`
    wins, equal timestamps break by higher activity digest — stopped at
    `at_millis`: an Enroll/Unenroll published after that instant never enters
    the fold. `enrolled_roles` is this function at `at_millis = _MAX_MILLIS`,
    i.e. "as of now" — so there is one fold, not two, and no existing check
    shifts behaviour.
    ADR-0021 Decision 4b: the trail is Enroll/Unenroll **and ratified
    membership actuations**. 03's `afp:MemberExpel`/`afp:MemberAdmit` have
    been the membership decisions since v1 and this fold never consumed them,
    so a lawful expulsion left the seat in the electorate forever and every
    round the hub pinned afterwards failed V4 by name. Only *ratified* acts
    enter — `ratified_membership_acts` documents what that costs and why it
    may not be relaxed — and they are cut at the same `at_millis` as
    everything else, so an expulsion at T moves no round pinned before T and a
    `MemberAdmit` restores forward only (Decision 4c). Signed history does not
    move in either direction.

    The hub cannot reach the same end with an `afp:Unenroll`: Decision 1 binds
    that to the agent's own operating instance, and the hub is not the
    expelled agent's operator. Decision 1 and Decision 4b interlock here.
    """
    from electorate import membership_actuation, ratified_membership_acts

    roles: dict[str, str] = {}
    # An expelled seat's last declared role, so a later MemberAdmit restores
    # what the agent actually held rather than inventing one. An agent
    # readmitted with no Enroll anywhere in the trail reads as `member`, which
    # is the role a governance round is about.
    held: dict[str, str] = {}
    trail = [
        a
        for a in all_activities
        if a.get("type") in ("afp:Enroll", "afp:Unenroll")
        and a.get("target") == hub_actor
        and instant_millis(a.get("published")) <= at_millis
    ]
    trail += [
        a
        for a in ratified_membership_acts(hub_actor, all_activities)
        if instant_millis(a.get("published")) <= at_millis
    ]
    for activity in sorted(trail, key=lambda a: (instant_millis(a.get("published")), digest_of(a))):
        agent = activity.get("object")
        if not isinstance(agent, str):
            continue
        if activity.get("type") == "afp:Enroll":
            held[agent] = roles[agent] = activity.get("afp:role", "member")
        elif membership_actuation(activity) == "afp:MemberAdmit":
            roles[agent] = held.get(agent, "member")
        else:  # afp:Unenroll, afp:MemberExpel
            roles.pop(agent, None)
    return roles


def enrolled_roles(hub_actor: str, all_activities: list[dict]) -> dict[str, str]:
    """agent -> role for the hub's currently enrolled agents (ADR-0004 Decision 1).

    Replayed from the Enroll/Unenroll trail: role is per-agent last-writer-wins
    — latest `published` wins, equal timestamps break by higher activity digest.
    An Enroll without `afp:role` reads as `member`, so every pre-ADR-0004
    record is unchanged. `enrolled_roles_at`'s zero-argument-equivalent caller
    (ADR-0019 W5 V3) — the same fold, "as of now."
    """
    return enrolled_roles_at(hub_actor, all_activities, _MAX_MILLIS)


def enrolled_instances(
    hub_actor: str, all_activities: list[dict], at_millis: int = _MAX_MILLIS
) -> dict[str, str]:
    """agent -> the instance that enrolled it (ADR-0005 Decision 2), as of `at_millis`.

    Replayed from the same trail and with the same last-writer-wins rule as
    `enrolled_roles`. ADR-0005 binds the Enroll's actor to the agent's own
    `afp:operatedBy` — checked separately in `check_enroll_authority` — so
    this trail is what says which operator an agent counts for when a round is
    weighted per instance.

    ADR-0021 Decision 1's second corollary: the cutoff is the one
    `enrolled_roles_at` always had and this fold never did. Without it an
    Enroll or Unenroll published *after* a round closed still moved the
    operator bucket that round's weights are recomputed against — a signed,
    closed round's arithmetic changing because of a later membership act,
    which is the same defect ADR-0020's forward-scoping rule exists to
    prevent. Defaulting to `_MAX_MILLIS` keeps every caller that means "as of
    now" behaving exactly as before.
    ADR-0021 Decision 4b: ratified membership actuations fold here too, for
    the same reason they fold into `enrolled_roles_at` — an expelled seat must
    leave its operator's bucket, or one operator keeps carrying weight for a
    seat the members voted away.

    A `MemberAdmit` restores the agent to **the instance that enrolled it**,
    never to the actuator that carried the decision out. The actuator is
    whichever member published the act; attributing the readmitted seat to it
    would hand that member a seat belonging to somebody else's operator, and
    quietly re-divide every per-operator weight in the next round.
    """
    from electorate import membership_actuation, ratified_membership_acts

    instances: dict[str, str] = {}
    enrolled_by: dict[str, str] = {}
    trail = [
        a
        for a in all_activities
        if a.get("type") in ("afp:Enroll", "afp:Unenroll")
        and a.get("target") == hub_actor
        and instant_millis(a.get("published")) <= at_millis
    ]
    trail += [
        a
        for a in ratified_membership_acts(hub_actor, all_activities)
        if instant_millis(a.get("published")) <= at_millis
    ]
    for activity in sorted(trail, key=lambda a: (instant_millis(a.get("published")), digest_of(a))):
        agent = activity.get("object")
        if not isinstance(agent, str):
            continue
        if activity.get("type") == "afp:Enroll":
            actor = activity.get("actor")
            if isinstance(actor, str):
                enrolled_by[agent] = instances[agent] = actor
        elif membership_actuation(activity) == "afp:MemberAdmit":
            if agent in enrolled_by:
                instances[agent] = enrolled_by[agent]
        else:  # afp:Unenroll, afp:MemberExpel
            instances.pop(agent, None)
    return instances


def effective_operator(
    instance: str, at_published: str, all_activities: list[dict]
) -> str:
    """The operator `instance` had declared itself operated by, as of `at_published`
    (ADR-0005 amendment: declared change of control).

    The latest `Create{afp:ControlTransfer}` on `instance`'s own chain with a
    `published` no later than the proposal being checked — never a later one,
    so a snapshot already pinned never moves when a later merger is declared.
    Absent any such activity, `instance` is its own operator: today's
    behaviour, unchanged when the feature is unused.
    """
    transfers = [
        a
        for a in all_activities
        if a.get("type") == "Create"
        and a.get("actor") == instance
        and isinstance(a.get("object"), dict)
        and a["object"].get("type") == "afp:ControlTransfer"
        and instant_millis(a.get("published")) <= instant_millis(at_published)
    ]
    if not transfers:
        return instance
    latest = max(transfers, key=lambda a: (instant_millis(a.get("published")), digest_of(a)))
    operated_by = latest["object"].get("afp:operatedBy")
    return operated_by if isinstance(operated_by, str) and operated_by else instance


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
    """ADR-0005 Decision 2 / ADR-0021 Decision 1 — an Enroll *or Unenroll* is
    issued by the agent's own instance.

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
        kind = activity.get("type")
        if kind not in ("afp:Enroll", "afp:Unenroll"):
            continue
        agent = activity.get("object")
        if not isinstance(agent, str):
            continue
        actor = activity.get("actor")
        operator = authority.operated_by.get(agent)
        ok = operator is not None and actor == operator
        # ADR-0021 Decision 1: the identical binding, on the identical
        # evidence, for the activity that REMOVES a seat. This loop filtered
        # `type != "afp:Enroll"` until 2026-08-22, so nothing anywhere asked
        # who signed an Unenroll — and the hub did not ask either, which made
        # membership removal an unauthenticated primitive that replayed clean.
        # Every fold below (`enrolled_roles_at`, `enrolled_instances`) reads
        # this trail; an unchecked half makes the whole of it advisory.
        verb, adr = ("enroll", "ADR-0005") if kind == "afp:Enroll" else ("unenroll", "ADR-0021")
        report.record(
            f"{verb}: {agent.split('/')[-1]} {verb}ed by its own instance",
            ok,
            "" if ok else
            (f"{verb}ed by {actor!r} but {agent} is operated by {operator!r} ({adr})"
             if operator is not None else
             f"{agent} publishes no afp:operatedBy, so no actor is entitled to {verb} it"),
        )


def check_decision_record(
    report,
    decision_activity: dict,
    all_activities: list[dict],
    keys: dict[str, bytes],
    pool: list[dict] | None = None,
    received: set[str] | None = None,
) -> None:
    decision = afp_object(decision_activity, "afp:DecisionRecord") or {}
    label = decision.get("id", "<no id>")
    round_id = decision.get("afp:round")

    # ADR-0010 Decision 3 — when a DecisionRecord ratifies a Synthesis, an
    # action MAY bind to it via afp:actsOn and the verifier follows the one
    # hop through afp:outcome. That makes afp:outcome load-bearing only for a
    # DecisionRecord actually used that way; a plain quorum vote (ADR-0002)
    # carries an arbitrary chosen value in afp:outcome (e.g. a policy option),
    # not a Synthesis id, and is untouched by this check.
    decision_digest = digest_of(decision_activity)
    used_for_actuation = any(a.get("afp:actsOn") == decision_digest for a in all_activities)
    outcome_id = decision.get("afp:outcome")
    # ADR-0019 W1/W2 — a round whose own proposal pins an afp:actionPolicy is
    # a governance round: afp:outcome is one of its options (or afp:no-
    # decision), never a Synthesis id, and W2's third resolution root reads
    # it that way. This check is for the other shape — a DecisionRecord that
    # ratifies a Synthesis (ADR-0010 Decision 3) — so a proposal-pinned round
    # skips it entirely rather than failing an expectation that never applied.
    governing_proposal = find_proposal_for_round(round_id, all_activities)
    is_governance_round = isinstance(governing_proposal, dict) and isinstance(
        governing_proposal.get("afp:actionPolicy"), dict
    )
    # ADR-0018 W6 — afp:no-decision is a terminal that ratifies nothing; it is
    # never a Synthesis id to resolve, however this branch's actuation trigger
    # got tripped.
    if (
        used_for_actuation
        and not is_governance_round
        and isinstance(outcome_id, str)
        and outcome_id != "afp:no-decision"
    ):
        outcome_synthesis = next(
            (
                obj
                for a in all_activities
                if (obj := afp_object(a, "afp:Synthesis")) is not None and obj.get("id") == outcome_id
            ),
            None,
        )
        report.record(
            f"decision: {label} outcome names a producible Synthesis",
            outcome_synthesis is not None,
            "" if outcome_synthesis is not None else
            f"afp:outcome names {outcome_id!r}, which resolves to no present "
            f"afp:Synthesis (ADR-0010)",
        )

    proposal = governing_proposal
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
    # ADR-0016: counted votes resolve from the thread pool — own plus
    # received — because with the hub's inbox live, a foreign member's vote
    # reaches the hub host as received bytes (the same grain ADR-0015 N2
    # ruled for declines). Phase two's received-check verifies those bytes
    # against the sender's own bundle; nothing here is trusted more.
    by_digest = {digest_of(a): a for a in (pool if pool is not None else all_activities)}

    hub_actor = decision.get("afp:hub") or proposal.get("afp:hub") or decision_activity.get("actor")
    # ADR-0005 Decision 1 — the pinned weights are recomputed, not trusted.
    # Recorded-so-a-verifier-can-see is not the same as checkable: without
    # this a hub simply writes the numbers it wants into its own proposal, and
    # the tally recomputation below would faithfully confirm them.
    # ADR-0021 Decision 1: read the membership trail as of the round being
    # weighed, never as of "now" — a later Unenroll must not move a closed
    # round's operator buckets.
    #
    # The instant is the PROPOSAL activity's `published`, resolved through
    # `proposal_activity_for`. `published` lives on the activity envelope and
    # never on the `afp:Proposal` payload, so the long-standing
    # `proposal.get("published") or decision_activity.get("published")` idiom
    # always resolved to the *close* instant — late enough to admit exactly
    # the membership acts this cutoff exists to exclude. Kept as the last
    # fallback so a bundle whose proposal activity cannot be located behaves
    # as it did before.
    proposal_activity = proposal_activity_for(round_id, all_activities)
    proposal_published = (
        (proposal_activity or {}).get("published")
        or proposal.get("published")
        or decision_activity.get("published")
    )
    at_proposal = instant_millis(proposal_published)
    instances = enrolled_instances(hub_actor, all_activities, at_proposal)
    # ADR-0004 Decision 1 — only member-role agents may ever be pinned into a
    # quorum snapshot; a requester or observer in afp:voters is a failure the
    # Enroll trail proves. Read as of the SAME instant as the weights beside
    # it, never as of "now": this was the one recompute in this function left
    # on the untimed fold, and once that fold began consuming ADR-0021
    # Decision 4b's ratified expulsions, a MemberExpel landing after a round
    # closed retroactively changed that closed round's role view — the same
    # class of defect as Decision 1's second corollary, one call site further
    # on.
    roles = enrolled_roles_at(hub_actor, all_activities, at_proposal)
    # ADR-0005 amendment (declared change of control) — an instance's weight
    # bucket is its *effective* operator as of this proposal's own `published`,
    # not necessarily itself; absent any Create{afp:ControlTransfer} this is
    # the identity function, so a bundle with no such activity recomputes
    # exactly as before.
    recomputed = voter_weights(
        [
            (v, effective_operator(instances.get(v, v), proposal_published, all_activities))
            for v in sorted(proposal.get("afp:voters", []) or declared_weights)
        ]
    )
    weights_match = all(
        recomputed.get(v, 0) == declared_weights.get(v, 0)
        for v in set(recomputed) | set(declared_weights)
    )
    report.record(
        f"weights: {label} pinned weights honor declared control",
        weights_match,
        "" if weights_match else
        f"recomputed {recomputed!r} but afp:Proposal declares {declared_weights!r} — each "
        f"effective operator carries the same total, divided among its pinned voters, "
        f"honoring any declared change of control (ADR-0005)",
    )

    # The `"member"` default is deliberate and must not be tightened into a
    # failure. An `afp:Enroll` is issued by the enrolling agent's own instance
    # (ADR-0005 Decision 2) and therefore lives on that agent's own chain, so
    # a hub host's bundle carries only its own Enroll and every foreign pinned
    # voter is simply *absent* from this domain's fold. Measured, not
    # reasoned: making absence a failure fails every hub host in the
    # repository — p5 alpha and p6 atlas both go red, naming the four or five
    # members whose Enrolls live in their own bundles. This is the same
    # one-directional asymmetry that makes ADR-0021's V4 three-valued, and it
    # is correct here for the identical reason.
    #
    # The limit that leaves, recorded rather than papered over: **nothing
    # verifies that a pinned voter WAS an enrolled member at the proposal's
    # instant.** V4 checks `enrolled ⊆ voters ∪ excluded` and never the
    # converse, and this check defaults absentees to `member` — so a hub may
    # still pin a stranger, or a seat it expelled last week, and replay clean.
    # Closing it needs a completeness signal no bundle carries today and a
    # replay-wide, three-valued check in V4's shape; it is an ADR-sized
    # question, not a line to change here.
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
    proposal_deadline = proposal.get("afp:deadline")
    late: list[tuple[str, str]] = []
    # ADR-0020 W3 V3/V4 — every vote actually counted, kept alongside the
    # tally so the L1 checks below can recompute over exactly what counted,
    # without a second pass over afp:countedVotes.
    counted_vote_records: list[tuple[str, dict, str]] = []

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
            # ADR-0016: a counted vote held as received bytes crossed the
            # boundary to reach this hub, and its author's keys live in the
            # author's bundle, not this one. Phase two's received-check
            # verifies exactly those bytes against the sender — failing them
            # here against the wrong key table would make every foreign vote
            # unverifiable by construction. Own-bundle votes still fail here.
            if received is None or vote_hash not in received:
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
        counted_vote_records.append((vote_hash, vote_activity, voter))

        # ADR-0018 W4/V5 — a counted vote whose own `published` is after the
        # proposal's `afp:deadline` closes the "signed lie" half of the
        # double enforcement: the hub's own clock gate (W4) is not evidence a
        # verifier holding only the bundle can recompute, but the vote's
        # self-signed `published` is.
        if isinstance(proposal_deadline, str) and instant_millis(vote_activity.get("published")) > instant_millis(proposal_deadline):
            late.append((vote_hash, voter))

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

    # ADR-0014 Decision 4 — afp:uncounted, where the record carries it. Two
    # silences that used to look identical: a member that recorded a Reject of
    # the proposal (declined — participation without assent) and one from whom
    # nothing arrived at all (silent — which during a partition is not an
    # abstention). The field is opt-in for compatibility: records closed
    # before ADR-0014 never accounted for anyone and are checked as before.
    uncounted = decision.get("afp:uncounted")
    if isinstance(uncounted, list):
        uncounted_agents = {
            str(entry.get("agent"))
            for entry in uncounted
            if isinstance(entry, dict) and isinstance(entry.get("agent"), str)
        }
        overlap = counted_voters & uncounted_agents
        partitioned = (
            len(uncounted_agents) == len(uncounted)
            and not overlap
            and counted_voters | uncounted_agents == pinned_voters
        )
        report.record(
            f"decision: {label} afp:uncounted partitions the pinned electorate",
            partitioned,
            "" if partitioned else
            f"counted voters plus afp:uncounted must equal the pinned snapshot exactly — "
            f"counted {sorted(counted_voters)!r}, uncounted {sorted(uncounted_agents)!r}, "
            f"pinned {sorted(pinned_voters)!r}"
            + (f", overlap {sorted(overlap)!r}" if overlap else "")
            + " (ADR-0014)",
        )

        undeclined = []
        for entry in uncounted:
            if not isinstance(entry, dict) or entry.get("afp:status") != "declined":
                continue
            agent = str(entry.get("agent"))
            proposal_id = None
            for a in all_activities:
                obj = afp_object(a, "afp:Proposal")
                if obj is not None and obj.get("afp:round") == decision.get("afp:round"):
                    proposal_id = obj.get("id")
                    break
            # ADR-0015 N2: the Reject may be a foreign member's, held here as
            # received bytes — a decline crosses the boundary the way
            # everything cross-boundary does, and phase two then verifies
            # those bytes against the sender's own bundle like any received
            # entry. The pool is own-plus-received; absent one, fall back to
            # the bundle's own activities exactly as before.
            search = pool if pool is not None else all_activities
            rejected = any(
                a.get("type") == "Reject" and a.get("actor") == agent and a.get("object") == proposal_id
                for a in search
            )
            if not rejected:
                undeclined.append(agent)
        report.record(
            f"decision: {label} declined members declined on the record",
            not undeclined,
            "" if not undeclined else
            "afp:uncounted marks " + ", ".join(undeclined) + " as declined, but the bundle "
            "holds no Reject of this round's proposal from them — a decline the record "
            "cannot produce (ADR-0014)",
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

    # ADR-0018 W5 — V1-V6, the round-as-a-commitment checks. Every one of
    # these is conditional on the W1 property it reads being present on the
    # proposal or the record, so a pre-ADR-0018 record — no afp:quorumRule,
    # no afp:deadline, no afp:binding, outcome never afp:no-decision —
    # triggers none of them, and the shipped export/, export-p2, export-p3
    # bundles replay with the same check counts as before this ADR.
    quorum_rule = proposal.get("afp:quorumRule")
    options = proposal.get("afp:options") or []
    outcome = decision.get("afp:outcome")

    if isinstance(quorum_rule, dict):
        # V1 — a rule a verifier cannot compute is a failure, not a skip
        # (W2): silently ignoring an unknown afp:form would let a bar read as
        # set when nothing was checkable.
        bar = threshold_of(quorum_rule, declared_weights)
        report.record(
            f"decision: {label} quorum rule is a known form",
            bar is not None,
            "" if bar is not None else
            f"afp:quorumRule names an unrecognised afp:form {quorum_rule.get('afp:form')!r} (ADR-0018)",
        )
        # V2 — the check finding 51 exists for: a real-option outcome that
        # did not in fact clear the pinned bar.
        if bar is not None and isinstance(outcome, str) and outcome in options:
            cleared = tally.get(outcome, 0) >= bar
            report.record(
                f"decision: {label} outcome cleared the pinned quorum rule",
                cleared,
                "" if cleared else
                f"afp:outcome {outcome!r} tallies {tally.get(outcome, 0)!r}, below the pinned "
                f"bar {bar} (ADR-0018)",
            )

    if outcome == "afp:no-decision":
        # V3 — the reserved outcome always carries a reason from the closed
        # set; anything else is an outcome that reads as decided-nothing with
        # no recomputable account of why.
        reason = decision.get("afp:noDecisionReason")
        # ADR-0020 Decision 4 adds the third reason: a round closed early
        # because the arithmetic already proved no option can reach the bar.
        # ADR-0033 Decision 4 adds the fourth reason: a round opened and
        # immediately closed because recusal left its pinned electorate
        # unable to satisfy its pinned quorum rule at all.
        reason_known = reason in ("expired", "threshold-not-met", "quorum-impossible", "electorate-exhausted")
        report.record(
            f"decision: {label} no-decision carries a reason",
            reason_known,
            "" if reason_known else
            f"afp:outcome is afp:no-decision but afp:noDecisionReason is {reason!r}, not "
            f"'expired', 'threshold-not-met', 'quorum-impossible' or 'electorate-exhausted' "
            f"(ADR-0018/ADR-0020/ADR-0033)",
        )
        # V4 — the reason is recomputable, not asserted: `threshold-not-met`
        # requires the actual winner to have missed the bar, `expired`
        # requires the record's own `published` to be past the deadline —
        # W3's `at` is the close instant, and the record's `published` is the
        # verifier's only stand-in for it.
        if reason_known:
            winner = None
            winner_weight = None
            for opt in list(options) + ["abstain"]:
                weight = tally.get(opt, 0)
                if winner_weight is None or weight > winner_weight:
                    winner, winner_weight = opt, weight
            bar = threshold_of(quorum_rule, declared_weights) if isinstance(quorum_rule, dict) else None
            if reason == "threshold-not-met":
                justified = bar is None or winner == "abstain" or (winner_weight or 0) < bar
            elif reason == "expired":
                deadline = proposal.get("afp:deadline")
                justified = isinstance(deadline, str) and instant_millis(decision_activity.get("published")) > instant_millis(deadline)
            elif reason == "quorum-impossible":  # ADR-0020 W3 V5
                from equivocation import convicted_actors_in_round, doomed

                convicted = convicted_actors_in_round(round_id, all_activities)
                justified = doomed(proposal, tally, counted_voters, convicted)
            else:  # "electorate-exhausted" — ADR-0033 Decision 4
                justified = electorate_exhausted(proposal)
            report.record(
                f"decision: {label} no-decision reason is justified",
                justified,
                "" if justified else
                (f"reason is 'threshold-not-met' but the winning option {winner!r} tallies "
                 f"{winner_weight!r}, at or above the bar {bar} (ADR-0018)"
                 if reason == "threshold-not-met" else
                 f"reason is 'expired' but the record's published {decision.get('published')!r} is "
                 f"at or before afp:deadline {proposal.get('afp:deadline')!r} (ADR-0018)"
                 if reason == "expired" else
                 f"reason is 'quorum-impossible' but the recomputed doomed predicate does not "
                 f"hold — some option remains attainable (ADR-0020)"
                 if reason == "quorum-impossible" else
                 f"reason is 'electorate-exhausted' but the pinned electorate, after its recused "
                 f"exclusions, can still satisfy the pinned quorum rule — or no exclusion is "
                 f"recorded as recused at all (ADR-0033)"),
            )

    if isinstance(proposal_deadline, str):
        # V5 — the other half of W4's double enforcement: a counted vote
        # whose own signed published is after the deadline.
        report.record(
            f"decision: {label} counted votes respect the deadline",
            not late,
            "" if not late else
            "counted vote published after afp:deadline: "
            + ", ".join(f"{voter} ({h[:24]}…)" for h, voter in late) + " (ADR-0018)",
        )

    if isinstance(quorum_rule, dict) or isinstance(proposal_deadline, str) or isinstance(proposal.get("afp:binding"), str):
        # V6 — the reserved value can never be a real option; a proposal that
        # lists it fails replay rather than being silently disambiguated.
        reserved_listed = "afp:no-decision" in options
        report.record(
            f"decision: {label} afp:no-decision is not an option",
            not reserved_listed,
            "" if not reserved_listed else
            "afp:options lists the reserved value afp:no-decision (ADR-0018)",
        )

    # ADR-0020 W3 V3/V4 — conditional on this round actually running at L1;
    # a pre-ADR-0020 round (afp:level absent) triggers neither.
    if proposal.get("afp:level") == 1:
        from equivocation import convicted_actors_in_round, vote_tuple_of

        convicted = convicted_actors_in_round(round_id, all_activities)
        convicted_counted = sorted({voter for _, _, voter in counted_vote_records if voter in convicted})
        report.record(
            f"decision: {label} tally counts no convicted ballot",
            not convicted_counted,
            "" if not convicted_counted else
            "counted vote(s) from actor(s) with an on-record afp:EquivocationProof for this "
            "round: " + ", ".join(convicted_counted) + " (ADR-0020)",
        )

        seen_tuples: dict[tuple, str] = {}
        duplicate_tuples: list[tuple] = []
        for vote_hash, vote_activity, _voter in counted_vote_records:
            tup = vote_tuple_of(vote_activity)
            if tup is None:
                continue
            prior = seen_tuples.get(tup)
            if prior is not None and prior != vote_hash:
                duplicate_tuples.append(tup)
            else:
                seen_tuples[tup] = vote_hash
        report.record(
            f"decision: {label} tally counts each tuple once",
            not duplicate_tuples,
            "" if not duplicate_tuples else
            "two counted votes share (actor, phase, seqNo): "
            + ", ".join(str(t) for t in duplicate_tuples) + " (ADR-0020)",
        )


def check_departure(report, activity: dict, all_activities: list[dict]) -> None:
    """ADR-0018 W5/W6 — V7-V9, the `afp:Departure` checks.

    A Departure is a pinned voter's public record of leaving a binding
    decision it lost. Unchecked it is a bare claim; V7-V9 make it
    recomputable: the decision it names must actually be present, the
    departing actor must actually have been pinned to vote on that round, and
    the round must actually have been declared `afp:binding: "joint"` — a
    Departure from an advisory round, or from an agent that was never seated,
    departs nothing.
    """
    departure = wrapped_payload(activity, "afp:Departure") or {}
    label = departure.get("id", "<no id>")
    decision_digest = departure.get("afp:decision")
    _decision_activity, decision = _decision_by_digest(decision_digest, all_activities)
    resolves = decision is not None
    report.record(
        f"departure: {label} names a producible DecisionRecord",
        resolves,
        "" if resolves else
        f"afp:decision {decision_digest!r} resolves to no present afp:DecisionRecord activity "
        f"in the pool (ADR-0018)",
    )
    if not resolves:
        return

    round_id = decision.get("afp:round")
    proposal = find_proposal_for_round(round_id, all_activities)
    pinned_voters = set((proposal or {}).get("afp:voters", []) or {})
    actor = activity.get("actor")
    is_pinned = actor in pinned_voters
    report.record(
        f"departure: {label} is by a pinned voter of that round",
        is_pinned,
        "" if is_pinned else
        f"{actor!r} departs afp:round {round_id!r} without being one of its pinned afp:voters "
        f"(ADR-0018)",
    )

    is_binding = (proposal or {}).get("afp:binding") == "joint"
    report.record(
        f"departure: {label} departs a binding decision",
        is_binding,
        "" if is_binding else
        f"afp:round {round_id!r}'s proposal does not declare afp:binding: \"joint\" (ADR-0018)",
    )


def check_decision_settlement(
    report,
    activity: dict,
    all_activities: list[dict],
    pool: list[dict],
    seen_rounds: dict[str, str],
) -> None:
    """ADR-0018 W5 — V10-V14, the decision-subject `afp:Settlement` checks.

    Mutually exclusive with the allocation settlement's `afp:task` (W1): this
    is the variant that closes a round rather than a task. V13 is the one
    worth reading twice — *dissent* is "voted something other than what the
    record decided", *vindicated* is "voted what the world turned out to
    be", and both are recomputed here from `afp:countedVotes`, never trusted
    from the settlement's own `afp:dissentVindicated` list, so a hub can
    neither hand standing to a majority voter nor withhold it from an actual
    dissenter without the check catching the mismatch.

    `seen_rounds` is shared across every decision-settlement in one replay
    (round id -> the first settlement id that claimed it), so V14 catches a
    second settlement naming a round the first one already settled.
    """
    settlement = settlement_payload(activity) or {}
    label = settlement.get("id", "<no id>")
    has_task = "afp:task" in settlement
    decision_digest = settlement.get("afp:decision")
    has_decision = decision_digest is not None
    one_subject = has_task != has_decision
    report.record(
        f"settlement: {label} names one subject",
        one_subject,
        "" if one_subject else
        "an afp:Settlement must carry exactly one of afp:task / afp:decision — this one "
        f"carries {'both' if has_task and has_decision else 'neither'} (ADR-0018)",
    )
    if not has_decision:
        return

    _decision_activity, decision = _decision_by_digest(decision_digest, all_activities)
    round_id = settlement.get("afp:round")
    resolves = decision is not None and decision.get("afp:round") == round_id
    report.record(
        f"settlement: {label} names a producible DecisionRecord",
        resolves,
        "" if resolves else
        (f"afp:decision {decision_digest!r} resolves to no present afp:DecisionRecord (ADR-0018)"
         if decision is None else
         f"afp:decision resolves to a DecisionRecord for afp:round {decision.get('afp:round')!r}, "
         f"not this settlement's declared afp:round {round_id!r} (ADR-0018)"),
    )
    if not resolves:
        return

    proposal = find_proposal_for_round(round_id, all_activities)
    options = (proposal or {}).get("afp:options") or []
    observed = settlement.get("afp:observedOutcome")
    outcome_ok = observed in options
    report.record(
        f"settlement: {label} observed outcome is an option of the round",
        outcome_ok,
        "" if outcome_ok else
        f"afp:observedOutcome {observed!r} is not among afp:round {round_id!r}'s afp:options "
        f"{options!r} (ADR-0018)",
    )

    # V13 — recomputed from afp:countedVotes, never from the settlement's own
    # afp:dissentVindicated list.
    by_digest = {digest_of(a): a for a in pool}
    decided_outcome = decision.get("afp:outcome")
    voted: dict[str, object] = {}
    for vote_hash in decision.get("afp:countedVotes", []):
        vote_activity = by_digest.get(vote_hash)
        vote_obj = afp_object(vote_activity, "afp:Vote") if isinstance(vote_activity, dict) else None
        if vote_obj is None:
            continue
        voter = vote_activity.get("actor")
        if isinstance(voter, str):
            voted[voter] = vote_obj.get("value")

    bad: list[str] = []
    for candidate in settlement.get("afp:dissentVindicated") or []:
        value = voted.get(candidate)
        if candidate not in voted:
            bad.append(f"{candidate} (no counted vote in afp:round {round_id!r})")
        elif value != observed:
            bad.append(f"{candidate} (voted {value!r}, not the observed outcome {observed!r})")
        elif value == decided_outcome:
            bad.append(f"{candidate} (voted the decided outcome {decided_outcome!r} — not a dissenter)")
    report.record(
        f"settlement: {label} vindicated dissenters voted the observed outcome",
        not bad,
        "" if not bad else "; ".join(bad) + " (ADR-0018)",
    )

    # V14 — one settlement per round in this bundle.
    prior = seen_rounds.get(round_id)
    duplicate = prior is not None and prior != label
    report.record(
        f"settlement: {label} settles its round once",
        not duplicate,
        "" if not duplicate else
        f"afp:round {round_id!r} is already settled by {prior!r} (ADR-0018)",
    )
    seen_rounds.setdefault(round_id, label)


def check_archive_state(report, activity: dict) -> None:
    """ADR-0015 Decision 3 — an archived hub's carried state recomputes to its
    own declared canon.

    `afp:stateHashes` existed first (07): hashes of the converged CRDT state
    at close. `afp:state` is the state itself, carried beside them, and this
    check is what makes it *entered the record* rather than *rode along*: each
    declared hash must equal `digest_of` over the carried value. An archive
    with hashes and no state is a pre-ADR-0015 record and passes as before —
    the state is opt-in; its honesty is not.
    """
    hashes = activity.get("afp:stateHashes")
    state = activity.get("afp:state")
    if not isinstance(hashes, dict) or not isinstance(state, dict):
        return
    label = activity.get("id", "<no id>")
    wrong = []
    for key, declared in hashes.items():
        if key not in state:
            wrong.append(f"{key}: declared a hash but carries no state for it")
            continue
        recomputed = digest_of(state[key])
        if recomputed != declared:
            wrong.append(f"{key}: carried state hashes to {recomputed[:24]}…, canon says {str(declared)[:24]}…")
    report.record(
        f"archive: {label} state matches its canonical hashes",
        not wrong,
        "" if not wrong else "; ".join(wrong) + " (ADR-0015)",
    )


def check_proposal_electorate(report, activity: dict) -> None:
    """ADR-0021 Decision 2 — V3 and V5, the two halves a single bundle can
    answer on its own: the snapshot digest is arithmetic over the proposal's
    own voter list, and the exclusion statuses are a shape check over its own
    `afp:excluded`. V4 (the partition against the Enroll trail) needs the whole
    replay and lives in `afp_verify.check_electorate`.
    """
    from electorate import EXCLUSION_STATUSES, excluded_entries, snapshot_matches

    proposal = afp_object(activity, "afp:Proposal")
    if proposal is None:
        return
    label = proposal.get("id", activity.get("id", "<no id>"))

    ok = snapshot_matches(proposal)
    report.record(
        f"round: {label} quorum snapshot matches its voter list",
        ok,
        "" if ok else
        f"afp:quorumSnapshot {proposal.get('afp:quorumSnapshot')!r} is not the digest of the "
        f"sorted afp:voters it travels with (ADR-0021)",
    )

    entries = excluded_entries(proposal)
    if not entries:
        return
    wrong: list[str] = []
    for entry in entries:
        status = entry.get("afp:status")
        agent = entry.get("agent")
        if not isinstance(agent, str):
            wrong.append(f"{entry!r} names no agent")
        elif status not in EXCLUSION_STATUSES:
            wrong.append(f"{agent}: unknown afp:status {status!r}")
        elif status == "recused" and not isinstance(entry.get("afp:cause"), dict):
            wrong.append(f"{agent}: status 'recused' without an afp:cause")
        elif status != "recused" and entry.get("afp:cause") is not None:
            wrong.append(f"{agent}: status {status!r} carries an afp:cause, which only 'recused' may")
    report.record(
        f"electorate: {label} exclusion statuses are known forms",
        not wrong,
        "" if not wrong else "; ".join(wrong) + " (ADR-0021)",
    )


def check_contribution_split(report, activity: dict) -> None:
    """ADR-0022 Decision 2 / W3 V1 — a co-authored `afp:Result` states who did
    how much of it, in integers.

    03 has required this since v3.4 (campaign 1's finding 7) and nothing has
    ever read it, so the one case where credit is genuinely ambiguous — two
    agents from two operators on one Result, which is the normal shape of an
    escalation — has been dropped from every recomputation in silence. The
    operator that does the most co-work is the one the ledger sees least of.

    Two rulings from the ADR are visible in the shape of this check. **Integers,
    not fractions**: 03 said "a map of actor → fraction summing to 1", which the
    AFP JCS numeric profile cannot express in a signed document — the identical
    wall ADR-0005 hit for `afp:voterWeights` and solved with integer shares over
    an LCM denominator, an answer that post-dates 03's sentence and was never
    carried back. And **the MUST binds**: 03 pairs its requirement with a
    fallback ("absent it, verifiers count such a Result for no one"), which is a
    rule nobody keeps; the fallback is retained only as what an accounting pass
    does with a pre-ADR record, and the requirement is enforced here.

    Conditional on the material: a single-author Result — every Result this
    repository has ever written — triggers nothing.
    """
    result = afp_object(activity, "afp:Result")
    if result is None:
        return
    attributed = result.get("attributedTo")
    authors = [a for a in attributed if isinstance(a, str)] if isinstance(attributed, list) else []
    split = result.get("afp:contributionSplit")
    label = result.get("id", activity.get("id", "<no id>"))
    name = f"contribution: {label} co-authored result declares a well-formed split"

    if len(authors) <= 1:
        # Nothing to divide. A split here would credit a division that does not
        # exist, which is as unreadable as one that is missing.
        if split is not None:
            report.record(
                name,
                False,
                "a single-author afp:Result carries afp:contributionSplit, which divides "
                "nothing (ADR-0022 Decision 2)",
            )
        return

    if not isinstance(split, dict):
        report.record(
            name,
            False,
            f"attributedTo names {len(authors)} actors and no afp:contributionSplit is "
            f"present — 03 requires one, and without it this Result credits nobody (ADR-0022)",
        )
        return

    wrong: list[str] = []
    missing = sorted(a for a in authors if a not in split)
    strangers = sorted(k for k in split if k not in authors)
    if missing:
        wrong.append("author(s) with no share: " + ", ".join(missing))
    if strangers:
        wrong.append("share(s) for non-author(s): " + ", ".join(strangers))
    for actor, share in sorted(split.items()):
        if isinstance(share, bool) or not isinstance(share, int) or share < 1:
            wrong.append(f"{actor}: share {share!r} is not a positive integer")
    report.record(
        name,
        not wrong,
        "" if not wrong else "; ".join(wrong) + " (ADR-0022 Decision 2)",
    )


def check_vote_l1_fields(report, all_activities: list[dict]) -> None:
    """ADR-0020 W3 V1 — an `afp:level: 1` round's votes carry well-formed
    `afp:phase`/`afp:seqNo`/`afp:proposalHash`, with `afp:seqNo` a positive
    integer. Conditional on the vote's own round actually being pinned L1 —
    an L0 vote (every pre-ADR-0020 bundle) triggers nothing here.
    """
    from equivocation import vote_tuple_of

    l1_rounds = {
        obj["afp:round"]
        for a in all_activities
        if (obj := afp_object(a, "afp:Proposal")) is not None
        and obj.get("afp:level") == 1
        and isinstance(obj.get("afp:round"), str)
    }
    if not l1_rounds:
        return
    for activity in all_activities:
        vote = afp_object(activity, "afp:Vote")
        if vote is None or vote.get("afp:round") not in l1_rounds:
            continue
        label = vote.get("id", activity.get("id", "<no id>"))
        ok = vote_tuple_of(activity) is not None
        report.record(
            f"vote: {label} L1 fields are well-formed",
            ok,
            "" if ok else
            "missing afp:phase, afp:seqNo or afp:proposalHash, or afp:seqNo < 1 (ADR-0020)",
        )


def check_equivocation_proof(
    report, activity: dict, keys: dict[str, bytes], prefix: str = ""
) -> None:
    """ADR-0020 W3 V2 — every leg of `convicts`: the embedded pair resolves,
    both proofs verify against the actor's published key (the same
    `verify_proof`/`keys` machinery every other signature uses), and the two
    votes actually convict (matching tuple, differing value/proposalHash).
    A proof failing any leg is itself a replay failure.
    """
    from equivocation import convicts, equivocation_proof_votes

    proof = wrapped_payload(activity, "afp:EquivocationProof") or {}
    label = proof.get("id", activity.get("id", "<no id>"))
    votes = equivocation_proof_votes(activity)
    if votes is None:
        report.record(
            f"{prefix}proof: {label} convicts",
            False,
            "afp:votes does not carry exactly two embedded afp:Vote activities (ADR-0020)",
        )
        return

    vote_a, vote_b = votes
    reason_a = verify_proof(vote_a, keys)
    reason_b = verify_proof(vote_b, keys)
    # The proof's own afp:round must be the round the pair was cast in — a
    # genuine pair announced under another round's name would otherwise
    # convict (and, forward-scoped, zero) a voter in a round it never
    # equivocated in.
    vote_round = (afp_object(vote_a, "afp:Vote") or {}).get("afp:round")
    round_matches = vote_round == proof.get("afp:round")
    ok = reason_a is None and reason_b is None and round_matches and convicts(vote_a, vote_b)
    if ok:
        detail = ""
    elif reason_a is not None:
        detail = f"first embedded vote fails signature verification: {reason_a} (ADR-0020)"
    elif reason_b is not None:
        detail = f"second embedded vote fails signature verification: {reason_b} (ADR-0020)"
    elif not round_matches:
        detail = (
            f"the proof names round {proof.get('afp:round')!r} but its votes were cast in "
            f"{vote_round!r} (ADR-0020)"
        )
    else:
        detail = "the two embedded votes do not convict — same tuple with no differing " \
                 "value or afp:proposalHash (ADR-0020)"
    report.record(f"{prefix}proof: {label} convicts", ok, detail)


def check_succession(report, activity: dict, all_activities: list[dict]) -> None:
    """ADR-0020 W3 V6/V7 — a successor round's proposer must be the round's
    entitled successor, and a declared succession rule must be a known form.
    Both conditional on the property being present: a proposal with neither
    `afp:successionRule` nor `afp:supersedesRound` (every pre-ADR-0020
    proposal) triggers nothing.
    """
    from equivocation import successor as compute_successor

    proposal = afp_object(activity, "afp:Proposal")
    if proposal is None:
        return
    label = proposal.get("id", "<no id>")

    rule = proposal.get("afp:successionRule")
    if rule is not None:
        known = isinstance(rule, dict) and rule.get("afp:form") == "snapshot-order"
        report.record(
            f"succession: {label} rule is a known form",
            known,
            "" if known else
            f"afp:successionRule names an unrecognised form {rule!r} (ADR-0020)",
        )

    supersedes = proposal.get("afp:supersedesRound")
    if supersedes is None:
        return

    stalled_activity = next(
        (
            a for a in all_activities
            if afp_object(a, "afp:Proposal") is not None and digest_of(a) == supersedes
        ),
        None,
    )
    if stalled_activity is None:
        report.record(
            f"round: {label} successor is entitled",
            False,
            f"afp:supersedesRound {supersedes!r} resolves to no present afp:Proposal activity (ADR-0020)",
        )
        return

    stalled_proposal = afp_object(stalled_activity, "afp:Proposal") or {}
    if stalled_proposal.get("afp:successionRule") is None:
        report.record(
            f"round: {label} successor is entitled",
            False,
            "the stalled proposal pinned no afp:successionRule — no sanctioned succession "
            "exists to inherit (ADR-0020)",
        )
        return

    entitled = compute_successor(stalled_activity, all_activities)
    ok = entitled is not None and activity.get("actor") == entitled
    report.record(
        f"round: {label} successor is entitled",
        ok,
        "" if ok else
        f"proposer {activity.get('actor')!r} is not the entitled successor "
        f"({entitled!r}) of the stalled round (ADR-0020)",
    )


def check_key_compromise_claim(report, activity: dict, all_activities: list[dict], authority) -> None:
    """ADR-0021 Decision 4a / W3 V8 — an `afp:KeyCompromiseClaim` is published
    by the convicted agent's own instance, and answers a proof that is really
    on the record and really convicts its own subject.

    The claim is the record's way of telling a sanction from an incident, and
    the entitlement it needs is exactly the one `afp:Vouch`, `afp:Disown` and
    `afp:ControlTransfer` need: a valid signature from the instance that
    operates the agent. Anybody else saying "my key was captured" about
    somebody else's key is not a contested conviction, it is a third party
    narrating — and a record that cannot tell those apart has gained nothing
    over the one state it had before.

    What it emphatically does **not** do is act (W0.3). Zeroing stays
    automatic; this check moves no weight, delays no round and reverses
    nothing. Per domain, because a claim rides on the claiming instance's own
    chain and that bundle publishes the actor documents this resolves against
    — but resolved against the thread pool, since the proof it answers is
    announced by the HUB and reaches the claimant as received bytes.
    """
    from equivocation import convicts, equivocation_proof_votes

    claim = afp_object(activity, "afp:KeyCompromiseClaim")
    if claim is None:
        return
    label = claim.get("id", activity.get("id", "<no id>"))
    name = f"claim: {label} is published by the agent's own instance"

    digest = claim.get("afp:proof")
    proof_activity = (
        next((a for a in all_activities if digest_of(a) == digest), None)
        if isinstance(digest, str)
        else None
    )
    if proof_activity is None:
        report.record(
            name,
            False,
            f"afp:proof {digest!r} resolves to no present activity — a claim answers a proof "
            f"on the record or it answers nothing (ADR-0021)",
        )
        return

    votes = equivocation_proof_votes(proof_activity)
    if votes is None or not convicts(*votes):
        report.record(
            name,
            False,
            "the named afp:proof does not convict — its embedded pair is absent, malformed, "
            "or does not equivocate (ADR-0021)",
        )
        return

    subject = votes[0].get("actor")
    operator = authority.operated_by.get(subject)
    actor = activity.get("actor")
    if operator is None or actor != operator:
        report.record(
            name,
            False,
            f"published by {actor!r}, but the convicted agent {subject} is operated by "
            f"{operator!r} — a compromise claim is self-referential or it is somebody else's "
            f"narration (ADR-0021)"
            if operator is not None else
            f"published by {actor!r}, but {subject} publishes no afp:operatedBy, so no actor "
            f"is entitled to claim capture of its key (ADR-0021)",
        )
        return

    # W1 makes both of these required, and W0.8 forbids a field no check
    # reads: `afp:verificationMethod` is "the key it says was captured", so it
    # must be a key that actually signed one of the convicting votes —
    # otherwise the claim answers a proof while naming an unrelated key — and
    # `afp:since` must be a readable instant, because "the moment the capture
    # began" is the whole content of the assertion.
    signed_by = {
        (v.get("proof") or {}).get("verificationMethod")
        for v in votes
        if isinstance(v.get("proof"), dict)
    }
    method = claim.get("afp:verificationMethod")
    since = claim.get("afp:since")
    wrong = []
    if method not in signed_by:
        wrong.append(
            f"afp:verificationMethod {method!r} signed neither convicting vote "
            f"({', '.join(sorted(str(s) for s in signed_by))})"
        )
    if not isinstance(since, str) or instant_millis(since) == 0:
        wrong.append(f"afp:since {since!r} is not a readable RFC 3339 instant")
    report.record(name, not wrong, "" if not wrong else "; ".join(wrong) + " (ADR-0021)")


def check_membership_actuation(report, activity: dict, all_activities: list[dict]) -> None:
    """ADR-0021 Decision 4b / W3 V9 and V10 — a `MemberExpel` / `MemberAdmit`
    is the ADR-0019 actuation of a governance round, and names that round's
    own subject.

    A governance round is an ordinary ADR-0018 round with a subject; there is
    no second consensus path and no second quorum. So the actuation is held to
    the ordinary actuation contract — `afp:actsOn` resolves to a real
    `DecisionRecord`, `afp:action` is the action that round's own pinned
    `afp:actionPolicy` names for that outcome — plus the two things that make
    it a *membership* act: the round must have pinned an
    `afp:governanceSubject`, and the agent removed or admitted must be that
    subject (V10). A governance round that expels somebody it never named is
    not a decision the record can be said to have taken.

    And the clause 02 has carried since before this ADR, now with teeth: a
    `MemberExpel` or `MemberAdmit` signed by the **hub's own actor** is
    invalid. ADR-0014 made the hub the sequencing authority that signs
    proposals, and that habit collides with member-entitled acts exactly here.
    Membership is decided by a weighted quorum among the members — never by a
    signature from the hub's own key.

    These are the same legs `ratified_membership_acts` requires before an act
    may edit the membership trail, and that is deliberate: an actuation the
    record does not ratify neither moves the electorate nor passes here.
    """
    from electorate import membership_actuation

    kind = membership_actuation(activity)
    if kind is None:
        return
    label = activity.get("id", "<no id>")
    v9 = f"membership: {label} actuates its round's declared action"

    hub_actor = activity.get("afp:hub")
    if isinstance(hub_actor, str) and activity.get("actor") == hub_actor:
        report.record(
            v9,
            False,
            f"signed by the hub actor {hub_actor} itself — a membership act requires a "
            f"weighted quorum among the members, never a signature from the hub's own key "
            f"(02, ADR-0021 Decision 4b)",
        )
        return

    acts_on = activity.get("afp:actsOn")
    decision_activity, decision = _decision_by_digest(acts_on, all_activities)
    if decision is None:
        report.record(
            v9,
            False,
            f"afp:actsOn {str(acts_on)[:24]}… resolves to no present afp:DecisionRecord "
            f"(ADR-0021)",
        )
        return

    round_id = decision.get("afp:round")
    proposal = find_proposal_for_round(round_id, all_activities) or {}
    subject = proposal.get("afp:governanceSubject")
    if not isinstance(subject, str):
        report.record(
            v9,
            False,
            f"round {round_id!r} pins no afp:governanceSubject, so it decided no membership "
            f"question and this actuation has nothing to act on (ADR-0021)",
        )
        return

    outcome = decision.get("afp:outcome")
    policy = proposal.get("afp:actionPolicy")
    admissible = policy.get(outcome) if isinstance(policy, dict) else None
    claimed = activity.get("afp:action")
    ok = admissible is not None and claimed == admissible
    report.record(
        v9,
        ok,
        "" if ok else
        f"afp:action is {claimed!r}, but the round's pinned afp:actionPolicy admits "
        f"{admissible!r} for outcome {outcome!r} (ADR-0019, ADR-0021)",
    )

    named = activity.get("object")
    ok = named == subject
    report.record(
        f"membership: {label} names the subject its round decided",
        ok,
        "" if ok else
        f"{kind} names {named!r}, but round {round_id!r} decided about {subject!r} — a "
        f"membership act may only reach the agent its round was about (ADR-0021)",
    )
