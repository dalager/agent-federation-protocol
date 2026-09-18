/**
 * ADR-0026 Decision 1: the signer port.
 *
 * Everything that signs — object proofs, HTTP signatures, the export manifest
 * — takes a `Signer` rather than a private key, so that where key material
 * lives becomes an adapter choice instead of an assumption compiled into
 * every call site. The baseline document's honest complaint was that "key
 * custody is currently *file custody*"; the port is what lets custody improve
 * without touching the instance.
 *
 * **The port is synchronous** — a deviation from the ADR as written, which
 * specified `sign(bytes): Promise<Uint8Array>`. The ADR did not price that:
 * `attachProof` is synchronous, and it is reached from `instance.publish`
 * (158 call sites) and from actor-document construction served inside
 * synchronous HTTP handlers (99 more). Making the port async turns the whole
 * signing core async for the benefit of one adapter that is not built here.
 * The `file` and `agent` adapters are natively synchronous; a `remote` KMS
 * adapter is what wants a promise, and it should arrive with the async
 * variant it needs rather than imposing one on everything now. Recorded in
 * ADR-0026's build status as a revision under contact.
 */

import { createPublicKey, sign as nodeSign, type KeyObject } from "node:crypto";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { readFileSync } from "node:fs";
import { encodeEd25519Multikey } from "./multibase.ts";
import { rawPublicKey, type KeyPair } from "./keys.ts";

/**
 * Where a key lives, as published informationally on an actor document's key
 * entry (`afp:custody`) so an auditor can see it without being able to reach
 * it. `remote-issued` (ADR-0035 Decision 2) names a root key that issues
 * short-lived successors rather than performing every signature itself — the
 * successors it issues are ordinary `file`-custody keys.
 */
export type Custody = "file" | "remote" | "agent" | "remote-issued";

export interface Signer {
  /** The verification method this signer signs as. */
  readonly keyId: string;
  /** The public half, for the actor document entry that publishes it. */
  readonly publicKeyMultibase: string;
  /** Where the private half lives — informational, never a capability. */
  readonly custody: Custody;
  sign(bytes: Uint8Array): Uint8Array;
}

/**
 * The `file` adapter: today's PEM-backed keypair behind the port. The
 * reference adapter, and the only one the gate needs.
 *
 * The `KeyObject` stays closed over here rather than being handed out, which
 * is the whole point — a caller can sign, and cannot export, copy or log the
 * private half.
 */
export function fileSigner(pair: KeyPair): Signer {
  return signerOver(pair.keyId, pair.privateKey, pair.publicKeyMultibase, "file");
}

/**
 * The `agent` adapter: `self` custody, meaning it — the instance holds no
 * private key for this actor at all.
 *
 * The agent supplies the signing operation and its own public half; the
 * instance can ask for a signature and can never produce one on its own,
 * which is the whole difference from `self` custody as it existed before
 * ADR-0026 (where the roster said `self` and the instance still minted and
 * held the PEM). 01 § "the agent–instance boundary" describes exactly this
 * and nothing had exercised it.
 *
 * Synchronous, like every adapter here: an agent in another process reaches
 * this through a bridge its own operator writes. A signer that must await the
 * network is the `remote` adapter's problem, and waits for the async port.
 */
export function agentSigner(
  keyId: string,
  publicKeyMultibase: string,
  sign: (bytes: Uint8Array) => Uint8Array,
): Signer {
  return { keyId, publicKeyMultibase, custody: "agent", sign };
}

/**
 * A signer over a bare `KeyObject`, for call sites that hold one directly
 * (the HTTP-signature tests, and any caller minting an ephemeral key). Same
 * closure discipline as `fileSigner`.
 */
export function signerOver(
  keyId: string,
  privateKey: KeyObject,
  publicKeyMultibase = encodeEd25519Multikey(rawPublicKey(createPublicKey(privateKey))),
  custody: Custody = "file",
): Signer {
  return {
    keyId,
    publicKeyMultibase,
    custody,
    sign: (bytes: Uint8Array): Uint8Array => new Uint8Array(nodeSign(null, bytes, privateKey)),
  };
}

// ------------------------------------------------------------- ADR-0035

/**
 * ADR-0035 Decision 3: the wire contract every remote signer speaks — a file-
 * backed reference implementation ships in `tools/signer/`, and any real KMS
 * or HSM proxy an operator runs fits the same shape.
 */
