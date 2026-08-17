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

  const clock = options.clock ?? fixedClock();
  const instance = new AfpInstance(config, agentRegistrations(config), clock);
  const thread = "urn:afp:thread:doc-1";
  const writer = brainOf(instance, "writer");

  // The human hands the writer a brief. It entered from outside AFP, so it
  // carries source provenance — otherwise the trail begins at "the agent said
  // so" (07 § Artifacts).
  const brief = instance.artifacts.put(encoder.encode(BRIEF), "text/plain", clock.now(), {
    sourceUrl: "urn:afp:operator-brief:doc-1",
    fetchedAt: clock.now().toISOString(),
  });

  // The writer drafts. This is the writer's own work rather than a delegated
  // task — nobody asked it via AFP — so it enters the record as a signed,
  // hash-addressed attachment on the Offer it then sends.
  const drafted = await writer.handle({
    capability: "afp:cap:draft",
    content: "Draft a readiness note from the attached brief.",
    attachments: [{ mediaType: "text/plain", bytes: encoder.encode(BRIEF) }],
    thread,
  });
  if (!drafted.ok) throw new Error(`writer could not draft: ${drafted.reason}`);
  const draft = storeOutput(instance, drafted, clock.now());

  // Task 1 — review the draft.
  instance.delegate({
    from: "writer",
    to: "reviewer",
    capability: "afp:cap:review",
    content: "Review the attached draft for unstated assumptions.",
    thread,
    correlationId: "task-1",
    attachments: [brief, draft],
    producedBy: drafted.producedBy,
    deadline: new Date(clock.now().getTime() + 10 * 60_000).toISOString(),
  });
  await instance.run();

  // The writer revises against the critique, then asks again. This is the
  // revision the spec's demo is named for: the record has to show the argument,
  // not just its conclusion.
  const critique = latestResultContent(instance, "reviewer");
  const revised = await writer.handle({
    capability: "afp:cap:draft",
    content: `Revise your note to address this critique.\n\n${critique}`,
    attachments: [{ mediaType: "text/plain", bytes: encoder.encode(BRIEF) }],
    thread,
  });
  if (!revised.ok) throw new Error(`writer could not revise: ${revised.reason}`);
  const revision = storeOutput(instance, revised, clock.now());

  // Task 2 — review the revision.
  instance.delegate({
    from: "writer",
    to: "reviewer",
    capability: "afp:cap:review",
    content: "Review the attached revision; the previous critique is addressed.",
    thread,
    correlationId: "task-2",
    attachments: [brief, revision],
    producedBy: revised.producedBy,
    deadline: new Date(clock.now().getTime() + 10 * 60_000).toISOString(),
  });
  await instance.run();

  const exported = exportBundle(instance, config.exportDir);
  return { instance, thread, exported };
}

function brainOf(instance: AfpInstance, name: string): Brain {
  const brain = instance.brainFor(name);
  if (!brain) throw new Error(`no brain registered for ${name}`);
  return brain;
}

/** Store a brain's first attachment as a hash-addressed artifact. */
function storeOutput(
  instance: AfpInstance,
  outcome: { attachments?: { mediaType: string; bytes: Uint8Array }[]; content: string },
  now: Date,
) {
  const artifact = outcome.attachments?.[0];
  return artifact
    ? instance.artifacts.put(artifact.bytes, artifact.mediaType, now)
    : instance.artifacts.put(encoder.encode(outcome.content), "text/markdown", now);
}

/** The content of an actor's most recent Result — the critique to revise against. */
function latestResultContent(instance: AfpInstance, actorName: string): string {
  const entries = instance.outbox.byActor(instance.actorId(actorName));
  for (let i = entries.length - 1; i >= 0; i--) {
    const object = entries[i].activity.object;
    if (!object || typeof object !== "object" || Array.isArray(object)) continue;
    const record = object as Record<string, unknown>;
    if (record.type === "afp:Result" && typeof record.content === "string") return record.content;
  }
  return "";
}
