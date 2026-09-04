#!/usr/bin/env python3
"""afp-verify — replay an AFP export and say whether it holds up.

Run by someone who was not there: this reads nothing but the export directory
and needs no access to the instance that produced it, no private keys, and no
network. It is a deliberately independent second implementation of the record
format (ADR-0001) — if it disagrees with the writer, that disagreement is the
finding rather than a nuisance.

    python3 afp_verify.py <export-dir> [--thread https://example.org/threads/...] [-v]

Exit status is 0 only if every check passes.

The replay procedure, per 04 "Replay procedure":
    resolve authority from the roster -> select by context -> verify each
    signature AND that its key had authority over the actor -> walk each
    prevActivity chain -> account for every rostered agent -> verify attachment
    digests -> confirm the thread reaches a terminal Result

Authority and completeness are not decoration. A signature-only replay accepts
an activity re-signed with any published key (the tail of a chain has no
successor to protect it) and accepts a bundle with a whole agent's outbox
deleted (chains are per-actor, so nothing points at the hole).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

from allocation import check_announce_role, check_award, check_retired_spellings
from asset import check_assets
from action import check_actions, check_supersession
from decision import (
    afp_object,
    check_archive_state,
    check_decision_record,
    check_decision_settlement,
    check_departure,
    check_contribution_split,
    check_enroll_authority,
    check_equivocation_proof,
    check_key_compromise_claim,
    check_membership_actuation,
    check_proposal_electorate,
    check_succession,
    check_vote_l1_fields,
    instant_millis,
    settlement_payload,
    wrapped_payload,
)
from electorate import (
    cause_resolves,
    excluded_entries,
    partition as electorate_partition,
    proofs_convicting,
)
from equivocation import convicts, equivocation_proof_votes, proof_round, vote_tuple_of
from federation import check_federation, check_joint
from keys import (
    check_key_intervals,
    check_manifest_key_history,
    check_manifest_signature,
    history_keys,
    parse_key_history,
)
from pins import (
    check_disclosed_answers_keep_their_pins,
    check_pins,
    check_prior_thread,
    check_proposal_action_policy,
)
from proof import CRYPTOSUITE, decode_multikey, digest_of, verify_proof
from summary import check_disputes, check_summary_arithmetic, check_summary_frame, check_summary_terminal


# --------------------------------------------------------------------- report


@dataclass
class Report:
    checks: list[tuple[str, bool, str]] = field(default_factory=list)

    def record(self, name: str, ok: bool, detail: str = "") -> bool:
        self.checks.append((name, ok, detail))
        return ok

    @property
    def failures(self) -> list[tuple[str, bool, str]]:
        return [check for check in self.checks if not check[1]]

    def print(self, verbose: bool) -> None:
        for name, ok, detail in self.checks:
            if ok and not verbose:
                continue
            mark = "  ok  " if ok else " FAIL "
            line = f"[{mark}] {name}"
            print(line if not detail else f"{line}\n           {detail}")

    def census(self) -> None:
        """ADR-0015 Decision 2 — what ran, per domain, per check family.

        Output, never checks: a family whose count is zero is a silence the
        reader should see, and recording silences as passing checks is the
        vacuous-record shape this repository already criticized. A bundle
        whose conditional checks all skipped prints its zeros here instead of
        printing nothing — which under several bundles is the difference
        between a question an auditor can ask and one they never think to.
        """
        import re as _re

        domains: dict[str, dict[str, int]] = {}
        for name, _ok, _detail in self.checks:
            match = _re.match(r"^(?:\[(?P<dom>[^\]]+)\] )?(?P<family>[a-z-]+):", name)
            if not match:
                continue
            domain = match.group("dom") or "·"
            family = match.group("family")
            bucket = domains.setdefault(domain, {})
            bucket[family] = bucket.get(family, 0) + 1
        # The conditional families: every one of these can legitimately run
        # zero times, and zero is exactly what must be VISIBLE — a family
        # absent from the line reads as nothing, a family printed at :0 reads
        # as a question. Unconditional families (signature, chain, …) appear
        # by their counts alone.
        conditional = (
            "action", "archive", "decision", "equivocation", "joint", "keys",
            "pins", "proof", "retention", "round", "succession", "supersession",
            "electorate", "synthesis", "unenroll", "vote",
            # ADR-0021 Decisions 3-5. Every one of these fires only on
            # material no shipped bundle carries — a recusal cause, a
            # compromise claim, a membership actuation, a cited proof — so
            # every one of them is a zero an auditor must be able to SEE
            # rather than an absence they never think to ask about.
            "recusal", "claim", "evidence", "membership",
            # ADR-0022 Decision 2 and its ADR-0017 amendment: a co-authored
            # Result's split, and a bundle whose vocabulary predates a rename.
            # `contribution:0` on a bundle full of single-author Results is the
            # honest reading; `vocabulary:0` says nothing here was retired.
            "contribution", "vocabulary",
        )
        print("census — checks run per domain (a zero you expected to be nonzero is a question):")
        for domain in sorted(domains):
            families = dict(domains[domain])
            for family in conditional:
                families.setdefault(family, 0)
            line = "  ".join(f"{family}:{count}" for family, count in sorted(families.items()))
            print(f"  {domain}  {line}")


# -------------------------------------------------------------------- loading


def load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def collect_public_keys(export: Path, history: list | None = None) -> dict[str, bytes]:
    """Map every published verification method id to its raw key bytes.

    A rotated-out key's bytes live only in `afp:keyHistory` — the current
    actor document no longer carries them — so `verify_proof`'s flat lookup
    stays correct for old signatures once `history` (ADR-0012) is folded in.
    An absent history contributes nothing, which is exactly today's map.
    """
    keys: dict[str, bytes] = {}
    for path in actor_documents(export):
        for method in load_json(path).get("assertionMethod", []):
            if isinstance(method, dict) and "publicKeyMultibase" in method:
                keys[method["id"]] = decode_multikey(method["publicKeyMultibase"])
    keys.update(history_keys(history))
    return keys


def actor_documents(export: Path) -> list[Path]:
    paths = [export / "instance.jsonld"]
    paths += sorted((export / "actors").glob("*.jsonld"))
    return [p for p in paths if p.exists()]


@dataclass
class Authority:
    """Which keys may sign for which actor, per the signed roster.

    A valid signature only proves that *someone holding a published key* wrote
    these bytes. Authority is the separate question of whether that key was
    entitled to speak for the actor named in the activity — see
    04 "Signature is not authority".
    """

    # actor URL -> verification-method ids permitted to sign for it
    keys_for_actor: dict[str, set[str]] = field(default_factory=dict)
    # actor URL -> True when the roster says the instance signs on its behalf
    instance_custody: dict[str, bool] = field(default_factory=dict)
    rostered: set[str] = field(default_factory=set)
    # actor URL -> the instance its own document names as operator
    # (`afp:operatedBy`) — who is entitled to enroll it (ADR-0005 Decision 2)
    operated_by: dict[str, str] = field(default_factory=dict)
    # this export's own instance actor id, from instance.jsonld — the origin
    # a cross-boundary activity is measured against (ADR-0008 Decision 1)
    instance_actor: str | None = None


def build_authority(export: Path, history: list | None = None) -> Authority:
    """Derive signing authority from the roster plus the actor documents."""
    authority = Authority()

    # Which key ids does each actor control, per its own document?
    controlled: dict[str, set[str]] = {}
    for path in actor_documents(export):
        doc = load_json(path)
        actor = doc.get("id")
        if not actor:
            continue
        ids = {
            m["id"]
            for m in doc.get("assertionMethod", [])
            if isinstance(m, dict) and "id" in m
        }
        controlled[actor] = ids
        # An instance speaks for itself with its own keys.
        authority.keys_for_actor.setdefault(actor, set()).update(ids)
        operator = doc.get("afp:operatedBy")
        if isinstance(operator, str):
            authority.operated_by[actor] = operator

    # ADR-0012: a rotated-out key is retired, not disowned — it remains part
    # of its actor's authority so an activity it signed in-interval still
    # resolves. Revoked keys stay in `controlled` too; the interval check
    # (keys.py) is what makes a post-revocation signature fail, not authority.
    if history:
        for record in history:
            if not record.actor or not record.key_id:
                continue
            controlled.setdefault(record.actor, set()).add(record.key_id)
            authority.keys_for_actor.setdefault(record.actor, set()).add(record.key_id)

    instance_doc = export / "instance.jsonld"
    instance_id = load_json(instance_doc).get("id") if instance_doc.exists() else None
    authority.instance_actor = instance_id

    roster_path = export / "roster.jsonld"
    if not roster_path.exists():
        return authority

    for entry in load_json(roster_path).get("orderedItems", []):
        if not isinstance(entry, dict):
            continue
        agent = entry.get("agent")
        if not agent:
            continue
        authority.rostered.add(agent)

        custody = entry.get("afp:keyCustody", "instance")
        if custody == "self":
            authority.instance_custody[agent] = False
            authority.keys_for_actor.setdefault(agent, set()).update(controlled.get(agent, set()))
        else:
            # `instance` custody: the operating instance signs, and must say so.
            authority.instance_custody[agent] = True
            operator = agent_operator(export, agent) or instance_id
            authority.keys_for_actor[agent] = set(controlled.get(operator, set()))

    return authority


def agent_operator(export: Path, agent_url: str) -> str | None:
    """The instance an agent declares as its operator, from its actor document."""
    for path in sorted((export / "actors").glob("*.jsonld")):
        doc = load_json(path)
        if doc.get("id") == agent_url:
            return doc.get("afp:operatedBy")
    return None


def check_authority(report: Report, authority: Authority, label: str, activity: dict) -> None:
    """The signing key must be entitled to speak for this activity's actor."""
    actor = activity.get("actor")
    proof = activity.get("proof")
    method = proof.get("verificationMethod") if isinstance(proof, dict) else None

    permitted = authority.keys_for_actor.get(actor)
    if permitted is None:
        report.record(
            f"authority: {label}",
            False,
            f"actor {actor} is not on the roster, so nothing may be signed for it",
        )
        return

    ok = method in permitted
    report.record(
        f"authority: {label}",
        ok,
        "" if ok else
        f"signed with {method}, which has no authority over {actor} "
        f"(permitted: {', '.join(sorted(permitted)) or 'none'})",
    )

    # Under instance custody the signature is the instance's, so the activity
    # must name the agent it acts for or attribution is unbound.
    if authority.instance_custody.get(actor):
        acting_as = activity.get("afp:actingAs")
        report.record(
            f"authority: {label} names the agent it acts for",
            acting_as == actor,
            "" if acting_as == actor else
            f"instance-custody activity has afp:actingAs {acting_as!r}, expected {actor!r}",
        )


