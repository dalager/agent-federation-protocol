/**
 * ADR-0032 Decision 3: configuration as a validated schema.
 *
 * A declarative table of every environment-backed setting, kept separate
 * from `config.ts` so that file stays under the line budget as the schema
 * grows. `config.ts`'s `loadConfig` reads through `readEntry` for every
 * scalar entry here (the handful of derived fields — paths under `dataDir`,
 * the nested `scheduler` object, `llmAllowedEndpoints`'s fallback to
 * `llmBaseUrl` — stay hand-written in `loadConfig`, since they are not one
 * environment variable each); `validate()` in `config.ts` walks this same
 * table plus those derived fields to report every problem at once.
 *
 * Every secret entry (`secret: true`) is a *path*, never a value — an
 * operator's `ps` output or a crash dump's environment block leaks nothing.
 */

export type EntryKind = "string" | "int" | "bool" | "list" | "path" | "file";

export interface ConfigEntry {
  /** The environment variable name. */
  readonly env: string;
  /** The field this becomes on `Config` (dotted for nested — informational only here). */
  readonly key: string;
  readonly kind: EntryKind;
  readonly default: string | number | boolean | readonly string[];
  /** A path to a secret file, never a value — never logged, never in `Config` as anything but a path. */
  readonly secret?: boolean;
  readonly doc: string;
}

