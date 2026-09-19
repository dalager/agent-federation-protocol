"""ADR-0033 Decision 3 — `check_policy`, run only when a manifest carries
`afp:policy`.

Kept apart from `afp_verify.py` for the reason every other extension is:
an auditor asking "what does the policy extension actually check" should not
wade through the rest of the replay. No shipped bundle before this ADR
carries `afp:policy` at all, so every check below is a no-op on those
(Compatibility) — this file changes the answer for nothing that already
verified.

Nothing here adjudicates the policy's wisdom (Decision 3's own words): it
checks that the record matches what the operator said it would do — the
brains that produced a Result, the controllers who approved or rejected, the
seat policy against the actual Enroll/Accept{Follow} trail, and (Decision 4)
the governance subject precondition against what is on record.
"""

from __future__ import annotations

from pathlib import Path

from action import _governing_policy, _resolve_synthesis
from decision import afp_object, instant_millis
from equivocation import convicts, equivocation_proof_votes
from proof import digest_of, verify_proof
from summary import dispute_payload


def _load_json(path: Path) -> dict:
    import json

    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def _anchors_equal(a, b) -> bool:
    def normalize(anchors):
        return sorted(
            tuple(sorted((entry or {}).items())) for entry in anchors if isinstance(entry, dict)
        )

    return normalize(a) == normalize(b)


def check_policy(
    report,
    export: Path,
    manifest: dict,
    all_activities: list[dict],
    keys: dict[str, bytes],
    instance_actor: str | None,
) -> None:
    """ADR-0033 Decision 3. A no-op unless `manifest["afp:policy"]` is
    present — every check below records under the `policy:` family so the
    census makes a bundle carrying no policy VISIBLE as `policy:0`, never
    silent."""
    policy_ref = manifest.get("afp:policy")
    if not isinstance(policy_ref, dict):
        return

    policy_path = export / "policy.jsonld"
    members = manifest.get("afp:members")
    declared = "policy.jsonld" in members if isinstance(members, list) else True
    present = policy_path.exists() and declared
    if not report.record(
        "policy: policy.jsonld is present and declared in afp:members",
        present,
        "" if present else
        f"manifest names afp:policy but policy.jsonld is "
        f"{'missing from the bundle' if not policy_path.exists() else 'not declared in afp:members'} (ADR-0033)",
    ):
        return

    policy = _load_json(policy_path)

    report.record(
        "policy: policy.jsonld id matches the manifest's afp:policy.id",
        policy.get("id") == policy_ref.get("id"),
        "" if policy.get("id") == policy_ref.get("id") else
        f"policy.jsonld's id is {policy.get('id')!r}, manifest names {policy_ref.get('id')!r} (ADR-0033)",
    )

    digest = digest_of(policy)
    report.record(
        "policy: policy.jsonld digest matches the manifest's afp:policy.afp:digest",
        digest == policy_ref.get("afp:digest"),
        "" if digest == policy_ref.get("afp:digest") else
        f"policy.jsonld digests to {digest!r}, manifest names {policy_ref.get('afp:digest')!r} — "
        f"the carried document does not match what the manifest says it exported (ADR-0033)",
    )

    reason = verify_proof(policy, keys)
    report.record("policy: policy.jsonld signature verifies", reason is None, reason or "")

    report.record(
        "policy: policy.jsonld is attributed to the bundle's instance actor",
        policy.get("attributedTo") == instance_actor,
        "" if policy.get("attributedTo") == instance_actor else
        f"policy.jsonld is attributedTo {policy.get('attributedTo')!r}, not this bundle's instance actor "
        f"{instance_actor!r} (ADR-0033)",
    )

    report.record(
        "policy: policy.jsonld is typed afp:Policy",
        policy.get("type") == "afp:Policy",
        "" if policy.get("type") == "afp:Policy" else
        f"policy.jsonld's type is {policy.get('type')!r}, not afp:Policy (ADR-0033)",
    )

    # afp:retentionDuty / afp:anchors — equal when both the manifest and the
    # policy declare one (a manifest whose extras disagreed with the policy
    # would already have thrown at export time — `export.ts`'s "afp:retentionDuty
    # disagrees" — so this is a replay-side check that the record a stranger
    # reads still agrees, not a second source of that guarantee).
    manifest_duty = manifest.get("afp:retentionDuty")
    policy_duty = policy.get("afp:retentionDuty")
    if isinstance(manifest_duty, dict) and isinstance(policy_duty, dict):
        equal = (
            manifest_duty.get("afp:horizon") == policy_duty.get("afp:horizon")
            and manifest_duty.get("afp:basis") == policy_duty.get("afp:basis")
        )
        report.record(
            "policy: manifest afp:retentionDuty matches the policy's",
            equal,
            "" if equal else
            f"manifest afp:retentionDuty is {manifest_duty!r}, policy's is {policy_duty!r} (ADR-0033)",
        )

    manifest_anchors = manifest.get("afp:anchors")
    policy_anchors = policy.get("afp:anchors")
    if isinstance(manifest_anchors, list) and isinstance(policy_anchors, list):
        equal = _anchors_equal(manifest_anchors, policy_anchors)
        report.record(
            "policy: manifest afp:anchors matches the policy's",
            equal,
            "" if equal else "manifest afp:anchors and the policy's afp:anchors disagree (ADR-0033)",
        )

    _check_hosted_hubs(report, export, policy, instance_actor)
    _check_brains(report, policy, all_activities)
    _check_controllers(report, policy, all_activities)
    _check_seat_policy(report, export, policy, all_activities)
    _check_governance_subject(report, policy, all_activities)


