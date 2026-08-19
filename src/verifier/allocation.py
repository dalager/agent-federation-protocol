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

from decision import afp_object
from proof import digest_of


# ------------------------------------------------------------------ helpers


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
    members: set[str] = set()
    trail = [
        a
        for a in all_activities
        if a.get("type") in ("afp:Enroll", "afp:Unenroll") and a.get("target") == hub_actor
    ]
    for activity in sorted(trail, key=lambda a: a.get("published", "")):
        agent = activity.get("object")
        if not isinstance(agent, str):
            continue
        if activity.get("type") == "afp:Enroll":
            members.add(agent)
        else:
            members.discard(agent)
    return members


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

    announce = next(
        (
            obj
            for a in all_activities
            if (obj := afp_object(a, "afp:Task")) is not None
            and obj.get("id") == task_id
        ),
        None,
    )
    if not report.record(
        f"award: {label} has a matching afp:Announce{{afp:Task}}",
        announce is not None,
        "" if announce is not None else
        f"no afp:Announce{{afp:Task}} for afp:task {task_id!r} — bid window and "
        f"selection rule are unrecoverable",
    ):
        return

    bid_window = announce.get("afp:bidWindow", {}) or {}
    opens = _parse_time(bid_window.get("opens"))
    closes = _parse_time(bid_window.get("closes"))

    by_digest = {digest_of(a): a for a in all_activities}
    members = enrolled_members(hub_actor, all_activities)

    commits = [a for a in all_activities if a.get("type") == "afp:bidCommit" and a.get("object") == task_id]
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
        "afp:BidReveal with no matching afp:bidCommit by the same actor: "
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
        "afp:bidCommit published outside the announced [opens, closes) window: "
        + ", ".join(outside_window),
    )

    # Rebuild the admitted pool the writer's admission gate produced, from the
    # record alone: enrolled bidders, estimators out under `exclude`, and the
    # failed winners a reauction Award names (bound to the prior Award).
    estimators = set(announce.get("afp:estimators", []) or [])
    policy = announce.get("afp:estimatorPolicy")
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

    # 3 — selection recomputation over the reconstructed pool.
    rule = announce.get("afp:selectionRule", {}) or {}
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
