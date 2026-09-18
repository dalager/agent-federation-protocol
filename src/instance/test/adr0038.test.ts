/**
 * ADR-0038 gate: the operator's own work — the agent collection from
 * configuration, and the `task` form of the command grammar. G1–G5 and G7,
 * in `test/adr0029.test.ts`'s harness style: a served instance with a real
 * read gate, commands genuinely HTTP-signed, the scheduler's flush driven by
 * hand the way adr0031's gate drives ticks. The CLI half — G6, G8–G10 — is
 * `test/adr0038-cli.test.ts`; the shared harness is `test/adr0038-harness.ts`.
 *
 *   node --experimental-sqlite --test test/adr0038.test.ts
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { AfpInstance } from "../src/instance.ts";
import { loadConfig } from "../src/config.ts";
import { createHttpServer } from "../src/ap/server.ts";
import type { JsonValue } from "../src/crypto/jcs.ts";
import { jumpClock } from "../src/demoP3.ts";
import { agentRegistrations } from "../src/demo.ts";
import { agentCollection, agentsCheck, validateAgentEntries } from "../src/agents.ts";
import { runConfigCheck } from "../src/runtime/configCheck.ts";
import { exportBundle } from "../src/export.ts";
import { parseCommand } from "../src/federation/visibility.ts";
import { cleanupWorkspaces, freshDemo, objectType, runVerifier, workspace } from "./helpers.ts";
import { freePort, heads, taskServe, VERIFIER, writeAgentsFile } from "./adr0038-harness.ts";

after(cleanupWorkspaces);

describe("ADR-0038 gate — the operator's own work", () => {
  it("G1 — AFP_AGENTS_FILE unset: the collection is the demo's writer/reviewer, and the P1 bundle replays clean", async () => {
    const config = loadConfig(workspace());
    assert.equal(config.agentsFile, undefined);
    const collection = agentCollection(config);
    const demo = agentRegistrations(config);
    assert.deepEqual(collection.map((r) => r.spec), demo.map((r) => r.spec), "byte-for-byte the demo's specs");
    assert.deepEqual(collection.map((r) => r.brain.name), demo.map((r) => r.brain.name));
    assert.ok(collection.every((r) => r.held === undefined), "no held actor in the demo collection");
    assert.deepEqual(agentsCheck(config), { ok: true, reason: "demo collection (AFP_AGENTS_FILE unset)" });

    // The P1 gate's own byte-level check (gate.test.ts check 10) is the
    // independent verifier over the demo's export — unchanged here.
    const { instance, exported, thread } = await freshDemo();
    try {
      const result = runVerifier(VERIFIER, exported.dir, thread);
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /PASSED/);
    } finally {
      instance.close();
    }
  });

  it("G2 — a three-entry file (llm/stub/none) boots a served instance: /roster names all three, the held actor has an instance-custody key, and an Offer to it is Rejected on the record", async () => {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const paths = workspace();
    const agentsFile = writeAgentsFile(paths, [
      { name: "writer", capabilities: ["afp:cap:draft"], persona: "You are a technical writer.", brain: "llm" },
      { name: "reviewer", capabilities: ["afp:cap:review"], brain: "stub", consumes: ["text/markdown"] },
      { name: "kasper", capabilities: [], brain: "none" },
    ]);
    const config = loadConfig({ ...paths, origin, agentsFile });
    assert.deepEqual(agentsCheck(config), { ok: true, reason: "3 from AFP_AGENTS_FILE" });
    const collection = agentCollection(config);
    assert.deepEqual(collection.map((r) => r.spec.keyCustody), ["instance", "instance", "instance"]);
    assert.deepEqual(collection.find((r) => r.spec.name === "reviewer")!.spec.consumes, ["text/markdown"]);
    assert.equal(collection.find((r) => r.spec.name === "kasper")!.held, true);

    const instance = new AfpInstance(config, collection, jumpClock());
    const server = createHttpServer(instance);
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    try {
      const roster = (await (await fetch(`${origin}/roster`)).json()) as { orderedItems: { agent: string; "afp:keyCustody": string }[] };
      assert.deepEqual(
        roster.orderedItems.map((m) => m.agent),
        ["writer", "reviewer", "kasper"].map((name) => instance.actorId(name)),
        "the roster names all three, in file order",
      );
      assert.ok(roster.orderedItems.every((m) => m["afp:keyCustody"] === "instance"));
      // Capabilities are on the Vouch trail and each agent document, not the roster entry.
      const capabilitiesOf = async (name: string) =>
        ((await (await fetch(`${origin}/agents/${name}`)).json()) as { "afp:capabilities": string[]; "afp:consumes"?: string[] });
      assert.deepEqual((await capabilitiesOf("writer"))["afp:capabilities"], ["afp:cap:draft"]);
      const reviewer = await capabilitiesOf("reviewer");
      assert.deepEqual(reviewer["afp:capabilities"], ["afp:cap:review"]);
      assert.deepEqual(reviewer["afp:consumes"], ["text/markdown"]);
      assert.deepEqual((await capabilitiesOf("kasper"))["afp:capabilities"], [], "the held actor publishes what it declared");
      assert.ok(existsSync(join(config.keyDir, "kasper.pem")), "the held actor's key is minted under instance custody");
      assert.equal(instance.isHeld("kasper"), true);

      const thread = `${origin}/threads/g2`;
      const offer = instance.delegate({ from: "reviewer", to: "kasper", capability: "afp:cap:anything", content: "do this", thread, correlationId: "g2-1" });
      await instance.run();
      const kasperEntries = instance.outbox.byActor(instance.actorId("kasper"));
      assert.equal(kasperEntries.length, 1, "exactly one answer, never a Result and never silence");
      assert.equal(kasperEntries[0].activity.type, "Reject");
      assert.equal(kasperEntries[0].activity.object, offer.activity.id, "the Reject names the Offer");
      assert.match(String(kasperEntries[0].activity["afp:reason"] ?? kasperEntries[0].activity.summary ?? JSON.stringify(kasperEntries[0].activity)), /held actor/);
    } finally {
      server.close();
      instance.close();
    }
  });

  it("G3 — config check reports every agents-file problem by name, all at once", async () => {
    const paths = workspace();
    const agentsFile = writeAgentsFile(paths, [
      { name: "writer", capabilities: ["afp:cap:draft"], brain: "stub" },
      { name: "writer", capabilities: ["afp:cap:draft"], brain: "stub" },
      { name: "Bad_Name", capabilities: [], brain: "stub" },
      { name: "extra", capabilities: [], brain: "stub", foo: 1 },
      { name: "selfish", capabilities: [], brain: "stub", keyCustody: "self" },
      { name: "magic", capabilities: [], brain: "wizard" },
    ]);
    const config = loadConfig({ ...paths, agentsFile });
    const result = await runConfigCheck(config, { offline: true });
    const line = result.lines.find((l) => l.name === "agents");
    assert.ok(line, "an `agents` line is reported");
    assert.equal(line!.ok, false);
    assert.equal(result.allOk, false);
    for (const expected of [
      "writer: duplicate name",
      "Bad_Name: name must match",
      'extra: unknown key "foo"',
      'selfish: keyCustody must be "instance"',
      "magic: brain must be one of llm/stub/none",
    ]) {
      assert.ok(line!.reason?.includes(expected), `expected "${expected}" in: ${line!.reason}`);
    }
    assert.throws(() => agentCollection(config), /AFP_AGENTS_FILE .*duplicate name/);

    // A missing file is a problem `validate()` names (like every *_FILE), and the line names it too.
    const missing = loadConfig({ ...workspace(), agentsFile: join(paths.dataDir, "nowhere.json") });
    const missingResult = await runConfigCheck(missing, { offline: true });
    assert.ok(missingResult.problems.some((p) => p.env === "AFP_AGENTS_FILE" && /does not exist/.test(p.message)));
    assert.equal(missingResult.lines.find((l) => l.name === "agents")!.ok, false);

    // And the pure validator: a non-array is one named problem, not a throw.
    assert.deepEqual(validateAgentEntries({}).problems, ["file must be a JSON array of agent entries"]);
  });

  it("G4 — `@worker task <brief>` from a listed, locally-held controller: 200 with the Offer; the next flush performs it; Accept and Result are on the thread, producedBy names the stub, and the thread replays clean", async () => {
    const { instance, server, scheduler, post, config } = await taskServe();
    try {
      const brief = "Assess whether the cutover fits a fifteen-minute window.";
      const res = await post("controller", "/agents/worker/command", { content: `@worker task ${brief}` });
      assert.equal(res.status, 200);
      const task = String(res.body.task);
      const thread = String(res.body.thread);
      const correlationId = String(res.body.correlationId);
      assert.match(task, new RegExp(`^${instance.actorId("controller")}/activities/`), "the Offer is the controller's own activity");
      assert.match(correlationId, /^task-[0-9a-f]{12}$/);
      assert.equal(thread, `${config.origin}/threads/${correlationId}`, "the default thread is derived from the slug");

      const offer = instance.outbox.byThread(thread);
      assert.equal(offer.length, 1, "before any flush: the Offer alone");
      assert.equal(objectType(offer[0].activity), "afp:Task");
      const object = offer[0].activity.object as Record<string, JsonValue>;
      assert.equal(object["afp:capability"], "afp:cap:assess", "defaults to the agent's first advertised capability");
      assert.equal(object.content, brief);
      assert.equal(instance.tasks.openCountForPerformer(instance.actorId("worker")), 1);

      // The scheduler's flush is what a served instance does on its own
      // timer: local targets short-circuit to in-process dispatch, so the
      // worker's brain performs and its answers land on the thread.
      await scheduler.tick("flush");
      const afterFlush = instance.outbox.byThread(thread);
      const types = afterFlush.map((e) => [e.activity.type, objectType(e.activity)]);
      assert.deepEqual(types, [["Offer", "afp:Task"], ["Accept", ""], ["Create", "afp:Result"]]);
      assert.equal(afterFlush[1].actor, instance.actorId("worker"));
      const result = afterFlush[2].activity.object as Record<string, JsonValue>;
      assert.equal(result["afp:producedBy"], "stub", "the Result names the stub brain");
      assert.equal(result["afp:correlationId"], correlationId);
      assert.equal((instance.brainFor("worker") as { invocations: number }).invocations, 1);

      // The second flush delivers Accept/Result back to the controller's
      // inbox, closing the task row — no further call from anyone.
      await scheduler.tick("flush");
      assert.equal(instance.tasks.openCountForPerformer(instance.actorId("worker")), 0);
      assert.equal(instance.queue.stats().pending, 0);

      const exported = exportBundle(instance, config.exportDir);
      const verdict = runVerifier(VERIFIER, exported.dir, thread, ["--verbose"]);
      assert.equal(verdict.code, 0, verdict.output);
      assert.match(verdict.output, /PASSED/);

      // The structured fields: an explicit capability, thread and deadline are honoured.
      const custom = await post("controller", "/agents/worker/command", {
        content: "@worker task Review the note.",
        capability: "afp:cap:review",
        thread: `${config.origin}/threads/my-thread`,
        deadline: "2026-12-31T00:00:00.000Z",
      });
      assert.equal(custom.status, 200);
      assert.equal(custom.body.thread, `${config.origin}/threads/my-thread`);
      const customOffer = instance.outbox.byThread(`${config.origin}/threads/my-thread`)[0].activity.object as Record<string, JsonValue>;
      assert.equal(customOffer["afp:capability"], "afp:cap:review");
      assert.equal(customOffer["afp:deadline"], "2026-12-31T00:00:00.000Z");
    } finally {
      server.close();
      instance.close();
    }
  });

  it("G5 — task from a listed-but-foreign controller, an unlisted signer, anonymous, a newline in the brief, an unadvertised capability, and the mention carrier: the identical polite reply, chain heads unchanged", async () => {
    const { instance, server, post, postAs, postUnsigned, foreignKey, foreignUrl, origin } = await taskServe();
    try {
      const path = "/agents/worker/command";
      const before = heads(instance, ["controller", "worker"]);
      const logBefore = instance.auditLog().length;
      assert.ok(instance.policy.controllers?.includes(foreignUrl), "the foreign controller is listed");
      assert.equal(instance.nameOf(foreignUrl), null, "…but not held here");

      const foreign = await postAs(foreignKey, path, { content: "@worker task Do my bidding." });
      const unlisted = await post("worker", path, { content: "@worker task Do my bidding." });
      const anonymous = await postUnsigned(path, { content: "@worker task Do my bidding." });
      const multiline = await post("controller", path, { content: "@worker task line one\nline two" });
      const capability = await post("controller", path, { content: "@worker task Draft it.", capability: "afp:cap:draft" });
      const badDeadline = await post("controller", path, { content: "@worker task Draft it.", deadline: "next tuesday" });

      for (const res of [foreign, unlisted, anonymous, multiline, capability, badDeadline]) {
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, foreign.body, "one fixed shape whatever the reason");
      }
      assert.ok(typeof foreign.body.reply === "string" && foreign.body.reply.length > 0);
      assert.deepEqual(heads(instance, ["controller", "worker"]), before, "no chain moved");
      assert.equal(instance.tasks.openCountForPerformer(instance.actorId("worker")), 0);
      // Verified refusals are logged (five), the anonymous one is not (ADR-0013 Decision 5).
      const log = instance.auditLog();
      assert.equal(log.length, logBefore + 5);
      assert.ok(log.slice(logBefore).every((row) => row.outcome === "polite-reply"));

      // Decision 3: the mention carrier does not carry `task`. A Create{Note}
      // from the *held, listed* controller — the strongest case — parses as
      // a task and is still refused with the polite reply; no Offer appears.
      assert.equal(parseCommand("@worker task hello", instance.actorId("worker"))?.command, "task", "the grammar parses it");
      const mention = instance.publish("controller", [instance.actorId("worker")], `${origin}/threads/mention-task`, "parties", (envelope) => ({
        "@context": ["https://www.w3.org/ns/activitystreams", "https://dalager.github.io/agent-federation-protocol/ns/v3.jsonld"],
        id: envelope.activityId,
        type: "Create",
        actor: envelope.actor,
        to: [...envelope.to],
        published: envelope.published,
        context: envelope.thread,
        "afp:visibility": envelope.visibility,
        ...(envelope.prevActivity !== null ? { "afp:prevActivity": envelope.prevActivity } : {}),
        object: { type: "Note", content: "@worker task hello" },
      }));
      const workerBefore = instance.outbox.byActor(instance.actorId("worker")).length;
      const outcome = await instance.receive(mention.activity);
      assert.equal(outcome.status, "dispatched", "the Note itself is a valid activity from a roster member");
      assert.equal(instance.outbox.byActor(instance.actorId("worker")).length, workerBefore, "no Offer, no Accept, no Result");
      assert.equal(instance.tasks.openCountForPerformer(instance.actorId("worker")), 0);
      const last = instance.auditLog().at(-1)!;
      assert.equal(last.outcome, "polite-reply");
      assert.match(last.reason, /task is not carried by mentions/);
    } finally {
      server.close();
      instance.close();
    }
  });

  it("G7 — every shipped bundle replays unchanged", async () => {
    // The P1 demo is replayed here; the rest — p2…p8 — are `test/demos.test.ts`
    // (ADR-0030 Decision 4), which `npm run gate` runs alongside this file.
    // None of them set AFP_AGENTS_FILE and none issue a `task`, so the record
    // they produce is the one they produced before this ADR.
    const { instance, exported, thread } = await freshDemo();
    try {
      const result = runVerifier(VERIFIER, exported.dir, thread, ["--verbose"]);
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /PASSED/);
      assert.doesNotMatch(result.output, /task-[0-9a-f]{12}/);
    } finally {
      instance.close();
    }
  });
});
