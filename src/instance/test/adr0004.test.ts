/**
 * ADR-0004 acceptance gate: the solo-foundation hardening replays end to end.
 *
 * One flow exercises all three recomputable-record extensions — roles, the
 * asset registry, and pinned reputation — exports the real record, hands it
 * to the independent Python verifier, and then breaks it one named check at
 * a time, exactly like the P1/P3 gates before it.
 */

import assert from "node:assert/strict";
import { readFileSync, writeFileSync, cpSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, describe, it } from "node:test";

import { loadConfig } from "../src/config.ts";
import { AfpInstance, type AgentRegistration } from "../src/instance.ts";
import { jumpClock } from "../src/demoP3.ts";
import { CountingBrain } from "../src/brains/stub.ts";
import { loadOrCreateHubKeyPair, type KeyPair } from "../src/crypto/keys.ts";
import { agentActor } from "../src/ap/documents.ts";
import { vouch } from "../src/ap/activities.ts";
import { exportBundle } from "../src/export.ts";
import { enroll, type Envelope } from "../src/hub/activities.ts";
import { Hub, hubTransport } from "../src/hub/hub.ts";
import { bidPayload, commitmentOf } from "../src/allocation/activities.ts";
import { cleanupWorkspaces, runVerifier, workspace } from "./helpers.ts";

after(cleanupWorkspaces);

const VERIFIER = join(import.meta.dirname, "..", "..", "verifier", "afp_verify.py");
const HUB_ID = "hardened";
const AGENTS = ["m1", "m2", "req", "obs"] as const;
const ROLES: Record<string, "member" | "requester" | "observer" | undefined> = {
  m1: undefined, // defaults to member — the pre-ADR-0004 record shape
  m2: "member",
  req: "requester",
  obs: "observer",
};

function setup() {
  const paths = workspace();
  const config = loadConfig(paths);
  const clock = jumpClock();
  const since = "2026-08-17T00:00:00Z";
  const agents: AgentRegistration[] = AGENTS.map((name) => ({
    spec: { name, capabilities: ["afp:cap:build"], keyCustody: "instance", since },
    brain: new CountingBrain(name, ["afp:cap:build"], () => ({ ok: true, content: "n/a" })),
  }));
  const instance = new AfpInstance(config, agents, clock);

  const hubKeys = new Map<string, KeyPair>();
  for (const name of AGENTS) {
    hubKeys.set(name, loadOrCreateHubKeyPair(config.keyDir, name, instance.actorId(name), HUB_ID));
  }

  let hub!: Hub;
  const fetchActor = (actorId: string) => {
    if (actorId === hub.actorId) return hub.actorDocument();
    if (actorId === instance.instanceDocument().id) return instance.instanceDocument();
    const name = instance.nameOf(actorId);
    if (!name) return null;
    const spec = instance.specs.find((s) => s.name === name)!;
    const hubKey = hubKeys.get(name);
    return agentActor(instance.config.origin, spec, instance.key(name), hubKey ? [hubKey] : []);
  };
  hub = new Hub({
    origin: config.origin,
    hubId: HUB_ID,
    db: instance.db,
    keyDir: config.keyDir,
    instanceActorId: instance.instanceDocument().id as string,
    maxDeliveryAttempts: config.maxDeliveryAttempts,
    backoffBaseMs: config.backoffBaseMs,
    fetchActor,
    now: () => instance.clock.now(),
  });
  return { instance, config, clock, hub, hubKeys };
}

/** Sign-and-shape one activity through an agent's P1 key, AS2 envelope fields included. */
function publish(
  instance: AfpInstance,
  hub: Hub,
  name: string,
  thread: string,
  body: (envelope: Envelope) => { [key: string]: unknown },
) {
  return instance.publish(name, [hub.actorId], thread, "hub", (envelope: Envelope) => ({
    "@context": ["https://www.w3.org/ns/activitystreams", "https://dalager.github.io/agent-federation-protocol/ns/v3.jsonld"],
    id: envelope.activityId,
    actor: envelope.actor,
    to: [...envelope.to],
    published: envelope.published,
    context: envelope.thread,
    "afp:visibility": envelope.visibility,
    ...(envelope.prevActivity !== null ? { "afp:prevActivity": envelope.prevActivity } : {}),
    ...body(envelope),
  }) as never);
}