export const CONFIG_SCHEMA: readonly ConfigEntry[] = [
  { env: "AFP_ORIGIN", key: "origin", kind: "string", default: "https://alpha.operator.local", doc: "The origin the instance publishes itself under" },
  { env: "AFP_OPERATOR", key: "operator", kind: "string", default: "Alpha Operator", doc: "Operator display name" },
  { env: "AFP_INSTANCE_NAME", key: "instanceName", kind: "string", default: "Alpha Operator Instance", doc: "Instance display name" },
  { env: "AFP_DATA_DIR", key: "dataDir", kind: "path", default: "./data", doc: "SQLite file, keys, artifacts" },
  { env: "AFP_EXPORT_DIR", key: "exportDir", kind: "path", default: "./export", doc: "Where the bundle is written" },
  { env: "AFP_PORT", key: "httpPort", kind: "int", default: 8787, doc: "npm run serve" },
  { env: "AFP_BRAIN", key: "brain", kind: "string", default: "llm", doc: "llm or stub" },
  { env: "AFP_LLM_BASE_URL", key: "llmBaseUrl", kind: "string", default: "http://localhost:13305/api/v1", doc: "Any OpenAI-compatible endpoint" },
  { env: "AFP_LLM_MODEL", key: "llmModel", kind: "string", default: "Qwen3.6-35B-A3B-NoThinking", doc: "" },
  { env: "AFP_LLM_MAX_TOKENS", key: "llmMaxTokens", kind: "int", default: 900, doc: "" },
  { env: "AFP_LLM_TIMEOUT_MS", key: "llmTimeoutMs", kind: "int", default: 120000, doc: "" },
  { env: "AFP_LLM_ALLOWED_ENDPOINTS", key: "llmAllowedEndpoints", kind: "list", default: [], doc: "Endpoint origins the llm brain may talk to; defaults to AFP_LLM_BASE_URL alone (ADR-0027 Decision 5)" },
  { env: "AFP_MAX_DELIVERY_ATTEMPTS", key: "maxDeliveryAttempts", kind: "int", default: 5, doc: "Before dead-lettering" },
  { env: "AFP_BACKOFF_BASE_MS", key: "backoffBaseMs", kind: "int", default: 50, doc: "" },
  { env: "AFP_SEEN_ID_TTL_MS", key: "seenIdTtlMs", kind: "int", default: 24 * 60 * 60 * 1000, doc: "" },
  { env: "AFP_DEV", key: "devMode", kind: "bool", default: false, doc: "1 permits an http: origin, loopback/private fetch targets, and literal-IP hosts (ADR-0025). Every demo sets it; serve does not" },
  { env: "AFP_TRUSTED_NETS", key: "trustedNets", kind: "list", default: [], doc: "Comma-separated CIDRs the address policy admits outside dev mode" },
  { env: "AFP_MAX_INBOX_BODY_BYTES", key: "maxInboxBodyBytes", kind: "int", default: 1024 * 1024, doc: "Inbox POST body cap, enforced before parsing (413 on overflow)" },
  { env: "AFP_RATE_LIMIT_PER_ADDRESS", key: "rateLimitPerAddress", kind: "int", default: 20, doc: "" },
  { env: "AFP_RATE_LIMIT_PER_ADDRESS_WINDOW_MS", key: "rateLimitPerAddressWindowMs", kind: "int", default: 1000, doc: "" },
  { env: "AFP_RATE_LIMIT_PER_ACTOR", key: "rateLimitPerActor", kind: "int", default: 60, doc: "" },
  { env: "AFP_RATE_LIMIT_PER_ACTOR_WINDOW_MS", key: "rateLimitPerActorWindowMs", kind: "int", default: 60 * 1000, doc: "" },
  { env: "AFP_REPLAY_CACHE_TTL_MS", key: "replayCacheTtlMs", kind: "int", default: 5 * 60 * 1000, doc: "" },
  { env: "AFP_KEY_PASSPHRASE_FILE", key: "keyPassphraseFile", kind: "file", default: "", secret: true, doc: "File holding the passphrase the file signer adapter encrypts PEMs with at rest (ADR-0026)" },
  { env: "AFP_CONTROLLERS", key: "controllers", kind: "list", default: [], doc: "Comma-separated actor URLs authorized to approve (ADR-0028 Decision 4)" },
  { env: "AFP_FEDIVERSE_WINDOW", key: "fediverseWindow", kind: "bool", default: false, doc: "1 dual-publishes a public shadow Note (ADR-0029 Decision 3)" },
  { env: "AFP_SWEEP_MS", key: "scheduler.sweepMs", kind: "int", default: 30_000, doc: "The resident scheduler's sweep-loop interval (ADR-0031 Decision 1)" },
  { env: "AFP_FLUSH_MS", key: "scheduler.flushMs", kind: "int", default: 10_000, doc: "The resident scheduler's flush-loop interval" },
  { env: "AFP_CONVERGE_MS", key: "scheduler.convergeMs", kind: "int", default: 60_000, doc: "The resident scheduler's hub-convergence interval" },
  { env: "AFP_HEARTBEAT_MS", key: "scheduler.heartbeatMs", kind: "int", default: 0, doc: "> 0 enables the optional afp:BoundaryDigest heartbeat; 0 is off, and allowed" },
  { env: "AFP_JITTER_MS", key: "scheduler.jitterMs", kind: "int", default: 0, doc: "Uniform random spread added to every scheduler interval" },
  { env: "AFP_BACKOFF_CEILING_MS", key: "backoffCeilingMs", kind: "int", default: 5 * 60 * 1000, doc: "The exponential delivery-backoff schedule's cap" },
  { env: "AFP_LOG_LEVEL", key: "logLevel", kind: "string", default: "info", doc: "debug/info/warn/error, or silent to mute the JSON-lines stream" },
  {
    env: "AFP_WEBHOOK_SECRET_FILE",
    key: "webhookSecretFile",
    kind: "file",
    default: "",
    secret: true,
    doc: "File holding the ADR-0028 webhook initiator's shared secret. Never a value in the environment",
  },
  {
    env: "AFP_SIGNER_CLIENT_CERT_FILE",
    key: "signerClientCertFile",
    kind: "file",
    default: "",
    secret: true,
    doc:
      "File holding the ADR-0035 remote signer's client certificate. Validated as readable only — " +
      "nothing in this codebase consumes it yet",
  },
];

/** Read one raw environment string, falling back to `fallback` on unset/empty. */
function readEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

/** Split a comma-separated env value into trimmed, non-empty entries. */
function readList(name: string, fallback: readonly string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return [...fallback];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Read one entry's typed value straight off the environment (no `dataDir`-relative
 * resolution — that stays in `config.ts`, which knows which entries are paths
 * relative to `dataDir` versus the working directory).
 */
export function readEntry(entry: ConfigEntry): string | number | boolean | string[] {
  switch (entry.kind) {
    case "string":
    case "path":
    case "file":
      return readEnv(entry.env, String(entry.default));
    case "bool":
      return readEnv(entry.env, entry.default ? "1" : "0") === "1";
    case "int": {
      const raw = process.env[entry.env];
      if (raw === undefined || raw === "") return entry.default as number;
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed)) throw new Error(`${entry.env} must be an integer, got ${raw}`);
      return parsed;
    }
    case "list":
      return readList(entry.env, entry.default as readonly string[]);
  }
}
