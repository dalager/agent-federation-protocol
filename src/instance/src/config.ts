/**
 * Environment abstraction. Nothing in the codebase reads `process.env` directly,
 * and no secret ever appears here — API keys are read by name at the point of
 * use, keys live on disk outside the repo.
 */

import { resolve } from "node:path";

export interface Config {
  /** Public origin the instance publishes itself under. */
  readonly origin: string;
  readonly operator: string;
  readonly instanceName: string;
  readonly dataDir: string;
  readonly dbPath: string;
  readonly keyDir: string;
  readonly artifactDir: string;
  readonly exportDir: string;
  readonly httpPort: number;
  /** Which brain implementation the agents run behind their port. */
  readonly brain: "stub" | "llm";
  /** OpenAI-compatible endpoint, including the version segment. */
  readonly llmBaseUrl: string;
  readonly llmModel: string;
  readonly llmMaxTokens: number;
  readonly llmTimeoutMs: number;
  /** Delivery attempts before an activity is dead-lettered. */
  readonly maxDeliveryAttempts: number;
  /** Base backoff in ms; attempt N waits base * 2^(N-1). */
  readonly backoffBaseMs: number;
  /** How long a seen activity id blocks redelivery. */
  readonly seenIdTtlMs: number;
}

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be an integer, got ${raw}`);
  return parsed;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = resolve(overrides.dataDir ?? env("AFP_DATA_DIR", "./data"));
  const brain = env("AFP_BRAIN", "llm");
  if (brain !== "stub" && brain !== "llm") {
    throw new Error(`AFP_BRAIN must be "stub" or "llm", got ${brain}`);
  }

  const base: Config = {
    origin: env("AFP_ORIGIN", "https://alpha.operator.local"),
    operator: env("AFP_OPERATOR", "Alpha Operator"),
    instanceName: env("AFP_INSTANCE_NAME", "Alpha Operator Instance"),
    dataDir,
    dbPath: resolve(dataDir, "afp.db"),
    keyDir: resolve(dataDir, "keys"),
    artifactDir: resolve(dataDir, "artifacts"),
    exportDir: resolve(overrides.exportDir ?? env("AFP_EXPORT_DIR", "./export")),
    httpPort: envInt("AFP_PORT", 8787),
    brain,
    llmBaseUrl: env("AFP_LLM_BASE_URL", "http://localhost:13305/api/v1"),
    llmModel: env("AFP_LLM_MODEL", "Qwen3.6-35B-A3B-NoThinking"),
    llmMaxTokens: envInt("AFP_LLM_MAX_TOKENS", 900),
    llmTimeoutMs: envInt("AFP_LLM_TIMEOUT_MS", 120000),
    maxDeliveryAttempts: envInt("AFP_MAX_DELIVERY_ATTEMPTS", 5),
    backoffBaseMs: envInt("AFP_BACKOFF_BASE_MS", 50),
    seenIdTtlMs: envInt("AFP_SEEN_ID_TTL_MS", 24 * 60 * 60 * 1000),
  };

  return { ...base, ...overrides };
}
