"""ADR-0010 Decision 1 — the pin machinery: the pin set, its digest, and the
per-thread resolution that `action.py` and `allocation.py` both need.

Kept apart from `action.py` for the same reason `decision.py` is kept apart
from `afp_verify.py`: the pin set is not an actuation concept, it is the
carrier four other extensions (policy, sufficiency, synthesizer, and
ADR-0011's irrevocability declaration) sit on top of, and an auditor asking
"what does a pin actually check" should find it in one place.

`afp:actionPolicy`, `afp:answerSufficiency`, `afp:synthesizer` and
`afp:irrevocableActions` MAY be carried by any task-bearing activity — an
`Announce{afp:Task}` or a direct `Offer{afp:Task}` — on the `afp:Task` object
itself. A thread may carry several task-bearing activities (a fan-out of
Offers); all of them MUST agree on a **pin digest**: `sha256(JCS(pin set))`
over those keys restricted to the ones present. The empty pin set is a value
like any other — an unpinned Offer added to a pinned thread is divergence, not
abstention.

`afp:priorThread` sits beside the pins on the same object but deliberately
outside them (ADR-0011 Decision 4): it identifies the thread's prehistory
rather than governing the answer, so a fan-out whose opening Offer alone
carries it must not read as divergence.
"""

from __future__ import annotations

from decision import afp_object, instant_millis
from proof import digest_of

PIN_KEYS = (
    "afp:actionPolicy",
    "afp:answerSufficiency",
    "afp:synthesizer",
    "afp:irrevocableActions",
)


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

        # ADR-0011 Decision 1 — every declared name MUST be a value of the
        # pinned afp:actionPolicy; a name matching none declares the
        # irreversibility of nothing. Checked OUTSIDE the policy block on
        # purpose: names drawn from a policy that was never pinned are the
        # same dead clause in its most complete form, and nesting this under
        # `if policy` would let that one case through unexamined.
        irrevocable = governing.get("afp:irrevocableActions")
        if isinstance(irrevocable, list):
            policy_values = set(policy.values()) if isinstance(policy, dict) else set()
            unknown = sorted(name for name in irrevocable if name not in policy_values)
            report.record(
                f"pins: {thread} afp:irrevocableActions name actions the policy declares",
                not unknown,
                "" if not unknown else
                f"afp:irrevocableActions names {unknown!r}, matching no value of the "
                + (
                    "pinned afp:actionPolicy"
                    if isinstance(policy, dict)
                    else "thread's afp:actionPolicy, which is not pinned at all"
                )
                + " — a declaration of the irreversibility of nothing (ADR-0011)",
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


def _synthesis_payload(activity: dict) -> dict | None:
    """Local, deliberately duplicated copy of `action._synthesis_of` — `pins`
    is imported by `action` at module load, so importing back would cycle."""
    obj = activity.get("object")
    if isinstance(obj, dict) and obj.get("type") == "afp:Synthesis":
        return obj
    return afp_object(activity, "afp:Synthesis")


def check_prior_thread(report, thread_pool: list[dict]) -> None:
    """ADR-0011 Decision 4 — a thread-opening task activity's `afp:priorThread`
    resolves to a closed, unretracted thread when the export contains it.

    Not part of the pin set (`afp:priorThread` sits beside the pins on the
    `afp:Task` object, outside them). A named prior thread absent from this
    bundle is not a failure — a lawfully scoped ADR-0009 export routinely
    omits other subjects' threads — and is reported as an out-of-scope
    reference under its own check name rather than folded into the
    resolution check or silently skipped, so an auditor sees which case
    applied. A thread naming itself is always a finding.
    """
    seen: set[tuple[str, str]] = set()
    for activity in thread_pool:
        task = is_task_bearing(activity)
        if task is None:
            continue
        prior = task.get("afp:priorThread")
        current = activity.get("context")
        if not isinstance(prior, str) or not isinstance(current, str):
            continue
        key = (current, prior)
        if key in seen:
            continue
        seen.add(key)

        if prior == current:
            report.record(
                f"thread: {prior} afp:priorThread resolves to a closed, unretracted thread",
                False,
                f"thread {current!r} names itself as its own afp:priorThread — a thread "
                f"cannot be its own prehistory (ADR-0011)",
            )
            continue

        prior_activities = [a for a in thread_pool if a.get("context") == prior]
        if not prior_activities:
            report.record(
                f"thread: {prior} afp:priorThread is out of scope for this export",
                True,
                f"referenced by thread {current!r} but not present in this bundle — a "
                f"lawfully scoped export (ADR-0009) routinely omits other subjects' "
                f"threads (ADR-0011)",
            )
            continue

        is_closed = any(
            afp_object(a, "afp:Result") is not None or afp_object(a, "afp:Error") is not None
            for a in prior_activities
        )
        superseded = False
        if is_closed:
            prior_synth_digests = {
                digest_of(a) for a in prior_activities if _synthesis_payload(a) is not None
            }
            superseded = any(
                (s := _synthesis_payload(a)) is not None and s.get("afp:supersedes") in prior_synth_digests
                for a in thread_pool
            )

        ok = is_closed and not superseded
        if not ok:
            detail = (
                f"thread {prior!r} carries no terminal afp:Result/afp:Error — a 'new ask "
                f"continuing a closed thread' pointing at a live thread (ADR-0011)"
                if not is_closed else
                f"thread {prior!r}'s answer was superseded — its outcome does not stand "
                f"unretracted (ADR-0011)"
            )
        else:
            detail = ""
        report.record(
            f"thread: {prior} afp:priorThread resolves to a closed, unretracted thread",
            ok,
            detail,
        )
