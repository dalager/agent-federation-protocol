/**
 * Double-knocking (ADR-0017 Decision 2): the transport leads with RFC 9421,
 * retries a 401 once with the cavage shim, and caches the peer's preference
 * per origin so the next delivery knocks once. A non-auth failure is a failed
 * hop, not a negotiation.
 *
 *   node --experimental-sqlite --test test/transport.test.ts
 */

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, it } from "node:test";

import { httpTransport } from "../src/federation/transport.ts";

const { privateKey } = generateKeyPairSync("ed25519");
const NOW = new Date("2026-08-21T10:00:00.000Z");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function transport() {
  return httpTransport({
    keyId: "https://alpha.example/actor#ed25519-key",
    privateKey,
    now: () => NOW,
    isLocal: () => false,
    local: { name: "local", deliver: async () => {} },
  });
}

/**
 * Record each POST's scheme; answer per a scripted status list. GETs are the
 * actor-document dereference (ADR-0017 Decision 3) and answer with an actor
 * whose advertised inbox is `<id>/inbox`.
 */
function scriptedFetch(statuses: number[]) {
  const schemes: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: { method?: string; headers?: Record<string, string> }) => {
    if ((init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify({ id: String(url), inbox: `${String(url)}/inbox` }), { status: 200 });
    }
    schemes.push(init?.headers?.["signature-input"] ? "rfc9421" : "cavage");
    const status = statuses[Math.min(schemes.length - 1, statuses.length - 1)];
    return new Response(status < 300 ? "{}" : '{"error":"no"}', { status });
  }) as typeof fetch;
  return schemes;
}

describe("httpTransport double-knocking", () => {
  it("leads with RFC 9421 and delivers on first knock", async () => {
    const schemes = scriptedFetch([202]);
    await transport().deliver("https://peer.example/actor", { type: "Create" });
    assert.deepEqual(schemes, ["rfc9421"]);
  });

  it("falls back to cavage on 401 and caches the preference for the origin", async () => {
    const schemes = scriptedFetch([401, 202, 202]);
    const t = transport();
    await t.deliver("https://peer.example/actor", { type: "Create" });
    assert.deepEqual(schemes, ["rfc9421", "cavage"], "one retry, shim scheme");
    await t.deliver("https://peer.example/other", { type: "Update" });
    assert.deepEqual(schemes, ["rfc9421", "cavage", "cavage"], "second delivery knocks once, remembered");
  });

  it("a non-auth failure throws for the retry queue without a scheme retry", async () => {
    const schemes = scriptedFetch([503]);
    await assert.rejects(
      () => transport().deliver("https://peer.example/actor", { type: "Create" }),
      /refused: 503/,
    );
    assert.deepEqual(schemes, ["rfc9421"], "503 is a failed hop, not a negotiation");
  });

  it("both schemes refused is a failed hop with the second answer", async () => {
    const schemes = scriptedFetch([401, 401]);
    await assert.rejects(
      () => transport().deliver("https://peer.example/actor", { type: "Create" }),
      /refused: 401/,
    );
    assert.deepEqual(schemes, ["rfc9421", "cavage"]);
  });
});
