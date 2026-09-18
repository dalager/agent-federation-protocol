/**
 * ADR-0038 gate: the operator's own work — the agent collection from
 * configuration, and the `task` form of the command grammar. Seven checks,
 * by number, in `test/adr0029.test.ts`'s harness style: a served instance
 * with a real read gate, commands genuinely HTTP-signed, the scheduler's
 * flush driven by hand the way adr0031's gate drives ticks.
 *
 *   node --experimental-sqlite --test test/adr0038.test.ts
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createServer as createProbe } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { AfpInstance, systemClock, type Clock } from "../src/instance.ts";
import { loadConfig } from "../src/config.ts";
import { createHttpServer } from "../src/ap/server.ts";
import { signRequest } from "../src/federation/httpSig.ts";
import { fileSigner } from "../src/crypto/signer.ts";
import { loadOrCreateKeyPair, type KeyPair } from "../src/crypto/keys.ts";
import { agentActor } from "../src/ap/documents.ts";
import type { ReadGateDeps } from "../src/federation/readGate.ts";
import type { JsonValue } from "../src/crypto/jcs.ts";
import { jumpClock } from "../src/demoP3.ts";
import { agentRegistrations } from "../src/demo.ts";
import { agentCollection, agentsCheck, DEFAULT_SINCE, validateAgentEntries } from "../src/agents.ts";
import { runConfigCheck } from "../src/runtime/configCheck.ts";
import { Scheduler } from "../src/runtime/scheduler.ts";
import { httpTransport } from "../src/federation/transport.ts";
import { exportBundle } from "../src/export.ts";
import { parseCommand } from "../src/federation/visibility.ts";
import { cleanupWorkspaces, freshDemo, objectType, runVerifier, workspace } from "./helpers.ts";

after(cleanupWorkspaces);

const VERIFIER = join(import.meta.dirname, "..", "..", "verifier", "afp_verify.py");
const INSTANCE_DIR = join(import.meta.dirname, "..");
const SCHEDULER = { sweepMs: 30_000, flushMs: 10_000, convergeMs: 60_000, heartbeatMs: 0, jitterMs: 0 };

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createProbe();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address && typeof address === "object") {
        const port = address.port;
        probe.close(() => resolve(port));
      } else {
        probe.close(() => reject(new Error("no port")));
      }
    });
  });
}

function writeAgentsFile(paths: { dataDir: string }, entries: unknown): string {
  const root = dirname(paths.dataDir);
  mkdirSync(root, { recursive: true });
  const file = join(root, "agents.json");
  writeFileSync(file, JSON.stringify(entries, null, 2));
  return file;
}

/**
 * A served instance booted from an `AFP_AGENTS_FILE`: "controller" is a
 * `brain: "none"` actor the instance holds, "worker" a stub. The policy
 * lists two controllers — the held one, and a *foreign* one whose actor
 * document the read gate can fetch (served from this harness) but whose key
 * this instance does not hold. `serve`'s own transport/scheduler wiring is
 * reproduced so a flush tick performs a locally delegated Offer.
 */
