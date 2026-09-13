#!/usr/bin/env node
/**
 * ADR-0034 Decision 2 — "the shipped bundles, moved out of `export-*`".
 *
 * Runs each demo the support index lists under "See it run", with stub
 * brains and deterministic clocks, exactly as `src/instance/test/demos.test.ts`
 * does — into a temp workspace, not the repo's own `data-pN`/`export-pN` — and
 * copies the resulting bundle(s) into `fixtures/<name>/`, alongside a
 * `VERIFY.json` naming the verifier invocation that replays it.
 *
 * A fixture is a **frozen artifact**, not a reproducible build: the keys and
 * timestamps embedded in a bundle differ across runs of this script (fresh
 * keypairs, and `fixedClock()`/`jumpClock()` start from a wall-clock-free but
 * still per-run-generated key). Re-running this script produces a bundle that
 * still verifies, but is not byte-identical to the one it replaces — that is
 * expected and is why the fixtures are committed rather than regenerated in
 * CI.
 *
 * Usage: node scripts/refresh-fixtures.mjs
 */

import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ADR-0025 Decision 1: the gate — and this script, which reproduces exactly
// what the gate runs — uses real HTTP servers over plain `http://127.0.0.1`
// origins, same as `src/instance/test/helpers.ts`.
if (process.env.AFP_DEV === undefined) process.env.AFP_DEV = "1";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INSTANCE_DIR = join(REPO_ROOT, "src", "instance");
const FIXTURES_DIR = join(REPO_ROOT, "fixtures");

const { runDemo, fixedClock } = await import(join(INSTANCE_DIR, "src", "demo.ts"));
const { runP2Demo } = await import(join(INSTANCE_DIR, "src", "demoP2.ts"));
const { runP3Demo } = await import(join(INSTANCE_DIR, "src", "demoP3.ts"));
const { runP4Demo } = await import(join(INSTANCE_DIR, "src", "demoP4.ts"));
const { runP5Demo } = await import(join(INSTANCE_DIR, "src", "demoP5.ts"));
const { runP6Demo } = await import(join(INSTANCE_DIR, "src", "demoP6.ts"));
const { runP7Demo } = await import(join(INSTANCE_DIR, "src", "demoP7.ts"));
const { runP8Demo } = await import(join(INSTANCE_DIR, "src", "demoP8.ts"));

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "afp-fixture-"));
  return { dataDir: join(root, "data"), exportDir: join(root, "export"), brain: "stub" };
}

/** Copy `src` (a directory) into `fixtures/<name>/<label>`, relative dir returned. */
function copyBundle(name, label, srcDir) {
  const dest = join(FIXTURES_DIR, name, label);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(srcDir, dest, { recursive: true });
  return label;
}

/** The manifest digest a human skimming the report can eyeball. */
function manifestDigest(bundleDir) {
  const manifestPath = join(bundleDir, "MANIFEST.json");
  const bytes = readFileSync(manifestPath);
  return createHash("sha256").update(bytes).digest("hex");
}

function writeVerify(name, bundles, thread) {
  const doc = { bundles, thread: thread ?? null };
  writeFileSync(join(FIXTURES_DIR, name, "VERIFY.json"), `${JSON.stringify(doc, null, 2)}\n`);
}

async function main() {
  const report = [];

  // p1 — demo / demo:offline's writer/editor thread.
  {
    const { instance, exported, thread } = await runDemo({ fresh: true, config: workspace(), clock: fixedClock() });
    const label = copyBundle("p1", "export", exported.dir);
    instance.close();
    writeVerify("p1", [label], thread);
    report.push(["p1", [join(FIXTURES_DIR, "p1", label)]]);
  }

  // p2 — the weighted quorum round.
  {
    const { instance, exported, thread } = await runP2Demo({ fresh: true, config: workspace() });
    const label = copyBundle("p2", "export", exported.dir);
    instance.close();
    writeVerify("p2", [label], thread);
    report.push(["p2", [join(FIXTURES_DIR, "p2", label)]]);
  }

  // p3 — the estimation panel's synthesis.
  {
    const { instance, exported, threads } = await runP3Demo({ fresh: true, config: workspace() });
    const label = copyBundle("p3", "export", exported.dir);
    instance.close();
    writeVerify("p3", [label], threads.estimate);
    report.push(["p3", [join(FIXTURES_DIR, "p3", label)]]);
  }

  // p4 — the federation handshake's two exports, jointly replayed.
  {
    const paths = workspace();
    const demo = await runP4Demo({ rootDir: paths.dataDir, exportRoot: paths.exportDir });
    const alpha = copyBundle("p4", "alpha", demo.exports.alpha.dir);
    const beta = copyBundle("p4", "beta", demo.exports.beta.dir);
    await demo.close();
    writeVerify("p4", [alpha, beta], null);
    report.push(["p4", [alpha, beta].map((l) => join(FIXTURES_DIR, "p4", l))]);
  }

  // p5 — the three-operator incident bridge.
  {
    const paths = workspace();
    const demo = await runP5Demo({ rootDir: paths.dataDir, exportRoot: paths.exportDir });
    const alpha = copyBundle("p5", "alpha", demo.exports.alpha.dir);
    const bravo = copyBundle("p5", "bravo", demo.exports.bravo.dir);
    const gamma = copyBundle("p5", "gamma", demo.exports.gamma.dir);
    await demo.close();
    writeVerify("p5", [alpha, bravo, gamma], demo.incidentThread);
    report.push(["p5", [alpha, bravo, gamma].map((l) => join(FIXTURES_DIR, "p5", l))]);
  }

  // p6 — the five-reinsurer parametric round.
  {
    const paths = workspace();
    const demo = await runP6Demo({ rootDir: paths.dataDir, exportRoot: paths.exportDir });
    const labels = Object.keys(demo.exports).map((name) => copyBundle("p6", name, `${demo.exportRoot}/${name}`));
    await demo.close();
    writeVerify("p6", labels, null);
    report.push(["p6", labels.map((l) => join(FIXTURES_DIR, "p6", l))]);
  }

  // p7 — the four-desk quarterly split.
  {
    const paths = workspace();
    const demo = await runP7Demo({ rootDir: paths.dataDir, exportRoot: paths.exportDir });
    const labels = Object.keys(demo.exports).map((name) => copyBundle("p7", name, `${demo.exportRoot}/${name}`));
    await demo.close();
    writeVerify("p7", labels, null);
    report.push(["p7", labels.map((l) => join(FIXTURES_DIR, "p7", l))]);
  }

  // p8 — the port-agent triage loop.
  {
    const paths = workspace();
    const demo = await runP8Demo({ fresh: true, config: { dataDir: paths.dataDir, exportDir: paths.exportDir } });
    const label = copyBundle("p8", "export", demo.exported.dir);
    demo.instance.close();
    writeVerify("p8", [label], demo.thread);
    report.push(["p8", [join(FIXTURES_DIR, "p8", label)]]);
  }

  console.log("fixtures refreshed:\n");
  for (const [name, dirs] of report) {
    for (const dir of dirs) {
      console.log(`  ${name}: ${dir}  manifest sha256=${manifestDigest(dir)}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
