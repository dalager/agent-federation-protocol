/**
 * `eddsa-jcs-2022` object integrity proofs (FEP-8b32 / W3C Data Integrity).
 *
 * This is the only signature that survives an export, and therefore the only
 * one a third-party replay can check — see 01 § Authentication. The exact
 * algorithm is restated in `src/verifier/README.md`, because an independent
 * implementation has to reproduce it byte for byte without reading this file.
 *
 *   proofConfig      = proof object minus proofValue, plus the document's @context
 *   proofConfigHash  = SHA-256( JCS(proofConfig) )
 *   documentHash     = SHA-256( JCS(document minus proof) )
 *   signingInput     = proofConfigHash || documentHash          (config first)
 *   proofValue       = 'z' + base58btc( Ed25519-sign(signingInput) )
 *
 * The emitted proof omits `@context` — it is present only while hashing.
 */

import { createHash, type KeyObject } from "node:crypto";
import { canonicalBytes, type JsonValue } from "./jcs.ts";
import { multibaseDecode, multibaseEncode } from "./multibase.ts";
import { sign, verify } from "./keys.ts";

export const CRYPTOSUITE = "eddsa-jcs-2022";
export const DATA_INTEGRITY_CONTEXT = "https://w3id.org/security/data-integrity/v1";

export interface Proof {
  type: "DataIntegrityProof";
  cryptosuite: typeof CRYPTOSUITE;
  created: string;
  verificationMethod: string;
  proofPurpose: "assertionMethod";
  proofValue: string;
}

export type SignedDocument = { [key: string]: JsonValue } & { proof: Proof };

export function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** `sha256:<hex>` over the canonical form of a JSON value — the AFP digest form. */
export function digestOf(value: JsonValue): string {
  return `sha256:${sha256Hex(canonicalBytes(value))}`;
}

function buildSigningInput(
  document: { [key: string]: JsonValue },
  proofConfig: { [key: string]: JsonValue },
): Uint8Array {
  const unsecured = { ...document };
  delete (unsecured as Record<string, unknown>).proof;

  const proofConfigHash = sha256(canonicalBytes(proofConfig));
  const documentHash = sha256(canonicalBytes(unsecured));

  const input = new Uint8Array(proofConfigHash.length + documentHash.length);
  input.set(proofConfigHash, 0);
  input.set(documentHash, proofConfigHash.length);
  return input;
}

export interface SignOptions {
  privateKey: KeyObject;
  verificationMethod: string;
  /** Overridable so tests and replays are reproducible. */
  created?: string;
}

/** Attach an `eddsa-jcs-2022` proof, returning a new document. */
export function attachProof(
  document: { [key: string]: JsonValue },
  options: SignOptions,
): SignedDocument {
  const created = options.created ?? new Date().toISOString();

  const proofConfig: { [key: string]: JsonValue } = {
    type: "DataIntegrityProof",
    cryptosuite: CRYPTOSUITE,
    created,
    verificationMethod: options.verificationMethod,
    proofPurpose: "assertionMethod",
  };
  // Present while hashing, absent on the wire.
  if (document["@context"] !== undefined) {
    proofConfig["@context"] = document["@context"];
  }

  const signature = sign(options.privateKey, buildSigningInput(document, proofConfig));
  const proof: Proof = {
    type: "DataIntegrityProof",
    cryptosuite: CRYPTOSUITE,
    created,
    verificationMethod: options.verificationMethod,
    proofPurpose: "assertionMethod",
    proofValue: multibaseEncode(signature),
  };

  return { ...document, proof } as SignedDocument;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/** Check a document's proof against a public key. Never throws. */
export function verifyProof(document: unknown, publicKey: KeyObject): VerifyResult {
  if (typeof document !== "object" || document === null) {
    return { ok: false, reason: "document is not an object" };
  }

  const doc = document as { [key: string]: JsonValue };
  const proof = doc.proof as unknown as Proof | undefined;
  if (!proof || typeof proof !== "object") return { ok: false, reason: "no proof present" };
  if (proof.type !== "DataIntegrityProof") {
    return { ok: false, reason: `unexpected proof type ${String(proof.type)}` };
  }
  if (proof.cryptosuite !== CRYPTOSUITE) {
    return { ok: false, reason: `unexpected cryptosuite ${String(proof.cryptosuite)}` };
  }
  if (proof.proofPurpose !== "assertionMethod") {
    return { ok: false, reason: `unexpected proofPurpose ${String(proof.proofPurpose)}` };
  }
  if (typeof proof.proofValue !== "string") return { ok: false, reason: "proofValue is not a string" };

  const proofConfig: { [key: string]: JsonValue } = {
    type: proof.type,
    cryptosuite: proof.cryptosuite,
    created: proof.created,
    verificationMethod: proof.verificationMethod,
    proofPurpose: proof.proofPurpose,
  };
  if (doc["@context"] !== undefined) proofConfig["@context"] = doc["@context"];

  let signature: Uint8Array;
  try {
    signature = multibaseDecode(proof.proofValue);
  } catch (error) {
    return { ok: false, reason: `undecodable proofValue: ${(error as Error).message}` };
  }

  let input: Uint8Array;
  try {
    input = buildSigningInput(doc, proofConfig);
  } catch (error) {
    return { ok: false, reason: `document is not canonicalizable: ${(error as Error).message}` };
  }

  return verify(publicKey, input, signature)
    ? { ok: true }
    : { ok: false, reason: "signature does not verify" };
}
