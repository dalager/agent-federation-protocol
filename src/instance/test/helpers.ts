/**
 * Shared test scaffolding.
 *
 * Isolated workspaces are pinned to the deterministic brains: the gate must be
 * reproducible and runnable offline, and gate check 10 shells out to a second
 * implementation that has to agree byte for byte.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runDemo, fixedClock } from "../src/demo.ts";
import type { AfpInstance } from "../src/instance.ts";
import type { JsonValue } from "../src/crypto/jcs.ts";

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
