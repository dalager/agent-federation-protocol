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
import { agentActorId } from "../src/ap/documents.ts";
import { CountingBrain } from "../src/brains/stub.ts";
import { attachProof, verifyProof } from "../src/crypto/proof.ts";
import { canonicalBytes } from "../src/crypto/jcs.ts";
import { encodeEd25519Multikey, multibaseDecode, multibaseEncode } from "../src/crypto/multibase.ts";
import { agentSigner, fileSigner, signerOver } from "../src/crypto/signer.ts";
import {
  allKeyHistories,
  loadOrCreateHubKeyPair,
  loadOrCreateKeyPair,
  publicKeyFromMultibase,
  rawPublicKey,
  rotateKeyPair,
} from "../src/crypto/keys.ts";
import { exportBundle, refusePrivateMaterial } from "../src/export.ts";
import { agreementObject } from "../src/federation/federation.ts";
import { admittingGrant, summarize } from "../src/federation/grants.ts";
import { digestOf } from "../src/crypto/proof.ts";
import { cleanupWorkspaces, publishRaw, runVerifier, testHub, testInstance, workspace } from "./helpers.ts";
import { RevocationRefused, revokeKey, rotateKey, votesEmbeddedInProofs } from "../src/instance/keyOps.ts";
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

describe("Decision 1 — the `agent` adapter: self custody that is actually self custody", () => {
  /** A keypair the instance never sees the private half of. */
  function outOfProcessAgent(actorId: string) {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const multibase = encodeEd25519Multikey(rawPublicKey(publicKey));
    let signatures = 0;
    return {
      publicKeyMultibase: multibase,
      get signatures() {
        return signatures;
      },
      signer: agentSigner(`${actorId}#ed25519-key`, multibase, (bytes) => {
        signatures++;
        return new Uint8Array(rawSign(null, bytes, privateKey));
      }),
    };
  }

  it("G3: the instance mints no key for an agent-custody agent, and its record replays clean", () => {
    const paths = workspace();
    const config = loadConfig(paths);
    const actorId = agentActorId(config.origin, "solo");
    const agent = outOfProcessAgent(actorId);
    const instance = new AfpInstance(config, [
      {
        spec: { name: "solo", capabilities: ["afp:cap:assess"], keyCustody: "self", since: "2026-08-17T00:00:00Z" },
        brain: new CountingBrain("solo", ["afp:cap:assess"], () => ({ ok: true, content: "ok" })),
        signer: agent.signer,
      },
    ]);
    try {
      // The property the whole adapter exists for: no private key on disk.
      assert.equal(existsSync(join(config.keyDir, "solo.pem")), false,
        "the instance holds no private key for a self-custody agent");

      instance.publish("solo", [], `${config.origin}/threads/solo`, "public", (envelope) => ({
        "@context": ["https://www.w3.org/ns/activitystreams"],
        id: envelope.activityId,
        type: "Create",
        actor: envelope.actor,
        to: [...envelope.to],
        published: envelope.published,
        context: envelope.thread,
        "afp:visibility": envelope.visibility,
        ...(envelope.prevActivity !== null ? { "afp:prevActivity": envelope.prevActivity } : {}),
        object: { type: "Note", content: "a note" },
      }) as never);
      assert.ok(agent.signatures > 0, "the agent's own signer produced the signature");

      const entry = instance.outbox.byActor(actorId).at(-1)!;
      // Self custody signs as itself — no afp:actingAs indirection.
      assert.equal(entry.activity["afp:actingAs"], undefined);
      assert.equal(
        (entry.activity.proof as { verificationMethod: string }).verificationMethod,
        `${actorId}#ed25519-key`,
      );
      assert.equal(
        verifyProof(entry.activity, publicKeyFromMultibase(agent.publicKeyMultibase)).ok,
        true,
        "and it verifies against the key the agent published",
      );

      // The actor document publishes the agent's public half, from a signer
      // whose private half this process never held.
      const doc = instance.agentDocument("solo") as { assertionMethod: { publicKeyMultibase: string }[] };
      assert.equal(doc.assertionMethod[0].publicKeyMultibase, agent.publicKeyMultibase);

      // G9 / P1 gate check 11: replay is clean and the record carries no
      // trace of how the signing was wired.
      exportBundle(instance, paths.exportDir);
      const result = runVerifier(VERIFIER, paths.exportDir, `${config.origin}/threads/solo`, ["--verbose"]);
      assert.equal(result.code, 0, `an agent-custody record replays clean: ${result.output}`);
      const bundle = readFileSync(join(paths.exportDir, "outbox", "solo.jsonld"), "utf8");
      for (const leak of ["agentSigner", "custody", "keyDir", "fileSigner"]) {
        assert.ok(!bundle.includes(leak), `the record leaks no wiring (${leak})`);
      }
    } finally {
      instance.close();
    }
  });

  it("the transport key stays instance-held even under agent custody, and says so", () => {
    // The HTTP hop is the instance's delivery on the agent's behalf, not the
    // agent's own act — and the key entry publishes that custody so an
    // auditor can see it (Decision 1's informational `afp:custody`).
    const paths = workspace();
    const config = loadConfig(paths);
    const agent = outOfProcessAgent(agentActorId(config.origin, "solo2"));
    const instance = new AfpInstance(config, [
      {
        spec: { name: "solo2", capabilities: ["afp:cap:assess"], keyCustody: "self", since: "2026-08-17T00:00:00Z" },
        brain: new CountingBrain("solo2", ["afp:cap:assess"], () => ({ ok: true, content: "ok" })),
        signer: agent.signer,
      },
    ]);
    try {
      const doc = instance.agentDocument("solo2") as {
        assertionMethod: { "afp:custody"?: string }[];
        authentication: { id: string; "afp:custody"?: string }[];
      };
      assert.equal(doc.authentication[0]["afp:custody"], "file", "the hop key's custody is published");
      assert.ok(doc.authentication[0].id.endsWith("#transport-key"));
      assert.equal(doc.assertionMethod[0]["afp:custody"], undefined,
        "the proof key's custody is the roster's afp:keyCustody, not a duplicate here");
      assert.equal(
        (instance.rosterDocument().orderedItems as { agent: string; "afp:keyCustody": string }[])
          .find((e) => e.agent.endsWith("/solo2"))?.["afp:keyCustody"],
        "self",
        "and the roster is where the proof key's custody is stated",
      );
    } finally {
      instance.close();
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

// ---------------------------------------------------------------- Decision 2

describe("Decision 2 — rotation and revocation as an operator surface", () => {
  function deps(instance: AfpInstance) {
    return { keyDir: instance.config.keyDir, origin: instance.config.origin, db: instance.db };
  }

  it("G4: after a rotation, both the old and the new signatures verify", () => {
    const { instance } = testInstance(["r1"], "afp:cap:assess");
    try {
      const before = instance.signer("r1");
      const signedBefore = attachProof({ id: "urn:before" }, { signer: before });

      const successor = rotateKey(deps(instance), "r1", { kind: "proof" }, new Date("2026-08-21T10:00:00.000Z"));
      assert.equal(successor.keyId, `${instance.actorId("r1")}#ed25519-key-2`);

      const signedAfter = attachProof({ id: "urn:after" }, { signer: fileSigner(successor) });

      // The retired key keeps its interval, so what it signed still verifies.
      const history = allKeyHistories(instance.config.keyDir, "r1", instance.actorId("r1"));
      const oldEntry = history.find((e) => e.keyId.endsWith("#ed25519-key"))!;
      const newEntry = history.find((e) => e.keyId.endsWith("#ed25519-key-2"))!;
      assert.equal(verifyProof(signedBefore, publicKeyFromMultibase(oldEntry.publicKeyMultibase)).ok, true);
      assert.equal(verifyProof(signedAfter, publicKeyFromMultibase(newEntry.publicKeyMultibase)).ok, true);
      assert.equal(oldEntry.retiredBy, "rotation");
      assert.equal(oldEntry.validUntil, "2026-08-21T10:00:00.000Z");
    } finally {
      instance.close();
    }
  });

  it("G5: a revocation cut earlier than a vote an on-record proof embeds is refused, by name", () => {
    const { instance } = testInstance(["v3"], "afp:cap:vote");
    try {
      const keyId = `${instance.actorId("v3")}#ed25519-key`;
      // An afp:EquivocationProof on the record, embedding a vote this key
      // signed at a known instant — the evidence ADR-0021 D4d protects.
      const vote = attachProof(
        { id: "urn:vote:1", type: "afp:Vote", published: "2026-08-21T12:00:00.000Z" },
        { signer: instance.signer("v3"), created: "2026-08-21T12:00:00.000Z" },
      );
      publishRaw(instance, "v3", [], `${instance.config.origin}/threads/x`, "public", {
        type: "Announce",
        object: {
          id: "urn:proof:1",
          type: "afp:EquivocationProof",
          "afp:votes": [vote, { ...vote, id: "urn:vote:2" }],
        },
      });

      const found = votesEmbeddedInProofs(deps(instance));
      assert.ok(found.some((v) => v.verificationMethod === keyId), "the embedded vote is discoverable");

      // A cut BEFORE the embedded vote would retroactively unsign convicting
      // evidence — refused.
      assert.throws(
        () => revokeKey(deps(instance), "v3", { kind: "proof" }, keyId, new Date("2026-08-20T00:00:00.000Z")),
        (error: unknown) =>
          error instanceof RevocationRefused && /2026-08-21T12:00:00.000Z/.test((error as Error).message),
      );

      // A cut AFTER it is an ordinary revocation and proceeds.
      revokeKey(deps(instance), "v3", { kind: "proof" }, keyId, new Date("2026-08-22T00:00:00.000Z"));
      const entry = allKeyHistories(instance.config.keyDir, "v3", instance.actorId("v3"))
        .find((e) => e.keyId === keyId)!;
      assert.equal(entry.retiredBy, "revocation");
      assert.equal(entry.validUntil, "2026-08-22T00:00:00.000Z");
    } finally {
      instance.close();
    }
  });

  it("key operations do not need a bootable instance — the revoked-with-no-successor dead end", () => {
    // Revocation mints no successor (ADR-0012 D2), which leaves the store
    // with no active key; the loader refuses that by design. If a key command
    // required a full instance it could not run at exactly the moment the
    // operator needs `rotate` — so it does not.
    const { instance, config } = testInstance(["d1"], "afp:cap:assess");
    const keyDir = config.keyDir;
    const origin = config.origin;
    const actorId = instance.actorId("d1");
    const db = instance.db;
    revokeKey({ keyDir, origin, db }, "d1", { kind: "proof" }, `${actorId}#ed25519-key`, new Date("2026-08-22T00:00:00.000Z"));

    assert.throws(() => loadOrCreateKeyPair(keyDir, "d1", actorId), /no active key/);
    const successor = rotateKey({ keyDir, origin, db }, "d1", { kind: "proof" }, new Date("2026-08-23T00:00:00.000Z"));
    assert.equal(successor.keyId, `${actorId}#ed25519-key-2`, "rotate is still the way out");
    instance.close();
  });
});

// ---------------------------------------------------------------- Decision 5

describe("Decision 5 — export scopes: visibility floor and agreement grant", () => {
  /** An instance with one `parties` thread and one `public` one. */
  function twoClasses() {
    const paths = workspace();
    const config = loadConfig(paths);
    const instance = new AfpInstance(config, [
      {
        spec: { name: "s1", capabilities: ["afp:cap:assess"], keyCustody: "instance", since: "2026-08-17T00:00:00Z" },
        brain: new CountingBrain("s1", ["afp:cap:assess"], () => ({ ok: true, content: "ok" })),
      },
    ]);
    // The Vouch trail the roster derives from is already `public`; add one
    // `parties` activity so the floor has something to withhold.
    instance.delegate({
      from: "s1", to: "s1", capability: "afp:cap:assess",
      content: "private matter", thread: `${config.origin}/threads/closed`, correlationId: "c-1",
    });
    return { instance, config, paths };
  }

  it("G8a: a visibility-floor scope stubs everything below the floor, 1:1", () => {
    const { instance, paths } = twoClasses();
    try {
      exportBundle(instance, paths.exportDir, [], { visibilityAtLeast: "public" });
      const manifest = JSON.parse(readFileSync(join(paths.exportDir, "MANIFEST.json"), "utf8"));
      assert.equal(manifest["afp:exportScope"]["afp:visibilityAtLeast"], "public",
        "the manifest declares the floor it was produced under");

      const outbox = JSON.parse(readFileSync(join(paths.exportDir, "outbox", "s1.jsonld"), "utf8"));
      const stubs = outbox.orderedItems.filter((i: { type: string }) => i.type === "afp:Redacted");
      const shown = outbox.orderedItems.filter((i: { type: string }) => i.type !== "afp:Redacted");
      assert.ok(stubs.length > 0, "the `parties` activity is withheld");
      assert.ok(
        shown.every((i: Record<string, string>) => i["afp:visibility"] === "public"),
        "nothing below the floor is disclosed",
      );
      // 1:1 in chain position — the stub mechanism must not hide scale.
      assert.equal(outbox.orderedItems.length, outbox.totalItems);

      const clean = runVerifier(VERIFIER, paths.exportDir, "", ["--verbose"]);
      assert.equal(clean.code, 0, `a floor-scoped bundle replays clean: ${clean.output}`);
      assert.match(clean.output, /scope: every disclosed activity is at or above the declared/);
    } finally {
      instance.close();
    }
  });

  it("G8b: a bundle disclosing below its declared floor is caught by the verifier", () => {
    const { instance, paths } = twoClasses();
    try {
      // Export everything, then claim a floor the bundle does not honour —
      // the over-disclosure a scoped bundle must not get away with.
      exportBundle(instance, paths.exportDir);
      const manifestPath = join(paths.exportDir, "MANIFEST.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest["afp:exportScope"] = { "afp:visibilityAtLeast": "public", "afp:omittedActors": [] };
      delete manifest.proof;
      writeFileSync(manifestPath, JSON.stringify(attachProof(manifest, { signer: instance.signer("@instance") }), null, 2));

      const result = runVerifier(VERIFIER, paths.exportDir, "", ["--verbose"]);
      assert.notEqual(result.code, 0, "a bundle that discloses below its declared floor must fail");
      assert.match(result.output, /FAIL.*at or above the declared 'public' floor/s);
    } finally {
      instance.close();
    }
  });

  it("G8c: an agreement-grant scope discloses exactly what those grants admit", () => {
    const { instance, paths, config } = twoClasses();
    try {
      // A grant admitting delegation on afp:cap:assess — the same shape the
      // boundary gate matches, so what a peer may read back is what it could
      // have been sent.
      const agreement = agreementObject({
        parties: [String(instance.instanceDocument().id), "https://beta.example/actor"],
        grants: [{ "afp:grantType": "direct-delegation", "afp:capabilities": ["afp:cap:assess"] }],
        expires: "2027-01-01T00:00:00.000Z",
      });
      exportBundle(instance, paths.exportDir, [], { agreement });

      const manifest = JSON.parse(readFileSync(join(paths.exportDir, "MANIFEST.json"), "utf8"));
      assert.equal(manifest["afp:exportScope"]["afp:agreement"], digestOf(agreement),
        "the manifest names the agreement by digest");

      const outbox = JSON.parse(readFileSync(join(paths.exportDir, "outbox", "s1.jsonld"), "utf8"));
      const shown = outbox.orderedItems.filter((i: { type: string }) => i.type !== "afp:Redacted");
      assert.ok(shown.length > 0, "the delegation the grant admits is disclosed");
      assert.ok(
        shown.every((i: Record<string, unknown>) => admittingGrant(agreement, summarize(i as never)) !== null),
        "every disclosed activity is one the grant admits",
      );
      assert.equal(config.origin.length > 0, true);
    } finally {
      instance.close();
    }
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

  it("a base58 signature that merely looks like a private Multikey is not a false positive", () => {
    // Found as an intermittent gate failure: the first cut matched the text
    // `z3we` anywhere in a file, and every proofValue is `z` + base58btc of a
    // 64-byte signature, so roughly one bundle in 200k proofs was refused for
    // carrying a legitimate signature. Custody is decided by DECODING now.
    const dir = mkdtempSync(join(tmpdir(), "afp-bundle-fp-"));
    const decoy = `z3we${"1".repeat(80)}`; // long, base58-shaped, decodes to the wrong length
    writeFileSync(join(dir, "outbox.jsonld"), JSON.stringify({ proof: { proofValue: decoy } }));
    refusePrivateMaterial(dir); // must not throw

    // The real thing — an Ed25519 private Multikey (0x80 0x26 || 32 bytes) — is caught.
    const { privateKey } = generateKeyPairSync("ed25519");
    const raw = (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).subarray(-32);
    const privateMultikey = multibaseEncode(Buffer.concat([Buffer.from([0x80, 0x26]), raw]));
    writeFileSync(join(dir, "leak.jsonld"), JSON.stringify({ key: privateMultikey }));
    assert.throws(() => refusePrivateMaterial(dir), /private Multikey/);
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
