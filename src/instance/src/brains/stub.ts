/**
 * Deterministic brains, used by the demo and the acceptance gate.
 *
 * The gate has to be reproducible and runnable offline — an LLM in the loop
 * would make "did the record verify" depend on sampling, and gate check 10 needs
 * two independent implementations to agree byte for byte. The endpoint-backed
 * brain in `openai.ts` implements the same port and is selected by configuration.
 */

import { textOf, type Brain, type TaskOutcome, type TaskRequest } from "./port.ts";

const encoder = new TextEncoder();

/** Counts invocations, so a replayed task can be shown *not* to run twice. */
export class CountingBrain implements Brain {
  invocations = 0;

  readonly name: string;
  readonly capabilities: readonly string[];
  /** ADR-0027 Decision 2: media types this brain consumes as bytes, if any. */
  readonly consumes?: readonly string[];
  private readonly respond: (request: TaskRequest) => TaskOutcome;

  constructor(
    name: string,
    capabilities: readonly string[],
    respond: (request: TaskRequest) => TaskOutcome,
    consumes?: readonly string[],
  ) {
    this.name = name;
    this.capabilities = capabilities;
    if (consumes) this.consumes = consumes;
    this.respond = respond;
  }

  async handle(request: TaskRequest): Promise<TaskOutcome> {
    this.invocations++;
    return this.respond(request);
  }
}

export function makeWriter(): CountingBrain {
  return new CountingBrain("writer", ["afp:cap:draft"], (request) => {
    // ADR-0027 Decision 2: read what the port allowed — the bounded excerpt,
    // or the full bytes when this agent declared it consumes the type.
    const source = request.attachments[0];
    const brief = source ? textOf(source) : request.content;
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
  // ADR-0027 Decision 2: the reviewer reads a whole draft, so it declares the
  // type it consumes rather than depending on the excerpt bound. The stub and
  // the endpoint-backed reviewer declare the same thing, so the offline gate
  // and the llm demo agree about what a reviewer was given.
  return new CountingBrain("reviewer", ["afp:cap:review"], (request) => {
    const draft = request.attachments[0];
    if (!draft) return { ok: false, reason: "no draft attached to review" };

    const text = textOf(draft);
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
  }, ["text/markdown"]);
}

/**
 * ADR-0038 Decision 1: the deterministic brain an `AFP_AGENTS_FILE` entry
 * with `brain: "stub"` gets. It answers any capability it advertises by
 * echoing the brief back under a fixed heading, and names itself `stub` in
 * `afp:producedBy` — the same value the default policy lists
 * (`config.ts` `assemblePolicy`), so a served instance's Results replay
 * clean under `check_policy` without an operator writing a policy file.
 */
export function makeEchoBrain(name: string, capabilities: readonly string[], consumes?: readonly string[]): CountingBrain {
  return new CountingBrain(name, capabilities, (request) => {
    const source = request.attachments[0];
    const heading = `# ${name}: ${request.capability}`;
    const body = source ? textOf(source) : request.content;
    return {
      ok: true,
      content: `${heading}\n\n${body.trim()}\n`,
      summary: `${name} answered ${request.capability}`,
      producedBy: "stub",
      attachments: [{ mediaType: "text/markdown", bytes: encoder.encode(`${heading}\n\n${body.trim()}\n`) }],
    };
  }, consumes);
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
