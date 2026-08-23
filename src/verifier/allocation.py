"""ADR-0003 Decision 7 — the `afp:Award` verifier extension.

Kept apart from `afp_verify.py` for the same reason `decision.py` is: an
auditor asking "what does the P3 auction extension actually check" should
not have to wade through the rest of the replay procedure to find it.

Per 03 "Bidding & allocation" and 04 "Synthesis": commit-reveal integrity,
recomputation of the announced selection rule over the revealed bids, the
synthesis binding for multi-performer awards, the announced answer-sufficiency
threshold, and the estimator/bidder separation policy. Everything here is
set-membership, digest comparison, or a pure-function rerun — no new
cryptography, no consensus protocol.

The bid pool a rule runs over is rebuilt from the record alone: reveals whose
digest matches their bidder's single in-window commitment, whose `afp:bidder`
is the signing actor, whose actor is enrolled per the export's Enroll/Unenroll
trail, minus announced estimators under the `exclude` policy, minus the failed
winners a reauction Award names (each of which must be a performer of the
prior Award it references). The writer applies exactly this filter at
admission; if the two disagree, that disagreement is the finding.

The selection rules ("ranking", "coverage") are deliberately reimplemented
here from their spec description in 03/ADR-0003, sharing no code with the
TypeScript instance.

Runs only when an export contains an `afp:Award`; an export with none (P1,
P2, or a P3 export before any award closes) runs none of this — backward
compatible by construction.
"""

from __future__ import annotations

import hashlib
from datetime import datetime

from decision import afp_object, enrolled_roles, instant_millis
from proof import digest_of
from reputation import REPUTATION_RULES


# ------------------------------------------------------------------ helpers


#: ADR-0017 Decision 5 renamed `afp:bidCommit` to `afp:BidCommit`, and shipped
#: with no read-side compatibility — so every bundle written before 2026-08-22
#: replayed as though its bid commitments did not exist, failing by
#: "reveal with no matching commitment" rather than by anything naming the real
#: cause. Measured on a 2026-08-19 export: ten failures, one rename.
#:
#: Kept as a **read-side alias only** (ADR-0022's amendment to ADR-0017,
#: finding 74): the writer emits the current spelling and nothing else, exactly
#: as draft-cavage became a read shim when RFC 9421 went native (ADR-0017
#: Decision 2). A record is supposed to outlive the vocabulary it was written
#: in; for `afp:ContributionSummary`, whose inputs are historical by
#: definition, a rename without an alias is an accounting error with a
#: signature on it.
RETIRED_TYPE_SPELLINGS = {"afp:bidCommit": "afp:BidCommit"}


def is_bid_commit(activity: dict) -> bool:
    """An `afp:BidCommit` under its current spelling or a retired one."""
    declared = activity.get("type")
    return declared == "afp:BidCommit" or RETIRED_TYPE_SPELLINGS.get(str(declared)) == "afp:BidCommit"


def check_retired_spellings(report, all_activities: list[dict]) -> None:
    """ADR-0022 / finding 74 — a bundle written under a retired type spelling
    still replays, and *says so by name*.

    The alias is what keeps the record readable; this check is what keeps the
    fact visible. Without it a pre-rename bundle passes silently and a reader
    has no way to know the vocabulary moved under it — which for an accounting
    roll-up over a historical period is the difference between a number and a
    number computed over a different set.

    Never a failure: the record is intact, and it was written in good faith
    under the spelling of its day.
    """
    for activity in all_activities:
        declared = str(activity.get("type"))
        current = RETIRED_TYPE_SPELLINGS.get(declared)
        if current is None:
            continue
        report.record(
            f"vocabulary: {activity.get('id', '<no id>')} uses the retired spelling {declared}",
            True,
            f"read as {current} (ADR-0017 Decision 5 renamed it; the alias is read-side only, "
            f"ADR-0022 finding 74) — the record is intact and its vocabulary is older than this verifier",
        )


def _parse_time(value: str | None) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def tie_break_digest(task_id: str, bidder_id: str) -> str:
    """The protocol-constant tie-break: hex sha256(taskId || '\\n' || bidderId)."""
    return hashlib.sha256(f"{task_id}\n{bidder_id}".encode("utf-8")).hexdigest()


