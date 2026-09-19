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
import { readSecret } from "./runtime/secrets.ts";
import { validatePolicySpec, type PolicySpec } from "./policySpec.ts";
import { derivedBrains, readAgentsFile } from "./agentsSpec.ts";

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
  /**
   * ADR-0036 Decision 10: which deployment profile this instance runs. A
   * hosting platform is a dependency of a different kind from a library, and
   * the record says which one an instance took — published in NodeInfo so a
   * counterparty can read it without asking.
   */
  readonly profile: "self-hosted" | "hosted";
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
   * ADR-0037 Decision 1: hub ids this instance hosts, from `AFP_HUBS`. A
   * convenience on the same terms as `controllers`: it populates
   * `afp:hostedHubs` on the policy document only when the policy file names no
   * hubs, because which hubs an instance hosts is a fact counterparties
   * federate against and the policy file is its source of record. Empty by
   * default — an instance hosts no hub until an operator says so.
   */
  readonly hubs: readonly string[];

  /**
   * ADR-0032 Decision 3: the ADR-0028 webhook initiator's shared secret, as a
   * file path — never a value in the environment. Absent means the webhook
   * route's secret is configured some other way (a demo's own literal, today).
   */
  readonly webhookSecretFile?: string;

  /**
   * ADR-0035 Decision 3: the remote signer's mTLS client identity and the CA
   * its own server certificate must chain to. `signerUrl` and
   * `signerRootKeyId` name the root key `afp keys rotate --root remote`
   * asks to sign a delegation; absent means `remote-issued` custody is not
   * configured, and that rotation path refuses rather than guessing.
   */
  readonly signerClientCertFile?: string;
  readonly signerClientKeyFile?: string;
  readonly signerCaFile?: string;
  readonly signerUrl?: string;
  readonly signerRootKeyId?: string;
  readonly issuedKeyLifetimeMs: number;

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

  // ---------------------------------------------------------- ADR-0033

  /**
   * ADR-0033 Decision 1: the operator's stated obligations, merged from
   * `AFP_POLICY_FILE` (when set) over the instance-derived defaults
   * `loadConfig` assembles below. `AfpInstance.policy` is this same value;
   * `AfpInstance.policyDocument()` is its signed form.
   */
  readonly policy: PolicySpec;

  // ---------------------------------------------------------- ADR-0038

  /** ADR-0038 Decision 1: the agent collection file (`src/agents.ts`); absent means the demo's writer/reviewer. */
  readonly agentsFile?: string;
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
 * ADR-0032 Decision 3: read a secret, trimmed, refusing an empty one.
 * Shared by every `*_FILE` secret — `keyPassphraseFromEnv` predates this
 * helper (ADR-0026) and keeps its own shape for compatibility, but is one
 * line different from what this would do.
 *
 * ADR-0036 Decision 6: the *reading* is the profile's now (`runtime/secrets.ts`),
 * so this name is kept for its twenty-odd callers while the mechanism moved.
 * A hosted deployment resolves the same reference against a binding.
 */
