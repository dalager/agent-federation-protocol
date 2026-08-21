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
from decision import afp_object
from proof import digest_of


def _synthesis_of(activity: dict) -> dict | None:
    """The afp:Synthesis payload, unwrapped — the outer type never matches here
    (a Synthesis travels as Create), but keep the same defensive shape as the
    Award/Settlement unwraps."""
    obj = activity.get("object")
    if isinstance(obj, dict) and obj.get("type") == "afp:Synthesis":
        return obj
    return afp_object(activity, "afp:Synthesis")


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
    by_digest = {digest_of(a): a for a in all_activities}

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
    # one DecisionRecord hop), and did what the policy said that justification
    # permits.
    for activity in all_activities:
        acts_on = activity.get("afp:actsOn")
        if not isinstance(acts_on, str):
            continue
        label = activity.get("id", "<no id>")
        target = by_digest.get(acts_on)
        resolved_activity, synthesis = _resolve_synthesis(target, all_activities)
        if not report.record(
            f"action: {label} acts on a producible Synthesis",
            synthesis is not None,
            "" if synthesis is not None else
            f"afp:actsOn names {acts_on[:24]}…, which resolves to no present afp:Synthesis, "
            f"directly or through a DecisionRecord's afp:outcome — an action whose "
            f"justification the record cannot produce (ADR-0006/ADR-0010)",
        ):
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