def _check_hosted_hubs(report, export: Path, policy: dict, instance_actor: str | None) -> None:
    """ADR-0037 Decision 1. Every `afp:Hub` actor document in the bundle whose
    `afp:operatedBy` is this bundle's instance actor must be named in the
    policy's `afp:hostedHubs`. `afp:operatedBy` is the hinge rather than "which
    activities this instance emitted", because a hub signs its own
    activities with its own key: the actor document is where the record
    already says whose server hosts it (ADR-0016).

    An absent `afp:hostedHubs` is "not declared" and records ok, the same answer
    `afp:brains` gives — the honest statement for the instance that hosts no
    hub, and for every bundle shipped before this property existed. A
    declared list is held to exactly: a hosted hub struck from it fails by
    name."""
    hubs = policy.get("afp:hostedHubs")
    if not isinstance(hubs, list):
        report.record("policy: afp:hostedHubs not declared — hosted hubs not held to a list", True, "")
        return

    declared = {
        entry.get("afp:hubId") for entry in hubs if isinstance(entry, dict)
    }
    actors_dir = export / "actors"
    if not actors_dir.exists():
        return
    for actor_path in sorted(actors_dir.glob("*.jsonld")):
        doc = _load_json(actor_path)
        types = doc.get("type")
        types = types if isinstance(types, list) else [types]
        if "afp:Hub" not in types:
            continue
        if doc.get("afp:operatedBy") != instance_actor:
            continue
        hub_id = doc.get("name") or doc.get("preferredUsername")
        ok = hub_id in declared
        report.record(
            f"policy: hosted hub {doc.get('id')!r} is named in afp:hostedHubs",
            ok,
            "" if ok else
            f"{doc.get('id')!r} is operated by this instance but {hub_id!r} is not among the policy's "
            f"afp:hostedHubs {sorted(d for d in declared if isinstance(d, str))!r} (ADR-0037)",
        )


def _brain_matches(produced_by: str, model, endpoint) -> bool:
    if produced_by == model:
        return True
    if isinstance(endpoint, str) and produced_by.startswith(f"{model} @ {endpoint}"):
        return True
    return False


