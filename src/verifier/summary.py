"""ADR-0022 Decisions 1 and 3 — the contribution summary, recomputed.

Kept apart from `decision.py` for the reason `electorate.py` and
`equivocation.py` are: these are the parity twins of TypeScript
`src/instance/src/hub/summary.ts`, mirrored from the ADR's own algorithm rather
than from the TypeScript internals, and an auditor comparing the two
implementations should find the pair self-contained in one file.

The defect this closes is campaign 10's through-line: **a sum is only as
recomputable as its input set is agreed, and the protocol did not name sets.**
Every mechanism before P7 answers a question about an event you can point at.
`afp:ContributionSummary` was the first object whose subject is a *boundary*,
and it shipped with a period selected on self-asserted clocks, an input scope
that four honest members resolve four different ways, and an `afp:inputHash`
whose preimage no document ever defined — a digest that reads exactly like a
check and is not one.

**Compatibility (binding).** Every function here fires only on an
`afp:ContributionSummary`, and no bundle written before this ADR carries one,
so nothing below can fail a pre-ADR export.
"""

from __future__ import annotations

from decision import afp_object, instant_millis, settlement_payload
from proof import digest_of

#: 04 § Disputes' own split, as a closed registry. Two grounds are mechanical
#: — re-checkable by anyone recomputing over the same inputs — and the third is
#: a judgement no arithmetic settles, which is why it escalates to a round.
DISPUTE_GROUNDS = ("omitted-input", "included-input", "quality")
MECHANICAL_GROUNDS = ("omitted-input", "included-input")

#: Closed registries (ADR-0022 W0.4). An unrecognised form fails; it never falls
#: through to a default, because a frame nobody can resolve is precisely the
#: unfalsifiable claim Decision 1 exists to remove.
PERIOD_FORMS = ("hub-observed",)
SPLIT_FORMS = ("declared-shares",)
VISIBILITY_CLASSES = ("public", "hub", "parties", "internal")


def summary_object(activity: dict) -> dict | None:
    """The `afp:ContributionSummary` payload of a `Create`, or `None`."""
    return afp_object(activity, "afp:ContributionSummary")


def frame_of(summary: dict) -> dict | None:
    """`afp:frame`, or `None` when the summary declares none — which is itself
    the finding, not a shape to work around."""
    frame = summary.get("afp:frame")
    return frame if isinstance(frame, dict) else None


def frame_is_known(frame: dict) -> list[str]:
    """Every reason this frame cannot be resolved, or `[]`.

    Returned as a list rather than a bool because a frame with three problems
    should say three things: a reader fixing one at a time otherwise gets a new
    failure each run, which is the worst possible way to learn a schema.
    """
    problems: list[str] = []

    period = frame.get("afp:periodRule")
    if not isinstance(period, dict):
        problems.append("afp:periodRule is absent")
    elif period.get("afp:form") not in PERIOD_FORMS:
        problems.append(f"unknown afp:periodRule form {period.get('afp:form')!r}")
    else:
        for field in ("afp:hub", "afp:from", "afp:to"):
            if not isinstance(period.get(field), str):
                problems.append(f"afp:periodRule is missing {field}")

    scope = frame.get("afp:inputScope")
    if not isinstance(scope, dict):
        problems.append("afp:inputScope is absent — a summary that does not say what it could read is not recomputable")
    else:
        classes = scope.get("afp:visibility")
        if not isinstance(classes, list) or not classes:
            problems.append("afp:inputScope declares no afp:visibility classes")
        else:
            unknown = [c for c in classes if c not in VISIBILITY_CLASSES]
            if unknown:
                problems.append("unknown visibility class(es): " + ", ".join(map(str, unknown)))

    split = frame.get("afp:splitRule")
    if not isinstance(split, dict) or split.get("afp:form") not in SPLIT_FORMS:
        problems.append(f"unknown afp:splitRule form {(split or {}).get('afp:form')!r}")

    if not isinstance(frame.get("afp:vocabulary"), str):
        problems.append("afp:vocabulary is absent — a roll-up over historical inputs must say which vocabulary read them")

    return problems


