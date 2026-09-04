/**
 * ADR-0026 gate: key custody and the signer port.
 *
 * Covers the decisions this pass builds — D1 (the port, `file` adapter), D3
 * (`afp:keyHistory` names every key that ever signed), D4 (an export never
 * carries private material). D2 (the rotate/revoke CLI), D5 (the two export
 * scopes) and D6 (the backup runbook) are not built here; see the ADR's
 * build status.
 *
 *   node --experimental-sqlite --test test/adr0026.test.ts
 */

import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as rawSign } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, describe, it } from "node:test";

import { loadConfig } from "../src/config.ts";
import { AfpInstance } from "../src/instance.ts";
import { CountingBrain } from "../src/brains/stub.ts";
import { attachProof, verifyProof } from "../src/crypto/proof.ts";
import { canonicalBytes } from "../src/crypto/jcs.ts";
import { multibaseDecode } from "../src/crypto/multibase.ts";
import { fileSigner, signerOver } from "../src/crypto/signer.ts";
import {
  allKeyHistories,
  loadOrCreateHubKeyPair,
  loadOrCreateKeyPair,
  publicKeyFromMultibase,
  rotateKeyPair,
} from "../src/crypto/keys.ts";
import { exportBundle, refusePrivateMaterial } from "../src/export.ts";
import { cleanupWorkspaces, runVerifier, testHub, testInstance, workspace } from "./helpers.ts";
import { VERIFIER } from "./adr0010-fixtures.ts";

after(cleanupWorkspaces);

// ---------------------------------------------------------------- Decision 1

describe("Decision 1 — the signer port", () => {
  it("G1: a proof signed through the port is byte-identical to one signed with the raw key", () => {
    // The compatibility proof, computed independently rather than by calling
    // the code under test twice: rebuild `eddsa-jcs-2022`'s signing input
    // here, sign it with the bare key, and require the port's proofValue to
    // match. If the port changed the algorithm, every existing bundle would
    // stop verifying — this is what says it did not.
    const { privateKey } = generateKeyPairSync("ed25519");
    const keyId = "https://alpha.example/actor#ed25519-key";
    const doc = { "@context": "https://www.w3.org/ns/activitystreams", id: "urn:x", type: "Create" };
    const created = "2026-08-21T10:00:00.000Z";

    const signed = attachProof(doc, { signer: signerOver(keyId, privateKey), created });

    const proofConfig = {
      "@context": doc["@context"],
      type: "DataIntegrityProof",
      cryptosuite: "eddsa-jcs-2022",
      created,
      verificationMethod: keyId,
      proofPurpose: "assertionMethod",
    };
    const expectedInput = Buffer.concat([
      createHash("sha256").update(canonicalBytes(proofConfig)).digest(),
      createHash("sha256").update(canonicalBytes(doc)).digest(),
    ]);
    const expected = rawSign(null, expectedInput, privateKey);
    assert.deepEqual(Buffer.from(multibaseDecode(signed.proof.proofValue)), expected);

    // And it verifies against the signer's own published public half.
    const signer = signerOver(keyId, privateKey);
    assert.equal(verifyProof(signed, publicKeyFromMultibase(signer.publicKeyMultibase)).ok, true);
  });

  it("the proof's verificationMethod comes from the signer, so no caller can sign as one key and claim another", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const signed = attachProof({ id: "urn:y" }, { signer: signerOver("urn:key:real", privateKey) });
    assert.equal(signed.proof.verificationMethod, "urn:key:real");
  });

  it("a signer exposes no way to read the private half back out", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const signer = signerOver("urn:key:x", privateKey);
    assert.deepEqual(Object.keys(signer).sort(), ["custody", "keyId", "publicKeyMultibase", "sign"]);
    assert.equal(signer.custody, "file");
  });

  it("PEMs are written 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "afp-keys-"));
    loadOrCreateKeyPair(dir, "a", "https://alpha.example/agents/a");
    assert.equal(statSync(join(dir, "a.pem")).mode & 0o777, 0o600);
  });

  it("with AFP_KEY_PASSPHRASE_FILE set, PEMs are encrypted at rest and still load", () => {
    const dir = mkdtempSync(join(tmpdir(), "afp-keys-enc-"));
    const passFile = join(dir, "pass.txt");
    writeFileSync(passFile, "correct horse battery staple\n");
    const previous = process.env.AFP_KEY_PASSPHRASE_FILE;
    process.env.AFP_KEY_PASSPHRASE_FILE = passFile;
    try {
      const made = loadOrCreateKeyPair(dir, "enc", "https://alpha.example/agents/enc");
      const pem = readFileSync(join(dir, "enc.pem"), "utf8");
      assert.ok(pem.includes("ENCRYPTED PRIVATE KEY"), "the PEM on disk is encrypted");
      assert.ok(!pem.includes("BEGIN PRIVATE KEY"), "and not also present in the clear");

      // It round-trips: reloading decrypts, and the same public half comes back.
      const reloaded = loadOrCreateKeyPair(dir, "enc", "https://alpha.example/agents/enc");
      assert.equal(reloaded.publicKeyMultibase, made.publicKeyMultibase);
      const signed = attachProof({ id: "urn:z" }, { signer: fileSigner(reloaded) });
      assert.equal(verifyProof(signed, publicKeyFromMultibase(made.publicKeyMultibase)).ok, true);
    } finally {
      if (previous === undefined) delete process.env.AFP_KEY_PASSPHRASE_FILE;
      else process.env.AFP_KEY_PASSPHRASE_FILE = previous;
    }
  });
});

