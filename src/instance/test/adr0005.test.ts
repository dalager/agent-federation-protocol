/**
 * ADR-0005 acceptance gate: operators are equal against a hub.
 *
 * Two operators, deliberately lopsided — Alpha runs one agent, Beta runs
 * three. Under the uniform per-agent weight this replaces, Beta would carry
 * three votes to Alpha's one and could decide every round by hiring, which is
 * the cheapest attack on a consortium there is: no reasoning required, and
 * indistinguishable in the record from enthusiastic participation.
 *
 *   node --experimental-sqlite --test test/adr0005.test.ts
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { loadConfig } from "../src/config.ts";
import { AfpInstance, type AgentRegistration } from "../src/instance.ts";
import { fixedClock } from "../src/demo.ts";
import { CountingBrain } from "../src/brains/stub.ts";
import { loadOrCreateHubKeyPair, type KeyPair } from "../src/crypto/keys.ts";
import { agentActor } from "../src/ap/documents.ts";
import { enroll, type Envelope } from "../src/hub/activities.ts";
import { Hub } from "../src/hub/hub.ts";
import { cleanupWorkspaces, workspace } from "./helpers.ts";

after(cleanupWorkspaces);

const HUB_ID = "consortium";

/** One operator: its own origin, its own keys, its own agents. */
function operator(origin: string, agentNames: readonly string[]) {
  const config = loadConfig({ ...workspace(), origin });
  const agents: AgentRegistration[] = agentNames.map((name) => ({
    spec: { name, capabilities: ["afp:cap:vote"], keyCustody: "instance", since: "2026-08-17T00:00:00Z" },
    brain: new CountingBrain(name, ["afp:cap:vote"], () => ({ ok: true, content: "n/a" })),
  }));
  const instance = new AfpInstance(config, agents, fixedClock());
  const hubKeys = new Map<string, KeyPair>(
    agentNames.map((name) => [name, loadOrCreateHubKeyPair(config.keyDir, name, instance.actorId(name), HUB_ID)]),
  );
  return { config, instance, hubKeys, agentNames };
}

type Operator = ReturnType<typeof operator>;

/** Resolve any actor document either operator publishes — the hub holds no keys of its own for them. */
function actorResolver(hub: () => Hub, operators: readonly Operator[]) {
  return (actorId: string): { [key: string]: never } | null => {
    if (actorId === hub().actorId) return hub().actorDocument() as never;
    for (const op of operators) {
      if (actorId === op.instance.instanceDocument().id) return op.instance.instanceDocument() as never;
      const name = op.instance.nameOf(actorId);
      if (!name) continue;
      const spec = op.instance.specs.find((s) => s.name === name)!;
      const hubKey = op.hubKeys.get(name);
      return agentActor(op.config.origin, spec, op.instance.key(name), hubKey ? [hubKey] : []) as never;
    }
    return null;
  };
}

/** An operator enrolls one of its own agents — the only enrollment ADR-0005 admits. */
function enrolls(op: Operator, hub: Hub, name: string, role?: "member" | "requester" | "observer") {
  return op.instance.publishAsInstance([hub.actorId], "urn:afp:thread:enroll", "hub", (envelope: Envelope) =>
    enroll(envelope, {
      agent: op.instance.actorId(name),
      hub: hub.actorId,
      capabilities: ["afp:cap:vote"],
      hubKey: op.hubKeys.get(name)!.keyId,
      role,
    }),
  );
}

