/**
 * ADR-0030 — "the gate is the index itself": every scenario's coverage
 * section carries one class per acceptance criterion, drawn from a closed
 * set, naming evidence that actually exists (a demo this gate runs, or a
 * test file on disk), its counts add up, and the support index's summary
 * cell agrees with the section it links to. No scenario prose is edited
 * here — a violation is reported, not fixed; the scenario author fixes it.
 *
 *   node --experimental-sqlite --test test/adr0030.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DEMOS_IN_GATE } from "./demos.test.ts";

const SCENARIOS_DIR = join(import.meta.dirname, "..", "..", "..", "docs", "afp", "scenarios");
const PACKAGE_JSON = join(import.meta.dirname, "..", "package.json");
const TEST_DIR = import.meta.dirname;

const CLASSES = ["workload demonstrated", "mechanism gated", "narrowed", "edge not built"] as const;
type Class = (typeof CLASSES)[number];

const SKIP = new Set(["08-the-subcontract-story.md", "the-operators-tuesday.md"]);

/** One `| a | b | c |` row, cells trimmed, leading/trailing empties dropped. */
function tableRows(section: string): string[][] {
  return section
    .split("\n")
    .filter((line) => /^\|.*\|$/.test(line.trim()) && !/^\|[\s:|-]+\|$/.test(line.trim()))
    .map((line) =>
      line
        .trim()
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    );
}