// ---------------------------------------------------------------- Decision 3

describe("Decision 3 — afp:keyHistory names every key that ever signed", () => {
  // What this proves and what it does not: the keys are now DECLARED with
  // their intervals, which is L1's recording half. It does not prove a
  // backdated cut on a hub-scoped key gets caught — no exported activity is
  // signed by one (under `instance` custody the instance key signs, including
  // for votes embedded in an afp:EquivocationProof), so the interval check is
  // armed rather than exercised. See ADR-0026's build status.
  it("G6: hub-scoped and transport keys are in the history — L1's recording half", () => {
    const { instance } = testInstance(["v1"], "afp:cap:vote");
    const { hub } = testHub(instance, ["v1"], "windward");
    assert.ok(hub.actorId);

    const entries = allKeyHistories(instance.config.keyDir, "v1", instance.actorId("v1"));
    const ids = entries.map((e) => e.keyId);
    assert.ok(
      ids.some((id) => id.endsWith("#ed25519-key")),
      "the proof key is still there",
    );
    assert.ok(
      ids.some((id) => id.endsWith("#hub-key-windward")),
      "the hub-scoped vote key is now there — the key that signs votes",
    );
    assert.ok(
      ids.some((id) => id.endsWith("#transport-key")),
      "and the transport key, so a boundary-log entry can be re-judged after a revocation",
    );
    assert.equal(new Set(ids).size, ids.length, "no two entries collide on one id");
    instance.close();
  });

  it("a rotated key of any kind gets a distinct id, so history entries never collide", () => {
    const dir = mkdtempSync(join(tmpdir(), "afp-rot-"));
    const controller = "https://alpha.example/agents/r";
    loadOrCreateHubKeyPair(dir, "r", controller, "windward");
    rotateKeyPair(dir, "r--hub-windward", controller, new Date("2026-08-21T10:00:00.000Z"));

    const ids = allKeyHistories(dir, "r", controller).map((e) => e.keyId);
    assert.ok(ids.includes(`${controller}#hub-key-windward`), "the retired hub key keeps its id");
    assert.ok(ids.includes(`${controller}#hub-key-windward-2`), "its successor is a distinct id");
    assert.equal(new Set(ids).size, ids.length);
  });

  it("the history's public halves are the ones that actually verify what those keys signed", () => {
    const { instance } = testInstance(["v2"], "afp:cap:vote");
    const entries = allKeyHistories(instance.config.keyDir, "v2", instance.actorId("v2"));
    const proofEntry = entries.find((e) => e.keyId.endsWith("#ed25519-key"))!;
    const signed = attachProof({ id: "urn:h" }, { signer: instance.signer("v2") });
    assert.equal(verifyProof(signed, publicKeyFromMultibase(proofEntry.publicKeyMultibase)).ok, true);
    instance.close();
  });
});

