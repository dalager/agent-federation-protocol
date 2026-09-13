/**
 * Shared test scaffolding.
 *
 * Isolated workspaces are pinned to the deterministic brains: the gate must be
 * reproducible and runnable offline, and gate check 10 shells out to a second
 * implementation that has to agree byte for byte.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runDemo, fixedClock } from "../src/demo.ts";
import { loadConfig } from "../src/config.ts";
import { AfpInstance, type AgentRegistration } from "../src/instance.ts";
import { jumpClock } from "../src/demoP3.ts";
import { CountingBrain } from "../src/brains/stub.ts";
import { loadOrCreateHubKeyPair, type KeyPair } from "../src/crypto/keys.ts";
import { agentActor } from "../src/ap/documents.ts";
import { Hub } from "../src/hub/hub.ts";
import type { Envelope, Visibility } from "../src/ap/activities.ts";
import type { JsonValue } from "../src/crypto/jcs.ts";

// ADR-0025 Decision 1: the gate runs real HTTP servers over plain
// `http://127.0.0.1` origins throughout — that is what "real sockets, no
// mocked wire" (ADR-0008 Decision 6) has always meant here. Setting this once,
// at import time, is the test-harness equivalent of the demo scripts' own
// `AFP_DEV=1` and keeps every existing gate byte-identical.
if (process.env.AFP_DEV === undefined) {
  process.env.AFP_DEV = "1";
}

const workspaces: string[] = [];

export function workspace(): { dataDir: string; exportDir: string; brain: "stub" } {
  const root = mkdtempSync(join(tmpdir(), "afp-gate-"));
  workspaces.push(root);
  return { dataDir: join(root, "data"), exportDir: join(root, "export"), brain: "stub" };
}

export function cleanupWorkspaces(): void {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
  workspaces.length = 0;
}

/** A full demo run in an isolated workspace. */
export async function freshDemo() {
  return runDemo({ fresh: true, config: workspace(), clock: fixedClock() });
}