describe("ADR-0004 acceptance gate: roles, assets, reputation replay end to end", () => {
  it("the export passes the verifier clean, and targeted mutations fail the named checks", async () => {
    const { instance, config, clock, hub, hubKeys } = setup();
    const transport = hubTransport(hub, instance.localTransport(), (target) => instance.nameOf(target) !== null);

    // --- Enrollment with roles.
    for (const name of AGENTS) {
      instance.publishAsInstance([hub.actorId], `${config.origin}/threads/enroll`, "hub", (envelope: Envelope) =>
        enroll(envelope, {
          agent: instance.actorId(name),
          hub: hub.actorId,
          capabilities: ["afp:cap:build"],
          hubKey: hubKeys.get(name)!.keyId,
          role: ROLES[name],
        }),
      );
    }
    await instance.run(transport);
    const [m1, m2, req] = ["m1", "m2", "req"].map((n) => instance.actorId(n));

    // --- A member registers an asset (Decision 2).
    const assetId = `${config.origin}/assets/broker-adapter`;
    await hub.receive(
      publish(instance, hub, "m1", `${config.origin}/threads/assets`, () => ({
        type: "Update",
        "afp:hub": hub.actorId,
        object: {
          id: assetId,
          type: "afp:Asset",
          "afp:version": "3.1",
          "afp:digest": "sha256:asset-bytes",
          attributedTo: m1,
        },
      })).activity,
    );
    assert.ok(hub.assetOf(assetId, "3.1"));

    // --- The requester announces its own ask (Decision 1's inbound path).
    const reqThread = `${config.origin}/threads/req-ask`;
    const reqWindow = {
      opens: clock.now().toISOString(),
      closes: new Date(clock.now().getTime() + 600_000).toISOString(),
    };
    await hub.receive(
      publish(instance, hub, "req", reqThread, () => ({
        type: "Announce",
        object: {
          id: `${config.origin}/tasks/req-ask`,
          type: "afp:Task",
          "afp:hub": hub.actorId,
          "afp:capability": "afp:cap:build",
          "afp:correlationId": "req-ask",
          content: "requester-scoped ask",
          "afp:bidWindow": reqWindow,
          "afp:selectionRule": { name: "ranking", params: { weights: { capabilityMatch: 1 } } },
          "afp:answerSufficiency": { count: 1 },
          "afp:estimatorPolicy": "exclude",
          "afp:estimators": [],
        },
      })).activity,
    );
    assert.equal(hub.allocation.auction(`${config.origin}/tasks/req-ask`)!.requester, req);

    // --- Auction 1 (no reputation): m1's bid claims asset reuse under the seal.
    const t1 = `${config.origin}/tasks/t1`;
    const t1Thread = `${config.origin}/threads/t1`;
    const window1 = {
      opens: clock.now().toISOString(),
      closes: new Date(clock.now().getTime() + 600_000).toISOString(),
    };
    hub.allocation.announce({
      taskId: t1,
      thread: t1Thread,
      hub: hub.actorId,
      capability: "afp:cap:build",
      content: "task one",
      correlationId: "t1",
      bidWindow: window1,
      selectionRule: { name: "ranking", params: { weights: { capabilityMatch: 1 } } as never },
      answerSufficiency: { count: 1 } as never,
      estimatorPolicy: "exclude",
      estimators: [],
    });

    const payloads = new Map<string, { [key: string]: unknown }>();
    const bidOn = async (task: string, thread: string, name: string, capabilityMatch: number, reuse = false) => {
      const payload = bidPayload({
        task,
        bidder: instance.actorId(name),
        capabilityMatch,
        estimatedCost: { unit: "EUR", value: 100 },
        estimatedLatency: "PT1H",
        nonce: `nonce-${task}-${name}`,
        ...(reuse ? { reuses: { asset: assetId, version: "3.1" } } : {}),
      });
      payloads.set(`${task}:${name}`, payload);
      await hub.receive(
        publish(instance, hub, name, thread, () => ({
          type: "afp:BidCommit",
          object: task,
          "afp:hub": hub.actorId,
          "afp:commitment": commitmentOf(payload),
        })).activity,
      );
    };
    const revealOn = async (task: string, thread: string, name: string) => {
      const payload = payloads.get(`${task}:${name}`)!;
      await hub.receive(
        publish(instance, hub, name, thread, () => ({
          type: "afp:BidReveal",
          object: { ...payload },
          "afp:hub": hub.actorId,
        })).activity,
      );
    };

    await bidOn(t1, t1Thread, "m1", 90, true);
    await bidOn(t1, t1Thread, "m2", 80);
    clock.jumpTo(new Date(new Date(window1.closes).getTime() + 1000).toISOString());
    await revealOn(t1, t1Thread, "m1");
    await revealOn(t1, t1Thread, "m2");
    const award1 = hub.allocation.closeAuction(t1, new Date(clock.now().getTime() + 3600_000).toISOString())!;
    assert.deepEqual((award1.activity.object as Record<string, unknown>)["afp:performers"], [m1]);

    // --- Settlement: m1 badly over budget, m2 close and dissent-vindicated.
    hub.allocation.settle(
      t1,
      { [m1]: { unit: "EUR", value: 200 }, [m2]: { unit: "EUR", value: 105 } } as never,
      [m2],
    );

    // Settlement is once per task: a second report — even from the legitimate
    // counterparty — would inject a competing "what actually happened" claim
    // into every later announce's exhaustive reputation snapshot.
    assert.throws(
      () => hub.allocation.settle(t1, { [m1]: { unit: "EUR", value: 999 } } as never),
      /already settled/,
    );

    // --- Auction 2 pins divergence-decay: standing flips the outcome.
    const t2 = `${config.origin}/tasks/t2`;
    const t2Thread = `${config.origin}/threads/t2`;
    const window2 = {
      opens: clock.now().toISOString(),
      closes: new Date(clock.now().getTime() + 600_000).toISOString(),
    };
    const announce2 = hub.allocation.announce({
      taskId: t2,
      thread: t2Thread,
      hub: hub.actorId,
      capability: "afp:cap:build",
      content: "task two",
      correlationId: "t2",
      bidWindow: window2,
      selectionRule: { name: "ranking", params: { weights: { capabilityMatch: 1, reputation: 1 } } as never },
      answerSufficiency: { count: 1 } as never,
      estimatorPolicy: "exclude",
      estimators: [],
      reputationRule: { name: "divergence-decay", params: {} },
    });
    const announce2Object = announce2.activity.object as Record<string, unknown>;
    assert.equal((announce2Object["afp:settlementSnapshot"] as string[]).length, 1, "the snapshot pins the settlement");

    await bidOn(t2, t2Thread, "m1", 90); // m1: 90 + reputation 0 (100% over estimate) = 90
    await bidOn(t2, t2Thread, "m2", 20); // m2: 20 + reputation 120 (95 + dissent bonus 25) = 140
    clock.jumpTo(new Date(new Date(window2.closes).getTime() + 1000).toISOString());
    await revealOn(t2, t2Thread, "m1");
    await revealOn(t2, t2Thread, "m2");
    const award2 = hub.allocation.closeAuction(t2, new Date(clock.now().getTime() + 3600_000).toISOString())!;
    assert.deepEqual(
      (award2.activity.object as Record<string, unknown>)["afp:performers"],
      [m2],
      "standing flips the outcome: 140 beats 90 once the pinned derivation counts",
    );

    // --- The winner's Result closes the reuse loop (afp:reused).
    publish(instance, hub, "m2", t2Thread, (envelope) => ({
      type: "Create",
      object: {
        id: `${config.origin}/results/t2`,
        type: "afp:Result",
        "afp:correlationId": "t2",
        content: "delivered",
        attributedTo: envelope.actor,
        "afp:reused": { asset: assetId, version: "3.1", digest: "sha256:adaptation-bytes" },
      },
    }));

    // --- Guardrails on the writer side.
    assert.throws(
      () =>
        hub.allocation.announce({
          taskId: `${config.origin}/tasks/bad`,
          thread: `${config.origin}/threads/bad`,
          hub: hub.actorId,
          capability: "afp:cap:build",
          content: "x",
          correlationId: "bad",
          bidWindow: window2,
          selectionRule: { name: "ranking", params: { weights: { reputation: 1 } } as never },
          answerSufficiency: {} as never,
          estimatorPolicy: "exclude",
          estimators: [],
        }),
      /no rule, no reputation input/,
    );

    // --- Export the real record and hand it to the independent verifier.
    instance.publishAsInstance([], `${config.origin}/threads/roster`, "public", (envelope: Envelope) =>
      vouch(envelope, { agent: hub.actorId, capabilities: ["afp:cap:hub"], keyCustody: "self" }),
    );
    const exported = exportBundle(instance, config.exportDir, [hub]);
    assert.ok(exported.activities > 0);

    const clean = runVerifier(VERIFIER, config.exportDir, t2Thread, ["--verbose"]);
    assert.equal(clean.code, 0, `verifier failed:\n${clean.output}`);
    assert.match(clean.output, /asset: .*immutable once registered/);
    assert.match(clean.output, /settlement snapshot is exhaustive/);
    assert.match(clean.output, /reputation rule 'divergence-decay' is known/);
    assert.match(clean.output, /reuse reference .*resolves/);
    assert.match(clean.output, /announced by an admissible role/);

    // --- Targeted mutations: one named ADR-0004 check at a time.
    const mutate = (name: string, edit: (outbox: { orderedItems: Record<string, unknown>[] }) => void) => {
      const dir = mkdtempSync(join(tmpdir(), "afp-adr4-mut-"));
      cpSync(exported.dir, dir, { recursive: true });
      const path = join(dir, "outbox", `${name}.jsonld`);
      const outbox = JSON.parse(readFileSync(path, "utf8"));
      edit(outbox);
      outbox.totalItems = outbox.orderedItems.length;
      writeFileSync(path, JSON.stringify(outbox, null, 2));
      return runVerifier(VERIFIER, dir, t2Thread, ["--verbose"]);
    };
    const hubOutbox = `hub-${HUB_ID}`;

    // 1 — the requester's Enroll retconned to observer: its Announce becomes a role violation.
    const observerAnnounce = mutate("instance", (outbox) => {
      for (const activity of outbox.orderedItems) {
        if (activity.type === "afp:Enroll" && activity.object === req) activity["afp:role"] = "observer";
      }
    });
    assert.notEqual(observerAnnounce.code, 0);
    assert.match(observerAnnounce.output, /FAIL \] announce: .*admissible role/);

    // 2 — a second Update mutating a registered (id, version) under a new digest.
    const mutatedAsset = mutate("m1", (outbox) => {
      const update = outbox.orderedItems.find((a) => a.type === "Update")!;
      const clone = JSON.parse(JSON.stringify(update));
      (clone.object as Record<string, unknown>)["afp:digest"] = "sha256:mutated-bytes";
      outbox.orderedItems.push(clone);
    });
    assert.notEqual(mutatedAsset.code, 0);
    assert.match(mutatedAsset.output, /FAIL \] asset: .*immutable once registered/);

    // 3 — a Result claiming reuse of a version nothing registered.
    const danglingReuse = mutate("m2", (outbox) => {
      for (const activity of outbox.orderedItems) {
        const object = activity.object as Record<string, unknown> | undefined;
        if (object?.["afp:reused"]) (object["afp:reused"] as Record<string, unknown>).version = "9.9";
      }
    });
    assert.notEqual(danglingReuse.code, 0);
    assert.match(danglingReuse.output, /FAIL \] asset: .*reuse reference .*resolves/);

    // 4 — a curated snapshot: the hub cherry-picks away the settlement.
    const curated = mutate(hubOutbox, (outbox) => {
      for (const activity of outbox.orderedItems) {
        const object = activity.object as Record<string, unknown> | undefined;
        if (object?.id === t2) object["afp:settlementSnapshot"] = [];
      }
    });
    assert.notEqual(curated.code, 0);
    assert.match(curated.output, /FAIL \] award: .*snapshot is exhaustive/);

    // 5 — an unknown derivation name is a failure, not a skip.
    const unknownRule = mutate(hubOutbox, (outbox) => {
      for (const activity of outbox.orderedItems) {
        const object = activity.object as Record<string, unknown> | undefined;
        if (object?.id === t2) object["afp:reputationRule"] = { name: "vibes", params: {} };
      }
    });
    assert.notEqual(unknownRule.code, 0);
    assert.match(unknownRule.output, /FAIL \] award: .*reputation rule 'vibes' is known/);

    // 6 — a rule pinned without its snapshot: no snapshot, no reputation input.
    const noSnapshot = mutate(hubOutbox, (outbox) => {
      for (const activity of outbox.orderedItems) {
        const object = activity.object as Record<string, unknown> | undefined;
        if (object?.id === t2) delete object["afp:settlementSnapshot"];
      }
    });
    assert.notEqual(noSnapshot.code, 0);
    assert.match(noSnapshot.output, /FAIL \] award: .*travels with its settlement snapshot/);

    // 7 (H8) — strip the hub's authorship from the governing Announce. A
    // requester-authored announce for the same task must not be promoted into
    // its place: the window, rule and snapshot an award is checked against
    // are the hub's terms or they are nobody's.
    const unhubbedAnnounce = mutate(hubOutbox, (outbox) => {
      for (const activity of outbox.orderedItems) {
        const object = activity.object as Record<string, unknown> | undefined;
        if (activity.type === "Announce" && object?.id === t2) activity.actor = req;
      }
    });
    assert.notEqual(unhubbedAnnounce.code, 0);
    assert.match(unhubbedAnnounce.output, /FAIL \] award: .*hub-authored afp:Announce/);

    // 8 (H10) — a mutated asset digest reports the conflict *once*. The
    // passing record used to be derived from the same first-write-wins data
    // as the failing one, so it printed unconditionally, contradicting it.
    const mutatedTwice = mutate("m1", (outbox) => {
      const update = outbox.orderedItems.find((a) => a.type === "Update")!;
      const clone = JSON.parse(JSON.stringify(update));
      (clone.object as Record<string, unknown>)["afp:digest"] = "sha256:rewritten";
      outbox.orderedItems.push(clone);
    });
    const immutabilityRecords = mutatedTwice.output
      .split("\n")
      .filter((line) => /is immutable once registered/.test(line));
    assert.equal(immutabilityRecords.length, 1, `expected one verdict, got:\n${immutabilityRecords.join("\n")}`);
    assert.match(immutabilityRecords[0], /FAIL/);

    instance.close();
  });
});
