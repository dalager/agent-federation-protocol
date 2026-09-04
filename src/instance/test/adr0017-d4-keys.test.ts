/**
 * ADR-0017 Decision 4: transport keys, split from proof keys.
 *
 * Two properties, each one a critique finding:
 *  - actor documents publish `assertionMethod` (proof keys only) and
 *    `authentication` (the `#transport-key` Multikey) as separate lists —
 *    the WP1 acceptance check;
 *  - the read gate resolves a signature against `authentication` first, with
 *    `assertionMethod` kept as a compatibility fallback (`resolveTransportKey.ts`) —
 *    both the transport key and the legacy proof key admit a GET, while an
 *    unknown keyId stays anonymous.
 *
 *   node --experimental-sqlite --test test/adr0017-d4-keys.test.ts
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { AfpInstance, type AgentRegistration } from "../src/instance.ts";
import { loadConfig } from "../src/config.ts";
import { createHttpServer } from "../src/ap/server.ts";
import { generateKeyPairSync } from "node:crypto";
import { signRequest } from "../src/federation/httpSig.ts";
import type { ReadGateDeps } from "../src/federation/readGate.ts";
import type { JsonValue } from "../src/crypto/jcs.ts";
import { createServer as createProbe } from "node:net";
import { jumpClock } from "../src/demoP3.ts";
import { cleanupWorkspaces, workspace } from "./helpers.ts";
import { fileSigner, signerOver } from "../src/crypto/signer.ts";

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
  const clock = jumpClock("2026-08-22T15:00:00.000Z");
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

describe("ADR-0017 Decision 4: transport keys", () => {
  it("assertionMethod carries only proof keys; authentication carries #transport-key", async () => {
    const { instance, server } = await serve();
    try {
      const docs = [instance.instanceDocument(), instance.agentDocument("d4")] as {
        assertionMethod?: { id: string }[];
        authentication?: { id: string }[];
      }[];

      for (const doc of docs) {
        for (const entry of doc.authentication ?? []) {
          assert.ok(entry.id.endsWith("#transport-key"), "every authentication entry is the transport key");
        }
        for (const entry of doc.assertionMethod ?? []) {
          assert.ok(!entry.id.endsWith("#transport-key"), "no assertionMethod entry is the transport key");
        }
      }

      assert.notEqual(
        instance.transportKey("@instance").keyId,
        instance.key("@instance").keyId,
        "the transport key and the proof key are distinct (WP1 acceptance check)",
      );
    } finally {
      server.close();
    }
  });

  it("a GET signed with the transport key resolves at the read gate", async () => {
    const { origin, instance, clock, server } = await serve();
    try {
      instance.inboxLog.record(
        "/actor/inbox",
        { id: `${origin}/x/1`, type: "Create", actor: `${origin}/peer` },
        clock.now(),
      );

      const key = instance.transportKey("@instance");
      const url = new URL(`${origin}/actor/inbox`);
      const signed = signRequest("GET", url.pathname, url.host, "", fileSigner(key), clock.now());
      const response = await fetch(url, { headers: { ...signed } });
      assert.equal(response.status, 200, "the transport key admits the owner's inbox view");
    } finally {
      server.close();
    }
  });

  it("a GET signed with the legacy proof key is still admitted (compatibility fallback)", async () => {
    const { origin, instance, clock, server } = await serve();
    try {
      instance.inboxLog.record(
        "/actor/inbox",
        { id: `${origin}/x/1`, type: "Create", actor: `${origin}/peer` },
        clock.now(),
      );

      const key = instance.key("@instance");
      const url = new URL(`${origin}/actor/inbox`);
      const signed = signRequest("GET", url.pathname, url.host, "", fileSigner(key), clock.now());
      const response = await fetch(url, { headers: { ...signed } });
      assert.equal(response.status, 200, "the assertionMethod fallback still admits the legacy proof key");
    } finally {
      server.close();
    }
  });

  it("a GET signed with an unknown keyId is anonymous", async () => {
    const { origin, instance, clock, server } = await serve();
    try {
      instance.inboxLog.record(
        "/actor/inbox",
        { id: `${origin}/x/1`, type: "Create", actor: `${origin}/peer` },
        clock.now(),
      );

      const stranger = generateKeyPairSync("ed25519");
      const url = new URL(`${origin}/actor/inbox`);
      const signed = signRequest(
        "GET",
        url.pathname,
        url.host,
        "",
        signerOver(`${origin}/actor#unknown-key`, stranger.privateKey),
        clock.now(),
      );
      const response = await fetch(url, { headers: { ...signed } });
      assert.equal(response.status, 404, "an unresolvable keyId cannot be told apart from a missing route");
    } finally {
      server.close();
    }
  });
});
