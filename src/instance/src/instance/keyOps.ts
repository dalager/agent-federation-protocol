/**
 * ADR-0026 Decision 2: rotation and revocation are a runbook and a CLI, not
 * demo code.
 *
 * Before this, `rotateKeyPair`/`revokeKeyPair` existed in `crypto/keys.ts` and
 * were reached only from tests — the ADR-0012 history entries an operator is
 * supposed to produce were produced by demos. These two functions are what a
 * runbook can actually call, and they carry the one refusal that cannot be
 * left to a human reading a date: **ADR-0021 Decision 4d** — a revocation cut
 * may not predate a vote embedded in an on-record `afp:EquivocationProof`.
 *
 * Why that refusal belongs here rather than only at replay: backdating a cut
 * to before the votes that convicted you is precisely how a caught equivocator
 * would try to argue the signatures were never theirs. Replay catches it after
 * the fact; this catches it at the moment the operator would otherwise commit
 * the mistake, which is what "a runbook" has to mean if it means anything.
 */

import { generateKeyPairSync } from "node:crypto";
import type { JsonValue } from "../crypto/jcs.ts";
import { hubScopedKeyId, keyHistory, keyIdFor, rawPublicKey, recordRemoteRootKey, revokeKeyPair, rotateKeyPair, transportKeyId, type KeyPair } from "../crypto/keys.ts";
import { instantMillis } from "../crypto/time.ts";
import { encodeEd25519Multikey } from "../crypto/multibase.ts";
import { attachProofAsync } from "../crypto/proof.ts";
import { fetchRemoteSignerPublicKey, remoteIssuedSigner, type RemoteSignerClientConfig } from "../crypto/signer.ts";
import { agentActorId, instanceActorId } from "../ap/documents.ts";
import { keyDelegation, type Envelope } from "../ap/activities.ts";
import { Outbox, type OutboxEntry } from "../store/outbox.ts";
import type { Db } from "../store/db.ts";

/**
 * What a key operation needs — deliberately *not* an `AfpInstance`.
 *
 * Revocation without a successor leaves the key store with no active key,
 * which `loadOrCreateKeyPair` refuses by design (ADR-0012 D2: the successor
 * comes from rotation, never from silently re-minting ordinal 1). Booting a
 * full instance to run a key command would therefore make `keys rotate` — the
 * sanctioned way out — impossible to run exactly when it is needed. These
 * operations work on the key store and the record directly.
 */
export interface KeyOpsDeps {
  keyDir: string;
  origin: string;
  /** Read-only here: used to find votes an on-record proof already embeds. */
  db: Db;
}

/** Which of an actor's three key kinds an operation addresses. */
export type KeyKind = { kind: "proof" } | { kind: "transport" } | { kind: "hub"; hubId: string };

export function parseKind(raw: string | undefined): KeyKind {
  if (raw === undefined || raw === "proof") return { kind: "proof" };
  if (raw === "transport") return { kind: "transport" };
  const hub = /^hub:(.+)$/.exec(raw);
  if (hub) return { kind: "hub", hubId: hub[1] };
  throw new Error(`unknown key kind "${raw}" — expected proof | transport | hub:<id>`);
}

/** The key-store file name for one actor's key of a given kind. */
export function keyFileName(actorName: string, kind: KeyKind): string {
  if (kind.kind === "proof") return actorName;
  if (kind.kind === "transport") return `${actorName}--transport`;
  return `${actorName}--hub-${kind.hubId}`;
}

/**
 * Every vote embedded in an `afp:EquivocationProof` anywhere in this
 * instance's record, paired with the key that signed it. This is the material
 * ADR-0021 Decision 4d protects: a cut earlier than one of these would strand
 * a proof that is already on the record and already convicting.
 */
