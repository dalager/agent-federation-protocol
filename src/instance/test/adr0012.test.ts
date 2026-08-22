/**
 * ADR-0012 acceptance gate: the long horizon.
 *
 * The record's promise is that a stranger holding no keys can replay it. That
 * promise quietly expired at the first key rotation, because a verifier
 * resolves keys from a *current* actor document and a rotated key is no longer
 * in it. Three flows here:
 *
 *  1. Rotation is survivable: an export written before a rotation and one
 *     written after it both verify, from the key history the manifest carries.
 *  2. The history and the inventory are checkable claims, not decoration —
 *     each named check fails on its own mutation.
 *  3. A bundle written before any of this existed still verifies unchanged.
 *     Constructed rather than found: the exported bundle directories are
 *     gitignored build artifacts, so the only honest way to test the
 *     compatibility path is to strip a fresh bundle back to the old shape and
 *     replay it.
 *
 *   node --experimental-sqlite --test test/adr0012.test.ts
 */

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, describe, it } from "node:test";

import { createResult } from "../src/ap/activities.ts";
import { keyHistory, loadOrCreateKeyPair, revokeKeyPair, rotateKeyPair } from "../src/crypto/keys.ts";
import { exportBundle } from "../src/export.ts";
import { cleanupWorkspaces, runVerifier, testInstance } from "./helpers.ts";
import { VERIFIER } from "./adr0010-fixtures.ts";

after(cleanupWorkspaces);

const CAPABILITY = "afp:cap:assess";
const THREAD = "https://alpha.operator.local/threads/horizon";

