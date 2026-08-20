"""ADR-0008 Decision 1/4 — the federation-boundary verifier extension.

Kept apart from `afp_verify.py` for the same reason `decision.py` and
`allocation.py` are: an auditor asking "what does the P4 boundary extension
actually check" should not have to wade through the rest of the replay.

Two pieces:

- `admitting_grant`/`summarize_activity` are a deliberate reimplementation of
  `src/instance/src/federation/grants.ts` `admittingGrant`/`summarize` — no
  code sharing, same semantics, diffed against the TypeScript by the raw-JSON
  parity harness. A grant admits an activity or it does not; the gate checks
  each inbound activity against *the grant that admits it*, never "some grant
  exists," and an unknown grant type admits nothing.
- `check_federation` replays Decision 4's expiry rule for a **single export**:
  every cross-boundary activity in *this* export must be covered by a
  co-signed `afp:FederationAgreement` (also in this export) that was active —
  held an admitting grant, at or before its `afp:expires` — when the activity
  published. This is the single-export replay only; comparing what one
  operator's export claims against the counterparty's own export (the
  two-export replay, findings 29a/29b) is deliberately deferred to its own
  ADR and is not attempted here.

An export with no cross-boundary activity runs none of this — backward
compatible by construction, so every export written before P4 stays green.
"""

from __future__ import annotations

from urllib.parse import urlsplit

from decision import afp_object, instant_millis

# --------------------------------------------------------------- grant match
#
# Mirrors src/instance/src/federation/grants.ts exactly (see that file's own
# docstring for the rule in prose). Kept as plain dict/str logic — no classes
# — so the parity harness can feed it raw JSON straight off the wire.

_DELEGATION_TYPES = {"Offer", "Accept", "Create", "Reject"}
_DELEGATION_OBJECTS = {"afp:Task", "afp:Result", "afp:Error", ""}


def admitting_grant(agreement: dict, summary: dict) -> dict | None:
    """The first grant in `agreement["afp:grants"]` that admits `summary`, or
    None. Order is the agreement's own — deterministic, because the agreement
    is signed bytes."""
    grants = agreement.get("afp:grants")
    if not isinstance(grants, list):
        return None

    for entry in grants:
        if not isinstance(entry, dict):
            continue
        grant_type = entry.get("afp:grantType")

        if grant_type == "hub":
            if summary.get("hub") is not None and summary["hub"] == entry.get("afp:hub"):
                return entry
            continue

        if grant_type == "direct-delegation":
            # Hub-addressed traffic never rides a delegation grant (no cross-admit).
            if summary.get("hub") is not None:
                continue
            if summary.get("type") not in _DELEGATION_TYPES:
                continue
            if summary.get("objectType") not in _DELEGATION_OBJECTS:
                continue
            if summary.get("type") == "Offer" or summary.get("objectType") == "afp:Task":
                # The opening move must name a granted capability.
                capabilities = entry.get("afp:capabilities")
                capabilities = capabilities if isinstance(capabilities, list) else []
                capability = summary.get("capability")
                if capability is None or capability not in capabilities:
                    continue
            # Responses (Accept / Result / Error / Reject) ride the
            # relationship the grant establishes; expiry (Decision 4) is what
            # constrains them in time, not re-matching a capability they do
            # not carry.
            return entry
        # Unknown grant type: admits nothing.
    return None


def summarize_activity(activity: dict) -> dict:
    """The summary the gate matches on, from a raw activity."""
    obj = activity.get("object")
    obj = obj if isinstance(obj, dict) else None
    hub = activity.get("afp:hub")
    if not isinstance(hub, str):
        hub = obj.get("afp:hub") if obj else None
        hub = hub if isinstance(hub, str) else None
    capability = obj.get("afp:capability") if obj else None
    return {
        "type": activity.get("type") or "",
        "objectType": (obj.get("type") if obj else None) or "",
        "capability": capability if isinstance(capability, str) else None,
        "hub": hub,
    }


# ---------------------------------------------------------- boundary replay


def _origin(url: object) -> str | None:
    if not isinstance(url, str):
        return None
    parts = urlsplit(url)
    if not parts.scheme or not parts.netloc:
        return None
    return f"{parts.scheme}://{parts.netloc}"


def _to_list(value: object) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [v for v in value if isinstance(v, str)]
    return []


def _agreement_parties(agreement: dict) -> list[str]:
    parties = agreement.get("afp:parties")
    return [p for p in parties if isinstance(p, str)] if isinstance(parties, list) else []


def _foreign_party(agreement: dict, instance_actor: str) -> str | None:
    """The agreement party that is not this export's instance — the reading
    Decision 1 gives "the foreign party is whichever party is not this
    export's instance actor." Two-party agreements only, per Decision 1."""
    for party in _agreement_parties(agreement):
        if party != instance_actor:
            return party
    return None


