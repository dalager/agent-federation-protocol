/**
 * ADR-0029 gate: the human window and the ActivityPub premise. Six checks,
 * by number, plus the primitives they rest on — folded from
 * `test/adr0029-wp2.test.ts` (Decision 2 "Watch") and
 * `test/adr0029-wp34.test.ts` (Decision 2 "Approve"/"Command" and
 * Decision 3, the fediverse projection).
 *
 *   node --experimental-sqlite --test test/adr0029.test.ts
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createServer as createProbe } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { AfpInstance, type AgentRegistration } from "../src/instance.ts";
import { loadConfig } from "../src/config.ts";
import { createHttpServer } from "../src/ap/server.ts";
import { signRequest } from "../src/federation/httpSig.ts";
import { fileSigner } from "../src/crypto/signer.ts";
import type { ReadGateDeps } from "../src/federation/readGate.ts";
import type { JsonValue } from "../src/crypto/jcs.ts";
import { jumpClock } from "../src/demoP3.ts";
import { runDemo } from "../src/demo.ts";
import { runP8Demo } from "../src/demoP8.ts";
import { CountingBrain } from "../src/brains/stub.ts";
import { auditGrant } from "../src/federation/visibility.ts";
import { digestOf } from "../src/crypto/proof.ts";
import { exportBundle } from "../src/export.ts";
import { renderThread } from "../src/render/rendering.ts";
import type { OutboxEntry } from "../src/store/outbox.ts";
import { cleanupWorkspaces, freshDemo, objectType, publishRaw, runVerifier, workspace } from "./helpers.ts";

after(cleanupWorkspaces);

const VERIFIER = join(import.meta.dirname, "..", "..", "verifier", "afp_verify.py");

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

/** Two agents ("owner" publishes; "party" is the one named on a `parties`
 * activity; "auditor" is named on neither, admitted only under a grant). */
async function watchServe() {
  const clock = jumpClock("2026-09-13T09:00:00.000Z");
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const paths = workspace();
  const config = loadConfig({ ...paths, origin });
  const registrations: AgentRegistration[] = ["owner", "party", "auditor"].map((name) => ({
    spec: { name, capabilities: ["afp:cap:assess"], keyCustody: "instance", since: "2026-08-17T00:00:00Z" },
    brain: { name, capabilities: ["afp:cap:assess"], handle: async () => ({ ok: true, content: "ok" }) },
  }));
  const instance = new AfpInstance(config, registrations, clock);

  let grants: { [key: string]: JsonValue }[] = [];
  const grantedFetches: { grant: string; auditor: string; path: string }[] = [];

  const fetchDocument = async (url: string): Promise<{ [key: string]: JsonValue } | null> => {
    try {
      const response = await fetch(url, { headers: { accept: "application/activity+json" } });
      return response.ok ? ((await response.json()) as { [key: string]: JsonValue }) : null;
    } catch {
      return null;
    }
  };
  const read: ReadGateDeps & { onGrantedFetch: (info: { grant: string; auditor: string; path: string; at: Date }) => void } = {
    selfActor: String(instance.instanceDocument().id),
    fetchDocument,
    isDenylisted: () => false,
    // Every agent here resolves to the same `afp:operatedBy` (the instance
    // actor), so one active agreement covers `admitsParties` for all of them.
    activeAgreementsWith: () => [{ type: "afp:FederationAgreement" } as unknown as { [k: string]: JsonValue }],
    roleOf: () => null,
    grants: () => grants,
    now: () => clock.now(),
    onGrantedFetch: (info) => grantedFetches.push({ grant: info.grant, auditor: info.auditor, path: info.path }),
  };
  const server = createHttpServer(instance, { read });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  return {
    clock,
    origin,
    instance,
    server,
    exportDir: paths.exportDir,
    setGrants: (next: { [key: string]: JsonValue }[]) => {
      grants = next;
    },
    grantedFetches,
  };
}

/**
 * A two-agent instance ("controller" is a registered agent under the
 * instance's own policy, "worker" is the performer commands address) plus a
 * running server with a real read gate, so a POST can be genuinely
 * HTTP-signed and verified end to end.
 */