export function runVerifier(script: string, dir: string, thread: string, extraArgs: string[] = []) {
  try {
    const output = execFileSync("python3", [script, dir, "--thread", thread, ...extraArgs], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

/**
 * The multi-bundle form of `runVerifier` — one or more export dirs, no
 * implicit `--thread` (each demo's own `verify it:` line decides whether one
 * belongs in `extraArgs`). This is what a joint replay across several
 * operators' bundles looks like on the CLI, and what `test/demos.test.ts`
 * (ADR-0030 Decision 4) replicates for p4–p7.
 */
export function runVerifierMulti(script: string, dirs: string[], extraArgs: string[] = []) {
  try {
    const output = execFileSync("python3", [script, ...dirs, ...extraArgs], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

/**
 * An instance with N same-capability agents on deterministic brains — the bare
 * P1 shape a gate starts from when it has no hub to set up.
 */
export function testInstance(agentNames: readonly string[], capability: string, origin?: string) {
  const paths = workspace();
  const config = loadConfig(origin ? { ...paths, origin } : paths);
  const clock = jumpClock();
  const agents: AgentRegistration[] = agentNames.map((name) => ({
    spec: { name, capabilities: [capability], keyCustody: "instance", since: "2026-08-17T00:00:00Z" },
    brain: new CountingBrain(name, [capability], () => ({ ok: true, content: "n/a" })),
  }));
  return { instance: new AfpInstance(config, agents, clock), config, clock };
}

/**
 * A hub over an existing instance, with per-agent hub keys and the actor
 * resolver wired — the setup every hub-bearing gate repeats verbatim.
 */
export function testHub(instance: AfpInstance, agentNames: readonly string[], hubId: string) {
  const hubKeys = new Map<string, KeyPair>(
    agentNames.map((name) => [
      name,
      loadOrCreateHubKeyPair(instance.config.keyDir, name, instance.actorId(name), hubId),
    ]),
  );
  let hub!: Hub;
  const fetchActor = (actorId: string) => {
    if (actorId === hub.actorId) return hub.actorDocument();
    if (actorId === instance.instanceDocument().id) return instance.instanceDocument();
    const name = instance.nameOf(actorId);
    if (!name) return null;
    const spec = instance.specs.find((s) => s.name === name)!;
    const hubKey = hubKeys.get(name);
    return agentActor(instance.config.origin, spec, instance.key(name), hubKey ? [hubKey] : []);
  };
  hub = new Hub({
    origin: instance.config.origin,
    hubId,
    db: instance.db,
    keyDir: instance.config.keyDir,
    instanceActorId: instance.instanceDocument().id as string,
    maxDeliveryAttempts: instance.config.maxDeliveryAttempts,
    backoffBaseMs: instance.config.backoffBaseMs,
    fetchActor,
    now: () => instance.clock.now(),
  });
  return { hub, hubKeys };
}

/**
 * The raw-body escape hatch: an envelope with an arbitrary body spread over
 * it, for activity shapes the builders deliberately do not emit (`afp:Act`,
 * `afp:BidCommit`) and for the malformed ones a gate needs to publish on
 * purpose.
 */
export function publishRaw(
  instance: AfpInstance,
  name: string,
  to: readonly string[],
  thread: string,
  visibility: Visibility,
  body: { [key: string]: unknown },
) {
  return instance.publish(name, to, thread, visibility, (envelope: Envelope) => ({
    "@context": ["https://www.w3.org/ns/activitystreams", "https://dalager.github.io/agent-federation-protocol/ns/v3.jsonld"],
    id: envelope.activityId,
    actor: envelope.actor,
    to: [...envelope.to],
    published: envelope.published,
    context: envelope.thread,
    "afp:visibility": envelope.visibility,
    ...(envelope.prevActivity !== null ? { "afp:prevActivity": envelope.prevActivity } : {}),
    ...body,
  }) as never);
}

/**
 * Copy a clean export, edit one outbox file, replay the mutated copy.
 *
 * Editing a signed activity breaks its signature too, so a caller asserts the
 * *named* check it meant to break rather than a failure count — the point is
 * which check noticed, not how many did.
 */
export function mutateBundle(
  script: string,
  exportDir: string,
  thread: string,
  outboxName: string,
  edit: (outbox: { orderedItems: Record<string, unknown>[] }) => void,
) {
  const dir = mkdtempSync(join(tmpdir(), "afp-mut-"));
  cpSync(exportDir, dir, { recursive: true });
  const path = join(dir, "outbox", `${outboxName}.jsonld`);
  const outbox = JSON.parse(readFileSync(path, "utf8"));
  edit(outbox);
  outbox.totalItems = outbox.orderedItems.length;
  writeFileSync(path, JSON.stringify(outbox, null, 2));
  return runVerifier(script, dir, thread, ["--verbose"]);
}

export function objectType(activity: { [key: string]: JsonValue }): string {
  const object = activity.object;
  return object && typeof object === "object" && !Array.isArray(object)
    ? String((object as Record<string, JsonValue>).type ?? "")
    : "";
}

export function errorCode(activity: { [key: string]: JsonValue }): JsonValue | undefined {
  const object = activity.object as Record<string, JsonValue> | undefined;
  return object?.["afp:errorCode"];
}

export function correlationOf(activity: { [key: string]: JsonValue }): string {
  const direct = activity["afp:correlationId"];
  if (typeof direct === "string") return direct;
  const object = activity.object as Record<string, JsonValue> | undefined;
  const nested = object?.["afp:correlationId"];
  return typeof nested === "string" ? nested : "";
}

export function attachmentsOf(activity: { [key: string]: JsonValue }): Record<string, JsonValue>[] {
  const object = activity.object as Record<string, JsonValue> | undefined;
  const attachment = object?.attachment;
  return Array.isArray(attachment) ? (attachment as Record<string, JsonValue>[]) : [];
}

export function countResults(instance: AfpInstance, actorName: string): number {
  return instance.outbox
    .byActor(instance.actorId(actorName))
    .filter((entry) => objectType(entry.activity) === "afp:Result").length;
}
