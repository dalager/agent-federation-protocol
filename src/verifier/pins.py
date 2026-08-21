"""ADR-0010 Decision 1 — the pin machinery: the pin set, its digest, and the
per-thread resolution that `action.py` and `allocation.py` both need.

Kept apart from `action.py` for the same reason `decision.py` is kept apart
from `afp_verify.py`: the pin set is not an actuation concept, it is the
carrier three other extensions (policy, sufficiency, synthesizer) sit on top
of, and an auditor asking "what does a pin actually check" should find it in
one place.

`afp:actionPolicy`, `afp:answerSufficiency` and `afp:synthesizer` MAY be
carried by any task-bearing activity — an `Announce{afp:Task}` or a direct
`Offer{afp:Task}` — on the `afp:Task` object itself. A thread may carry
several task-bearing activities (a fan-out of Offers); all of them MUST agree
on a **pin digest**: `sha256(JCS(pin set))` over the object `{afp:actionPolicy,
afp:answerSufficiency, afp:synthesizer}` restricted to the keys present. The
empty pin set is a value like any other — an unpinned Offer added to a pinned
thread is divergence, not abstention.
"""

from __future__ import annotations

from decision import afp_object, instant_millis
from proof import digest_of

PIN_KEYS = ("afp:actionPolicy", "afp:answerSufficiency", "afp:synthesizer")


def is_task_bearing(activity: dict) -> dict | None:
    """The `afp:Task` object of a task-bearing activity — `Announce{Task}` or
    a direct `Offer{Task}` — or None for anything else."""
    if activity.get("type") not in ("Announce", "Offer"):
        return None
    return afp_object(activity, "afp:Task")


def pin_set(task: dict) -> dict:
    """The pin set: `{afp:actionPolicy, afp:answerSufficiency,
    afp:synthesizer}` restricted to the keys actually present on the task."""
    return {key: task[key] for key in PIN_KEYS if key in task}


def pin_digest(task: dict) -> str:
    return digest_of(pin_set(task))


def correlation_id(activity: dict) -> str | None:
    """`afp:correlationId`, read from the activity or its nested object — the
    same either-shape reading `ap/activities.ts`'s reader uses on the writer
    side."""
    direct = activity.get("afp:correlationId")
    if isinstance(direct, str):
        return direct
    obj = activity.get("object")
    if isinstance(obj, dict):
        nested = obj.get("afp:correlationId")
        if isinstance(nested, str):
            return nested
    return None


def task_activities_by_context(activities: list[dict]) -> dict[str, list[dict]]:
    """Task-bearing activities grouped by `context` — the thread."""
    grouped: dict[str, list[dict]] = {}
    for activity in activities:
        if is_task_bearing(activity) is None:
            continue
        context = activity.get("context")
        if not isinstance(context, str):
            continue
        grouped.setdefault(context, []).append(activity)
    return grouped


def governing_pins(thread: str, thread_pool: list[dict]) -> tuple[dict | None, str]:
    """The agreed pin set for a thread's task-bearing activities.

    Returns (pin set or None, detail). None with a reason when the thread
    carries no task-bearing activity, or when its task-bearing activities
    disagree on their pin digest — divergence, not a tie to break: the
    verifier resolves no governing pins for that thread rather than picking a
    winner.
    """
    task_activities = [
        a for a in thread_pool if a.get("context") == thread and is_task_bearing(a) is not None
    ]
    if not task_activities:
        return None, f"thread {thread!r} carries no task-bearing activity to pin from"
    tasks = [is_task_bearing(a) for a in task_activities]
    digests = {pin_digest(t) for t in tasks}
    if len(digests) > 1:
        return None, (
            f"thread {thread!r}'s task-bearing activities disagree on their pinned set "
            f"({len(digests)} distinct pin digests among {len(task_activities)} activities) "
            f"(ADR-0010)"
        )
    return pin_set(tasks[0]), ""