def _parse_duration_seconds(value: str) -> float:
    """Seconds from the `PTnHnMnS` subset of ISO-8601; a decimal is allowed
    only on the seconds component. Unparseable -> +inf (mirrors the writer)."""
    if not isinstance(value, str) or not value.startswith("PT"):
        return float("inf")
    total = 0.0
    number = ""
    for char in value[2:]:
        if char.isdigit() or char == ".":
            number += char
            continue
        if char not in ("H", "M", "S") or not number:
            return float("inf")
        if char in ("H", "M") and "." in number:
            return float("inf")
        total += float(number) * {"H": 3600, "M": 60, "S": 1}[char]
        number = ""
    if number:  # trailing digits with no unit letter
        return float("inf")
    return total


def _payload_of(bid: dict) -> dict:
    return bid["payload"]


# ------------------------------------------------------------- selection rules
#
# Each rule is a pure function over the revealed bid list — entries are
# {"payload": <afp:Bid object>, "digest": <payload digest>, "bidder": actor} —
# returning (performers, synthesizer, winning_digests).


def select_ranking(task_id: str, params: dict, bids: list[dict]):
    """Highest score by the published linear weights; ties by lower tie-break
    digest. A zero/absent weight contributes exactly 0 even for an infinite
    field value (0 * inf is NaN, and NaN must never reach a sort key)."""
    weights = params.get("weights", {}) or {}

    def term(weight, value) -> float:
        return weight * value if weight else 0.0

    best = None
    best_key = None
    for bid in bids:
        payload = _payload_of(bid)
        score = (
            term(weights.get("capabilityMatch", 0), payload.get("afp:capabilityMatch", 0))
            + term(weights.get("cost", 0), (payload.get("afp:estimatedCost") or {}).get("value", 0))
            + term(
                weights.get("latencySeconds", 0),
                _parse_duration_seconds(payload.get("afp:estimatedLatency", "")),
            )
            # ADR-0004 Decision 3: the optional reputation weight — its term is
            # the pinned derivation's recomputed output for this bidder.
            + term(weights.get("reputation", 0), bid.get("reputation", 0))
        )
        key = (-score, tie_break_digest(task_id, bid["bidder"]))
        if best_key is None or key < best_key:
            best_key = key
            best = bid

    if best is None:
        return [], None, []
    return [best["bidder"]], None, [best["digest"]]


def select_coverage(task_id: str, params: dict, bids: list[dict]):
    """Minimal covering subset of the revealed *bids* over the announced
    domains at confidence >= minConfidence (integer percent, default 60; an
    undeclared domain counts as 0). Ties among equal-size covering subsets by
    the lexicographically smallest comma-joined sorted tie-break digest list.
    Synthesizer, only when >1 performer: most eligible domains, ties by the
    lower tie-break digest."""
    domains = params.get("domains", []) or []
    min_confidence = params.get("minConfidence", 60)
    if not domains:
        return [], None, []

    entries = []
    for bid in bids:
        coverage = _payload_of(bid).get("afp:coverage") or {}
        entries.append(
            {
                "bid": bid,
                "covers": [d for d in domains if coverage.get(d, 0) >= min_confidence],
                "key": tie_break_digest(task_id, bid["bidder"]),
            }
        )

    domain_set = set(domains)
    best_subset = None
    best_key = None
    for mask in range(1, 1 << len(entries)):
        subset = [entries[i] for i in range(len(entries)) if mask & (1 << i)]
        union = {d for e in subset for d in e["covers"]}
        if union != domain_set:
            continue
        key = (len(subset), ",".join(sorted(e["key"] for e in subset)))
        if best_key is None or key < best_key:
            best_key = key
            best_subset = subset

    if best_subset is None:
        return [], None, []

    ordered = sorted(best_subset, key=lambda e: e["key"])
    synthesizer = None
    if len(ordered) > 1:
        synthesizer = min(ordered, key=lambda e: (-len(e["covers"]), e["key"]))["bid"]["bidder"]
    return [e["bid"]["bidder"] for e in ordered], synthesizer, [e["bid"]["digest"] for e in ordered]


