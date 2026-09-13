/**
 * ADR-0034 Decision 2 — the compatibility gate every phase ADR carries
 * ("every shipped bundle replays unchanged"), finally over bundles that are
 * actually shipped (`fixtures/`, committed) rather than re-generated on
 * every gate run. Each fixture's `VERIFY.json` names the verifier
 * invocation `scripts/refresh-fixtures.mjs` recorded when it produced the
 * bundle; this test reconstructs that invocation and asserts PASSED.
 *
 *   node --experimental-sqlite --test test/fixtures.test.ts
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runVerifier, runVerifierMulti } from "./helpers.ts";

const FIXTURES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures");
const VERIFIER = join(import.meta.dirname, "..", "..", "verifier", "afp_verify.py");

interface VerifySpec {
  bundles: string[];
  thread: string | null;
}

function fixtureNames(): string[] {
  return readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

describe("ADR-0034 Decision 2: every shipped fixture replays unchanged", () => {
  for (const name of fixtureNames()) {
    it(`${name} — replays PASSED per its VERIFY.json`, () => {
      const fixtureDir = join(FIXTURES_DIR, name);
      const spec: VerifySpec = JSON.parse(readFileSync(join(fixtureDir, "VERIFY.json"), "utf8"));
      const dirs = spec.bundles.map((b) => join(fixtureDir, b));

      const result =
        dirs.length === 1 && spec.thread
          ? runVerifier(VERIFIER, dirs[0], spec.thread, ["--verbose"])
          : spec.thread
            ? runVerifierMulti(VERIFIER, dirs, ["--thread", spec.thread, "--verbose"])
            : runVerifierMulti(VERIFIER, dirs, ["--verbose"]);

      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /PASSED/);
    });
  }
});
