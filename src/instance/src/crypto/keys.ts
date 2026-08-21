/**
 * Ed25519 key material.
 *
 * Node's built-in `crypto` covers Ed25519 outright, so P1 needs no cryptography
 * dependency at all. Keys live on disk in PKCS#8/SPKI PEM, never in source and
 * never in the record.
 *
 * ADR-0012 Decision 1 adds versioned key ids and validity intervals: a `keyId`
 * derived as `{controller}#ed25519-key` cannot express two keys for one actor,
 * so rotation appends an ordinal (`#ed25519-key-2`, `#ed25519-key-3`, …) while
 * the first key keeps its unversioned id — that is what lets every export
 * written before this ADR keep verifying against ids it already contains. The
 * interval (`validFrom`/`validUntil`/`retiredBy`) travels beside the PEM in a
 * small per-name sidecar index (`<name>.keys.json`) rather than inside it, so a
 * pre-ADR-0012 key directory — PEM only, no sidecar — still loads: a missing
 * sidecar synthesizes a single open-ended ordinal-1 entry rather than failing.
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

export type RetiredBy = "rotation" | "revocation";

export interface KeyPair {
  /** Fully-qualified verification method id, e.g. `https://…/agents/writer#ed25519-key`. */
  readonly keyId: string;
  readonly controller: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  /** `publicKeyMultibase` for the actor document's Multikey entry. */
  readonly publicKeyMultibase: string;
  /**
   * ISO instant the key became valid — **absent when it was never recorded**.
   * A first key predating any key store has no knowable start, and inventing
   * one (a file mtime, the moment the store was read) manufactures a fact that
   * can be wrong in the one direction that matters: a start *after* activities
   * the key legitimately signed. Absent means unbounded below (ADR-0012).
   */
  readonly validFrom?: string;
  /** ISO instant the key stopped being valid, absent while still active. */
  readonly validUntil?: string;
  /** How the key left service — absent while still active. */
  readonly retiredBy?: RetiredBy;
}

/** One entry in a `<name>.keys.json` sidecar index — one per key ordinal. */
interface KeyIndexEntry {
  ordinal: number;
  /** Absent when never recorded — see `KeyPair.validFrom`. */
  validFrom?: string;
  validUntil?: string;
  retiredBy?: RetiredBy;
}

/** A full history entry, shaped for the manifest's `afp:keyHistory` (ADR-0012 Decision 1). */
export interface KeyHistoryEntry {
  keyId: string;
  publicKeyMultibase: string;
  validFrom?: string;
  validUntil?: string;
  retiredBy?: RetiredBy;
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

/** `#ed25519-key` for the first key, `#ed25519-key-<ordinal>` for every rotation after it. */
function keyIdFor(controller: string, ordinal: number): string {
  return ordinal === 1 ? `${controller}#ed25519-key` : `${controller}#ed25519-key-${ordinal}`;
}

function pemPath(keyDir: string, name: string, ordinal: number): string {
  const base = ordinal === 1 ? name : `${name}-${ordinal}`;
  return join(keyDir, `${base}.pem`);
}

function indexPath(keyDir: string, name: string): string {
  return join(keyDir, `${name}.keys.json`);
}

function readIndex(keyDir: string, name: string): KeyIndexEntry[] {
  const path = indexPath(keyDir, name);
  if (!existsSync(path)) return [];
  return (JSON.parse(readFileSync(path, "utf8")) as KeyIndexEntry[]).sort(
    (a, b) => a.ordinal - b.ordinal,
  );
}

function writeIndex(keyDir: string, name: string, entries: KeyIndexEntry[]): void {
  writeFileSync(
    indexPath(keyDir, name),
    `${JSON.stringify(entries.sort((a, b) => a.ordinal - b.ordinal), null, 2)}\n`,
  );
}

/**
 * The index as it should be read, sidecar or not.
 *
 * A key directory written before ADR-0012 has a PEM and no sidecar at all —
 * that MUST still load. The synthesized entry never touches disk: it is a
 * read-time fallback, not a migration, so a directory nobody opened under the
 * new code stays byte-for-byte what it was.
 */
function effectiveIndex(keyDir: string, name: string): KeyIndexEntry[] {
  const entries = readIndex(keyDir, name);
  if (entries.length > 0) return entries;
  const first = pemPath(keyDir, name, 1);
  if (!existsSync(first)) return [];
  // No sidecar to date it from, so the entry declares no start. An mtime would
  // be a guess dressed as a fact — and a wrong guess here is not harmless: a
  // synthesized start later than activities the key really signed would fail
  // exactly the corpus this ADR exists to keep verifiable. Unbounded below is
  // the true statement (ADR-0012 Decision 1).
  return [{ ordinal: 1 }];
}

/** The currently active entry — highest ordinal without a `validUntil`. */
function activeEntry(entries: KeyIndexEntry[]): KeyIndexEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].validUntil === undefined) return entries[i];
  }
  return undefined;
}

