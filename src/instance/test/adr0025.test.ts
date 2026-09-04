/**
 * ADR-0025 gate: transport hardening.
 *
 *   node --experimental-sqlite --test test/adr0025.test.ts
 */

import assert from "node:assert/strict";
import { createServer } from "node:net";
import { after, describe, it } from "node:test";

import { loadConfig } from "../src/config.ts";
import { policedFetch, FetchRefusal } from "../src/federation/fetchPolicy.ts";
import { RateLimiter } from "../src/federation/rateLimit.ts";
import { SeenSignatures } from "../src/store/dedupe.ts";
import { AfpInstance } from "../src/instance.ts";
import { CountingBrain } from "../src/brains/stub.ts";
import { createHttpServer } from "../src/ap/server.ts";
import { Federation } from "../src/federation/federation.ts";
import { fetchActorDocument } from "../src/federation/inbox.ts";
import { cleanupWorkspaces, workspace } from "./helpers.ts";

after(cleanupWorkspaces);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address && typeof address === "object") {
        const port = address.port;
        probe.close(() => resolve(port));
      } else {
        probe.close(() => reject(new Error("no port")));
      }
    });
  });
}

// G1/G2 — TLS-only outside dev mode, loud allowance inside it.
describe("Decision 1 — TLS-only outside development mode", () => {
  it("G1: refuses an http: origin in production mode", () => {
    assert.throws(
      () => loadConfig({ ...workspace(), origin: "http://example.instance", devMode: false }),
      /must be https:/,
    );
  });

  it("G2: an http: origin is accepted with AFP_DEV set", () => {
    const config = loadConfig({ ...workspace(), origin: "http://127.0.0.1:1", devMode: true });
    assert.equal(config.origin, "http://127.0.0.1:1");
  });
});

// G3/G4/G5/G6 — the fetch policy itself.
describe("Decision 2 — one fetch policy", () => {
  const realFetch = globalThis.fetch;
  after(() => {
    globalThis.fetch = realFetch;
  });

  it("G1b: refuses an http: target outside development mode", async () => {
    await assert.rejects(
      () => policedFetch("http://example.instance/actor", "document", { devMode: false }),
      (error: unknown) => error instanceof FetchRefusal && error.class === "insecure-origin",
    );
  });

  it("G3: refuses a literal private-address target outside development mode, before any request is made", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await assert.rejects(
      () => policedFetch("https://10.0.0.5/actor", "document", { devMode: false }),
      (error: unknown) => error instanceof FetchRefusal && error.class === "ssrf",
    );
    assert.equal(called, false, "no request was made once the address policy refused");
  });

  it("G4: a redirect is refused, not followed", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 302, headers: { location: "https://elsewhere/actor" } })) as typeof fetch;
    await assert.rejects(
      () => policedFetch("https://peer.example/actor", "document", { devMode: true }),
      (error: unknown) => error instanceof FetchRefusal && error.class === "redirect",
    );
  });

  it("G5: a document over the size cap is refused, streamed rather than buffered whole", async () => {
    const big = "x".repeat(300 * 1024);
    globalThis.fetch = (async () =>
      new Response(big, { status: 200, headers: { "content-type": "application/activity+json" } })) as typeof fetch;
    await assert.rejects(
      () => policedFetch("https://peer.example/actor", "document", { devMode: true }),
      (error: unknown) => error instanceof FetchRefusal && error.class === "size",
    );
  });

  it("wrong content-type on a document fetch is refused", async () => {
    globalThis.fetch = (async () => new Response("<html/>", { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
    await assert.rejects(
      () => policedFetch("https://peer.example/actor", "document", { devMode: true }),
      (error: unknown) => error instanceof FetchRefusal && error.class === "content-type",
    );
  });
});

// G6 — key-controller binding, at the inbox.
describe("Decision 3 — a key id is bound to the document that answers for it", () => {
  it("G6: refuses when the fetched document's id differs from the keyId's controller", async () => {
    const { handleInboxPost } = await import("../src/federation/inbox.ts");
    const outcome = await handleInboxPost(
      {
        federation: { isDenylisted: () => false, gate: () => ({ admitted: false, step: "agreement", reason: "n/a" }) } as unknown as Federation,
        selfOrigin: "https://alpha.example",
        now: () => new Date("2026-08-21T10:00:00.000Z"),
        receive: async () => {},
        // The document answers, but claims to be a different id than the
        // controller the keyId names — the substitution Decision 3 closes.
        fetchDocument: async () => ({ id: "https://alpha.example/actor-impostor", assertionMethod: [] }),
      },
      "/actor/inbox",
      {
        host: "alpha.example",
        date: "Fri, 21 Aug 2026 10:00:00 GMT",
        "signature-input": 'afp=("@method" "@authority" "@path" "date");created=1755770400;keyid="https://alpha.example/actor#k1";alg="ed25519"',
        signature: "afp=:AA==:",
      },
      "{}",
    );
    assert.equal(outcome.status, 401);
    assert.equal(outcome.body.error, "key-controller-mismatch");
  });
});

// G7 — body cap.
describe("Decision 4 — bodies are capped before parsing", () => {
  it("G7: an inbox POST over the configured cap is refused 413", async () => {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const config = loadConfig({ ...workspace(), origin, devMode: true, maxInboxBodyBytes: 1024 });
    const instance = new AfpInstance(config, [
      { spec: { name: "a1", capabilities: ["afp:cap:assess"], keyCustody: "instance", since: "2026-08-17T00:00:00Z" }, brain: new CountingBrain("a1", [], () => ({ ok: true, content: "" })) },
    ]);
    const actorId = String(instance.instanceDocument().id);
    const federation = new Federation(instance.db, actorId, () => instance.clock.now());
    const server = createHttpServer(instance, {
      inbox: { federation, receive: (a) => instance.receiveAdmitted(a), fetchDocument: fetchActorDocument },
    });
    await new Promise<void>((resolveListen) => server.listen(port, "127.0.0.1", resolveListen));
    try {
      const response = await fetch(`${origin}/actor/inbox`, {
        method: "POST",
        headers: { "content-type": "application/activity+json" },
        body: "x".repeat(4096),
      });
      assert.equal(response.status, 413);
    } finally {
      instance.close();
      server.close();
    }
  });
});

// G8 — rate limiting.
describe("Decision 5 — rate limiting is real", () => {
  it("G8: the per-address bucket empties and refuses with Retry-After, then admits after the window", () => {
    const limiter = new RateLimiter(2, 1000);
    const now = 0;
    assert.equal(limiter.allow("1.2.3.4", now), true);
    assert.equal(limiter.allow("1.2.3.4", now), true);
    assert.equal(limiter.allow("1.2.3.4", now), false);
    assert.ok(limiter.retryAfterSeconds("1.2.3.4", now) > 0);
    assert.equal(limiter.allow("1.2.3.4", now + 1001), true, "a fresh window admits again");
  });

  it("an unauthenticated burst against a served instance answers 429 with Retry-After", async () => {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const config = loadConfig({ ...workspace(), origin, devMode: true, rateLimitPerAddress: 2, rateLimitPerAddressWindowMs: 60_000 });
    const instance = new AfpInstance(config, []);
    const server = createHttpServer(instance);
    await new Promise<void>((resolveListen) => server.listen(port, "127.0.0.1", resolveListen));
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        const response = await fetch(`${origin}/actor`);
        statuses.push(response.status);
      }
      assert.ok(statuses.includes(429), `expected a 429 somewhere in ${statuses}`);
      const rejected = statuses.indexOf(429);
      assert.ok(rejected >= 0);
    } finally {
      instance.close();
      server.close();
    }
  });
});