def _check_brains(report, policy: dict, all_activities: list[dict]) -> None:
    """Every `afp:producedBy` on every `afp:Result` names a brain the policy
    lists — a value matches an entry when it equals `afp:model` exactly (the
    stub brain's own `afp:producedBy`), or when it starts with
    `"<afp:model> @ <afp:endpoint>"` (the llm brain's `producedByLine`; the
    `"; template sha256:…"` suffix is not matched against the policy)."""
    brains = policy.get("afp:brains")
    if not isinstance(brains, list) or not brains:
        report.record(
            "policy: afp:brains not declared — producedBy not held to a list",
            True,
            "",
        )
        return

    entries = [(b.get("afp:model"), b.get("afp:endpoint")) for b in brains if isinstance(b, dict)]
    for activity in all_activities:
        result = afp_object(activity, "afp:Result")
        if result is None:
            continue
        produced_by = result.get("afp:producedBy")
        if not isinstance(produced_by, str):
            continue
        ok = any(_brain_matches(produced_by, model, endpoint) for model, endpoint in entries)
        report.record(
            f"policy: {result.get('id', '<no id>')} afp:producedBy names a listed brain",
            ok,
            "" if ok else
            f"afp:producedBy is {produced_by!r}, which the policy's afp:brains does not list (ADR-0033)",
        )


def _check_controllers(report, policy: dict, all_activities: list[dict]) -> None:
    """For every `Create{afp:Act}` whose `afp:action` equals the governing
    pinned policy's value for category `approve` or `reject` — resolved the
    way `action.py` resolves it, via `afp:actsOn`'s Synthesis chain — the
    reconciliation Result's `afp:externalRef` must be an operator-listed
    controller. A round with no resolvable governing policy is skipped: this
    check is about the operator's policy document, not about whether the
    round itself was well-formed (that is `check_actions`'s question)."""
    controllers = policy.get("afp:controllers")
    controllers = controllers if isinstance(controllers, list) else []
    by_digest = {digest_of(a): a for a in all_activities}

    for activity in all_activities:
        obj = activity.get("object")
        if not (isinstance(obj, dict) and obj.get("type") == "afp:Act"):
            continue
        acts_on = activity.get("afp:actsOn")
        action_value = activity.get("afp:action")
        if not isinstance(acts_on, str) or not isinstance(action_value, str):
            continue
        target = by_digest.get(acts_on)
        resolved_activity, synthesis = _resolve_synthesis(target, all_activities)
        if resolved_activity is None or synthesis is None:
            continue
        governing_policy, _ = _governing_policy(resolved_activity, all_activities)
        if governing_policy is None:
            continue
        decision = next((d for d in ("approve", "reject") if governing_policy.get(d) == action_value), None)
        if decision is None:
            continue

        act_digest = digest_of(activity)
        reconciliation = next(
            (
                a
                for a in all_activities
                if (r := afp_object(a, "afp:Result")) is not None and r.get("afp:reconciles") == act_digest
            ),
            None,
        )
        if reconciliation is None:
            continue  # unreconciled — not this check's question
        result = afp_object(reconciliation, "afp:Result") or {}
        external_ref = result.get("afp:externalRef")
        ok = isinstance(external_ref, str) and external_ref in controllers
        label = activity.get("id", "<no id>")
        report.record(
            f"policy: {label} was {decision}d by an authorized controller",
            ok,
            "" if ok else
            (f"{label} was {decision}d by {external_ref!r}, which the policy's afp:controllers does not list "
             f"(ADR-0033)"
             if controllers else
             f"{label} was {decision}d by {external_ref!r}, but the policy's afp:controllers is empty — an "
             f"approval happened under a policy naming nobody who may approve (ADR-0033)"),
        )


