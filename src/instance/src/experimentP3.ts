/**
 * The P3 Lemonade experiment: the same allocation flow as `demoP3.ts`, but the
 * coalition's partial answers and the Synthesis are produced by a real local
 * model (an OpenAI-compatible Lemonade endpoint) instead of stub text.
 *
 * What varies is only who writes the words — bids, sealing, selection, and
 * ratification are the deterministic machinery, and the exported record has
 * exactly the same shape. Which is the point of the experiment: see how the
 * record reads when the content is real, and confirm the verifier neither
 * knows nor cares where the prose came from.
 *
 * Fails loudly rather than falling back: an experiment that quietly reverts
 * to stub content would be reporting on nothing.
 */

import type { LlmEndpoint } from "./brains/openai.ts";
import { checkEndpoint, makeLlmBrain } from "./brains/openai.ts";
import { runP3Demo, type P3DemoResult } from "./demoP3.ts";
import { ESTIMATION_PANEL, type AgentProfile } from "./profiles.ts";
import type { Config } from "./config.ts";
import type { JsonValue } from "./crypto/jcs.ts";

const QUESTION = [
  "Estimate the cost of migrating our payments platform off the legacy on-prem",
  "stack to a managed cloud provider: ~40 services, a 6 TB transaction store,",
  "PCI-DSS scope, and 14 third-party licensing agreements. Target is a Q3",
  "cutover with a dual-run parallel period.",
].join(" ");

/**
 * The persona comes from the same profile the bid coverage came from
 * (profiles.ts): the model is told to be exactly the specialist it bid as,
 * never a separately maintained prompt that can outgrow the declaration.
 */
function estimatorSystem(profile: AgentProfile, domains: string[]): string {
  return [
    `You are ${profile.name}, a ${profile.persona}, covering ${domains.join(" and ")} on an estimation panel.`,
    `Estimate ONLY the ${domains.join("/")} portion of the migration cost, in kDKK.`,
    "Reply as short markdown: a cost range on the first line in the form",
    "'Range: <low>–<high> kDKK', then 2-3 bullet points naming the cost drivers,",
    "then exactly one line 'Assumption: <the one assumption you rely on most>'.",
    "If you believe the plan is infeasible in the stated timeline regardless of",
    "cost, end with a final line 'OBJECTION: <one sentence>'; otherwise end with",
    "'OBJECTION: none'. Do not ask questions.",
  ].join(" ");
}

function synthesizerSystem(): string {
  return [
    "You are the synthesizer on an estimation panel. You receive each",
    "specialist's partial cost estimate for disjoint domains of one migration.",
    "Combine them into a single total range: low_kdkk is the sum of every",
    "specialist's low bound and high_kdkk the sum of every high bound, reduced",
    "only where two specialists priced the same overlapping domain. The total",
    "range can never be narrower than any single input range. Reply with ONLY a JSON",
    'object, no prose: {"method": string, "low_kdkk": integer, "high_kdkk":',
    'integer, "confidence_pct": integer between 0 and 100, "assumptions":',
    "[array of short strings]}.",
  ].join(" ");
}

async function ask(endpoint: LlmEndpoint, name: string, system: string, user: string) {
  const brain = makeLlmBrain(name, ["afp:cap:estimate"], system, endpoint);
  const outcome = await brain.handle({ capability: "afp:cap:estimate", content: user, attachments: [], thread: "" });
  if (!outcome.ok) throw new Error(`model call for ${name} failed: ${outcome.reason}`);
  return { content: outcome.content, producedBy: outcome.producedBy ?? endpoint.model };
}

function parseObjection(content: string): string | null {
  const line = [...content.split("\n")].reverse().find((l) => l.trim().toUpperCase().startsWith("OBJECTION:"));
  if (!line) return null;
  const text = line.slice(line.indexOf(":") + 1).trim();
  return !text || /^none\b/i.test(text) ? null : text;
}

function parseSynthesis(text: string): { method: string; answer: JsonValue; confidence: number; assumptions: string[] } {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) throw new Error(`synthesizer returned no JSON object:\n${text}`);
  const parsed = JSON.parse(match[0]) as {
    method?: unknown; low_kdkk?: unknown; high_kdkk?: unknown; confidence_pct?: unknown; assumptions?: unknown;
  };
  const low = Math.round(Number(parsed.low_kdkk));
  const high = Math.round(Number(parsed.high_kdkk));
  const confidence = Math.min(100, Math.max(0, Math.round(Number(parsed.confidence_pct))));
  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    throw new Error(`synthesizer JSON has no numeric range: ${match[0]}`);
  }
  // Integers throughout — the AFP JCS profile forbids non-integer numbers.
  return {
    method: typeof parsed.method === "string" && parsed.method ? parsed.method : "sum-of-disjoint-ranges",
    answer: { unit: "kDKK", low, high },
    confidence,
    assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions.map(String).slice(0, 6) : [],
  };
}

export async function runP3Experiment(options: {
  endpoint: LlmEndpoint;
  config?: Partial<Config>;
}): Promise<P3DemoResult & { partials: { name: string; content: string }[] }> {
  const problem = await checkEndpoint(options.endpoint);
  if (problem) throw new Error(`brain endpoint unavailable: ${problem}`);

  const partials: { name: string; content: string }[] = [];
  const result = await runP3Demo({
    fresh: true,
    config: options.config,
    content: {
      resultOf: async (name, domains) => {
        const profile = ESTIMATION_PANEL.find((p) => p.name === name)!;
        const produced = await ask(options.endpoint, name, estimatorSystem(profile, domains), QUESTION);
        partials.push({ name, content: produced.content });
        return { ...produced, objection: parseObjection(produced.content) };
      },
      synthesize: async (inputs) => {
        const brief = inputs
          .map((input) =>
            `--- ${input.name} ---\n${input.content}` + (input.objection ? `\n(raised objection: ${input.objection})` : ""),
          )
          .join("\n\n");
        // One retry: a local model occasionally wraps the JSON in prose.
        try {
          return parseSynthesis((await ask(options.endpoint, "synthesizer", synthesizerSystem(), brief)).content);
        } catch {
          return parseSynthesis((await ask(options.endpoint, "synthesizer", synthesizerSystem(), brief)).content);
        }
      },
    },
  });

  return { ...result, partials };
}