export function readSecretFile(path: string): string | undefined {
  return readSecret(path);
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

  // ADR-0036 Decision 10: which profile this instance runs, refused at load
  // time like every other enum the schema cannot express.
  const profile = String(readEntry(entry("AFP_PROFILE")));
  if (profile !== "self-hosted" && profile !== "hosted") {
    throw new Error(`AFP_PROFILE must be "self-hosted" or "hosted", got ${profile}`);
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
  const signerClientKeyFile = String(readEntry(entry("AFP_SIGNER_CLIENT_KEY_FILE")));
  const signerCaFile = String(readEntry(entry("AFP_SIGNER_CA_FILE")));
  const signerUrl = String(readEntry(entry("AFP_SIGNER_URL")));
  const signerRootKeyId = String(readEntry(entry("AFP_SIGNER_ROOT_KEY_ID")));
  const policyFile = String(readEntry(entry("AFP_POLICY_FILE")));
  const agentsFile = String(readEntry(entry("AFP_AGENTS_FILE")));
  const controllersFromEnv = readEntry(entry("AFP_CONTROLLERS")) as string[];
  const hubsFromEnv = readEntry(entry("AFP_HUBS")) as string[];

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
    profile,
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
    ...(signerClientKeyFile ? { signerClientKeyFile } : {}),
    ...(signerCaFile ? { signerCaFile } : {}),
    ...(signerUrl ? { signerUrl } : {}),
    ...(signerRootKeyId ? { signerRootKeyId } : {}),
    ...(agentsFile ? { agentsFile } : {}),
    issuedKeyLifetimeMs: readEntry(entry("AFP_ISSUED_KEY_LIFETIME_MS")) as number,
    controllers: controllersFromEnv,
    hubs: hubsFromEnv,
    fediverseWindow: readEntry(entry("AFP_FEDIVERSE_WINDOW")) as boolean,
    scheduler: {
      sweepMs: readEntry(entry("AFP_SWEEP_MS")) as number,
      flushMs: readEntry(entry("AFP_FLUSH_MS")) as number,
      convergeMs: readEntry(entry("AFP_CONVERGE_MS")) as number,
      heartbeatMs: readEntry(entry("AFP_HEARTBEAT_MS")) as number,
      jitterMs: readEntry(entry("AFP_JITTER_MS")) as number,
    },
    backoffCeilingMs: readEntry(entry("AFP_BACKOFF_CEILING_MS")) as number,
    // Placeholder — recomputed below from the *merged* config, so an
    // `overrides.controllers`/`overrides.brain` (every test's own way of
    // setting these, `loadConfig({ ...paths, controllers })`) feeds the
    // policy default exactly as the corresponding environment variable
    // would. `overrides.policy` bypasses this entirely, unchanged.
    policy: {},
  };

  const merged: Config = { ...base, ...overrides };
  if (overrides.policy !== undefined) return merged;
  return {
    ...merged,
    policy: assemblePolicy(policyFile, {
      brain: merged.brain,
      llmModel: merged.llmModel,
      llmBaseUrl: merged.llmBaseUrl,
      controllers: merged.controllers,
      hubs: merged.hubs,
      agentsFile: merged.agentsFile,
    }),
  };
}

/**
 * ADR-0033 Decision 1: the operator's `AFP_POLICY_FILE` (a JSON file in the
 * `PolicySpec` shape) merged over instance-derived defaults. A property the
 * file states wins; a property it omits falls back to the default named
 * here. `AFP_CONTROLLERS` populates `afp:controllers` only when the file
 * names none — the policy file is the source of record, the env var the
 * convenience that predates it (ADR-0028 Decision 4).
 */