def _federation_agreements(all_activities: list[dict]) -> list[dict]:
    """Every `Create{afp:FederationAgreement}` object payload in this export."""
    agreements = []
    for activity in all_activities:
        if activity.get("type") != "Create":
            continue
        obj = afp_object(activity, "afp:FederationAgreement")
        if obj is not None:
            agreements.append(obj)
    return agreements


def check_federation(report, all_activities: list[dict], authority) -> None:
    instance_actor = getattr(authority, "instance_actor", None)
    if not instance_actor:
        return  # no instance identity resolved — nothing to check a boundary against
    instance_origin = _origin(instance_actor)
    if instance_origin is None:
        return

    agreements = _federation_agreements(all_activities)

    cross_boundary: list[tuple[dict, str]] = []  # (activity, foreign target actor)
    for activity in all_activities:
        for target in _to_list(activity.get("to")):
            if _origin(target) is not None and _origin(target) != instance_origin:
                cross_boundary.append((activity, target))
                break  # one foreign target is enough to mark the activity

    if not cross_boundary:
        return  # backward compatible by construction — nothing crosses the boundary

    def relevant_agreements(foreign_target: str) -> list[dict]:
        """Agreements naming this instance and a party at the target's origin."""
        target_origin = _origin(foreign_target)
        out = []
        for agreement in agreements:
            parties = _agreement_parties(agreement)
            if instance_actor not in parties:
                continue
            foreign_party = _foreign_party(agreement, instance_actor)
            if foreign_party is not None and _origin(foreign_party) == target_origin:
                out.append(agreement)
        return out

    for activity, foreign_target in cross_boundary:
        label = activity.get("id", "<no id>")
        summary = summarize_activity(activity)
        published = instant_millis(activity.get("published"))
        candidates = relevant_agreements(foreign_target)

        # (a) admissibility per Decision 4: an agreement holding an admitting
        # grant, active (published <= afp:expires) at this instant.
        admitting = None
        for agreement in candidates:
            grant = admitting_grant(agreement, summary)
            if grant is not None and published <= instant_millis(agreement.get("afp:expires")):
                admitting = agreement
                break
        report.record(
            f"federation: {label} admitted by a grant",
            admitting is not None,
            "" if admitting is not None else
            (f"no co-signed afp:FederationAgreement with {foreign_target} admits "
             f"{summary['type']}{{{summary['objectType']}}} — grants on record: "
             + "; ".join(str(g) for a in candidates for g in (a.get("afp:grants") or []))
             if candidates else
             f"no co-signed afp:FederationAgreement in this export names {foreign_target} "
             f"as a party (ADR-0008)"),
        )

        # (b) Decision 4's named failure for a post-expiry Offer specifically:
        # a grant matches by shape, but the window has closed.
        if summary["type"] == "Offer" and summary["objectType"] == "afp:Task":
            grant_match = next(
                (a for a in candidates if admitting_grant(a, summary) is not None), None
            )
            if grant_match is not None:
                expires = instant_millis(grant_match.get("afp:expires"))
                report.record(
                    f"federation: {label} inside the agreement window",
                    published <= expires,
                    "" if published <= expires else
                    f"Offer published {activity.get('published')!r} is after the admitting "
                    f"agreement's afp:expires {grant_match.get('afp:expires')!r} — a "
                    f"post-expiry Offer admitted (ADR-0008 Decision 4)",
                )

        # (c) the backstop: a cross-boundary Result/Error published after
        # every relevant agreement expired must ride an in-time Accept for
        # the same correlationId — completion-with-a-hard-edge, checkable.
        if summary["type"] == "Create" and summary["objectType"] in ("afp:Result", "afp:Error"):
            expiries = [instant_millis(a.get("afp:expires")) for a in candidates]
            if expiries and published > max(expiries):
                obj = activity.get("object") if isinstance(activity.get("object"), dict) else {}
                correlation = obj.get("afp:correlationId")
                in_time_accept = any(
                    a.get("type") == "Accept"
                    and isinstance(a.get("object"), dict)
                    and a["object"].get("afp:correlationId") == correlation
                    and any(instant_millis(a.get("published")) <= e for e in expiries)
                    for a in all_activities
                )
                report.record(
                    f"federation: {label} late outcome rides an in-time Accept",
                    in_time_accept,
                    "" if in_time_accept else
                    f"{summary['objectType']} for afp:correlationId {correlation!r} published "
                    f"after every admitting agreement expired, with no in-time Accept on "
                    f"record for the same correlation (ADR-0008 Decision 4)",
                )
