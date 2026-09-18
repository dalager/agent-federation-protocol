/**
 * ADR-0035 gate: remote custody — `remote-issued` (Decisions 2-3) and its
 * on-record `afp:KeyDelegation` (Decision 5). Decision 4 (the asynchronous
 * `remote` adapter, the full port) is costed and deliberately unscheduled —
 * nothing here builds it.
 *
 * G1-G8 follow the ADR's own gate matrix (G1/G4/G5/G6/G7/G8 as specified;
 * G2/G3 each have a "b" case added on review: G2b pins the root-resolution
 * amendment — the root must be published on an actor document, never
 * resolved from afp:keyHistory or the delegation's own claim — and G3b pins
 * the compromise-window amendment — a signature past the delegation's own
 * declared validUntil fails even if afp:keyHistory were left untouched).
 *
 *   node --experimental-sqlite --test test/adr0035.test.ts
 */

import assert from "node:assert/strict";
import { createServer as createHttpsServer } from "node:https";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, before, describe, it } from "node:test";
import { createPublicKey, generateKeyPairSync, sign as nodeSign, type KeyObject } from "node:crypto";

import { createResult } from "../src/ap/activities.ts";
import { AfpInstance } from "../src/instance.ts";
import { exportBundle } from "../src/export.ts";
import { encodeEd25519Multikey } from "../src/crypto/multibase.ts";
import { rawPublicKey, loadOrCreateKeyPair } from "../src/crypto/keys.ts";
import { fetchRemoteSignerPublicKey, remoteIssuedSigner } from "../src/crypto/signer.ts";
import { type RemoteRootConfig, rotateKeyWithRemoteRoot } from "../src/instance/keyOps.ts";
import { makeDevCerts, type DevCertBundle } from "../src/tools/signer/devCerts.ts";
import { startSignerServer, type SignerServerHandle } from "../src/tools/signer/server.ts";
import { cleanupWorkspaces, runVerifier, testInstance, workspace } from "./helpers.ts";
import { VERIFIER } from "./adr0010-fixtures.ts";
import { loadConfig } from "../src/config.ts";
import { runConfigCheck } from "../src/runtime/configCheck.ts";

after(cleanupWorkspaces);

const CAPABILITY = "afp:cap:assess";
const THREAD = "https://alpha.operator.local/threads/custody";
const ROOT_KEY_ID = "urn:afp-root-key:alpha";
const LIFETIME_MS = 60 * 60 * 1000;

let certs: DevCertBundle;
let rootKeyDir: string;
let rootPrivateKey: KeyObject;

function safeName(keyId: string): string {
  return keyId.replace(/[^a-zA-Z0-9]/g, "_");
}

/** A running reference signer authorized for ROOT_KEY_ID under the dev client cert. */
async function freshSigner(): Promise<SignerServerHandle> {
  return startSignerServer({
    keyDir: rootKeyDir,
    cert: certs.serverCert,
    key: certs.serverKey,
    ca: certs.caCert,
    authorizedFingerprints: { [ROOT_KEY_ID]: [certs.clientFingerprint256] },
  });
}

/** Reachable — GET /keys answers — but nothing is authorized to POST /sign. */
async function unauthorizedSigner(): Promise<SignerServerHandle> {
  return startSignerServer({
    keyDir: rootKeyDir,
    cert: certs.serverCert,
    key: certs.serverKey,
    ca: certs.caCert,
    authorizedFingerprints: {},
  });
}

function remoteConfig(handle: SignerServerHandle): RemoteRootConfig {
  return {
    url: handle.url,
    keyId: ROOT_KEY_ID,
    clientCertFile: certs.clientCertFile,
    clientKeyFile: certs.clientKeyFile,
    caFile: certs.caCertFile,
    lifetimeMs: LIFETIME_MS,
  };
}

before(() => {
  certs = makeDevCerts();
  rootKeyDir = mkdtempSync(join(tmpdir(), "afp-signer-keys-"));
  const pair = generateKeyPairSync("ed25519");
  rootPrivateKey = pair.privateKey;
  writeFileSync(
    join(rootKeyDir, `${safeName(ROOT_KEY_ID)}.pem`),
    pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  );
});