// ---------------------------------------------------------------- Decision 4

describe("Decision 4 — an export never carries private material", () => {
  it("G7: a bundle containing a planted PEM is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "afp-bundle-"));
    writeFileSync(join(dir, "innocent.jsonld"), JSON.stringify({ id: "urn:ok" }));
    refusePrivateMaterial(dir); // clean bundle: no complaint

    const { privateKey } = generateKeyPairSync("ed25519");
    writeFileSync(join(dir, "oops.pem"), privateKey.export({ type: "pkcs8", format: "pem" }) as string);
    assert.throws(() => refusePrivateMaterial(dir), /private key material/);
  });

  it("the passphrase itself is caught even when no PEM is present", () => {
    const dir = mkdtempSync(join(tmpdir(), "afp-bundle-pass-"));
    const passFile = join(dir, "..", `pass-${Date.now()}.txt`);
    writeFileSync(passFile, "hunter2-and-then-some\n");
    writeFileSync(join(dir, "note.jsonld"), JSON.stringify({ note: "hunter2-and-then-some" }));
    assert.throws(() => refusePrivateMaterial(dir, passFile), /passphrase/);
  });

  it("the manifest's own signature is verified by the independent verifier", () => {
    // Found while building D3: ADR-0012 Decision 1 made the manifest a signed
    // document so that "the export's self-description stops being the one
    // part of a bundle anybody could edit freely" — but the verifier only
    // checked WHICH key was named, never the signature. Every field the
    // manifest carries (afp:keyHistory above all, now that D3 widened it) was
    // editable at will. This pins the fix.
    const paths = workspace();
    const config = loadConfig(paths);
    const instance = new AfpInstance(config, [
      {
        spec: { name: "m1", capabilities: ["afp:cap:assess"], keyCustody: "instance", since: "2026-08-17T00:00:00Z" },
        brain: new CountingBrain("m1", ["afp:cap:assess"], () => ({ ok: true, content: "ok" })),
      },
    ]);
    try {
      exportBundle(instance, paths.exportDir);
      const clean = runVerifier(VERIFIER, paths.exportDir, "", ["--verbose"]);
      assert.equal(clean.code, 0, `a clean bundle verifies: ${clean.output}`);
      assert.match(clean.output, /keys: the manifest's signature verifies/, "the check actually ran");

      // Edit one field of the signed manifest, leaving the proof untouched —
      // the shape of every manifest forgery.
      const manifestPath = join(paths.exportDir, "MANIFEST.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.exportedAt = "1999-01-01T00:00:00.000Z";
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      const tampered = runVerifier(VERIFIER, paths.exportDir, "", ["--verbose"]);
      assert.notEqual(tampered.code, 0, "an edited manifest must not replay clean");
      assert.match(tampered.output, /FAIL.*manifest's signature verifies/s);
    } finally {
      instance.close();
    }
  });

  it("a real export passes the scan and still writes its bundle", () => {
    const paths = workspace();
    const config = loadConfig(paths);
    const instance = new AfpInstance(config, [
      {
        spec: { name: "e1", capabilities: ["afp:cap:assess"], keyCustody: "instance", since: "2026-08-17T00:00:00Z" },
        brain: new CountingBrain("e1", ["afp:cap:assess"], () => ({ ok: true, content: "ok" })),
      },
    ]);
    try {
      const summary = exportBundle(instance, paths.exportDir);
      assert.ok(summary.activities > 0);
      assert.ok(existsSync(join(paths.exportDir, "MANIFEST.json")));
      // The written bundle carries public halves only — the property the scan enforces.
      const manifest = readFileSync(join(paths.exportDir, "MANIFEST.json"), "utf8");
      assert.ok(!manifest.includes("PRIVATE KEY"));
    } finally {
      instance.close();
    }
  });
});
