/**
 * HTTP signature covered-set discipline (ADR-0013 Decision 1) across both
 * schemes (ADR-0017 Decision 2: RFC 9421 native, draft-cavage shim).
 *
 * The read path needs a body-less signature, and the obvious way to get one —
 * letting the verifier honour whatever the incoming signature says it
 * covered — is a signature-stripping attack on the *write* path: a POST that
 * declares it covered no body digest would verify with an unauthenticated
 * body.
 *
 * So the covered set is derived from the request method — in the native
 * scheme and in the shim alike — and this file is the proof. It is
 * deliberately a unit test rather than part of an ADR gate: the property is
 * about one module, and it should fail loudly the moment someone "simplifies"
 * it, without a hub, an export or a verifier in the way.
 *
 *   node --experimental-sqlite --test test/httpsig.test.ts
 */

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";

import {
  coveredComponents,
  coveredHeaders,
  extractKeyId,
  signRequest,
  signRequestCavage,
  verifyRequest,
} from "../src/federation/httpSig.ts";
import { signerOver } from "../src/crypto/signer.ts";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const KEY_ID = "https://alpha.example/actor#ed25519-key";
const resolveKey = (keyId: string) => (keyId === KEY_ID ? publicKey : null);
const NOW = new Date("2026-08-21T10:00:00.000Z");

