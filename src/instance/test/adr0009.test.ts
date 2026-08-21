/**
 * ADR-0009 acceptance gate: the federated joint replay.
 *
 * The two-instance flow of adr0008.test.ts, taken one step further: both
 * sides export — Alpha in full, Bravo scoped with redaction stubs and a
 * declared omission — and the auditor's two folders become one command. Then
 * the set is broken one named check at a time: a silent deletion where a stub
 * should be, tampered received bytes, an agreement that tells two stories.
 *
 *   node --experimental-sqlite --test test/adr0009.test.ts
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, cpSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, describe, it } from "node:test";

import { loadConfig } from "../src/config.ts";
import { AfpInstance, type AgentRegistration } from "../src/instance.ts";
import { jumpClock } from "../src/demoP3.ts";
import { CountingBrain } from "../src/brains/stub.ts";
import { createHttpServer } from "../src/ap/server.ts";
import type { Envelope } from "../src/ap/activities.ts";
import { Federation, agreementObject, createAgreement } from "../src/federation/federation.ts";
import { httpTransport } from "../src/federation/transport.ts";
import { exportBundle } from "../src/export.ts";
import { vouch } from "../src/ap/activities.ts";
import { cleanupWorkspaces, workspace } from "./helpers.ts";

after(cleanupWorkspaces);

const VERIFIER = join(import.meta.dirname, "..", "..", "verifier", "afp_verify.py");

function jointVerify(dirs: string[], extra: string[] = []): { code: number; output: string } {
  try {
    const output = execFileSync("python3", [VERIFIER, ...dirs, "--verbose", ...extra], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address && typeof address === "object") {
        const port = address.port;
        probe.close(() => resolve(port));
      } else probe.close(() => reject(new Error("no port")));
    });
  });
}

async function operator(agents: readonly string[], clock: ReturnType<typeof jumpClock>) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const paths = workspace();
  const config = loadConfig({ ...paths, origin });
  const registrations: AgentRegistration[] = agents.map((agent) => ({
    spec: { name: agent, capabilities: ["afp:cap:assess"], keyCustody: "instance", since: "2026-08-17T00:00:00Z" },
    brain: new CountingBrain(agent, ["afp:cap:assess"], () => ({ ok: true, content: "done" })),
  }));
  const instance = new AfpInstance(config, registrations, clock);
  const actorId = String(instance.instanceDocument().id);
  const federation = new Federation(instance.db, actorId, () => clock.now());
  const fetchDocument = async (url: string) => {
    try {
      const response = await fetch(url, { headers: { accept: "application/activity+json" } });
      return response.ok ? ((await response.json()) as { [key: string]: never }) : null;
    } catch {
      return null;
    }
  };
  const server = createHttpServer(instance, {
    inbox: { federation, receive: (activity) => instance.receiveAdmitted(activity), fetchDocument },
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const transport = httpTransport({
    keyId: instance.key("@instance").keyId,
    privateKey: instance.key("@instance").privateKey,
    now: () => clock.now(),
    isLocal: (target) => instance.nameOf(target) !== null || target === actorId,
    local: instance.localTransport(),
  });
  return { instance, federation, server, actorId, transport, exportDir: config.exportDir };
}

describe("ADR-0009 gate: two exports, one engagement", () => {
  it("the joint replay passes; deletion, divergence and two-story agreements fail by name", async () => {
    const clock = jumpClock();
    const alpha = await operator(["a-lead"], clock);
    const beta = await operator(["b-assessor", "b-private"], clock);

    try {
      // --- Handshake (dual-Create, as in the adr0008 gate).
      const expires = new Date(clock.now().getTime() + 3600_000).toISOString();
      const object = agreementObject({
        parties: [alpha.actorId, beta.actorId],
        grants: [{ "afp:grantType": "direct-delegation", "afp:capabilities": ["afp:cap:assess"] }],
        expires,
      });
      const alphaCreate = alpha.instance.publishAsInstance([beta.actorId], "urn:afp:thread:fed", "parties", (envelope: Envelope) =>
        createAgreement(envelope, object),
      );
      alpha.federation.recordOwnCreate(object, alphaCreate.activity);
      await alpha.instance.run(alpha.transport);
      const betaCreate = beta.instance.publishAsInstance([alpha.actorId], "urn:afp:thread:fed", "parties", (envelope: Envelope) =>
        createAgreement(envelope, object),
      );
      beta.federation.recordOwnCreate(object, betaCreate.activity);
      await beta.instance.run(beta.transport);

      // --- Bravo does something that is none of Alpha's business.
      beta.instance.publish("b-assessor", [], "urn:afp:thread:other-client", "internal", (envelope: Envelope) => ({
        "@context": ["https://www.w3.org/ns/activitystreams", "https://dalager.github.io/agent-federation-protocol/ns/v3.jsonld"],
        id: envelope.activityId,
        type: "Create",
        actor: envelope.actor,
        to: [],
        published: envelope.published,
        context: envelope.thread,
        "afp:visibility": envelope.visibility,
        ...(envelope.prevActivity !== null ? { "afp:prevActivity": envelope.prevActivity } : {}),
        object: { id: "urn:afp:result:other", type: "afp:Result", "afp:correlationId": "other", content: "confidential", attributedTo: envelope.actor },
      }));

      // --- The delegation, and Bravo's engagement-thread answer.
      const offer = alpha.instance.publish("a-lead", [beta.instance.actorId("b-assessor")], "urn:afp:thread:sub-1", "parties", (envelope: Envelope) => ({
        "@context": ["https://www.w3.org/ns/activitystreams", "https://dalager.github.io/agent-federation-protocol/ns/v3.jsonld"],
        id: envelope.activityId,
        type: "Offer",
        actor: envelope.actor,
        to: [...envelope.to],
        published: envelope.published,
        context: envelope.thread,
        "afp:visibility": envelope.visibility,
        ...(envelope.prevActivity !== null ? { "afp:prevActivity": envelope.prevActivity } : {}),
        object: { id: "urn:afp:task:sub-1", type: "afp:Task", "afp:capability": "afp:cap:assess", "afp:correlationId": "sub-1", content: "assess it" },
      }));
      assert.ok(offer);
      await alpha.instance.run(alpha.transport);
      await beta.instance.run(beta.transport); // Accept + Result cross back
      await alpha.instance.run(alpha.transport);

      // --- Both sides export. Alpha in full; Bravo scoped: the engagement and
      // the handshake, its other client's thread as stubs, its uninvolved
      // agent as a declared omission.
      for (const op of [alpha, beta]) {
        op.instance.publishAsInstance([], "urn:afp:thread:roster", "public", (envelope: Envelope) =>
          vouch(envelope, { agent: `${op.actorId}`, capabilities: ["afp:cap:hub"], keyCustody: "self" }),
        );
      }
      const alphaDir = join(alpha.exportDir, "..", "export-a");
      const betaDir = join(beta.exportDir, "..", "export-b");
      exportBundle(alpha.instance, alphaDir, [], undefined, alpha.federation);
      exportBundle(
        beta.instance,
        betaDir,
        [],
        { threads: ["urn:afp:thread:fed", "urn:afp:thread:sub-1", "urn:afp:thread:roster"], omitActors: ["b-private"] },
        beta.federation,
      );

      // Bravo's bundle really is scoped: stubs mid-chain where the other
      // client's work was, and the uninvolved agent has no file at all.
      const betaAssessorOutbox = JSON.parse(readFileSync(join(betaDir, "outbox", "b-assessor.jsonld"), "utf8")) as {
        orderedItems: { type: string }[];
      };
      assert.ok(betaAssessorOutbox.orderedItems.some((item) => item.type === "afp:Redacted"), "the scope produced stubs");
      const betaManifest = JSON.parse(readFileSync(join(betaDir, "MANIFEST.json"), "utf8")) as {
        "afp:exportScope": { "afp:omittedActors": string[] };
      };
      assert.ok(betaManifest["afp:exportScope"]["afp:omittedActors"].includes(beta.instance.actorId("b-private")));

      // --- The joint replay: two folders, one command.
      const clean = jointVerify([alphaDir, betaDir]);
      assert.equal(clean.code, 0, `joint replay failed:\n${clean.output}`);
      assert.match(clean.output, /\[export-a\] signature:/);
      assert.match(clean.output, /\[export-b\] completeness: .*omitted by declared scope/);
      assert.match(clean.output, /joint: agreement .*digest-equal in both exports/);
      assert.match(clean.output, /joint: received .*matches the sender's record/);

      const mutate = (dir: string, file: string, edit: (doc: { orderedItems: Record<string, unknown>[] }) => void) => {
        const copyA = mkdtempSync(join(tmpdir(), "afp-adr9-a-"));
        const copyB = mkdtempSync(join(tmpdir(), "afp-adr9-b-"));
        cpSync(alphaDir, copyA, { recursive: true });
        cpSync(betaDir, copyB, { recursive: true });
        const target = join(dir === "a" ? copyA : copyB, file);
        const doc = JSON.parse(readFileSync(target, "utf8"));
        edit(doc);
        if (doc.orderedItems) doc.totalItems = doc.orderedItems.length;
        writeFileSync(target, JSON.stringify(doc, null, 2));
        return jointVerify([copyA, copyB]);
      };

      // 1 — deletion vs discretion: remove a stub outright — the chain gaps.
      const silentDeletion = mutate("b", "outbox/b-assessor.jsonld", (doc) => {
        doc.orderedItems = doc.orderedItems.filter((item) => item.type !== "afp:Redacted");
      });
      assert.match(silentDeletion.output, /FAIL \] \[afp-adr9-b.*\] chain: b-assessor/);

      // 2 — divergence: Alpha's received copy of Bravo's Result is tampered.
      const divergence = mutate("a", "received.jsonld", (doc) => {
        for (const item of doc.orderedItems) {
          const activity = (item as Record<string, Record<string, unknown>>)["afp:activity"];
          const object = activity?.object as Record<string, unknown> | undefined;
          if (object?.type === "afp:Result") object.content = "totally fine, ship it";
        }
      });
      assert.notEqual(divergence.code, 0);
      assert.match(divergence.output, /FAIL \] joint: received .*matches the sender's record/);

      // 3 — two stories: Bravo's export carries a different agreement object.
      const twoStories = mutate("b", `outbox/instance.jsonld`, (doc) => {
        for (const item of doc.orderedItems) {
          const object = (item as Record<string, Record<string, unknown>>).object;
          if (object?.type === "afp:FederationAgreement") object["afp:expires"] = "2099-01-01T00:00:00Z";
        }
      });
      assert.notEqual(twoStories.code, 0);
      assert.match(twoStories.output, /FAIL \] joint: agreement .*digest-equal/);

      // 4 — a stub that names nothing covers nothing.
      const blankStub = mutate("b", "outbox/b-assessor.jsonld", (doc) => {
        for (const item of doc.orderedItems) if (item.type === "afp:Redacted") delete item["afp:digest"];
      });
      assert.notEqual(blankStub.code, 0);
      assert.match(blankStub.output, /FAIL \] \[afp-adr9-b.*\] chain: .*stub declares a digest/);
    } finally {
      for (const op of [alpha, beta]) {
        await new Promise<void>((resolve) => op.server.close(() => resolve()));
        op.instance.close();
      }
    }
  });
});

describe("ADR-0009: a scope covers the whole bundle, received bytes included", () => {
  it("out-of-scope received activities are dropped, not shipped", async () => {
    // Found by review: `exportBundle` stubbed its own outboxes by scope and
    // shipped received.jsonld unfiltered — so the subject-scoped audit bundle
    // (the deliverable 29b exists for) redacted the operator's activities on
    // other clients' threads while handing over the counterparties' copies of
    // those same threads verbatim. The stubs closed the front door; the back
    // door was open.
    const { testInstance } = await import("./helpers.ts");
    const { exportBundle } = await import("../src/export.ts");
    const { instance, config } = testInstance(["writer"], "afp:cap:assess");
    const inThread = "urn:afp:thread:this-client";
    const outThread = "urn:afp:thread:other-client";
    instance.publish("writer", [], inThread, "parties", (envelope) =>
      // any local activity, so the scoped thread is non-empty
      ({ ...envelope, id: envelope.activityId, type: "Create", actor: envelope.actor, to: [], published: envelope.published, context: envelope.thread, "afp:visibility": "parties", object: { id: "urn:afp:result:x", type: "afp:Result", "afp:correlationId": "x", content: "ok", attributedTo: envelope.actor } }) as never,
    );

    const received = {
      receivedActivities: () => [
        { digest: "sha256:aaa", fromInstance: "https://bravo.example/actor", activity: { id: "urn:a:1", context: inThread } as never },
        { digest: "sha256:bbb", fromInstance: "https://bravo.example/actor", activity: { id: "urn:a:2", context: outThread } as never },
      ],
    };
    exportBundle(instance, config.exportDir, [], { threads: [inThread], omitActors: [] }, received);

    const receivedOut = JSON.parse(readFileSync(join(config.exportDir, "received.jsonld"), "utf8"));
    const ids = (receivedOut.orderedItems as { "afp:activity": { id: string } }[]).map((i) => i["afp:activity"].id);
    assert.deepEqual(ids, ["urn:a:1"], "only the declared thread's received bytes ship");
    const manifest = JSON.parse(readFileSync(join(config.exportDir, "MANIFEST.json"), "utf8"));
    assert.ok((manifest["afp:members"] as string[]).includes("received.jsonld"));
    instance.close();
  });
});
