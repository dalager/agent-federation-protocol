"""ADR-0006 Decision 1 — the checkable-actuation verifier extension.

Kept apart from `afp_verify.py` for the same reason `decision.py`, `asset.py`
and `reputation.py` are: an auditor asking "what does the actuation extension
actually check" should not wade through the rest of the replay.

The record already makes *how an answer was reached* recomputable; this makes
*what was done about it* the same. An acting activity hash-binds itself to the
Synthesis it acts on (`afp:actsOn`) and names the action it claims
(`afp:action`); the governing task activity pinned `afp:actionPolicy` — a
closed map `category → admissible action` — before any answer existed. Three
checks, all set-membership and digest resolution:

- a Synthesis under a policy-bearing task activity carries a category from
  the closed set;
- every `afp:actsOn` resolves to a present Synthesis (directly, or through the
  one DecisionRecord hop ADR-0010 Decision 3 admits) — acting on a
  justification you cannot produce is the actuation-flavored "counted vote
  you cannot produce";
- the claimed action equals `policy[category]` for the answer it acts on.

The governing pins are found through the record's own chain, and that chain
now has two roots (ADR-0010 Decision 1), never a side channel: `Synthesis ->
afp:award -> Award -> afp:task -> hub-authored Announce` runs first; when the
Synthesis carries no `afp:award`, the governing pins fall back to the outer
Synthesis activity's own `context` — the thread's pin-bearing task activities,
resolved by `pins.governing_pins`. Task activities that pin no policy
constrain nothing; exports predating ADR-0006 run none of this.

ADR-0010 also adds three checks that are about the *Synthesis*, not the
action: the pinned/derived synthesizer names who may emit it, a partial
Synthesis must account for every leg of its thread, and a thread with no
Award reads its pinned answer-sufficiency as a count over
`afp:contributingResults` rather than a selection-time coverage score.
"""

from __future__ import annotations

import pins
from decision import afp_object, enrolled_roles, enrolled_roles_at, find_proposal_for_round, instant_millis

from proof import digest_of
#: ADR-0018 Decision 2 — the reserved outcome of a round that did not decide.
#: Actionable, but only through the policy key of the same name (ADR-0019 W1).
NO_DECISION_OUTCOME = "afp:no-decision"


def _synthesis_of(activity: dict) -> dict | None:
    """The afp:Synthesis payload, unwrapped — the outer type never matches here
    (a Synthesis travels as Create), but keep the same defensive shape as the
    Award/Settlement unwraps."""
    obj = activity.get("object")
    if isinstance(obj, dict) and obj.get("type") == "afp:Synthesis":
        return obj
    return afp_object(activity, "afp:Synthesis")


def _governance_decision(target: dict | None, all_activities: list[dict]) -> dict | None:
    """The `afp:DecisionRecord` payload of a target that *decided a question* —
    or None (ADR-0019 W1).

    Two conditions, and the first is the load-bearing one:

    1. **The round pinned an `afp:actionPolicy`.** That pin is the proposer's
       deliberate statement that this question's outcomes have consequences,
       and it is the only thing an action could be looked up in. A ratification
       round pins none — its outcome names an answer, not a course of action —
       so it keeps taking ADR-0010 Decision 3's Synthesis hop, and a
       DecisionRecord whose outcome names *another* DecisionRecord still fails
       exactly where it always failed. Deciding this on the pin rather than on
       what the outcome string looks like matters: a ratification round's
       options legitimately contain activity ids, so "the outcome is an option"
       cannot tell the two flows apart on its own.
    2. **The outcome is one the round offered** — an option, or ADR-0018's
       reserved `afp:no-decision`. The outcome IS the category the policy is
       keyed by (ADR-0019 W1), and an outcome outside that set is not a
       category.
    """
    if not isinstance(target, dict):
        return None
    decision = afp_object(target, "afp:DecisionRecord")
    if decision is None:
        return None
    outcome = decision.get("afp:outcome")
    if not isinstance(outcome, str):
        return None
    proposal = find_proposal_for_round(decision.get("afp:round"), all_activities)
    if not isinstance((proposal or {}).get("afp:actionPolicy"), dict):
        return None
    options = proposal.get("afp:options")
    admissible = isinstance(options, list) and outcome in options
    return decision if admissible or outcome == NO_DECISION_OUTCOME else None


