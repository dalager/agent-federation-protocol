"""ADR-0004 Decision 3 — the reputation-derivation verifier extension.

Kept apart for the same reason `decision.py` and `allocation.py` are. The
derivations here are deliberately reimplemented from their spec description
(03 § "Consuming reputation, recomputably"), sharing no code with the
TypeScript instance — that mirroring *is* the verifiability guarantee.

Determinism rules, identical on both sides:
- Divergence is relative: integer percent of the estimate, unit-free. An entry
  whose estimated/actual units differ, or whose values are non-integers, or
  whose estimate is not positive, is skipped — never guessed at.
- Decay is exact rational arithmetic over the recency ordering (settlements by
  `published`, ties by digest; per-step decay a ratio of small integers,
  accumulated in arbitrary-precision integers) — never a float exponential.
- Neutral prior: a bidder with no history scores exactly 50.
- `afp:dissentVindicated` is a bonus (+25 on a settled entry; a vindication
  with no usable settled entry counts as accuracy 100).

Per settlement (recency step k back from the newest, weight (num/den)^k):
  a = max(0, 100 - (100·|actual−estimate|) // estimate)   if the entry is usable
  a += dissentBonus                                        if also vindicated
  a = 100                                                  if vindicated only
Score = (Σ a·w) // (Σ w) over the settlements the bidder appears in.
"""

from __future__ import annotations

from decision import instant_millis


def _usable_cost(value) -> tuple[str, int] | None:
    """A cost is usable when it carries a string unit and an **integer-valued
    number**.

    JSON draws no int/float line, and the AFP JCS profile forbids only
    *non-integer* numbers — `100.0` is legal on the wire and canonicalizes to
    `100`, so a signed document may well carry it. Testing `isinstance(x, int)`
    alone would drop such an entry here while the TypeScript writer
    (`Number.isInteger`) keeps it, and the two implementations would score the
    same settlement differently. Accept integer-valued floats, reject booleans
    (a bool is an int in Python, never a cost), reject genuine fractions.
    """
    if not isinstance(value, dict):
        return None
    unit = value.get("unit")
    amount = value.get("value")
    if not isinstance(unit, str) or isinstance(amount, bool):
        return None
    if isinstance(amount, int):
        return unit, amount
    if isinstance(amount, float) and amount.is_integer():
        return unit, int(amount)
    return None


def divergence_decay(params: dict, settlements: list[dict], bidder: str) -> int:
    """settlements: [{"object": <afp:Settlement>, "published": str, "digest": str}]."""
    num = params.get("decayNum", 1)
    den = params.get("decayDen", 2)
    bonus = params.get("dissentBonus", 25)

    ordered = sorted(settlements, key=lambda s: (instant_millis(s["published"]), s["digest"]))
    n = len(ordered)

    score_num = 0
    score_den = 0
    for idx, record in enumerate(ordered):
        settlement = record["object"]
        k = n - 1 - idx  # steps back from the newest
        weight = (num ** k) * (den ** (n - 1 - k))  # common denominator den^(n-1)

        entries = settlement.get("afp:settles") or []
        entry = next((e for e in entries if isinstance(e, dict) and e.get("actor") == bidder), None)
        # Must be a list: a bare `in` against a string is a SUBSTRING test, so
        # a malformed (or crafted) "afp:dissentVindicated": "…sub-bidder-42"
        # would award vindication to bidder "bidder-42" here while the writer,
        # which type-guards with Array.isArray, awards none.
        vindicated_field = settlement.get("afp:dissentVindicated")
        vindicated = isinstance(vindicated_field, list) and bidder in vindicated_field

        a = None
        if entry is not None:
            estimated = _usable_cost((entry.get("afp:estimated") or {}).get("afp:estimatedCost"))
            actual = _usable_cost(entry.get("afp:actual"))
            if estimated and actual and estimated[0] == actual[0] and estimated[1] > 0:
                divergence = (100 * abs(actual[1] - estimated[1])) // estimated[1]
                a = 0 if divergence >= 100 else 100 - divergence
                if vindicated:
                    a += bonus
            elif vindicated:
                a = 100  # unusable entry, but an accurate minority objection still counts
            # Unusable entry, not vindicated: skipped — never guessed at.
        elif vindicated:
            a = 100  # vindication with no settled entry: full accuracy

        if a is not None:
            score_num += a * weight
            score_den += weight

    if score_den == 0:
        return 50  # neutral prior — no history is not bad history
    return score_num // score_den


REPUTATION_RULES = {
    "divergence-decay": divergence_decay,
}
