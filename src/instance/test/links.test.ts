/**
 * ADR-0034 Decision 2 — runs `scripts/check-links.mjs` (the link-and-anchor
 * check) and asserts it exits 0. The script does its own printing; this test
 * only asserts the gate.
 *
 *   node --experimental-sqlite --test test/links.test.ts
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";

const SCRIPT = join(import.meta.dirname, "..", "..", "..", "scripts", "check-links.mjs");

describe("ADR-0034 Decision 2: docs link-and-anchor check", () => {
  it("every relative link and anchor under docs/ resolves", () => {
    try {
      const output = execFileSync("node", [SCRIPT], { encoding: "utf8" });
      assert.match(output, /^ok —/);
    } catch (error) {
      const err = error as { status?: number; stdout?: string; stderr?: string };
      assert.fail(`check-links.mjs failed (exit ${err.status}):\n${err.stdout ?? ""}${err.stderr ?? ""}`);
    }
  });
});
