/**
 * HTTP Signature covered-header discipline (ADR-0013 Decision 1).
 *
 * The read path needs a body-less signature, and the obvious way to get one —
 * letting the verifier honour whatever the incoming `Signature` header says it
 * covered — is a signature-stripping attack on the *write* path: a POST that
 * declares it covered no `digest` would verify with an unauthenticated body.
 *
 * So the covered set is derived from the request method, and this file is the
 * proof. It is deliberately a unit test rather than part of an ADR gate: the
 * property is about one function, and it should fail loudly the moment someone
 * "simplifies" that function, without a hub, an export or a verifier in the way.
 *
 *   node --experimental-sqlite --test test/httpsig.test.ts
 */

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";

import { coveredHeaders, signRequest, verifyRequest } from "../src/federation/httpSig.ts";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const KEY_ID = "https://alpha.example/actor#ed25519-key";
const resolveKey = (keyId: string) => (keyId === KEY_ID ? publicKey : null);
const NOW = new Date("2026-08-21T10:00:00.000Z");

describe("HTTP Signature: the covered set comes from the method, never from the signature", () => {
  it("a POST binds its body and a GET has none to bind", () => {
    assert.deepEqual(coveredHeaders("POST"), ["(request-target)", "host", "date", "digest"]);
    assert.deepEqual(coveredHeaders("GET"), ["(request-target)", "host", "date"]);
    // Case is not a way in.
    assert.deepEqual(coveredHeaders("post"), coveredHeaders("POST"));
  });

  it("round-trips both shapes", () => {
    const body = JSON.stringify({ type: "Create" });
    const post = signRequest("POST", "/actor/inbox", "alpha.example", body, KEY_ID, privateKey, NOW);
    assert.ok(post.digest, "a POST signature carries the digest it binds");
    assert.equal(
      verifyRequest("POST", "/actor/inbox", post, body, resolveKey, NOW).ok,
      true,
    );

    const get = signRequest("GET", "/agents/writer/outbox", "alpha.example", "", KEY_ID, privateKey, NOW);
    assert.equal(get.digest, undefined, "a GET signs no digest — there is no body to bind");
    assert.equal(
      verifyRequest("GET", "/agents/writer/outbox", get, "", resolveKey, NOW).ok,
      true,
    );
  });

  it("refuses a POST whose signature claims it covered no digest — the downgrade", () => {
    // The attack: sign the *GET-shaped* string (no digest), then present it on
    // a POST carrying an arbitrary body. If the verifier believed the
    // declaration, the signature would verify over a string that never
    // mentioned the body, and the body would be unauthenticated.
    const forged = signRequest("POST", "/actor/inbox", "alpha.example", "", KEY_ID, privateKey, NOW);
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

  it("refuses a POST with no digest header at all", () => {
    const body = JSON.stringify({ type: "Create" });
    const signed = signRequest("POST", "/actor/inbox", "alpha.example", body, KEY_ID, privateKey, NOW);
    const { digest: _dropped, ...withoutDigest } = signed;
    const result = verifyRequest("POST", "/actor/inbox", withoutDigest, body, resolveKey, NOW);
    assert.equal(result.ok, false);
    assert.match(result.reason, /digest header does not match the body/);
  });

  it("refuses a GET signature replayed onto a different path", () => {
    const get = signRequest("GET", "/agents/writer/outbox", "alpha.example", "", KEY_ID, privateKey, NOW);
    const result = verifyRequest("GET", "/agents/reviewer/outbox", get, "", resolveKey, NOW);
    assert.equal(result.ok, false);
    assert.match(result.reason, /signature does not verify/);
  });

  it("refuses a GET outside the skew window", () => {
    const get = signRequest("GET", "/actor", "alpha.example", "", KEY_ID, privateKey, NOW);
    const late = new Date(NOW.getTime() + 6 * 60 * 1000);
    const result = verifyRequest("GET", "/actor", get, "", resolveKey, late);
    assert.equal(result.ok, false);
    assert.match(result.reason, /skew window/);
  });

  it("a digest header on a GET is not a way to smuggle coverage", () => {
    // `digest` is not in a GET's covered set, so a supplied one is simply not
    // part of the signed string — it can neither help nor hurt, and must not
    // change the verdict.
    const get = signRequest("GET", "/actor", "alpha.example", "", KEY_ID, privateKey, NOW);
    const withDigest = { ...get, digest: "SHA-256=not-a-real-digest" };
    assert.equal(verifyRequest("GET", "/actor", withDigest, "", resolveKey, NOW).ok, true);
  });
});
