/**
 * ADR-0030 Decision 4 — "demos are gates": every demo the scenarios' support
 * index (`docs/afp/scenarios/README.md` § Is this workload supported?) lists
 * under "See it run" runs here too, into an isolated workspace, and its
 * exported bundle(s) replay clean under the verifier. A demo that stops
 * producing a passing bundle fails this file — which is what CI runs
 * (the CI wiring itself is [ADR-0034](../../../docs/afp/adr/0034-release-conformance-and-disclosure.md)'s,
 * not built here). `:llm` variants are judgement checks, not gates, and stay
 * out of this file by design.
 *
 * Every run below is pinned to isolated `dataDir`/`exportDir` (or
 * `rootDir`/`exportRoot`) paths from `workspace()` — never the repo's own
 * `./data-pN`/`./export-pN` — so this file cannot clobber an operator's own
 * demo run and can run its own cases concurrently with everything else in
 * the gate.
 *
 *   node --experimental-sqlite --test test/demos.test.ts
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { runP2Demo } from "../src/demoP2.ts";
import { runP3Demo } from "../src/demoP3.ts";
import { runP4Demo } from "../src/demoP4.ts";
import { runP5Demo } from "../src/demoP5.ts";
import { runP6Demo } from "../src/demoP6.ts";
import { runP7Demo } from "../src/demoP7.ts";
import { runP8Demo } from "../src/demoP8.ts";
import { cleanupWorkspaces, freshDemo, runVerifier, runVerifierMulti, workspace } from "./helpers.ts";

const VERIFIER = join(import.meta.dirname, "..", "..", "verifier", "afp_verify.py");

/**
 * The demos this file runs, named the way the support index and
 * `package.json` name them. ADR-0030 Decision 4's rule ("every 'workload
 * demonstrated' names a demo that CI runs") is `test/adr0030.test.ts` G3's
 * check, and this is the list it checks against — `demo`/`demo:offline`
 * share one gate (same code path, `AFP_BRAIN=stub` is already the default).
 */
export const DEMOS_IN_GATE = ["demo", "demo:offline", "demo:p2", "demo:p3", "demo:p4", "demo:p5", "demo:p6", "demo:p7", "demo:p8"];

after(cleanupWorkspaces);

describe("ADR-0030 WP-4: every demo is a gate", () => {
  it("demo / demo:offline — P1's writer/editor thread exports and replays clean", async () => {
    const { instance, exported, thread } = await freshDemo();
    const result = runVerifier(VERIFIER, exported.dir, thread);
    instance.close();
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /PASSED/);
  });

  it("p2 — the weighted quorum round exports and replays clean", async () => {
    const { instance, exported, thread } = await runP2Demo({ fresh: true, config: workspace() });
    const result = runVerifier(VERIFIER, exported.dir, thread, ["--verbose"]);
    instance.close();
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /PASSED/);
  });

  it("p3 — the estimation panel's synthesis exports and replays clean", async () => {
    const { instance, exported, threads } = await runP3Demo({ fresh: true, config: workspace() });
    const result = runVerifier(VERIFIER, exported.dir, threads.estimate, ["--verbose"]);
    instance.close();
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /PASSED/);
  });

  it("p4 — the federation handshake's two exports jointly replay clean", async () => {
    const paths = workspace();
    const demo = await runP4Demo({ rootDir: paths.dataDir, exportRoot: paths.exportDir });
    const result = runVerifierMulti(VERIFIER, [demo.exports.alpha.dir, demo.exports.beta.dir], ["--verbose"]);
    await demo.close();
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /PASSED/);
  });

  it("p5 — the three-operator incident bridge's exports jointly replay clean", async () => {
    const paths = workspace();
    const demo = await runP5Demo({ rootDir: paths.dataDir, exportRoot: paths.exportDir });
    const dirs = [demo.exports.alpha.dir, demo.exports.bravo.dir, demo.exports.gamma.dir];
    const result = runVerifierMulti(VERIFIER, dirs, ["--thread", demo.incidentThread, "--verbose"]);
    await demo.close();
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /PASSED/);
  });

  it("p6 — the five-reinsurer parametric round's exports jointly replay clean", async () => {
    const paths = workspace();
    const demo = await runP6Demo({ rootDir: paths.dataDir, exportRoot: paths.exportDir });
    const dirs = Object.keys(demo.exports).map((name) => `${demo.exportRoot}/${name}`);
    const result = runVerifierMulti(VERIFIER, dirs, ["--verbose"]);
    await demo.close();
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /PASSED/);
  });

  it("p7 — the four-desk quarterly split's exports jointly replay clean", async () => {
    const paths = workspace();
    const demo = await runP7Demo({ rootDir: paths.dataDir, exportRoot: paths.exportDir });
    const dirs = Object.keys(demo.exports).map((name) => `${demo.exportRoot}/${name}`);
    const result = runVerifierMulti(VERIFIER, dirs, ["--verbose"]);
    await demo.close();
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /PASSED/);
  });

  it("p8 — the port-agent triage loop exports and replays clean", async () => {
    const paths = workspace();
    const demo = await runP8Demo({ fresh: true, config: { dataDir: paths.dataDir, exportDir: paths.exportDir } });
    const result = runVerifier(VERIFIER, demo.exported.dir, demo.thread, ["--verbose"]);
    demo.instance.close();
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /PASSED/);
  });
});