SELECTION_RULES = {
    "ranking": select_ranking,
    "coverage": select_coverage,
}


# --------------------------------------------------------- pool reconstruction


def enrolled_members(hub_actor: str, all_activities: list[dict]) -> set[str]:
    """The hub's membership, replayed from the Enroll/Unenroll trail."""
    return set(enrolled_roles(hub_actor, all_activities))


def check_announce_role(report, announce_activity: dict, all_activities: list[dict]) -> None:
    """ADR-0004 Decision 1 — an observer (or non-enrolled, non-hub actor) cannot
    announce; only the hub itself, a member, or a requester may. Replayed from
    the Enroll trail, exactly as membership is."""
    obj = afp_object(announce_activity, "afp:Task") or {}
    label = obj.get("id", "<no id>")
    actor = announce_activity.get("actor")
    hub_actor = obj.get("afp:hub")
    if actor == hub_actor:
        return  # the hub's own (re-)fan-out — always admitted
    roles = enrolled_roles(hub_actor, all_activities)
    role = roles.get(actor)
    ok = role in ("member", "requester")
    report.record(
        f"announce: {label} announced by an admissible role",
        ok,
        "" if ok else
        f"Announce{{afp:Task}} from {actor!r} whose role is {role!r} — only the hub, "
        f"a member, or a requester may announce (ADR-0004)",
    )


# ---------------------------------------------------------------- check_award