def _resolve_synthesis(target: dict | None, all_activities: list[dict]) -> tuple[dict | None, dict | None]:
    """Resolve an `afp:actsOn` target to the (activity, Synthesis payload) it
    ultimately names, following at most one hop through a `Create{afp:
    DecisionRecord}` (ADR-0010 Decision 3): digest -> DecisionRecord ->
    `afp:outcome` id -> the `Create{afp:Synthesis}` carrying that id.

    Two hops never resolve: a DecisionRecord whose outcome names another
    DecisionRecord returns (None, None) here exactly as an unresolvable
    afp:actsOn does, because the hop only ever looks for a Synthesis.
    """
    if target is None:
        return None, None
    synthesis = _synthesis_of(target)
    if synthesis is not None:
        return target, synthesis
    decision = afp_object(target, "afp:DecisionRecord")
    if decision is None:
        return None, None
    outcome_id = decision.get("afp:outcome")
    if not isinstance(outcome_id, str):
        return None, None
    hop_target = next(
        (a for a in all_activities if (s := _synthesis_of(a)) is not None and s.get("id") == outcome_id),
        None,
    )
    if hop_target is None:
        return None, None
    return hop_target, _synthesis_of(hop_target)


def _governing_pins(activity: dict, all_activities: list[dict]) -> tuple[dict | None, str]:
    """The governing pin set for a Synthesis-bearing activity: the pinned
    `{afp:actionPolicy, afp:answerSufficiency, afp:synthesizer}` object,
    restricted to the keys present, resolved via one of two roots.

    Root 1: `Synthesis -> afp:award -> Award -> afp:task -> hub-authored
    Announce`. When the Award carries its own `afp:synthesizer` (ADR-0003's
    derived form), that value overrides the Announce's pinned one — the
    Award is the derived form of the same pin (ADR-0010 Decision 2), and
    where a rule derives none the Announce's pin governs alone.

    Root 2 (ADR-0010 Decision 1, fallback): when the Synthesis carries no
    `afp:award`, the governing pins are resolved from the outer activity's
    own `context` — the thread's agreed pin-bearing task activities.
    """
    synthesis = _synthesis_of(activity)
    if synthesis is None:
        return None, "not a Synthesis-bearing activity"

    award_id = synthesis.get("afp:award")
    if award_id is not None:
        award = next(
            (
                o
                for a in all_activities
                if isinstance(o := a.get("object"), dict)
                and o.get("type") == "afp:Award"
                and o.get("id") == award_id
            ),
            None,
        )
        if award is None:
            return None, f"afp:award {award_id!r} resolves to no Award"
        task_id = award.get("afp:task")
        hub_actor = award.get("afp:hub")
        announce = next(
            (
                obj
                for a in all_activities
                if a.get("actor") == hub_actor
                and (obj := afp_object(a, "afp:Task")) is not None
                and obj.get("id") == task_id
            ),
            None,
        )
        if announce is None:
            return None, f"afp:task {task_id!r} has no hub-authored Announce"
        governing = pins.pin_set(announce)
        award_synthesizer = award.get("afp:synthesizer")
        if award_synthesizer is not None:
            governing = {**governing, "afp:synthesizer": award_synthesizer}
        return governing, ""

    context = activity.get("context")
    if not isinstance(context, str):
        return None, "Synthesis carries no afp:award and its activity has no context to fall back on"
    return pins.governing_pins(context, all_activities)


def _governing_policy(activity: dict, all_activities: list[dict]) -> tuple[dict | None, str]:
    """Thin wrapper over `_governing_pins` for the policy-only callers below."""
    governing, detail = _governing_pins(activity, all_activities)
    if governing is None:
        return None, detail
    policy = governing.get("afp:actionPolicy")
    if not isinstance(policy, dict):
        return None, "the governing pins include no afp:actionPolicy"
    return policy, ""