def hub_chain_slice(pool: list[dict], hub: str, start: str, end: str) -> list[dict] | None:
    """The hub's own activities in `(start, end]`, in chain order — or `None`
    when the interval does not resolve in this pool.

    Walked backwards from `end` along `afp:prevActivity`, never sorted by
    `published`: the chain is the hub's own assertion of order, and relying on
    it rather than on wall-clock is the whole of Decision 1's period rule.

    `None` and `[]` are different answers and the caller must keep them apart —
    an unresolvable interval that read as an empty period would sum nothing and
    pass, which is the vacuous shape this repository fails checks for.
    """
    by_digest = {digest_of(a): a for a in pool if a.get("actor") == hub}
    cursor = by_digest.get(end)
    if cursor is None:
        return None
    walked: list[dict] = []
    while cursor is not None:
        if digest_of(cursor) == start:
            return list(reversed(walked))
        walked.append(cursor)
        prev = cursor.get("afp:prevActivity")
        cursor = by_digest.get(prev) if isinstance(prev, str) else None
    return list(reversed(walked)) if start == "" else None


def credit_of(result: dict) -> list[tuple[str, int, int]]:
    """`[(agent, share, denominator)]` for one Result — ADR-0022 Decision 2's
    arithmetic applied. A single-author Result is the whole of itself."""
    attributed = result.get("attributedTo")
    split = result.get("afp:contributionSplit")
    if isinstance(attributed, list) and len(attributed) > 1 and isinstance(split, dict):
        denominator = sum(v for v in split.values() if isinstance(v, int) and not isinstance(v, bool))
        if denominator <= 0:
            return []
        return [(a, s, denominator) for a, s in sorted(split.items()) if isinstance(s, int)]
    if isinstance(attributed, str):
        return [(attributed, 1, 1)]
    if isinstance(attributed, list) and attributed and isinstance(attributed[0], str):
        return [(attributed[0], 1, 1)]
    return []


def _lcm(values: list[int]) -> int:
    from math import gcd

    lcm = 1
    for value in sorted(values):
        if value <= 0:
            return 0
        lcm = lcm // gcd(lcm, value) * value
    return lcm