export function votesEmbeddedInProofs(
  deps: KeyOpsDeps,
): { verificationMethod: string; published: string }[] {
  const rows = deps.db.prepare("SELECT activity_json FROM outbox").all() as { activity_json: string }[];
  const found: { verificationMethod: string; published: string }[] = [];

  const walk = (node: JsonValue): void => {
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as { [key: string]: JsonValue };
    if (record.type === "afp:EquivocationProof" && Array.isArray(record["afp:votes"])) {
      for (const vote of record["afp:votes"] as JsonValue[]) {
        if (!vote || typeof vote !== "object" || Array.isArray(vote)) continue;
        const proof = (vote as { [key: string]: JsonValue }).proof;
        const published = (vote as { [key: string]: JsonValue }).published;
        if (proof && typeof proof === "object" && !Array.isArray(proof)) {
          const method = (proof as { [key: string]: JsonValue }).verificationMethod;
          if (typeof method === "string" && typeof published === "string") {
            found.push({ verificationMethod: method, published });
          }
        }
      }
    }
    for (const value of Object.values(record)) walk(value);
  };

  for (const row of rows) {
    try {
      walk(JSON.parse(row.activity_json));
    } catch {
      /* an unparseable row cannot embed a proof */
    }
  }
  return found;
}

/** The controller id and key-store file name for one actor's key. */
export function locate(deps: KeyOpsDeps, actorName: string, kind: KeyKind): { controller: string; file: string } {
  const isInstance = actorName === "@instance";
  return {
    controller: isInstance ? instanceActorId(deps.origin) : agentActorId(deps.origin, actorName),
    file: keyFileName(isInstance ? "instance" : actorName, kind),
  };
}

/**
 * Rotation: mint the successor and close the outgoing key's interval. The
 * retired key keeps its interval forever, so everything it signed in-interval
 * verifies forever — rotation is hygiene, not a compromise (ADR-0012 D2).
 */
export function rotateKey(deps: KeyOpsDeps, actorName: string, kind: KeyKind, at: Date): KeyPair {
  const { controller, file } = locate(deps, actorName, kind);
  return rotateKeyPair(deps.keyDir, file, controller, at);
}

/** The per-kind keyId function, matching the one `crypto/keys.ts` uses when it mints a key of that kind. */
function keyIdFnFor(kind: KeyKind): (controller: string, ordinal: number) => string {
  if (kind.kind === "proof") return keyIdFor;
  if (kind.kind === "transport") return transportKeyId;
  const hubId = kind.hubId;
  return (controller, ordinal) => hubScopedKeyId(controller, hubId, ordinal);
}

/**
 * ADR-0035 Decision 2: rotation whose successor is introduced by a root key
 * that lives on a remote signer — `remote-issued` custody. One `/sign` call,
 * made *before* anything local is mutated, so an unreachable or refusing
 * signer leaves the current key exactly as it was (gate G4/G5): the
 * successor keypair is generated in memory, the `afp:KeyDelegation` naming
 * its public half is built and sent to the root key for signature, and only
 * once that succeeds is the keypair committed to the local store and the
 * signed delegation appended to the instance's own chain.
 */
export interface RemoteRootConfig extends RemoteSignerClientConfig {
  /** How long the successor is valid before its own next rotation. */
  lifetimeMs: number;
}