describe("ADR-0035 gate: remote-issued custody", () => {
  it("G1: rotation with a remote root calls /sign exactly once, and the successor signs everything after it", async () => {
    const handle = await freshSigner();
    try {
      const { instance, config } = testInstance(["writer"], CAPABILITY);
      const deps = { keyDir: config.keyDir, origin: config.origin, db: instance.db };
      const at = instance.clock.now();

      const { successor, delegation } = await rotateKeyWithRemoteRoot(deps, "@instance", { kind: "proof" }, at, remoteConfig(handle));
      assert.equal(handle.signCount, 1, "exactly one call to /sign");
      assert.match(successor.keyId, /#ed25519-key-2$/);
      assert.equal(delegation.activity.type, "Create");

      instance.close();

      // Reopening reloads the active key from disk — the successor, since
      // rotation closed the old ordinal's interval. What signs next is what
      // this checks.
      const reopened = new AfpInstance(config, [
        { spec: { name: "writer", capabilities: [CAPABILITY], keyCustody: "instance", since: at.toISOString() }, brain: instance.brainFor("writer")! },
      ]);
      const entry = reopened.publish("writer", [], THREAD, "parties", (envelope) =>
        createResult(envelope, { resultId: `${config.origin}/results/after-rotation`, correlationId: "leg-1", content: "post-rotation" }),
      );
      assert.equal((entry.activity.proof as { verificationMethod: string }).verificationMethod, successor.keyId);
      reopened.close();
    } finally {
      await handle.close();
    }
  });

  it("G2: the afp:KeyDelegation is signed by its named root and its interval falls inside the root's, and replays clean", async () => {
    const handle = await freshSigner();
    try {
      const { instance, config } = testInstance(["writer"], CAPABILITY);
      const deps = { keyDir: config.keyDir, origin: config.origin, db: instance.db };
      const at = instance.clock.now();

      instance.publish("writer", [], THREAD, "parties", (envelope) =>
        createResult(envelope, { resultId: `${config.origin}/results/g2`, correlationId: "leg-2", content: "ok" }),
      );

      // `writer`'s own key file, not the instance's: under `instance`
      // custody `writer`'s file is minted but unused for signing (the
      // instance key signs on its behalf), so rotating it here exercises
      // the delegation mechanism without disturbing the live signer the
      // instance itself still uses to sign the manifest below.
      const { delegation } = await rotateKeyWithRemoteRoot(deps, "writer", { kind: "proof" }, at, remoteConfig(handle));
      const object = delegation.activity.object as { [key: string]: unknown };
      assert.equal(object.type, "afp:KeyDelegation");
      assert.equal(object["afp:rootKey"], ROOT_KEY_ID);
      assert.equal(object["afp:rootKeyMultibase"], undefined, "the root's public half is not embedded in the activity");
      assert.equal((delegation.activity.proof as { verificationMethod: string }).verificationMethod, ROOT_KEY_ID);

      // Published on the instance actor document — the anchor the verifier
      // resolves the root from, never the delegation's own claim.
      const doc = instance.instanceDocument() as { assertionMethod: { id: string; "afp:custody"?: string }[] };
      const published = doc.assertionMethod.find((m) => m.id === ROOT_KEY_ID);
      assert.ok(published, "the root's public half is published on the instance actor document");
      assert.equal(published!["afp:custody"], "remote-issued");

      const exported = exportBundle(instance, config.exportDir);
      const manifest = JSON.parse(readFileSync(join(exported.dir, "MANIFEST.json"), "utf8")) as {
        "afp:keyHistory": Record<string, unknown>[];
      };
      assert.equal(
        manifest["afp:keyHistory"].some((e) => e.id === ROOT_KEY_ID),
        false,
        "the root never travels in afp:keyHistory — only on the actor document",
      );

      const result = runVerifier(VERIFIER, exported.dir, THREAD, ["--verbose"]);
      assert.equal(result.code, 0, `verifier failed:\n${result.output}`);
      assert.match(result.output, /keys: .*\(afp:KeyDelegation\)'s root key is published on an actor document/);
      assert.match(result.output, /keys: .*\(afp:KeyDelegation\) is signed by the root key it names/);
      instance.close();
    } finally {
      await handle.close();
    }
  });

  it("G2b: a delegation whose afp:rootKey is not published on any actor document fails by name", async () => {
    const handle = await freshSigner();
    try {
      const { instance, config } = testInstance(["writer"], CAPABILITY);
      const deps = { keyDir: config.keyDir, origin: config.origin, db: instance.db };
      await rotateKeyWithRemoteRoot(deps, "writer", { kind: "proof" }, instance.clock.now(), remoteConfig(handle));
      instance.publish("writer", [], THREAD, "parties", (envelope) =>
        createResult(envelope, { resultId: `${config.origin}/results/g2b`, correlationId: "leg-2b", content: "ok" }),
      );
      const exported = exportBundle(instance, config.exportDir);

      // Strip the root's published entry from the instance actor document —
      // the one anchor `check_key_delegations` trusts. Nothing about the
      // manifest's own signature protects this: actor documents are served
      // data, not signed blobs, which is exactly why a verifier must not
      // resolve a root any other way (afp:keyHistory, the activity's own
      // claim) that a thief with host access could still produce.
      const docPath = join(exported.dir, "instance.jsonld");
      const doc = JSON.parse(readFileSync(docPath, "utf8")) as { assertionMethod: { id: string }[] };
      doc.assertionMethod = doc.assertionMethod.filter((m) => m.id !== ROOT_KEY_ID);
      writeFileSync(docPath, JSON.stringify(doc, null, 2));

      const result = runVerifier(VERIFIER, exported.dir, THREAD, ["--verbose"]);
      assert.notEqual(result.code, 0);
      assert.match(result.output, /FAIL \] keys: .*\(afp:KeyDelegation\)'s root key is published on an actor document/);
      instance.close();
    } finally {
      await handle.close();
    }
  });

  it("G3: a delegated key signing outside its declared interval fails keys: by name at replay", async () => {
    const handle = await freshSigner();
    try {
      const { instance, config } = testInstance(["writer"], CAPABILITY);
      const deps = { keyDir: config.keyDir, origin: config.origin, db: instance.db };
      const at = instance.clock.now();
      await rotateKeyWithRemoteRoot(deps, "@instance", { kind: "proof" }, at, remoteConfig(handle));

      instance.publish("writer", [], THREAD, "parties", (envelope) =>
        createResult(envelope, { resultId: `${config.origin}/results/g3`, correlationId: "leg-3", content: "ok" }),
      );
      const exported = exportBundle(instance, config.exportDir);

      const manifestPath = join(exported.dir, "MANIFEST.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { "afp:keyHistory": Record<string, unknown>[] };
      const successorEntry = manifest["afp:keyHistory"].find((e) => String(e.id).endsWith("#ed25519-key-2"));
      assert.ok(successorEntry, "the successor key must be in the exported history");
      successorEntry["afp:validFrom"] = "2099-01-01T00:00:00.000Z";
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      const result = runVerifier(VERIFIER, exported.dir, THREAD, ["--verbose"]);
      assert.notEqual(result.code, 0);
      assert.match(result.output, /FAIL \] keys: .*signed by a key valid at its published instant/);
      instance.close();
    } finally {
      await handle.close();
    }
  });

  it("G3b: a signature made after the delegation's own validUntil fails at replay, even with an untouched afp:keyHistory", async () => {
    const handle = await freshSigner();
    try {
      const { instance, config, clock } = testInstance(["writer"], CAPABILITY);
      const deps = { keyDir: config.keyDir, origin: config.origin, db: instance.db };
      const at = instance.clock.now();

      const { successor } = await rotateKeyWithRemoteRoot(deps, "@instance", { kind: "proof" }, at, remoteConfig(handle));
      instance.close();

      // Past the delegated window (one hour) — nothing local stops a live
      // process from signing (the key material is still in memory; the
      // index is only consulted on load), which is exactly why the record,
      // not the process, has to be what a stranger holds this to.
      clock.jumpTo(new Date(at.getTime() + LIFETIME_MS + 60_000).toISOString());
      const reopened = new AfpInstance(config, [
        { spec: { name: "writer", capabilities: [CAPABILITY], keyCustody: "instance", since: at.toISOString() }, brain: instance.brainFor("writer")! },
      ], clock);
      const entry = reopened.publish("writer", [], THREAD, "parties", (envelope) =>
        createResult(envelope, { resultId: `${config.origin}/results/g3b`, correlationId: "leg-3b", content: "late" }),
      );
      assert.equal((entry.activity.proof as { verificationMethod: string }).verificationMethod, successor.keyId);

      const exported = exportBundle(reopened, config.exportDir);
      const result = runVerifier(VERIFIER, exported.dir, THREAD, ["--verbose"]);
      assert.notEqual(result.code, 0, "a signature past the delegated window must not replay clean");
      assert.match(result.output, /FAIL \] keys: .*signed by a key valid at its published instant/);
      assert.match(result.output, /FAIL \] keys: .*falls inside its afp:KeyDelegation's declared window/);
      reopened.close();
    } finally {
      await handle.close();
    }
  });

  it("G4: the reference signer refuses an unauthorized keyId with 403, and rotation fails closed", async () => {
    const handle = await unauthorizedSigner();
    try {
      const { instance, config } = testInstance(["writer"], CAPABILITY);
      const deps = { keyDir: config.keyDir, origin: config.origin, db: instance.db };
      const before = loadOrCreateKeyPair(config.keyDir, "instance", instance.instanceDocument().id as string);

      await assert.rejects(
        () => rotateKeyWithRemoteRoot(deps, "@instance", { kind: "proof" }, instance.clock.now(), remoteConfig(handle)),
        /403|not authorized/,
      );

      const after = loadOrCreateKeyPair(config.keyDir, "instance", instance.instanceDocument().id as string);
      assert.equal(after.keyId, before.keyId, "no successor was minted");
      instance.close();
    } finally {
      await handle.close();
    }
  });

  it("G5: signer unreachable at rotation time — the current key keeps signing, and the failure is reported", async () => {
    const { instance, config } = testInstance(["writer"], CAPABILITY);
    const deps = { keyDir: config.keyDir, origin: config.origin, db: instance.db };
    const before = loadOrCreateKeyPair(config.keyDir, "instance", instance.instanceDocument().id as string);

    const unreachable = remoteConfig({ url: "https://127.0.0.1:1", signCount: 0 } as unknown as SignerServerHandle);
    await assert.rejects(() =>
      rotateKeyWithRemoteRoot(deps, "@instance", { kind: "proof" }, instance.clock.now(), unreachable),
    );

    const after = loadOrCreateKeyPair(config.keyDir, "instance", instance.instanceDocument().id as string);
    assert.equal(after.keyId, before.keyId, "the current key is untouched and keeps signing");

    // And it still signs, uninterrupted.
    const entry = instance.publish("writer", [], THREAD, "parties", (envelope) =>
      createResult(envelope, { resultId: `${config.origin}/results/g5`, correlationId: "leg-5", content: "ok" }),
    );
    assert.equal((entry.activity.proof as { verificationMethod: string }).verificationMethod, before.keyId);
    instance.close();
  });

  it("G6: a signing failure mid-publish leaves no half-appended chain", async () => {
    // Reachable — GET /keys succeeds — but POST /sign is refused, so the
    // failure this case is about happens where the ADR says it must: at the
    // one call to /sign, not earlier at a connection that never opens
    // (that's G5's shape, not G6's).
    const handle = await unauthorizedSigner();
    try {
      const { instance, config } = testInstance(["writer"], CAPABILITY);
      const deps = { keyDir: config.keyDir, origin: config.origin, db: instance.db };
      const instanceActorUrl = instance.instanceDocument().id as string;
      const seqBefore = instance.outbox.byActor(instanceActorUrl).length;
      const headBefore = instance.outbox.headDigest(instanceActorUrl);

      await assert.rejects(
        () => rotateKeyWithRemoteRoot(deps, "@instance", { kind: "proof" }, instance.clock.now(), remoteConfig(handle)),
        /403|not authorized/,
      );

      const seqAfter = instance.outbox.byActor(instanceActorUrl).length;
      const headAfter = instance.outbox.headDigest(instanceActorUrl);
      assert.equal(seqAfter, seqBefore, "no afp:KeyDelegation (or anything else) was appended");
      assert.equal(headAfter, headBefore, "the chain head is byte-identical — nothing moved");
      instance.close();
    } finally {
      await handle.close();
    }
  });

  it("a blackholed signer times out rather than hanging rotation forever", async () => {
    // Accepts the TLS/mTLS handshake — same certs, same client-cert
    // requirement — but its handler never answers, which is the shape a
    // firewalled or wedged signer takes on the wire (unlike G5's refused
    // connection).
    const blackhole = createHttpsServer(
      { cert: certs.serverCert, key: certs.serverKey, ca: certs.caCert, requestCert: true, rejectUnauthorized: true },
      () => {
        /* never responds */
      },
    );
    await new Promise<void>((resolve, reject) => {
      blackhole.once("error", reject);
      blackhole.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      const address = blackhole.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const signer = remoteIssuedSigner({
        url: `https://127.0.0.1:${port}`,
        keyId: ROOT_KEY_ID,
        clientCertFile: certs.clientCertFile,
        clientKeyFile: certs.clientKeyFile,
        caFile: certs.caCertFile,
        timeoutMs: 150,
      });
      const started = Date.now();
      await assert.rejects(() => signer.sign(new TextEncoder().encode("hang")), /timed out/);
      assert.ok(Date.now() - started < 5_000, "the timeout fired instead of the default (or no) timeout");
    } finally {
      await new Promise<void>((resolve) => blackhole.close(() => resolve()));
    }
  });

  it("G7: two /sign calls with the same message are byte-identical (Ed25519 determinism)", async () => {
    const handle = await freshSigner();
    try {
      const signer = remoteIssuedSigner({
        url: handle.url,
        keyId: ROOT_KEY_ID,
        clientCertFile: certs.clientCertFile,
        clientKeyFile: certs.clientKeyFile,
        caFile: certs.caCertFile,
      });
      const message = new TextEncoder().encode("retry-safety");
      const first = await signer.sign(message);
      const second = await signer.sign(message);
      assert.deepEqual(first, second);

      const direct = nodeSign(null, message, rootPrivateKey);
      assert.deepEqual(Buffer.from(first), direct);
    } finally {
      await handle.close();
    }
  });

  it("G8: an ordinary bundle with no remote-issued custody replays exactly as before", async () => {
    const { instance, config } = testInstance(["writer"], CAPABILITY);
    instance.publish("writer", [], THREAD, "parties", (envelope) =>
      createResult(envelope, { resultId: `${config.origin}/results/g8`, correlationId: "leg-8", content: "ok" }),
    );
    const exported = exportBundle(instance, config.exportDir);
    const result = runVerifier(VERIFIER, exported.dir, THREAD, ["--verbose"]);
    assert.equal(result.code, 0, `verifier failed:\n${result.output}`);
    assert.doesNotMatch(result.output, /afp:KeyDelegation/);

    // Also referenced by this gate rather than re-run here: `npm run gate`
    // replays every shipped demo bundle (test/demos.test.ts), none of which
    // carry an afp:KeyDelegation — custody leaves no trace in a record that
    // never asked for it.
    instance.close();
  });

  it("config check: a policy declaring remote-issued custody must agree with AFP_ISSUED_KEY_LIFETIME_MS", async () => {
    const base = loadConfig(workspace());

    const agreeing = {
      ...base,
      issuedKeyLifetimeMs: LIFETIME_MS,
      policy: { ...base.policy, custody: { instance: "remote-issued" as const, keyLifetimeMs: LIFETIME_MS } },
    };
    const agreeingResult = await runConfigCheck(agreeing, { offline: true });
    const agreeingLine = agreeingResult.lines.find((l) => l.name === "custody");
    assert.ok(agreeingLine?.ok, `expected the custody line to pass: ${agreeingLine?.reason}`);

    const mismatched = {
      ...base,
      issuedKeyLifetimeMs: LIFETIME_MS,
      policy: { ...base.policy, custody: { instance: "remote-issued" as const, keyLifetimeMs: LIFETIME_MS * 2 } },
    };
    const mismatchedResult = await runConfigCheck(mismatched, { offline: true });
    const mismatchedLine = mismatchedResult.lines.find((l) => l.name === "custody");
    assert.equal(mismatchedLine?.ok, false);
    assert.match(mismatchedLine?.reason ?? "", /custody-lifetime-mismatch/);
    assert.match(mismatchedLine?.reason ?? "", new RegExp(String(LIFETIME_MS)));
    assert.match(mismatchedLine?.reason ?? "", new RegExp(String(LIFETIME_MS * 2)));

    // Ordinary file custody: no line at all, the same silence every other
    // custody mode gets today.
    const ordinary = { ...base, policy: { ...base.policy, custody: { instance: "file" as const } } };
    const ordinaryResult = await runConfigCheck(ordinary, { offline: true });
    assert.equal(ordinaryResult.lines.some((l) => l.name === "custody"), false);
  });

  it("the reference public key endpoint round-trips", async () => {
    const handle = await freshSigner();
    try {
      const result = await fetchRemoteSignerPublicKey({
        url: handle.url,
        keyId: ROOT_KEY_ID,
        clientCertFile: certs.clientCertFile,
        clientKeyFile: certs.clientKeyFile,
        caFile: certs.caCertFile,
      });
      const expected = encodeEd25519Multikey(rawPublicKey(createPublicKey(rootPrivateKey)));
      assert.equal(result.keyId, ROOT_KEY_ID);
      assert.equal(result.publicKeyMultibase, expected);
    } finally {
      await handle.close();
    }
  });
});
