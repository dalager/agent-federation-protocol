/**
 * Environment abstraction. Every environment read in the codebase goes through
 * this module — `loadConfig` for an instance's own settings, `devModeFromEnv`
 * for the handful of fetch call sites that run before a `Config` is in scope
 * (ADR-0025; making the policy a required argument there instead is the
 * standing cleanup). No secret ever appears here — API keys are read by name at
 * the point of use, keys live on disk outside the repo.
 *
 * ADR-0032 Decision 3: the flat, environment-backed fields are declared once
 * in `configSchema.ts` and read here through `readEntry` — one table instead
 * of one `env()`/`envInt()` call site per field. `validate()` below walks that
 * same table, plus the handful of derived fields (paths under `dataDir`, the
 * `AFP_ORIGIN` scheme, secret-file readability) that are not one environment
 * variable each, and reports every problem it finds — never throwing at the
 * first. Every secret is a *path* in the environment, never a value: a
 * process listing of a instance running this file leaks nothing.
 */

import { resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_SCHEMA, readEntry, type ConfigEntry } from "./configSchema.ts";

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

  /**
   * ADR-0032 Decision 3: the ADR-0028 webhook initiator's shared secret, as a
   * file path — never a value in the environment. Absent means the webhook
   * route's secret is configured some other way (a demo's own literal, today).
   */
  readonly webhookSecretFile?: string;

  /**
   * ADR-0032 Decision 3 / ADR-0035: the remote signer's client certificate
   * file. Validated as readable by `validate()`; nothing in this codebase
   * consumes it yet — the remote signer adapter of ADR-0035 is where it
   * will be read.
   */
  readonly signerClientCertFile?: string;

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

  // ---------------------------------------------------------- ADR-0031

  /**
   * ADR-0031 Decision 1: the resident scheduler's four loops. `heartbeatMs`
   * of `0` means off — the default, since the heartbeat is an operator
   * option (ADR-0008 Decision 3), not the premise. `jitterMs` bounds a
   * uniform random spread added to each interval so concurrent instances do
   * not tick in lockstep; `0` (the default) is exact.
   */
  readonly scheduler: {
    readonly sweepMs: number;
    readonly flushMs: number;
    readonly convergeMs: number;
    readonly heartbeatMs: number;
    readonly jitterMs: number;
  };
  /** ADR-0031 Decision 6: the exponential backoff schedule's cap in ms. */
  readonly backoffCeilingMs: number;
}

/**
 * ADR-0025 Decision 1: whether `AFP_DEV=1` is set, read the same way
 * `loadConfig` reads it. Exists for the handful of call sites (every demo
 * file's direct use of `fetchActorDocument`) that fetch before an instance's
 * own `Config` is in scope to thread through.
 */
export function devModeFromEnv(): boolean {
  return process.env.AFP_DEV === "1";
}

/**
 * ADR-0032 Decision 3: read a secret file, trimmed, refusing an empty file.
 * Shared by every `*_FILE` secret — `keyPassphraseFromEnv` predates this
 * helper (ADR-0026) and keeps its own shape for compatibility, but is one
 * line different from what this would do.
 */
export function readSecretFile(path: string): string | undefined {
  if (!path || !existsSync(path)) return undefined;
  const value = readFileSync(path, "utf8").trim();
  return value.length > 0 ? value : undefined;
}

/**
 * ADR-0026 Decision 1: the passphrase protecting the `file` adapter's PEMs at
 * rest, read from the file `AFP_KEY_PASSPHRASE_FILE` names. Read at the point
 * of use, never stored on `Config` — the same discipline `AFP_LLM_API_KEY`
 * has always had.
 */
export function keyPassphraseFromEnv(): string | undefined {
  const file = process.env.AFP_KEY_PASSPHRASE_FILE ?? "";
  return readSecretFile(file);
}

