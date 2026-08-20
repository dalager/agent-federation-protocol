/**
 * HTTP Signatures for the hop (ADR-0008 Decision 2) — draft-cavage shape,
 * Ed25519 keys, fediverse practice.
 *
 * Transport authentication only: it proves who delivered these bytes on this
 * hop, and nothing more. Payload integrity is the `eddsa-jcs-2022` object
 * proof the activity already carries — which is also why none of this needs a
 * Python mirror: the hop signature is ephemeral and never enters the record,
 * so the verifier never sees it. That asymmetry is correct, not an omission.
 *
 * Signed headers: `(request-target) host date digest` — the digest header
 * binds the body, the date bounds replay, and the target stops cross-endpoint
 * splicing. Clock skew tolerance is generous (5 minutes) because P4 accepts
 * skew by design (Decision 4).
 */

import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

const SKEW_MS = 5 * 60 * 1000;

export interface SignedRequestHeaders {
  host: string;
  date: string;
  digest: string;
  signature: string;
}

export function signRequest(
  method: string,
  path: string,
  host: string,
  body: string,
  keyId: string,
  privateKey: KeyObject,
  now: Date,
): SignedRequestHeaders {
  const date = now.toUTCString();
  const digest = `SHA-256=${createHash("sha256").update(body).digest("base64")}`;
  const signingString = [
    `(request-target): ${method.toLowerCase()} ${path}`,
    `host: ${host}`,
    `date: ${date}`,
    `digest: ${digest}`,
  ].join("\n");
  const signature = sign(null, Buffer.from(signingString), privateKey).toString("base64");
  return {
    host,
    date,
    digest,
    signature:
      `keyId="${keyId}",algorithm="hs2019",headers="(request-target) host date digest",` +
      `signature="${signature}"`,
  };
}

export interface VerifyResult {
  ok: boolean;
  keyId: string | null;
  reason: string;
}

export function verifyRequest(
  method: string,
  path: string,
  headers: { host?: string; date?: string; digest?: string; signature?: string },
  body: string,
  resolveKey: (keyId: string) => KeyObject | null,
  now: Date,
): VerifyResult {
  const header = headers.signature;
  if (!header) return { ok: false, keyId: null, reason: "no Signature header" };

  const fields = new Map<string, string>();
  for (const match of header.matchAll(/(\w+)="([^"]*)"/g)) fields.set(match[1], match[2]);
  const keyId = fields.get("keyId") ?? null;
  const signature = fields.get("signature");
  if (!keyId || !signature) return { ok: false, keyId, reason: "Signature header missing keyId or signature" };

  if (!headers.date || Math.abs(now.getTime() - new Date(headers.date).getTime()) > SKEW_MS) {
    return { ok: false, keyId, reason: "date header absent or outside the skew window" };
  }
  const expectedDigest = `SHA-256=${createHash("sha256").update(body).digest("base64")}`;
  if (headers.digest !== expectedDigest) {
    return { ok: false, keyId, reason: "digest header does not match the body" };
  }

  const publicKey = resolveKey(keyId);
  if (!publicKey) return { ok: false, keyId, reason: `no key resolvable for ${keyId}` };

  const signingString = [
    `(request-target): ${method.toLowerCase()} ${path}`,
    `host: ${headers.host ?? ""}`,
    `date: ${headers.date}`,
    `digest: ${headers.digest}`,
  ].join("\n");
  const ok = verify(null, Buffer.from(signingString), publicKey, Buffer.from(signature, "base64"));
  return ok ? { ok: true, keyId, reason: "" } : { ok: false, keyId, reason: "signature does not verify" };
}

export { createPrivateKey, createPublicKey };
