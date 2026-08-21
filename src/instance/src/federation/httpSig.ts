/**
 * HTTP signatures for the hop — RFC 9421 native, draft-cavage as the
 * compatibility shim (ADR-0017 Decision 2, superseding ADR-0008 Decision 2's
 * cavage-first choice; its revisit trigger — fediverse migration toward
 * RFC 9421 — has fired).
 *
 * Transport authentication only: it proves who delivered these bytes on this
 * hop, and nothing more. Payload integrity is the `eddsa-jcs-2022` object
 * proof the activity already carries — which is also why none of this needs a
 * Python mirror: the hop signature is ephemeral and never enters the record,
 * so the verifier never sees it. That asymmetry is correct, not an omission.
 *
 * Native scheme (RFC 9421): structured `Signature-Input`/`Signature` fields,
 * Ed25519 (`alg="ed25519"`), `Content-Digest` (RFC 9530) binding the body,
 * `created` bounding replay alongside the `date` header. Covered components:
 * `@method`, `@authority`, `@path`, `date` — plus `content-digest` for a
 * request that carries a body.
 *
 * Shim scheme (draft-cavage): the fediverse-legacy `Signature` header with
 * `(request-target) host date [digest]`, `algorithm="hs2019"`, legacy
 * RFC 3230 `Digest`. Verified when presented; emitted only by the transport's
 * double-knock fallback.
 *
 * **The covered set is derived from the request method and never read from
 * the signature** (ADR-0013 Decision 1) — in both schemes. A signature that
 * declares a different covered set than the method demands is refused by
 * name rather than verified against its own weaker string: honouring the
 * declaration would let an attacker strip the body binding off a POST,
 * leaving the body unauthenticated while the signature still verified. The
 * discipline was never cavage-specific (ADR-0017 Decision 2).
 */

import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

const SKEW_MS = 5 * 60 * 1000;

export interface SignedRequestHeaders {
  host: string;
  date: string;
  /** RFC 9530 `Content-Digest` — present only when the method carries a body. */
  "content-digest"?: string;
  /** RFC 9421 covered-components declaration. */
  "signature-input": string;
  signature: string;
}

export interface CavageSignedRequestHeaders {
  host: string;
  date: string;
  /** Legacy RFC 3230 `Digest` — present only when the method carries a body. */
  digest?: string;
  signature: string;
}

/** Methods that carry a body, and therefore bind it into the signature. */
const BODY_METHODS = new Set(["post", "put", "patch"]);

/**
 * The cavage headers a shim signature MUST cover, decided by the method alone.
 */
export function coveredHeaders(method: string): string[] {
  const base = ["(request-target)", "host", "date"];
  return BODY_METHODS.has(method.toLowerCase()) ? [...base, "digest"] : base;
}

/**
 * The RFC 9421 components a native signature MUST cover, decided by the
 * method alone. This function and `coveredHeaders` are the security boundary
 * of the module: every path — signing, verifying, the declared-set check —
 * reads the covered set from here, so there is exactly one place where "what
 * does this request bind" is answered, and no caller can widen or narrow it.
 */
export function coveredComponents(method: string): string[] {
  const base = ["@method", "@authority", "@path", "date"];
  return BODY_METHODS.has(method.toLowerCase()) ? [...base, "content-digest"] : base;
}

function contentDigest(body: string): string {
  return `sha-256=:${createHash("sha256").update(body).digest("base64")}:`;
}

function legacyDigest(body: string): string {
  return `SHA-256=${createHash("sha256").update(body).digest("base64")}`;
}

// ------------------------------------------------------------ RFC 9421

interface ComponentValues {
  host: string;
  date: string;
  "content-digest"?: string;
}

function componentValue(name: string, method: string, path: string, values: ComponentValues): string {
  if (name === "@method") return method.toUpperCase();
  if (name === "@authority") return values.host;
  if (name === "@path") return path;
  if (name === "date") return values.date;
  if (name === "content-digest") return values["content-digest"] ?? "";
  return "";
}

function signatureBase(
  covered: readonly string[],
  params: string,
  method: string,
  path: string,
  values: ComponentValues,
): string {
  const lines = covered.map((name) => `"${name}": ${componentValue(name, method, path, values)}`);
  lines.push(`"@signature-params": ${params}`);
  return lines.join("\n");
}

