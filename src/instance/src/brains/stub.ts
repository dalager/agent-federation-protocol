/**
 * Deterministic brains, used by the demo and the acceptance gate.
 *
 * The gate has to be reproducible and runnable offline — an LLM in the loop
 * would make "did the record verify" depend on sampling. The Anthropic brain in
 * `anthropic.ts` implements the same port and is selected by configuration.
 */

import type { Brain, TaskOutcome, TaskRequest } from "./port.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Counts invocations, so a replayed task can be shown *not* to run twice. */
export class CountingBrain implements Brain {
  invocations = 0;

  readonly name: string;
  readonly capabilities: readonly string[];
  private readonly respond: (request: TaskRequest) => TaskOutcome;

  constructor(
    name: string,
    capabilities: readonly string[],
    respond: (request: TaskRequest) => TaskOutcome,
  ) {
    this.name = name;
    this.capabilities = capabilities;
    this.respond = respond;
  }

  async handle(request: TaskRequest): Promise<TaskOutcome> {
    this.invocations++;
    return this.respond(request);
  }
}

export function makeWriter(): CountingBrain {
  return new CountingBrain("writer", ["afp:cap:draft"], (request) => {
    const source = request.attachments[0];
    const brief = source ? decoder.decode(source.bytes) : request.content;
    const draft = [
      "# Migration readiness note",
      "",
      `Brief: ${brief.trim()}`,
      "",
      "Findings: the billing cutover is feasible within the stated window,",
      "provided the parallel-run period is retained.",
    ].join("\n");

    return {
      ok: true,
      content: "Draft prepared.",
      summary: "draft v1",
      attachments: [{ mediaType: "text/markdown", bytes: encoder.encode(draft) }],
    };
  });
}

export function makeReviewer(): CountingBrain {
  return new CountingBrain("reviewer", ["afp:cap:review"], (request) => {
    const draft = request.attachments[0];
    if (!draft) return { ok: false, reason: "no draft attached to review" };

    const text = decoder.decode(draft.bytes);
    const approved = text.includes("parallel-run");
    const critique = approved
      ? "Approved: the parallel-run assumption is stated explicitly."
      : "Rejected: the parallel-run assumption is missing and the cutover claim rests on it.";

    return {
      ok: true,
      content: critique,
      summary: approved ? "approved" : "changes requested",
      attachments: [{ mediaType: "text/markdown", bytes: encoder.encode(`# Review\n\n${critique}\n`) }],
    };
  });
}

/** A brain that always fails — used to exercise dead-lettering and `afp:Error`. */
export function makeFailingBrain(name: string, capability: string): Brain {
  return {
    name,
    capabilities: [capability],
    async handle(): Promise<TaskOutcome> {
      return { ok: false, reason: "brain is deliberately unavailable" };
    },
  };
}