def check_award(report, award_activity: dict, all_activities: list[dict]) -> None:
    # An `afp:Award` activity carries its fields on the object payload; prefer
    # it over the outer wrapper (whose type also matches) so `afp:task`,
    # `afp:winningBids` and friends resolve.
    obj = award_activity.get("object")
    if isinstance(obj, dict) and obj.get("type") == "afp:Award":
        award = obj
    else:
        award = afp_object(award_activity, "afp:Award") or {}
    label = award.get("id", "<no id>")
    task_id = award.get("afp:task")
    hub_actor = award.get("afp:hub") or award_activity.get("actor")

    candidates = [
        a
        for a in all_activities
        if (obj := afp_object(a, "afp:Task")) is not None and obj.get("id") == task_id
    ]
    # A requester's inbound Announce and the hub's re-fan-out (ADR-0004) may
    # both name the task, and only the hub's own is governing — it carries the
    # window, the selection rule and the pinned settlement snapshot this whole
    # check then recomputes against. Falling back to "whichever Announce came
    # first" would hand all of that to whoever authored it (H8).
    hub_announces = [a for a in candidates if a.get("actor") == hub_actor]
    announce_activity = hub_announces[0] if hub_announces else None
    announce = afp_object(announce_activity, "afp:Task") if announce_activity else None
    if not report.record(
        f"award: {label} has a matching hub-authored afp:Announce{{afp:Task}}",
        announce is not None,
        "" if announce is not None else
        (f"afp:task {task_id!r} is announced by {sorted({str(a.get('actor')) for a in candidates})} "
         f"but not by the awarding hub {hub_actor!r} — the terms this award is checked "
         f"against would be the announcer's, not the hub's"
         if candidates else
         f"no afp:Announce{{afp:Task}} for afp:task {task_id!r} — bid window and "
         f"selection rule are unrecoverable"),
    ):
        return
    # Two governing announces are two sets of terms; a replay cannot say which
    # one the award answers.
    report.record(
        f"award: {label} has exactly one hub-authored announce",
        len(hub_announces) == 1,
        "" if len(hub_announces) == 1 else
        f"the hub announced afp:task {task_id!r} {len(hub_announces)} times — bid window, "
        f"selection rule and settlement snapshot are ambiguous",
    )

    bid_window = announce.get("afp:bidWindow", {}) or {}
    opens = _parse_time(bid_window.get("opens"))
    closes = _parse_time(bid_window.get("closes"))

    by_digest = {digest_of(a): a for a in all_activities}
    # ADR-0004 Decision 1: pool reconstruction excludes non-member-role reveals
    # — a requester or observer can never be an admitted bidder.
    roles = enrolled_roles(hub_actor, all_activities)
    members = {agent for agent, role in roles.items() if role == "member"}

    commits = [a for a in all_activities if is_bid_commit(a) and a.get("object") == task_id]
    reveals = [
        a
        for a in all_activities
        if a.get("type") == "afp:BidReveal"
        and isinstance(a.get("object"), dict)
        and a.get("object", {}).get("afp:task") == task_id
    ]

    # One sealed commitment per bidder: several differing in-window commits are
    # a free option (commit many bids, reveal the best after the close).
    multi_commit = sorted(
        actor
        for actor in {c.get("actor") for c in commits}
        if len({c.get("afp:commitment") for c in commits if c.get("actor") == actor}) > 1
    )
    report.record(
        f"award: {label} one commitment per bidder",
        not multi_commit,
        "" if not multi_commit else
        "bidder holds several differing commitments — a free option at reveal time: "
        + ", ".join(multi_commit),
    )

    # 2a — every reveal's payload digest matches a commit by the same actor.
    unmatched_reveals: list[str] = []
    bound_elsewhere: list[str] = []
    early_reveals: list[str] = []
    matched: list[dict] = []  # {"payload","digest","bidder","commit","reveal"}
    for reveal in reveals:
        payload = reveal.get("object", {})
        payload_digest = digest_of(payload)
        actor = reveal.get("actor")
        commit = next(
            (c for c in commits if c.get("actor") == actor and c.get("afp:commitment") == payload_digest),
            None,
        )
        if commit is None:
            unmatched_reveals.append(reveal.get("id", payload_digest[:24] + "…"))
            continue
        # The committed payload must name its signer: a payload bidding as
        # someone else would credit the bid — and possibly the award — to an
        # actor who never signed anything.
        if payload.get("afp:bidder") != actor:
            bound_elsewhere.append(f"{reveal.get('id')} (afp:bidder {payload.get('afp:bidder')!r})")
            continue
        # Sealing also fails from the other side: a reveal published while the
        # window was still open showed its hand to later bidders.
        published = _parse_time(reveal.get("published"))
        if closes is not None and (published is None or published < closes):
            early_reveals.append(reveal.get("id", payload_digest[:24] + "…"))
            continue
        matched.append(
            {"payload": payload, "digest": payload_digest, "bidder": actor, "commit": commit, "reveal": reveal}
        )

    report.record(
        f"award: {label} every reveal matches a prior commitment",
        not unmatched_reveals,
        "" if not unmatched_reveals else
        "afp:BidReveal with no matching afp:BidCommit by the same actor: "
        + ", ".join(unmatched_reveals),
    )
    report.record(
        f"award: {label} every revealed payload names its signing actor as bidder",
        not bound_elsewhere,
        "" if not bound_elsewhere else
        "afp:bidder differs from the reveal's actor: " + ", ".join(bound_elsewhere),
    )
    report.record(
        f"award: {label} reveals land after the bid window closes",
        not early_reveals,
        "" if not early_reveals else
        "afp:BidReveal published inside the sealed window: " + ", ".join(early_reveals),
    )

    # 2b — the matching commit's published time lies within [opens, closes).
    outside_window: list[str] = []
    in_window: list[dict] = []
    for entry in matched:
        published = _parse_time(entry["commit"].get("published"))
        if opens is not None and closes is not None and (published is None or not (opens <= published < closes)):
            outside_window.append(entry["commit"].get("id", entry["digest"][:24] + "…"))
        else:
            in_window.append(entry)
    report.record(
        f"award: {label} matching commitments land inside the bid window",
        not outside_window,
        "" if not outside_window else
        "afp:BidCommit published outside the announced [opens, closes) window: "
        + ", ".join(outside_window),
    )

    # Rebuild the admitted pool the writer's admission gate produced, from the
    # record alone: enrolled bidders, estimators out under `exclude`, and the
    # failed winners a reauction Award names (bound to the prior Award).
    estimators = set(announce.get("afp:estimators", []) or [])
    policy = announce.get("afp:estimatorPolicy")

    # ADR-0006 Decision 2: the estimator wall generalized. The announce may
    # exclude the performers of named prior tasks; the excluded set is rebuilt
    # from those tasks' Awards on the record, never taken on trust — and a
    # listed task with no resolvable Award is itself a failure, because an
    # exclusion you cannot reconstruct excludes nobody.
    prior_excluded: set[str] = set()
    for prior_task in announce.get("afp:excludePerformersOf", []) or []:
        prior_award = next(
            (
                o
                for a in all_activities
                if isinstance(o := a.get("object"), dict)
                and o.get("type") == "afp:Award"
                and o.get("afp:task") == prior_task
            ),
            None,
        )
        report.record(
            f"award: {label} prior-task exclusion {prior_task} resolves to an Award",
            prior_award is not None,
            "" if prior_award is not None else
            f"afp:excludePerformersOf names {prior_task!r}, which has no Award in the "
            f"record — an exclusion that cannot be reconstructed (ADR-0006)",
        )
        prior_excluded.update((prior_award or {}).get("afp:performers", []) or [])
    excluded = set(award.get("afp:excludedBidders", []) or [])
    prior_award_id = award.get("afp:priorAward")
    if excluded or prior_award_id:
        prior = next(
            (
                o
                for a in all_activities
                if isinstance(o := a.get("object"), dict)
                and o.get("type") == "afp:Award"
                and o.get("id") == prior_award_id
            ),
            None,
        )
        prior_performers = set((prior or {}).get("afp:performers", []) or [])
        unjustified = sorted(excluded - prior_performers)
        report.record(
            f"award: {label} excluded bidders are the prior award's failed performers",
            prior is not None and not unjustified,
            "" if prior is not None and not unjustified else
            (f"afp:priorAward {prior_award_id!r} is not a present afp:Award" if prior is None else
             "afp:excludedBidders names bidders the prior award never awarded: " + ", ".join(unjustified)),
        )

    pool = [
        {"payload": e["payload"], "digest": e["digest"], "bidder": e["bidder"]}
        for e in in_window
        if e["bidder"] in members
        and e["bidder"] not in excluded
        and not (policy == "exclude" and e["bidder"] in estimators)
        and e["bidder"] not in prior_excluded
    ]
    pool_digests = {b["digest"] for b in pool}

    # 2c — every winning bid digest resolves to a bid in the admitted pool.
    winning_bids = award.get("afp:winningBids", []) or []
    unresolvable_winners = [d for d in winning_bids if d not in pool_digests]
    report.record(
        f"award: {label} winning bids are all producible",
        not unresolvable_winners,
        "" if not unresolvable_winners else
        "afp:winningBids names a digest with no admitted afp:BidReveal to back it: "
        + ", ".join(d[:24] + "…" for d in unresolvable_winners),
    )

    # 3 — reputation (ADR-0004 Decision 3): when the announce pins a rule,
    # resolve the pinned snapshot, check it exhaustive, recompute the
    # derivation, and feed it into selection recomputation. When it pins none,
    # a reputation weight in the selection rule is a live number nothing pinned.
    rule = announce.get("afp:selectionRule", {}) or {}
    rep_rule = announce.get("afp:reputationRule")
    weights = (rule.get("params", {}) or {}).get("weights", {}) or {}
    if rep_rule is None:
        report.record(
            f"award: {label} reputation is consumed only when pinned",
            not weights.get("reputation"),
            "" if not weights.get("reputation") else
            "selection weights include 'reputation' but the announce pins no "
            "afp:reputationRule — a live number inside a recomputable Award (ADR-0004)",
        )
    else:
        snapshot = announce.get("afp:settlementSnapshot")
        if not report.record(
            f"award: {label} reputation rule travels with its settlement snapshot",
            isinstance(snapshot, list),
            "afp:reputationRule without afp:settlementSnapshot — no snapshot, no "
            "reputation input (ADR-0004)",
        ):
            snapshot = []
        rep_name = (rep_rule or {}).get("name")
        rep_fn = REPUTATION_RULES.get(rep_name)
        report.record(
            f"award: {label} reputation rule {rep_name!r} is known",
            rep_fn is not None,
            "" if rep_fn is not None else
            f"no verifier implementation for reputation rule {rep_name!r} — an unknown "
            f"derivation name is a verification failure, not a skip",
        )

        # Every pinned digest must resolve to a present afp:Settlement.
        resolved: list[dict] = []
        missing_settlements: list[str] = []
        for digest in snapshot:
            activity = by_digest.get(digest)
            # Like the Award, an afp:Settlement's outer type matches too —
            # prefer the object payload, where afp:settles lives.
            settlement = None
            if isinstance(activity, dict):
                obj = activity.get("object")
                if isinstance(obj, dict) and obj.get("type") == "afp:Settlement":
                    settlement = obj
                else:
                    settlement = afp_object(activity, "afp:Settlement")
            if settlement is None:
                missing_settlements.append(str(digest))
            else:
                resolved.append({"object": settlement, "published": activity.get("published", ""), "digest": digest})
        report.record(
            f"award: {label} pinned settlement snapshot resolves",
            not missing_settlements,
            "" if not missing_settlements else
            "afp:settlementSnapshot names a digest with no present afp:Settlement: "
            + ", ".join(d[:24] + "…" for d in missing_settlements),
        )

        # Exhaustive, not curated: every settlement of this hub published
        # before the announce must be in the snapshot — cherry-picking away a
        # bidder's bad history is checkable against the hub's own outbox.
        # Compare instants, not strings: a hub picks its own settlement's
        # `published` representation, and a numeric UTC offset string-sorts
        # before 'Z' regardless of chronology — so a string `<` here lets a
        # hub dodge the comparison and omit an unflattering settlement.
        announce_published = instant_millis(announce_activity.get("published")) if announce_activity else 0
        snapshot_set = set(snapshot)
        omitted = sorted(
            digest_of(a)[:24] + "…"
            for a in all_activities
            if afp_object(a, "afp:Settlement") is not None
            and a.get("actor") == hub_actor
            and instant_millis(a.get("published")) < announce_published
            and digest_of(a) not in snapshot_set
        )
        report.record(
            f"award: {label} settlement snapshot is exhaustive",
            not omitted,
            "" if not omitted else
            "afp:settlementSnapshot omits settlement(s) this hub published before the "
            "announce (curated, not exhaustive): " + ", ".join(omitted),
        )

        if rep_fn is not None:
            for entry in pool:
                entry["reputation"] = rep_fn((rep_rule or {}).get("params", {}) or {}, resolved, entry["bidder"])

    rule_name = rule.get("name")
    rule_fn = SELECTION_RULES.get(rule_name)
    performers = award.get("afp:performers", []) or []
    if rule_fn is None:
        report.record(
            f"award: {label} selection rule {rule_name!r} is known",
            False,
            f"no verifier implementation for selection rule {rule_name!r}",
        )
    else:
        r_performers, r_synthesizer, r_winning = rule_fn(task_id, rule.get("params", {}) or {}, pool)
        declared_synthesizer = award.get("afp:synthesizer")
        performers_match = r_performers == performers
        synthesizer_match = (r_synthesizer or None) == (declared_synthesizer or None)
        winning_match = r_winning == winning_bids
        report.record(
            f"award: {label} recomputed performers match the declared award",
            performers_match,
            "" if performers_match else
            f"recomputed {r_performers!r} but afp:Award declares {performers!r}",
        )
        report.record(
            f"award: {label} recomputed synthesizer matches the declared award",
            synthesizer_match,
            "" if synthesizer_match else
            f"recomputed {r_synthesizer!r} but afp:Award declares {declared_synthesizer!r}",
        )
        # ADR-0010 Decision 2 — precedence between a pinned afp:synthesizer
        # (on the Announce) and the rule's derived one. Absent is not unequal:
        # this only fires when both are present, and only when a rule derived
        # one at all — a ranking rule derives none, and the pin then governs
        # alone with nothing to disagree with.
        pinned_synthesizer = announce.get("afp:synthesizer")
        if isinstance(pinned_synthesizer, str) and r_synthesizer is not None:
            synthesizer_agrees = pinned_synthesizer == r_synthesizer
            report.record(
                f"award: {label} pinned synthesizer agrees with the recomputed one",
                synthesizer_agrees,
                "" if synthesizer_agrees else
                f"afp:synthesizer pins {pinned_synthesizer!r} but the selection rule "
                f"derives {r_synthesizer!r} — the derived value governs (ADR-0010)",
            )
        # Producible is not enough: the declared evidence set must be exactly
        # the winning bids the rule picked, or the award cites someone else's.
        report.record(
            f"award: {label} afp:winningBids are the recomputed winners' bids",
            winning_match,
            "" if winning_match else
            f"recomputed winning digests {[d[:24] + '…' for d in r_winning]!r} but afp:Award "
            f"declares {[str(d)[:24] + '…' for d in winning_bids]!r}",
        )

        # Answer sufficiency (03: "state it in the announce, not after") —
        # checkable at replay per ADR-0003 Decision 3.
        sufficiency = announce.get("afp:answerSufficiency", {}) or {}
        required_count = sufficiency.get("count")
        if isinstance(required_count, (int, float)):
            report.record(
                f"award: {label} meets the announced answer-sufficiency count",
                len(performers) >= required_count,
                "" if len(performers) >= required_count else
                f"award names {len(performers)} performer(s), announce requires {required_count}",
            )
        required_domains = sufficiency.get("coverage")
        if isinstance(required_domains, list) and required_domains:
            min_confidence = (rule.get("params", {}) or {}).get("minConfidence", 60)
            winners = [b for b in pool if b["digest"] in set(winning_bids)]
            covered = {
                d
                for b in winners
                for d in required_domains
                if (_payload_of(b).get("afp:coverage") or {}).get(d, 0) >= min_confidence
            }
            gaps = [d for d in required_domains if d not in covered]
            report.record(
                f"award: {label} meets the announced answer-sufficiency coverage",
                not gaps,
                "" if not gaps else "awarded coverage misses domain(s): " + ", ".join(gaps),
            )

    # 4 — synthesis binding, only when more than one performer.
    if len(performers) > 1:
        synthesis = next(
            (
                obj
                for a in all_activities
                if (obj := afp_object(a, "afp:Synthesis")) is not None
                and obj.get("afp:award") == award.get("id")
            ),
            None,
        )
        if report.record(
            f"award: {label} has a matching afp:Synthesis",
            synthesis is not None,
            "" if synthesis is not None else
            f"award names {len(performers)} performers but no Create{{afp:Synthesis}} "
            f"references afp:award {award.get('id')!r}",
        ):
            contributing = synthesis.get("afp:contributingResults", []) or []
            missing_results = [
                d
                for d in contributing
                if d not in by_digest or afp_object(by_digest[d], "afp:Result") is None
            ]
            report.record(
                f"award: {label} synthesis' contributing results are all present",
                not missing_results,
                "" if not missing_results else
                "afp:contributingResults names a digest with no present Create{afp:Result} "
                "activity: " + ", ".join(d[:24] + "…" for d in missing_results),
            )
            method = synthesis.get("afp:method")
            method_ok = isinstance(method, str) and bool(method)
            report.record(
                f"award: {label} synthesis declares a non-empty afp:method",
                method_ok,
                "" if method_ok else f"afp:method is {method!r}",
            )
            dissent_ok = "afp:dissent" in synthesis and isinstance(synthesis.get("afp:dissent"), list)
            report.record(
                f"award: {label} synthesis carries an afp:dissent list",
                dissent_ok,
                "" if dissent_ok else "afp:dissent is missing or not a list",
            )

    # 5b — prior-performer separation (ADR-0006), whenever an exclusion is pinned.
    if announce.get("afp:excludePerformersOf"):
        offending_prior = [p for p in performers if p in prior_excluded]
        report.record(
            f"award: {label} respects prior-performer separation",
            not offending_prior,
            "" if not offending_prior else
            "afp:excludePerformersOf is pinned but the award names a performer of an "
            "excluded prior task: " + ", ".join(offending_prior),
        )

    # 5 — estimator separation, only under "exclude" policy.
    if policy == "exclude":
        offending = [p for p in performers if p in estimators]
        report.record(
            f"award: {label} respects estimator/bidder separation",
            not offending,
            "" if not offending else
            "afp:estimatorPolicy is 'exclude' but the award names a performer who "
            "estimated this task: " + ", ".join(offending),
        )