function signatureParams(covered: readonly string[], created: number, keyId: string): string {
  const list = covered.map((name) => `"${name}"`).join(" ");
  return `(${list});created=${created};keyid="${keyId}";alg="ed25519"`;
}

/** Sign a request with the native scheme (RFC 9421 + RFC 9530). */
export function signRequest(
  method: string,
  path: string,
  host: string,
  body: string,
  keyId: string,
  privateKey: KeyObject,
  now: Date,
): SignedRequestHeaders {
  const covered = coveredComponents(method);
  const date = now.toUTCString();
  const digest = covered.includes("content-digest") ? contentDigest(body) : undefined;
  const created = Math.floor(now.getTime() / 1000);
  const params = signatureParams(covered, created, keyId);
  const values: ComponentValues = { host, date, "content-digest": digest };
  const signature = sign(null, Buffer.from(signatureBase(covered, params, method, path, values)), privateKey).toString(
    "base64",
  );
  return {
    host,
    date,
    ...(digest !== undefined ? { "content-digest": digest } : {}),
    "signature-input": `afp=${params}`,
    signature: `afp=:${signature}:`,
  };
}

/** Sign a request with the legacy shim (draft-cavage), for double-knock fallback. */
export function signRequestCavage(
  method: string,
  path: string,
  host: string,
  body: string,
  keyId: string,
  privateKey: KeyObject,
  now: Date,
): CavageSignedRequestHeaders {
  const covered = coveredHeaders(method);
  const date = now.toUTCString();
  const digest = covered.includes("digest") ? legacyDigest(body) : undefined;
  const signature = sign(
    null,
    Buffer.from(cavageSigningString(covered, method, path, { host, date, digest })),
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

function cavageSigningString(
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

// ------------------------------------------------------------ verification

export interface VerifyResult {
  ok: boolean;
  keyId: string | null;
  reason: string;
}

export interface RequestAuthHeaders {
  host?: string;
  date?: string;
  digest?: string;
  "content-digest"?: string;
  "signature-input"?: string;
  signature?: string;
}

/**
 * The signer's keyId, from whichever scheme the request carries — RFC 9421
 * `keyid` in `Signature-Input`, or cavage `keyId` in `Signature`. The single
 * place callers learn who claims to have signed, before resolving keys.
 */
export function extractKeyId(headers: RequestAuthHeaders): string | null {
  const input = headers["signature-input"];
  if (input) return /keyid="([^"]+)"/.exec(input)?.[1] ?? null;
  return /keyId="([^"]+)"/.exec(headers.signature ?? "")?.[1] ?? null;
}

/**
 * Verify whichever scheme the request presents: `Signature-Input` present
 * means native RFC 9421; a bare cavage `Signature` header is the shim.
 */
export function verifyRequest(
  method: string,
  path: string,
  headers: RequestAuthHeaders,
  body: string,
  resolveKey: (keyId: string) => KeyObject | null,
  now: Date,
): VerifyResult {
  if (headers["signature-input"]) return verifyRfc9421(method, path, headers, body, resolveKey, now);
  if (headers.signature) return verifyCavage(method, path, headers, body, resolveKey, now);
  return { ok: false, keyId: null, reason: "no Signature-Input or Signature header" };
}

function dateOutsideSkew(date: string | undefined, now: Date): boolean {
  return !date || Math.abs(now.getTime() - new Date(date).getTime()) > SKEW_MS;
}

