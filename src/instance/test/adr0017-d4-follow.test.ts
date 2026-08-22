/**
 * ADR-0017 Decision 4: Follow/Accept enrollment at the hub — a live seat
 * (this instance has Followed the hub) gates `afp:Enroll` under
 * `seatPolicy: "follow-required"`; the default policy stays byte-identical
 * to pre-D4 behavior.
 *
 *   node --experimental-sqlite --test test/adr0017-d4-follow.test.ts
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createServer as createProbe } from "node:net";

import { loadConfig } from "../src/config.ts";
import { AfpInstance, type AgentRegistration } from "../src/instance.ts";
import { createHttpServer } from "../src/ap/server.ts";
import { openDb, type Db } from "../src/store/db.ts";
import { enroll } from "../src/hub/activities.ts";
import { Hub } from "../src/hub/hub.ts";
import { admissionLog } from "../src/allocation/store.ts";
import { jumpClock } from "../src/demoP3.ts";
import type { JsonValue } from "../src/crypto/jcs.ts";
import { cleanupWorkspaces, workspace } from "./helpers.ts";

after(cleanupWorkspaces);

const HUB_ID = "seat-hub";

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

function dummyBrain(name: string) {
  return { name, capabilities: ["afp:cap:x"], handle: async () => ({ ok: true as const, content: "n/a" }) };
}

function makeInstance(origin: string, agentName: string) {
  const config = loadConfig({ ...workspace(), origin, operator: origin });
  const registrations: AgentRegistration[] = [
    { spec: { name: agentName, capabilities: ["afp:cap:x"], keyCustody: "instance", since: "2026-08-17T00:00:00Z" }, brain: dummyBrain(agentName) },
  ];
  return new AfpInstance(config, registrations, jumpClock());
}

/** A hub over its own store, resolving actor documents across every instance handed to it. */
function makeHub(instances: readonly AfpInstance[], options: { db: Db; seatPolicy?: "follow-required" | "enroll-implies-seat" }) {
  let hub!: Hub;
  const fetchActor = (actorId: string): { [key: string]: JsonValue } | null => {
    if (hub && actorId === hub.actorId) return hub.actorDocument();
    for (const instance of instances) {
      if (actorId === instance.instanceDocument().id) return instance.instanceDocument();
      const name = instance.nameOf(actorId);
      if (name) return instance.agentDocument(name);
    }
    return null;
  };
  hub = new Hub({
    origin: instances[0].config.origin,
    hubId: HUB_ID,
    db: options.db,
    keyDir: instances[0].config.keyDir,
    instanceActorId: instances[0].instanceDocument().id as string,
    maxDeliveryAttempts: 3,
    backoffBaseMs: 10,
    fetchActor,
    now: () => instances[0].clock.now(),
    seatPolicy: options.seatPolicy,
  });
  return hub;
}

function enrollAgent(instance: AfpInstance, hub: Hub, name: string) {
  const agentId = instance.actorId(name);
  return instance.publishAsInstance([hub.actorId], `${instance.config.origin}/threads/enroll`, "hub", (envelope) =>
    enroll(envelope, { agent: agentId, hub: hub.actorId, capabilities: ["afp:cap:x"], hubKey: instance.key(name).keyId }),
  );
}