def recompute(pool: list[dict], frame: dict, hub_actor: str) -> dict | None:
    """Decision 1 and 3's arithmetic: `{denominator, credited, unreadable,
    inputs}` for the period the frame declares, or `None` when the interval does
    not resolve here.

    The join is protocol-level and reads no naming convention: the chain slice
    gives the settlements the hub sequenced, each settlement names its task, the
    task's own `Announce` gives the thread, and the Results on that thread are
    the work. A deployment that numbers its correlation ids differently
    recomputes identically.
    """
    # Deduplicated by digest before anything is counted. Not defensive tidying:
    # a joint replay's merged pool legitimately holds the same Result twice —
    # the author's own copy and the verbatim copy a counterparty received across
    # the boundary (ADR-0009) — and summing the pool as given credits that work
    # twice, a wrong number arrived at from an entirely correct record.
    pool = list({digest_of(a): a for a in pool}.values())

    period = frame["afp:periodRule"]
    slice_ = hub_chain_slice(pool, period["afp:hub"], period["afp:from"], period["afp:to"])
    if slice_ is None:
        return None

    scope = set(frame["afp:inputScope"]["afp:visibility"])
    announces: dict[str, dict] = {}
    for activity in pool:
        task = afp_object(activity, "afp:Task")
        if task is not None and isinstance(task.get("id"), str):
            announces[task["id"]] = activity

    # ADR-0022 Decision 4: the operator mapping is folded from the Enroll trail
    # **as of the period's close**, and an `afp:Unenroll` does not clear it.
    # Two rules, both learned in the build. The operator is the `actor` of the
    # agent's own Enroll (ADR-0005 Decision 2 binds it there, which is what
    # makes this readable at all); and leaving a hub ends a seat, it does not
    # retroactively change who did the work. `enrolled_instances` is the wrong
    # fold here for exactly that reason — it answers "who operates this member
    # now", and resolving as of now would let an agent that leaves after a
    # quarter re-bucket its own past credit, the defect ADR-0021 Decision 1
    # closed for weights arriving one layer up.
    closes_at = instant_millis(slice_[-1].get("published")) if slice_ else 2**62
    operators: dict[str, str] = {}
    seen: dict[str, int] = {}
    for activity in pool:
        if activity.get("type") != "afp:Enroll":
            continue
        if activity.get("afp:hub") != hub_actor and activity.get("target") != hub_actor:
            continue
        agent = activity.get("object")
        at = instant_millis(activity.get("published"))
        if not isinstance(agent, str) or at > closes_at:
            continue
        if agent in seen and seen[agent] > at:
            continue
        seen[agent] = at
        operators[agent] = str(activity.get("actor", ""))

    def operator_of(agent: str) -> str:
        return operators.get(agent, agent)

    rows: list[tuple[str, int, int]] = []
    unreadable: dict[str, int] = {}
    qualified: dict[str, int] = {}
    inputs: set[str] = set()

    for activity in slice_:
        # `settlement_payload`, not `afp_object`: an `afp:Settlement` travels as a
        # BARE afp-typed activity carrying its payload in `object`, so
        # `afp_object` matches the envelope on its first branch and hands back
        # an activity with no `afp:task` on it. The two implementations
        # disagreed here on the first run, which is the entire reason they are
        # written from the ADR rather than from each other.
        settlement = settlement_payload(activity)
        if settlement is None:
            continue
        inputs.add(digest_of(activity))
        announce = announces.get(str(settlement.get("afp:task", "")))
        thread = announce.get("context") if isinstance(announce, dict) else None
        results = [
            a
            for a in pool
            if thread is not None
            and a.get("context") == thread
            and afp_object(a, "afp:Result") is not None
            and a.get("afp:visibility") in scope
        ]
        if not results:
            # The hub sequenced a settlement, so the work happened; this
            # computer cannot read the Result that says who did it. Counted,
            # never estimated, never silently skipped (W0.2) — attributed
            # through the settlement's own entries, which the hub published and
            # every member can read.
            settles = settlement.get("afp:settles")
            actors = (
                [str(e.get("actor")) for e in settles if isinstance(e, dict) and isinstance(e.get("actor"), str)]
                if isinstance(settles, list)
                else []
            )
            for operator in sorted({operator_of(a) for a in (actors or ["unattributed"])}):
                unreadable[operator] = unreadable.get(operator, 0) + 1
            continue
        # Decision 4: does the record say this answer did not hold? A
        # supersession on the task's own thread (ADR-0007) is the only marker
        # the protocol has — a bare Result re-opened later has none, which is
        # finding 71's sharp edge and why the rule is "credit is fixed at
        # acceptance", not "credit is provisional".
        superseded = any(
            a.get("context") == thread
            and isinstance(a.get("object"), dict)
            and isinstance(a["object"].get("afp:supersedes"), str)
            for a in pool
        )
        for result in results:
            inputs.add(digest_of(result))
            credits = credit_of(afp_object(result, "afp:Result") or {})
            rows.extend(credits)
            if superseded:
                for operator in sorted({operator_of(agent) for agent, _, _ in credits}):
                    qualified[operator] = qualified.get(operator, 0) + 1

    denominator = _lcm([row[2] for row in rows]) if rows else 1
    credited: dict[str, int] = {}
    for agent, share, own in rows:
        operator = operator_of(agent)
        credited[operator] = credited.get(operator, 0) + share * denominator // own

    # Decision 4: the membership acts this period brackets. The hub does not
    # sequence enrollment — an Enroll rides its own instance's chain — so the
    # bracket is the `published` of the slice's own endpoints, which are the
    # hub's own assertions and carry exactly the authority the period rule
    # already relies on. Nothing is *selected* by wall-clock; this labels a
    # window the chain already fixed.
    membership_acts = {"afp:Enroll", "afp:Unenroll", "afp:MemberExpel", "afp:MemberAdmit"}
    opens = str(slice_[0].get("published", "")) if slice_ else ""
    closes = str(slice_[-1].get("published", "")) if slice_ else ""
    membership: list[dict] = []
    for activity in pool:
        declared = activity.get("type")
        types = [str(t) for t in declared] if isinstance(declared, list) else [str(declared)]
        act = next((t for t in types if t in membership_acts), None)
        if act is None or not opens:
            continue
        at = str(activity.get("published", ""))
        if opens <= at <= closes:
            membership.append({"agent": str(activity.get("object", "")), "afp:act": act})
    membership.sort(key=lambda e: (e["agent"], e["afp:act"]))

    return {
        "denominator": denominator,
        "credited": credited,
        "unreadable": unreadable,
        "qualified": qualified,
        "membership": membership,
        "inputs": sorted(inputs),
    }