async function taskServe(options: { clock?: Clock } = {}) {
  const clock = options.clock ?? jumpClock("2026-09-13T09:00:00.000Z");
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const paths = workspace();
  const agentsFile = writeAgentsFile(paths, [
    { name: "controller", capabilities: [], brain: "none" },
    { name: "worker", capabilities: ["afp:cap:assess", "afp:cap:review"], brain: "stub" },
  ]);
  const foreignOrigin = "https://other.example";
  const foreignUrl = `${foreignOrigin}/agents/boss`;
  const controllers = [`${origin}/agents/controller`, foreignUrl];
  // A wide per-address bucket: the CLI cases fire several signed reads —
  // each with the read gate's own fetch of the controller's document — inside
  // one second, which the default 20/s bucket would answer 429.
  const config = loadConfig({ ...paths, origin, agentsFile, controllers, rateLimitPerAddress: 1000 });
  const instance = new AfpInstance(config, agentCollection(config), clock);

  const foreignKey = loadOrCreateKeyPair(join(dirname(paths.dataDir), "foreign-keys"), "boss", foreignUrl);
  const foreignDoc = agentActor(foreignOrigin, { name: "boss", capabilities: [], keyCustody: "self", since: DEFAULT_SINCE }, foreignKey);

  const fetchDocument = async (url: string): Promise<{ [key: string]: JsonValue } | null> => {
    if (url === foreignUrl) return foreignDoc;
    try {
      const response = await fetch(url, { headers: { accept: "application/activity+json" } });
      return response.ok ? ((await response.json()) as { [key: string]: JsonValue }) : null;
    } catch {
      return null;
    }
  };
  const read: ReadGateDeps = {
    selfActor: String(instance.instanceDocument().id),
    fetchDocument,
    isDenylisted: () => false,
    activeAgreementsWith: () => [],
    roleOf: () => null,
    grants: () => [],
    now: () => clock.now(),
  };
  const server = createHttpServer(instance, { read });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  const transport = httpTransport({
    signer: instance.transportSigner("@instance"),
    now: () => clock.now(),
    isLocal: (target) => instance.nameOf(target) !== null,
    local: instance.localTransport(),
  });
  const scheduler = new Scheduler({ instance, transport, config: SCHEDULER });

  const postAs = async (pair: KeyPair, path: string, body: { [key: string]: unknown }) => {
    const text = JSON.stringify(body);
    const headers = signRequest("POST", path, `127.0.0.1:${port}`, text, fileSigner(pair), clock.now());
    const res = await fetch(`${origin}${path}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: text });
    return { status: res.status, body: (await res.json()) as { [key: string]: JsonValue } };
  };
  const post = (name: string, path: string, body: { [key: string]: unknown }) => postAs(instance.key(name), path, body);
  const postUnsigned = async (path: string, body: { [key: string]: unknown }) => {
    const res = await fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as { [key: string]: JsonValue } };
  };

  return { clock, origin, paths, agentsFile, controllers, config, instance, server, scheduler, foreignKey, foreignUrl, post, postAs, postUnsigned };
}

function heads(instance: AfpInstance, names: readonly string[]): string[] {
  return names.map((name) => instance.outbox.headDigest(instance.actorId(name)) ?? "");
}

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

  it("G6 — the CLI: `npm run task` against a served instance signs as the controller and gets the same 200; with the controller key absent it fails by name and opens no store", async () => {
    // Wall clock: the CLI signs with `new Date()`, and the read gate checks skew against the instance's clock.
    const { instance, server, paths, agentsFile, controllers, origin, scheduler } = await taskServe({ clock: systemClock });
    try {
      const env = {
        ...process.env,
        AFP_DATA_DIR: paths.dataDir,
        AFP_ORIGIN: origin,
        AFP_CONTROLLERS: controllers.join(","),
        AFP_AGENTS_FILE: agentsFile,
        AFP_BRAIN: "stub",
        AFP_DEV: "1",
        AFP_LOG_LEVEL: "silent",
      };
      // Asynchronous on purpose: the served instance lives in *this* process,
      // so a synchronous exec would block the very event loop that has to
      // answer the child's POST (and the read gate's fetch of the
      // controller's actor document).
      const cli = async (args: string[], overrides: Record<string, string> = {}) =>
        (await promisify(execFile)(process.execPath, ["--disable-warning=ExperimentalWarning", "src/cli.ts", "task", ...args], {
          cwd: INSTANCE_DIR,
          env: { ...env, ...overrides },
          encoding: "utf8",
        })).stdout;

      const out = await cli(["worker", "Draft a readiness note.", "--as", "controller"]);
      const body = JSON.parse(out) as { task: string; thread: string; correlationId: string };
      assert.match(body.task, new RegExp(`^${instance.actorId("controller")}/activities/`));
      assert.equal(instance.outbox.byThread(body.thread).length, 1, "the Offer is on the record");
      await scheduler.tick("flush");
      assert.equal(instance.outbox.byThread(body.thread).length, 3, "…and performed on the next flush");

      // `--as` defaults to the first locally-held controller.
      const defaulted = JSON.parse(await cli(["worker", "Another job."])) as { task: string };
      assert.match(defaulted.task, new RegExp(`^${instance.actorId("controller")}/activities/`));

      // Key absent: a fresh data dir holds no `controller.pem`. Fails by name,
      // and the CLI never opened a store there — no db, no lock.
      const fresh = join(dirname(paths.dataDir), "cli-fresh");
      const head = instance.outbox.headDigest(instance.actorId("controller"));
      let failure: { code?: number; stderr?: string } | null = null;
      try {
        await cli(["worker", "Never sent."], { AFP_DATA_DIR: fresh });
      } catch (error) {
        failure = error as { code?: number; stderr?: string };
      }
      assert.ok(failure, "the CLI exits non-zero");
      assert.equal(failure!.code, 2);
      assert.match(String(failure!.stderr), /controller key for "controller" not found/);
      assert.match(String(failure!.stderr), /never mints/);
      assert.equal(existsSync(join(fresh, "afp.db.lock")), false, "no lock file appeared");
      assert.equal(existsSync(join(fresh, "afp.db")), false, "no store was created");
      assert.equal(instance.outbox.headDigest(instance.actorId("controller")), head, "the served instance is undisturbed");
      assert.equal((await fetch(`${origin}/actor`)).status, 200, "the served instance still answers");
    } finally {
      server.close();
      instance.close();
    }
  });

  /**
   * G8 harness: a served instance on the wall clock with a performed task,
   * and the `show` CLI run against it from a *separate* data dir that holds a
   * copy of the keys and no store — so "never opens the store" is checked
   * by the absence of any `afp.db`/`afp.db.lock` there, not inferred.
   */
  async function showServe() {
    const served = await taskServe({ clock: systemClock });
    const { instance, scheduler, post, paths } = served;
    const res = await post("controller", "/agents/worker/command", { content: "@worker task Assess the window." });
    const slug = String(res.body.correlationId);
    const thread = String(res.body.thread);
    await scheduler.tick("flush");
    await scheduler.tick("flush");
    assert.equal(instance.outbox.byThread(thread).length, 3, "Offer, Accept, Result on the thread");

    const clientData = join(dirname(paths.dataDir), "cli-data");
    mkdirSync(clientData, { recursive: true });
    cpSync(served.config.keyDir, join(clientData, "keys"), { recursive: true });
    const env = {
      ...process.env,
      AFP_DATA_DIR: clientData,
      AFP_ORIGIN: served.origin,
      AFP_CONTROLLERS: served.controllers.join(","),
      AFP_AGENTS_FILE: served.agentsFile,
      AFP_BRAIN: "stub",
      AFP_DEV: "1",
      AFP_LOG_LEVEL: "silent",
    };
    const show = async (args: string[]) => {
      try {
        const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--disable-warning=ExperimentalWarning", "src/cli.ts", "show", ...args], {
          cwd: INSTANCE_DIR,
          env,
          encoding: "utf8",
        });
        return { code: 0, stdout, stderr };
      } catch (error) {
        const failed = error as { code?: number; stdout?: string; stderr?: string };
        return { code: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
      }
    };
    const noStoreOpened = () => {
      assert.equal(existsSync(join(clientData, "afp.db")), false, "the CLI created no store");
      assert.equal(existsSync(join(clientData, "afp.db.lock")), false, "the CLI took no lock");
    };
    return { ...served, slug, thread, show, noStoreOpened };
  }

  it("G8 — `show status`, an anonymous rendering fetch, and `show thread` on a thread the controller is no party to: served, 404, and exit 1 without opening the store", async () => {
    const { instance, server, origin, slug, show, noStoreOpened } = await showServe();
    try {
      const status = await show(["status", "worker"]);
      assert.equal(status.code, 0, status.stderr);
      const body = JSON.parse(status.stdout) as { status: { chainHead: string; paused: boolean; pending: number } };
      assert.equal(body.status.chainHead, instance.outbox.headDigest(instance.actorId("worker")), "the chain head, as the controller");
      assert.equal(body.status.paused, false);

      const anonymous = await fetch(`${origin}/threads/${slug}/rendering`);
      assert.equal(anonymous.status, 404, "a parties thread to an anonymous caller is indistinguishable from no thread");

      // A thread the controller is no party to: the worker's own note, addressed to nobody.
      instance.publish("worker", [], `${origin}/threads/private-note`, "parties", (envelope) => ({
        "@context": ["https://www.w3.org/ns/activitystreams", "https://dalager.github.io/agent-federation-protocol/ns/v3.jsonld"],
        id: envelope.activityId,
        type: "Create",
        actor: envelope.actor,
        to: [],
        published: envelope.published,
        context: envelope.thread,
        "afp:visibility": envelope.visibility,
        ...(envelope.prevActivity !== null ? { "afp:prevActivity": envelope.prevActivity } : {}),
        object: { type: "Note", content: "nobody's business" },
      }));
      const refused = await show(["thread", "private-note"]);
      assert.equal(refused.code, 1);
      assert.equal(refused.stdout, "");
      assert.equal(refused.stderr.trim(), "not served to controller (404)", "one line, no speculation");
      // A full URL resolves to the same slug; a foreign thread URL is refused locally, before any request.
      const byUrl = await show(["thread", `${origin}/threads/private-note`]);
      assert.equal(byUrl.stderr.trim(), "not served to controller (404)");
      const foreign = await show(["thread", "https://other.example/threads/x"]);
      assert.equal(foreign.code, 2);
      assert.match(foreign.stderr, /not a thread under/);

      // `show agent` runs the timeline route; the worker's entries are all
      // `parties` and, under the finding below, none is admitted — the route
      // answers 200 with an empty narrative rather than 404, by design.
      const timeline = await show(["agent", "worker"]);
      assert.equal(timeline.code, 0, timeline.stderr);
      assert.match(timeline.stdout, /^Rendering of /);
      noStoreOpened();
    } finally {
      server.close();
      instance.close();
    }
  });

  // Admitted by ADR-0013 Decision 3 as revised under contact (2026-09-18):
  // the controller is self-operated (no self-agreement to check) and is the
  // Offer's author and the Accept/Result's addressee — a party to all three.
  it("G8(b) — `show thread <slug>` as the controller that delegated the task: the narrative names Offer, Accept and Result, and --json carries afp:bundle", async () => {
    const { instance, server, slug, show, noStoreOpened } = await showServe();
    try {
      const narrative = await show(["thread", slug]);
      assert.equal(narrative.code, 0, narrative.stderr);
      assert.match(narrative.stdout, /^Rendering of .*\/threads\/task-[0-9a-f]{12} — digest [0-9a-f]{64}, rendered .*, no export\n/);
      assert.match(narrative.stdout, /Offer\/afp:Task/);
      assert.match(narrative.stdout, /Accept/);
      assert.match(narrative.stdout, /Create\/afp:Result/);

      const json = await show(["thread", slug, "--json"]);
      assert.equal(json.code, 0, json.stderr);
      const rendering = JSON.parse(json.stdout) as { "afp:bundle": unknown; "afp:renderingDigest": string; narrative: string[] };
      assert.ok("afp:bundle" in rendering, "the bundle field the rendering already has (null before an export)");
      assert.equal(rendering["afp:bundle"], null);
      assert.equal(rendering.narrative.length, 3);
      noStoreOpened();
    } finally {
      server.close();
      instance.close();
    }
  });

  it("G9 — `show result <slug>` as the controller prints the performer's Result and afp:producedBy; --json yields the activity; before any flush it is `no result yet`; anonymous outbox omits it; no store opened", async () => {
    // The unperformed case first: a fresh task on the same served instance, no flush.
    const served = await showServe();
    const { instance, server, origin, slug, show, noStoreOpened, post } = served;
    try {
      const pending = await post("controller", "/agents/worker/command", { content: "@worker task Not yet performed." });
      const pendingSlug = String(pending.body.correlationId);
      assert.equal(instance.outbox.byThread(String(pending.body.thread)).length, 1, "Offer only");
      const early = await show(["result", pendingSlug]);
      assert.equal(early.code, 1);
      assert.equal(early.stdout, "");
      assert.equal(early.stderr.trim(), `no result yet on ${origin}/threads/${pendingSlug}`);

      // The performed task from the harness.
      const text = await show(["result", slug]);
      assert.equal(text.code, 0, text.stderr);
      const [header, ...rest] = text.stdout.split("\n");
      assert.match(header, /^worker · \d{4}-\d{2}-\d{2}T.* · afp:producedBy: stub$/);
      assert.match(rest.join("\n"), /# worker: afp:cap:assess/, "the Result's content, verbatim");
      assert.match(rest.join("\n"), /Assess the window\./);
      assert.match(text.stdout, /attachment: text\/markdown sha256:[0-9a-f]{64}/, "attachments are named, not fetched");

      const json = await show(["result", slug, "--json"]);
      assert.equal(json.code, 0, json.stderr);
      const activity = JSON.parse(json.stdout) as { type: string; actor: string; context: string; object: { type: string; "afp:producedBy": string } };
      assert.equal(activity.type, "Create");
      assert.equal(activity.object.type, "afp:Result");
      assert.equal(activity.object["afp:producedBy"], "stub");
      assert.equal(activity.actor, instance.actorId("worker"));
      assert.equal(activity.context, `${origin}/threads/${slug}`);

      // `--agent` names the performer outright; `--all` lists in order (one here).
      const named = await show(["result", slug, "--agent", "worker", "--all", "--json"]);
      assert.equal(named.code, 0, named.stderr);
      assert.equal((JSON.parse(named.stdout) as unknown[]).length, 1);

      // The Result is `parties`: anonymous, the performer's outbox does not carry it.
      const anonymous = await fetch(`${origin}/agents/worker/outbox`);
      const anonymousBody = await anonymous.text();
      assert.ok(!anonymousBody.includes('"afp:Result"'), `no Result served anonymously (status ${anonymous.status}): ${anonymousBody.slice(0, 200)}`);

      // A thread the controller is no party to: the rendering's 404, same line.
      const refused = await show(["result", "nobody-elses"]);
      assert.equal(refused.code, 1);
      assert.equal(refused.stderr.trim(), "not served to controller (404)");
      noStoreOpened();
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
