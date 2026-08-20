"""ADR-0004 Decision 2 — the `afp:Asset` verifier extension.

Kept apart from `afp_verify.py` for the same reason `decision.py` and
`allocation.py` are: an auditor asking "what does the asset extension actually
check" should not have to wade through the rest of the replay procedure.

Per 07 "Artifacts & attachments" and ADR-0004: the asset registry is replayed
from ordinary signed `Update{afp:Asset}` activities; one (id, version) is
immutable once registered — a second Update naming the same (id, version) with
a different digest is a claim nothing can resolve; registration is a
member-role act; and every `afp:reuses` (on a revealed Bid) or `afp:reused`
(on a Result) reference must resolve to a registered asset. A reuse claim that
resolves to nothing is the asset-flavored "counted vote you cannot produce."

Runs only when an export contains an `afp:Asset` Update or a reuse reference;
an export with none runs none of this — backward compatible by construction.
"""

from __future__ import annotations

from decision import afp_object, enrolled_roles


def _asset_updates(all_activities: list[dict]) -> list[tuple[dict, dict]]:
    """(activity, asset object) for every Update{afp:Asset}, in outbox order."""
    out = []
    for activity in all_activities:
        if activity.get("type") != "Update":
            continue
        obj = afp_object(activity, "afp:Asset")
        if obj is not None:
            out.append((activity, obj))
    return out


def replay_registry(all_activities: list[dict]) -> dict[tuple[str, str], dict]:
    """(assetId, version) -> first-registered asset record. First write wins:
    the immutability check is what names any later conflicting write."""
    registry: dict[tuple[str, str], dict] = {}
    for _, obj in _asset_updates(all_activities):
        key = (str(obj.get("id")), str(obj.get("afp:version")))
        registry.setdefault(key, obj)
    return registry


def check_assets(report, all_activities: list[dict]) -> None:
    updates = _asset_updates(all_activities)
    registry = replay_registry(all_activities)

    # 1 — (id, version) immutability: an asset that mutated under its own
    # version is a named failure, not a merge.
    #
    # Exactly one record per asset key. Deriving a passing record from the
    # registry instead would compare first-write-wins against first-write-wins
    # — always true, so the "ok" line would print unconditionally, including
    # over a failure it contradicts. A check that cannot fail is worse here
    # than no check: this tool's whole value is that its findings mean
    # something (H10).
    first: dict[tuple[str, str], str] = {}
    conflicts: dict[tuple[str, str], list[str]] = {}
    for _, obj in updates:
        key = (str(obj.get("id")), str(obj.get("afp:version")))
        digest = str(obj.get("afp:digest"))
        if key not in first:
            first[key] = digest
        elif first[key] != digest:
            conflicts.setdefault(key, []).append(digest)
    for key, held in first.items():
        offered = conflicts.get(key, [])
        report.record(
            f"asset: {key[0]}@{key[1]} is immutable once registered",
            not offered,
            "" if not offered else
            f"registered with digest {held}, later Update(s) offer "
            f"{', '.join(sorted(set(offered)))} — a new version is a new entry (ADR-0004)",
        )

    # 2 — registration authority: any member may register; a requester or
    # observer registration is a role violation on the record (ADR-0004).
    for activity, obj in updates:
        actor = activity.get("actor")
        hub_actor = activity.get("afp:hub") or obj.get("afp:hub")
        roles = enrolled_roles(hub_actor, all_activities)
        role = roles.get(actor, "member" if actor == hub_actor else None)
        ok = role == "member" or actor == hub_actor
        report.record(
            f"asset: {obj.get('id')}@{obj.get('afp:version')} registered by a member",
            ok,
            "" if ok else
            f"Update{{afp:Asset}} from {actor!r} whose role is {role!r} — only "
            f"member-role agents register assets (ADR-0004)",
        )

    # 3 — reference resolution: every afp:reuses (revealed Bid) and afp:reused
    # (Result) resolves to a registered (id, version).
    def resolve(ref: dict, where: str) -> None:
        asset_id = str(ref.get("asset"))
        version = str(ref.get("version"))
        ok = (asset_id, version) in registry
        report.record(
            f"asset: {where} reuse reference {asset_id}@{version} resolves",
            ok,
            "" if ok else
            f"{where} claims reuse of {asset_id}@{version} but no registered "
            f"afp:Asset backs it — a reuse claim that resolves to nothing (ADR-0004)",
        )

    for activity in all_activities:
        if activity.get("type") == "afp:BidReveal":
            payload = activity.get("object")
            if isinstance(payload, dict) and isinstance(payload.get("afp:reuses"), dict):
                resolve(payload["afp:reuses"], f"bid {activity.get('id', '<no id>')}")
        result = afp_object(activity, "afp:Result")
        if result is not None and isinstance(result.get("afp:reused"), dict):
            resolve(result["afp:reused"], f"result {result.get('id', '<no id>')}")
