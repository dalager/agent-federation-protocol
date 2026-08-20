"""ADR-0006 Decision 1 — the checkable-actuation verifier extension.

Kept apart from `afp_verify.py` for the same reason `decision.py`, `asset.py`
and `reputation.py` are: an auditor asking "what does the actuation extension
actually check" should not wade through the rest of the replay.

The record already makes *how an answer was reached* recomputable; this makes
*what was done about it* the same. An acting activity hash-binds itself to the
Synthesis it acts on (`afp:actsOn`) and names the action it claims
(`afp:action`); the governing Announce pinned `afp:actionPolicy` — a closed
map `category → admissible action` — before any answer existed. Three checks,
all set-membership and digest resolution:

- a Synthesis under a policy-bearing announce carries a category from the
  closed set;
- every `afp:actsOn` resolves to a present Synthesis — acting on a
  justification you cannot produce is the actuation-flavored "counted vote
  you cannot produce";
- the claimed action equals `policy[category]` for the answer it acts on.

The governing announce is found through the record's own chain — Synthesis →
`afp:award` → Award → `afp:task` → hub-authored Announce — never through a
side channel. Announces that pin no policy constrain nothing; exports
predating ADR-0006 run none of this.
"""

from __future__ import annotations

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


def _governing_policy(synthesis: dict, all_activities: list[dict]) -> tuple[dict | None, str]:
    """The pinned afp:actionPolicy for a Synthesis, via Award → Task → Announce.

    Returns (policy or None, detail); a broken link returns None with the
    reason — the caller decides whether an unresolvable chain matters (it does
    only when someone acted on the answer).
    """
    award_id = synthesis.get("afp:award")
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
    policy = announce.get("afp:actionPolicy")
    if not isinstance(policy, dict):
        return None, "the announce pins no afp:actionPolicy"
    return policy, ""


def check_actions(report, all_activities: list[dict]) -> None:
    by_digest = {digest_of(a): a for a in all_activities}

    # 1 — a Synthesis under a policy-bearing announce carries a category from
    # the closed set. Checked for every such Synthesis, acted on or not: a
    # policy over categories the answer can ignore constrains nothing.
    for activity in all_activities:
        synthesis = _synthesis_of(activity)
        if synthesis is None:
            continue
        policy, _ = _governing_policy(synthesis, all_activities)
        if policy is None:
            continue
        label = synthesis.get("id", "<no id>")
        category = synthesis.get("afp:category")
        ok = isinstance(category, str) and category in policy
        report.record(
            f"action: {label} answers within the pinned category set",
            ok,
            "" if ok else
            f"afp:category is {category!r}, but the announce's afp:actionPolicy admits "
            f"only {sorted(policy)} (ADR-0006)",
        )

    # 2/3 — every action resolves its justification, and did what the policy
    # said that justification permits.
    for activity in all_activities:
        acts_on = activity.get("afp:actsOn")
        if not isinstance(acts_on, str):
            continue
        label = activity.get("id", "<no id>")
        target = by_digest.get(acts_on)
        synthesis = _synthesis_of(target) if isinstance(target, dict) else None
        if not report.record(
            f"action: {label} acts on a producible Synthesis",
            synthesis is not None,
            "" if synthesis is not None else
            f"afp:actsOn names {acts_on[:24]}…, which resolves to no present afp:Synthesis "
            f"— an action whose justification the record cannot produce (ADR-0006)",
        ):
            continue

        policy, detail = _governing_policy(synthesis, all_activities)
        if not report.record(
            f"action: {label} traces to a pinned action policy",
            policy is not None,
            "" if policy is not None else
            f"{detail} — an acted-on answer whose admissible actions were never pinned",
        ):
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


def check_supersession(report, all_activities: list[dict]) -> None:
    """ADR-0007 — answer-level supersession, checkable end to end.

    Three claims, each a digest-walk over the export: the revision names what
    it withdraws (afp:supersedes resolves, same context); a quorum's answer is
    retracted only by a quorum (ratification parity over DecisionRecords); and
    every action whose justification was withdrawn has a recorded disposition
    (afp:disposes + afp:actsOn on the superseding answer). Exports with no
    afp:supersedes run none of this.
    """
    by_digest = {digest_of(a): a for a in all_activities}

    def ratified(synthesis: dict) -> bool:
        target = synthesis.get("id")
        return any(
            (o := afp_object(a, "afp:DecisionRecord")) is not None and o.get("afp:outcome") == target
            for a in all_activities
        )

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
            report.record(
                f"supersession: {label} ratified, as the answer it retracts was",
                ratified(superseding),
                "" if ratified(superseding) else
                "the superseded Synthesis was ratified by a DecisionRecord, the "
                "superseding one is not — a quorum's answer retracted without a quorum "
                "(ADR-0007)",
            )

        # Decision 3 — actions on the withdrawn answer are dealt with.
        superseding_digest = digest_of(activity)
        for actor_activity in all_activities:
            if actor_activity.get("afp:actsOn") != supersedes:
                continue
            if "afp:disposes" in actor_activity:
                continue  # dispositions of earlier actions are not themselves orphaned
            action_digest = digest_of(actor_activity)
            action_label = actor_activity.get("id", "<no id>")
            disposed = any(
                a.get("afp:disposes") == action_digest and a.get("afp:actsOn") == superseding_digest
                for a in all_activities
            )
            report.record(
                f"supersession: {action_label} disposed of after its justification was withdrawn",
                disposed,
                "" if disposed else
                f"{action_label} acted on the retracted answer and no activity disposes "
                f"of it (afp:disposes + afp:actsOn the superseding Synthesis) — an "
                f"orphaned consequence (ADR-0007)",
            )
