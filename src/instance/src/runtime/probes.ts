/**
 * ADR-0032 Decision 3: the store, signer, and self-check probes, factored out
 * of `runtime/health.ts` so `/readyz` and `afp config check` call the same
 * functions rather than two copies that could drift.
 */

import { publicKeyFromMultibase, verify } from "../crypto/keys.ts";
import type { AfpInstance } from "../instance.ts";
import type { JsonValue } from "../crypto/jcs.ts";

export type ProbeResult = { ok: true } | { ok: false; reason: string };

/** The store answers a trivial query. */
export function probeStore(instance: AfpInstance): ProbeResult {
  try {
    instance.db.get("SELECT 1");
    return { ok: true };
  } catch {
    return { ok: false, reason: "store-unavailable" };
  }
}

export function defaultSignerProbe(instance: AfpInstance): void {
  const signer = instance.signer("@instance");
  const message = new TextEncoder().encode("afp:readyz-signer-probe");
  const signature = signer.sign(message);
  const publicKey = publicKeyFromMultibase(signer.publicKeyMultibase);
  if (!verify(publicKey, message, signature)) {
    throw new Error("signer produced a signature that does not verify");
  }
}

/** The signer answers (sign-then-verify a fixed byte string). */
export function probeSigner(instance: AfpInstance, signerProbe?: () => void): ProbeResult {
  try {
    (signerProbe ?? (() => defaultSignerProbe(instance)))();
    return { ok: true };
  } catch {
    return { ok: false, reason: "signer-unavailable" };
  }
}

/**
 * ADR-0032 Decision 2's self-check: fetch this instance's own `/actor`
 * through the same fetch policy `serve` uses, and require its `id` to equal
 * the instance's own actor id.
 */
export async function probeSelfCheck(
  instance: AfpInstance,
  fetchActor?: (url: string) => Promise<{ [key: string]: JsonValue } | null>,
): Promise<ProbeResult> {
  if (!fetchActor) return { ok: false, reason: "self-check-skipped" };
  try {
    const selfId = instance.instanceDocument().id as string;
    const doc = await fetchActor(`${instance.config.origin}/actor`);
    if (!doc || doc.id !== selfId) {
      return { ok: false, reason: "self-check-mismatch" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "self-check-failed" };
  }
}