describe("ADR-0017 Decision 4: Follow/Accept seats", () => {
  it("Follow establishes a seat, and the hub answers Accept{object: the Follow id, proof present}", async () => {
    const db = openDb(":memory:");
    const instance = makeInstance("https://a.local", "a1");
    const hub = makeHub([instance], { db, seatPolicy: "follow-required" });

    const followEntry = instance.followHub(hub.actorId);
    assert.equal(followEntry.activity.type, "Follow");
    assert.equal(followEntry.activity.object, hub.actorId);

    const outcome = await hub.receive(followEntry.activity);
    assert.equal(outcome.status, "dispatched");
    assert.ok(hub.followers().includes(instance.instanceDocument().id as string), "the follower now holds a seat");

    const accepted = hub.outbox.byActor(hub.actorId).find((e) => e.activity.type === "Accept");
    assert.ok(accepted, "the hub published an Accept");
    assert.equal(accepted!.activity.object, followEntry.activity.id, "Accept.object is the Follow activity id");
    assert.deepEqual(accepted!.activity.to, [instance.instanceDocument().id]);
    assert.ok(accepted!.activity.proof, "the Accept carries a proof");
    assert.equal(accepted!.activity["afp:visibility"], "public");
  });

  it("Enroll without a seat is rejected under follow-required — the admission log names the reason", async () => {
    const db = openDb(":memory:");
    const instance = makeInstance("https://b.local", "b1");
    const hub = makeHub([instance], { db, seatPolicy: "follow-required" });

    const enrollEntry = enrollAgent(instance, hub, "b1");
    const outcome = await hub.receive(enrollEntry.activity);
    assert.equal(outcome.status, "dispatched", "the Enroll's own signature still verifies");
    assert.ok(!hub.members().includes(instance.actorId("b1")), "enrollment was refused for lack of a seat");

    const agentId = instance.actorId("b1");
    const log = admissionLog(db, agentId);
    assert.ok(log.length > 0, "the refusal is on the record");
    assert.equal(log.at(-1)!.outcome, "rejected");
    assert.match(log.at(-1)!.reason, /no seat/);
    assert.match(log.at(-1)!.reason, /ADR-0017 D4/);
  });

  it("Follow then Enroll seats and enrolls; /hubs/:id/followers lists the instance over HTTP", async () => {
    const db = openDb(":memory:");
    const instance = makeInstance("https://c.local", "c1");
    const hub = makeHub([instance], { db, seatPolicy: "follow-required" });

    await hub.receive(instance.followHub(hub.actorId).activity);
    const enrollOutcome = await hub.receive(enrollAgent(instance, hub, "c1").activity);
    assert.equal(enrollOutcome.status, "dispatched");
    assert.ok(hub.members().includes(instance.actorId("c1")), "Enroll succeeds once seated");

    const port = await freePort();
    const server = createHttpServer(instance, {
      hubs: [{ hubId: HUB_ID, actorDocument: () => hub.actorDocument(), followers: () => hub.followers() }],
    });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${port}/hubs/${HUB_ID}/followers`);
      assert.equal(response.status, 200);
      const collection = (await response.json()) as { type: string; orderedItems: string[] };
      assert.equal(collection.type, "OrderedCollection");
      assert.deepEqual(collection.orderedItems, [instance.instanceDocument().id]);
    } finally {
      server.close();
    }
  });

  it("Undo{Follow} revokes the seat and mass-unenrolls only that instance's agents", async () => {
    const db = openDb(":memory:");
    const instanceA = makeInstance("https://d.local", "d1");
    const instanceB = makeInstance("https://e.local", "e1");
    const hub = makeHub([instanceA, instanceB], { db, seatPolicy: "follow-required" });

    await hub.receive(instanceA.followHub(hub.actorId).activity);
    await hub.receive(instanceB.followHub(hub.actorId).activity);
    await hub.receive(enrollAgent(instanceA, hub, "d1").activity);
    await hub.receive(enrollAgent(instanceB, hub, "e1").activity);
    assert.ok(hub.members().includes(instanceA.actorId("d1")));
    assert.ok(hub.members().includes(instanceB.actorId("e1")));

    const undoEntry = instanceA.unfollowHub(hub.actorId);
    assert.equal(undoEntry.activity.type, "Undo");
    const undoOutcome = await hub.receive(undoEntry.activity);
    assert.equal(undoOutcome.status, "dispatched");

    assert.ok(!hub.followers().includes(instanceA.instanceDocument().id as string), "the seat is revoked");
    assert.ok(!hub.members().includes(instanceA.actorId("d1")), "d1 was mass-unenrolled");
    assert.ok(hub.members().includes(instanceB.actorId("e1")), "e1, a different operator's agent, is untouched");
    assert.ok(hub.followers().includes(instanceB.instanceDocument().id as string), "B's seat is untouched");
  });

  it("re-Following after Undo revives the same seat", async () => {
    const db = openDb(":memory:");
    const instance = makeInstance("https://f.local", "f1");
    const hub = makeHub([instance], { db, seatPolicy: "follow-required" });
    const selfId = instance.instanceDocument().id as string;

    await hub.receive(instance.followHub(hub.actorId).activity);
    await hub.receive(instance.unfollowHub(hub.actorId).activity);
    assert.ok(!hub.followers().includes(selfId));

    await hub.receive(instance.followHub(hub.actorId).activity);
    assert.ok(hub.followers().includes(selfId), "re-Follow revives the seat");

    const enrollOutcome = await hub.receive(enrollAgent(instance, hub, "f1").activity);
    assert.equal(enrollOutcome.status, "dispatched");
    assert.ok(hub.members().includes(instance.actorId("f1")), "the revived seat admits Enroll");
  });

  it("default seatPolicy (enroll-implies-seat) still enrolls without any Follow — the compat proof", async () => {
    const db = openDb(":memory:");
    const instance = makeInstance("https://g.local", "g1");
    const hub = makeHub([instance], { db }); // no seatPolicy — default

    const outcome = await hub.receive(enrollAgent(instance, hub, "g1").activity);
    assert.equal(outcome.status, "dispatched");
    assert.ok(hub.members().includes(instance.actorId("g1")), "byte-identical to pre-D4: Enroll alone still admits");
  });

  it("/actor/following lists the hub after followHub", async () => {
    const port = await freePort();
    const config = loadConfig({ ...workspace(), origin: `http://127.0.0.1:${port}` });
    const registrations: AgentRegistration[] = [
      { spec: { name: "h1", capabilities: ["afp:cap:x"], keyCustody: "instance", since: "2026-08-17T00:00:00Z" }, brain: dummyBrain("h1") },
    ];
    const instance = new AfpInstance(config, registrations, jumpClock());
    const server = createHttpServer(instance);
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    try {
      const hubActorId = "https://elsewhere.local/hubs/some-hub";
      instance.followHub(hubActorId);

      const response = await fetch(`http://127.0.0.1:${port}/actor/following`);
      assert.equal(response.status, 200);
      const collection = (await response.json()) as { type: string; orderedItems: string[] };
      assert.equal(collection.type, "OrderedCollection");
      assert.deepEqual(collection.orderedItems, [hubActorId]);
    } finally {
      server.close();
    }
  });
});