function entry(env: string): ConfigEntry {
  const found = CONFIG_SCHEMA.find((e) => e.env === env);
  if (!found) throw new Error(`no schema entry for ${env}`); // programmer error, not an operator one
  return found;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = resolve(overrides.dataDir ?? String(readEntry(entry("AFP_DATA_DIR"))));
  const brain = String(readEntry(entry("AFP_BRAIN")));
  if (brain !== "stub" && brain !== "llm") {
    throw new Error(`AFP_BRAIN must be "stub" or "llm", got ${brain}`);
  }

  const devMode = overrides.devMode ?? (readEntry(entry("AFP_DEV")) as boolean);
  const origin = overrides.origin ?? String(readEntry(entry("AFP_ORIGIN")));
  // ADR-0025 Decision 1: refused at load time, not discovered at the first
  // outbound fetch — an operator who forgot AFP_DEV finds out before the
  // instance ever answers a request.
  if (!devMode && !origin.startsWith("https:")) {
    throw new Error(
      `AFP_ORIGIN must be https: outside development mode, got "${origin}" — set AFP_DEV=1 to run over http:`,
    );
  }

  const llmBaseUrl = String(readEntry(entry("AFP_LLM_BASE_URL")));
  // ADR-0027 Decision 5: an unset allow-list is not "anything" — it is the one
  // endpoint this instance was configured with.
  const llmAllowedEndpoints = readEntry(entry("AFP_LLM_ALLOWED_ENDPOINTS")) as string[];

  const keyPassphraseFile = String(readEntry(entry("AFP_KEY_PASSPHRASE_FILE")));
  const webhookSecretFile = String(readEntry(entry("AFP_WEBHOOK_SECRET_FILE")));
  const signerClientCertFile = String(readEntry(entry("AFP_SIGNER_CLIENT_CERT_FILE")));

  const base: Config = {
    origin,
    operator: String(readEntry(entry("AFP_OPERATOR"))),
    instanceName: String(readEntry(entry("AFP_INSTANCE_NAME"))),
    dataDir,
    dbPath: resolve(dataDir, "afp.db"),
    keyDir: resolve(dataDir, "keys"),
    artifactDir: resolve(dataDir, "artifacts"),
    exportDir: resolve(overrides.exportDir ?? String(readEntry(entry("AFP_EXPORT_DIR")))),
    httpPort: readEntry(entry("AFP_PORT")) as number,
    brain,
    llmBaseUrl,
    llmModel: String(readEntry(entry("AFP_LLM_MODEL"))),
    llmMaxTokens: readEntry(entry("AFP_LLM_MAX_TOKENS")) as number,
    llmTimeoutMs: readEntry(entry("AFP_LLM_TIMEOUT_MS")) as number,
    llmAllowedEndpoints: llmAllowedEndpoints.length > 0 ? llmAllowedEndpoints : [llmBaseUrl],
    maxDeliveryAttempts: readEntry(entry("AFP_MAX_DELIVERY_ATTEMPTS")) as number,
    backoffBaseMs: readEntry(entry("AFP_BACKOFF_BASE_MS")) as number,
    seenIdTtlMs: readEntry(entry("AFP_SEEN_ID_TTL_MS")) as number,
    devMode,
    trustedNets: readEntry(entry("AFP_TRUSTED_NETS")) as string[],
    maxInboxBodyBytes: readEntry(entry("AFP_MAX_INBOX_BODY_BYTES")) as number,
    rateLimitPerAddress: readEntry(entry("AFP_RATE_LIMIT_PER_ADDRESS")) as number,
    rateLimitPerAddressWindowMs: readEntry(entry("AFP_RATE_LIMIT_PER_ADDRESS_WINDOW_MS")) as number,
    rateLimitPerActor: readEntry(entry("AFP_RATE_LIMIT_PER_ACTOR")) as number,
    rateLimitPerActorWindowMs: readEntry(entry("AFP_RATE_LIMIT_PER_ACTOR_WINDOW_MS")) as number,
    replayCacheTtlMs: readEntry(entry("AFP_REPLAY_CACHE_TTL_MS")) as number,
    ...(keyPassphraseFile ? { keyPassphraseFile } : {}),
    ...(webhookSecretFile ? { webhookSecretFile } : {}),
    ...(signerClientCertFile ? { signerClientCertFile } : {}),
    controllers: readEntry(entry("AFP_CONTROLLERS")) as string[],
    fediverseWindow: readEntry(entry("AFP_FEDIVERSE_WINDOW")) as boolean,
    scheduler: {
      sweepMs: readEntry(entry("AFP_SWEEP_MS")) as number,
      flushMs: readEntry(entry("AFP_FLUSH_MS")) as number,
      convergeMs: readEntry(entry("AFP_CONVERGE_MS")) as number,
      heartbeatMs: readEntry(entry("AFP_HEARTBEAT_MS")) as number,
      jitterMs: readEntry(entry("AFP_JITTER_MS")) as number,
    },
    backoffCeilingMs: readEntry(entry("AFP_BACKOFF_CEILING_MS")) as number,
  };

  return { ...base, ...overrides };
}

// ------------------------------------------------------------- validate()

export interface ConfigProblem {
  readonly field: string;
  readonly env: string;
  readonly message: string;
}

/** Options narrowing which checks `validate` runs — the store/signer/self-check probes live in `runtime/probes.ts`. */
export interface ValidateOptions {
  /** Skip the writability/ownership probe against `dataDir` — used by a test that only wants the pure checks. */
  skipDataDirProbe?: boolean;
}

