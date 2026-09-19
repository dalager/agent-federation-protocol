/**
 * ADR-0032 Decision 3: `afp config check` — validate configuration and probe
 * the store/signer/self-check without starting the server. Exported as
 * `runConfigCheck` so `cli.ts`'s `config check` case stays thin and the test
 * suite can call it directly.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { validate, type ConfigProblem } from "../config.ts";
import { openDb, StoreLocked } from "../store/db.ts";
import { AfpInstance } from "../instance.ts";
import { probeSelfCheck } from "./probes.ts";
import { agentsCheck } from "../agents.ts";
import type { JsonValue } from "../crypto/jcs.ts";

export interface ConfigCheckLine {
  readonly name: string;
  readonly ok: boolean;
  readonly reason?: string;
}

export interface ConfigCheckResult {
  readonly problems: readonly ConfigProblem[];
  readonly lines: readonly ConfigCheckLine[];
  /** `true` only when there are no validation problems and every line is `ok`. */
  readonly allOk: boolean;
}

export interface RunConfigCheckOptions {
  /** ADR-0032 Decision 3: skip the self-check fetch entirely, named in its own line. */
  offline?: boolean;
  /** Test-only override of the self-check fetch. Defaults to a real `fetchActorDocument` call. */
  fetchActor?: (url: string) => Promise<{ [key: string]: JsonValue } | null>;
}

/** `${keyDir}/instance.pem` — the ordinal-1 convention `crypto/keys.ts` mints the instance key under. */
function instanceKeyExists(config: Config): boolean {
  return existsSync(join(config.keyDir, "instance.pem"));
}

export async function runConfigCheck(config: Config, options: RunConfigCheckOptions = {}): Promise<ConfigCheckResult> {
  const problems = validate(config);
  const lines: ConfigCheckLine[] = [];

  // ADR-0035 Decision 2, item 3 of its review: two lifetimes exist —
  // AFP_ISSUED_KEY_LIFETIME_MS, which actually drives `keys rotate --root
  // remote`, and the policy's published `custody.keyLifetimeMs`, which is
  // the obligation a counterparty reads. Nothing else holds them to
  // agreeing, so a changed env var with a stale policy file would publish a
  // lifetime the instance does not honour — reported here, by name, rather
  // than silently.
  const custody = config.policy.custody;
  const declaresRemoteIssued = custody?.instance === "remote-issued" ||
    custody?.agents === "remote-issued" ||
    custody?.hub === "remote-issued";
  if (declaresRemoteIssued) {
    const agree = custody?.keyLifetimeMs === config.issuedKeyLifetimeMs;
    lines.push(
      agree
        ? { name: "custody", ok: true }
        : {
            name: "custody",
            ok: false,
            reason: `custody-lifetime-mismatch: policy declares custody.keyLifetimeMs=${custody?.keyLifetimeMs}, ` +
              `but AFP_ISSUED_KEY_LIFETIME_MS=${config.issuedKeyLifetimeMs} is what rotation actually uses`,
          },
    );
  }

  // ADR-0038 Decision 1: the agent collection `serve` would boot — every
  // problem with AFP_AGENTS_FILE named at once, or which collection applies.
  const agents = agentsCheck(config);
  lines.push({ name: "agents", ok: agents.ok, reason: agents.reason });

  // ADR-0037 Decision 2: the hubs `serve` would build. `validatePolicySpec`
  // has already named any malformed entry among the `problems` above; this
  // line says what the operator gets — which is the fact worth reading back,
  // since "hosts no hub" is a perfectly good answer that looks identical to
  // a misspelled AFP_HUBS until someone says it out loud.
  const hosted = config.policy.hubs ?? [];
  lines.push({
    name: "hubs",
    ok: true,
    reason: hosted.length === 0
      ? "hosts no hub"
      : hosted
          .map((hub) => `${config.origin}/hubs/${hub.id}` + (hub.replicaOf ? ` (replica of ${hub.replicaOf})` : ""))
          .join(", "),
  });

  // Store: opens (and immediately closes) the store path — a running
  // instance holding the lock is reported as `store-locked` with its pid,
  // not as a failure, since the whole point is to check config *while*
  // `serve` is up.
  let storeLockedByPid: number | undefined;
  try {
    const db = openDb(config.dbPath);
    db.close();
    lines.push({ name: "store", ok: true });
  } catch (error) {
    if (error instanceof StoreLocked) {
      storeLockedByPid = /pid (\d+)/.exec(error.message)?.[1] ? Number(/pid (\d+)/.exec(error.message)![1]) : undefined;
      lines.push({ name: "store", ok: true, reason: `store-locked (pid ${storeLockedByPid ?? "?"})` });
    } else {
      lines.push({ name: "store", ok: false, reason: `store-unavailable: ${(error as Error).message}` });
    }
  }

  // Signer and self-check both need an open `AfpInstance` — opened at most
  // once here and shared, both so a live instance's lock is hit only once
  // and so the (never-minting) signer probe and the self-check agree on the
  // same process. `config check` must never mint a key: when the instance
  // key file does not exist yet, or the store is already held by a live
  // process, both probes are skipped with a named line rather than either
  // minting a key or colliding with that lock.
  let instance: AfpInstance | undefined;
  const canOpenInstance = storeLockedByPid === undefined;

  if (!instanceKeyExists(config)) {
    lines.push({ name: "signer", ok: true, reason: "skipped — no instance key minted yet" });
  } else if (!canOpenInstance) {
    lines.push({ name: "signer", ok: true, reason: `skipped — store held by pid ${storeLockedByPid}` });
  } else {
    try {
      instance = new AfpInstance(config, []);
      const signer = instance.signer("@instance");
      const message = new TextEncoder().encode("afp:config-check-signer-probe");
      const signature = signer.sign(message);
      const { publicKeyFromMultibase, verify } = await import("../crypto/keys.ts");
      const ok = verify(publicKeyFromMultibase(signer.publicKeyMultibase), message, signature);
      lines.push(ok ? { name: "signer", ok: true } : { name: "signer", ok: false, reason: "signer-unavailable" });
    } catch (error) {
      lines.push({ name: "signer", ok: false, reason: `signer-unavailable: ${(error as Error).message}` });
    }
  }

  // Self-check: ADR-0032 Decision 2 — fetch this instance's own /actor and
  // require its id to equal the origin it published. Skipped with a named
  // line under --offline, or when the store is locked (the same reason the
  // signer probe above skips).
  if (options.offline) {
    lines.push({ name: "self-check", ok: true, reason: "skipped — --offline" });
  } else if (!canOpenInstance) {
    lines.push({ name: "self-check", ok: true, reason: `skipped — store held by pid ${storeLockedByPid}` });
  } else {
    try {
      instance ??= new AfpInstance(config, []);
      const result = await probeSelfCheck(instance, options.fetchActor);
      lines.push(result.ok ? { name: "self-check", ok: true } : { name: "self-check", ok: false, reason: result.reason });
    } catch (error) {
      lines.push({ name: "self-check", ok: false, reason: `self-check-failed: ${(error as Error).message}` });
    }
  }

  instance?.close();

  const allOk = problems.length === 0 && lines.every((line) => line.ok);
  return { problems, lines, allOk };
}