# --------------------------------------------------------------------- checks


def check_chain(report: Report, actor: str, activities: list[dict]) -> None:
    """Walk one actor's hash chain: no gap, no fork, correct start — and
    non-decreasing `published` along it (ADR-0008 Decision 4's backstop).

    The monotonicity check is what makes backdating detectable anywhere: a
    timestamp-dependent rule (agreement expiry, settlement recency, role LWW)
    compares instants the actor itself wrote, and chain position brackets any
    backdated value between its honestly-dated neighbors — rewriting the
    bracket means rewriting the signed chain tail.
    """
    previous_digest: str | None = None
    previous_instant: int | None = None
    after_stub = False

    for index, activity in enumerate(activities):
        # ADR-0009 Decision 4: a redaction stub stands in chain position for a
        # lawfully-withheld activity. Its declared digest becomes the link the
        # next disclosed activity must name; its own backward link is inside
        # the withheld content and is unverifiable by design. Monotonicity
        # brackets across it (a stub carries no published).
        if activity.get("type") == "afp:Redacted":
            stub_digest = activity.get("afp:digest")
            report.record(
                f"chain: {actor}[{index}] redaction stub declares a digest",
                isinstance(stub_digest, str) and stub_digest.startswith("sha256:"),
                "" if isinstance(stub_digest, str) and str(stub_digest).startswith("sha256:") else
                f"afp:Redacted without a well-formed afp:digest ({stub_digest!r}) — a stub "
                f"that names nothing covers nothing (ADR-0009)",
            )
            previous_digest = str(stub_digest) if isinstance(stub_digest, str) else previous_digest
            after_stub = True
            continue

        label = f"{actor}[{index}] {activity.get('id', '<no id>')}"
        declared = activity.get("afp:prevActivity")

        instant = instant_millis(activity.get("published"))
        if previous_instant is not None:
            report.record(
                f"chain: {label} published does not decrease",
                instant >= previous_instant,
                "" if instant >= previous_instant else
                f"published {activity.get('published')!r} precedes its chain "
                f"predecessor's — a backdated timestamp inside a signed chain (ADR-0008)",
            )
        previous_instant = instant

        if index == 0:
            report.record(
                f"chain: {label} starts the chain",
                declared is None,
                "" if declared is None else
                f"first activity claims a predecessor ({declared}) — the chain does not start here",
            )
        elif after_stub:
            report.record(
                f"chain: {label} links to the declared redaction",
                declared == previous_digest,
                "" if declared == previous_digest else
                f"expected afp:prevActivity {previous_digest} (the stub's declared digest), found {declared}",
            )
        else:
            report.record(
                f"chain: {label} links to its predecessor",
                declared == previous_digest,
                "" if declared == previous_digest else
                f"expected afp:prevActivity {previous_digest}, found {declared}",
            )

        previous_digest = digest_of(activity)
        after_stub = False


def chain_head_digest(activities: list[dict]) -> str | None:
    """The digest a next activity on this chain would have to name — the
    stub's declared digest when the chain currently ends on a redaction
    (ADR-0009 Decision 4), otherwise the last activity's own digest."""
    if not activities:
        return None
    last = activities[-1]
    if last.get("type") == "afp:Redacted":
        digest = last.get("afp:digest")
        return digest if isinstance(digest, str) else None
    return digest_of(last)


def check_members(report: Report, export: Path, manifest: dict) -> None:
    """ADR-0012 Decision 4: every file present is declared in `afp:members`,
    and every declared member is present. A manifest with no `afp:members` is
    pre-inventory and this check does not run at all (Compatibility) — it is
    never failed for lacking a field that did not exist when it was written.
    """
    members = manifest.get("afp:members")
    if not isinstance(members, list):
        return
    declared = {m for m in members if isinstance(m, str)}
    present = {
        path.relative_to(export).as_posix()
        for path in export.rglob("*")
        if path.is_file() and path.name != "MANIFEST.json"
    }

    undeclared = sorted(present - declared)
    report.record(
        "bundle: every file present is declared in afp:members",
        not undeclared,
        "" if not undeclared else
        f"{len(undeclared)} file(s) travel with this bundle but afp:members does not "
        f"admit to carrying them: {', '.join(undeclared[:5])}"
        + (", …" if len(undeclared) > 5 else ""),
    )

    missing = sorted(declared - present)
    report.record(
        "bundle: every declared member is present",
        not missing,
        "" if not missing else
        f"afp:members declares {len(missing)} file(s) not found in the bundle: "
        f"{', '.join(missing[:5])}" + (", …" if len(missing) > 5 else ""),
    )


