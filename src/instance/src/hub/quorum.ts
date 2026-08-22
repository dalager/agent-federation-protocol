/**
 * Threshold arithmetic for `afp:quorumRule` (ADR-0018 W2) — one function,
 * mirrored on the Python side (`src/verifier/decision.py`, `threshold_of`).
 * Integer arithmetic only: the JCS numeric profile forbids non-integer
 * numbers in signed bytes, so no ratio, percentage, or float appears here.
 *
 * `T` is the pinned total — every seat in `afp:voterWeights`, including seats
 * that never voted. A silent seat's weight still counts toward the bar its
 * own operator's vote must clear (ADR-0018 Decision 5, finding 52).
 */

export type QuorumRule =
  | { "afp:form": "majority-of-total" }
  | { "afp:form": "two-thirds-of-total" }
  | { "afp:form": "explicit"; "afp:threshold": number };

/**
 * The bar a round's winning option must clear, or `null` for a form a
 * verifier cannot compute — an unknown rule is a replay failure (W2), never
 * silently ignored, so `null` must never be signed as if it were a number.
 */
export function thresholdOf(rule: QuorumRule, weights: Readonly<Record<string, number>>): number | null {
  const total = Object.values(weights).reduce((sum, w) => sum + w, 0);
  switch (rule["afp:form"]) {
    case "majority-of-total":
      return Math.floor(total / 2) + 1;
    case "two-thirds-of-total":
      return Math.floor((2 * total) / 3) + 1;
    case "explicit": {
      const threshold = rule["afp:threshold"];
      // Integer >= 1, else UNKNOWN_FORM (W2) — `Number.isInteger` rejects
      // both non-integers and `NaN`; booleans coerce to 0/1 under `typeof`
      // checks alone, so the explicit `typeof` guard is required.
      if (typeof threshold !== "number" || !Number.isInteger(threshold) || threshold < 1) return null;
      return threshold;
    }
    default:
      return null;
  }
}
