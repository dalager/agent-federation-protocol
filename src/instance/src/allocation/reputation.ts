/**
 * The reputation-derivation registry (ADR-0004 Decision 3): a small named set
 * of pure functions from a pinned settlement list to a per-bidder score —
 * exactly the selection-rule registry's shape, reapplied. An unknown name is
 * a verification failure, not a skip.
 *
 * Determinism rules (03 § Consuming reputation, recomputably), mirrored
 * bit-for-bit by the Python verifier's `reputation.py`:
 *
 * - Divergence is **relative**: integer percent of the estimate, unit-free.
 *   An entry whose estimated/actual units differ, or whose values are
 *   non-numeric, or whose estimate is not a positive integer, is skipped —
 *   never guessed at.
 * - Decay is **exact rational arithmetic over the recency ordering**:
 *   settlements ordered by `published`, ties by digest; per-step decay a
 *   ratio of small integers (default 1/2), accumulated in bigints — never a
 *   wall-clock float exponential.
 * - Neutral prior: a bidder with no history scores exactly 50 — new entrants
 *   are not punished for being new.
 * - `afp:dissentVindicated` is a bonus (default +25 on a settled entry; a
 *   vindication with no settled entry counts as accuracy 100) — a swarm that
 *   penalizes accurate minority objections stops producing them (04).
 *
 * Per settlement (recency step k back from the newest, weight (num/den)^k):
 *   a = max(0, 100 - floor(100·|actual−estimate| / estimate))   if entry usable
 *   a += dissentBonus                                            if also vindicated
 *   a = 100                                                      if vindicated only
 * Score = floor(Σ a·w / Σ w) over the settlements the bidder appears in.
 */

import type { JsonValue } from "../crypto/jcs.ts";
import { instantMillis } from "../crypto/time.ts";

export interface ReputationRule {
  name: string;
  params: { [key: string]: JsonValue };
}

/** One pinned settlement, resolved from its digest: the afp:Settlement object plus ordering keys. */
export interface PinnedSettlement {
  object: { [key: string]: JsonValue };
  published: string;
  digest: string;
}

type ScoreFn = (params: { [key: string]: JsonValue }, settlements: PinnedSettlement[], bidder: string) => number;

function usableCost(value: JsonValue): { unit: string; value: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const unit = (value as Record<string, JsonValue>).unit;
  const amount = (value as Record<string, JsonValue>).value;
  if (typeof unit !== "string" || typeof amount !== "number" || !Number.isInteger(amount)) return null;
  return { unit, value: amount };
}

function divergenceDecay(
  params: { [key: string]: JsonValue },
  settlements: PinnedSettlement[],
  bidder: string,
): number {
  const num = BigInt(typeof params.decayNum === "number" ? params.decayNum : 1);
  const den = BigInt(typeof params.decayDen === "number" ? params.decayDen : 2);
  const bonus = BigInt(typeof params.dissentBonus === "number" ? params.dissentBonus : 25);

  // Recency ordering: by published *instant*, ties by digest — the protocol
  // constant. Comparing the raw strings would order a negative-UTC-offset
  // timestamp before a 'Z' one that it actually follows in time, and the
  // verifier must reach the identical ordering (see instant_millis there).
  const ordered = [...settlements].sort((a, b) => {
    const ta = instantMillis(a.published);
    const tb = instantMillis(b.published);
    if (ta !== tb) return ta - tb;
    return a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0;
  });
  const n = ordered.length;

  let scoreNum = 0n;
  let scoreDen = 0n;
  for (let idx = 0; idx < n; idx++) {
    const settlement = ordered[idx].object;
    const k = n - 1 - idx; // steps back from the newest
    // Common denominator den^(n-1): weight = num^k · den^(n-1-k), all bigint.
    const weight = num ** BigInt(k) * den ** BigInt(n - 1 - k);

    // Every element is guarded, not just the array: a null or a bare string in
    // `afp:settles` is a property access away from throwing, and a derivation
    // that crashes where the verifier's returns a score has diverged just as
    // surely as one that returns a different number.
    const entries = Array.isArray(settlement["afp:settles"])
      ? (settlement["afp:settles"] as JsonValue[]).filter(
          (e): e is Record<string, JsonValue> => !!e && typeof e === "object" && !Array.isArray(e),
        )
      : [];
    const entry = entries.find((e) => e.actor === bidder);
    const vindicated = Array.isArray(settlement["afp:dissentVindicated"])
      && (settlement["afp:dissentVindicated"] as JsonValue[]).includes(bidder);

    let a: bigint | null = null;
    if (entry) {
      const estimated = usableCost((entry["afp:estimated"] as Record<string, JsonValue> | undefined)?.["afp:estimatedCost"] ?? null);
      const actual = usableCost(entry["afp:actual"] ?? null);
      if (estimated && actual && estimated.unit === actual.unit && estimated.value > 0) {
        const est = BigInt(estimated.value);
        const act = BigInt(actual.value);
        const diff = act > est ? act - est : est - act;
        const divergence = (100n * diff) / est; // floor — integer percent of the estimate
        a = divergence >= 100n ? 0n : 100n - divergence;
        if (vindicated) a += bonus;
      } else if (vindicated) {
        a = 100n; // unusable entry, but an accurate minority objection still counts
      }
      // Unusable entry, not vindicated: skipped — never guessed at.
    } else if (vindicated) {
      a = 100n; // vindication with no settled entry: full accuracy
    }

    if (a !== null) {
      scoreNum += a * weight;
      scoreDen += weight;
    }
  }

  if (scoreDen === 0n) return 50; // neutral prior — no history is not bad history
  return Number(scoreNum / scoreDen); // floor
}

const REGISTRY: Record<string, ScoreFn> = { "divergence-decay": divergenceDecay };

export function knownReputationRule(name: string): boolean {
  return name in REGISTRY;
}

/** Score one bidder under a named derivation. Throws on an unknown name — never silently skips. */
export function runReputationRule(rule: ReputationRule, settlements: PinnedSettlement[], bidder: string): number {
  const fn = REGISTRY[rule.name];
  if (!fn) throw new Error(`unknown reputation rule ${rule.name} — not in the registry`);
  return fn(rule.params, settlements, bidder);
}
