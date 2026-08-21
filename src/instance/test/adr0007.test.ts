/**
 * ADR-0007 acceptance gate: the retraction replays end to end.
 *
 * Scenario 07's shape: a ratified `safe` answer, an advisory acted on it, the
 * evidence that should have lost, and the retraction — superseding Synthesis,
 * parity round, disposition. Then the record is broken one named check at a
 * time: a retraction of nothing, a quorum un-decided without a quorum, and an
 * orphaned consequence.
 *
 *   node --experimental-sqlite --test test/adr0007.test.ts
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
import { enroll, castVote, type Envelope } from "../src/hub/activities.ts";
import { Hub, hubTransport } from "../src/hub/hub.ts";
import { bidPayload, commitmentOf } from "../src/allocation/activities.ts";
import { actionStamp, dispositionStamp } from "../src/allocation/actions.ts";
import { cleanupWorkspaces, runVerifier, workspace } from "./helpers.ts";

after(cleanupWorkspaces);

const VERIFIER = join(import.meta.dirname, "..", "..", "verifier", "afp_verify.py");
const HUB_ID = "platform";
const AGENTS = ["deps", "api"] as const;
// The `afp:no-verdict` entry is ADR-0010 Decision 4's reserved key: a policy that
// cannot state its non-answer action is not yet a policy.
const POLICY = {
  safe: "publish-advisory",
  unsafe: "publish-warning",
  unclear: "hold",
  "afp:no-verdict": "hold",
} as const;

function setup() {
  const paths = workspace();
  const config = loadConfig(paths);
  const clock = jumpClock();
  const agents: AgentRegistration[] = AGENTS.map((name) => ({
    spec: { name, capabilities: ["afp:cap:assess"], keyCustody: "instance", since: "2026-08-17T00:00:00Z" },
    brain: new CountingBrain(name, ["afp:cap:assess"], () => ({ ok: true, content: "n/a" })),
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

function publish(instance: AfpInstance, hub: Hub, name: string, thread: string, body: { [key: string]: unknown }) {
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

describe("ADR-0007 gate: supersession replays end to end", () => {
  it("the retraction passes clean; each mutation fails its named check", async () => {
    const { instance, config, clock, hub, hubKeys } = setup();
    const transport = hubTransport(hub, instance.localTransport(), (target) => instance.nameOf(target) !== null);
    for (const name of AGENTS) {
      instance.publishAsInstance([hub.actorId], "urn:afp:thread:enroll", "hub", (envelope: Envelope) =>
        enroll(envelope, {
          agent: instance.actorId(name),
          hub: hub.actorId,
          capabilities: ["afp:cap:assess"],
          hubKey: hubKeys.get(name)!.keyId,
        }),
      );
    }
    await instance.run(transport);
    const deps = instance.actorId("deps");

    // --- The question with consequences: policy pinned, auction run.
    const task = "urn:afp:task:libfoo-v4";
    const thread = "urn:afp:thread:libfoo-v4";
    const window = { opens: clock.now().toISOString(), closes: new Date(clock.now().getTime() + 600_000).toISOString() };
    hub.allocation.announce({
      taskId: task,
      thread,
      hub: hub.actorId,
      capability: "afp:cap:assess",
      content: "may client teams upgrade libfoo v3 -> v4?",
      correlationId: "libfoo-v4",
      bidWindow: window,
      selectionRule: { name: "ranking", params: { weights: { capabilityMatch: 1 } } as never },
      answerSufficiency: { count: 1 } as never,
      estimatorPolicy: "exclude",
      estimators: [],
      actionPolicy: POLICY,
    });
    const payload = bidPayload({
      task, bidder: deps, capabilityMatch: 90,
      estimatedCost: { unit: "EUR", value: 100 }, estimatedLatency: "PT1H", nonce: "n-1",
    });
    await hub.receive(publish(instance, hub, "deps", thread, {
      type: "afp:bidCommit", object: task, "afp:hub": hub.actorId, "afp:commitment": commitmentOf(payload),
    }).activity);
    clock.jumpTo(new Date(new Date(window.closes).getTime() + 1000).toISOString());
    await hub.receive(publish(instance, hub, "deps", thread, {
      type: "afp:BidReveal", object: { ...payload }, "afp:hub": hub.actorId,
    }).activity);
    const award = hub.allocation.closeAuction(task, new Date(clock.now().getTime() + 3600_000).toISOString())!;
    const awardId = (award.activity.object as Record<string, unknown>).id;

    // --- The `safe` answer, ratified by a round whose outcome names it.
    const synthesisId = "urn:afp:synthesis:libfoo-v4-safe";
    const safeSynthesis = publish(instance, hub, "deps", thread, {
      type: "Create",
      object: {
        id: synthesisId, type: "afp:Synthesis", "afp:award": awardId,
        "afp:method": "assessment", "afp:answer": "v4 is compatible", "afp:confidence": 80,
        "afp:contributingResults": [], "afp:assumptions": [], "afp:dissent": [],
        "afp:category": "safe", attributedTo: deps,
      },
    });
    const safeDigest = digestOf(safeSynthesis.activity);

    // `priorQuorumSnapshot` is ADR-0011 Decision 3: a round ratifying a
    // *superseding* answer must name the electorate that ratified the answer
    // being withdrawn, so a changed panel is visible rather than implied.
    const ratify = async (round: string, outcomeId: string, priorQuorumSnapshot?: string) => {
      const proposal = hub.proposeRound({ round, thread, question: `Ratify ${outcomeId}?`, options: [outcomeId, "reject"] });
      const snapshot = String((proposal.activity.object as Record<string, unknown>)["afp:quorumSnapshot"]);
      for (const name of AGENTS) {
        await hub.receive(
          instance.publish(name, [hub.actorId], thread, "hub", (envelope: Envelope) =>
            castVote(envelope, { voteId: `${envelope.actor}/votes/${round}`, round, proposalHash: proposal.digest, quorumSnapshot: snapshot, value: outcomeId }),
          ).activity,
        );
      }
      return hub.closeRound(round, priorQuorumSnapshot ? { priorQuorumSnapshot } : undefined);
    };
    const decision1 = await ratify("urn:afp:round:ratify-safe", synthesisId);
    assert.equal((decision1.activity.object as Record<string, unknown>)["afp:outcome"], synthesisId);

    // --- The world moves: the advisory, hash-bound and admissible.
    const advisory = publish(instance, hub, "api", thread, {
      type: "afp:Act",
      object: task,
      ...actionStamp("publish-advisory", safeDigest, { policy: POLICY, category: "safe" }),
    });
    const advisoryDigest = digestOf(advisory.activity);

    // --- The retraction: supersedes + parity round + disposition.
    const unsafeId = "urn:afp:synthesis:libfoo-v4-unsafe";
    const unsafeSynthesis = publish(instance, hub, "deps", thread, {
      type: "Create",
      object: {
        id: unsafeId, type: "afp:Synthesis", "afp:award": awardId,
        "afp:method": "assessment", "afp:answer": "v4 changed a serialization default — do not upgrade", "afp:confidence": 95,
        "afp:contributingResults": [], "afp:assumptions": [], "afp:dissent": [],
        "afp:category": "unsafe", "afp:supersedes": safeDigest, attributedTo: deps,
      },
    });
    const unsafeDigest = digestOf(unsafeSynthesis.activity);
    const safeSnapshot = String((decision1.activity.object as Record<string, unknown>)["afp:quorumSnapshot"]);
    await ratify("urn:afp:round:ratify-unsafe", unsafeId, safeSnapshot);

    publish(instance, hub, "api", thread, {
      type: "afp:Act",
      object: task,
      ...dispositionStamp("publish-warning", advisoryDigest, unsafeDigest, { policy: POLICY, category: "unsafe" }),
    });

    // Terminal outcome for the thread, then export and verify.
    publish(instance, hub, "deps", thread, {
      type: "Create",
      object: { id: "urn:afp:result:libfoo-v4", type: "afp:Result", "afp:correlationId": "libfoo-v4", content: "assessment revised — see the superseding Synthesis", attributedTo: deps },
    });
    instance.publishAsInstance([], "urn:afp:thread:roster", "public", (envelope: Envelope) =>
      vouch(envelope, { agent: hub.actorId, capabilities: ["afp:cap:hub"], keyCustody: "self" }),
    );
    const exported = exportBundle(instance, config.exportDir, [hub]);
    const clean = runVerifier(VERIFIER, config.exportDir, thread, ["--verbose"]);
    assert.equal(clean.code, 0, `verifier failed:\n${clean.output}`);
    assert.match(clean.output, /supersession: .*retracts a producible Synthesis/);
    assert.match(clean.output, /supersession: .*retracts an answer on its own thread/);
    assert.match(clean.output, /supersession: .*ratified, as the answer it retracts was/);
    assert.match(clean.output, /supersession: .*disposed of after its justification was withdrawn/);

    // --- Mutations.
    const mutate = (name: string, edit: (outbox: { orderedItems: Record<string, unknown>[] }) => void) => {
      const dir = mkdtempSync(join(tmpdir(), "afp-adr7-mut-"));
      cpSync(exported.dir, dir, { recursive: true });
      const path = join(dir, "outbox", `${name}.jsonld`);
      const outbox = JSON.parse(readFileSync(path, "utf8"));
      edit(outbox);
      outbox.totalItems = outbox.orderedItems.length;
      writeFileSync(path, JSON.stringify(outbox, null, 2));
      return runVerifier(VERIFIER, dir, thread, ["--verbose"]);
    };

    // 1 — a retraction of nothing.
    const danglingSupersedes = mutate("deps", (outbox) => {
      for (const activity of outbox.orderedItems) {
        const object = activity.object as Record<string, unknown> | undefined;
        if (object?.id === unsafeId) object["afp:supersedes"] = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
      }
    });
    assert.notEqual(danglingSupersedes.code, 0);
    assert.match(danglingSupersedes.output, /FAIL \] supersession: .*retracts a producible Synthesis/);

    // 2 — a quorum's answer un-decided without a quorum: erase the parity round.
    const noParity = mutate(`hub-${HUB_ID}`, (outbox) => {
      for (const activity of outbox.orderedItems) {
        const object = activity.object as Record<string, unknown> | undefined;
        if (object?.type === "afp:DecisionRecord" && object["afp:outcome"] === unsafeId) {
          object["afp:outcome"] = "reject";
        }
      }
    });
    assert.notEqual(noParity.code, 0);
    assert.match(noParity.output, /FAIL \] supersession: .*ratified, as the answer it retracts was/);

    // 3 — the orphaned consequence: the disposition never happened.
    const orphaned = mutate("api", (outbox) => {
      outbox.orderedItems = outbox.orderedItems.filter((a) => !a["afp:disposes"]);
    });
    assert.notEqual(orphaned.code, 0);
    assert.match(orphaned.output, /FAIL \] supersession: .*disposed of after its justification was withdrawn/);

    instance.close();
  });
});
