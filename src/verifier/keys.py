"""ADR-0012 Decisions 1/2 — the signing-key history: interval-aware key
resolution, and the rotation/revocation distinction it exists to check.

Kept apart from `afp_verify.py` for the same reason `pins.py` is: an auditor
asking "how does the verifier resolve an old signature" should find the whole
answer in one file, not woven through the general replay.

**Compatibility (binding).** An absent `afp:keyHistory` means today's
behaviour: `parse_key_history` returns `None`, and every function here is a
no-op on `None` — keys resolve from the current actor document alone, no
interval is consulted, and nothing here can fail a pre-ADR-0012 bundle.

**Instance custody.** Under `instance` custody the key that signs an agent's
activity is the *operating instance's* key, not the agent's own — so a
history entry's `afp:actor` names whoever's key actually signed, and interval
resolution is keyed on `verificationMethod` id alone, never on the activity's
own `actor`. Grouping "does this actor's history cover its chain" therefore
groups by the *signing* actor (the history entry's `afp:actor`), which is the
instance in the common case and matches what the manifest actually declares.
"""

from __future__ import annotations

from dataclasses import dataclass

from decision import instant_millis
from proof import decode_multikey, verify_proof


@dataclass
class KeyRecord:
    actor: str | None
    key_id: str | None
    public_key: bytes
    # epoch ms. `afp:validFrom` MAY be absent — a first key's start is often
    # never recorded, and a synthesized one (PEM mtime, export time) risks
    # landing *after* activities the key legitimately signed, which is the
    # one direction that silently strands a corpus. `instant_millis(None)`
    # already returns 0 (epoch start), which is exactly "no lower bound" for
    # every real `published` instant — so an absent afp:validFrom is never
    # treated as an error or as "now" (ADR-0012 Decision 1).
    valid_from: int
    valid_until: int | None  # epoch ms; None = still active
    retired_by: str | None  # "rotation" | "revocation" | None (active)


def parse_key_history(manifest: dict) -> list[KeyRecord] | None:
    """`afp:keyHistory` entries, or `None` when the manifest carries no
    history at all — the caller runs no interval checks on `None` (Compatibility)."""
    raw = manifest.get("afp:keyHistory")
    if not isinstance(raw, list):
        return None

    records: list[KeyRecord] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        multibase = entry.get("publicKeyMultibase")
        if not isinstance(multibase, str):
            continue
        try:
            key_bytes = decode_multikey(multibase)
        except ValueError:
            continue
        until = entry.get("afp:validUntil")
        records.append(
            KeyRecord(
                actor=entry.get("afp:actor"),
                key_id=entry.get("id"),
                public_key=key_bytes,
                # instant_millis(None) -> 0: an absent afp:validFrom reads as
                # unbounded below, never as "now" — see the field comment.
                valid_from=instant_millis(entry.get("afp:validFrom")),
                valid_until=instant_millis(until) if isinstance(until, str) else None,
                retired_by=entry.get("afp:retiredBy"),
            )
        )
    return records


def history_keys(history: list[KeyRecord] | None) -> dict[str, bytes]:
    """`id -> key bytes` for every historied key, folded into the flat map
    `collect_public_keys` builds so a signature by a rotated-out key still
    finds its bytes exactly as a current one does."""
    if history is None:
        return {}
    return {r.key_id: r.public_key for r in history if r.key_id}


def _covers(record: KeyRecord, instant: int) -> bool:
    if instant < record.valid_from:
        return False
    return record.valid_until is None or instant <= record.valid_until


