/**
 * Per-instance vote weighting (ADR-0005 Decision 1): one operator, one weight.
 *
 * Every live `member`-role agent votes, but each seated instance carries the
 * same total — so an operator's say does not grow by running more agents,
 * which is otherwise the cheapest attack on a consortium: no reasoning
 * required, and indistinguishable in the record from enthusiastic
 * participation.
 *
 * The division cannot be fractional. The AFP JCS numeric profile forbids
 * non-integer numbers and `afp:voterWeights` is pinned inside the signed
 * proposal, so `1/n` is unrepresentable rather than merely awkward. Instead,
 * with `n_I` the count of instance `I`'s pinned voters and `L` the least
 * common multiple of every `n_I`, each of `I`'s voters carries `L / n_I` —
 * every instance sums to exactly `L`, and every weight is a whole number.
 *
 * This *generalizes* ADR-0002 Decision 3 rather than replacing it: with one
 * instance, `L = n` and every voter carries 1, which is precisely the uniform
 * weight P1–P3 already publish. Every existing export recomputes unchanged.
 *
 * `src/verifier/decision.py`'s `voter_weights` mirrors this exactly, and the
 * verifier recomputes the proposal's weights rather than trusting them — a
 * hub that writes its own numbers fails the same way one that mistallies does.
 */

/** Greatest common divisor over non-negative bigints. */
function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a;
}

/**
 * `agent → weight` for one round's pinned voters.
 *
 * Computed in arbitrary-precision integers so the least common multiple is
 * exact regardless of how the per-instance counts fall; the result is
 * converted only after the division, and a total beyond `Number.MAX_SAFE_INTEGER`
 * throws rather than silently rounding into a signed document.
 */
export function voterWeights(voters: readonly { agent: string; instance: string }[]): Record<string, number> {
  if (voters.length === 0) return {};

  const counts = new Map<string, number>();
  for (const { instance } of voters) counts.set(instance, (counts.get(instance) ?? 0) + 1);

  // lcm is order-independent, but fold over a sorted key list anyway so two
  // implementations cannot disagree by accumulation order.
  let lcm = 1n;
  for (const instance of [...counts.keys()].sort()) {
    const n = BigInt(counts.get(instance)!);
    lcm = (lcm / gcd(lcm, n)) * n;
  }
  if (lcm > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`per-instance weight denominator ${lcm} exceeds the safe integer range`);
  }

  const weights: Record<string, number> = {};
  for (const { agent, instance } of voters) {
    weights[agent] = Number(lcm / BigInt(counts.get(instance)!));
  }
  return weights;
}