describe("HTTP Signature: the covered set comes from the method, never from the signature", () => {
  it("a POST binds its body and a GET has none to bind — both schemes", () => {
    assert.deepEqual(coveredComponents("POST"), ["@method", "@authority", "@path", "date", "content-digest"]);
    assert.deepEqual(coveredComponents("GET"), ["@method", "@authority", "@path", "date"]);
    assert.deepEqual(coveredHeaders("POST"), ["(request-target)", "host", "date", "digest"]);
    assert.deepEqual(coveredHeaders("GET"), ["(request-target)", "host", "date"]);
    // Case is not a way in.
    assert.deepEqual(coveredComponents("post"), coveredComponents("POST"));
  });

  it("round-trips both shapes natively (RFC 9421)", () => {
    const body = JSON.stringify({ type: "Create" });
    const post = signRequest("POST", "/actor/inbox", "alpha.example", body, signerOver(KEY_ID, privateKey), NOW);
    assert.ok(post["content-digest"], "a POST signature carries the Content-Digest it binds");
    assert.match(post["signature-input"], /^afp=\("@method" "@authority" "@path" "date" "content-digest"\);created=\d+/);
    assert.equal(extractKeyId(post), KEY_ID);
    assert.equal(verifyRequest("POST", "/actor/inbox", post, body, resolveKey, NOW).ok, true);

    const get = signRequest("GET", "/agents/writer/outbox", "alpha.example", "", signerOver(KEY_ID, privateKey), NOW);
    assert.equal(get["content-digest"], undefined, "a GET signs no digest — there is no body to bind");
    assert.equal(verifyRequest("GET", "/agents/writer/outbox", get, "", resolveKey, NOW).ok, true);
  });

  it("round-trips the cavage shim, and extractKeyId reads both schemes", () => {
    const body = JSON.stringify({ type: "Create" });
    const post = signRequestCavage("POST", "/actor/inbox", "alpha.example", body, signerOver(KEY_ID, privateKey), NOW);
    assert.ok(post.digest, "a shim POST carries the legacy Digest it binds");
    assert.equal(extractKeyId(post), KEY_ID);
    assert.equal(verifyRequest("POST", "/actor/inbox", post, body, resolveKey, NOW).ok, true);

    const get = signRequestCavage("GET", "/actor", "alpha.example", "", signerOver(KEY_ID, privateKey), NOW);
    assert.equal(verifyRequest("GET", "/actor", get, "", resolveKey, NOW).ok, true);
  });

  it("refuses a native POST whose signature claims it covered no content-digest — the downgrade", () => {
    // The attack: sign the *GET-shaped* base (no content-digest), then present
    // it on a POST carrying an arbitrary body. If the verifier believed the
    // declaration, the signature would verify over a base that never mentioned
    // the body, and the body would be unauthenticated.
    const forged = signRequest("GET", "/actor/inbox", "alpha.example", "", signerOver(KEY_ID, privateKey), NOW);
    const attackerBody = JSON.stringify({ type: "Delete", object: "everything" });
    const result = verifyRequest("POST", "/actor/inbox", forged, attackerBody, resolveKey, NOW);
    assert.equal(result.ok, false);
    assert.match(result.reason, /covers .* but a POST must cover/);
  });

  it("refuses a cavage POST that declares it covered no digest — same downgrade, shim scheme", () => {
    const forged = signRequestCavage("POST", "/actor/inbox", "alpha.example", "", signerOver(KEY_ID, privateKey), NOW);
    const stripped = {
      ...forged,
      signature: forged.signature.replace(
        'headers="(request-target) host date digest"',
        'headers="(request-target) host date"',
      ),
    };
    const attackerBody = JSON.stringify({ type: "Delete", object: "everything" });
    const result = verifyRequest("POST", "/actor/inbox", stripped, attackerBody, resolveKey, NOW);
    assert.equal(result.ok, false);
    assert.match(result.reason, /declares it covered .* but a POST must cover/);
  });

  it("refuses a native POST with no Content-Digest header at all", () => {
    const body = JSON.stringify({ type: "Create" });
    const signed = signRequest("POST", "/actor/inbox", "alpha.example", body, signerOver(KEY_ID, privateKey), NOW);
    const { "content-digest": _dropped, ...withoutDigest } = signed;
    const result = verifyRequest("POST", "/actor/inbox", withoutDigest, body, resolveKey, NOW);
    assert.equal(result.ok, false);
    assert.match(result.reason, /Content-Digest does not match the body/);
  });

  it("refuses a GET signature replayed onto a different path", () => {
    const get = signRequest("GET", "/agents/writer/outbox", "alpha.example", "", signerOver(KEY_ID, privateKey), NOW);
    const result = verifyRequest("GET", "/agents/reviewer/outbox", get, "", resolveKey, NOW);
    assert.equal(result.ok, false);
    assert.match(result.reason, /signature does not verify/);
  });

  it("refuses a GET outside the skew window — date and created both bound replay", () => {
    const get = signRequest("GET", "/actor", "alpha.example", "", signerOver(KEY_ID, privateKey), NOW);
    const late = new Date(NOW.getTime() + 6 * 60 * 1000);
    const result = verifyRequest("GET", "/actor", get, "", resolveKey, late);
    assert.equal(result.ok, false);
    assert.match(result.reason, /skew window/);

    // A fresh date header cannot rescue a stale created parameter: the
    // signature binds date, so re-dating breaks it — but created is checked
    // first and refuses by name.
    const redated = { ...get, date: late.toUTCString() };
    const redatedResult = verifyRequest("GET", "/actor", redated, "", resolveKey, late);
    assert.equal(redatedResult.ok, false);
    assert.match(redatedResult.reason, /created parameter absent or outside the skew window/);
  });

  it("a Content-Digest header on a GET is not a way to smuggle coverage", () => {
    // `content-digest` is not in a GET's covered set, so a supplied one is
    // simply not part of the signed base — it can neither help nor hurt, and
    // must not change the verdict.
    const get = signRequest("GET", "/actor", "alpha.example", "", signerOver(KEY_ID, privateKey), NOW);
    const withDigest = { ...get, "content-digest": "sha-256=:bm90LXJlYWw=:" };
    assert.equal(verifyRequest("GET", "/actor", withDigest, "", resolveKey, NOW).ok, true);
  });

  it("an expired signature is refused even inside the date skew", () => {
    const get = signRequest("GET", "/actor", "alpha.example", "", signerOver(KEY_ID, privateKey), NOW);
    const created = Math.floor(NOW.getTime() / 1000);
    const expired = {
      ...get,
      "signature-input": get["signature-input"].replace(`created=${created}`, `created=${created};expires=${created - 1}`),
    };
    const result = verifyRequest("GET", "/actor", expired, "", resolveKey, NOW);
    assert.equal(result.ok, false);
    // The tampered params no longer match the signed base, but expiry is
    // checked first and refuses by name.
    assert.match(result.reason, /expired/);
  });
});