async function commandServe() {
  const clock = jumpClock("2026-09-13T09:00:00.000Z");
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const paths = workspace();
  const controllerName = "controller";
  const workerName = "worker";
  const config = loadConfig({
    ...paths,
    origin,
    controllers: [`${origin}/agents/${controllerName}`],
  });
  const brain = new CountingBrain(workerName, ["afp:cap:assess"], () => ({ ok: true, content: "ok" }));
  const registrations: AgentRegistration[] = [
    { spec: { name: controllerName, capabilities: [], keyCustody: "instance", since: "2026-08-17T00:00:00Z" }, brain: new CountingBrain(controllerName, [], () => ({ ok: true, content: "n/a" })) },
    { spec: { name: workerName, capabilities: ["afp:cap:assess"], keyCustody: "instance", since: "2026-08-17T00:00:00Z" }, brain },
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
    selfActor: String(instance.instanceDocument().id),
    fetchDocument,
    isDenylisted: () => false,
    activeAgreementsWith: () => [],
    roleOf: () => null,
    grants: () => [],
    now: () => clock.now(),
  };
  const server = createHttpServer(instance, { read });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  const post = async (name: string, path: string, body: { [key: string]: unknown }) => {
    const text = JSON.stringify(body);
    const headers = signRequest("POST", path, `127.0.0.1:${port}`, text, fileSigner(instance.key(name)), clock.now());
    const res = await fetch(`${origin}${path}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: text });
    return { status: res.status, body: (await res.json()) as { [key: string]: JsonValue } };
  };
  const postUnsigned = async (path: string, body: { [key: string]: unknown }) => {
    const res = await fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as { [key: string]: JsonValue } };
  };

  return { clock, origin, instance, server, controllerName, workerName, post, postUnsigned, brain };
}

function windowInstance() {
  const paths = workspace();
  const config = loadConfig({ ...paths, fediverseWindow: true });
  const clock = jumpClock();
  const agents: AgentRegistration[] = ["delegator", "performer"].map((name) => ({
    spec: { name, capabilities: ["afp:cap:assess"], keyCustody: "instance", since: "2026-08-17T00:00:00Z" },
    brain: new CountingBrain(name, ["afp:cap:assess"], () => ({ ok: true, content: "ok" })),
  }));
  return new AfpInstance(config, agents, clock);
}

describe("ADR-0029 gate — the human window and the ActivityPub premise", () => {
  it("G1 — a rendering fetched anonymously for a parties thread is 404; for a public thread, a rendering carrying the digest of what it rendered", async () => {
    const { origin, instance, server, clock } = await watchServe();
    try {
      const partiesThread = `${origin}/threads/t-parties`;
      const partyId = instance.actorId("party");
      publishRaw(instance, "owner", [partyId], partiesThread, "parties", {
        type: "Create",
        content: "the secret clause",
        object: { type: "Note" },
      });

      const anon = await fetch(`${origin}/threads/t-parties/rendering`);
      assert.equal(anon.status, 404, "a parties thread to an anonymous caller is indistinguishable from no thread");

      const publicThread = `${origin}/threads/t-public`;
      publishRaw(instance, "owner", [], publicThread, "public", {
        type: "Create",
        content: "the public announcement, out in the open",
        object: { type: "Note" },
      });
      const entries = instance.outbox.byThread(publicThread);

      const res = await fetch(`${origin}/threads/t-public/rendering`);
      assert.equal(res.status, 200);
      const rendering = (await res.json()) as {
        "afp:renders": string[];
        "afp:renderingDigest": string;
        "afp:chainHeads": { [k: string]: string };
        "afp:bundle": unknown;
        narrative: string[];
      };
      assert.deepEqual(rendering["afp:renders"], entries.map((e) => digestOf(e.activity)), "digests, in chain order");
      assert.equal(rendering["afp:chainHeads"][instance.actorId("owner")], instance.outbox.headDigest(instance.actorId("owner")));
      assert.equal(rendering["afp:bundle"], null, "no export yet");
      assert.ok(rendering.narrative[0].includes("the public announcement"), "public excerpt is included");

      // Accept: text/plain
      const text = await fetch(`${origin}/threads/t-public/rendering`, { headers: { accept: "text/plain" } });
      assert.equal(text.headers.get("content-type"), "text/plain; charset=utf-8");
      const body = await text.text();
      assert.ok(body.startsWith(`Rendering of ${publicThread} — digest ${rendering["afp:renderingDigest"]}`));

      // after export: afp:bundle populates and the digest recomputes from the file bytes
      exportBundle(instance, instance.config.exportDir);
      const afterExport = (await (await fetch(`${origin}/threads/t-public/rendering`)).json()) as { "afp:bundle": { "afp:manifestDigest": string; "afp:verdict": string } };
      assert.ok(afterExport["afp:bundle"], "an export now exists");
      assert.equal(afterExport["afp:bundle"]["afp:verdict"], "unverified", "never fabricated");
      const manifestBytes = readFileSync(join(instance.config.exportDir, "MANIFEST.json"), "utf8");
      const expectedDigest = `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`;
      assert.equal(afterExport["afp:bundle"]["afp:manifestDigest"], expectedDigest);

      // a party fetching the parties thread sees no `content` text
      const headers = signRequest("GET", "/threads/t-parties/rendering", new URL(origin).host, "", fileSigner(instance.key("party")), clock.now());
      const partyRes = await fetch(`${origin}/threads/t-parties/rendering`, { headers: { ...headers } });
      assert.equal(partyRes.status, 200, "the named party is admitted");
      const partyRendering = (await partyRes.json()) as { narrative: string[] };
      assert.ok(!partyRendering.narrative.some((line) => line.includes("the secret clause")), "no content text leaked to a party");
    } finally {
      server.close();
    }
  });

  it("G2 — the same under an afp:AuditGrant: served, and the fetch is recorded", async () => {
    const { origin, instance, server, clock, setGrants, grantedFetches } = await watchServe();
    try {
      const thread = `${origin}/threads/t-audit`;
      const partyId = instance.actorId("party");
      publishRaw(instance, "owner", [partyId], thread, "parties", { type: "Create", content: "gated payload" });

      const auditorId = instance.actorId("auditor");
      const grant = auditGrant(
        {
          activityId: `${origin}/activities/grant-1`,
          actor: `${origin}/actor`,
          to: [auditorId],
          thread,
          visibility: "internal",
          published: clock.now().toISOString(),
          prevActivity: null,
        },
        { auditor: auditorId, scope: { thread }, visibilityClasses: ["parties"], expires: "2027-01-01T00:00:00Z" },
      );
      setGrants([grant]);

      const headers = signRequest("GET", "/threads/t-audit/rendering", new URL(origin).host, "", fileSigner(instance.key("auditor")), clock.now());
      const res = await fetch(`${origin}/threads/t-audit/rendering`, { headers: { ...headers } });
      assert.equal(res.status, 200, "the grant admits the auditor");
      assert.equal(grantedFetches.length, 1, "ADR-0013 A5: a grant-admitted fetch is recorded");
      assert.equal(grantedFetches[0].auditor, auditorId);
      assert.equal(grantedFetches[0].path, "/threads/t-audit/rendering");

      // an expired grant admits nothing, and records nothing
      setGrants([{ ...grant, object: { ...(grant.object as { [k: string]: JsonValue }), "afp:expires": "2020-01-01T00:00:00Z" } }]);
      const expiredHeaders = signRequest("GET", "/threads/t-audit/rendering", new URL(origin).host, "", fileSigner(instance.key("auditor")), clock.now());
      const expiredRes = await fetch(`${origin}/threads/t-audit/rendering`, { headers: { ...expiredHeaders } });
      assert.equal(expiredRes.status, 404);
      assert.equal(grantedFetches.length, 1, "no new record for a refused read");
    } finally {
      server.close();
    }
  });

  it("G3(a) — status from a listed controller: 200 with the outbox's own chain head", async () => {
    const { instance, controllerName, workerName, post, server } = await commandServe();
    try {
      const res = await post(controllerName, `/agents/${workerName}/command`, { content: `@${workerName} status` });
      assert.equal(res.status, 200);
      const status = res.body.status as { [k: string]: JsonValue };
      const actorUrl = instance.actorId(workerName);
      assert.equal(status.agent, actorUrl);
      assert.equal(status.chainHead, instance.outbox.headDigest(actorUrl));
      assert.equal(status.pending, 0);
      assert.equal(status.paused, false);
    } finally {
      server.close();
    }
  });

  it("G3(b) — pause: 200, then an Offer to that agent produces a Reject and the brain is never invoked", async () => {
    const { origin, instance, server, controllerName, workerName, post, brain } = await commandServe();
    try {
      const res = await post(controllerName, `/agents/${workerName}/command`, { content: `@${workerName} pause` });
      assert.equal(res.status, 200);
      assert.equal(res.body.paused, true);

      // idempotent
      const again = await post(controllerName, `/agents/${workerName}/command`, { content: `@${workerName} pause` });
      assert.equal(again.body.paused, true);

      const thread = `${origin}/threads/pause-check`;
      instance.delegate({ from: controllerName, to: workerName, capability: "afp:cap:assess", content: "please assess", thread, correlationId: "corr-pause-1" });
      await instance.run();

      assert.equal(brain.invocations, 0, "a paused performer's brain never runs");
      const workerEntries = instance.outbox.byThread(thread).filter((e) => e.actor === instance.actorId(workerName));
      assert.equal(workerEntries.length, 1);
      assert.equal(workerEntries[0].activity.type, "Reject");
      assert.equal(workerEntries[0].activity.summary, "paused by controller");
    } finally {
      server.close();
    }
  });

  it("G3(c) — approve on a thread whose task pins approve/reject: an afp:Act naming the action, reconciled to the controller", async () => {
    const { instance, server, controllerName, workerName, post } = await commandServe();
    try {
      const thread = `${instance.config.origin}/threads/approve-check`;
      const policy = { approve: "release-funds", reject: "close-case", "afp:no-verdict": "close-case" };
      instance.delegate({
        from: controllerName,
        to: workerName,
        capability: "afp:cap:assess",
        content: "release the funds?",
        thread,
        correlationId: "corr-approve-1",
        pins: { actionPolicy: policy },
      });

      const actsOn = `sha256:${"a".repeat(64)}`;
      const res = await post(controllerName, `/agents/${workerName}/command`, { content: "approve", thread, actsOn });
      assert.equal(res.status, 200);
      assert.equal(res.body.approved, true);
      assert.ok(typeof res.body.actuation === "string");
      assert.ok(typeof res.body.reconciliation === "string");

      const actEntry = instance.outbox.byThread(thread).find((e) => e.activity["afp:action"] !== undefined);
      assert.ok(actEntry, "an afp:Act was recorded");
      assert.equal(actEntry!.activity["afp:action"], "release-funds");
      assert.equal(actEntry!.activity["afp:actsOn"], actsOn);

      const reconciliation = instance.outbox.byThread(thread).find((e) => {
        const object = e.activity.object as Record<string, JsonValue> | undefined;
        return object?.type === "afp:Result" && object["afp:reconciles"] !== undefined;
      });
      assert.ok(reconciliation, "a reconciliation was recorded");
      const object = reconciliation!.activity.object as Record<string, JsonValue>;
      assert.equal(object["afp:externalRef"], instance.actorId(controllerName));
    } finally {
      server.close();
    }
  });

  it("G3(d) — an unlisted signer, no signature, and garbage content all get the identical polite reply and change nothing on the chain", async () => {
    const { instance, server, workerName, post, postUnsigned } = await commandServe();
    try {
      const path = `/agents/${workerName}/command`;
      const before = instance.outbox.byActor(instance.actorId(workerName)).length;
      const logBefore = instance.auditLog().length;

      const fromStranger = await post(workerName, path, { content: `@${workerName} status` }); // "worker" is not a controller
      const anonymous = await postUnsigned(path, { content: `@${workerName} status` });
      const injection = await post("controller", path, { content: "@worker pause; rm -rf" });
      const multiline = await post("controller", path, { content: `@${workerName} pause\nand more` });

      for (const res of [fromStranger, anonymous]) {
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, fromStranger.body);
      }
      // A garbage/multiline command from an *authorized* controller still
      // fails to parse and gets the same fixed shape — the polite reply is
      // not conditioned on who sent it, only on whether it parsed.
      assert.equal(injection.status, 200);
      assert.equal(multiline.status, 200);
      assert.deepEqual(injection.body, multiline.body);
      assert.ok(typeof fromStranger.body.reply === "string" && fromStranger.body.reply.length > 0);

      assert.equal(instance.outbox.byActor(instance.actorId(workerName)).length, before, "nothing published for any refused attempt");
      // ADR-0013 Decision 5: only a *verified* signer's refusal is worth a
      // line — an anonymous request is free and unbounded, so logging it
      // would let any stranger write into the operator's store at will.
      // Three verified refusals (fromStranger, injection, multiline); the
      // anonymous one leaves no new row.
      const log = instance.auditLog();
      assert.equal(log.length, logBefore + 3, "the anonymous refusal is answered but not recorded");
      assert.ok(
        log.slice(logBefore).every((row) => row.outcome === "polite-reply"),
        "every verified refusal is recorded with the polite-reply outcome",
      );
    } finally {
      server.close();
    }
  });

  it("G3(e) — the inbox carrier: a Create{Note} mention from the controller executes; from a stranger it is dropped", async () => {
    const { origin, instance, server, controllerName, workerName } = await commandServe();
    try {
      const workerUrl = instance.actorId(workerName);

      const mention = instance.publish(controllerName, [workerUrl], `${origin}/threads/mention-1`, "parties", (envelope) => ({
        "@context": ["https://www.w3.org/ns/activitystreams", "https://dalager.github.io/agent-federation-protocol/ns/v3.jsonld"],
        id: envelope.activityId,
        type: "Create",
        actor: envelope.actor,
        to: [...envelope.to],
        published: envelope.published,
        context: envelope.thread,
        "afp:visibility": envelope.visibility,
        ...(envelope.prevActivity !== null ? { "afp:prevActivity": envelope.prevActivity } : {}),
        object: { type: "Note", content: `@${workerName} status` },
      }));

      const before = instance.outbox.byActor(workerUrl).length;
      const outcome = await instance.receive(mention.activity);
      assert.equal(outcome.status, "dispatched", "an authorized controller's mention is accepted, not dropped");
      assert.equal(instance.outbox.byActor(workerUrl).length, before, "status makes no chain change");

      // From a stranger — here, "worker" itself, a registered agent that is
      // not a controller — the same mention is dropped with a polite-reply
      // audit entry, and nothing is delivered anywhere (Mastodon delivery is
      // ADR-0023 L18, parked).
      const strangerMention = instance.publish(workerName, [workerUrl], `${origin}/threads/mention-2`, "parties", (envelope) => ({
        "@context": ["https://www.w3.org/ns/activitystreams", "https://dalager.github.io/agent-federation-protocol/ns/v3.jsonld"],
        id: envelope.activityId,
        type: "Create",
        actor: envelope.actor,
        to: [...envelope.to],
        published: envelope.published,
        context: envelope.thread,
        "afp:visibility": envelope.visibility,
        ...(envelope.prevActivity !== null ? { "afp:prevActivity": envelope.prevActivity } : {}),
        object: { type: "Note", content: `@${workerName} status` },
      }));
      // The pipeline's own accept/reject (signature valid, actor on roster)
      // is a protocol-level fact and stays "dispatched"; command authorization
      // is a layer above it, recorded on the audit log by `onMention` itself.
      const beforeCommand = instance.outbox.byActor(workerUrl).length;
      const dropped = await instance.receive(strangerMention.activity);
      assert.equal(dropped.status, "dispatched");
      assert.equal(instance.outbox.byActor(workerUrl).length, beforeCommand, "the stranger's mention triggers no command effect");
      const log = instance.auditLog();
      assert.ok(log.some((row) => row.outcome === "polite-reply"), "the polite reply is recorded, never delivered");
    } finally {
      server.close();
    }
  });

  it("G4(a) — the fediverse window off: no shadow Notes in any outbox, and the verifier passes", async () => {
    const { instance, exported, thread } = await freshDemo();
    try {
      for (const name of ["writer", "reviewer"]) {
        const actorUrl = instance.actorId(name);
        for (const entry of instance.outbox.byActor(actorUrl)) {
          assert.notEqual(objectType(entry.activity), "Note", `${name}'s outbox carries no shadow Note with the window off`);
        }
      }
      const clean = runVerifier(VERIFIER, exported.dir, thread);
      assert.equal(clean.code, 0, `the P1 demo's own bundle failed to verify after ADR-0029:\n${clean.output}`);
      assert.match(clean.output, /PASSED/);
    } finally {
      instance.close();
    }
  });

  it("G4(b) — an explicit fediverseWindow: false run has the same sequence counts and activity shapes as the flag's own default", async () => {
    // Two fresh workspaces mint two independent keypairs, so signatures (and
    // therefore digests) legitimately differ between them; what must not
    // differ with the flag off is the *shape* of the record — same sequence
    // length per actor, same ordered (type, object type) pairs, no extra
    // activity spliced in anywhere.
    const control = await freshDemo();
    try {
      const off = await runDemo({ fresh: true, config: { ...workspace(), brain: "stub", fediverseWindow: false } });
      try {
        for (const name of ["writer", "reviewer"]) {
          const controlEntries = control.instance.outbox.byActor(control.instance.actorId(name));
          const offEntries = off.instance.outbox.byActor(off.instance.actorId(name));
          assert.equal(offEntries.length, controlEntries.length, `${name}: same sequence length`);
          assert.deepEqual(
            offEntries.map((e) => [e.activity.type, objectType(e.activity)]),
            controlEntries.map((e) => [e.activity.type, objectType(e.activity)]),
            `${name}: identical shape`,
          );
        }
      } finally {
        off.instance.close();
      }
    } finally {
      control.instance.close();
    }
  });

  it("G5(a) — the window on, a parties event: the shadow carries no gated content, a Link to the machine activity", () => {
    const instance = windowInstance();
    try {
      const thread = `${instance.config.origin}/threads/g5-parties`;
      const secretContent = "the confidential settlement figure is $42,000";
      const offer = instance.delegate({
        from: "delegator",
        to: "performer",
        capability: "afp:cap:assess",
        content: secretContent,
        thread,
        correlationId: "corr-g5-1",
      });

      const delegatorUrl = instance.actorId("delegator");
      const entries = instance.outbox.byActor(delegatorUrl);
      assert.equal(entries.length, 2, "the Offer, plus exactly one shadow — never a shadow of the shadow");
      const shadow = entries[entries.length - 1];

      assert.equal(objectType(shadow.activity), "Note");
      assert.equal(shadow.visibility, "public");
      assert.equal(shadow.activity["afp:shadowOf"], offer.digest);
      assert.equal(shadow.activity["afp:prevActivity"], offer.digest);

      const object = shadow.activity.object as Record<string, JsonValue>;
      const content = String(object.content);
      assert.equal(content.includes(secretContent), false, "no gated Task content leaks into the shadow");
      const attachment = object.attachment as Record<string, JsonValue>;
      assert.equal(attachment.type, "Link");
      assert.equal(attachment.href, offer.activity.id, "the Link points at the machine-readable Offer");

      // A shadow of a shadow does not exist: only one Note in the whole chain.
      const noteCount = entries.filter((e) => objectType(e.activity) === "Note").length;
      assert.equal(noteCount, 1);
    } finally {
      instance.close();
    }
  });

  it("G5(b) — a public Vouch's shadow is itself public (and may carry a summary)", () => {
    const instance = windowInstance();
    try {
      const instanceActorUrl = instance.instanceDocument().id as string;
      const entries = instance.outbox.byActor(instanceActorUrl);
      const vouches = entries.filter((e) => e.activity.type === "afp:Vouch");
      const shadows = entries.filter((e) => objectType(e.activity) === "Note");
      assert.equal(vouches.length, 2, "one Vouch per registered agent");
      assert.equal(shadows.length, vouches.length, "one shadow per Vouch, never a shadow of a shadow");
      for (const shadow of shadows) {
        assert.equal(shadow.visibility, "public");
      }
    } finally {
      instance.close();
    }
  });

  it("G6 — every shipped bundle replayed is unchanged (window off by default)", async () => {
    const { exported, thread } = await freshDemo();
    const clean = runVerifier(VERIFIER, exported.dir, thread);
    assert.equal(clean.code, 0, `the P1 demo's own bundle failed to verify after ADR-0029:\n${clean.output}`);
    assert.match(clean.output, /PASSED/);

    const p8Paths = workspace();
    const p8 = await runP8Demo({ fresh: true, config: { dataDir: p8Paths.dataDir, exportDir: p8Paths.exportDir } });
    try {
      const p8clean = runVerifier(VERIFIER, p8.exported.dir, p8.thread, ["--verbose"]);
      assert.equal(p8clean.code, 0, `demo:p8's own bundle failed to verify after ADR-0029:\n${p8clean.output}`);
      assert.match(p8clean.output, /PASSED/);
    } finally {
      p8.instance.close();
    }
  });
});

