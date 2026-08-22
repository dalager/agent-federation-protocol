/**
 * ADR-0017 Decision 4: WebFinger (RFC 7033).
 *
 *   node --experimental-sqlite --test test/adr0017-d4-webfinger.test.ts
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createServer as createProbe } from "node:net";

import { AfpInstance, type AgentRegistration } from "../src/instance.ts";
import { loadConfig } from "../src/config.ts";
import { createHttpServer } from "../src/ap/server.ts";
import { jumpClock } from "../src/demoP3.ts";
import { cleanupWorkspaces, workspace } from "./helpers.ts";

/** Grab a free localhost port (origin must be known before the instance exists). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createProbe();
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

after(cleanupWorkspaces);

async function serve() {
  const clock = jumpClock("2026-08-21T15:00:00.000Z");
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const config = loadConfig({ ...workspace(), origin });
  const registrations: AgentRegistration[] = [
    {
      spec: { name: "d4", capabilities: ["afp:cap:assess"], keyCustody: "instance", since: "2026-08-17T00:00:00Z" },
      brain: { name: "d4", capabilities: ["afp:cap:assess"], handle: async () => ({ ok: true, content: "ok" }) },
    },
  ];
  const instance = new AfpInstance(config, registrations, clock);
  const hub = { hubId: "bridge", actorDocument: () => ({ id: `${origin}/hubs/bridge`, type: "Application" }) };
  const server = createHttpServer(instance, { hubs: [hub] });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { origin, instance, server };
}

describe("ADR-0017 Decision 4: WebFinger", () => {
  it("400 on missing resource", async () => {
    const { origin, server } = await serve();
    try {
      const res = await fetch(`${origin}/.well-known/webfinger`);
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, "malformed resource");
    } finally {
      server.close();
    }
  });

  it("404 on unknown acct", async () => {
    const { origin, server } = await serve();
    try {
      const host = new URL(origin).host;
      const res = await fetch(`${origin}/.well-known/webfinger?resource=${encodeURIComponent(`acct:nobody@${host}`)}`);
      assert.equal(res.status, 404);
    } finally {
      server.close();
    }
  });

  it("404 on acct with the wrong host", async () => {
    const { origin, server } = await serve();
    try {
      const res = await fetch(`${origin}/.well-known/webfinger?resource=${encodeURIComponent("acct:instance@example.com")}`);
      assert.equal(res.status, 404);
    } finally {
      server.close();
    }
  });

  it("200 JRD for the instance actor over acct:", async () => {
    const { origin, instance, server } = await serve();
    try {
      const host = new URL(origin).host;
      const resource = `acct:instance@${host}`;
      const res = await fetch(`${origin}/.well-known/webfinger?resource=${encodeURIComponent(resource)}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "application/jrd+json");
      assert.equal(res.headers.get("access-control-allow-origin"), "*");
      const jrd = (await res.json()) as { subject: string; aliases: string[]; links: { rel: string; type: string; href: string }[] };
      const actorId = `${origin}/actor`;
      assert.equal(jrd.subject, resource);
      assert.deepEqual(jrd.aliases, [actorId]);
      assert.deepEqual(jrd.links, [{ rel: "self", type: "application/activity+json", href: actorId }]);
      const doc = instance.instanceDocument() as { preferredUsername: string };
      assert.equal(doc.preferredUsername, "instance", "actor doc preferredUsername matches the JRD subject's user part");
    } finally {
      server.close();
    }
  });

  it("200 JRD for an agent over acct:", async () => {
    const { origin, instance, server } = await serve();
    try {
      const host = new URL(origin).host;
      const resource = `acct:d4@${host}`;
      const res = await fetch(`${origin}/.well-known/webfinger?resource=${encodeURIComponent(resource)}`);
      assert.equal(res.status, 200);
      const jrd = (await res.json()) as { subject: string; aliases: string[] };
      const actorId = `${origin}/agents/d4`;
      assert.equal(jrd.subject, resource);
      assert.deepEqual(jrd.aliases, [actorId]);
      const doc = instance.agentDocument("d4") as { preferredUsername: string };
      assert.equal(doc.preferredUsername, "d4");
    } finally {
      server.close();
    }
  });

  it("200 JRD for a hub over acct:", async () => {
    const { origin, server } = await serve();
    try {
      const host = new URL(origin).host;
      const resource = `acct:bridge@${host}`;
      const res = await fetch(`${origin}/.well-known/webfinger?resource=${encodeURIComponent(resource)}`);
      assert.equal(res.status, 200);
      const jrd = (await res.json()) as { subject: string; aliases: string[] };
      assert.equal(jrd.subject, resource);
      assert.deepEqual(jrd.aliases, [`${origin}/hubs/bridge`]);
    } finally {
      server.close();
    }
  });

  it("200 JRD for the https: resource form, subject echoing the resource", async () => {
    const { origin, server } = await serve();
    try {
      const actorId = `${origin}/agents/d4`;
      const res = await fetch(`${origin}/.well-known/webfinger?resource=${encodeURIComponent(actorId)}`);
      assert.equal(res.status, 200);
      const jrd = (await res.json()) as { subject: string; aliases: string[]; links: { href: string }[] };
      assert.equal(jrd.subject, actorId);
      assert.deepEqual(jrd.aliases, [actorId]);
      assert.equal(jrd.links[0]?.href, actorId);
    } finally {
      server.close();
    }
  });

  it("404 on an unknown https: resource", async () => {
    const { origin, server } = await serve();
    try {
      const res = await fetch(`${origin}/.well-known/webfinger?resource=${encodeURIComponent(`${origin}/agents/nobody`)}`);
      assert.equal(res.status, 404);
    } finally {
      server.close();
    }
  });
});