def check_retention(
    report: Report,
    export: Path,
    manifest: dict,
    all_activities: list[dict],
    chain_heads: dict[str, str],
) -> None:
    """ADR-0012 Decision 3, scoped to a declared `afp:retentionDuty`: at least
    one anchor exists, every anchor names a chain head this bundle actually
    contains, and every artifact a retained activity references keeps its
    bytes — not merely its digest. A bundle with no declared duty runs none
    of this (Compatibility): it is held to the SHOULDs as before.

    Never dereferences `afp:anchorRef` — the verifier reaches no network by
    design, and that seam is the auditor's (ADR-0012).
    """
    duty = manifest.get("afp:retentionDuty")
    if not isinstance(duty, dict):
        return

    anchors = manifest.get("afp:anchors")
    anchors = [a for a in anchors if isinstance(a, dict)] if isinstance(anchors, list) else []
    report.record(
        "retention: the declared duty is backed by an anchor",
        bool(anchors),
        "" if anchors else
        f"afp:retentionDuty declares {duty.get('afp:horizon')!r} but afp:anchors is "
        f"empty — a declared duty with no anchor (ADR-0012)",
    )

    heads = set(chain_heads.values())
    unresolved = sorted(
        {
            a.get("afp:actor", "<unknown>")
            for a in anchors
            if a.get("afp:head") not in heads
        }
    )
    report.record(
        "retention: every anchor names a chain head this bundle contains",
        not unresolved,
        "" if not unresolved else
        f"anchor(s) for {', '.join(unresolved)} name a digest that is not a chain head "
        f"this bundle contains (ADR-0012)",
    )

    missing_bytes = []
    for activity in all_activities:
        obj = activity.get("object")
        attachments = obj.get("attachment", []) if isinstance(obj, dict) else []
        for link in attachments:
            if not isinstance(link, dict):
                continue
            digest = link.get("afp:digest")
            if not isinstance(digest, str):
                continue
            if not (export / "artifacts" / digest.replace(":", "-")).exists():
                missing_bytes.append(digest[:24])
    report.record(
        "retention: artifacts referenced by retained activities keep their bytes",
        not missing_bytes,
        "" if not missing_bytes else
        f"{len(missing_bytes)} artifact(s) referenced by a retained activity are absent "
        f"from artifacts/ — the retention duty requires the bytes themselves, not only "
        f"the digest (07's federation floor is not a retention policy) (ADR-0012)",
    )


def check_attachments(report: Report, export: Path, activity: dict) -> None:
    """Every attachment must carry a digest, and the bytes must match it."""
    obj = activity.get("object")
    attachments = obj.get("attachment", []) if isinstance(obj, dict) else []

    for link in attachments:
        if not isinstance(link, dict):
            continue
        activity_id = activity.get("id", "<no id>")
        digest = link.get("afp:digest")

        if not isinstance(digest, str):
            report.record(
                f"artifact: attachment in {activity_id} declares a digest",
                False,
                "attachment has no afp:digest — evidence is unverifiable",
            )
            continue

        path = export / "artifacts" / digest.replace(":", "-")
        if not path.exists():
            report.record(
                f"artifact: {digest[:24]}… present in bundle",
                False,
                f"referenced by {activity_id} but absent from artifacts/",
            )
            continue

        actual = "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
        report.record(
            f"artifact: {digest[:24]}… matches its digest",
            actual == digest,
            "" if actual == digest else
            f"bytes hash to {actual[:24]}… but are referenced as {digest[:24]}… by {activity_id}",
        )


def check_thread(report: Report, activities: list[dict], thread: str, own_actors: set[str] | None = None) -> None:
    """A replay selects by `context` and must reach a terminal outcome."""
    in_thread = [a for a in activities if a.get("context") == thread]
    report.record(
        f"thread: {thread} has activities",
        bool(in_thread),
        "" if in_thread else "no activity carries this context",
    )
    if not in_thread:
        return

    # Only threads that delegated something are expected to close. An
    # administrative thread — the instance's Vouch/Disown trail, say — has no
    # terminal outcome by design, and demanding one would report a gap where
    # there is none.
    tasks = [a for a in in_thread if outcome_type(a) == "afp:Task"]
    outcomes = [a for a in in_thread if outcome_type(a) in ("afp:Result", "afp:Error")]

    # A bundle answers for the threads it *acted on*. A hub broadcasts its queue
    # to every member, so a desk that never bid on a ticket holds the announce
    # and nothing else — and where the answer carries customer data it will
    # never hold more than that, because ADR-0013's gate is doing its job. An
    # absent terminal is that domain's gap only if that domain was in the
    # thread; otherwise the record is reporting somebody else's completeness as
    # this bundle's hole, which is exactly the confusion ADR-0009 separated when
    # it ruled that a per-actor chain cannot show a missing participant.
    #
    # Nothing is loosened for a participant: a domain that published in a thread
    # and dropped its terminal still fails here. Found by the P7 demo, the first
    # workload whose hub broadcasts work most of its members never touch.
    participated = own_actors is None or any(a.get("actor") in own_actors for a in in_thread)
    if tasks and not participated:
        report.record(
            f"thread: {thread} reaches a terminal outcome",
            True,
            "received-only: this domain published nothing in this thread, so an absent terminal is "
            "not its gap — the hub broadcast the task and the answer is somebody else's to hold "
            "(ADR-0009's participant/completeness split)",
        )
    elif tasks:
        report.record(
            f"thread: {thread} reaches a terminal outcome",
            bool(outcomes),
            "" if outcomes else "thread contains no afp:Result or afp:Error — it never closed",
        )

    # correlationId identifies one task; reusing it across tasks is the collision
    # scenario 02 found, so a replay checks that each task closed exactly once.
    seen: dict[str, int] = {}
    for activity in outcomes:
        obj = activity.get("object") or {}
        correlation = obj.get("afp:correlationId") if isinstance(obj, dict) else None
        if correlation:
            seen[correlation] = seen.get(correlation, 0) + 1

    duplicated = [cid for cid, count in seen.items() if count > 1]
    report.record(
        f"thread: {thread} has one outcome per correlationId",
        not duplicated,
        "" if not duplicated else f"correlationId answered more than once: {', '.join(duplicated)}",
    )


def outcome_type(activity: dict) -> str:
    obj = activity.get("object")
    return obj.get("type", "") if isinstance(obj, dict) else ""


# ----------------------------------------------------------------------- main


