/**
 * Anthropic-backed brains — the same port, a real model behind it.
 *
 * Loaded dynamically so the P1 core keeps zero required dependencies and the
 * acceptance gate runs offline. The API key is read from the environment at the
 * point of use and never stored, logged, or written into the record.
 */

import type { Brain, TaskOutcome, TaskRequest } from "./port.ts";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

interface AnthropicClient {
  messages: {
    create(request: unknown): Promise<{ content: { type: string; text?: string }[] }>;
  };
}

async function loadClient(): Promise<AnthropicClient> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set; use AFP_BRAIN=stub to run offline");
  }
  try {
    const module = (await import("@anthropic-ai/sdk")) as { default: new () => AnthropicClient };
    return new module.default();
  } catch {
    throw new Error("@anthropic-ai/sdk is not installed; run `npm i @anthropic-ai/sdk`");
  }
}

export function makeAnthropicBrain(
  name: string,
  capabilities: readonly string[],
  systemPrompt: string,
  model: string,
): Brain {
  return {
    name,
    capabilities,
    async handle(request: TaskRequest): Promise<TaskOutcome> {
      let client: AnthropicClient;
      try {
        client = await loadClient();
      } catch (error) {
        return { ok: false, reason: (error as Error).message };
      }

      const attachments = request.attachments
        .map((artifact, i) => `--- attachment ${i + 1} (${artifact.mediaType}) ---\n${decoder.decode(artifact.bytes)}`)
        .join("\n\n");

      try {
        const response = await client.messages.create({
          model,
          max_tokens: 2048,
          system: systemPrompt,
          messages: [
            {
              role: "user",
              content: attachments ? `${request.content}\n\n${attachments}` : request.content,
            },
          ],
        });

        const text = response.content
          .filter((block) => block.type === "text")
          .map((block) => block.text ?? "")
          .join("\n")
          .trim();

        if (!text) return { ok: false, reason: "model returned no text content" };

        return {
          ok: true,
          content: text,
          summary: `${name} completed ${request.capability}`,
          attachments: [{ mediaType: "text/markdown", bytes: encoder.encode(text) }],
        };
      } catch (error) {
        return { ok: false, reason: `model call failed: ${(error as Error).message}` };
      }
    },
  };
}

export const WRITER_PROMPT =
  "You are a technical writer. Produce a concise markdown note answering the brief. " +
  "State assumptions explicitly.";

export const REVIEWER_PROMPT =
  "You are a reviewer. Critique the attached draft for unstated assumptions and " +
  "unsupported claims. Begin your reply with either 'Approved:' or 'Rejected:'.";