def check_key_intervals(
    report,
    history: list[KeyRecord] | None,
    labeled_activities: list[tuple[str, dict]],
) -> None:
    """ADR-0012 Decision 1/2: every signature resolves to a key valid at its
    `published` instant, and each signing actor's declared intervals leave no
    gap across the activities that actor's keys signed.

    Scoped **per key, not per bundle**: a `verificationMethod` that appears in
    `afp:keyHistory` MUST satisfy its interval, but one that does not appear
    resolves exactly as it does today, with no interval check and no finding.
    An undeclared key is the compatibility path; a key the history *does*
    declare, signing outside its interval, is the finding worth naming.

    ADR-0026 Decision 3 widened what a writer declares: an agent's hub-scoped
    vote key and its transport key are now in the history too, where before
    only the instance key, the per-agent P1 key and the per-hub key were
    (ADR-0023 row L1, "a live hole" per ADR-0021 Q7). This function needed no
    change for that — being keyed on `verificationMethod` rather than on actor
    is exactly what let the new entries fall under the check automatically —
    but the reach is worth stating precisely. This check reads
    `proof.verificationMethod` on the activities an outbox carries. In every
    bundle shipped today those are signed by the proof key — under `instance`
    custody the instance key signs on the agent's behalf, so no exported
    activity, and no vote embedded in an `afp:EquivocationProof`, is signed by
    a hub-scoped or transport key. Declaring those keys therefore ARMS the
    interval check without yet exercising it: the day a hub-scoped signature
    does travel in a bundle it is judged, and until then the entries are a
    record of what exists rather than a check that fires. A bundle from a
    writer that predates ADR-0026 declares fewer keys and is judged on the
    ones it does declare.

    `labeled_activities` is every non-stub activity across every outbox, each
    paired with the same `f"{actor}[{index}] {id}"` label the signature check
    uses, so a finding here reads next to the signature it's about.
    """
    if history is None:
        return  # no history in this bundle — today's behaviour (Compatibility)

    by_id = {r.key_id: r for r in history if r.key_id}
    gap_actors: set[str] = set()
    seen_actors: set[str] = set()

    for label, activity in labeled_activities:
        proof = activity.get("proof")
        method = proof.get("verificationMethod") if isinstance(proof, dict) else None
        record = by_id.get(method)
        if record is None:
            # A key not named in the history at all — a hub-scoped key, or a
            # signature by an unpublished key already reported by
            # `signature:`/`authority:` — resolves exactly as it does today.
            # This check judges only the keys the history does claim.
            continue

        instant = instant_millis(activity.get("published"))
        ok = _covers(record, instant)
        report.record(
            f"keys: {label} signed by a key valid at its published instant",
            ok,
            "" if ok else
            f"signed with {method}, valid from {record.valid_from} until "
            f"{record.valid_until if record.valid_until is not None else 'now'} "
            f"(ms since epoch), but published at {instant} — a signature outside "
            f"its key's declared interval (ADR-0012)",
        )

        if record.actor:
            seen_actors.add(record.actor)
            covered_by_any = any(
                _covers(r, instant) for r in history if r.actor == record.actor
            )
            if not covered_by_any:
                gap_actors.add(record.actor)

    for actor in sorted(seen_actors):
        gap = actor in gap_actors
        report.record(
            f"keys: {actor} declared intervals cover every activity in its chain",
            not gap,
            "" if not gap else
            f"{actor}'s chain reaches into a period no declared key interval "
            f"covers — a chain signed by something the bundle refuses to name "
            f"(ADR-0012)",
        )


