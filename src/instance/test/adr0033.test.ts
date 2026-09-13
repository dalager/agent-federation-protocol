/**
 * ADR-0033 gate — the ADR's own gate paragraph, numbered G1–G6, plus every
 * primitive the four work packages built underneath it: the signed policy
 * object (Decision 1), the export manifest (Decision 2), the Python
 * verifier's `check_policy` (Decision 3), and the hub-side governance
 * answers (Decision 4).
 *
 * Supersedes `adr0033-wp1.test.ts` and `adr0033-wp3.test.ts` — every
 * assertion from both files is folded in below (WP-1/2/4a's object,
 * manifest, config-reader and hub-side cases; WP-3/4b's `check_policy` and
 * `decision.py` cases), regrouped rather than dropped: 23 cases either way.
 *
 *   node --experimental-sqlite --test test/adr0033.test.ts
 */

import assert from "node:assert/strict";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, describe, it } from "node:test";

import { loadConfig, validate } from "../src/config.ts";
import { AfpInstance, type AgentRegistration } from "../src/instance.ts";
import { jumpClock } from "../src/demoP3.ts";
import { CountingBrain } from "../src/brains/stub.ts";
import { createHttpServer } from "../src/ap/server.ts";
import { policyDocument, validatePolicySpec, type PolicySpec } from "../src/ap/policy.ts";
import { publicKeyFromMultibase } from "../src/crypto/keys.ts";
import { verifyProof, digestOf } from "../src/crypto/proof.ts";
import { exportBundle } from "../src/export.ts";
import { enroll, castVote } from "../src/hub/activities.ts";
import { createSynthesis } from "../src/allocation/activities.ts";
import { contributionDispute } from "../src/hub/summary.ts";
import { GovernanceRefused } from "../src/hub/governance.ts";
import { approveThroughPort, ApprovalRefused } from "../src/ports/approval.ts";
import { vouch } from "../src/ap/activities.ts";
import { cleanupWorkspaces, freshDemo, runVerifier, testHub, testInstance, workspace } from "./helpers.ts";
import { runP8Demo } from "../src/demoP8.ts";
import { VERIFIER } from "./adr0010-fixtures.ts";
import type { JsonValue } from "../src/crypto/jcs.ts";

after(cleanupWorkspaces);

const CAPABILITY = "afp:cap:assess";
const AGENTS = ["victim", "bystander", "third"] as const;
const HUB_ID = "governance";

type Governance = { subjectPrecondition: "any-member" | "proof-or-dispute-on-record"; electorateFloor: "refuse" | "no-decision:electorate-exhausted" };

/** A hub with three enrolled agents. Shared by every describe block below —
 * the two source files this one supersedes each had their own copy under
 * this same name; kept as one now that they are one file. */
function bridge(options: { seatPolicy?: "follow-required" | "enroll-implies-seat"; governance?: Governance; controllers?: readonly string[] } = {}) {
  const { instance, config, clock } = testInstance([...AGENTS], CAPABILITY);
  if (options.seatPolicy) config.policy.seatPolicy = options.seatPolicy;
  if (options.governance) config.policy.governance = options.governance;
  if (options.controllers) config.policy.controllers = [...options.controllers];
  const { hub } = testHub(instance, [...AGENTS], HUB_ID, { seatPolicy: options.seatPolicy, governance: options.governance });
  const thread = `${config.origin}/threads/enroll`;
  for (const agent of AGENTS) {
    hub.receive(
      instance.publishAsInstance([hub.actorId], thread, "hub", (envelope) =>
        enroll(envelope, {
          agent: instance.actorId(agent),
          hub: hub.actorId,
          capabilities: [CAPABILITY],
          hubKey: `${instance.actorId(agent)}#${HUB_ID}`,
        }),
      ).activity,
    );
  }
  return { instance, config, clock, hub, thread };
}
type Bridge = ReturnType<typeof bridge>;

function exportOf(t: Bridge) {
  t.instance.publishAsInstance([], `${t.config.origin}/threads/roster`, "public", (envelope) =>
    vouch(envelope, { agent: t.hub.actorId, capabilities: ["afp:cap:hub"], keyCustody: "self" }),
  );
  return exportBundle(t.instance, t.config.exportDir, [t.hub]);
}

