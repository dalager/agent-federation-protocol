/**
 * ADR-0017 Decision 3: spec-shaped delivery, over a real socket.
 *
 * Four properties, each one a critique finding:
 *  - every URL an actor document advertises is served (finding 1.5) — the
 *    instance actor's outbox answers, and its advertised inbox/outbox match
 *    the mounted routes;
 *  - collections carry `@context` and page past the threshold;
 *  - a GET on an inbox is the owner's view: the instance's own signature
 *    reads the received log, a stranger gets the gate's ordinary 404;
 *  - `application/ld+json` with the AS2 profile is honoured on Accept.
 *
 *   node --experimental-sqlite --test test/adr0017-d3.test.ts
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { AfpInstance, type AgentRegistration } from "../src/instance.ts";
import { loadConfig } from "../src/config.ts";
import { createHttpServer } from "../src/ap/server.ts";
import { signRequest } from "../src/federation/httpSig.ts";
import type { ReadGateDeps } from "../src/federation/readGate.ts";
import type { JsonValue } from "../src/crypto/jcs.ts";
import { createServer as createProbe } from "node:net";
import { jumpClock } from "../src/demoP3.ts";
import { cleanupWorkspaces, publishRaw, workspace } from "./helpers.ts";

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

const AS2_LD = 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"';

async function serve() {
  const clock = jumpClock("2026-08-21T15:00:00.000Z");
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const config = loadConfig({ ...workspace(), origin });
  const registrations: AgentRegistration[] = [
    {
      spec: { name: "d3", capabilities: ["afp:cap:assess"], keyCustody: "instance", since: "2026-08-17T00:00:00Z" },
      brain: { name: "d3", capabilities: ["afp:cap:assess"], handle: async () => ({ ok: true, content: "ok" }) },
    },
  ];
  const instance = new AfpInstance(config, registrations, clock);

  const fetchDocument = async (url: string): Promise<{ [key: string]: JsonValue } | null> => {
    try {
      const response = await fetch(url, { headers: { accept: "application/activity+json" } });
      return response.ok ? ((await response.json()) as { [key: string]: JsonValue }) : null;
    } catch {
      return null;
    }
  };
  const read: ReadGateDeps = {
    fetchDocument,
    isDenylisted: () => false,
    activeAgreementsWith: () => [],
    roleOf: () => null,
    grants: () => [],
    now: () => clock.now(),
  };
  const server = createHttpServer(instance, { read });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { clock, origin, instance, server };
}

describe("ADR-0017 Decision 3: spec-shaped delivery", () => {
  it("advertised inbox/outbox URLs are the mounted routes, and the instance outbox is served", async () => {
    const { origin, instance, server } = await serve();
    try {
      const actor = instance.instanceDocument() as { id: string; inbox: string; outbox: string };
      assert.equal(actor.inbox, `${actor.id}/inbox`, "the instance actor advertises the route the server mounts");
      assert.equal(actor.outbox, `${actor.id}/outbox`);

      const response = await fetch(actor.outbox);
      assert.equal(response.status, 200, "the advertised instance outbox answers");
      const outbox = (await response.json()) as { "@context": unknown; type: string; orderedItems: unknown[] };
      assert.equal(outbox.type, "OrderedCollection");
      assert.ok(Array.isArray(outbox["@context"]), "collections carry @context");
    } finally {
      server.close();
    }
  });

  it("a large collection pages: first link, partOf, next/prev", async () => {
    const { origin, instance, server, clock } = await serve();
    try {
      for (let i = 0; i < 120; i++) {
        publishRaw(instance, "d3", [], "urn:afp:thread:d3-page", "public", { type: "Create", content: `item ${i}` });
      }
      const collection = (await (await fetch(`${origin}/agents/d3/outbox`)).json()) as {
        totalItems: number;
        first?: string;
        orderedItems?: unknown[];
      };
      assert.equal(collection.totalItems, 120);
      assert.equal(collection.orderedItems, undefined, "past the threshold the collection links, not lists");
      assert.ok(collection.first?.endsWith("?page=1"));

      const page2 = (await (await fetch(`${origin}/agents/d3/outbox?page=2`)).json()) as {
        type: string;
        partOf: string;
        prev?: string;
        next?: string;
        orderedItems: unknown[];
      };
      assert.equal(page2.type, "OrderedCollectionPage");
      assert.equal(page2.partOf, `${origin}/agents/d3/outbox`);
      assert.ok(page2.prev?.endsWith("?page=1"));
      assert.ok(page2.next?.endsWith("?page=3"));
      assert.equal(page2.orderedItems.length, 50);
    } finally {
      server.close();
    }
  });

  it("an inbox GET is the owner's view: self-signed reads it, a stranger gets 404", async () => {
    const { origin, instance, server, clock } = await serve();
    try {
      instance.inboxLog.record(
        "/actor/inbox",
        { id: `${origin}/x/1`, type: "Create", actor: `${origin}/peer` },
        clock.now(),
      );

      const anonymous = await fetch(`${origin}/actor/inbox`);
      assert.equal(anonymous.status, 404, "a stranger cannot tell the inbox view from a missing route");

      const key = instance.key("@instance");
      const url = new URL(`${origin}/actor/inbox`);
      const signed = signRequest("GET", url.pathname, url.host, "", key.keyId, key.privateKey, clock.now());
      const owner = await fetch(url, { headers: { ...signed } });
      assert.equal(owner.status, 200, "the instance's own signature reads its inbox");
      const inbox = (await owner.json()) as { type: string; totalItems: number; orderedItems: unknown[] };
      assert.equal(inbox.type, "OrderedCollection");
      assert.equal(inbox.totalItems, 1);
    } finally {
      server.close();
    }
  });

  it("Accept negotiation: the AS2 ld+json profile is answered in kind", async () => {
    const { origin, server } = await serve();
    try {
      const plain = await fetch(`${origin}/actor`);
      assert.equal(plain.headers.get("content-type"), "application/activity+json");
      const profiled = await fetch(`${origin}/actor`, { headers: { accept: AS2_LD } });
      assert.equal(profiled.headers.get("content-type"), AS2_LD);
    } finally {
      server.close();
    }
  });
});