def check_actions(report, all_activities: list[dict], thread_pool: list[dict]) -> None:
    # ADR-0015 N2, arriving at actuation: `afp:actsOn` resolves from the THREAD
    # POOL — own activities plus received bytes — not from the own outbox
    # alone. Until ADR-0019 an action and the Synthesis justifying it were
    # always authored inside one trust domain, so the distinction never
    # surfaced. A governance actuation breaks that: the `DecisionRecord` is
    # written by a hub on one operator's server and acted on by an agent
    # enrolled from another, so for the actor's own bundle the justification is
    # received bytes or it is nowhere. The same grain `check_decision_record`
    # already uses for counted votes, and phase two verifies those bytes
    # against the sender's own bundle exactly as it does there.
    by_digest = {digest_of(a): a for a in thread_pool}

    # 1 — a Synthesis under a policy-bearing task activity carries a category
    # from the closed set. Checked for every such Synthesis, acted on or not:
    # a policy over categories the answer can ignore constrains nothing.
    for activity in all_activities:
        synthesis = _synthesis_of(activity)
        if synthesis is None:
            continue
        policy, _ = _governing_policy(activity, all_activities)
        if policy is None:
            continue
        label = synthesis.get("id", "<no id>")
        category = synthesis.get("afp:category")
        ok = isinstance(category, str) and category in policy
        report.record(
            f"action: {label} answers within the pinned category set",
            ok,
            "" if ok else
            f"afp:category is {category!r}, but the governing afp:actionPolicy admits "
            f"only {sorted(policy)} (ADR-0006)",
        )

    # 2/3 — every action resolves its justification (directly, or through the
    # one DecisionRecord hop, or ADR-0019 W2's third root over a round's own
    # proposal), and did what the policy said that justification permits.
    for activity in all_activities:
        acts_on = activity.get("afp:actsOn")
        if not isinstance(acts_on, str):
            continue
        label = activity.get("id", "<no id>")
        target = by_digest.get(acts_on)
        resolved_activity, synthesis = _resolve_synthesis(target, all_activities)
        # ADR-0019 W2 — a DecisionRecord target with no Synthesis behind it
        # (a governance round decided, ratifying nothing) is a producible
        # justification too, resolved through its own round's proposal. Tried
        # only when the Synthesis-and-hop resolution above found nothing, so
        # a DecisionRecord that DOES ratify a Synthesis (ADR-0010 Decision 3)
        # keeps taking the existing path unchanged.
        # …and only a DecisionRecord that actually DECIDED something counts.
        # `afp:outcome` must be one of that round's own pinned options, or the
        # reserved afp:no-decision — because the outcome IS the category the
        # policy is looked up by (ADR-0019 W1), and an outcome that is not an
        # option is not a category. This is what keeps ADR-0010's "two hops
        # never resolve" exactly as it was: a DecisionRecord whose outcome
        # names another DecisionRecord decided nothing this policy can admit,
        # so it falls through to the same failure it always produced.
        decision = _governance_decision(target, thread_pool) if synthesis is None else None
        found = synthesis is not None or decision is not None
        if not report.record(
            f"action: {label} acts on a producible justification",
            found,
            "" if found else
            f"afp:actsOn names {acts_on[:24]}…, which resolves to no present afp:Synthesis or "
            f"afp:DecisionRecord, directly or through a DecisionRecord's afp:outcome — an "
            f"action whose justification the record cannot produce (ADR-0006/ADR-0010/ADR-0019)",
        ):
            continue

        if decision is not None:
            _check_decision_actuation(report, activity, label, decision, all_activities, thread_pool)
            continue

        policy, detail = _governing_policy(resolved_activity, all_activities)
        if not report.record(
            f"action: {label} traces to a pinned action policy",
            policy is not None,
            "" if policy is not None else
            f"{detail} — an acted-on answer whose admissible actions were never pinned",
        ):
            continue

        if activity.get("afp:disposition") == "annotate":
            # ADR-0011 Decision 2 — an annotate disposition carries no
            # afp:action, so it has nothing to compare against the policy;
            # `check_supersession` names and governs it instead.
            continue

        category = synthesis.get("afp:category")
        admissible = policy.get(category) if isinstance(category, str) else None
        claimed = activity.get("afp:action")
        ok = admissible is not None and claimed == admissible
        report.record(
            f"action: {label} is the action the answer permitted",
            ok,
            "" if ok else
            f"afp:action is {claimed!r}, but the pinned policy admits {admissible!r} for "
            f"category {category!r} (ADR-0006)",
        )

    check_synthesis_pins(report, all_activities, thread_pool)
    check_actuator_publishes_only_actuation(report, all_activities)