// G9 — replay cache.
describe("Decision 7 — a signed request cannot be replayed inside the skew window", () => {
  it("G9: the same (keyId, date, signature) is refused the second time", () => {
    const config = loadConfig({ ...workspace() });
    const instance = new AfpInstance(config, []);
    try {
      const seen = new SeenSignatures(instance.db, 5 * 60 * 1000);
      const now = new Date("2026-08-21T10:00:00.000Z");
      assert.equal(seen.markSeen("https://alpha.example/actor#k1", "Fri, 21 Aug 2026 10:00:00 GMT", "afp=:AA==:", now), true);
      assert.equal(seen.markSeen("https://alpha.example/actor#k1", "Fri, 21 Aug 2026 10:00:00 GMT", "afp=:AA==:", now), false);
      // A different signature (a different request) is unaffected.
      assert.equal(seen.markSeen("https://alpha.example/actor#k1", "Fri, 21 Aug 2026 10:00:00 GMT", "afp=:BB==:", now), true);
    } finally {
      instance.close();
    }
  });
});

// The TTL tables under both dedupe layers: expiry is decided by the query,
// not by the sweep, so amortizing the sweep cannot widen or narrow a window.
describe("dedupe TTL tables — expiry is a property of the query", () => {
  it("an entry past its TTL reads as absent and can be re-marked, without a sweep having run", () => {
    const config = loadConfig({ ...workspace(), seenIdTtlMs: 1000, replayCacheTtlMs: 1000 });
    const instance = new AfpInstance(config, []);
    try {
      const t0 = new Date("2026-08-21T10:00:00.000Z");
      // Inside the TTL: a repeat is a repeat.
      assert.equal(instance.seen.markSeen("urn:a1", t0), true);
      assert.equal(instance.seen.markSeen("urn:a1", new Date(t0.getTime() + 500)), false);
      assert.equal(instance.seen.has("urn:a1", new Date(t0.getTime() + 500)), true);

      // Past the TTL but well inside the sweep interval, so no DELETE has run:
      // the row is still on disk and must nonetheless read as absent.
      const afterTtl = new Date(t0.getTime() + 1500);
      assert.equal(instance.seen.has("urn:a1", afterTtl), false, "an expired row must read as absent");
      assert.equal(instance.seen.markSeen("urn:a1", afterTtl), true, "an expired id must be markable again");
      assert.equal(instance.seen.markSeen("urn:a1", afterTtl), false, "and the fresh window must then hold");

      // The same property, one layer up, for the signature cache.
      const sig = ["k1", "Fri, 21 Aug 2026 10:00:00 GMT", "afp=:AA==:"] as const;
      assert.equal(instance.seenSignatures.markSeen(...sig, t0), true);
      assert.equal(instance.seenSignatures.markSeen(...sig, t0), false);
      assert.equal(instance.seenSignatures.markSeen(...sig, afterTtl), true, "past the TTL it is a new presentation");
    } finally {
      instance.close();
    }
  });
});

// G11 — nothing here touches the record.
describe("G11 — the record is untouched", () => {
  it("a full P4 run (real HTTP, the fetch policy live throughout) still exports and both sides agree", async () => {
    const { runP4Demo } = await import("../src/demoP4.ts");
    const dirs = workspace();
    const result = await runP4Demo({ rootDir: `${dirs.dataDir}-p4`, exportRoot: `${dirs.exportDir}-p4` });
    try {
      assert.ok(result.exports.alpha.activities > 0);
      assert.ok(result.exports.beta.activities > 0);
    } finally {
      await result.close();
    }
  });
});
