/**
 * The P1 demo: a draft, a critique, a revision — and an export a stranger can check.
 *
 * Two agents in one process, one thread, no network between them. Brains run
 * against an OpenAI-compatible endpoint by default (a local Lemonade server);
 * `AFP_BRAIN=stub` swaps in deterministic brains so the gate stays reproducible
 * and offline. The record is identical in shape either way — that is the port
 * doing its job.
 */

import { rmSync } from "node:fs";
import { loadConfig, type Config } from "./config.ts";
import { AfpInstance, type AgentRegistration, type Clock } from "./instance.ts";
import { makeReviewer, makeWriter } from "./brains/stub.ts";
import { makeLlmBrain, REVIEWER_PROMPT, WRITER_PROMPT } from "./brains/openai.ts";
import { exportBundle, type ExportSummary } from "./export.ts";
import type { Brain } from "./brains/port.ts";
import type { LlmEndpoint } from "./brains/openai.ts";

const encoder = new TextEncoder();

const BRIEF =
  "Assess whether the billing platform cutover fits a 15-minute downtime window, " +
  "given PCI scope must not expand.";

/** A clock that advances by fixed steps, so repeated runs are comparable. */
export function fixedClock(start = "2026-08-17T09:00:00.000Z", stepMs = 1000): Clock {
  let t = new Date(start).getTime();
  return {
    now() {
      const now = new Date(t);
      t += stepMs;
      return now;
    },
  };
}

/** Endpoint settings assembled from config; the API key never leaves this call. */
export function endpointOf(config: Config): LlmEndpoint {
  return {
    baseUrl: config.llmBaseUrl,
    model: config.llmModel,
    maxTokens: config.llmMaxTokens,
    timeoutMs: config.llmTimeoutMs,
    apiKey: process.env.AFP_LLM_API_KEY,
  };
}

function brains(config: Config): { writer: Brain; reviewer: Brain } {
  if (config.brain === "llm") {
    const endpoint = endpointOf(config);
    return {
      writer: makeLlmBrain("writer", ["afp:cap:draft"], WRITER_PROMPT, endpoint),
      reviewer: makeLlmBrain("reviewer", ["afp:cap:review"], REVIEWER_PROMPT, endpoint),
    };
  }
  return { writer: makeWriter(), reviewer: makeReviewer() };
}

export function agentRegistrations(config: Config): AgentRegistration[] {
  const { writer, reviewer } = brains(config);
  const since = "2026-08-17T00:00:00Z";
  return [
    {
      spec: { name: "writer", capabilities: writer.capabilities, keyCustody: "instance", since },
      brain: writer,
    },
    {
      spec: { name: "reviewer", capabilities: reviewer.capabilities, keyCustody: "instance", since },
      brain: reviewer,
    },
  ];
}

export interface DemoResult {
  instance: AfpInstance;
  thread: string;
  exported: ExportSummary;
}

/**
 * Run the demo end to end.
 *
 * The thread is one `context` spanning two tasks, each with its own
 * `correlationId` — the split that scenario 02 forced into the spec.
 */
export async function runDemo(
  options: { fresh?: boolean; config?: Partial<Config>; clock?: Clock } = {},
): Promise<DemoResult> {
  const config = loadConfig(options.config);
  if (options.fresh) {
    rmSync(config.dataDir, { recursive: true, force: true });
    rmSync(config.exportDir, { recursive: true, force: true });
  }

  const instance = new AfpInstance(config, agentRegistrations(config), options.clock ?? fixedClock());
  const thread = "urn:afp:thread:doc-1";

  // The human hands the writer a brief, stored as a hash-addressed artifact.
  const brief = instance.artifacts.put(encoder.encode(BRIEF), "text/plain");

  // Task 1 — writer drafts. Delegated to itself: the brief comes from outside
  // AFP, so the first hop is the operator asking their own agent to work.
  instance.delegate({
    from: "reviewer",
    to: "writer",
    capability: "afp:cap:draft",
    content: "Draft a readiness note from the attached brief.",
    thread,
    correlationId: "task-1",
    attachments: [brief],
  });
  await instance.run();

  // Task 2 — reviewer critiques the draft the writer just produced.
  const draft = latestAttachment(instance, "writer");
  instance.delegate({
    from: "writer",
    to: "reviewer",
    capability: "afp:cap:review",
    content: "Review the attached draft for unstated assumptions.",
    thread,
    correlationId: "task-2",
    attachments: draft ? [draft] : [],
  });
  await instance.run();

  const exported = exportBundle(instance, config.exportDir);
  return { instance, thread, exported };
}

/** The most recent artifact an actor attached to a Result. */
function latestAttachment(instance: AfpInstance, actorName: string) {
  const entries = instance.outbox.byActor(instance.actorId(actorName));
  for (let i = entries.length - 1; i >= 0; i--) {
    const object = entries[i].activity.object;
    if (!object || typeof object !== "object" || Array.isArray(object)) continue;
    const attachment = (object as Record<string, unknown>).attachment;
    if (!Array.isArray(attachment) || attachment.length === 0) continue;
    const digest = (attachment[0] as Record<string, unknown>)["afp:digest"];
    if (typeof digest !== "string") continue;
    const ref = instance.artifacts.lookup(digest);
    if (ref) return ref;
  }
  return null;
}
