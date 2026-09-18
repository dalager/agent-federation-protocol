/**
 * The ADR-0038 gate's shared harness — a served instance booted from an
 * `AFP_AGENTS_FILE`, in `test/adr0029.test.ts`'s style, used by both
 * `test/adr0038.test.ts` (the collection and the command form) and
 * `test/adr0038-cli.test.ts` (the `task`/`show` CLIs against it). Not a test
 * file itself: `npm run gate`'s glob is `test/*.test.ts`.
 */

import assert from "node:assert/strict";
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
import { agentCollection, DEFAULT_SINCE } from "../src/agents.ts";
import { Scheduler } from "../src/runtime/scheduler.ts";
import { httpTransport } from "../src/federation/transport.ts";
import { workspace } from "./helpers.ts";

export const VERIFIER = join(import.meta.dirname, "..", "..", "verifier", "afp_verify.py");
export const INSTANCE_DIR = join(import.meta.dirname, "..");
const SCHEDULER = { sweepMs: 30_000, flushMs: 10_000, convergeMs: 60_000, heartbeatMs: 0, jitterMs: 0 };

export function freePort(): Promise<number> {
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

export function writeAgentsFile(paths: { dataDir: string }, entries: unknown): string {
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
export async function taskServe(options: { clock?: Clock; globalBrain?: "stub" | "llm" } = {}) {
  const clock = options.clock ?? jumpClock("2026-09-13T09:00:00.000Z");
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const paths = workspace();
  const agentsFile = writeAgentsFile(paths, [
    { name: "controller", capabilities: [], brain: "none" },
    { name: "worker", capabilities: ["afp:cap:assess", "afp:cap:review"], brain: "stub" },
    // G10's second agent: consumes markdown as bytes (ADR-0027 Decision 2).
    { name: "reviewer", capabilities: ["afp:cap:review"], brain: "stub", consumes: ["text/markdown"] },
  ]);
  const foreignOrigin = "https://other.example";
  const foreignUrl = `${foreignOrigin}/agents/boss`;
  const controllers = [`${origin}/agents/controller`, foreignUrl];
  // A wide per-address bucket: the CLI cases fire several signed reads —
  // each with the read gate's own fetch of the controller's document — inside
  // one second, which the default 20/s bucket would answer 429.
  // `globalBrain` overrides the workspace's AFP_BRAIN=stub: an operator's
  // default is `llm`, and the collection's own brain kinds — not that global
  // — must be what the published policy lists (ADR-0038, found by walkthrough).
  const config = loadConfig({ ...paths, brain: options.globalBrain ?? paths.brain, origin, agentsFile, controllers, rateLimitPerAddress: 1000 });
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

/**
 * The CLI harness: a served instance on the wall clock with a performed
 * task, and the `show`/`task` CLIs run against it from a *separate* data dir
 * that holds a copy of the keys and no store — so "never opens the store" is
 * checked by the absence of any `afp.db`/`afp.db.lock` there, not inferred.
 * Spawned asynchronously: the served instance lives in the test process, so
 * a synchronous exec would block the very event loop that has to answer the
 * child's requests (and the read gate's fetch of the controller's document).
 */
export async function showServe(options: { globalBrain?: "stub" | "llm" } = {}) {
  const served = await taskServe({ clock: systemClock, ...options });
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
  const cli = async (command: string, args: string[]) => {
    try {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--disable-warning=ExperimentalWarning", "src/cli.ts", command, ...args], {
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
  const show = (args: string[]) => cli("show", args);
  const task = (args: string[]) => cli("task", args);
  const noStoreOpened = () => {
    assert.equal(existsSync(join(clientData, "afp.db")), false, "the CLI created no store");
    assert.equal(existsSync(join(clientData, "afp.db.lock")), false, "the CLI took no lock");
  };
  return { ...served, slug, thread, show, task, noStoreOpened };
}

export function heads(instance: AfpInstance, names: readonly string[]): string[] {
  return names.map((name) => instance.outbox.headDigest(instance.actorId(name)) ?? "");
}