/** The markdown section from a `## `/`### ` heading to the next same-or-higher heading. */
function sectionAt(text: string, headingLine: string): string {
  const lines = text.split("\n");
  const start = lines.indexOf(headingLine);
  const level = (headingLine.match(/^#+/) ?? ["##"])[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s/);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/**
 * The anchor GitHub gives a heading: lowercased, punctuation dropped, spaces
 * to hyphens — so `## Coverage as of 2026-09-13 (re-walk)` links as
 * `#coverage-as-of-2026-09-13-re-walk`. A re-walk section (ADR-0030
 * Decision 2) can then share its date with the section it follows and still
 * be the one the index points at.
 */
function slugOf(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9 \-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function scenarioFiles(): string[] {
  return readdirSync(SCENARIOS_DIR)
    .filter((name) => /^\d\d-.*\.md$/.test(name) && !SKIP.has(name))
    .sort();
}

const packageScripts: Record<string, string> = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")).scripts ?? {};

interface Parsed {
  file: string;
  text: string;
  acceptanceRows: string[][];
  coverageHeadingLine: string | null;
  coverageDate: string | null;
  /** GitHub-style slug of the current section's heading — what the README's Coverage cell must link to. */
  coverageAnchor: string | null;
  coverageRows: string[][];
  countsLine: string | null;
}

function parse(file: string): Parsed {
  const text = readFileSync(join(SCENARIOS_DIR, file), "utf8");
  const lines = text.split("\n");

  const acceptanceHeading = lines.find((l) => /^## Acceptance criteria/.test(l)) ?? null;
  const acceptanceRows = acceptanceHeading
    ? tableRows(sectionAt(text, acceptanceHeading)).slice(1) // drop header row
    : [];

  const coverageHeadings = lines.filter((l) => /^## Coverage as of \d{4}-\d{2}-\d{2}/.test(l));
  const lastHeading = coverageHeadings.length ? coverageHeadings[coverageHeadings.length - 1] : null;
  const coverageDate = lastHeading ? (lastHeading.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? null) : null;
  const coverageAnchor = lastHeading ? slugOf(lastHeading.replace(/^#+\s*/, "")) : null;
  const coverageSection = lastHeading ? sectionAt(text, lastHeading) : "";
  const coverageRows = lastHeading ? tableRows(coverageSection).slice(1) : [];
  const countsLine = coverageSection.split("\n").find((l) => l.trim().startsWith("**Counts:**")) ?? null;

  return { file, text, acceptanceRows, coverageHeadingLine: lastHeading, coverageDate, coverageAnchor, coverageRows, countsLine };
}

describe("ADR-0030: the coverage index is the gate", () => {
  const files = scenarioFiles();
  assert.ok(files.length >= 13, `expected at least 13 numbered scenarios, found ${files.length}`);

  for (const file of files) {
    const p = parse(file);

    it(`G1 — ${file} has a current "## Coverage as of <date>" section`, () => {
      if (!p.acceptanceRows.length) return; // no acceptance-criteria heading at all is its own failure below
      assert.ok(
        p.coverageHeadingLine,
        `${file}: has an "## Acceptance criteria" section but no "## Coverage as of <date>" section`,
      );
    });

    it(`G1b — ${file} has an "## Acceptance criteria" heading`, () => {
      assert.ok(p.acceptanceRows.length > 0, `${file}: no "## Acceptance criteria" table found (or it is empty)`);
    });

    if (!p.coverageHeadingLine || !p.acceptanceRows.length) continue;

    it(`G2 — ${file} coverage rows have a valid Class and match the criteria count`, () => {
      const violations: string[] = [];
      for (const row of p.coverageRows) {
        const cls = row[1];
        if (!CLASSES.includes(cls as Class)) {
          violations.push(`  bad Class "${cls}" in row: ${row.join(" | ")}`);
        }
      }
      if (p.coverageRows.length !== p.acceptanceRows.length) {
        violations.push(
          `  row count mismatch: ${p.coverageRows.length} coverage rows vs ${p.acceptanceRows.length} acceptance criteria`,
        );
      }
      assert.equal(violations.length, 0, `${file}:\n${violations.join("\n")}`);
    });

    it(`G3 — ${file} "workload demonstrated" rows cite a demo this gate runs`, () => {
      const violations: string[] = [];
      for (const row of p.coverageRows) {
        if (row[1] !== "workload demonstrated") continue;
        const evidence = row[2] ?? "";
        const m = evidence.match(/^`npm run (demo(?::[\w-]+)?)`/);
        if (!m) {
          violations.push(`  row does not begin with a backticked "npm run demo..." : ${row.join(" | ")}`);
          continue;
        }
        const script = m[1];
        if (!(script in packageScripts)) {
          violations.push(`  script "${script}" is not in package.json: ${row.join(" | ")}`);
        }
        if (script.endsWith(":llm")) {
          violations.push(`  "${script}" is a :llm variant, not a CI gate: ${row.join(" | ")}`);
        }
        if (!DEMOS_IN_GATE.includes(script)) {
          violations.push(`  "${script}" is not run by test/demos.test.ts (DEMOS_IN_GATE): ${row.join(" | ")}`);
        }
      }
      assert.equal(violations.length, 0, `${file}:\n${violations.join("\n")}`);
    });

    it(`G4 — ${file} "mechanism gated"/"narrowed" rows cite a test file that exists`, () => {
      const violations: string[] = [];
      for (const row of p.coverageRows) {
        if (row[1] !== "mechanism gated" && row[1] !== "narrowed") continue;
        const evidence = row[2] ?? "";
        const m = evidence.match(/^`(test\/[\w.-]+\.test\.ts)`/);
        if (!m) {
          violations.push(`  row does not begin with a backticked "test/<name>.test.ts": ${row.join(" | ")}`);
          continue;
        }
        const path = join(TEST_DIR, "..", m[1]);
        if (!existsSync(path)) violations.push(`  ${m[1]} does not exist: ${row.join(" | ")}`);
      }
      assert.equal(violations.length, 0, `${file}:\n${violations.join("\n")}`);
    });

    it(`G5 — ${file} Counts line matches the row classes and totals the row count`, () => {
      assert.ok(p.countsLine, `${file}: no "**Counts:**" line found in the coverage section`);
      const counts: Partial<Record<Class, number>> = {};
      const re = /(\d+)\s+(demonstrated|gated|narrowed|not built)/g;
      let m: RegExpExecArray | null;
      const label: Record<string, Class> = {
        demonstrated: "workload demonstrated",
        gated: "mechanism gated",
        narrowed: "narrowed",
        "not built": "edge not built",
      };
      while ((m = re.exec(p.countsLine!))) counts[label[m[2]]] = Number(m[1]);

      const actual: Record<Class, number> = {
        "workload demonstrated": 0,
        "mechanism gated": 0,
        narrowed: 0,
        "edge not built": 0,
      };
      for (const row of p.coverageRows) {
        const cls = row[1] as Class;
        if (cls in actual) actual[cls]++;
      }

      const violations: string[] = [];
      for (const cls of CLASSES) {
        if ((counts[cls] ?? -1) !== actual[cls]) {
          violations.push(`  ${cls}: Counts line says ${counts[cls] ?? "(missing)"}, rows say ${actual[cls]}`);
        }
      }
      const declaredTotal = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
      if (declaredTotal !== p.coverageRows.length) {
        violations.push(`  Counts line sums to ${declaredTotal}, but there are ${p.coverageRows.length} rows`);
      }
      assert.equal(violations.length, 0, `${file}: ${p.countsLine}\n${violations.join("\n")}`);
    });
  }

  it("G6 — README's coverage cells match each scenario's current section", () => {
    const readmeText = readFileSync(join(SCENARIOS_DIR, "README.md"), "utf8");
    const violations: string[] = [];

    for (const file of files) {
      const p = parse(file);
      if (!p.coverageHeadingLine || !p.countsLine) continue; // reported by the per-file checks above

      const counts: Record<Class, number> = { "workload demonstrated": 0, "mechanism gated": 0, narrowed: 0, "edge not built": 0 };
      for (const row of p.coverageRows) {
        const cls = row[1] as Class;
        if (cls in counts) counts[cls]++;
      }
      const expectedCell = `${counts["workload demonstrated"]}·${counts["mechanism gated"]}·${counts.narrowed}·${counts["edge not built"]}`;
      const anchor = `${file}#${p.coverageAnchor}`;

      const candidateRows =
        readmeText.match(new RegExp(`^\\|\\s*\\[\\d+\\]\\(${file.replace(".", "\\.")}\\).*$`, "gm")) ?? [];
      const supportRow = candidateRows.find((line) => line.includes("#coverage-as-of-"));
      if (!supportRow) {
        violations.push(`  ${file}: no support-index row with a Coverage cell found in README.md`);
        continue;
      }
      const cellMatch = supportRow.match(/\[([\d·]+)\]\(([^)]+)\)\s*\|?\s*$/);
      if (!cellMatch) {
        violations.push(`  ${file}: support-index row has no "[a·b·c·d](anchor)" Coverage cell: ${supportRow}`);
        continue;
      }
      const [, cell, link] = cellMatch;
      if (cell !== expectedCell) {
        violations.push(`  ${file}: README Coverage cell is [${cell}], current section counts are [${expectedCell}]`);
      }
      if (link !== anchor) {
        violations.push(`  ${file}: README Coverage link is (${link}), current section anchor is (${anchor})`);
      }
    }

    assert.equal(violations.length, 0, `docs/afp/scenarios/README.md:\n${violations.join("\n")}`);
  });
});