export async function rotateKeyWithRemoteRoot(
  deps: KeyOpsDeps,
  actorName: string,
  kind: KeyKind,
  at: Date,
  remote: RemoteRootConfig,
): Promise<{ successor: KeyPair; delegation: OutboxEntry }> {
  const { controller, file } = locate(deps, actorName, kind);
  const keyIdOf = keyIdFnFor(kind);

  // Ordinals are assigned without gaps (crypto/keys.ts `rotateKeyPair`), so
  // the count of existing history entries is exactly the ordinal the next
  // rotation will mint — knowable before minting it.
  const nextOrdinal = keyHistory(deps.keyDir, file, controller, keyIdOf).length + 1;
  const successorKeyId = keyIdOf(controller, nextOrdinal);
  const candidate = generateKeyPairSync("ed25519");
  const publicKeyMultibase = encodeEd25519Multikey(rawPublicKey(candidate.publicKey));

  const validFrom = at.toISOString();
  const validUntil = new Date(at.getTime() + remote.lifetimeMs).toISOString();

  // The root's public half never lives on this host as a signing key. It is
  // fetched here only so it can be recorded and published on the instance
  // actor document (below) — never embedded in the delegation activity
  // itself, and never folded into afp:keyHistory: both are part of the
  // record this same host produces, and a verifier must resolve the root
  // from an anchor a counterparty already held before any theft, not from
  // anything this export can assert about itself (ADR-0035 Decision 2's
  // amendment). A throw here, like the /sign call below, happens before any
  // local mutation: an unreachable signer leaves the current key untouched.
  const rootKey = await fetchRemoteSignerPublicKey(remote);

  const instanceId = instanceActorId(deps.origin);
  const outbox = new Outbox(deps.db);
  const envelope: Envelope = {
    activityId: `${instanceId}/activities/${String(outbox.nextSeq(instanceId)).padStart(4, "0")}`,
    actor: instanceId,
    to: [],
    thread: `${deps.origin}/threads/key-custody`,
    visibility: "public",
    published: validFrom,
    prevActivity: outbox.headDigest(instanceId),
  };
  const activity = keyDelegation(envelope, {
    delegatedKey: { keyId: successorKeyId, publicKeyMultibase },
    validFrom,
    validUntil,
    rootKey: remote.keyId,
  });

  // The one call to /sign this path makes — exactly once, and before any
  // local mutation. A throw here (unreachable signer, a 403 for an
  // unauthorized keyId) propagates unchanged: the caller sees the current
  // key still active and nothing written.
  const signed = await attachProofAsync(activity, {
    signer: remoteIssuedSigner(remote),
    created: validFrom,
  });

  // Everything from here on is local and infallible in practice — nothing
  // between a successful /sign and the return below should leave the store
  // half-updated (G6).
  recordRemoteRootKey(deps.keyDir, { keyId: remote.keyId, publicKeyMultibase: rootKey.publicKeyMultibase });

  // `rotateKeyPair` itself always shapes a proof-style id (`#ed25519-key-N`);
  // the transport/hub-scoped forms are applied by their own callers
  // (`loadOrCreateTransportKeyPair`/`loadOrCreateHubKeyPair`), the same
  // correction applied here so the returned successor's `keyId` matches the
  // one the delegation just named and signed for. The delegated `validUntil`
  // travels onto the successor's own index entry — and therefore into
  // afp:keyHistory — so a signature made after the delegation expired fails
  // `keys:` at replay rather than reading as still-current (Decision 2's
  // compromise-window property; `check_key_delegations` in the Python
  // verifier holds every such signature to this same window a second way,
  // independent of the history entry).
  const rotated = rotateKeyPair(deps.keyDir, file, controller, at, candidate, new Date(validUntil));
  const successor: KeyPair = { ...rotated, keyId: successorKeyId };
  const delegation = outbox.append(signed as unknown as { [key: string]: JsonValue });
  return { successor, delegation };
}

export class RevocationRefused extends Error {}

/**
 * Revocation: cut the key's interval at the compromise instant.
 *
 * Refuses a `since` earlier than any vote that an on-record
 * `afp:EquivocationProof` embeds and this key signed (ADR-0021 Decision 4d).
 * The refusal names the vote, because "your cut is too early" is not
 * actionable and "this cut would strand the vote at <instant> that proof
 * <id> embeds" is.
 */
export function revokeKey(
  deps: KeyOpsDeps,
  actorName: string,
  kind: KeyKind,
  keyId: string,
  since: Date,
): void {
  // A cut at or before an embedded vote's instant would place that vote
  // outside the key's declared validity — retroactively unsigning evidence
  // that is already on the record.
  const cut = since.getTime();
  const conflicting = votesEmbeddedInProofs(deps)
    .filter((vote) => vote.verificationMethod === keyId && instantMillis(vote.published) >= cut)
    .sort((a, b) => instantMillis(a.published) - instantMillis(b.published));

  if (conflicting.length > 0) {
    const earliest = conflicting[0];
    throw new RevocationRefused(
      `refusing to cut ${keyId} at ${since.toISOString()}: an afp:EquivocationProof on this ` +
        `record embeds a vote signed by that key at ${earliest.published}, which the cut would ` +
        `place outside the key's validity — a revocation may not retroactively unsign evidence ` +
        `already used to convict (ADR-0021 Decision 4d). Cut no earlier than ${earliest.published}.`,
    );
  }

  revokeKeyPair(deps.keyDir, locate(deps, actorName, kind).file, since);
}
