/**
 * Environment abstraction. Every environment read in the codebase goes through
 * this module — `loadConfig` for an instance's own settings, `devModeFromEnv`
 * for the handful of fetch call sites that run before a `Config` is in scope
 * (ADR-0025; making the policy a required argument there instead is the
 * standing cleanup). No secret ever appears here — API keys are read by name at
 * the point of use, keys live on disk outside the repo.
 */

import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

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
  /**
   * ADR-0027 Decision 5: endpoint origins the `llm` brain may talk to. A brain
   * built against anything else is refused at startup. Defaults to the
   * configured `llmBaseUrl` alone — the reference brain's only network is the
   * endpoint it was configured with, and widening that is an explicit act.
   */
  readonly llmAllowedEndpoints: readonly string[];
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

  // ---------------------------------------------------------- ADR-0026

  /**
   * ADR-0026 Decision 1: a file holding the passphrase the `file` signer
   * adapter's PEMs are encrypted with at rest. Absent means unencrypted PEMs,
   * which is every deployment before this ADR. The passphrase itself is read
   * at the point of use and never enters a Config field, a log or the record
   * — this names the file, not the secret.
   */
  readonly keyPassphraseFile?: string;

  // ---------------------------------------------------------- ADR-0028

  /**
   * ADR-0028 Decision 4: actor URLs of human controllers authorized to
   * approve through an `ApprovalPort`. Stands in for ADR-0033's signed policy
   * document until it exists — ADR-0029 Decision 2 says the controller list
   * belongs there; until it does, this is where the instance's own policy
   * names who may approve. Empty by default: no controller is authorized
   * until an operator configures one.
   */
  readonly controllers: readonly string[];

  // ---------------------------------------------------------- ADR-0029

  /**
   * ADR-0029 Decision 3: dual-publish a `public` `Create{Note}` shadow (built
   * by `federation/visibility.ts` `shadowNote`) alongside every event 04
   * lists as operator-visible. Off by default — this is a profile, not the
   * premise (Decision 1): AFP objects are not consumable by fediverse
   * software by design, and until delivery to a real Mastodon inbox exists
   * (ADR-0023 L18, parked — it needs an RSA shim this instance does not
   * have), the window is only "followable by AFP-aware software and by
   * anything that can read a public outbox".
   */
  readonly fediverseWindow: boolean;
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

/**
 * ADR-0026 Decision 1: the passphrase protecting the `file` adapter's PEMs at
 * rest, read from the file `AFP_KEY_PASSPHRASE_FILE` names. Read at the point
 * of use, never stored on `Config` — the same discipline `AFP_LLM_API_KEY`
 * has always had.
 */
export function keyPassphraseFromEnv(): string | undefined {
  const file = env("AFP_KEY_PASSPHRASE_FILE", "");
  if (!file || !existsSync(file)) return undefined;
  const passphrase = readFileSync(file, "utf8").trim();
  return passphrase.length > 0 ? passphrase : undefined;
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

  const llmBaseUrl = env("AFP_LLM_BASE_URL", "http://localhost:13305/api/v1");
  // ADR-0027 Decision 5: an unset allow-list is not "anything" — it is the one
  // endpoint this instance was configured with.
  const llmAllowedEndpoints = env("AFP_LLM_ALLOWED_ENDPOINTS", "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

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
    llmBaseUrl,
    llmModel: env("AFP_LLM_MODEL", "Qwen3.6-35B-A3B-NoThinking"),
    llmMaxTokens: envInt("AFP_LLM_MAX_TOKENS", 900),
    llmTimeoutMs: envInt("AFP_LLM_TIMEOUT_MS", 120000),
    llmAllowedEndpoints: llmAllowedEndpoints.length > 0 ? llmAllowedEndpoints : [llmBaseUrl],
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
    ...(env("AFP_KEY_PASSPHRASE_FILE", "") ? { keyPassphraseFile: env("AFP_KEY_PASSPHRASE_FILE", "") } : {}),
    controllers: env("AFP_CONTROLLERS", "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    fediverseWindow: env("AFP_FEDIVERSE_WINDOW", "0") === "1",
  };

  return { ...base, ...overrides };
}
