/**
 * ADR-0017 Decision 5: namespace hygiene.
 *
 * Four properties, each one a critique finding:
 *  - FEP-f1d5 NodeInfo is live: the discovery link at the well-known route,
 *    and the version document it points at;
 *  - the policy document's canonical URL moves to an unreserved path, with
 *    the old `.well-known` route kept as a transition alias serving the
 *    same body — and the instance document names the canonical one;
 *  - no activity this instance emits carries a `urn:afp:` id — the record
 *    is minted under the instance's own https origin;
 *  - the allocation protocol's sealed-bid activity is `afp:BidCommit`
 *    (type-name capitalization), on both the TypeScript and Python sides.
 *
 *   node --experimental-sqlite --test test/adr0017-d5.test.ts
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createServer as createProbe } from "node:net";

import { AfpInstance, type AgentRegistration } from "../src/instance.ts";
import { loadConfig } from "../src/config.ts";
import { createHttpServer } from "../src/ap/server.ts";
import { bidCommit } from "../src/allocation/activities.ts";
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

async function serve() {
  const clock = jumpClock("2026-08-22T09:00:00.000Z");
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const config = loadConfig({ ...workspace(), origin });
  const registrations: AgentRegistration[] = [
    {
      spec: { name: "d5", capabilities: ["afp:cap:assess"], keyCustody: "instance", since: "2026-08-17T00:00:00Z" },
      brain: { name: "d5", capabilities: ["afp:cap:assess"], handle: async () => ({ ok: true, content: "ok" }) },
    },
  ];
  const instance = new AfpInstance(config, registrations, clock);
  const server = createHttpServer(instance, {});
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { clock, origin, instance, server };
}

describe("ADR-0017 Decision 5: namespace hygiene", () => {
  it("NodeInfo: the discovery link and the version document it points at", async () => {
    const { origin, server } = await serve();
    try {
      const discovery = await fetch(`${origin}/.well-known/nodeinfo`);
      assert.equal(discovery.status, 200);
      const discoveryBody = (await discovery.json()) as { links: { rel: string; href: string }[] };
      const link = discoveryBody.links.find((l) => l.rel === "http://nodeinfo.diaspora.software/ns/schema/2.1");
      assert.ok(link, "the 2.1 schema link is advertised");
      assert.equal(link!.href, `${origin}/nodeinfo/2.1`);

      const versionResponse = await fetch(link!.href);
      assert.equal(versionResponse.status, 200);
      const version = (await versionResponse.json()) as { version: string; protocols: string[] };
      assert.equal(version.version, "2.1");
      assert.deepEqual(version.protocols, ["activitypub"]);
    } finally {
      server.close();
    }
  });

  it("policy: the canonical path and the well-known alias serve identical bodies, and the actor names the canonical one", async () => {
    const { origin, instance, server } = await serve();
    try {
      const canonical = await fetch(`${origin}/afp/policy`);
      const alias = await fetch(`${origin}/.well-known/afp-policy`);
      assert.equal(canonical.status, 200);
      assert.equal(alias.status, 200);
      assert.deepEqual(await canonical.json(), await alias.json(), "the alias serves the same body as the canonical path");

      const actor = instance.instanceDocument() as { "afp:policy": string };
      assert.equal(actor["afp:policy"], `${origin}/afp/policy`, "the instance document names the canonical path");
    } finally {
      server.close();
    }
  });

  it("no activity a fresh instance publishes carries a urn:afp: id", async () => {
    const { origin, instance, server } = await serve();
    try {
      publishRaw(instance, "d5", [], `${origin}/threads/d5-clean`, "public", { type: "Create", content: "hello" });
      const outbox = await (await fetch(`${origin}/agents/d5/outbox`)).json();
      assert.ok(!JSON.stringify(outbox).includes("urn:afp:"), "no emitted activity carries a urn:afp: id");
    } finally {
      server.close();
    }
  });

  it("the allocation sealed-bid activity is afp:BidCommit", async () => {
    const { origin, instance, server } = await serve();
    try {
      const entry = instance.publish("d5", [], `${origin}/threads/d5-bid`, "hub", (envelope) =>
        bidCommit(envelope, { task: `${origin}/tasks/t1`, hub: `${origin}/hubs/bridge`, commitment: "sha256:abc" }),
      );
      assert.equal(entry.activity.type, "afp:BidCommit");
    } finally {
      server.close();
    }
  });
});