def _check_seat_policy(report, export: Path, policy: dict, all_activities: list[dict]) -> None:
    """Under `afp:seatPolicy: "follow-required"`, every `afp:Enroll`
    addressed to a hub this bundle hosts (an actor document in `actors/`
    carrying no `afp:replicaOf`) must be preceded — by `published` instant —
    by an `Accept{Follow}` in the hub's own outbox, the Follow itself
    authored by the Enroll's own actor (the instance). Under
    `enroll-implies-seat` the check records ok, informational — a replica's
    bundle, which relays Enrolls it never admitted, is never examined at all
    (it has no un-replicated actor document to find here)."""
    seat_policy = policy.get("afp:seatPolicy")
    if seat_policy not in ("follow-required", "enroll-implies-seat"):
        return

    actors_dir = export / "actors"
    if not actors_dir.exists():
        return
    for actor_path in sorted(actors_dir.glob("*.jsonld")):
        doc = _load_json(actor_path)
        if doc.get("afp:replicaOf"):
            continue
        hub_actor = doc.get("id")
        if not isinstance(hub_actor, str):
            continue
        enrolls = [
            a for a in all_activities if a.get("type") == "afp:Enroll" and a.get("target") == hub_actor
        ]
        if not enrolls:
            continue

        if seat_policy == "enroll-implies-seat":
            report.record(
                f"policy: {hub_actor} seat policy enroll-implies-seat does not require a Follow trail",
                True,
                "",
            )
            continue

        for enroll_activity in enrolls:
            instance_actor = enroll_activity.get("actor")
            enroll_label = enroll_activity.get("id", "<no id>")
            enroll_at = instant_millis(enroll_activity.get("published"))
            follow_ids = {
                a.get("id")
                for a in all_activities
                if a.get("actor") == instance_actor and a.get("type") == "Follow" and a.get("object") == hub_actor
            }
            preceded = any(
                a.get("actor") == hub_actor
                and a.get("type") == "Accept"
                and a.get("object") in follow_ids
                and instant_millis(a.get("published")) <= enroll_at
                for a in all_activities
            )
            report.record(
                f"policy: {enroll_label} is preceded by an Accept{{Follow}} from {hub_actor}",
                preceded,
                "" if preceded else
                f"{hub_actor} runs afp:seatPolicy 'follow-required', but {enroll_label} (enrolling "
                f"{instance_actor} at {hub_actor}) has no preceding Accept{{Follow}} in {hub_actor}'s "
                f"own outbox for a Follow authored by {instance_actor} (ADR-0033)",
            )


def _subject_precondition_holds(subject: str, all_activities: list[dict], before_millis: int) -> bool:
    for activity in all_activities:
        if instant_millis(activity.get("published")) >= before_millis:
            continue
        votes = equivocation_proof_votes(activity)
        if votes is not None and votes[0].get("actor") == subject and convicts(*votes):
            return True
        dispute = dispute_payload(activity)
        if dispute is not None:
            evidence = dispute.get("afp:evidence")
            if isinstance(evidence, list):
                for cited in evidence:
                    named = next((a for a in all_activities if digest_of(a) == cited), None)
                    if named is not None and named.get("actor") == subject:
                        return True
    return False


def _check_governance_subject(report, policy: dict, all_activities: list[dict]) -> None:
    """ADR-0033 Decision 4's subject precondition, recomputed. Lives here
    rather than beside `check_proposal_electorate` in `decision.py` because
    its trigger — `afp:governance.afp:subjectPrecondition` — is a field on
    the policy document `check_policy` already loaded; a reader asking "what
    does the policy make checkable" finds both governance answers (this one
    and `electorate_exhausted`, wired into `decision.py` where the
    no-decision reason it justifies already lives) from this one entry
    point, one hop each."""
    governance = policy.get("afp:governance")
    if not isinstance(governance, dict):
        return
    if governance.get("afp:subjectPrecondition") != "proof-or-dispute-on-record":
        return

    for activity in all_activities:
        proposal = afp_object(activity, "afp:Proposal")
        if proposal is None:
            continue
        subject = proposal.get("afp:governanceSubject")
        if not isinstance(subject, str):
            continue
        at = instant_millis(activity.get("published"))
        holds = _subject_precondition_holds(subject, all_activities, at)
        report.record(
            f"policy: {proposal.get('id', '<no id>')} names afp:governanceSubject {subject} with a proof or "
            f"dispute on record",
            holds,
            "" if holds else
            f"{proposal.get('id', '<no id>')} names afp:governanceSubject {subject!r}, but the policy requires "
            f"'proof-or-dispute-on-record' and neither a convicting Announce{{afp:EquivocationProof}} nor an "
            f"afp:ContributionDispute citing an activity of theirs is on record before it opened (ADR-0033)",
        )