/** Copy an export, edit `policy.jsonld` or `MANIFEST.json` (or any other
 * bundle file) in place, replay. */
function mutateFile(exportDir: string, thread: string, fileName: string, edit: (doc: Record<string, unknown>) => void) {
  const dir = mkdtempSync(join(tmpdir(), "afp-mut-policy-"));
  cpSync(exportDir, dir, { recursive: true });
  const path = join(dir, fileName);
  const doc = JSON.parse(readFileSync(path, "utf8"));
  edit(doc);
  writeFileSync(path, JSON.stringify(doc, null, 2));
  return runVerifier(VERIFIER, dir, thread, ["--verbose"]);
}

// ================================================================
// G1–G6 — the ADR's own gate paragraph
// ================================================================

describe("ADR-0033 gate", () => {
  it("G1 — a bundle with a policy replays clean and policy: runs (census > 0)", () => {
    const t = bridge();
    const summary = exportOf(t);
    const clean = runVerifier(VERIFIER, summary.dir, t.thread, ["--verbose"]);
    assert.equal(clean.code, 0, clean.output);
    assert.match(clean.output, /PASSED/);
    const census = clean.output.match(/^\s*·\s+.*$/m)?.[0] ?? "";
    const match = census.match(/policy:(\d+)/);
    assert.ok(match && Number(match[1]) > 0, `expected policy:>0 in the census line:\n${census}`);
    t.instance.close();
  });

  it("G2 — a Result whose afp:producedBy names an unlisted brain fails by name", () => {
    const t = bridge();
    t.instance.publish("victim", [t.hub.actorId], t.thread, "hub", (envelope) => ({
      "@context": ["https://www.w3.org/ns/activitystreams", "https://dalager.github.io/agent-federation-protocol/ns/v3.jsonld"],
      id: envelope.activityId,
      actor: envelope.actor,
      to: [...envelope.to],
      published: envelope.published,
      context: envelope.thread,
      "afp:visibility": envelope.visibility,
      ...(envelope.prevActivity !== null ? { "afp:prevActivity": envelope.prevActivity } : {}),
      type: "Create",
      object: {
        id: `${envelope.actor}/results/g2-2`,
        type: "afp:Result",
        "afp:correlationId": "g2-2",
        content: "n/a",
        attributedTo: envelope.actor,
        "afp:producedBy": "an-unlisted-brain/9",
      },
    }));
    const summary = exportOf(t);
    const out = runVerifier(VERIFIER, summary.dir, t.thread, ["--verbose"]);
    assert.notEqual(out.code, 0);
    assert.match(out.output, /FAIL \] policy: .*afp:producedBy names a listed brain/);
    assert.match(out.output, /an-unlisted-brain\/9/);
    t.instance.close();
  });

  it("G3 — an approval by an unlisted controller fails by name (the mutated afp:externalRef)", async () => {
    const CONTROLLER = "https://controller.example/actor";
    const ACTION_POLICY = { approve: "grant-access", reject: "deny-access", "afp:no-verdict": "deny-access" };
    const t = bridge({ controllers: [CONTROLLER] });
    const thread = `${t.config.origin}/threads/approve-g3`;
    t.instance.delegate({
      from: "victim",
      to: "bystander",
      capability: CAPABILITY,
      content: "approve the release?",
      thread,
      correlationId: "g3-approve",
      pins: { actionPolicy: ACTION_POLICY },
    });
    const synthesis = t.instance.publish("bystander", [t.hub.actorId], thread, "hub", (envelope) =>
      createSynthesis(envelope, {
        synthesisId: `${envelope.actor}/syntheses/g3-approve`,
        method: "assess",
        answer: "release",
        confidence: 90,
        contributingResults: [],
        assumptions: [],
        dissent: [],
        category: "approve",
        absentInputs: [{ correlationId: "g3-approve", errorCode: "afp:no-verdict", digest: null }],
      }),
    ).activity;
    const synthesisDigest = digestOf(synthesis);

    await approveThroughPort(
      t.instance,
      { present: async () => ({ decision: "approve", by: CONTROLLER }) },
      {
        actuatorName: "victim",
        decisionRecordDigest: synthesisDigest,
        thread,
        summary: "approve or reject",
        policy: ACTION_POLICY,
        correlationId: "g3-corr",
      },
    );

    const summary = exportOf(t);
    const out = mutateFile(summary.dir, t.thread, "outbox/victim.jsonld", (doc) => {
      const items = doc.orderedItems as Record<string, unknown>[];
      const result = items.find(
        (a) => (a.object as Record<string, unknown> | undefined)?.["afp:reconciles"] !== undefined,
      )!;
      (result.object as Record<string, unknown>)["afp:externalRef"] = "https://stranger.example/actor";
    });
    assert.notEqual(out.code, 0);
    assert.match(out.output, /FAIL \] policy: .*was approved by an authorized controller/);
    assert.match(out.output, /stranger\.example/);
    t.instance.close();
  });

  it("G4 — a round about an agent with nothing on record is refused at the hub, and fails at replay when spliced in", () => {
    const governance: Governance = { subjectPrecondition: "proof-or-dispute-on-record", electorateFloor: "no-decision:electorate-exhausted" };
    const t = bridge({ governance });
    const subject = t.instance.actorId("third");

    assert.throws(
      () =>
        t.hub.proposeRound({
          round: `${t.config.origin}/rounds/g4-refused`,
          thread: t.thread,
          question: "expel third?",
          options: ["yes", "no"],
          governanceSubject: subject,
        }),
      GovernanceRefused,
    );

    // Put a checkable dispute on record, opening a round about `third`
    // legitimately — then splice the dispute back out of the exported
    // bundle: the round survives (the hub already checked it), but replay
    // must catch the now-groundless afp:governanceSubject.
    const warmup = `${t.config.origin}/rounds/g4-warmup`;
    const proposal = t.hub.proposeRound({ round: warmup, thread: t.thread, question: "ship it?", options: ["yes", "no"] });
    const snapshot = String((proposal.activity.object as Record<string, JsonValue>)["afp:quorumSnapshot"]);
    const thirdVote = t.instance.publish("third", [t.hub.actorId], t.thread, "hub", (envelope) =>
      castVote(envelope, { voteId: `${envelope.actor}/votes/g4-warmup`, round: warmup, hub: t.hub.actorId, proposalHash: proposal.digest, quorumSnapshot: snapshot, value: "yes" }),
    ).activity;
    t.hub.receive(thirdVote);

    const disputeEntry = t.instance.publish("victim", [], t.thread, "public", (envelope) =>
      contributionDispute(envelope, {
        disputeId: `${envelope.actor}/disputes/g4-1`,
        hub: t.hub.actorId,
        summary: `${t.hub.actorId}/summaries/whatever`,
        ground: "quality",
        evidence: [digestOf(thirdVote)],
      }),
    );

    t.hub.proposeRound({
      round: `${t.config.origin}/rounds/g4-opened`,
      thread: t.thread,
      question: "expel third?",
      options: ["yes", "no"],
      governanceSubject: subject,
    });

    const summary = exportOf(t);
    const clean = runVerifier(VERIFIER, summary.dir, t.thread, ["--verbose"]);
    assert.equal(clean.code, 0, clean.output);
    assert.match(clean.output, /policy: .*names afp:governanceSubject .* with a proof or dispute on record/);

    const spliced = mutateFile(summary.dir, t.thread, "outbox/victim.jsonld", (doc) => {
      const items = doc.orderedItems as Record<string, unknown>[];
      const kept = items.filter((a) => digestOf(a as never) !== digestOf(disputeEntry.activity as never));
      doc.orderedItems = kept;
    });
    assert.notEqual(spliced.code, 0);
    assert.match(spliced.output, /FAIL \] policy: .*names afp:governanceSubject .* with a proof or dispute on record/);
    t.instance.close();
  });

  it("G5 — an electorate emptied by recusal closes electorate-exhausted and the reason recomputes; a mutated reason fails by name", () => {
    const t = bridge({ governance: { subjectPrecondition: "any-member", electorateFloor: "no-decision:electorate-exhausted" } });
    const round = `${t.config.origin}/rounds/g5-exhausted`;
    const subject = t.instance.actorId("victim");
    t.hub.proposeRound({
      round,
      thread: t.thread,
      question: "ship it?",
      options: ["yes", "no"],
      quorumRule: { "afp:form": "explicit", "afp:threshold": 3 },
      recused: [{ agent: subject, cause: { "afp:form": "governance-subject" } }],
      governanceSubject: subject,
    });
    const row = t.hub.roundVoters(round);
    assert.equal(row.includes(subject), false, "the recused subject is not among the pinned voters");

    const summary = exportOf(t);
    const clean = runVerifier(VERIFIER, summary.dir, t.thread, ["--verbose"]);
    assert.equal(clean.code, 0, clean.output);
    assert.match(clean.output, /PASSED/);

    // Relabeling a genuinely quorum-impossible close (no recusal at all) as
    // electorate-exhausted must fail: the reason is recomputed, not asserted.
    const t2 = bridge();
    const doomed = `${t2.config.origin}/rounds/g5-doomed`;
    t2.hub.proposeRound({
      round: doomed,
      thread: t2.thread,
      question: "ship it?",
      options: ["yes", "no"],
      quorumRule: { "afp:form": "explicit", "afp:threshold": 4 },
    });
    t2.hub.demandClose(doomed);
    const summary2 = exportOf(t2);
    const mutated = mutateFile(summary2.dir, t2.thread, `outbox/hub-${HUB_ID}.jsonld`, (doc) => {
      const items = doc.orderedItems as Record<string, unknown>[];
      const decision = items.find((a) => (a.object as Record<string, unknown> | undefined)?.type === "afp:DecisionRecord")!;
      (decision.object as Record<string, unknown>)["afp:noDecisionReason"] = "electorate-exhausted";
    });
    assert.notEqual(mutated.code, 0);
    assert.match(mutated.output, /FAIL \] decision: .* no-decision reason is justified/);
    t.instance.close();
    t2.instance.close();
  });

  it("G6 — every shipped bundle replays unchanged: freshDemo and runP8Demo PASSED, now carrying policy.jsonld", async () => {
    const fresh = await freshDemo();
    assert.ok(existsSync(join(fresh.exported.dir, "policy.jsonld")));
    const freshOut = runVerifier(VERIFIER, fresh.exported.dir, fresh.thread, ["--verbose"]);
    assert.equal(freshOut.code, 0, `demo export must verify with a policy present:\n${freshOut.output}`);
    assert.match(freshOut.output, /PASSED/);
    fresh.instance.close();

    const p8 = await runP8Demo({ fresh: true, config: workspace() });
    assert.ok(existsSync(join(p8.exported.dir, "policy.jsonld")));
    const p8Out = runVerifier(VERIFIER, p8.exported.dir, p8.thread, ["--verbose"]);
    assert.equal(p8Out.code, 0, p8Out.output);
    assert.match(p8Out.output, /PASSED/);
    p8.instance.close();
  });
});

