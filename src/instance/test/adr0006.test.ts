/**
 * ADR-0006 acceptance gate: checkable actuation replays end to end.
 *
 * One flow: a triage auction pins an action policy, its Synthesis answers
 * within the closed category set, an action hash-binds itself to that answer
 * and does what the policy permits — and the review auction excludes the
 * fix's performer, so the agent that wrote the diff cannot certify it. Then
 * the record is broken one named check at a time.
 *
 *   node --experimental-sqlite --test test/adr0006.test.ts
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
import { digestOf } from "../src/crypto/proof.ts";
import { agentActor } from "../src/ap/documents.ts";
import { vouch } from "../src/ap/activities.ts";
import { exportBundle } from "../src/export.ts";
import { enroll, type Envelope } from "../src/hub/activities.ts";
import { Hub, hubTransport } from "../src/hub/hub.ts";
import { bidPayload, commitmentOf } from "../src/allocation/activities.ts";
import { actionStamp, admissibleAction } from "../src/allocation/actions.ts";
import { cleanupWorkspaces, runVerifier, workspace } from "./helpers.ts";

after(cleanupWorkspaces);

const VERIFIER = join(import.meta.dirname, "..", "..", "verifier", "afp_verify.py");
const HUB_ID = "actuation";
const AGENTS = ["m1", "m2"] as const;

const POLICY = {
  "mechanical-fix": "announce-fix",
  "not-a-bug": "recategorize",
  "needs-elevation": "assign-team",
  // ADR-0010 Decision 4: every pinned policy declares its non-answer action, so
  // a panel that cannot answer still releases whatever waits on it.
  "afp:no-verdict": "request-info",
} as const;

function setup() {
  const paths = workspace();
  const config = loadConfig(paths);
  const clock = jumpClock();
  const agents: AgentRegistration[] = AGENTS.map((name) => ({
    spec: { name, capabilities: ["afp:cap:fix"], keyCustody: "instance", since: "2026-08-17T00:00:00Z" },
    brain: new CountingBrain(name, ["afp:cap:fix"], () => ({ ok: true, content: "n/a" })),
  }));
  const instance = new AfpInstance(config, agents, clock);
  const hubKeys = new Map<string, KeyPair>(
    AGENTS.map((name) => [name, loadOrCreateHubKeyPair(config.keyDir, name, instance.actorId(name), HUB_ID)]),
  );
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

function publish(
  instance: AfpInstance,
  hub: Hub,
  name: string,
  thread: string,
  body: { [key: string]: unknown },
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
    ...body,
  }) as never);
}

describe("ADR-0006 gate: the action policy and the performer wall replay end to end", () => {
  it("clean flow passes; each mutation fails its named check", async () => {
    const { instance, config, clock, hub, hubKeys } = setup();
    const transport = hubTransport(hub, instance.localTransport(), (target) => instance.nameOf(target) !== null);
    for (const name of AGENTS) {
      instance.publishAsInstance([hub.actorId], `${config.origin}/threads/enroll`, "hub", (envelope: Envelope) =>
        enroll(envelope, {
          agent: instance.actorId(name),
          hub: hub.actorId,
          capabilities: ["afp:cap:fix"],
          hubKey: hubKeys.get(name)!.keyId,
        }),
      );
    }
    await instance.run(transport);
    const [m1, m2] = AGENTS.map((n) => instance.actorId(n));

    const runAuction = async (
      taskId: string,
      thread: string,
      bidders: readonly { name: string; match: number }[],
      extras: { [key: string]: unknown } = {},
    ) => {
      const window = {
        opens: clock.now().toISOString(),
        closes: new Date(clock.now().getTime() + 600_000).toISOString(),
      };
      hub.allocation.announce({
        taskId,
        thread,
        hub: hub.actorId,
        capability: "afp:cap:fix",
        content: `work for ${taskId}`,
        correlationId: taskId.split(":").pop()!,
        bidWindow: window,
        selectionRule: { name: "ranking", params: { weights: { capabilityMatch: 1 } } as never },
        answerSufficiency: { count: 1 } as never,
        estimatorPolicy: "exclude",
        estimators: [],
        ...(extras as object),
      });
      const payloads: { name: string; payload: { [key: string]: unknown } }[] = [];
      for (const { name, match } of bidders) {
        const payload = bidPayload({
          task: taskId,
          bidder: instance.actorId(name),
          capabilityMatch: match,
          estimatedCost: { unit: "EUR", value: 100 },
          estimatedLatency: "PT1H",
          nonce: `n-${taskId}-${name}`,
        });
        payloads.push({ name, payload });
        await hub.receive(
          publish(instance, hub, name, thread, {
            type: "afp:BidCommit",
            object: taskId,
            "afp:hub": hub.actorId,
            "afp:commitment": commitmentOf(payload),
          }).activity,
        );
      }
      clock.jumpTo(new Date(new Date(window.closes).getTime() + 1000).toISOString());
      for (const { name, payload } of payloads) {
        await hub.receive(
          publish(instance, hub, name, thread, { type: "afp:BidReveal", object: { ...payload }, "afp:hub": hub.actorId }).activity,
        );
      }
      return hub.allocation.closeAuction(taskId, new Date(clock.now().getTime() + 3600_000).toISOString())!;
    };

    // --- The triage auction pins the action policy; m1 wins.
    const t1 = `${config.origin}/tasks/triage-1`;
    const t1Thread = `${config.origin}/threads/triage-1`;
    const award1 = await runAuction(t1, t1Thread, [{ name: "m1", match: 90 }, { name: "m2", match: 50 }], {
      actionPolicy: POLICY,
    });
    const award1Object = award1.activity.object as Record<string, unknown>;
    assert.deepEqual(award1Object["afp:performers"], [m1]);

    // --- The winner's Synthesis answers within the closed set.
    const synthesis = publish(instance, hub, "m1", t1Thread, {
      type: "Create",
      object: {
        id: `${config.origin}/syntheses/triage-1`,
        type: "afp:Synthesis",
        "afp:award": award1Object.id,
        "afp:method": "triage",
        "afp:answer": "null deref on optional field",
        "afp:confidence": 70,
        "afp:contributingResults": [],
        "afp:assumptions": [],
        "afp:dissent": [],
        "afp:category": "mechanical-fix",
        attributedTo: m1,
      },
    });
    const synthesisDigest = digestOf(synthesis.activity);

    // --- The action: hash-bound to the answer, admissible under the policy.
    assert.equal(admissibleAction(POLICY, "mechanical-fix"), "announce-fix");
    assert.throws(() => admissibleAction(POLICY, "vibes"), /not in the pinned/);
    assert.throws(
      () => actionStamp("recategorize", synthesisDigest, { policy: POLICY, category: "mechanical-fix" }),
      /not admissible/,
    );
    publish(instance, hub, "m2", t1Thread, {
      type: "afp:Act",
      object: t1,
      ...actionStamp("announce-fix", synthesisDigest, { policy: POLICY, category: "mechanical-fix" }),
    });

    // Close the triage thread with a terminal outcome, as the replay demands.
    publish(instance, hub, "m1", t1Thread, {
      type: "Create",
      object: {
        id: `${config.origin}/results/triage-1`,
        type: "afp:Result",
        "afp:correlationId": "triage-1",
        content: "triage complete — see the Synthesis",
        attributedTo: m1,
      },
    });

    // --- The review auction excludes t1's performer: m1's commit is refused.
    const t2 = `${config.origin}/tasks/review-1`;
    assert.throws(
      () =>
        hub.allocation.announce({
          taskId: `${config.origin}/tasks/bad`,
          thread: `${config.origin}/threads/bad`,
          hub: hub.actorId,
          capability: "afp:cap:fix",
          content: "x",
          correlationId: "bad",
          bidWindow: { opens: clock.now().toISOString(), closes: new Date(clock.now().getTime() + 600_000).toISOString() },
          selectionRule: { name: "ranking", params: {} as never },
          answerSufficiency: {} as never,
          estimatorPolicy: "exclude",
          estimators: [],
          excludePerformersOf: [`${config.origin}/tasks/never-awarded`],
        }),
      /no Award to exclude performers of/,
    );
    const award2 = await runAuction(t2, `${config.origin}/threads/review-1`, [{ name: "m1", match: 95 }, { name: "m2", match: 40 }], {
      excludePerformersOf: [t1],
    });
    assert.deepEqual(
      (award2.activity.object as Record<string, unknown>)["afp:performers"],
      [m2],
      "the agent that wrote the fix cannot be the agent that certifies it",
    );
    assert.ok(
      hub.allocation.admissions(t2).some((a) => a.outcome === "rejected" && /performer of/.test(a.reason)),
      "the wall rejection is audit-logged in the estimator lane",
    );

    // --- Export; the independent verifier passes the whole binding.
    instance.publishAsInstance([], `${config.origin}/threads/roster`, "public", (envelope: Envelope) =>
      vouch(envelope, { agent: hub.actorId, capabilities: ["afp:cap:hub"], keyCustody: "self" }),
    );
    const exported = exportBundle(instance, config.exportDir, [hub]);
    const clean = runVerifier(VERIFIER, config.exportDir, t1Thread, ["--verbose"]);
    assert.equal(clean.code, 0, `verifier failed:\n${clean.output}`);
    assert.match(clean.output, /action: .*answers within the pinned category set/);
    assert.match(clean.output, /action: .*acts on a producible justification/);
    assert.match(clean.output, /action: .*is the action the answer permitted/);
    assert.match(clean.output, /award: .*prior-task exclusion .*resolves to an Award/);
    assert.match(clean.output, /award: .*respects prior-performer separation/);

    // --- Mutations, one named check at a time.
    const mutate = (name: string, edit: (outbox: { orderedItems: Record<string, unknown>[] }) => void) => {
      const dir = mkdtempSync(join(tmpdir(), "afp-adr6-mut-"));
      cpSync(exported.dir, dir, { recursive: true });
      const path = join(dir, "outbox", `${name}.jsonld`);
      const outbox = JSON.parse(readFileSync(path, "utf8"));
      edit(outbox);
      outbox.totalItems = outbox.orderedItems.length;
      writeFileSync(path, JSON.stringify(outbox, null, 2));
      return runVerifier(VERIFIER, dir, t1Thread, ["--verbose"]);
    };
    const hubOutbox = `hub-${HUB_ID}`;

    // 1 — an answer outside the closed set.
    const strayCategory = mutate("m1", (outbox) => {
      for (const activity of outbox.orderedItems) {
        const object = activity.object as Record<string, unknown> | undefined;
        if (object?.type === "afp:Synthesis") object["afp:category"] = "vibes";
      }
    });
    assert.notEqual(strayCategory.code, 0);
    assert.match(strayCategory.output, /FAIL \] action: .*answers within the pinned category set/);

    // 2 — the action the policy did not permit.
    const wrongAction = mutate("m2", (outbox) => {
      for (const activity of outbox.orderedItems) {
        if (activity["afp:actsOn"]) activity["afp:action"] = "recategorize";
      }
    });
    assert.notEqual(wrongAction.code, 0);
    assert.match(wrongAction.output, /FAIL \] action: .*is the action the answer permitted/);

    // 3 — a justification the record cannot produce.
    const danglingActsOn = mutate("m2", (outbox) => {
      for (const activity of outbox.orderedItems) {
        if (activity["afp:actsOn"]) activity["afp:actsOn"] = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
      }
    });
    assert.notEqual(danglingActsOn.code, 0);
    assert.match(danglingActsOn.output, /FAIL \] action: .*acts on a producible justification/);

    // 4 — the excluded performer awarded anyway.
    const walledPerformer = mutate(hubOutbox, (outbox) => {
      for (const activity of outbox.orderedItems) {
        const object = activity.object as Record<string, unknown> | undefined;
        if (object?.type === "afp:Award" && object["afp:task"] === t2) object["afp:performers"] = [m1];
      }
    });
    assert.notEqual(walledPerformer.code, 0);
    assert.match(walledPerformer.output, /FAIL \] award: .*respects prior-performer separation/);

    // 5 — an exclusion the record cannot reconstruct.
    const ghostExclusion = mutate(hubOutbox, (outbox) => {
      for (const activity of outbox.orderedItems) {
        const object = activity.object as Record<string, unknown> | undefined;
        if (object?.type === "afp:Task" && object.id === t2) object["afp:excludePerformersOf"] = [`${config.origin}/tasks/ghost`];
      }
    });
    assert.notEqual(ghostExclusion.code, 0);
    assert.match(ghostExclusion.output, /FAIL \] award: .*prior-task exclusion .*resolves to an Award/);

    instance.close();
  });
});