describe("ADR-0005 gate: operators are equal against a hub", () => {
  it("one agent weighs as much as three, when the three share an operator", async () => {
    const alpha = operator("https://alpha.operator.local", ["a1"]);
    const beta = operator("https://beta.operator.local", ["b1", "b2", "b3", "b4"]);

    let hub!: Hub;
    hub = new Hub({
      origin: alpha.config.origin,
      hubId: HUB_ID,
      db: alpha.instance.db,
      keyDir: alpha.config.keyDir,
      instanceActorId: alpha.instance.instanceDocument().id as string,
      maxDeliveryAttempts: alpha.config.maxDeliveryAttempts,
      backoffBaseMs: alpha.config.backoffBaseMs,
      fetchActor: actorResolver(() => hub, [alpha, beta]),
      now: () => alpha.instance.clock.now(),
    });

    // Each operator enrolls its own agents, signed by itself.
    await hub.receive(enrolls(alpha, hub, "a1").activity);
    for (const name of ["b1", "b2", "b3"]) await hub.receive(enrolls(beta, hub, name).activity);

    const a1 = alpha.instance.actorId("a1");
    const [b1, b2, b3, b4] = beta.agentNames.map((n) => beta.instance.actorId(n));
    assert.deepEqual([...hub.members()].sort(), [a1, b1, b2, b3].sort(), "all four are enrolled");
    assert.equal(hub.instanceOf(a1), alpha.instance.instanceDocument().id, "the enrolling operator is on the record");
    assert.equal(hub.instanceOf(b1), beta.instance.instanceDocument().id);

    // --- The round: four voters, two operators, equal say.
    const proposal = hub.proposeRound({
      round: "urn:afp:round:equal-1",
      thread: "urn:afp:thread:equal-1",
      question: "Whose weight decides?",
      options: ["alpha", "beta"],
    });
    const weights = (proposal.activity.object as Record<string, unknown>)["afp:voterWeights"] as Record<string, number>;

    assert.equal(weights[a1], 3, "Alpha's lone agent carries its operator's whole seat");
    assert.deepEqual([weights[b1], weights[b2], weights[b3]], [1, 1, 1], "Beta's three split theirs");
    assert.equal(weights[a1], weights[b1] + weights[b2] + weights[b3], "one operator, one weight");

    // Every weight is a whole number — the JCS numeric profile forbids
    // anything else in a document that gets signed.
    for (const w of Object.values(weights)) assert.ok(Number.isInteger(w), `weight ${w} is not an integer`);

    // --- Hiring buys nothing. Beta enrols a fourth agent and re-opens.
    await hub.receive(enrolls(beta, hub, "b4").activity);
    assert.ok(hub.members().includes(b4), "the fourth agent really is enrolled — or the next assertion proves nothing");

    const after2 = hub.proposeRound({
      round: "urn:afp:round:equal-2",
      thread: "urn:afp:thread:equal-2",
      question: "And now?",
      options: ["alpha", "beta"],
    });
    const w2 = (after2.activity.object as Record<string, unknown>)["afp:voterWeights"] as Record<string, number>;
    assert.equal(Object.keys(w2).length, 5, "five voters now");
    const betaTotal = [b1, b2, b3, b4].reduce((sum, agent) => sum + w2[agent], 0);
    assert.equal(w2[a1], betaTotal, "a fourth Beta agent still does not outweigh Alpha's one");
    assert.deepEqual([w2[b1], w2[b2], w2[b3], w2[b4]], [1, 1, 1, 1], "Beta's seat now splits four ways");
    assert.equal(w2[a1], 4, "Alpha's single agent absorbs the whole seat, whatever Beta's headcount");

    alpha.instance.close();
    beta.instance.close();
  });

  it("refuses an enrollment issued by anyone but the agent's own operator", async () => {
    const alpha = operator("https://alpha.operator.local", ["a1"]);
    const beta = operator("https://beta.operator.local", ["b1"]);

    let hub!: Hub;
    hub = new Hub({
      origin: alpha.config.origin,
      hubId: HUB_ID,
      db: alpha.instance.db,
      keyDir: alpha.config.keyDir,
      instanceActorId: alpha.instance.instanceDocument().id as string,
      maxDeliveryAttempts: alpha.config.maxDeliveryAttempts,
      backoffBaseMs: alpha.config.backoffBaseMs,
      fetchActor: actorResolver(() => hub, [alpha, beta]),
      now: () => alpha.instance.clock.now(),
    });

    const b1 = beta.instance.actorId("b1");

    // Alpha tries to enroll one of Beta's agents — validly signed by Alpha,
    // and refused anyway: a signature is not an entitlement to enroll.
    const poached = alpha.instance.publishAsInstance([hub.actorId], "urn:afp:thread:enroll", "hub", (envelope: Envelope) =>
      enroll(envelope, { agent: b1, hub: hub.actorId, capabilities: ["afp:cap:vote"], hubKey: "x", role: "member" }),
    );
    const outcome = await hub.receive(poached.activity);
    assert.equal(outcome.status, "dispatched", "the signature itself verifies — this is an authority failure, not a forgery");
    assert.ok(!hub.members().includes(b1), "Beta's agent is not enrolled by Alpha");

    // An agent enrolling itself as a member is the self-promotion this closes.
    const selfEnroll = beta.instance.publish("b1", [hub.actorId], "urn:afp:thread:enroll", "hub", (envelope: Envelope) =>
      enroll(envelope, { agent: b1, hub: hub.actorId, capabilities: ["afp:cap:vote"], hubKey: "x", role: "member" }),
    );
    await hub.receive(selfEnroll.activity);
    assert.ok(!hub.members().includes(b1), "an agent cannot enroll itself");

    // Beta enrolling its own agent is admitted.
    await hub.receive(enrolls(beta, hub, "b1").activity);
    assert.ok(hub.members().includes(b1), "the agent's own operator may enroll it");

    alpha.instance.close();
    beta.instance.close();
  });
});