// Sanity on the primitives, carried over from WP-2's narrower unit gate —
// not a numbered row on their own, but coverage the G1/G2 routes rest on.
describe("ADR-0029 primitives", () => {
  it("timeline: anonymous sees only public activities; an unknown agent is 404", async () => {
    const { origin, instance, server } = await watchServe();
    try {
      publishRaw(instance, "owner", [], `${origin}/threads/t1`, "public", { type: "Create", content: "public one" });
      publishRaw(instance, "owner", [instance.actorId("party")], `${origin}/threads/t2`, "parties", { type: "Create", content: "hidden" });

      const res = await fetch(`${origin}/agents/owner/timeline`);
      assert.equal(res.status, 200);
      const timeline = (await res.json()) as { "afp:renders": string[] };
      const publicEntries = instance.outbox.byActor(instance.actorId("owner")).filter((e) => e.visibility === "public");
      assert.deepEqual(timeline["afp:renders"], publicEntries.map((e) => digestOf(e.activity)));

      const unknown = await fetch(`${origin}/agents/nope/timeline`);
      assert.equal(unknown.status, 404);
    } finally {
      server.close();
    }
  });

  it("renderThread never emits a parties activity's content into narrative", () => {
    const publicEntry: OutboxEntry = {
      activityId: "https://x/act/1",
      actor: "https://x/agents/a",
      seq: 1,
      thread: "https://x/threads/t",
      digest: "sha256:" + "a".repeat(64),
      prevActivity: null,
      visibility: "public",
      published: "2026-09-13T00:00:00Z",
      activity: { type: "Create", actor: "https://x/agents/a", published: "2026-09-13T00:00:00Z", "afp:visibility": "public", content: "visible line" },
    };
    const partiesEntry: OutboxEntry = {
      activityId: "https://x/act/2",
      actor: "https://x/agents/b",
      seq: 1,
      thread: "https://x/threads/t",
      digest: "sha256:" + "b".repeat(64),
      prevActivity: null,
      visibility: "parties",
      published: "2026-09-13T00:00:01Z",
      activity: { type: "Create", actor: "https://x/agents/b", published: "2026-09-13T00:00:01Z", "afp:visibility": "parties", content: "gated line" },
    };
    const rendering = renderThread([publicEntry, partiesEntry], { thread: "https://x/threads/t", bundle: null, now: "2026-09-13T00:00:02Z" });
    assert.ok(rendering.narrative.some((line) => line.includes("visible line")));
    assert.ok(!rendering.narrative.some((line) => line.includes("gated line")));
  });
});