def verify_export(export: Path, thread: str | None, report: Report) -> dict:
    manifest_path = export / "MANIFEST.json"
    if not report.record("bundle: MANIFEST.json present", manifest_path.exists()):
        return
    manifest = load_json(manifest_path)
    report.record(
        "bundle: declares the eddsa-jcs-2022 cryptosuite",
        manifest.get("cryptosuite") == CRYPTOSUITE,
        f"manifest says {manifest.get('cryptosuite')!r}",
    )

    # ADR-0012 Decision 1: the manifest's own key history, when it carries
    # one. `history` is None for every export written before this ADR, and
    # everything downstream that consults it is a no-op on None.
    history = parse_key_history(manifest)
    check_manifest_key_history(report, manifest, history)

    keys = collect_public_keys(export, history)
    report.record("keys: actor documents publish verification keys", bool(keys),
                  "no assertionMethod entries found in any actor document")

    # ADR-0012 Decision 1 made the manifest a signed document precisely so
    # that "the export's self-description stops being the one part of a bundle
    # anybody could edit freely" — but nothing here ever checked the
    # signature, only which key was named. So the whole self-description
    # (`afp:keyHistory`, `afp:members`, `afp:exportScope`, `afp:retentionDuty`,
    # `afp:anchors`) was editable at will and every bundle still passed.
    #
    # Verified against keys published by the ACTOR DOCUMENTS, never against
    # the manifest's own history: the history is inside the document being
    # verified, so resolving through it would let a forger insert the public
    # half of whatever key they signed their rewrite with. A method that only
    # the history knows about is therefore unauthenticatable here, and says so
    # rather than passing quietly.
    check_manifest_signature(report, manifest, collect_public_keys(export))

    roster_path = export / "roster.jsonld"
    if report.record("roster: present", roster_path.exists()):
        roster = load_json(roster_path)
        reason = verify_proof(roster, keys)
        # Gate check 9: the roster verifies as a whole from a cached copy.
        report.record("roster: signature verifies from the cached copy", reason is None, reason or "")

    authority = build_authority(export, history)

    all_activities: list[dict] = []
    seen_actors: set[str] = set()
    labeled_activities: list[tuple[str, dict]] = []
    chain_heads: dict[str, str] = {}

    for outbox_path in sorted((export / "outbox").glob("*.jsonld")):
        outbox = load_json(outbox_path)
        actor_url = outbox.get("attributedTo", outbox_path.stem)
        actor = outbox_path.stem
        seen_actors.add(actor_url)
        activities = outbox.get("orderedItems", [])
        all_activities.extend(activities)

        declared = outbox.get("totalItems")
        report.record(
            f"outbox: {actor} totalItems matches its contents",
            declared is None or declared == len(activities),
            f"declares {declared}, contains {len(activities)}",
        )

        for index, activity in enumerate(activities):
            if activity.get("type") == "afp:Redacted":
                continue  # a stub is a placeholder, not an activity — check_chain owns it
            label = f"{actor}[{index}] {activity.get('id', '<no id>')}"
            labeled_activities.append((label, activity))
            reason = verify_proof(activity, keys)
            report.record(f"signature: {label}", reason is None, reason or "")

            # Authentication is not authorization. Checked separately and on
            # purpose: the tail of a chain rests on its signature alone.
            check_authority(report, authority, label, activity)

            visibility = activity.get("afp:visibility")
            report.record(
                f"visibility: {label} declares a read class",
                isinstance(visibility, str),
                "" if isinstance(visibility, str) else
                "no afp:visibility — the record does not say who may read this",
            )

            check_attachments(report, export, activity)

        check_chain(report, actor, activities)
        head = chain_head_digest(activities)
        if head is not None:
            chain_heads[actor_url] = head

    # ADR-0012 Decision 1/2: interval-aware key resolution, over every
    # signature collected above — a no-op when this bundle carries no
    # afp:keyHistory (Compatibility).
    check_key_intervals(report, history, labeled_activities)

    # ADR-0012 Decision 4: the content inventory — a no-op when this
    # manifest carries no afp:members (Compatibility).
    check_members(report, export, manifest)

    # ADR-0012 Decision 3: the declared-duty obligations — a no-op when this
    # manifest carries no afp:retentionDuty (Compatibility).
    check_retention(report, export, manifest, all_activities, chain_heads)

    # Evidence in the bundle that no activity points at is unbound: it proves
    # nothing and cannot be checked, so it should not be travelling with the
    # record at all.
    referenced = {
        link.get("afp:digest")
        for activity in all_activities
        for link in (
            activity.get("object", {}).get("attachment", [])
            if isinstance(activity.get("object"), dict)
            else []
        )
        if isinstance(link, dict)
    }
    for path in sorted((export / "artifacts").glob("*")):
        digest = path.name.replace("-", ":", 1)
        report.record(
            f"artifact: {digest[:24]}… is referenced by an activity",
            digest in referenced,
            "" if digest in referenced else
            "present in the bundle but attached to nothing — unbound evidence",
        )

    # A per-actor chain cannot show that a whole participant is missing — and a
    # scoped export (ADR-0009 Decision 5) may *declare* an omission, which is
    # discretion; an undeclared gap remains what it always was.
    export_scope = manifest.get("afp:exportScope") or {}
    declared_omissions = set(export_scope.get("afp:omittedActors", []) or [])
    for agent in sorted(authority.rostered):
        if agent in declared_omissions:
            report.record(
                f"completeness: rostered agent {agent.split('/')[-1]} omitted by declared scope",
                True,
                "",
            )
            continue
        report.record(
            f"completeness: rostered agent {agent.split('/')[-1]} has an outbox",
            agent in seen_actors,
            "" if agent in seen_actors else
            f"{agent} is on the signed roster but contributes no outbox to this bundle",
        )

    received_activities: list[dict] = []
    received_path = export / "received.jsonld"
    if received_path.exists():
        for item in load_json(received_path).get("orderedItems", []):
            if isinstance(item, dict) and isinstance(item.get("afp:activity"), dict):
                received_activities.append(item["afp:activity"])

    # A federated thread's terminal outcome may live in the counterparty's
    # outbox; the receiving side holds those bytes verbatim (ADR-0009), so the
    # thread replay pools them. Chain, signature and completeness checks never
    # do — a foreign chain is its own domain's to answer for.
    thread_pool = all_activities + received_activities
    threads = thread and [thread] or sorted(
        {a["context"] for a in thread_pool if isinstance(a.get("context"), str)}
    )
    for name in threads:
        check_thread(report, thread_pool, name, own_actors=set(seen_actors))

    # ADR-0010 Decision 1: pin-equality and pins-precede-answers over the
    # thread pool — the same pool `check_thread` runs over, because a
    # delegated thread's opening Offer may be authored by the counterparty.
    check_pins(report, thread_pool)
    check_disclosed_answers_keep_their_pins(report, thread_pool)
    # ADR-0019 W5 V5: a proposal-pinned afp:actionPolicy names an action for
    # every option and for afp:no-decision. Exports with no proposal-pinned
    # policy (everything before this ADR) run none of this.
    check_proposal_action_policy(report, thread_pool)
    # ADR-0011 Decision 4: afp:priorThread resolves to a closed, unretracted
    # thread when present; an absent one is a lawfully scoped omission.
    check_prior_thread(report, thread_pool)

    # ADR-0005 Decision 2: who was entitled to issue each afp:Enroll. Exports
    # with no enrollment (all of P1) run none of this.
    check_enroll_authority(report, authority, all_activities)

    # ADR-0002 Decision 3 / 04 replay step 7. Exports with no DecisionRecord
    # (all of P1, and any P2 export without a closed vote) run none of this —
    # backward compatible by construction.
    # ADR-0016: which pool entries are received bytes — a counted vote that
    # resolves to one is signature-verified in phase two against its sender's
    # bundle, never against this domain's key table (ADR-0015 N2's grain).
    received_digests = {digest_of(a) for a in received_activities}
    for activity in all_activities:
        if afp_object(activity, "afp:DecisionRecord") is not None:
            check_decision_record(report, activity, all_activities, keys, pool=thread_pool, received=received_digests)

        if activity.get("type") == "afp:Archive":
            check_archive_state(report, activity)

        # ADR-0021 Decision 4 V8/V9/V10. Both are per domain: a compromise
        # claim rides on the claiming instance's own chain (so that bundle
        # publishes the actor document V8 resolves the operator against), and
        # a membership actuation is checked against the round it names, the
        # same way every other actuation has been since ADR-0006. A bundle
        # carrying neither — every export that has ever shipped — runs
        # neither.
        # Both resolve against `thread_pool`, not `all_activities`: the proof
        # a claim answers is announced by the HUB, and the DecisionRecord and
        # governance proposal an actuation names are signed by the hub too, so
        # in every real consortium they reach the claiming or actuating party
        # as received bytes rather than through its own outbox. Resolving them
        # against the domain's own chain alone would fail exactly the honest
        # cases. `_check_decision_actuation` already reads the same pool for
        # the same reason.
        check_key_compromise_claim(report, activity, thread_pool, authority)
        check_membership_actuation(report, activity, thread_pool)

    # ADR-0020 W3 V1/V6/V7: L1's vote and succession checks. Exports with no
    # afp:level: 1 round and no afp:successionRule/afp:supersedesRound
    # (everything before this ADR) run none of this. V2 is NOT here — a proof
    # convicts a foreign actor whose key this bundle need not publish, so it
    # runs in the replay-wide layer beside V8 (`check_equivocation_proofs`).
    check_vote_l1_fields(report, all_activities)
    # ADR-0022 Decision 2 / V1: co-authored Results state their split. Over the
    # thread pool, because a co-authored Result routinely arrives as received
    # bytes — co-work is what crosses a boundary. Exports with no multi-author
    # attributedTo (every bundle this repository has shipped, which is finding
    # 66 restated as a measurement) run none of this.
    for activity in thread_pool:
        check_contribution_split(report, activity)
    # ADR-0022 / finding 74: a bundle written under a retired type spelling
    # replays, and says so by name.
    check_retired_spellings(report, all_activities)
    # ADR-0022 Decision 1 / V2: the frame is a shape claim about the summary's
    # own bytes, so it answers per domain. V3/V4 need the pool and run in the
    # replay-wide layer. Exports with no afp:ContributionSummary — every bundle
    # written before this ADR — run none of this.
    for activity in all_activities:
        check_summary_frame(report, activity)
    for activity in all_activities:
        if afp_object(activity, "afp:Proposal") is not None:
            check_succession(report, activity, all_activities)
            # ADR-0021 Decision 2 V3/V5 — per domain, because a proposal
            # carries its own voter list and its own exclusions wherever it
            # sits. V4 needs the hub's Enroll trail and runs replay-wide.
            check_proposal_electorate(report, activity)

    # ADR-0018 W5 V7-V9 / W6: afp:Departure from a binding round. Exports
    # with none (everything before this ADR, and any round without
    # afp:binding: "joint") run none of this.
    for activity in all_activities:
        if afp_object(activity, "afp:Departure") is not None:
            check_departure(report, activity, all_activities)

    # ADR-0018 W5 V10-V14: the decision-subject afp:Settlement variant.
    # seen_rounds is shared across the whole export so V14 catches a second
    # settlement naming a round the first one already settled. Exports with
    # no decision settlement (everything before this ADR, and every
    # allocation-task Settlement) run none of this.
    decision_settlement_seen_rounds: dict[str, str] = {}
    for activity in all_activities:
        settlement = settlement_payload(activity)
        if settlement is not None and settlement.get("afp:decision") is not None:
            check_decision_settlement(
                report, activity, all_activities, thread_pool, decision_settlement_seen_rounds
            )

    # ADR-0003 Decision 7 / 03 "Bidding & allocation". Exports with no Award
    # (all of P1/P2) run none of this — backward compatible by construction.
    for activity in all_activities:
        if afp_object(activity, "afp:Award") is not None:
            # ADR-0003's award recomputation, over the **thread pool** rather
            # than this domain's own outbox. A federated auction's bidders are
            # in other domains by construction, so their commits and reveals
            # arrive as received bytes (ADR-0015 N2's grain, the same pool
            # `check_decision_record` reads for counted votes) — and reading
            # only the host's own activities made every cross-boundary award
            # unrecomputable: no producible winning bid, no recomputed
            # performer, no match. Found by the P7 demo, which is the first
            # workload to run an auction across a boundary at all.
            #
            # The fourth time this shape has appeared (ADR-0020's foreign
            # signing key, ADR-0021's foreign Enroll trail and cited proofs),
            # and ADR-0021 W3 wrote the rule after the third: a check whose
            # evidence is owned by a different party must read the pool.
            check_award(report, activity, thread_pool)

    # ADR-0004 Decision 1: an Announce{afp:Task} from an observer (or from an
    # actor the Enroll trail never admitted) is a role violation on the record.
    for activity in all_activities:
        if activity.get("type") == "Announce" and afp_object(activity, "afp:Task") is not None:
            check_announce_role(report, activity, all_activities)

    # ADR-0006 Decision 1: every action hash-binds to the Synthesis that
    # justified it, and did what the pinned policy said that answer permits.
    # ADR-0010 extends this: the pin's second root, the DecisionRecord hop,
    # and the Synthesis-level checks (synthesizer, leg partition, answer
    # sufficiency) — the last of which needs the thread pool.
    check_actions(report, all_activities, thread_pool)
    # ADR-0007: answer-level supersession — resolution, ratification parity,
    # and dispositions for actions whose justification was withdrawn.
    check_supersession(report, all_activities)

    # ADR-0008 Decision 1/4: every cross-boundary activity in this export
    # rides a co-signed afp:FederationAgreement, active with an admitting
    # grant, at its published instant. Single-export replay only — the
    # two-export replay against a counterparty's own export (29a/29b) is a
    # later ADR. Exports with no cross-boundary activity run none of this.
    check_federation(report, all_activities, authority)

    # ADR-0004 Decision 2: the asset registry replays from Update{afp:Asset};
    # (id, version) immutability, member-role registration, and reuse-reference
    # resolution. Exports with no assets and no reuse claims run none of this.
    check_assets(report, all_activities)

    return {
        "path": export,
        "instance_actor": authority.instance_actor,
        "activities": all_activities,
        # The keys this bundle publishes (own actor documents plus its own key
        # history). Carried out so the replay-wide layer can verify a proof
        # whose convicted actor lives in a different domain — see
        # `check_equivocation_proofs`.
        "keys": keys,
        # This bundle's own `afp:keyHistory` (None before ADR-0012). Carried
        # out for the same reason `keys` is: V14 compares a revocation cut
        # against a proof that routinely sits in somebody else's bundle.
        "history": history,
    }