def _check_decision_actuation(
    report, activity: dict, label: str, decision: dict, all_activities: list[dict], thread_pool: list[dict]
) -> None:
    """ADR-0019 W2/W5 — V2 and V3, for an action whose `afp:actsOn` resolves to
    a `DecisionRecord` with no Synthesis behind it (a governance round decided
    something, and ratified nothing).

    V1 (the shared "acts on a producible justification" check) and V4 (the
    actuator's write restriction) are checked by the caller / by
    `check_actuator_publishes_only_actuation`; this covers only the two
    checks that need the resolved decision itself.
    """
    round_id = decision.get("afp:round")
    proposal = find_proposal_for_round(round_id, thread_pool)
    hub_actor = decision.get("afp:hub") or (proposal or {}).get("afp:hub")
    outcome = decision.get("afp:outcome")

    # V2 — the category IS the outcome (W1): afp:action must equal the
    # round's own pinned policy at that outcome, checked only where the
    # policy is actually pinned (a round that pinned none constrains
    # nothing, same discipline as check_synthesis_pins's governing pins).
    policy = (proposal or {}).get("afp:actionPolicy")
    if isinstance(policy, dict) and isinstance(outcome, str):
        admissible = policy.get(outcome)
        claimed = activity.get("afp:action")
        ok = admissible is not None and claimed == admissible
        report.record(
            f"action: {label} action is admissible under the round's pinned policy",
            ok,
            "" if ok else
            f"afp:action is {claimed!r}, but the round's pinned afp:actionPolicy admits "
            f"{admissible!r} for outcome {outcome!r} (ADR-0019)",
        )

    # V3 — the actor was enrolled as member or actuator in the deciding hub
    # at the action's own published instant, replayed from the Enroll trail
    # the verifier already reconstructs for snapshot and role checks.
    if isinstance(hub_actor, str):
        roles = enrolled_roles_at(hub_actor, thread_pool, instant_millis(activity.get("published")))
        actor = activity.get("actor")
        role = roles.get(actor)
        ok = role in ("member", "actuator")
        report.record(
            f"action: {label} actor is enrolled in the deciding hub",
            ok,
            "" if ok else
            f"actor {actor!r} holds role {role!r} in hub {hub_actor!r} at this action's "
            f"published instant — only a member or an actuator may act on a decision "
            f"(ADR-0019)",
        )


def check_actuator_publishes_only_actuation(report, all_activities: list[dict]) -> None:
    """ADR-0019 W4/W5 V4 — an `actuator`-role agent's only admissible write is
    the actuation record itself.

    The role is otherwise purely declarative (W4): every existing
    enforcement point already tests `=== "member"`, so an actuator is
    excluded from all of them for free. This is the one restriction with no
    existing analogue, checked here as a replay fact rather than enforced on
    the writer — enforcement a writer alone provides leaves no trace
    (ADR-0003 Decision 6).
    """
    hub_actors = sorted(
        {
            a.get("target")
            for a in all_activities
            if a.get("type") in ("afp:Enroll", "afp:Unenroll") and isinstance(a.get("target"), str)
        }
    )
    for hub_actor in hub_actors:
        roles = enrolled_roles(hub_actor, all_activities)
        for agent in sorted(agent for agent, role in roles.items() if role == "actuator"):
            violations = sorted(
                a.get("id", "<no id>")
                for a in all_activities
                if a.get("actor") == agent
                and a.get("afp:visibility") == "hub"
                and not isinstance(a.get("afp:actsOn"), str)
            )
            report.record(
                f"roles: {agent} actuator publishes only actuation activities",
                not violations,
                "" if not violations else
                f"authored hub-visibility activity(ies) carrying no afp:actsOn: "
                + ", ".join(violations)
                + " — an actuator's only admissible write is the actuation record itself "
                "(ADR-0019)",
            )


