/**
 * Environment abstraction. Every environment read in the codebase goes through
 * this module — `loadConfig` for an instance's own settings, `devModeFromEnv`
 * for the handful of fetch call sites that run before a `Config` is in scope
 * (ADR-0025; making the policy a required argument there instead is the
 * standing cleanup). No secret ever appears here — API keys are read by name at
 * the point of use, keys live on disk outside the repo.
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

  // ---------------------------------------------------------- ADR-0025

  /**
   * Development mode (ADR-0025 Decision 1): `http:` origins, loopback and
   * private-range fetch targets, and literal-IP hosts are permitted. Every
   * demo and the gate run this way; a served production instance must not,
   * silently or otherwise — `loadConfig` refuses an `http:` origin when this
   * is false.
   */
  readonly devMode: boolean;
  /**
   * Named private/loopback ranges an operator's own network legitimately
   * uses (e.g. a hub reached over a corporate VPN) — the address policy's
   * escape hatch outside dev mode, comma-separated CIDRs.
   */
  readonly trustedNets: readonly string[];
  /** Inbox POST body cap in bytes (ADR-0025 Decision 4). */
  readonly maxInboxBodyBytes: number;
  /** Rate-limit bucket size and refill for unauthenticated inbox POSTs / reads. */
  readonly rateLimitPerAddress: number;
  readonly rateLimitPerAddressWindowMs: number;
  /** Rate-limit bucket for a signature-verified actor. */
  readonly rateLimitPerActor: number;
  readonly rateLimitPerActorWindowMs: number;
  /** TTL for the signed-request replay cache — the signature skew window. */
  readonly replayCacheTtlMs: number;
}

/**
 * ADR-0025 Decision 1: whether `AFP_DEV=1` is set, read the same way
 * `loadConfig` reads it. Exists for the handful of call sites (every demo
 * file's direct use of `fetchActorDocument`) that fetch before an instance's
 * own `Config` is in scope to thread through.
 */
export function devModeFromEnv(): boolean {
  return env("AFP_DEV", "0") === "1";
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

  const devMode = overrides.devMode ?? env("AFP_DEV", "0") === "1";
  const origin = overrides.origin ?? env("AFP_ORIGIN", "https://alpha.operator.local");
  // ADR-0025 Decision 1: refused at load time, not discovered at the first
  // outbound fetch — an operator who forgot AFP_DEV finds out before the
  // instance ever answers a request.
  if (!devMode && !origin.startsWith("https:")) {
    throw new Error(
      `AFP_ORIGIN must be https: outside development mode, got "${origin}" — set AFP_DEV=1 to run over http:`,
    );
  }

  const base: Config = {
    origin,
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
    devMode,
    trustedNets: env("AFP_TRUSTED_NETS", "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    maxInboxBodyBytes: envInt("AFP_MAX_INBOX_BODY_BYTES", 1024 * 1024),
    rateLimitPerAddress: envInt("AFP_RATE_LIMIT_PER_ADDRESS", 20),
    rateLimitPerAddressWindowMs: envInt("AFP_RATE_LIMIT_PER_ADDRESS_WINDOW_MS", 1000),
    rateLimitPerActor: envInt("AFP_RATE_LIMIT_PER_ACTOR", 60),
    rateLimitPerActorWindowMs: envInt("AFP_RATE_LIMIT_PER_ACTOR_WINDOW_MS", 60 * 1000),
    replayCacheTtlMs: envInt("AFP_REPLAY_CACHE_TTL_MS", 5 * 60 * 1000),
  };

  return { ...base, ...overrides };
}