def check_electorate(report: Report, bundles: list[dict | None]) -> None:
    """ADR-0021 Decision 2 / V4 — every member-role enrolled agent is either
    pinned into a round's `afp:voters` or declared in its `afp:excluded`.

    **Replay-wide and three-valued**, and the scoping is the whole subtlety.
    A hub's membership is the hub's fact: the Enroll trail lives on the host's
    chain and each member's own, so a peer's bundle holds the proposal it
    received and its own single Enroll and nothing else. Folding per domain
    fails every non-host bundle in the repository — measured, not predicted,
    while writing the ADR. So the trail is folded over the merged pool, and a
    replay that contains no trail for the hub at all records `unresolvable`
    rather than a failure.

    This is the same shape as ADR-0020's V2 (a proof convicting a foreign
    actor whose key lives in another bundle): a check whose evidence is owned
    by a different party belongs here, not in the per-domain loop.
    """
    present = [b for b in bundles if b is not None]
    pool: list[dict] = []
    for bundle in present:
        pool.extend(bundle["activities"])

    for bundle in present:
        domain = bundle["path"].name or str(bundle["path"])
        prefix = f"[{domain}] " if len(present) > 1 else ""
        for activity in bundle["activities"]:
            proposal = afp_object(activity, "afp:Proposal")
            if proposal is None:
                continue
            label = proposal.get("id", activity.get("id", "<no id>"))
            missing, overlapping, enrolled = electorate_partition(activity, pool)
            if not enrolled:
                # No Enroll trail for this hub anywhere in the replay — the
                # question cannot be answered here, and saying so is not the
                # same as saying yes (W0.5).
                report.record(
                    f"{prefix}electorate: {label} accounts for every enrolled member",
                    True,
                    "unresolvable: this replay carries no Enroll trail for the hub, so the "
                    "pinned electorate cannot be compared against it (ADR-0021)",
                )
                continue
            ok = not missing and not overlapping
            detail = ""
            if missing:
                detail = ("member-role agent(s) neither pinned nor declared in afp:excluded: "
                          + ", ".join(sorted(missing)))
            if overlapping:
                detail += ("; " if detail else "") + (
                    "agent(s) both pinned and excluded: " + ", ".join(sorted(overlapping)))
            report.record(
                f"{prefix}electorate: {label} accounts for every enrolled member",
                ok,
                "" if ok else detail + " (ADR-0021)",
            )


