/**
 * Ed25519 key material.
 *
 * Node's built-in `crypto` covers Ed25519 outright, so P1 needs no cryptography
 * dependency at all. Keys live on disk in PKCS#8/SPKI PEM, never in source and
 * never in the record.
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
  type KeyObject,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { decodeEd25519Multikey, encodeEd25519Multikey } from "./multibase.ts";

export interface KeyPair {
  /** Fully-qualified verification method id, e.g. `https://…/agents/writer#ed25519-key`. */
  readonly keyId: string;
  readonly controller: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  /** `publicKeyMultibase` for the actor document's Multikey entry. */
  readonly publicKeyMultibase: string;
}

/** Raw 32-byte public key, extracted from the SPKI DER encoding. */
export function rawPublicKey(publicKey: KeyObject): Uint8Array {
  const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  // An Ed25519 SPKI document is a fixed 12-byte header followed by the key.
  return new Uint8Array(der.subarray(der.length - 32));
}

export function sign(privateKey: KeyObject, data: Uint8Array): Uint8Array {
  return new Uint8Array(nodeSign(null, data, privateKey));
}

export function verify(publicKey: KeyObject, data: Uint8Array, signature: Uint8Array): boolean {
  try {
    return nodeVerify(null, data, publicKey, signature);
  } catch {
    return false;
  }
}

/** Rebuild a public KeyObject from a `publicKeyMultibase` value. */
export function publicKeyFromMultibase(multibase: string): KeyObject {
  const raw = Buffer.from(decodeEd25519Multikey(multibase));
  const spkiHeader = Buffer.from([
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
  ]);
  return createPublicKey({
    key: Buffer.concat([spkiHeader, raw]),
    format: "der",
    type: "spki",
  });
}

/**
 * Load or create a hub-scoped keypair for `controller` under one hub.
 *
 * P2 extends the key store to `(actorId, hubId?) → key` (ADR-0002 Decision 4):
 * the file name carries the hub scope so it never collides with the P1
 * `assertionMethod` key, and the `keyId` matches the `afp:hubKey` shape from
 * 02 (`…#hub-key-<hubId>`) so it publishes alongside the P1 key rather than
 * replacing it.
 */
export function loadOrCreateHubKeyPair(
  keyDir: string,
  name: string,
  controller: string,
  hubId: string,
): KeyPair {
  const pair = loadOrCreateKeyPair(keyDir, `${name}--hub-${hubId}`, controller);
  return { ...pair, keyId: `${controller}#hub-key-${hubId}` };
}

/**
 * Load the keypair for `controller`, generating and persisting one on first use.
 *
 * P1 runs `keyCustody: "instance"`, so in practice this is the instance key
 * signing on each agent's behalf; giving every actor its own file keeps the
 * switch to `self` custody a configuration change rather than a rewrite.
 */
export function loadOrCreateKeyPair(keyDir: string, name: string, controller: string): KeyPair {
  const path = join(keyDir, `${name}.pem`);
  mkdirSync(dirname(path), { recursive: true });

  let privateKey: KeyObject;
  if (existsSync(path)) {
    privateKey = createPrivateKey(readFileSync(path, "utf8"));
  } else {
    const pair = generateKeyPairSync("ed25519");
    privateKey = pair.privateKey;
    writeFileSync(
      path,
      privateKey.export({ type: "pkcs8", format: "pem" }) as string,
      { mode: 0o600 },
    );
  }

  const publicKey = createPublicKey(privateKey);
  return {
    keyId: `${controller}#ed25519-key`,
    controller,
    privateKey,
    publicKey,
    publicKeyMultibase: encodeEd25519Multikey(rawPublicKey(publicKey)),
  };
}