function verifyRfc9421(
  method: string,
  path: string,
  headers: RequestAuthHeaders,
  body: string,
  resolveKey: (keyId: string) => KeyObject | null,
  now: Date,
): VerifyResult {
  const input = headers["signature-input"]!;
  const inputMatch = /^([!#$%&'*+.^_`|~\w-]+)=(\(.*)$/.exec(input.trim());
  if (!inputMatch) return { ok: false, keyId: null, reason: "malformed Signature-Input" };
  const label = inputMatch[1];
  const params = inputMatch[2];
  const keyId = /keyid="([^"]+)"/.exec(params)?.[1] ?? null;
  const listMatch = /^\(([^)]*)\)/.exec(params);
  if (!keyId || !listMatch) return { ok: false, keyId, reason: "Signature-Input missing keyid or component list" };

  const sigMatch = new RegExp(`(?:^|,\\s*)${label}=:([^:]*):`).exec(headers.signature ?? "");
  if (!sigMatch) return { ok: false, keyId, reason: `no Signature member for label "${label}"` };
  const signature = sigMatch[1];

  if (dateOutsideSkew(headers.date, now)) {
    return { ok: false, keyId, reason: "date header absent or outside the skew window" };
  }
  const created = Number(/;created=(\d+)/.exec(params)?.[1] ?? NaN);
  if (!Number.isFinite(created) || Math.abs(now.getTime() - created * 1000) > SKEW_MS) {
    return { ok: false, keyId, reason: "created parameter absent or outside the skew window" };
  }
  const expires = /;expires=(\d+)/.exec(params)?.[1];
  if (expires !== undefined && Number(expires) * 1000 < now.getTime()) {
    return { ok: false, keyId, reason: "signature expired" };
  }

  // The method decides what this request had to bind (ADR-0013 Decision 1,
  // restated against 9421's component model): the declared covered components
  // must equal the method-derived set — a disagreement is refused by name.
  const required = coveredComponents(method);
  const declared = [...listMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const sameSet = declared.length === required.length && required.every((c) => declared.includes(c));
  if (!sameSet) {
    return {
      ok: false,
      keyId,
      reason: `signature covers (${declared.join(" ")}) but a ${method.toUpperCase()} must cover (${required.join(" ")})`,
    };
  }

  if (required.includes("content-digest") && headers["content-digest"] !== contentDigest(body)) {
    return { ok: false, keyId, reason: "Content-Digest does not match the body" };
  }

  const publicKey = resolveKey(keyId);
  if (!publicKey) return { ok: false, keyId, reason: `no key resolvable for ${keyId}` };

  // Rebuild the base in the declared order (equal as a set to the required
  // one), so a conformant signer's ordering choice verifies.
  const base = signatureBase(declared, params, method, path, {
    host: headers.host ?? "",
    date: headers.date!,
    "content-digest": headers["content-digest"],
  });
  const ok = verify(null, Buffer.from(base), publicKey, Buffer.from(signature, "base64"));
  return ok ? { ok: true, keyId, reason: "" } : { ok: false, keyId, reason: "signature does not verify" };
}

function verifyCavage(
  method: string,
  path: string,
  headers: RequestAuthHeaders,
  body: string,
  resolveKey: (keyId: string) => KeyObject | null,
  now: Date,
): VerifyResult {
  const header = headers.signature!;
  const fields = new Map<string, string>();
  for (const match of header.matchAll(/(\w+)="([^"]*)"/g)) fields.set(match[1], match[2]);
  const keyId = fields.get("keyId") ?? null;
  const signature = fields.get("signature");
  if (!keyId || !signature) return { ok: false, keyId, reason: "Signature header missing keyId or signature" };

  if (dateOutsideSkew(headers.date, now)) {
    return { ok: false, keyId, reason: "date header absent or outside the skew window" };
  }

  const covered = coveredHeaders(method);
  const declared = fields.get("headers");
  if (declared !== undefined && declared !== covered.join(" ")) {
    return {
      ok: false,
      keyId,
      reason: `signature declares it covered "${declared}" but a ${method.toUpperCase()} must cover "${covered.join(" ")}"`,
    };
  }

  if (covered.includes("digest") && headers.digest !== legacyDigest(body)) {
    return { ok: false, keyId, reason: "digest header does not match the body" };
  }

  const publicKey = resolveKey(keyId);
  if (!publicKey) return { ok: false, keyId, reason: `no key resolvable for ${keyId}` };

  const ok = verify(
    null,
    Buffer.from(
      cavageSigningString(covered, method, path, {
        host: headers.host ?? "",
        date: headers.date!,
        digest: headers.digest,
      }),
    ),
    publicKey,
    Buffer.from(signature, "base64"),
  );
  return ok ? { ok: true, keyId, reason: "" } : { ok: false, keyId, reason: "signature does not verify" };
}

export { createPrivateKey, createPublicKey };