def _merged_pool(bundles: list[dict | None]) -> tuple[list[dict], list[dict]]:
    """`(present_bundles, every activity in them)` — the one merged pool every
    replay-wide check in this layer folds over.

    Factored out rather than repeated because the reason it exists is a rule,
    not a convenience: a check whose evidence is owned by a different party
    belongs at replay scope. A hub's Enroll trail, a foreign actor's signing
    key, a proof announced by the party that caught the equivocation — none of
    them is in the bundle that needs them, and every one of them is in the
    case file.
    """
    present = [b for b in bundles if b is not None]
    pool: list[dict] = []
    for bundle in present:
        pool.extend(bundle["activities"])
    return present, pool


def _received_activities(bundle: dict) -> list[dict]:
    """The activities a bundle holds as received bytes (ADR-0009), or `[]`.

    The same `received.jsonld` read `_bundle_votes_and_proofs` and
    `verify_export`'s `thread_pool` already do — factored out because a third
    caller wanted it and a fourth will.
    """
    received_path = bundle["path"] / "received.jsonld"
    if not received_path.exists():
        return []
    return [
        item["afp:activity"]
        for item in load_json(received_path).get("orderedItems", [])
        if isinstance(item, dict) and isinstance(item.get("afp:activity"), dict)
    ]


def check_recusal_causes(report: Report, bundles: list[dict | None]) -> None:
    """ADR-0021 Decision 3 / V6 — every `recused` exclusion's declared cause
    resolves on the record, against the agent it excludes.

    This is the security property of the whole decision, and it is the
    estimator wall's: the excluded set is recomputed from prior signed
    evidence rather than trusted, so a proposer can recuse the convicted and
    the accused and nobody else. A cause naming a proof that convicts a
    different agent, or a `governance-subject` form on a round that pins no
    subject, is a recusal by assertion — which is exactly the free, undeclared
    exclusion this ADR exists to end, wearing a declaration.

    Replay-wide and three-valued, for V4's reason and with V4's own condition
    for the third value: the evidence a cause resolves against — the hub's
    announced proofs, the hub's Enroll trail — lives on the hub's chain, and a
    member's bundle carries the proposal it received and nothing else. When
    the replay holds no trail for the hub at all it cannot distinguish a
    forged cause from a bundle that was never given the hub's half, so it says
    `unresolvable` and says it out loud (W0.5). When the trail *is* present, an
    absent proof digest fails by name: Decision 3's ruling, intact.
    """
    present, pool = _merged_pool(bundles)

    for bundle in present:
        domain = bundle["path"].name or str(bundle["path"])
        prefix = f"[{domain}] " if len(present) > 1 else ""
        for activity in bundle["activities"]:
            proposal = afp_object(activity, "afp:Proposal")
            if proposal is None:
                continue
            label = proposal.get("id", activity.get("id", "<no id>"))
            _missing, _overlapping, enrolled = electorate_partition(activity, pool)
            for entry in excluded_entries(proposal):
                if entry.get("afp:status") != "recused":
                    continue
                agent = entry.get("agent")
                if not isinstance(agent, str):
                    continue  # V5 (per domain, pure shape) already names this
                name = (
                    f"{prefix}recusal: {agent.split('/')[-1]} in {label} has a resolvable cause"
                )
                if not enrolled:
                    report.record(
                        name,
                        True,
                        "unresolvable: this replay carries no trail for the hub, so a declared "
                        "cause cannot be resolved against the record it cites (ADR-0021)",
                    )
                    continue
                cause = entry.get("afp:cause")
                ok = cause_resolves(cause, agent, proposal, pool)
                report.record(
                    name,
                    ok,
                    "" if ok else
                    f"afp:cause {cause!r} does not resolve: the cited proof is absent or "
                    f"convicts somebody else, or the round pins no afp:governanceSubject "
                    f"naming {agent} (ADR-0021)",
                )


def check_enroll_evidence(report: Report, bundles: list[dict | None]) -> None:
    """ADR-0021 Decision 5 / V11, V12 and V13 — what a citation is worth.

    03 has called the `afp:EquivocationProof` portable since v1 without giving
    it anywhere to go. An `afp:Enroll` may now carry one inline (the only
    available path: the bundle's `artifacts/` channel needs an
    `object.attachment[]` to bind to, and an Enroll's object is a bare agent
    URL). What the verifier does with it is recompute it, never trust it:

    - **V11** — the cited proof must satisfy every leg of `convicts`, and must
      convict the agent being enrolled. A citation against somebody else is
      not evidence about this enrollment.
    - **V12** — never fails, and that is the point. An enrollment at a new hub
      is precisely the case where the accused's own bundle is absent, so the
      convicting signature has no key to verify against. That outcome is
      recorded as `unresolvable` in the detail rather than passing silently
      (W0.5) — a reader who sees it knows to ask for the other bundle.
    - **V13** — `afp:priorProofs` is worth exactly one thing, and it is the
      enforceable one: nobody is obliged to volunteer their history, but a
      signed denial contradicted by a proof in the same case file is a
      finding. The empty list is a meaningful value, not an absence.

    Replay-wide for the reason ADR-0020 learned the hard way: a cited proof
    convicts a foreign actor whose key lives in a different bundle.

    And **own outbox plus received bytes**, for the reason Decision 5b is
    written about: the motivating case is an agent enrolling at a *new* hub
    while carrying a proof against itself, so the citation the hub host must
    weigh arrives in its `received.jsonld` and never appears in its own
    outbox. An Enroll is issued by the enrolling agent's own instance
    (ADR-0005 Decision 2), so a scan of own-outbox Enrolls only ever meets
    citations whose signing key that same bundle publishes — which would make
    V12's `unresolvable` a branch no honest bundle could reach, and a value
    nothing can take is not a third value (W0.8). The key table stays merged
    and is deliberately not widened: that is precisely what leaves a foreign
    signer unresolvable rather than absent-and-passing.
    """
    present, pool = _merged_pool(bundles)
    merged_keys: dict[str, bytes] = {}
    for bundle in present:
        merged_keys.update(bundle.get("keys") or {})
    for bundle in present:
        pool.extend(_received_activities(bundle))

    for bundle in present:
        domain = bundle["path"].name or str(bundle["path"])
        prefix = f"[{domain}] " if len(present) > 1 else ""
        seen: set[str] = set()
        for activity in bundle["activities"] + _received_activities(bundle):
            if activity.get("type") != "afp:Enroll":
                continue
            agent = activity.get("object")
            if not isinstance(agent, str):
                continue
            # One Enroll can sit in a bundle twice — its issuer's outbox and
            # the host's received record are the same bytes — and one finding
            # about it is a finding, two is noise.
            digest = digest_of(activity)
            if digest in seen:
                continue
            seen.add(digest)
            label = activity.get("id", "<no id>")

            evidence = activity.get("afp:evidence")
            entries = [e for e in evidence if isinstance(e, dict)] if isinstance(evidence, list) else []
            if entries:
                wrong: list[str] = []
                unresolvable: list[str] = []
                for entry in entries:
                    declared = entry.get("afp:digest")
                    carried = entry.get("afp:object")
                    if not isinstance(carried, dict):
                        wrong.append(f"{str(declared)[:24]}…: carries no inline afp:object")
                        continue
                    recomputed = digest_of(carried)
                    if recomputed != declared:
                        wrong.append(
                            f"{str(declared)[:24]}…: the inline proof hashes to "
                            f"{recomputed[:24]}…"
                        )
                        continue
                    votes = equivocation_proof_votes(carried)
                    if votes is None or not convicts(*votes):
                        wrong.append(f"{recomputed[:24]}…: does not convict")
                        continue
                    if votes[0].get("actor") != agent:
                        wrong.append(
                            f"{recomputed[:24]}…: convicts {votes[0].get('actor')!r}, not the "
                            f"enrolling agent"
                        )
                        continue
                    for vote in votes:
                        method = (vote.get("proof") or {}).get("verificationMethod")
                        if method not in merged_keys:
                            unresolvable.append(str(method))
                report.record(
                    f"{prefix}evidence: {label} cited proof convicts the enrolling agent",
                    not wrong,
                    "" if not wrong else "; ".join(wrong) + " (ADR-0021)",
                )
                # V12 never fails — it exists so the unresolvable case is
                # visible rather than swallowed into a passing check.
                report.record(
                    f"{prefix}evidence: {label} cited proof resolves to a key",
                    True,
                    "" if not unresolvable else
                    "unresolvable: this replay publishes no key for "
                    + ", ".join(sorted(set(unresolvable)))
                    + " — the convicting signature cannot be verified here, so ask for the "
                      "accused's own bundle (ADR-0021)",
                )

            prior = activity.get("afp:priorProofs")
            if isinstance(prior, list):
                declared_digests = {p for p in prior if isinstance(p, str)}
                contradicting = sorted(
                    digest_of(p)
                    for p in proofs_convicting(agent, pool)
                    if digest_of(p) not in declared_digests
                )
                report.record(
                    f"{prefix}evidence: {label} prior-proof declaration is not contradicted",
                    not contradicting,
                    "" if not contradicting else
                    f"{agent} declared afp:priorProofs omitting "
                    + ", ".join(d[:24] + "…" for d in contradicting)
                    + ", which this case file carries and which convict it (ADR-0021)",
                )