def ratifying_decision(summary_id: str, pool: list[dict]) -> dict | None:
    """The `afp:DecisionRecord` that ratifies this summary, or `None`.

    04's own ratification idiom, reused rather than reinvented: a
    `DecisionRecord` whose `afp:outcome` names the object it ratifies — exactly
    what ADR-0007 already reads to tell a ratified Synthesis from a cheap one.
    A summary needs no new machinery to become authoritative, and giving it any
    would have meant inventing a second consensus path for the one object whose
    entire value is that nobody's arithmetic is privileged.
    """
    for activity in pool:
        decision = afp_object(activity, "afp:DecisionRecord")
        if decision is not None and decision.get("afp:outcome") == summary_id:
            return decision
    return None


def check_summary_terminal(report, bundles: list[dict | None]) -> None:
    """ADR-0022 Decision 5 / W3 V7 and V8 — a dispute ends.

    04 resolves the mechanical dispute by "republishing a corrected summary",
    and `afp:computedBy` is deliberately not a privileged role — so two members
    can publish contradicting summaries for one period, both signed, both
    honest, with nothing in the record ranking them. The protocol had an object
    that says what a quarter was worth, a mechanism for challenging it, and no
    mechanism for the challenge to *end*.

    Two checks close that without giving anybody a casting vote:

    - **V7, ratification parity** — ADR-0007's rule transplanted: a ratified
      summary is superseded only by a ratified one. Otherwise a quarter the
      members voted on could be quietly overwritten by a draft nobody weighed.
    - **V8, one standing summary per period** — of the ratified summaries for a
      given period, exactly one may stand unsuperseded. Two is the ambiguity
      Decision 5 exists to remove, and it is *detectable* only across the whole
      case file, since the competing summaries live in different members'
      bundles by construction.

    Drafts are untouched. Publishing one is legitimate and carries no authority,
    which is the state most summaries in a pool that never disputes anything
    will stay in forever.
    """
    present, pool = [b for b in bundles if b is not None], []
    for bundle in present:
        pool.extend(bundle["activities"])
    pool = list({digest_of(a): a for a in pool}.values())

    standing: dict[tuple, list[str]] = {}
    superseded_ids: set[str] = set()
    summaries: list[tuple[str, dict, dict, str]] = []  # (domain, activity, summary, label)

    for bundle in present:
        domain = bundle["path"].name or str(bundle["path"])
        for activity in bundle["activities"]:
            summary = summary_object(activity)
            if summary is None:
                continue
            label = str(summary.get("id", activity.get("id", "<no id>")))
            summaries.append((domain, activity, summary, label))
            target = summary.get("afp:supersedes")
            if isinstance(target, str):
                superseded_ids.add(target)

    for domain, activity, summary, label in summaries:
        prefix = f"[{domain}] " if len(present) > 1 else ""
        target = summary.get("afp:supersedes")
        if isinstance(target, str):
            prior = next((s for _, _, s, l in summaries if l == target), None)
            name = f"{prefix}contribution: {label} supersedes a summary it may lawfully supersede"
            if prior is None:
                report.record(
                    name,
                    False,
                    f"afp:supersedes names {target!r}, which is not in this replay — a correction "
                    f"resolves against the summary it corrects (ADR-0022 Decision 5)",
                )
            else:
                prior_ratified = ratifying_decision(target, pool) is not None
                own_ratified = ratifying_decision(label, pool) is not None
                ok = (not prior_ratified) or own_ratified
                report.record(
                    name,
                    ok,
                    ""
                    if ok
                    else "the superseded summary was ratified by a round and this correction is "
                    "still a draft — a ratified answer is retracted only by a ratified one "
                    "(ADR-0007's parity rule, ADR-0022 Decision 5)",
                )

        if ratifying_decision(label, pool) is not None and label not in superseded_ids:
            frame = frame_of(summary) or {}
            period = frame.get("afp:periodRule") if isinstance(frame.get("afp:periodRule"), dict) else {}
            key = (
                str(period.get("afp:hub")),
                str(period.get("afp:from")),
                str(period.get("afp:to")),
            )
            standing.setdefault(key, []).append(label)

    for key, labels in sorted(standing.items()):
        if len(labels) <= 1:
            continue
        for domain, _activity, _summary, label in summaries:
            if label not in labels:
                continue
            prefix = f"[{domain}] " if len(present) > 1 else ""
            report.record(
                f"{prefix}contribution: {label} is the only ratified summary standing for its period",
                False,
                "ratified and unsuperseded alongside "
                + ", ".join(sorted(set(labels) - {label}))
                + " for the same period — a dispute that ends leaves one standing summary, and a "
                "correction supersedes rather than competes (ADR-0022 Decision 5)",
            )