def check_synthesis_pins(report, all_activities: list[dict], thread_pool: list[dict]) -> None:
    """ADR-0010 Decisions 2 and 4 — checks about the Synthesis itself: who may
    emit it, whether it accounts for every leg of its thread, and whether it
    meets a pinned answer-side sufficiency count."""
    by_digest = {digest_of(a): a for a in all_activities}

    for activity in all_activities:
        synthesis = _synthesis_of(activity)
        if synthesis is None:
            continue
        label = synthesis.get("id", "<no id>")

        # Admissibility: actor and attributedTo must equal the pinned/derived
        # synthesizer, when one governs.
        governing, _ = _governing_pins(activity, all_activities)
        synthesizer = governing.get("afp:synthesizer") if governing else None
        if isinstance(synthesizer, str):
            matches_pin = activity.get("actor") == synthesizer and synthesis.get("attributedTo") == synthesizer
            ok = matches_pin
            substituted = False
            if not ok and isinstance(synthesis.get("afp:supersedes"), str):
                # ADR-0011 Decision 3 — a ratified superseding Synthesis may
                # substitute the pinned synthesizer; the ratifying quorum is
                # then the authority for the substitution. An unratified one
                # still fails — otherwise anyone supersedes by being someone
                # else.
                synthesis_id = synthesis.get("id")
                substituted = any(
                    (o := afp_object(a, "afp:DecisionRecord")) is not None
                    and o.get("afp:outcome") == synthesis_id
                    for a in all_activities
                )
                ok = substituted
            report.record(
                f"synthesis: {label} is emitted by the pinned synthesizer",
                ok,
                "" if ok else
                f"afp:synthesizer names {synthesizer!r}, but this Synthesis has actor "
                f"{activity.get('actor')!r} / attributedTo {synthesis.get('attributedTo')!r}, "
                f"and it is not a ratified supersession — the one substitution a quorum's "
                f"ratification may make (ADR-0010/ADR-0011)",
            )

        # Leg partition and answer-side sufficiency both belong to Decision
        # 4's direct-flow discipline — the fallback root, no Award. An
        # Award-rooted, multi-performer Synthesis has one task-bearing
        # activity (the Announce) and several per-performer Results whose
        # correlationId is a suffixed variant of the task's; the Award-scoped
        # performer-count/coverage checks in allocation.py already govern
        # that shape and are untouched.
        if synthesis.get("afp:award") is not None:
            continue

        # Leg partition: every distinct correlationId among the thread's
        # task-bearing activities appears either as a contributing Result or
        # as a declared afp:absentInputs entry.
        context = activity.get("context")
        if isinstance(context, str):
            legs = {
                cid
                for a in thread_pool
                if a.get("context") == context
                and pins.is_task_bearing(a) is not None
                and (cid := pins.correlation_id(a)) is not None
            }
            if legs:
                contributing = synthesis.get("afp:contributingResults", []) or []
                contributing_cids = {
                    pins.correlation_id(by_digest[d])
                    for d in contributing
                    if d in by_digest and afp_object(by_digest[d], "afp:Result") is not None
                }
                absent_cids = {
                    entry.get("afp:correlationId")
                    for entry in (synthesis.get("afp:absentInputs", []) or [])
                    if isinstance(entry, dict)
                }
                missing = sorted(legs - contributing_cids - absent_cids)
                report.record(
                    f"synthesis: {label} accounts for every leg of its thread",
                    not missing,
                    "" if not missing else
                    f"leg(s) {missing} appear in neither afp:contributingResults nor "
                    f"afp:absentInputs — a leg silently dropped instead of declared "
                    f"(ADR-0010)",
                )

        sufficiency = governing.get("afp:answerSufficiency") if governing else None
        if not isinstance(sufficiency, dict):
            continue
        required_count = sufficiency.get("count")
        if not isinstance(required_count, (int, float)):
            continue
        contributing = synthesis.get("afp:contributingResults", []) or []
        category = synthesis.get("afp:category")
        ok = len(contributing) >= required_count or category == "afp:no-verdict"
        report.record(
            f"synthesis: {label} meets the pinned answer-sufficiency count",
            ok,
            "" if ok else
            f"Synthesis binds {len(contributing)} contributing result(s), pinned "
            f"afp:answerSufficiency requires {required_count}, and afp:category is "
            f"{category!r} — not afp:no-verdict (ADR-0010)",
        )


