/**
 * Brains backed by an OpenAI-compatible chat-completions endpoint.
 *
 * Written against the wire protocol with `fetch` rather than a vendor SDK, so
 * the instance keeps zero runtime dependencies and any compatible server works:
 * the reference deployment is a local Lemonade server running Qwen, but the same
 * adapter points at a hosted endpoint by changing two environment variables.
 *
 * This file implements `brains/port.ts` and nothing else. It knows nothing about
 * ActivityPub, signing, or the record — swapping model providers cannot change
 * the shape of what ends up in the outbox.
 */

import type { Brain, TaskOutcome, TaskRequest } from "./port.ts";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export interface LlmEndpoint {
  /** Base URL including the version segment, e.g. `http://localhost:13305/api/v1`. */
  baseUrl: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
  /** Optional — a local server usually needs none. Read at the point of use. */
  apiKey?: string;
}

interface ChatCompletion {
  model?: string;
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: { total_tokens?: number };
  error?: { message?: string };
}

/**
 * One chat completion. Returns the assistant text, or throws with a message
 * that says what a human should actually go and check.
 */
async function complete(
  endpoint: LlmEndpoint,
  system: string,
  user: string,
): Promise<{ text: string; model: string }> {
  const url = `${endpoint.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (endpoint.apiKey) headers.authorization = `Bearer ${endpoint.apiKey}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: endpoint.model,
        max_tokens: endpoint.maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(endpoint.timeoutMs),
    });
  } catch (error) {
    const reason = (error as Error).name === "TimeoutError"
      ? `no response within ${endpoint.timeoutMs}ms`
      : (error as Error).message;
    throw new Error(`cannot reach ${url}: ${reason}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${url} returned ${response.status}: ${body.slice(0, 200)}`);
  }

  const payload = (await response.json()) as ChatCompletion;
  if (payload.error?.message) throw new Error(`endpoint error: ${payload.error.message}`);

  const text = payload.choices?.[0]?.message?.content?.trim() ?? "";
  if (!text) throw new Error("endpoint returned no assistant text");

  return { text, model: payload.model ?? endpoint.model };
}

export function makeLlmBrain(
  name: string,
  capabilities: readonly string[],
  systemPrompt: string,
  endpoint: LlmEndpoint,
): Brain {
  return {
    name,
    capabilities,
    async handle(request: TaskRequest): Promise<TaskOutcome> {
      const attachments = request.attachments
        .map((artifact, index) =>
          `--- attachment ${index + 1} (${artifact.mediaType}) ---\n${decoder.decode(artifact.bytes)}`,
        )
        .join("\n\n");

      const user = attachments ? `${request.content}\n\n${attachments}` : request.content;

      try {
        const { text, model } = await complete(endpoint, systemPrompt, user);
        return {
          ok: true,
          content: text,
          summary: firstLine(text),
          // Which model produced this becomes part of the record: an auditor
          // asking "what made this claim" should not have to take the agent's
          // word for it (04 § Rationale externalization).
          producedBy: `${model} @ ${endpoint.baseUrl}`,
          attachments: [{ mediaType: "text/markdown", bytes: encoder.encode(`${text}\n`) }],
        };
      } catch (error) {
        // A failure here becomes a signed `afp:Error` in the record rather than
        // a thrown exception — the trail says the model was unreachable.
        return { ok: false, reason: (error as Error).message };
      }
    },
  };
}

function firstLine(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  return line.replace(/^#+\s*/, "").trim().slice(0, 120);
}

export const WRITER_PROMPT = [
  "You are a technical writer working inside an audited agent workflow.",
  "Answer the brief as a short markdown note of two or three paragraphs.",
  "State every assumption you rely on explicitly, in its own sentence, because a",
  "reviewer will check them. Do not ask questions; produce the note.",
].join(" ");

export const REVIEWER_PROMPT = [
  "You are a reviewer working inside an audited agent workflow.",
  "Critique the attached draft for unstated assumptions and unsupported claims.",
  "Begin your reply with 'Approved:' or 'Rejected:' followed by one sentence of",
  "justification, then give your specific findings as a short markdown list.",
].join(" ");

/** Probe the endpoint so the CLI can fail early with something actionable. */
export async function checkEndpoint(endpoint: LlmEndpoint): Promise<string | null> {
  try {
    const response = await fetch(`${endpoint.baseUrl.replace(/\/$/, "")}/models`, {
      signal: AbortSignal.timeout(endpoint.timeoutMs),
    });
    if (!response.ok) return `${endpoint.baseUrl} returned ${response.status}`;
    const payload = (await response.json()) as { data?: { id?: string }[] };
    const ids = (payload.data ?? []).map((entry) => entry.id);
    return ids.includes(endpoint.model)
      ? null
      : `model ${endpoint.model} is not served by ${endpoint.baseUrl}`;
  } catch (error) {
    return `cannot reach ${endpoint.baseUrl}: ${(error as Error).message}`;
  }
}