function assemblePolicy(
  policyFile: string,
  derived: { brain: "stub" | "llm"; llmModel: string; llmBaseUrl: string; controllers: readonly string[]; hubs?: readonly string[]; agentsFile?: string },
): PolicySpec {
  const fromFile = readPolicyFile(policyFile);
  // ADR-0038: with an agents file the brains are per agent, so the published
  // list is the union the collection actually runs (`derivedBrains`). A file
  // with problems falls back to the AFP_BRAIN default here — `config check`'s
  // `agents` line is where those problems are reported, not a throw from
  // `loadConfig`. Found by walkthrough: an export from a stub collection under
  // the default AFP_BRAIN=llm failed its own verifier's check_policy.
  const collectionBrains = derived.agentsFile
    ? (({ entries, problems }) => (problems.length > 0 ? null : derivedBrains(entries, { model: derived.llmModel, endpoint: derived.llmBaseUrl })))(readAgentsFile(derived.agentsFile))
    : null;
  const defaults: PolicySpec = {
    // ADR-0032 Decision 6's flipped default.
    seatPolicy: "follow-required",
    controllers: [...derived.controllers],
    // ADR-0037 Decision 1: `AFP_HUBS` is ids only — `peers` and `replicaOf`
    // are policy-file-only, because a replica set is not a thing to spell in
    // an env var. No env var and no file property means the property is
    // absent, which means what it means today: this instance hosts no hub.
    ...((derived.hubs ?? []).length > 0 ? { hubs: (derived.hubs ?? []).map((id) => ({ id })) } : {}),
    // What the old ad-hoc `/afp/policy` body said (ap/server.ts, pre-ADR-0033).
    defaultVisibility: "internal",
    custody: { instance: "file" },
    // Must match what Results actually carry: the stub brain writes
    // `afp:producedBy: "stub"`; the llm brain writes `producedByLine(model,
    // endpoint)` = "<model> @ <endpoint> ; template sha256:…" — the verifier
    // matches a Result's producedBy against `afp:model` alone or against the
    // "<model> @ <endpoint>" prefix, so both forms are represented here.
    brains: collectionBrains ?? (derived.brain === "stub" ? [{ model: "stub" }] : [{ model: derived.llmModel, endpoint: derived.llmBaseUrl }]),
    // Today's behaviour for Q2 (ADR-0021 open question 2): any member may
    // pin a governanceSubject. Q3's floor names a close rather than leaving
    // an exhausted electorate to throw uncaught — `no-decision:electorate-exhausted`
    // is the operator-neutral default; `refuse` is available for a policy that
    // would rather never open such a round.
    governance: { subjectPrecondition: "any-member", electorateFloor: "no-decision:electorate-exhausted" },
  };
  if (!fromFile) return defaults;
  return {
    ...defaults,
    ...fromFile,
    controllers: fromFile.controllers && fromFile.controllers.length > 0 ? fromFile.controllers : defaults.controllers,
    hubs: fromFile.hubs && fromFile.hubs.length > 0 ? fromFile.hubs : defaults.hubs,
    custody: fromFile.custody ? { ...defaults.custody, ...fromFile.custody } : defaults.custody,
    brains: fromFile.brains ?? defaults.brains,
    governance: fromFile.governance ?? defaults.governance,
  };
}

/** Read and parse `AFP_POLICY_FILE`, or `undefined` if unset/empty/absent. */
function readPolicyFile(path: string): PolicySpec | undefined {
  if (!path || !existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8").trim();
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw) as PolicySpec;
  } catch (error) {
    // A named error, not a bare JSON.parse message: the operator wrote this
    // file by hand, and "Unexpected token" says nothing about which file.
    throw new Error(`AFP_POLICY_FILE ${path} is not valid JSON: ${(error as Error).message}`);
  }
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
    ["issuedKeyLifetimeMs", "AFP_ISSUED_KEY_LIFETIME_MS", "issuedKeyLifetimeMs"],
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

  // ADR-0037 Decision 1: the env convenience gets the same check the policy
  // property gets in `validatePolicySpec` — the two spellings, one answer.
  for (const hub of config.hubs) {
    if (!/^[\w-]+$/.test(hub)) {
      push("hubs", "AFP_HUBS", `"${hub}" is not a [A-Za-z0-9_-] path segment`);
    }
  }

  for (const [field, env, path] of [
    ["keyPassphraseFile", "AFP_KEY_PASSPHRASE_FILE", config.keyPassphraseFile] as const,
    ["webhookSecretFile", "AFP_WEBHOOK_SECRET_FILE", config.webhookSecretFile] as const,
    ["signerClientCertFile", "AFP_SIGNER_CLIENT_CERT_FILE", config.signerClientCertFile] as const,
    ["signerClientKeyFile", "AFP_SIGNER_CLIENT_KEY_FILE", config.signerClientKeyFile] as const,
    ["signerCaFile", "AFP_SIGNER_CA_FILE", config.signerCaFile] as const,
    ["agentsFile", "AFP_AGENTS_FILE", config.agentsFile] as const,
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

  for (const problem of validatePolicySpec(config.policy)) {
    // `problem` reads "<field> <message>" (e.g. `governance.electorateFloor must be…`) —
    // split once so the field lands in ConfigProblem.field the way every other row does.
    const spaceAt = problem.indexOf(" ");
    const field = spaceAt === -1 ? problem : problem.slice(0, spaceAt);
    const message = spaceAt === -1 ? problem : problem.slice(spaceAt + 1);
    push(`policy.${field}`, "AFP_POLICY_FILE", message);
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