def check_supersession(report, all_activities: list[dict]) -> None:
    """ADR-0007 — answer-level supersession, checkable end to end.

    Three claims, each a digest-walk over the export: the revision names what
    it withdraws (afp:supersedes resolves, same context); a quorum's answer is
    retracted only by a quorum (ratification parity over DecisionRecords); and
    every action whose justification was withdrawn has a recorded disposition
    (afp:disposes + afp:actsOn on the superseding answer, resolved through the
    same zero-or-one DecisionRecord hop as `check_actions` — ADR-0010 Decision
    3). Exports with no afp:supersedes run none of this.
    """
    by_digest = {digest_of(a): a for a in all_activities}

    def ratified(synthesis: dict) -> bool:
        target = synthesis.get("id")
        return any(
            (o := afp_object(a, "afp:DecisionRecord")) is not None and o.get("afp:outcome") == target
            for a in all_activities
        )

    def ratifying_decision(outcome_id: str | None) -> dict | None:
        """The `afp:DecisionRecord` payload whose `afp:outcome` names
        `outcome_id` — the same by-outcome resolution `ratified()` uses,
        returning the record itself rather than a bool (ADR-0011 Decision 3:
        no reverse index from snapshot digest to round)."""
        if not isinstance(outcome_id, str):
            return None
        return next(
            (
                o for a in all_activities
                if (o := afp_object(a, "afp:DecisionRecord")) is not None and o.get("afp:outcome") == outcome_id
            ),
            None,
        )

    def acts_on_resolves_to(activity: dict, target_digest: str) -> bool:
        acts_on = activity.get("afp:actsOn")
        if not isinstance(acts_on, str):
            return False
        resolved_activity, _ = _resolve_synthesis(by_digest.get(acts_on), all_activities)
        return resolved_activity is not None and digest_of(resolved_activity) == target_digest

    for activity in all_activities:
        superseding = _synthesis_of(activity)
        if superseding is None:
            continue
        supersedes = superseding.get("afp:supersedes")
        if not isinstance(supersedes, str):
            continue
        label = superseding.get("id", "<no id>")

        target_activity = by_digest.get(supersedes)
        superseded = _synthesis_of(target_activity) if isinstance(target_activity, dict) else None
        if not report.record(
            f"supersession: {label} retracts a producible Synthesis",
            superseded is not None,
            "" if superseded is not None else
            f"afp:supersedes names {supersedes[:24]}…, which resolves to no present "
            f"afp:Synthesis — a retraction of nothing (ADR-0007)",
        ):
            continue

        same_context = activity.get("context") == target_activity.get("context")
        report.record(
            f"supersession: {label} retracts an answer on its own thread",
            same_context,
            "" if same_context else
            f"the superseding Synthesis is on {activity.get('context')!r} but the "
            f"superseded one is on {target_activity.get('context')!r} — a revision that "
            f"answers a different thread retracts nothing",
        )

        # Decision 2 — overturning a decision costs what the decision cost.
        if ratified(superseded):
            superseding_ratified = ratified(superseding)
            report.record(
                f"supersession: {label} ratified, as the answer it retracts was",
                superseding_ratified,
                "" if superseding_ratified else
                "the superseded Synthesis was ratified by a DecisionRecord, the "
                "superseding one is not — a quorum's answer retracted without a quorum "
                "(ADR-0007)",
            )

            # ADR-0011 Decision 3 — where both are ratified, the superseding
            # DecisionRecord names the electorate it overturns, and the name
            # must be right: it MUST equal the afp:quorumSnapshot actually
            # carried by the DecisionRecord that ratified the superseded
            # Synthesis, found by afp:outcome, never by a snapshot-digest
            # reverse index.
            if superseding_ratified:
                superseding_decision = ratifying_decision(label)
                superseded_decision = ratifying_decision(superseded.get("id"))
                declared = (
                    superseding_decision.get("afp:priorQuorumSnapshot")
                    if superseding_decision else None
                )
                actual = superseded_decision.get("afp:quorumSnapshot") if superseded_decision else None
                snapshot_ok = declared is not None and declared == actual
                report.record(
                    f"supersession: {label} names the electorate that ratified the answer it retracts",
                    snapshot_ok,
                    "" if snapshot_ok else
                    f"afp:priorQuorumSnapshot is {declared!r}, but the DecisionRecord that "
                    f"ratified the superseded Synthesis carries afp:quorumSnapshot {actual!r} "
                    f"(ADR-0011)",
                )

        # Decision 3 — actions on the withdrawn answer are dealt with. The
        # orphan scan resolves afp:actsOn through zero-or-one DecisionRecord
        # hop before comparing (ADR-0010 Decision 3): an action bound to the
        # superseded answer via a DecisionRecord is exactly as orphaned as one
        # bound to it directly.
        superseding_digest = digest_of(activity)
        for actor_activity in all_activities:
            if not acts_on_resolves_to(actor_activity, supersedes):
                continue
            if "afp:disposes" in actor_activity:
                continue  # dispositions of earlier actions are not themselves orphaned
            action_digest = digest_of(actor_activity)
            action_label = actor_activity.get("id", "<no id>")
            disposing_activity = next(
                (
                    a for a in all_activities
                    if a.get("afp:disposes") == action_digest and acts_on_resolves_to(a, superseding_digest)
                ),
                None,
            )
            disposed = disposing_activity is not None
            report.record(
                f"supersession: {action_label} disposed of after its justification was withdrawn",
                disposed,
                "" if disposed else
                f"{action_label} acted on the retracted answer and no activity disposes "
                f"of it (afp:disposes + afp:actsOn the superseding Synthesis) — an "
                f"orphaned consequence (ADR-0007)",
            )

            # ADR-0011 Decision 2 — the annotate disposition satisfies
            # existence by itself (an annotate carries afp:disposes and
            # afp:actsOn like any disposition, no afp:action). What it must
            # additionally satisfy: the disposed action's own name was
            # declared irrevocable on the governing pins of the thread the
            # disposed action was taken on — the original action's thread,
            # not the disposition's — resolved the same way check_actions
            # resolves any Synthesis-bearing activity's governing pins.
            if disposing_activity is not None and disposing_activity.get("afp:disposition") == "annotate":
                governing, _ = _governing_pins(target_activity, all_activities)
                irrevocable = governing.get("afp:irrevocableActions") if governing else None
                action_name = actor_activity.get("afp:action")
                annotate_ok = isinstance(irrevocable, list) and action_name in irrevocable
                report.record(
                    f"supersession: {action_label} annotates an action declared irrevocable",
                    annotate_ok,
                    "" if annotate_ok else
                    f"{action_label}'s afp:action {action_name!r} is not among the "
                    f"afp:irrevocableActions pinned on its own thread — an annotate "
                    f"disposition against an action never declared irrevocable (ADR-0011)",
                )