def _outcome_type(activity: dict) -> str:
    obj = activity.get("object")
    return obj.get("type", "") if isinstance(obj, dict) else ""


def check_pins(report, thread_pool: list[dict]) -> None:
    """Thread-level pin checks, over the thread pool (own activities plus
    received foreign bytes) — the same pool `check_thread` runs over, because
    a delegated thread's opening Offer may be authored by the counterparty."""
    grouped = task_activities_by_context(thread_pool)
    for thread, task_activities in grouped.items():
        tasks = [is_task_bearing(a) for a in task_activities]
        digests = {pin_digest(t) for t in tasks}
        agree = len(digests) <= 1
        report.record(
            f"pins: {thread} task activities agree on their pinned set",
            agree,
            "" if agree else
            f"{len(task_activities)} task-bearing activities on this thread pin "
            f"{len(digests)} distinct sets — an unpinned Offer on a pinned thread is "
            f"divergence, not abstention (ADR-0010)",
        )
        if not agree:
            continue
        governing = pin_set(tasks[0])
        if not governing:
            continue  # an unpinned thread constrains nothing (ADR-0006's opt-in reading)

        # Pins precede answers, by `published` — the only comparator threads
        # spanning several actors' clocks have available. Only the thread's
        # OPENING task activity is bound (spec correction to ADR-0010
        # Decision 1): later task activities on the same thread need no
        # ordering rule of their own, because pin-equality already governs
        # them — carrying a byte-identical pin set, they introduce no
        # constraint that was not fixed when the thread opened. Sequential
        # delegation on one thread (Offer -> Result -> Offer -> Result) is a
        # legitimate, longstanding shape, and binding only the opening act
        # still catches the real abuse: a thread pinned wholly after its
        # answers were visible.
        answer_instants = [
            a.get("published")
            for a in thread_pool
            if a.get("context") == thread and _outcome_type(a) in ("afp:Result", "afp:Error")
        ]
        if answer_instants:
            earliest_answer = min(instant_millis(p) for p in answer_instants)
            opening = min(task_activities, key=lambda a: instant_millis(a.get("published")))
            opens_before = instant_millis(opening.get("published")) < earliest_answer
            report.record(
                f"pins: {thread} pins precede the thread's first answer",
                opens_before,
                "" if opens_before else
                f"the thread's opening task-bearing activity ({opening.get('id', '<no id>')}) "
                f"published at or after the thread's first Result/Error — a pin published "
                f"once answers are visible constrains nothing (ADR-0010)",
            )

        policy = governing.get("afp:actionPolicy")
        if isinstance(policy, dict):
            # A *declared, non-empty* action, matching the writer's refusal
            # exactly: a key mapped to "" would satisfy presence while leaving
            # the actuator with nothing admissible to do, which is the parked
            # application by another route.
            declared = policy.get("afp:no-verdict")
            has_no_verdict = isinstance(declared, str) and declared != ""
            report.record(
                f"pins: {thread} pinned afp:actionPolicy declares an afp:no-verdict action",
                has_no_verdict,
                "" if has_no_verdict else
                f"the pinned afp:actionPolicy maps afp:no-verdict to {declared!r} — a policy "
                "that cannot state its non-answer action is not yet a policy (ADR-0010)",
            )

        sufficiency = governing.get("afp:answerSufficiency")
        if isinstance(sufficiency, dict):
            has_award = any(
                a.get("context") == thread and afp_object(a, "afp:Award") is not None
                for a in thread_pool
            )
            if not has_award:
                has_coverage = "coverage" in sufficiency
                report.record(
                    f"pins: {thread} answer-sufficiency pins a count, not coverage",
                    not has_coverage,
                    "" if not has_coverage else
                    "pinned afp:answerSufficiency carries a 'coverage' key on a thread with "
                    "no Award — coverage is scored against a bid's afp:coverage at a "
                    "selection rule's minConfidence, neither of which exists in the direct "
                    "flow (ADR-0010)",
                )