def dispute_payload(activity: dict) -> dict | None:
    """An `afp:ContributionDispute`'s payload — a bare afp-typed activity
    carrying it in `object`, the same shape `afp:Settlement` uses (and the shape
    that made these two implementations disagree once already)."""
    if activity.get("type") != "afp:ContributionDispute":
        return None
    payload = activity.get("object")
    return payload if isinstance(payload, dict) else None


def check_disputes(report, bundles: list[dict | None]) -> None:
    """ADR-0022 Decision 5 / 04 § Disputes — a dispute resolves against the
    record, or it is not a dispute.

    Two checks, both from 04's own two sentences.

    **V9 — it points at things that exist.** The challenged summary resolves in
    the replay, the ground is one of the three 04 defines, and every cited
    digest resolves to an activity the case file actually carries. Nothing here
    adjudicates: a mechanical dispute needs no adjudication, because the
    disputed summary either recomputes or it does not and V3/V5 already say
    which in this same replay. What this refuses is the bare assertion — P7's
    gate line is that a dispute resolves "against the record, not against a
    claim", and a dispute citing nothing checkable is precisely a claim.

    **V10 — a quality dispute is not settled by republishing.** 04 routes the
    contested case ("did a Result meet the quality bar?") to a governance vote,
    "the same path as equivocation", and nothing enforced it. So: where a
    summary is under an unanswered `quality` dispute and a correction supersedes
    it, that correction MUST be ratified. Otherwise the cheap path silently
    swallows the expensive one — republish, and the question nobody could settle
    by arithmetic is simply gone from the record.

    Replay-wide, because a dispute and the summary it challenges live in
    different members' bundles by construction: the disputant is by definition
    not the computer.
    """
    present = [b for b in bundles if b is not None]
    pool: list[dict] = []
    for bundle in present:
        pool.extend(bundle["activities"])
        received_path = bundle["path"] / "received.jsonld"
        if received_path.exists():
            from afp_verify import load_json  # local import: the loader lives with the replay

            for item in load_json(received_path).get("orderedItems", []):
                activity = item.get("afp:activity")
                if isinstance(activity, dict):
                    pool.append(activity)
    pool = list({digest_of(a): a for a in pool}.values())

    summaries = {
        str((summary_object(a) or {}).get("id")): a for a in pool if summary_object(a) is not None
    }
    by_digest = {digest_of(a): a for a in pool}

    for bundle in present:
        domain = bundle["path"].name or str(bundle["path"])
        prefix = f"[{domain}] " if len(present) > 1 else ""
        for activity in bundle["activities"]:
            dispute = dispute_payload(activity)
            if dispute is None:
                continue
            label = dispute.get("id", activity.get("id", "<no id>"))
            v9 = f"{prefix}contribution: {label} dispute rests on evidence the record carries"
            target = str(dispute.get("afp:summary", ""))

            if target not in summaries:
                # The disputant holds the summary; this replay may not. Saying
                # so is not the same as saying the dispute is sound (W0.2).
                report.record(
                    v9,
                    True,
                    f"unresolvable: the challenged summary {target!r} is not in this replay, so the "
                    f"dispute cannot be checked against it (ADR-0022)",
                )
                continue

            problems: list[str] = []
            ground = dispute.get("afp:ground")
            if ground not in DISPUTE_GROUNDS:
                problems.append(f"unknown afp:ground {ground!r}")
            evidence = dispute.get("afp:evidence")
            if not isinstance(evidence, list) or not evidence:
                problems.append("cites no afp:evidence — a dispute without evidence is a claim")
            else:
                dangling = sorted(d for d in evidence if d not in by_digest)
                if dangling:
                    problems.append(
                        "cited evidence resolves to no activity in this case file: " + ", ".join(map(str, dangling))
                    )
            report.record(v9, not problems, "" if not problems else "; ".join(problems) + " (04 § Disputes, ADR-0022)")

            if ground != "quality":
                continue

            v10 = f"{prefix}contribution: {label} quality dispute escalates rather than being republished away"
            correction = next(
                (
                    s
                    for s in pool
                    if summary_object(s) is not None and (summary_object(s) or {}).get("afp:supersedes") == target
                ),
                None,
            )
            if correction is None:
                # An open quality dispute is a lawful state — the pool has not
                # answered it yet, and the record says so.
                report.record(v10, True, "open: no correction supersedes the disputed summary yet")
                continue
            correction_id = str((summary_object(correction) or {}).get("id"))
            ratified = ratifying_decision(correction_id, pool) is not None
            report.record(
                v10,
                ratified,
                ""
                if ratified
                else f"{correction_id} supersedes a summary under an unanswered quality dispute and is "
                f"itself a draft — 04 routes a contested case to a governance vote, the same path as "
                f"equivocation, and republishing is the cheap path it is not entitled to (ADR-0022 Decision 5)",
            )


