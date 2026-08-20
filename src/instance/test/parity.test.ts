/**
 * Cross-implementation parity: the writer and the verifier must compute the
 * same answers from the same bytes.
 *
 * The dual implementation *is* the verifiability guarantee — a hub's award is
 * trustworthy because a second, independent implementation reaches it too.
 * That holds only while the two agree, and they drift in ways unit tests
 * written on one side cannot see: a JSON number serialized `100.0` instead of
 * `100`, a timestamp carrying an offset instead of `Z`, a field arriving as a
 * string where a list was meant. Each of those shipped as a real divergence
 * during ADR-0004 and is pinned here.
 *
 * Cases live in `src/verifier/test/parity/cases.json` as raw JSON and are read
 * by both sides. They are deliberately not generated in either language:
 * authoring them in JS would serialize `100.0` back to `100` and the case
 * could never fail.
 *
 *   node --experimental-sqlite --test test/parity.test.ts
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runReputationRule, type PinnedSettlement } from "../src/allocation/reputation.ts";
import { instantMillis } from "../src/crypto/time.ts";
import { voterWeights } from "../src/hub/weights.ts";

const PARITY_DIR = join(import.meta.dirname, "..", "..", "verifier", "test", "parity");
const CASES_PATH = join(PARITY_DIR, "cases.json");

interface Cases {
  reputation: { name: string; bidder: string; settlements: PinnedSettlement[] }[];
  instants: string[];
  weights: { name: string; voters: [string, string][] }[];
}

/** The TypeScript side's answers, keyed exactly as the Python runner keys its own. */
function typescriptResults(cases: Cases): Record<string, unknown> {
  const results: Record<string, unknown> = {};
  for (const testCase of cases.reputation) {
    const key = `reputation:${testCase.name}`;
    try {
      results[key] = runReputationRule(
        { name: "divergence-decay", params: {} },
        testCase.settlements,
        testCase.bidder,
      );
    } catch (error) {
      results[key] = `THREW: ${(error as Error).constructor.name}`;
    }
  }
  for (const testCase of cases.weights) {
    const key = `weights:${testCase.name}`;
    try {
      results[key] = voterWeights(testCase.voters.map(([agent, instance]) => ({ agent, instance })));
    } catch (error) {
      results[key] = `THREW: ${(error as Error).constructor.name}`;
    }
  }
  for (const value of cases.instants) {
    results[`instant:${value}`] = instantMillis(value);
  }
  return results;
}

function pythonResults(): Record<string, unknown> {
  const output = execFileSync("python3", [join(PARITY_DIR, "run_parity.py"), CASES_PATH], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output);
}

describe("cross-implementation parity (writer vs verifier)", () => {
  const cases = JSON.parse(readFileSync(CASES_PATH, "utf8")) as Cases;

  it("both implementations answer identically on every shared case", () => {
    const ts = typescriptResults(cases);
    const py = pythonResults();

    const keys = [...new Set([...Object.keys(ts), ...Object.keys(py)])].sort();
    // Compare canonically: a weights map is an object, and object key order
    // is not semantic — JCS sorts keys before anything is signed, and the
    // Python runner serializes with sort_keys. Comparing raw JSON.stringify
    // would report an ordering artefact as a divergence.
    const canonical = (v: unknown): string =>
      v !== null && typeof v === "object" && !Array.isArray(v)
        ? JSON.stringify(Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => (a < b ? -1 : 1))))
        : JSON.stringify(v);
    const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
    const divergent = keys
      .filter((key) => !same(ts[key], py[key]))
      .map((key) => `  ${key}\n    writer=${JSON.stringify(ts[key])}  verifier=${JSON.stringify(py[key])}`);

    assert.equal(
      divergent.length,
      0,
      `the two implementations disagree on ${divergent.length} case(s):\n${divergent.join("\n")}`,
    );
    assert.ok(keys.length >= cases.reputation.length + cases.instants.length + cases.weights.length);
  });

  // A parity harness that silently compares nothing would be worse than none:
  // it would report agreement forever. These pin the cases whose two possible
  // answers actually differ, so a regression shows up as a real disagreement
  // rather than as two matching neutral priors.
  it("the regression cases are discriminating, not accidentally equal", () => {
    const score = (name: string) => {
      const testCase = cases.reputation.find((c) => c.name === name)!;
      return runReputationRule({ name: "divergence-decay", params: {} }, testCase.settlements, testCase.bidder);
    };

    assert.equal(score("integer-valued float estimate is usable, not skipped"), 100, "usable → 100, skipped → 50");
    assert.equal(score("float estimate, wildly over — must not collapse to the neutral prior"), 0, "usable → 0, skipped → 50");
    assert.equal(score("genuine fraction is skipped on both sides"), 50);
    assert.equal(score("dissentVindicated as a string must not substring-match"), 50, "substring match would be 100");
    assert.equal(score("dissentVindicated as a proper list still counts"), 100);
    assert.equal(score("no history at all is the neutral prior"), 50);

    // Chronology, not lexicography: the -01:00 settlement is the later one, so
    // its 200%-over divergence carries the heavier decay weight.
    assert.equal(score("recency ordering: negative UTC offset is chronologically later than Z"), 33);
    assert.notEqual(instantMillis("2026-01-01T00:00:00-01:00"), instantMillis("2026-01-01T00:00:00Z"));
    assert.equal(instantMillis("2026-01-01T00:00:00.000Z"), instantMillis("2026-01-01T00:00:00Z"));
    assert.equal(instantMillis("not-a-timestamp"), 0, "unparseable is 0, never NaN — NaN in a sort key is unspecified");

    // The weighting's whole point is that these two are the same total.
    const w = (name: string) => {
      const c = cases.weights.find((x) => x.name === name)!;
      return voterWeights(c.voters.map(([agent, instance]) => ({ agent, instance })));
    };
    const solo = w("single instance reduces to the uniform weight of 1");
    assert.deepEqual(Object.values(solo), [1, 1, 1, 1], "one instance must still weigh 1 per voter");

    const three = w("three instances, unequal headcounts, equal totals");
    assert.deepEqual(three, { a1: 2, a2: 2, a3: 2, b1: 3, b2: 3, c1: 6 });
    const total = (weights: Record<string, number>, prefix: string) =>
      Object.entries(weights).filter(([a]) => a.startsWith(prefix)).reduce((s, [, v]) => s + v, 0);
    assert.equal(total(three, "a"), 6);
    assert.equal(total(three, "b"), 6);
    assert.equal(total(three, "c"), 6);

    // One operator with one agent must not be outvoted by one with five.
    const lopsided = w("one against many — the attack this exists to stop");
    assert.equal(total(lopsided, "a"), total(lopsided, "b"), "five agents buy no more say than one");

    assert.deepEqual(w("input order does not change the result"), three, "ordering is not an input");
  });
});
