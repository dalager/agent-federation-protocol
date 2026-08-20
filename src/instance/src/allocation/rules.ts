/**
 * The selection-rule registry (ADR-0003 Decision 3): a small named set of pure
 * functions from the revealed bid set to a performer set (plus synthesizer).
 *
 * Rules take the revealed bids only — never hub state, clocks, or randomness —
 * so the Python verifier reimplements each one from its spec description,
 * sharing no code, and the gate diffs the two implementations' outputs on the
 * same bid sets. An unknown rule name is a verification failure, not a skip.
 */

import type { JsonValue } from "../crypto/jcs.ts";
import { sha256Hex } from "../crypto/proof.ts";

/** A revealed bid, as seen by a rule: the committed payload plus its digest. */
export interface RevealedBid {
  bidder: string;
  digest: string;
  capabilityMatch: number;
  estimatedCostValue: number;
  estimatedLatencySeconds: number;
  /** Declared sub-domain → confidence (03 § Selection rules). */
  coverage: Record<string, number>;
  /**
   * The pinned reputation derivation's output for this bidder (ADR-0004
   * Decision 3) — set by the caller only when the Announce pinned a rule.
   */
  reputation?: number;
}

export interface SelectionRule {
  name: string;
  params: { [key: string]: JsonValue };
}

export interface Selection {
  /** Winning bid digests, in deterministic order. */
  winningBids: string[];
  performers: string[];
  /** Named only by set-selection awards of more than one performer. */
  synthesizer: string | null;
}

/**
 * The protocol tie-break constant (03 § Bidding): `sha256(taskId || bidderId)`
 * with a newline separator so no (taskId, bidderId) pair is ambiguous.
 * Lower hex digest wins. Never a per-task choice.
 */
export function tieBreak(taskId: string, bidderId: string): string {
  return sha256Hex(new TextEncoder().encode(`${taskId}\n${bidderId}`));
}

/** ISO-8601 duration (PTnHnMnS subset) → seconds. Bid metadata, not arithmetic-critical. */
export function latencySeconds(duration: string): number {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(duration);
  if (!match) return Number.POSITIVE_INFINITY;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

/**
 * `ranking` — score each bid by the published linear weights over its declared
 * fields, take the top one (03: "score each bid, take the top one").
 * Params: `weights: { capabilityMatch, cost, latencySeconds }` — missing
 * weights are 0, so an announce states exactly what it selects on.
 */
function ranking(taskId: string, bids: RevealedBid[], params: { [key: string]: JsonValue }): Selection | null {
  if (bids.length === 0) return null;
  const weights = (params.weights ?? {}) as Record<string, number>;
  // A zero (or absent) weight contributes exactly 0 even when the field is
  // Infinity (unparseable latency) — `0 * Infinity` is NaN, and NaN in a sort
  // key is unspecified behavior in one implementation and first-wins in the
  // other. Skipping the term keeps both rule implementations total functions.
  const term = (weight: number | undefined, value: number): number => (weight ? weight * value : 0);
  const score = (bid: RevealedBid): number =>
    term(weights.capabilityMatch, bid.capabilityMatch) +
    term(weights.cost, bid.estimatedCostValue) +
    term(weights.latencySeconds, bid.estimatedLatencySeconds) +
    // ADR-0004 Decision 3: the optional reputation weight — its term is the
    // pinned derivation's output, never a live number. `coverage` stays
    // reputation-free at this phase.
    term(weights.reputation, bid.reputation ?? 0);

  // Codepoint comparison on the hex digests — never locale collation, which
  // would make the protocol constant host-dependent.
  const best = [...bids].sort((a, b) => {
    const byScore = score(b) - score(a);
    if (byScore !== 0) return byScore;
    const ka = tieBreak(taskId, a.bidder);
    const kb = tieBreak(taskId, b.bidder);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  })[0];
  return { winningBids: [best.digest], performers: [best.bidder], synthesizer: null };
}

/**
 * `coverage` — minimal bid set whose declared coverage satisfies the announced
 * predicate: every named domain claimed at confidence ≥ `minConfidence`.
 * Params: `domains: string[]`, `minConfidence: number` — confidences travel
 * as integer percent (the AFP JCS profile forbids non-integer numbers).
 *
 * Determinism: smallest covering set wins; among equal-size sets, the one whose
 * sorted tie-break digests compare lexicographically lowest. The synthesizer is
 * the awardee covering the most eligible domains (scenario 04:
 * broadest-coverage awardee), ties by the same constant. No full cover → no award.
 */
function coverage(taskId: string, bids: RevealedBid[], params: { [key: string]: JsonValue }): Selection | null {
  const domains = (params.domains as string[] | undefined) ?? [];
  const min = typeof params.minConfidence === "number" ? params.minConfidence : 60;
  if (domains.length === 0) return null;

  const eligible = bids.map((bid) => ({
    bid,
    covers: domains.filter((d) => (bid.coverage[d] ?? 0) >= min),
    key: tieBreak(taskId, bid.bidder),
  }));

  let best: typeof eligible | null = null;
  const setKey = (set: typeof eligible) => set.map((e) => e.key).sort().join(",");
  // Exhaustive over subsets — bid pools are small by construction, and the
  // verifier mirrors exactly this enumeration order-independently.
  for (let mask = 1; mask < 1 << eligible.length; mask++) {
    const subset = eligible.filter((_, i) => mask & (1 << i));
    const covered = new Set(subset.flatMap((e) => e.covers));
    if (!domains.every((d) => covered.has(d))) continue;
    if (
      best === null ||
      subset.length < best.length ||
      (subset.length === best.length && setKey(subset) < setKey(best))
    ) {
      best = subset;
    }
  }
  if (!best) return null;

  const byKey = (a: { key: string }, b: { key: string }) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const ordered = [...best].sort(byKey);
  const synthesizer =
    ordered.length > 1
      ? [...ordered].sort((a, b) => b.covers.length - a.covers.length || byKey(a, b))[0].bid.bidder
      : null;
  return {
    winningBids: ordered.map((e) => e.bid.digest),
    performers: ordered.map((e) => e.bid.bidder),
    synthesizer,
  };
}

const REGISTRY: Record<
  string,
  (taskId: string, bids: RevealedBid[], params: { [key: string]: JsonValue }) => Selection | null
> = { ranking, coverage };

export function knownRule(name: string): boolean {
  return name in REGISTRY;
}

/** Run a named rule. Throws on an unknown name — never silently skips (Decision 3). */
export function runRule(rule: SelectionRule, taskId: string, bids: RevealedBid[]): Selection | null {
  const fn = REGISTRY[rule.name];
  if (!fn) throw new Error(`unknown selection rule ${rule.name} — not in the registry`);
  return fn(taskId, bids, rule.params);
}