def check_revocation_not_erasing(report: Report, bundles: list[dict | None]) -> None:
    """ADR-0021 Decision 4d / V14 — a revocation cut may not predate a vote
    embedded in a proof against that key's actor.

    The seam ADR-0012 left open, running the other way from the one it named.
    Revocation *cuts*: `check_key_intervals` fails anything the key signed
    after the cut. So the convicted party publishes a key history revoking the
    method that signed its equivocating votes, dates the cut an hour earlier,
    and the two embedded votes now sit past it — ADR-0020's V2 requires both to
    verify, so the proof that convicted it fails replay. The sanctioned party
    rewrites the key history and the evidence against it evaporates.

    Nothing here stops a genuine revocation, and nothing stops anyone claiming
    the capture predated the equivocation: that claim is exactly what
    `afp:KeyCompromiseClaim` is for and what a governance round then weighs.
    What it stops is the claim being self-executing against somebody else's
    evidence. Say it in a claim, argue it in a round; do not write it into the
    key history and call the evidence invalid.

    Replay-wide, because the proof and the key history routinely sit in
    different bundles — which is the whole attack: the erasing history is
    published by the very party the proof is about. The pool includes received
    bytes for the same reason `check_enroll_evidence`'s does: the proof is
    announced by the hub that caught the equivocation, so at the convicted
    party — the one bundle certain to hold the erasing history — it arrives as
    received bytes and never through its own outbox.

    **Matched on the key, never on the actor**, and this is the whole
    correctness of the check. `afp:keyCustody: "instance"` is the default in
    this repository and what every shipped bundle uses: an agent's activities
    are signed by its *operating instance's* key, so the history entry's
    `afp:actor` is the instance while the embedded vote's `actor` is the
    agent, and the two never compare equal. An actor-equality match is
    therefore silent on precisely the custody every real bundle has — measured
    against the gate, not reasoned about. The rule ADR-0012's own interval
    resolution follows applies here too: interval questions are keyed on
    `verificationMethod` alone. So the relation this check needs is *this key
    signed that vote*, which is custody-correct in both directions — under
    self-custody the method is the agent's own key and nothing changes.
    """
    present, pool = _merged_pool(bundles)
    for bundle in present:
        pool.extend(_received_activities(bundle))

    # Every on-record proof's embedded votes, indexed by the key that actually
    # signed each one. `convicts` is recomputed rather than trusted: a bare
    # announcement typed afp:EquivocationProof must not be able to freeze an
    # honest party's revocation, so only a genuinely convicting pair protects
    # itself from erasure.
    votes_by_method: dict[str, set[str]] = {}
    for activity in pool:
        if proof_round(activity) is None:
            continue
        votes = equivocation_proof_votes(activity)
        if votes is None or not convicts(*votes):
            continue
        for vote in votes:
            method = (vote.get("proof") or {}).get("verificationMethod")
            if isinstance(method, str) and isinstance(vote.get("published"), str):
                votes_by_method.setdefault(method, set()).add(vote["published"])

    for bundle in present:
        domain = bundle["path"].name or str(bundle["path"])
        prefix = f"[{domain}] " if len(present) > 1 else ""
        for record in bundle.get("history") or []:
            if record.retired_by != "revocation" or record.valid_until is None:
                continue
            if not isinstance(record.key_id, str):
                continue
            early = sorted(
                published
                for published in votes_by_method.get(record.key_id, ())
                if instant_millis(published) > record.valid_until
            )
            report.record(
                f"{prefix}claim: {record.key_id} revocation does not predate a proof against it",
                not early,
                "" if not early else
                f"the revocation cut at epoch-ms {record.valid_until} precedes vote(s) published "
                + ", ".join(early)
                + f" that this key signed and that an on-record afp:EquivocationProof embeds "
                f"against {record.actor} — a revocation is not an eraser "
                f"(ADR-0021 Decision 4d)",
            )


def check_equivocation_proofs(report: Report, bundles: list[dict | None]) -> None:
    """ADR-0020 W3 V2, at replay scope rather than per domain.

    An `afp:EquivocationProof` convicts an actor who, in any real
    consortium, belongs to a *different* operator: Atlas publishes the proof,
    Meridian signed the votes. The convicted actor's verification key is
    published in Meridian's own actor document — that is, in Meridian's
    bundle — so verifying the two embedded votes against only the announcing
    bundle's key table fails every genuine cross-domain proof, which is every
    proof that matters. The keys of the whole replay are the right table, and
    they resolve exactly the way ADR-0009's received bytes do: against the
    domain that owns them.

    A single-bundle replay merges one bundle, which is the previous
    behaviour: a proof over a local actor still verifies, and a forged one
    still fails.

    The finding is attributed to the domain whose bundle holds the proof, so
    the `proof` family still appears in that domain's census line (finding
    48's rule) rather than in the joint row.
    """
    present = [b for b in bundles if b is not None]
    merged: dict[str, bytes] = {}
    for bundle in present:
        merged.update(bundle.get("keys") or {})
    for bundle in present:
        domain = bundle["path"].name or str(bundle["path"])
        prefix = f"[{domain}] " if len(present) > 1 else ""
        for activity in bundle["activities"]:
            if wrapped_payload(activity, "afp:EquivocationProof") is not None:
                check_equivocation_proof(report, activity, merged, prefix)