// ================================================================
// primitives — every WP-1/2/3/4 assertion, regrouped under the gate
// ================================================================

describe("ADR-0033 primitives", () => {
  describe("Decision 1 — the policy document", () => {
    it("round-trips under the instance key, carrying only the properties given", () => {
      const { instance } = testInstance([...AGENTS], CAPABILITY);
      const spec: PolicySpec = { seatPolicy: "follow-required", defaultVisibility: "internal" };
      const doc = policyDocument(instance.config.origin, spec, instance.signer("@instance"), "2026-09-01T00:00:00Z");

      const method = (instance.instanceDocument().assertionMethod as Record<string, string>[])[0];
      const publicKey = publicKeyFromMultibase(method.publicKeyMultibase);
      assert.equal(verifyProof(doc, publicKey).ok, true, "the policy document did not verify under the instance key");

      assert.equal(doc["afp:seatPolicy"], "follow-required");
      assert.equal(doc["afp:defaultVisibility"], "internal");
      assert.equal(doc["afp:controllers"], undefined, "an unset property must not appear on the wire");
      assert.equal(doc["afp:governance"], undefined);
      assert.equal(doc.type, "afp:Policy");
      instance.close();
    });

    it("validatePolicySpec names every bad value", () => {
      const problems = validatePolicySpec({
        seatPolicy: "sometimes" as never,
        controllers: ["not-a-url"],
        defaultVisibility: "loud" as never,
        threadLayout: { form: "per-vibe" as never, note: "" },
        governance: { subjectPrecondition: "any-member", electorateFloor: "vibes" as never },
        terms: { url: "not a url", digest: "not-sha256" },
      });
      assert.match(problems.join("\n"), /seatPolicy/);
      assert.match(problems.join("\n"), /controllers/);
      assert.match(problems.join("\n"), /defaultVisibility/);
      assert.match(problems.join("\n"), /threadLayout\.form/);
      assert.match(problems.join("\n"), /threadLayout\.note/);
      assert.match(problems.join("\n"), /governance\.electorateFloor/);
      assert.match(problems.join("\n"), /terms\.url/);
      assert.match(problems.join("\n"), /terms\.digest/);
    });

    it("loadConfig merges AFP_POLICY_FILE over the instance-derived defaults; validate() names a bad enum", () => {
      const paths = workspace();
      const policyFile = join(paths.dataDir, "..", "policy.json");
      writeFileSync(
        policyFile,
        JSON.stringify({ controllers: ["https://controller.example/actor"], governance: { subjectPrecondition: "any-member", electorateFloor: "vibes" } }),
      );
      process.env.AFP_POLICY_FILE = policyFile;
      try {
        const withFile = loadConfig(paths);
        assert.deepEqual(withFile.policy.controllers, ["https://controller.example/actor"]);
        assert.equal(withFile.policy.seatPolicy, "follow-required");
        assert.equal(withFile.policy.defaultVisibility, "internal");

        const problems = validate(withFile, { skipDataDirProbe: true });
        const bad = problems.find((p) => p.field === "policy.governance.electorateFloor");
        assert.ok(bad, `validate() should report the bad enum under policy.governance.electorateFloor:\n${JSON.stringify(problems)}`);
      } finally {
        delete process.env.AFP_POLICY_FILE;
      }
    });

    it("the brains default matches what a stub or llm brain actually writes as afp:producedBy", () => {
      const stub = testInstance([...AGENTS], CAPABILITY);
      assert.deepEqual(stub.config.policy.brains, [{ model: "stub" }]);
      stub.instance.close();

      const llmPaths = workspace();
      const llm = loadConfig({ ...llmPaths, brain: "llm", llmModel: "some-model", llmBaseUrl: "http://127.0.0.1:9/api" });
      assert.deepEqual(llm.policy.brains, [{ model: "some-model", endpoint: "http://127.0.0.1:9/api" }]);
    });
  });

  describe("/afp/policy serves the signed document", () => {
    function freePort(): Promise<number> {
      return new Promise((resolve, reject) => {
        const probe = createServer();
        probe.listen(0, "127.0.0.1", () => {
          const address = probe.address();
          if (address && typeof address === "object") {
            const port = address.port;
            probe.close(() => resolve(port));
          } else probe.close(() => reject(new Error("no port")));
        });
      });
    }

    it("both /afp/policy and /.well-known/afp-policy serve the identical signed bytes", async () => {
      const port = await freePort();
      const origin = `http://127.0.0.1:${port}`;
      const config = loadConfig({ ...workspace(), origin });
      const registrations: AgentRegistration[] = [{
        spec: { name: "clerk", capabilities: [CAPABILITY], keyCustody: "instance", since: "2026-08-17T00:00:00Z" },
        brain: new CountingBrain("clerk", [CAPABILITY], () => ({ ok: true, content: "n/a" })),
      }];
      const instance = new AfpInstance(config, registrations, jumpClock());
      const server = createHttpServer(instance, {});
      await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
      try {
        const a = await fetch(`${origin}/afp/policy`, { headers: { accept: "application/activity+json" } });
        const b = await fetch(`${origin}/.well-known/afp-policy`, { headers: { accept: "application/activity+json" } });
        assert.equal(a.status, 200);
        assert.equal(b.status, 200);
        const [docA, docB] = [await a.json(), await b.json()];
        assert.deepEqual(docA, docB);
        assert.equal(docA.type, "afp:Policy");
        assert.equal(docA["afp:seatPolicy"], "follow-required");
      } finally {
        server.close();
        instance.close();
      }
    });
  });

  describe("Decision 2 — the export manifest names the policy it was produced under", () => {
    it("a fresh export carries policy.jsonld, declares it, and the manifest's digest matches; the verifier still passes", () => {
      const t = bridge();
      const summary = exportOf(t);
      assert.ok(existsSync(join(summary.dir, "policy.jsonld")));
      const manifest = JSON.parse(readFileSync(join(summary.dir, "MANIFEST.json"), "utf8"));
      assert.ok((manifest["afp:members"] as string[]).includes("policy.jsonld"));
      const policyOnDisk = JSON.parse(readFileSync(join(summary.dir, "policy.jsonld"), "utf8"));
      assert.equal(manifest["afp:policy"]["afp:digest"], digestOf(policyOnDisk as JsonValue));
      assert.equal(manifest["afp:policy"].id, policyOnDisk.id);

      const clean = runVerifier(VERIFIER, summary.dir, t.thread, ["--verbose"]);
      assert.equal(clean.code, 0, `a bundle carrying a policy must still replay clean:\n${clean.output}`);
      assert.match(clean.output, /PASSED/);
      t.instance.close();
    });

    it("fills the manifest's retentionDuty/anchors from the policy when extras names none; conflicting values throw", () => {
      const paths = workspace();
      const policyFile = join(paths.dataDir, "..", "policy-retention.json");
      writeFileSync(policyFile, JSON.stringify({ retentionDuty: { horizon: "P5Y", basis: "EU AI Act Art. 12" } }));
      process.env.AFP_POLICY_FILE = policyFile;
      let instance!: AfpInstance;
      try {
        const config = loadConfig(paths);
        instance = new AfpInstance(config, [], jumpClock());
        const summary = exportBundle(instance, config.exportDir);
        const manifest = JSON.parse(readFileSync(join(summary.dir, "MANIFEST.json"), "utf8"));
        assert.deepEqual(manifest["afp:retentionDuty"], { "afp:horizon": "P5Y", "afp:basis": "EU AI Act Art. 12" });

        assert.throws(
          () =>
            exportBundle(instance, config.exportDir, [], undefined, undefined, {
              retentionDuty: { horizon: "P1Y", basis: "a different basis" },
            }),
          /afp:retentionDuty disagrees/,
        );
      } finally {
        delete process.env.AFP_POLICY_FILE;
        instance?.close();
      }
    });
  });

  describe("the three controller readers honour the policy, not just AFP_CONTROLLERS", () => {
    it("an approveThroughPort by a controller listed only in the policy file succeeds; one listed nowhere is refused", async () => {
      const paths = workspace();
      const controllerUrl = "https://controller.example/actor";
      const policyFile = join(paths.dataDir, "..", "policy-controllers.json");
      writeFileSync(policyFile, JSON.stringify({ controllers: [controllerUrl] }));
      process.env.AFP_POLICY_FILE = policyFile;
      let instance!: AfpInstance;
      try {
        const config = loadConfig({ ...paths, controllers: [] });
        assert.deepEqual(config.policy.controllers, [controllerUrl], "AFP_CONTROLLERS is empty; the policy file is the source");
        instance = new AfpInstance(
          config,
          [{ spec: { name: "port", capabilities: [CAPABILITY], keyCustody: "instance", since: "2026-08-17T00:00:00Z" }, brain: new CountingBrain("port", [CAPABILITY], () => ({ ok: true, content: "n/a" })) }],
          jumpClock(),
        );
        const thread = `${config.origin}/threads/decide`;
        const decisionRecordDigest = "sha256:" + "0".repeat(64);

        const ok = await approveThroughPort(instance, { present: async () => ({ decision: "approve", by: controllerUrl }) }, {
          actuatorName: "port",
          decisionRecordDigest,
          thread,
          summary: "approve or reject",
          policy: { approve: "approve-it", reject: "reject-it" },
          correlationId: "corr-1",
        });
        assert.equal(ok.by, controllerUrl);

        await assert.rejects(
          () =>
            approveThroughPort(instance, { present: async () => ({ decision: "approve", by: "https://stranger.example/actor" }) }, {
              actuatorName: "port",
              decisionRecordDigest,
              thread,
              summary: "approve or reject",
              policy: { approve: "approve-it", reject: "reject-it" },
              correlationId: "corr-2",
            }),
          ApprovalRefused,
        );
      } finally {
        delete process.env.AFP_POLICY_FILE;
        instance?.close();
      }
    });
  });

  describe("Decision 4 — governance: subject precondition", () => {
    it("refuses a round about an agent with nothing on record; opens once a dispute citing its activity lands", async () => {
      const t = bridge({ governance: { subjectPrecondition: "proof-or-dispute-on-record", electorateFloor: "no-decision:electorate-exhausted" } });
      const subject = t.instance.actorId("third");

      assert.throws(
        () =>
          t.hub.proposeRound({
            round: `${t.config.origin}/rounds/r1`,
            thread: t.thread,
            question: "expel third?",
            options: ["yes", "no"],
            governanceSubject: subject,
          }),
        GovernanceRefused,
      );

      const warmup = `${t.config.origin}/rounds/warmup`;
      const proposal = t.hub.proposeRound({ round: warmup, thread: t.thread, question: "ship it?", options: ["yes", "no"] });
      const snapshot = String((proposal.activity.object as Record<string, JsonValue>)["afp:quorumSnapshot"]);
      const thirdVote = t.instance.publish("third", [t.hub.actorId], t.thread, "hub", (envelope) =>
        castVote(envelope, { voteId: `${envelope.actor}/votes/warmup`, round: warmup, hub: t.hub.actorId, proposalHash: proposal.digest, quorumSnapshot: snapshot, value: "yes" }),
      ).activity;
      t.hub.receive(thirdVote);

      t.instance.publish("victim", [], t.thread, "public", (envelope) =>
        contributionDispute(envelope, {
          disputeId: `${envelope.actor}/disputes/1`,
          hub: t.hub.actorId,
          summary: `${t.hub.actorId}/summaries/whatever`,
          ground: "quality",
          evidence: [digestOf(thirdVote)],
        }),
      );

      const opened = t.hub.proposeRound({
        round: `${t.config.origin}/rounds/r2`,
        thread: t.thread,
        question: "expel third?",
        options: ["yes", "no"],
        governanceSubject: subject,
      });
      assert.equal((opened.activity.object as Record<string, JsonValue>)["afp:governanceSubject"], subject);
      t.instance.close();
    });
  });

  describe("Decision 4 — governance: the electorate floor", () => {
    it("electorateFloor: refuse never opens a round whose recusal leaves the bar unreachable", async () => {
      const t = bridge({ governance: { subjectPrecondition: "any-member", electorateFloor: "refuse" } });
      assert.throws(
        () =>
          t.hub.proposeRound({
            round: `${t.config.origin}/rounds/floor-refuse`,
            thread: t.thread,
            question: "ship it?",
            options: ["yes", "no"],
            quorumRule: { "afp:form": "explicit", "afp:threshold": 3 },
            recused: [{ agent: t.instance.actorId("victim"), cause: { "afp:form": "governance-subject" } }],
            governanceSubject: t.instance.actorId("victim"),
          }),
        GovernanceRefused,
      );
      t.instance.close();
    });

    it("electorateFloor: no-decision:electorate-exhausted opens-and-closes with that reason; the verifier recomputes it", async () => {
      const t = bridge({ governance: { subjectPrecondition: "any-member", electorateFloor: "no-decision:electorate-exhausted" } });
      const round = `${t.config.origin}/rounds/floor-exhausted`;
      const subject = t.instance.actorId("victim");
      const proposal = t.hub.proposeRound({
        round,
        thread: t.thread,
        question: "ship it?",
        options: ["yes", "no"],
        quorumRule: { "afp:form": "explicit", "afp:threshold": 3 },
        recused: [{ agent: subject, cause: { "afp:form": "governance-subject" } }],
        governanceSubject: subject,
      });
      void proposal;
      const row = t.hub.roundVoters(round);
      assert.equal(row.includes(subject), false, "the recused subject is not among the pinned voters");

      exportOf(t);
      const out = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
      assert.equal(out.code, 0, out.output);
      assert.match(out.output, /PASSED/);
      t.instance.close();
    });
  });

  describe("every demo export carries a policy", () => {
    it("freshDemo()'s export declares policy.jsonld and the bundle still verifies", async () => {
      const { instance, exported, thread } = await freshDemo();
      assert.ok(existsSync(join(exported.dir, "policy.jsonld")));
      const clean = runVerifier(VERIFIER, exported.dir, thread, ["--verbose"]);
      assert.equal(clean.code, 0, `demo export must verify with a policy present:\n${clean.output}`);
      assert.match(clean.output, /PASSED/);
      instance.close();
    });
  });

  describe("a policy-carrying bundle replays clean (WP-3 fixture: three-agent hub)", () => {
    it("replays clean and the census shows policy: > 0", () => {
      const t = bridge();
      const summary = exportOf(t);
      const clean = runVerifier(VERIFIER, summary.dir, t.thread, ["--verbose"]);
      assert.equal(clean.code, 0, clean.output);
      assert.match(clean.output, /PASSED/);
      const census = clean.output.match(/^\s*·\s+.*$/m)?.[0] ?? "";
      const match = census.match(/policy:(\d+)/);
      assert.ok(match && Number(match[1]) > 0, `expected policy:>0 in the census line:\n${census}`);
      t.instance.close();
    });
  });

  describe("check_policy: the carried document", () => {
    it("mutating policy.jsonld (flip afp:defaultVisibility) fails the signature check by name", () => {
      const t = bridge();
      const summary = exportOf(t);
      const out = mutateFile(summary.dir, t.thread, "policy.jsonld", (doc) => {
        doc["afp:defaultVisibility"] = doc["afp:defaultVisibility"] === "internal" ? "public" : "internal";
      });
      assert.notEqual(out.code, 0);
      assert.match(out.output, /FAIL \] policy: policy\.jsonld signature verifies/);
      t.instance.close();
    });

    it("mutating the manifest's afp:policy.afp:digest fails by name", () => {
      const t = bridge();
      const summary = exportOf(t);
      const out = mutateFile(summary.dir, t.thread, "MANIFEST.json", (doc) => {
        (doc["afp:policy"] as Record<string, unknown>)["afp:digest"] = "sha256:" + "0".repeat(64);
      });
      assert.notEqual(out.code, 0);
      assert.match(out.output, /FAIL \] policy: policy\.jsonld digest matches the manifest's afp:policy\.afp:digest/);
      t.instance.close();
    });
  });

  describe("check_policy: seat policy vs. the Enroll trail", () => {
    it("follow-required: an Enroll spliced in before its Accept{Follow} fails by name", () => {
      const t = bridge({ seatPolicy: "follow-required" });
      const summary = exportOf(t);
      const out = mutateFile(summary.dir, t.thread, "outbox/instance.jsonld", (doc) => {
        const items = doc.orderedItems as Record<string, unknown>[];
        const followIndex = items.findIndex((a) => a.type === "Follow");
        const enrollIndex = items.findIndex((a) => a.type === "afp:Enroll");
        items[enrollIndex].published = new Date(
          new Date(items[followIndex].published as string).getTime() - 60_000,
        ).toISOString();
      });
      assert.notEqual(out.code, 0);
      assert.match(out.output, /FAIL \] policy: .*is preceded by an Accept\{Follow\}/);
      t.instance.close();
    });

    it("enroll-implies-seat: the check records ok, informational", () => {
      const t = bridge({ seatPolicy: "enroll-implies-seat" });
      const summary = exportOf(t);
      const clean = runVerifier(VERIFIER, summary.dir, t.thread, ["--verbose"]);
      assert.equal(clean.code, 0, clean.output);
      assert.match(clean.output, /policy: .*seat policy enroll-implies-seat does not require a Follow trail/);
      t.instance.close();
    });
  });
});