function loadKeyPairAt(keyDir: string, name: string, controller: string, entry: KeyIndexEntry): KeyPair {
  const path = pemPath(keyDir, name, entry.ordinal);
  const privateKey = createPrivateKey(readFileSync(path, "utf8"));
  const publicKey = createPublicKey(privateKey);
  return {
    keyId: keyIdFor(controller, entry.ordinal),
    controller,
    privateKey,
    publicKey,
    publicKeyMultibase: encodeEd25519Multikey(rawPublicKey(publicKey)),
    validFrom: entry.validFrom,
    validUntil: entry.validUntil,
    retiredBy: entry.retiredBy,
  };
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
 * Load the *currently active* keypair for `controller`, generating and
 * persisting an ordinal-1 key on first use.
 *
 * P1 runs `keyCustody: "instance"`, so in practice this is the instance key
 * signing on each agent's behalf; giving every actor its own file keeps the
 * switch to `self` custody a configuration change rather than a rewrite.
 *
 * After a rotation the active key is a higher ordinal than 1 — this resolves
 * to whichever entry in the sidecar index has no `validUntil`, which is what
 * lets an instance resume signing with the post-rotation key across restarts.
 * (A directory with every ordinal retired and none active — revoked with no
 * follow-up rotation — has no key to resume with; that is a deployment error
 * for the caller to notice, not a case this function papers over.)
 */
export function loadOrCreateKeyPair(keyDir: string, name: string, controller: string): KeyPair {
  mkdirSync(keyDir, { recursive: true });
  const existing = effectiveIndex(keyDir, name);
  const active = activeEntry(existing);
  if (active) return loadKeyPairAt(keyDir, name, controller, active);

  // Nothing on disk yet (or every ordinal already retired, which only happens
  // if effectiveIndex found real history — but no PEM at ordinal 1 means this
  // is a genuinely fresh actor): mint ordinal 1.
  const path = pemPath(keyDir, name, 1);
  mkdirSync(dirname(path), { recursive: true });
  const pair = generateKeyPairSync("ed25519");
  writeFileSync(path, pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string, {
    mode: 0o600,
  });
  // No validFrom on a first key: the key store has no clock of its own, and the
  // instance's clock may be a test or replay clock running years from wall time
  // — stamping one here would date the key by when the *process* ran rather
  // than by anything the record can corroborate. Rotation and revocation supply
  // the instants they genuinely know; a beginning is not one of them.
  const entry: KeyIndexEntry = { ordinal: 1 };
  writeIndex(keyDir, name, [...existing.filter((e) => e.ordinal !== 1), entry]);
  return loadKeyPairAt(keyDir, name, controller, entry);
}

/**
 * Rotation (ADR-0012 Decision 2): archive the active key and mint its
 * successor. The retired key keeps its validity interval and stays in the
 * history forever — everything it signed in-interval verifies forever. This
 * is distinct from revocation: rotation is routine hygiene, not a compromise.
 */
export function rotateKeyPair(
  keyDir: string,
  name: string,
  controller: string,
  at: Date = new Date(),
): KeyPair {
  // Ensures ordinal 1 exists before rotating a brand-new actor.
  loadOrCreateKeyPair(keyDir, name, controller);
  const entries = effectiveIndex(keyDir, name);
  const current = activeEntry(entries);
  if (!current) throw new Error(`no active key to rotate for ${name}`);

  const retiredAt = at.toISOString();
  const nextOrdinal = Math.max(...entries.map((e) => e.ordinal)) + 1;
  const nextPath = pemPath(keyDir, name, nextOrdinal);
  const pair = generateKeyPairSync("ed25519");
  writeFileSync(nextPath, pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string, {
    mode: 0o600,
  });

  const nextEntries = entries.map((e) =>
    e.ordinal === current.ordinal ? { ...e, validUntil: retiredAt, retiredBy: "rotation" as const } : e,
  );
  const newEntry: KeyIndexEntry = { ordinal: nextOrdinal, validFrom: retiredAt };
  nextEntries.push(newEntry);
  writeIndex(keyDir, name, nextEntries);

  return loadKeyPairAt(keyDir, name, controller, newEntry);
}

/**
 * Revocation (ADR-0012 Decision 2): cut the active key's interval at the
 * supplied compromise instant. Unlike rotation, this does not mint a
 * successor — a compromise and "what signs next" are separate decisions, and
 * collapsing them would hide which one happened. `afp:retiredBy: "revocation"`
 * records the *reason*, which Decision 2 needs on the record rather than
 * inferred from a merely-closed interval.
 */
export function revokeKeyPair(keyDir: string, name: string, compromisedAt: Date): void {
  const entries = effectiveIndex(keyDir, name);
  const current = activeEntry(entries);
  if (!current) throw new Error(`no active key to revoke for ${name}`);

  const cutAt = compromisedAt.toISOString();
  const nextEntries = entries.map((e) =>
    e.ordinal === current.ordinal ? { ...e, validUntil: cutAt, retiredBy: "revocation" as const } : e,
  );
  writeIndex(keyDir, name, nextEntries);
}

/**
 * The full signing-key history for one actor, oldest first — what the
 * exporter collects into the manifest's `afp:keyHistory` (ADR-0012 Decision 1).
 */
export function keyHistory(keyDir: string, name: string, controller: string): KeyHistoryEntry[] {
  return effectiveIndex(keyDir, name).map((entry) => {
    const pair = loadKeyPairAt(keyDir, name, controller, entry);
    return {
      keyId: pair.keyId,
      publicKeyMultibase: pair.publicKeyMultibase,
      validFrom: pair.validFrom,
      validUntil: pair.validUntil,
      retiredBy: pair.retiredBy,
    };
  });
}