/** Read/patch/rewrite a copied bundle's manifest, then replay it. */
function withManifest(dir: string, edit: (m: Record<string, unknown>) => void) {
  const copy = mkdtempSync(join(tmpdir(), "afp-adr12-"));
  cpSync(dir, copy, { recursive: true });
  const path = join(copy, "MANIFEST.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  edit(manifest);
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return { dir: copy, result: runVerifier(VERIFIER, copy, THREAD, ["--verbose"]) };
}

describe("ADR-0012 gate: an export outlives the key that signed it", () => {
  it("a rotation strands nothing: bundles from before and after both verify", async () => {
    const { instance, config } = testInstance(["writer"], CAPABILITY);
    const writer = "writer";

    instance.publish(writer, [], THREAD, "parties", (envelope) =>
      createResult(envelope, { resultId: `${config.origin}/results/before`, correlationId: "leg-before", content: "signed by key one" }),
    );
    const before = mkdtempSync(join(tmpdir(), "afp-adr12-before-"));
    exportBundle(instance, before);
    assert.equal(runVerifier(VERIFIER, before, THREAD).code, 0);

    // The rotation itself. `at` is drawn from the instance's own clock rather
    // than wall time — the key store has none, and dating a rotation by when
    // the test process ran is the bug this ADR spent a paragraph on.
    const rotationInstant = instance.clock.now();
    const rotated = rotateKeyPair(config.keyDir, writer, instance.actorId(writer), rotationInstant);
    assert.match(rotated.keyId, /#ed25519-key-2$/, "a rotated key takes the next ordinal; the first keeps the bare id");
    assert.equal(rotated.validFrom, rotationInstant.toISOString());

    const after = mkdtempSync(join(tmpdir(), "afp-adr12-after-"));
    exportBundle(instance, after);
    const afterResult = runVerifier(VERIFIER, after, THREAD, ["--verbose"]);
    assert.equal(afterResult.code, 0, `post-rotation export failed:\n${afterResult.output}`);

    // The whole point: the pre-rotation activity still resolves, and it
    // resolves through the history rather than the current document.
    assert.match(afterResult.output, /keys: .*signed by a key valid at its published instant/);
    assert.match(afterResult.output, /keys: the manifest's proof resolves to a key its own history declares valid/);
    const history = JSON.parse(readFileSync(join(after, "MANIFEST.json"), "utf8"))["afp:keyHistory"] as Record<string, unknown>[];
    const retired = history.find((e) => e["afp:retiredBy"] === "rotation");
    assert.ok(retired, "the superseded key stays in the history rather than vanishing");
    assert.equal(retired["afp:validUntil"], rotationInstant.toISOString());

    rmSync(before, { recursive: true, force: true });
    rmSync(after, { recursive: true, force: true });
    instance.close();
  });

  it("the history and the inventory are claims the record checks", async () => {
    const { instance, config } = testInstance(["writer"], CAPABILITY);
    instance.publish("writer", [], THREAD, "parties", (envelope) =>
      createResult(envelope, { resultId: `${config.origin}/results/claims`, correlationId: "leg-claims", content: "one" }),
    );
    const exported = exportBundle(instance, config.exportDir);
    assert.equal(runVerifier(VERIFIER, exported.dir, THREAD).code, 0);

    // 1 — an interval that no longer covers what the key signed. The forger's
    // move is to narrow a window, not to widen it: narrowing is how you
    // disown a signature you would rather not answer for.
    const forgedInterval = withManifest(exported.dir, (m) => {
      const history = m["afp:keyHistory"] as Record<string, unknown>[];
      for (const entry of history) entry["afp:validFrom"] = "2099-01-01T00:00:00Z";
    });
    assert.notEqual(forgedInterval.result.code, 0);
    assert.match(forgedInterval.result.output, /FAIL \] keys: .*signed by a key valid at its published instant/);

    // 2 — a file in the bundle that the manifest does not admit to carrying.
    const undeclared = mkdtempSync(join(tmpdir(), "afp-adr12-extra-"));
    cpSync(exported.dir, undeclared, { recursive: true });
    writeFileSync(join(undeclared, "outbox", "smuggled.jsonld"), JSON.stringify({ orderedItems: [] }));
    const undeclaredResult = runVerifier(VERIFIER, undeclared, THREAD, ["--verbose"]);
    assert.notEqual(undeclaredResult.code, 0);
    assert.match(undeclaredResult.output, /FAIL \] bundle: every file present is declared in afp:members/);

    // 3 — a member the manifest declares and the bundle does not have.
    const missingMember = withManifest(exported.dir, (m) => {
      (m["afp:members"] as string[]).push("outbox/never-existed.jsonld");
    });
    assert.notEqual(missingMember.result.code, 0);
    assert.match(missingMember.result.output, /FAIL \] bundle: every declared member is present/);

    // 4 — a declared retention duty with nothing backing it. The duty is
    // opt-in, and declaring it is what turns the obligation on.
    const dutyNoAnchor = withManifest(exported.dir, (m) => {
      m["afp:retentionDuty"] = { "afp:horizon": "P5Y", "afp:basis": "EU AI Act Art. 12" };
    });
    assert.notEqual(dutyNoAnchor.result.code, 0);
    assert.match(dutyNoAnchor.result.output, /FAIL \] retention: the declared duty is backed by an anchor/);

    // 5 — an anchor naming a digest that is not a chain head. An anchor that
    // pins nothing in the bundle pins nothing at all.
    const bogusAnchor = withManifest(exported.dir, (m) => {
      m["afp:retentionDuty"] = { "afp:horizon": "P5Y", "afp:basis": "EU AI Act Art. 12" };
      m["afp:anchors"] = [{
        "afp:actor": instance.actorId("writer"),
        "afp:head": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        "afp:instant": instance.clock.now().toISOString(),
        "afp:anchorRef": "https://timestamps.example/tx/1",
      }];
    });
    assert.notEqual(bogusAnchor.result.code, 0);
    assert.match(bogusAnchor.result.output, /FAIL \] retention: every anchor names a chain head this bundle contains/);

    rmSync(undeclared, { recursive: true, force: true });
    instance.close();
  });

  it("a bundle written before any of this existed still verifies, unchanged", async () => {
    const { instance, config } = testInstance(["writer"], CAPABILITY);
    instance.publish("writer", [], THREAD, "parties", (envelope) =>
      createResult(envelope, { resultId: `${config.origin}/results/legacy`, correlationId: "leg-legacy", content: "old world" }),
    );
    const exported = exportBundle(instance, config.exportDir);

    // Strip the bundle back to its pre-ADR-0012 shape. This has to be
    // constructed rather than found: `export*/` is gitignored build output, so
    // there is no committed old corpus to point at — and a compatibility claim
    // tested against a bundle the current code just wrote would be testing
    // nothing at all.
    const legacy = withManifest(exported.dir, (m) => {
      delete m["afp:keyHistory"];
      delete m["afp:members"];
      delete m.proof;
      delete m["@context"];
    });
    assert.equal(
      legacy.result.code,
      0,
      `a pre-ADR-0012 bundle must verify unchanged — this ADR exists to stop old exports failing:\n${legacy.result.output}`,
    );
    // And it must verify *without* silently running the new checks against
    // absent data: no history means no interval claims to check.
    assert.doesNotMatch(legacy.result.output, /keys: .*signed by a key valid at its published instant/);
    assert.doesNotMatch(legacy.result.output, /bundle: every file present is declared in afp:members/);

    instance.close();
  });

  it("a revocation survives its own recovery path — the record is never reborn", async () => {
    // Found by review: `loadOrCreateKeyPair` claimed in a comment to refuse
    // when history exists with no active key, and never checked. The failure
    // was not an edge case — `rotateKeyPair` *called* loadOrCreate first, so
    // the documented recovery after a compromise (rotate to mint a successor)
    // was exactly what overwrote the revoked PEM and replaced its history
    // entry with a bare one: a revoked key reborn as a fresh unbounded key
    // under the same keyId, the compromise cut erased. Erasure in the key
    // store, in the one flow an operator under incident pressure follows.
    const { instance, config } = testInstance(["writer"], CAPABILITY);
    const writer = instance.actorId("writer");
    const original = instance.key("writer");
    const compromisedAt = new Date("2026-08-20T12:00:00.000Z");
    revokeKeyPair(config.keyDir, "writer", compromisedAt);

    // The destructive path refuses instead of minting.
    assert.throws(
      () => loadOrCreateKeyPair(config.keyDir, "writer", writer),
      /retired.*revocation.*rotateKeyPair/s,
    );

    // The sanctioned path appends — and touches nothing behind it.
    const successor = rotateKeyPair(config.keyDir, "writer", writer, new Date("2026-08-20T12:05:00.000Z"));
    assert.match(successor.keyId, /#ed25519-key-2$/);
    const history = keyHistory(config.keyDir, "writer", writer);
    assert.equal(history.length, 2);
    assert.equal(history[0].retiredBy, "revocation", "the compromise cut survives the rotation");
    assert.equal(history[0].validUntil, compromisedAt.toISOString(), "at the instant the revocation wrote");
    assert.equal(
      history[0].publicKeyMultibase,
      original.publicKeyMultibase,
      "the retired PEM is the original key, not a rebirth under its id",
    );
    instance.close();
  });
});