function isAbsoluteUrl(value: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * ADR-0032 Decision 3: report every configuration problem at once, never
 * throwing on the first. `loadConfig` keeps its own `AFP_ORIGIN` throw for
 * backward compatibility (every existing call site expects it), but the same
 * problem is reported here too, alongside everything else, so `config check`
 * sees the whole picture even when `loadConfig` itself would have refused.
 */
export function validate(config: Config, options: ValidateOptions = {}): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const push = (field: string, env: string, message: string): void => {
    problems.push({ field, env, message });
  };

  if (!config.devMode && !config.origin.startsWith("https:")) {
    push("origin", "AFP_ORIGIN", `must be https: outside development mode, got "${config.origin}"`);
  }

  const intFields: Array<[keyof Config, string, string]> = [
    ["httpPort", "AFP_PORT", "httpPort"],
    ["llmMaxTokens", "AFP_LLM_MAX_TOKENS", "llmMaxTokens"],
    ["llmTimeoutMs", "AFP_LLM_TIMEOUT_MS", "llmTimeoutMs"],
    ["maxDeliveryAttempts", "AFP_MAX_DELIVERY_ATTEMPTS", "maxDeliveryAttempts"],
    ["backoffBaseMs", "AFP_BACKOFF_BASE_MS", "backoffBaseMs"],
    ["seenIdTtlMs", "AFP_SEEN_ID_TTL_MS", "seenIdTtlMs"],
    ["maxInboxBodyBytes", "AFP_MAX_INBOX_BODY_BYTES", "maxInboxBodyBytes"],
    ["rateLimitPerAddress", "AFP_RATE_LIMIT_PER_ADDRESS", "rateLimitPerAddress"],
    ["rateLimitPerAddressWindowMs", "AFP_RATE_LIMIT_PER_ADDRESS_WINDOW_MS", "rateLimitPerAddressWindowMs"],
    ["rateLimitPerActor", "AFP_RATE_LIMIT_PER_ACTOR", "rateLimitPerActor"],
    ["rateLimitPerActorWindowMs", "AFP_RATE_LIMIT_PER_ACTOR_WINDOW_MS", "rateLimitPerActorWindowMs"],
    ["replayCacheTtlMs", "AFP_REPLAY_CACHE_TTL_MS", "replayCacheTtlMs"],
    ["backoffCeilingMs", "AFP_BACKOFF_CEILING_MS", "backoffCeilingMs"],
  ];
  for (const [field, env, name] of intFields) {
    const value = config[field] as unknown as number;
    if (!Number.isFinite(value) || value < 0) {
      push(name, env, `must be a non-negative integer, got ${value}`);
    }
  }

  // Heartbeat 0 is allowed (= off); every other scheduler interval must be > 0.
  const schedulerFields: Array<[keyof Config["scheduler"], string]> = [
    ["sweepMs", "AFP_SWEEP_MS"],
    ["flushMs", "AFP_FLUSH_MS"],
    ["convergeMs", "AFP_CONVERGE_MS"],
  ];
  for (const [field, env] of schedulerFields) {
    if (!(config.scheduler[field] > 0)) {
      push(`scheduler.${field}`, env, `must be > 0, got ${config.scheduler[field]}`);
    }
  }
  if (config.scheduler.heartbeatMs < 0) {
    push("scheduler.heartbeatMs", "AFP_HEARTBEAT_MS", `must be >= 0 (0 = off), got ${config.scheduler.heartbeatMs}`);
  }
  if (config.scheduler.jitterMs < 0) {
    push("scheduler.jitterMs", "AFP_JITTER_MS", `must be >= 0, got ${config.scheduler.jitterMs}`);
  }

  for (const endpoint of config.llmAllowedEndpoints) {
    if (!isAbsoluteUrl(endpoint)) {
      push("llmAllowedEndpoints", "AFP_LLM_ALLOWED_ENDPOINTS", `"${endpoint}" is not an absolute URL`);
    }
  }

  for (const controller of config.controllers) {
    if (!/^https?:/.test(controller)) {
      push("controllers", "AFP_CONTROLLERS", `"${controller}" is not an http(s) URL`);
    }
  }

  for (const [field, env, path] of [
    ["keyPassphraseFile", "AFP_KEY_PASSPHRASE_FILE", config.keyPassphraseFile] as const,
    ["webhookSecretFile", "AFP_WEBHOOK_SECRET_FILE", config.webhookSecretFile] as const,
    ["signerClientCertFile", "AFP_SIGNER_CLIENT_CERT_FILE", config.signerClientCertFile] as const,
  ]) {
    if (path === undefined) continue;
    if (!existsSync(path)) {
      push(field, env, `is set to "${path}", which does not exist`);
      continue;
    }
    try {
      readFileSync(path, "utf8");
    } catch {
      push(field, env, `is set to "${path}", which is not readable`);
    }
  }

  if (!options.skipDataDirProbe) {
    const dirProblem = probeDataDirWritable(config.dataDir);
    if (dirProblem) push("dataDir", "AFP_DATA_DIR", dirProblem);
  }

  return problems;
}

/**
 * ADR-0032 Decision 2: "writable and owned by the process user". Probed with
 * a temp file rather than `accessSync`, which cannot tell writable-by-us from
 * writable-by-anyone on every platform this runs on; ownership is checked
 * where `process.getuid` exists (POSIX) and skipped (never flagged) where it
 * does not.
 */
function probeDataDirWritable(dataDir: string): string | undefined {
  try {
    // `openDb` creates `dataDir` itself on first use — this probe would
    // otherwise flag every never-yet-started instance as misconfigured, so
    // it creates the directory too, exactly as `openDb` does.
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const stat = statSync(dataDir);
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      return `is not owned by this process's user (uid ${process.getuid()}), owned by uid ${stat.uid}`;
    }
    const probe = join(dataDir, `.afp-writable-probe-${process.pid}`);
    writeFileSync(probe, "");
    unlinkSync(probe);
    return undefined;
  } catch (error) {
    return `is not writable: ${(error as Error).message}`;
  }
}