def check_summary_frame(report, activity: dict) -> None:
    """ADR-0022 Decision 1 / W3 V2 — the frame is present and every form in it
    is one this verifier can resolve. Per domain: a frame is a shape claim about
    the summary's own bytes and needs nothing from anybody else."""
    summary = summary_object(activity)
    if summary is None:
        return
    label = summary.get("id", activity.get("id", "<no id>"))
    frame = frame_of(summary)
    if frame is None:
        report.record(
            f"contribution: {label} summary frame is a known form",
            False,
            "no afp:frame — a summary that does not declare which events it summed, over which "
            "window, under which visibility classes, is a number in a signed envelope (ADR-0022 "
            "Decision 1)",
        )
        return
    problems = frame_is_known(frame)
    report.record(
        f"contribution: {label} summary frame is a known form",
        not problems,
        "" if not problems else "; ".join(problems) + " (ADR-0022 Decision 1)",
    )


def check_summary_arithmetic(report, bundles: list[dict | None]) -> None:
    """ADR-0022 Decisions 1 and 3 / W3 V3 and V4 — **replay-wide and
    three-valued**, for the reason ADR-0021's V4 already established: the
    evidence belongs to other parties.

    A summary sums four operators' Results and a hub's chain. The computer's own
    bundle holds its half; the rest lives in the bundles beside it. Folding this
    per domain would fail every non-host bundle in any real case file, so the
    pool is merged, and a replay that cannot resolve the declared interval at
    all records **unresolvable** rather than a failure — which is not the same
    as recording a pass, and prints in the census as its own count.

    V4 is the half campaign 10 was actually about. A summary computed over a
    partial view is legitimate — 07's classes are doing their job, and ADR-0013
    is right to 404 a competitor — but a summary that sums a partial view and
    says nothing about it is indistinguishable from one that summed everything,
    which is how two honest members disagreed with no way to tell an entitlement
    gap from a fraud.
    """
    present = [b for b in bundles if b is not None]
    pool: list[dict] = []
    for bundle in present:
        pool.extend(bundle["activities"])

    for bundle in present:
        domain = bundle["path"].name or str(bundle["path"])
        prefix = f"[{domain}] " if len(present) > 1 else ""
        for activity in bundle["activities"]:
            summary = summary_object(activity)
            if summary is None:
                continue
            label = summary.get("id", activity.get("id", "<no id>"))
            frame = frame_of(summary)
            if frame is None or frame_is_known(frame):
                continue  # V2 already failed this one by name; do not fail it twice

            hub_actor = str(summary.get("afp:hub") or frame["afp:periodRule"]["afp:hub"])
            recomputed = recompute(pool, frame, hub_actor)

            v3 = f"{prefix}contribution: {label} input hash matches the set its frame declares"
            v4 = f"{prefix}contribution: {label} unreadable inputs are counted, not dropped"
            if recomputed is None:
                detail = (
                    "unresolvable: this replay does not carry the hub chain the frame's period "
                    "names, so the summed set cannot be rebuilt from it (ADR-0022)"
                )
                report.record(v3, True, detail)
                report.record(v4, True, detail)
                report.record(f"{prefix}contribution: {label} entries recompute from the frame", True, detail)
                report.record(f"{prefix}contribution: {label} credit is fixed at acceptance", True, detail)
                continue

            declared_hash = summary.get("afp:inputHash")
            recomputed_hash = digest_of(sorted(recomputed["inputs"]))
            report.record(
                v3,
                declared_hash == recomputed_hash,
                ""
                if declared_hash == recomputed_hash
                else f"afp:inputHash {declared_hash!r} is not the digest of the sorted activity "
                f"digests the frame selects ({len(recomputed['inputs'])} of them) — the field "
                f"exists so a second party can confirm it summed the same things (ADR-0022 Decision 3)",
            )

            # V5 — the numbers themselves. This is P7's own roadmap gate line
            # ("a second operator recomputes it from certificates and Results
            # and matches") and it is what makes Decision 4 enforceable rather
            # than aspirational: nothing in `recompute` deducts for a settlement
            # or a supersession, so a summary that quietly un-counts work it
            # already credited cannot match the recomputation.
            v5 = f"{prefix}contribution: {label} entries recompute from the frame"
            declared_entries = summary.get("afp:entries")
            entries = (
                {str(e.get("afp:operator")): e.get("afp:credited") for e in declared_entries if isinstance(e, dict)}
                if isinstance(declared_entries, list)
                else {}
            )
            expected = recomputed["credited"]
            disagree = sorted(
                operator
                for operator in set(entries) | set(expected)
                if entries.get(operator) != expected.get(operator)
            )
            denominator_ok = summary.get("afp:denominator") == recomputed["denominator"]
            report.record(
                v5,
                not disagree and denominator_ok,
                ""
                if not disagree and denominator_ok
                else (
                    ""
                    if denominator_ok
                    else f"afp:denominator {summary.get('afp:denominator')!r} is not the recomputed "
                    f"{recomputed['denominator']}; "
                )
                + (
                    ""
                    if not disagree
                    else "credit disagrees for "
                    + ", ".join(f"{o} (declared {entries.get(o)!r}, recomputed {expected.get(o)!r})" for o in disagree)
                )
                + " (ADR-0022 Decisions 1 and 4)",
            )

            # V6 — Decision 4's two records, both of which exist so that neither
            # of them moves a number.
            v6 = f"{prefix}contribution: {label} credit is fixed at acceptance"
            problems: list[str] = []
            declared_qualified = summary.get("afp:qualified")
            qualified = (
                {str(e.get("afp:operator")): e.get("afp:count") for e in declared_qualified if isinstance(e, dict)}
                if isinstance(declared_qualified, list)
                else None
            )
            if qualified is None:
                problems.append(
                    "no afp:qualified census — an answer the record says did not hold is recorded, "
                    "never deducted, and a summary that says nothing cannot be told from one with "
                    "nothing to say"
                )
            elif qualified != {k: v for k, v in recomputed["qualified"].items()}:
                problems.append(
                    f"afp:qualified {qualified!r} is not the recomputed {recomputed['qualified']!r}"
                )
            declared_membership = summary.get("afp:membership")
            if not isinstance(declared_membership, list):
                problems.append("no afp:membership record for the period")
            elif [
                {"agent": str(e.get("agent")), "afp:act": str(e.get("afp:act"))}
                for e in declared_membership
                if isinstance(e, dict)
            ] != recomputed["membership"]:
                problems.append(
                    "afp:membership does not match the acts this period brackets — accounting is "
                    "forward-scoped (ADR-0021's rule, one layer up), so a seat that ended inside "
                    "the period keeps the work it was credited before it ended, and the record "
                    "says the seat ended"
                )
            report.record(v6, not problems, "" if not problems else "; ".join(problems) + " (ADR-0022 Decision 4)")

            declared = summary.get("afp:unreadable")
            declared_counts = (
                {str(e.get("afp:operator")): e.get("afp:count") for e in declared if isinstance(e, dict)}
                if isinstance(declared, list)
                else None
            )
            if declared_counts is None:
                report.record(
                    v4,
                    False,
                    "no afp:unreadable census — a summary states what it could not read, or a "
                    "partial view is indistinguishable from a complete one (ADR-0022 Decision 1)",
                )
                continue
            missing = {
                operator: count
                for operator, count in recomputed["unreadable"].items()
                if declared_counts.get(operator) != count
            }
            report.record(
                v4,
                not missing,
                ""
                if not missing
                else "declared census disagrees with the recomputed one for "
                + ", ".join(f"{operator} (recomputed {count})" for operator, count in sorted(missing.items()))
                + " (ADR-0022 Decision 1)",
            )
