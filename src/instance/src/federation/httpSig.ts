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
 * Signed headers: `(request-target) host date` for a request with no body, and
 * the same plus `digest` for one that carries a body — the digest header binds
 * the body, the date bounds replay, and the target stops cross-endpoint
 * splicing. Clock skew tolerance is generous (5 minutes) because P4 accepts
 * skew by design (Decision 4).
 *
 * **The covered set is derived from the request method and never read from the
 * signature** (ADR-0013 Decision 1). A `Signature` header declares which
 * headers it covered; honouring that declaration would let an attacker strip
 * the body binding off a POST by claiming it covered no `digest`, leaving the
 * body unauthenticated while the signature still verified. So the method
 * decides, the declaration is checked against it, and a disagreement is
 * refused by name rather than accommodated. One builder serves both shapes,
 * because two hand-maintained signing strings are how that bug gets
 * reintroduced later.
 */

import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

const SKEW_MS = 5 * 60 * 1000;

export interface SignedRequestHeaders {
  host: string;
  date: string;
  /** Present only for methods whose covered set includes it — see `coveredHeaders`. */
  digest?: string;
  signature: string;
}

/** Methods that carry a body, and therefore bind it into the signature. */
const BODY_METHODS = new Set(["post", "put", "patch"]);

/**
 * The headers a signature MUST cover, decided by the method alone.
 *
 * This function is the security boundary of the module: every other path —
 * signing, verifying, and the declared-set check — reads the covered set from
 * here, so there is exactly one place where "what does this request bind" is
 * answered, and no caller can widen or narrow it.
 */
export function coveredHeaders(method: string): string[] {
  const base = ["(request-target)", "host", "date"];
  return BODY_METHODS.has(method.toLowerCase()) ? [...base, "digest"] : base;
}

function signingString(
  covered: readonly string[],
  method: string,
  path: string,
  values: { host: string; date: string; digest?: string },
): string {
  return covered
    .map((name) => {
      if (name === "(request-target)") return `(request-target): ${method.toLowerCase()} ${path}`;
      if (name === "host") return `host: ${values.host}`;
      if (name === "date") return `date: ${values.date}`;
      return `digest: ${values.digest ?? ""}`;
    })
    .join("\n");
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
  const covered = coveredHeaders(method);
  const date = now.toUTCString();
  const digest = covered.includes("digest")
    ? `SHA-256=${createHash("sha256").update(body).digest("base64")}`
    : undefined;
  const signature = sign(
    null,
    Buffer.from(signingString(covered, method, path, { host, date, digest })),
    privateKey,
  ).toString("base64");
  return {
    host,
    date,
    ...(digest !== undefined ? { digest } : {}),
    signature:
      `keyId="${keyId}",algorithm="hs2019",headers="${covered.join(" ")}",` +
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

  // The method decides what this request had to bind. A signature that claims
  // to have covered something else is refused here rather than verified
  // against its own weaker string — that refusal is what stops a POST being
  // downgraded to an unbound body by a `headers="(request-target) host date"`
  // claim (ADR-0013 Decision 1).
  const covered = coveredHeaders(method);
  const declared = fields.get("headers");
  if (declared !== undefined && declared !== covered.join(" ")) {
    return {
      ok: false,
      keyId,
      reason: `signature declares it covered "${declared}" but a ${method.toUpperCase()} must cover "${covered.join(" ")}"`,
    };
  }

  if (covered.includes("digest")) {
    const expectedDigest = `SHA-256=${createHash("sha256").update(body).digest("base64")}`;
    if (headers.digest !== expectedDigest) {
      return { ok: false, keyId, reason: "digest header does not match the body" };
    }
  }

  const publicKey = resolveKey(keyId);
  if (!publicKey) return { ok: false, keyId, reason: `no key resolvable for ${keyId}` };

  const ok = verify(
    null,
    Buffer.from(
      signingString(covered, method, path, {
        host: headers.host ?? "",
        date: headers.date,
        digest: headers.digest,
      }),
    ),
    publicKey,
    Buffer.from(signature, "base64"),
  );
  return ok ? { ok: true, keyId, reason: "" } : { ok: false, keyId, reason: "signature does not verify" };
}

export { createPrivateKey, createPublicKey };