def _bundle_votes_and_proofs(bundle: dict) -> tuple[list[tuple[str, dict]], list[dict]]:
    """`([(domain, vote_activity), ...], [proof_activity, ...])` for one
    bundle — its own outbox plus its `received.jsonld` record, the same pool
    ADR-0009/0015 already read for the joint replay."""
    domain = bundle["path"].name or str(bundle["path"])
    votes: list[tuple[str, dict]] = []
    proofs: list[dict] = []
    for activity in bundle["activities"]:
        if afp_object(activity, "afp:Vote") is not None:
            votes.append((domain, activity))
        if proof_round(activity) is not None:
            proofs.append(activity)

    received_path = bundle["path"] / "received.jsonld"
    if received_path.exists():
        for item in load_json(received_path).get("orderedItems", []):
            act = item.get("afp:activity")
            if not isinstance(act, dict):
                continue
            if afp_object(act, "afp:Vote") is not None:
                votes.append((domain, act))
            if proof_round(act) is not None:
                proofs.append(act)
    return votes, proofs


def check_equivocation_scan(report: Report, bundles: list[dict | None]) -> None:
    """ADR-0020 Decision 5 / W3 V8 — the searchlight: pool every `afp:Vote`
    across every bundle (own outbox and received-bytes record alike), group
    by `(actor, round, phase, seqNo)`, and test Decision 2's predicate on
    each pair. A conviction pair with no on-record `afp:EquivocationProof` in
    any bundle for that round fails the joint replay by name, attributed to
    every domain whose bundle held one of the two votes — a concealed
    equivocation is exactly as detectable as a two-story agreement.

    A bundle carrying no `afp:Vote` at all (every export before this ADR)
    contributes nothing, and no report is ever recorded for it — the family
    still reads as `equivocation:0` in the census (finding 48's rule), via
    `Report.census`'s conditional-family default, not via a passing record
    here.
    """
    entries: list[tuple[str, dict]] = []
    proofs: list[dict] = []
    for bundle in bundles:
        # A bundle that never got past `bundle: MANIFEST.json present` has
        # already failed by name and carries no activities to scan — skipping
        # it keeps that one clean finding from becoming two.
        if bundle is None:
            continue
        bundle_votes, bundle_proofs = _bundle_votes_and_proofs(bundle)
        entries.extend(bundle_votes)
        proofs.extend(bundle_proofs)

    # Keyed by the *convicted voter*, not just the round: one announced proof
    # excuses that voter's pair, never every other pair in the same round — a
    # hub that announced one conviction would otherwise buy blanket
    # concealment for the rest of the round (Decision 5 fails a conviction
    # pair, not a round).
    announced: set[tuple[str, str]] = set()
    for proof_activity in proofs:
        announced_round = proof_round(proof_activity)
        proof_votes = equivocation_proof_votes(proof_activity)
        if announced_round is None or proof_votes is None:
            continue
        for vote in proof_votes:
            if isinstance(vote.get("actor"), str):
                announced.add((announced_round, vote["actor"]))

    # group (actor, round, phase, seqNo) -> {digest: {domains holding it}}
    groups: dict[tuple, dict[str, set[str]]] = {}
    by_digest: dict[str, dict] = {}
    for domain, activity in entries:
        tup = vote_tuple_of(activity)
        if tup is None:
            continue
        digest = digest_of(activity)
        by_digest[digest] = activity
        groups.setdefault(tup, {}).setdefault(digest, set()).add(domain)

    reported: set[tuple[str, str]] = set()
    for tup, digests_to_domains in groups.items():
        actor, round_id = tup[0], tup[1]
        if (round_id, actor) in announced or (round_id, actor) in reported:
            continue
        digests = list(digests_to_domains)
        convicted = False
        holders: set[str] = set()
        for i in range(len(digests)):
            for j in range(i + 1, len(digests)):
                if convicts(by_digest[digests[i]], by_digest[digests[j]]):
                    convicted = True
                    holders |= digests_to_domains[digests[i]] | digests_to_domains[digests[j]]
        if not convicted:
            continue
        reported.add((round_id, actor))
        for domain in sorted(holders):
            report.record(
                f"[{domain}] equivocation: unannounced conviction pair in round {round_id}",
                False,
                f"votes at {tup!r} convict, but no afp:EquivocationProof convicting {actor} in "
                f"this round is on record in any bundle (ADR-0020)",
            )


class PrefixedReport:
    """Domain-labelled findings (ADR-0009 Decision 2's corollary): in a joint
    replay every check names the export it ran against, so a hole is Bravo's
    or Alpha's, never "the record's"."""

    def __init__(self, report: Report, prefix: str):
        self._report = report
        self._prefix = prefix

    def record(self, name: str, ok: bool, detail: str = "") -> bool:
        return self._report.record(f"[{self._prefix}] {name}", ok, detail)


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify one AFP export bundle, or replay several jointly (ADR-0009).")
    parser.add_argument("exports", type=Path, nargs="+", help="export director(y|ies) — several run the federated joint replay")
    parser.add_argument("--thread", help="only replay this context (default: every thread found)")
    parser.add_argument("-v", "--verbose", action="store_true", help="show passing checks too")
    args = parser.parse_args()

    for export in args.exports:
        if not export.is_dir():
            print(f"no such export directory: {export}", file=sys.stderr)
            return 2

    report = Report()
    try:
        if len(args.exports) == 1:
            bundle = verify_export(args.exports[0], args.thread, report)
            # ADR-0020 Decision 5 / W3 V8: the searchlight runs over a single
            # bundle's own+received pool too — concealment does not require a
            # second export in the replay, only a second copy of a vote.
            check_equivocation_scan(report, [bundle])
            check_equivocation_proofs(report, [bundle])
            check_electorate(report, [bundle])
            check_summary_arithmetic(report, [bundle])
            check_summary_terminal(report, [bundle])
            check_disputes(report, [bundle])
            check_recusal_causes(report, [bundle])
            check_enroll_evidence(report, [bundle])
            check_revocation_not_erasing(report, [bundle])
        else:
            # ADR-0009 Decision 1: N single-export replays plus a cross-check —
            # never a forked verifier. Phase one runs today's replay per bundle,
            # domain-labelled; phase two runs the cross-checks that only make
            # sense over the set.
            bundles = []
            for export in args.exports:
                domain = export.name or str(export)
                bundles.append(verify_export(export, args.thread, PrefixedReport(report, domain)))  # type: ignore[arg-type]
            check_joint(report, bundles)
            check_equivocation_scan(report, bundles)
            # V2 runs here, not per domain: a proof convicts a foreign actor
            # whose key its own bundle never publishes (ADR-0020 Decision 1's
            # "verifies standalone" needs the whole case file's key table).
            check_equivocation_proofs(report, bundles)
            check_electorate(report, bundles)
            check_summary_arithmetic(report, bundles)
            check_summary_terminal(report, bundles)
            check_disputes(report, bundles)
            # ADR-0021 Decisions 3-5, all here for one reason: every fact they
            # rest on — the hub's proofs, the accused's signing key, the key
            # history of the party a proof is about — is owned by a domain
            # other than the one holding the activity being checked.
            check_recusal_causes(report, bundles)
            check_enroll_evidence(report, bundles)
            check_revocation_not_erasing(report, bundles)
    except Exception as exc:  # a malformed bundle is a failed audit, not a crash
        report.record("bundle: readable", False, f"{type(exc).__name__}: {exc}")

    report.print(args.verbose)
    report.census()
    failures = report.failures
    total = len(report.checks)

    print()
    if failures:
        print(f"FAILED — {len(failures)} of {total} checks did not pass")
        print("This record cannot be replayed as authentic.")
        return 1

    print(f"PASSED — {total} checks, no gaps")
    print("Every signature verifies, every chain is unbroken, every artifact matches its digest.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
