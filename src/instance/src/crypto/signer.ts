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
import { encodeEd25519Multikey } from "./multibase.ts";
import { rawPublicKey, type KeyPair } from "./keys.ts";

/**
 * Where a key lives, as published informationally on an actor document's key
 * entry (`afp:custody`) so an auditor can see it without being able to reach
 * it.
 */
export type Custody = "file" | "remote" | "agent";

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
