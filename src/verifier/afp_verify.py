#!/usr/bin/env python3
"""afp-verify — replay an AFP export and say whether it holds up.

Run by someone who was not there: this reads nothing but the export directory
and needs no access to the instance that produced it, no private keys, and no
network. It is a deliberately independent second implementation of the record
format (ADR-0001) — if it disagrees with the writer, that disagreement is the
finding rather than a nuisance.

    python3 afp_verify.py <export-dir> [--thread urn:afp:thread:...] [-v]

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

from allocation import check_announce_role, check_award
from asset import check_assets
from action import check_actions, check_supersession
from decision import afp_object, check_decision_record, check_enroll_authority, instant_millis
from federation import check_federation, check_joint
from keys import (
    check_key_intervals,
    check_manifest_key_history,
    history_keys,
    parse_key_history,
)
from pins import check_disclosed_answers_keep_their_pins, check_pins, check_prior_thread
from proof import CRYPTOSUITE, decode_multikey, digest_of, verify_proof


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


def check_thread(report: Report, activities: list[dict], thread: str) -> None:
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
    if tasks:
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
        check_thread(report, thread_pool, name)

    # ADR-0010 Decision 1: pin-equality and pins-precede-answers over the
    # thread pool — the same pool `check_thread` runs over, because a
    # delegated thread's opening Offer may be authored by the counterparty.
    check_pins(report, thread_pool)
    check_disclosed_answers_keep_their_pins(report, thread_pool)
    # ADR-0011 Decision 4: afp:priorThread resolves to a closed, unretracted
    # thread when present; an absent one is a lawfully scoped omission.
    check_prior_thread(report, thread_pool)

    # ADR-0005 Decision 2: who was entitled to issue each afp:Enroll. Exports
    # with no enrollment (all of P1) run none of this.
    check_enroll_authority(report, authority, all_activities)

    # ADR-0002 Decision 3 / 04 replay step 7. Exports with no DecisionRecord
    # (all of P1, and any P2 export without a closed vote) run none of this —
    # backward compatible by construction.
    for activity in all_activities:
        if afp_object(activity, "afp:DecisionRecord") is not None:
            check_decision_record(report, activity, all_activities, keys)

    # ADR-0003 Decision 7 / 03 "Bidding & allocation". Exports with no Award
    # (all of P1/P2) run none of this — backward compatible by construction.
    for activity in all_activities:
        if afp_object(activity, "afp:Award") is not None:
            check_award(report, activity, all_activities)

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

    return {"path": export, "instance_actor": authority.instance_actor, "activities": all_activities}


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
            verify_export(args.exports[0], args.thread, report)
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
    except Exception as exc:  # a malformed bundle is a failed audit, not a crash
        report.record("bundle: readable", False, f"{type(exc).__name__}: {exc}")

    report.print(args.verbose)
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
