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

from decision import afp_object, enrolled_instances, instant_millis, settlement_payload
from proof import digest_of

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

    instances = enrolled_instances(hub_actor, pool, instant_millis(None) or 2**63)
    def operator_of(agent: str) -> str:
        return instances.get(agent, agent)

    rows: list[tuple[str, int, int]] = []
    unreadable: dict[str, int] = {}
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
        for result in results:
            inputs.add(digest_of(result))
            rows.extend(credit_of(afp_object(result, "afp:Result") or {}))

    denominator = _lcm([row[2] for row in rows]) if rows else 1
    credited: dict[str, int] = {}
    for agent, share, own in rows:
        operator = operator_of(agent)
        credited[operator] = credited.get(operator, 0) + share * denominator // own

    return {
        "denominator": denominator,
        "credited": credited,
        "unreadable": unreadable,
        "inputs": sorted(inputs),
    }


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