def check_key_delegations(
    report,
    actor_keys: dict[str, bytes],
    labeled_activities: list[tuple[str, dict]],
) -> None:
    """ADR-0035 Decision 2/5 — the on-record artifact `remote-issued` custody
    publishes when its root key mints a successor.

    `actor_keys` MUST come from the bundle's actor documents alone (never
    `afp:keyHistory`, never the delegation activity's own claim about its
    root) — the same "never resolve a signer against the record under
    verification" discipline `check_manifest_signature` already holds the
    manifest to. A thief who has stolen the host holds every key the
    manifest and its history can assert; the one thing they do not hold is
    an actor document a counterparty already fetched and cached before the
    theft, which is why that is the only anchor this check trusts.

    Also holds every signature by a delegated key to the window **its own
    delegation declares**, independent of `afp:keyHistory`'s entry for that
    key: `check_key_intervals` above already checks the history entry, but
    the history is asserted by the same (possibly stolen) key that signs the
    rest of the export, so a widened `afp:validUntil` there proves nothing
    on its own. The delegation is root-signed and therefore unforgeable by
    whoever holds only the successor, so its declared window is what a
    doctored history entry cannot override (the compromise window Decision 2
    exists for).
    """
    # label -> (delegatedKeyId, validFrom ms, validUntil ms)
    delegations: list[tuple[str, str, int, int]] = []

    for label, activity in labeled_activities:
        obj = activity.get("object")
        if not isinstance(obj, dict) or obj.get("type") != "afp:KeyDelegation":
            continue

        root_key_id = obj.get("afp:rootKey")
        root_published = isinstance(root_key_id, str) and root_key_id in actor_keys
        report.record(
            f"keys: {label} (afp:KeyDelegation)'s root key is published on an actor document",
            root_published,
            "" if root_published else
            f"names root key {root_key_id!r}, which no actor document in this bundle publishes — "
            f"resolving it from afp:keyHistory or the activity's own claim instead is exactly the "
            f"circularity that would let a stolen host mint its own 'root' and delegate itself a "
            f"successor (ADR-0035 Decision 2)",
        )

        proof = activity.get("proof")
        signer = proof.get("verificationMethod") if isinstance(proof, dict) else None
        signed_by_root = root_published and signer == root_key_id
        report.record(
            f"keys: {label} (afp:KeyDelegation) is signed by the root key it names",
            signed_by_root,
            "" if signed_by_root else
            f"names root key {root_key_id!r} but is signed by {signer!r} — a delegation not "
            f"signed by its own (published) root is an unchecked handoff, not a delegation",
        )

        from_raw = obj.get("afp:validFrom")
        until_raw = obj.get("afp:validUntil")
        interval_present = isinstance(from_raw, str) and isinstance(until_raw, str)
        report.record(
            f"keys: {label} (afp:KeyDelegation) declares both ends of its delegated interval",
            interval_present,
            "" if interval_present else
            "afp:validFrom and afp:validUntil must both be present strings — an open-ended "
            "delegation is not one Decision 2's compromise-window property can be checked against",
        )

        delegated = obj.get("afp:delegatedKey")
        delegated_key_id = delegated.get("keyId") if isinstance(delegated, dict) else None
        if root_published and signed_by_root and interval_present and isinstance(delegated_key_id, str):
            delegations.append((label, delegated_key_id, instant_millis(from_raw), instant_millis(until_raw)))

    for label, activity in labeled_activities:
        proof = activity.get("proof")
        method = proof.get("verificationMethod") if isinstance(proof, dict) else None
        if method is None:
            continue
        published = instant_millis(activity.get("published"))
        for delegation_label, delegated_key_id, valid_from, valid_until in delegations:
            if method != delegated_key_id:
                continue
            ok = valid_from <= published <= valid_until
            report.record(
                f"keys: {label} signed by {method} falls inside its afp:KeyDelegation's declared window",
                ok,
                "" if ok else
                f"signed at {published}, but {delegation_label}'s afp:KeyDelegation declared "
                f"{method!r} valid {valid_from}..{valid_until} — a signature outside the delegated "
                f"window is not saved by anything afp:keyHistory separately claims (ADR-0035)",
            )


def check_manifest_signature(report, manifest: dict, actor_keys: dict[str, bytes]) -> None:
    """ADR-0012 Decision 1: the manifest is a signed document, so its own
    bytes must verify — not merely name a plausible key.

    `actor_keys` MUST come from the bundle's actor documents alone. The
    manifest's `afp:keyHistory` is part of the document under verification;
    resolving the signing key through it would let anyone who rewrites a
    manifest also supply the public half of the key they rewrote it with, and
    the check would congratulate them.

    An unsigned manifest is pre-ADR-0012 and is skipped (Compatibility); a
    signed one whose method no actor document publishes is reported, because
    "signed by something this bundle will not name" is exactly the case a
    forger needs and an honest exporter never produces.
    """
    proof = manifest.get("proof")
    if not isinstance(proof, dict):
        return  # unsigned: pre-ADR-0012 bundle

    method = proof.get("verificationMethod")
    if method not in actor_keys:
        report.record(
            "keys: the manifest's signature verifies",
            False,
            f"manifest signed with {method!r}, which no actor document in this bundle "
            f"publishes — an export's self-description must be verifiable against the "
            f"keys the bundle itself carries (ADR-0012 Decision 1)",
        )
        return

    reason = verify_proof(manifest, actor_keys)
    report.record(
        "keys: the manifest's signature verifies",
        reason is None,
        reason or "",
    )


def check_manifest_key_history(report, manifest: dict, history: list[KeyRecord] | None) -> None:
    """ADR-0012 Decision 1: the key that signed the manifest MUST itself
    appear in its own history and be valid at the manifest's own instant. An
    unsigned manifest is read as pre-ADR-0012 (Compatibility) and this check
    does not run; nor does it run when the manifest is signed but carries no
    history — there is nothing to resolve against."""
    proof = manifest.get("proof")
    if not isinstance(proof, dict) or history is None:
        return

    method = proof.get("verificationMethod")
    record = next((r for r in history if r.key_id == method), None)
    instant = instant_millis(proof.get("created") or manifest.get("exportedAt"))
    ok = record is not None and _covers(record, instant)
    report.record(
        "keys: the manifest's proof resolves to a key its own history declares valid",
        ok,
        "" if ok else
        f"manifest signed with {method!r}, which its own afp:keyHistory does not "
        f"declare valid at the manifest's instant — an export signed by a key its "
        f"own history says was retired is incoherent on its face (ADR-0012)",
    )