export interface RemoteSignerClientConfig {
  /** `{AFP_SIGNER_URL}` — configuration, never a fetched resource (ADR-0025's policedFetch does not apply). */
  url: string;
  keyId: string;
  /** mTLS client certificate/key this instance authenticates to the signer with. */
  clientCertFile?: string;
  clientKeyFile?: string;
  /** CA the signer's own server certificate must chain to. */
  caFile?: string;
  /** How long to wait for a response before giving up. Default 10s — a rotation is an operator waiting, not a background loop. */
  timeoutMs?: number;
}

const DEFAULT_REMOTE_SIGNER_TIMEOUT_MS = 10_000;

/**
 * The one adapter whose signature crosses the network — `remote-issued`
 * custody's root key, called once per rotation to sign the
 * `afp:KeyDelegation` that introduces its successor (Decision 2). Not a
 * `Signer`: the port stays synchronous (ADR-0026's revision note), and this
 * type is the narrow async exception `crypto/proof.ts`'s `attachProofAsync`
 * exists for.
 */
export interface AsyncSigner {
  readonly keyId: string;
  readonly custody: "remote-issued";
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}

export function remoteIssuedSigner(cfg: RemoteSignerClientConfig): AsyncSigner {
  return {
    keyId: cfg.keyId,
    custody: "remote-issued",
    async sign(bytes: Uint8Array): Promise<Uint8Array> {
      const body = JSON.stringify({
        keyId: cfg.keyId,
        alg: "ed25519",
        message: Buffer.from(bytes).toString("base64"),
      });
      const res = await remoteSignerRequest(cfg, "POST", "/sign", body);
      if (res.status === 403) {
        throw new Error(`remote signer refused: client certificate is not authorized for ${cfg.keyId}`);
      }
      if (res.status === 404) throw new Error(`remote signer: unknown keyId ${cfg.keyId}`);
      if (res.status !== 200) {
        throw new Error(`remote signer /sign failed: ${res.status} ${res.text}`);
      }
      const parsed = JSON.parse(res.text) as { signature: string };
      return new Uint8Array(Buffer.from(parsed.signature, "base64"));
    },
  };
}

/** `GET /keys/{keyId}` — the public half a delegation or an operator wants to confirm. */
export async function fetchRemoteSignerPublicKey(
  cfg: RemoteSignerClientConfig,
): Promise<{ keyId: string; publicKeyMultibase: string }> {
  const res = await remoteSignerRequest(cfg, "GET", `/keys/${encodeURIComponent(cfg.keyId)}`);
  if (res.status !== 200) throw new Error(`remote signer GET /keys/${cfg.keyId} failed: ${res.status} ${res.text}`);
  return JSON.parse(res.text) as { keyId: string; publicKeyMultibase: string };
}

/**
 * Called directly, over mutual TLS, never through `policedFetch` — ADR-0025's
 * address policy exists for *fetched* resources; the signer's address is
 * configuration an operator set on purpose, and its host is pinned by mTLS
 * rather than by the SSRF guard (ADR-0035 Decision 3).
 */
function remoteSignerRequest(
  cfg: RemoteSignerClientConfig,
  method: "GET" | "POST",
  path: string,
  body?: string,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, cfg.url);
    const options: RequestOptions = {
      method,
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      headers: {
        "content-type": "application/json",
        ...(body ? { "content-length": Buffer.byteLength(body) } : {}),
      },
      cert: cfg.clientCertFile ? readFileSync(cfg.clientCertFile) : undefined,
      key: cfg.clientKeyFile ? readFileSync(cfg.clientKeyFile) : undefined,
      ca: cfg.caFile ? readFileSync(cfg.caFile) : undefined,
    };
    const req = httpsRequest(options, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: data }));
    });
    req.on("error", reject);
    // A blackholed signer (accepts the TLS connection, never answers) must
    // not hang `keys rotate` forever — the request is destroyed and the
    // resulting error propagates through the same `reject` path as any
    // other transport failure, so callers (rotateKeyWithRemoteRoot) fail
    // closed exactly as they do for an unreachable host.
    req.setTimeout(cfg.timeoutMs ?? DEFAULT_REMOTE_SIGNER_TIMEOUT_MS, () => {
      req.destroy(new Error(`remote signer request to ${url} timed out after ${cfg.timeoutMs ?? DEFAULT_REMOTE_SIGNER_TIMEOUT_MS}ms`));
    });
    if (body) req.write(body);
    req.end();
  });
}
