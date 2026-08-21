/**
 * ADR-0010 X7 — the claim the whole ADR rests on: the fallback is a **second
 * root, not a second meaning**.
 *
 * The same answer, acted on the same way, must draw the same verdicts from the
 * same named checks whether its policy was pinned in an Announce and reached
 * through the Award chain, or pinned on a direct Offer and reached through the
 * thread. If the two roots could disagree, "checkable" would mean two
 * different words depending on which flow a deployment happened to choose —
 * which is the defect scenario 09 found in the spec, reintroduced one layer
 * down in the implementation.
 *
 * Compared per named check rather than per hand-picked assertion, so a check
 * added to one root and forgotten on the other fails here instead of quietly
 * letting the roots drift apart again.
 *
 *   node --experimental-sqlite --test test/adr0010-parity.test.ts
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { digestOf } from "../src/crypto/proof.ts";
import { vouch, createResult } from "../src/ap/activities.ts";
import type { TaskPins } from "../src/ap/pins.ts";
import { exportBundle } from "../src/export.ts";
import { enroll, type Envelope as HubEnvelope } from "../src/hub/activities.ts";
import { hubTransport } from "../src/hub/hub.ts";
import { bidPayload, commitmentOf, createSynthesis } from "../src/allocation/activities.ts";
import { actionStamp } from "../src/allocation/actions.ts";
import { cleanupWorkspaces, mutateBundle, runVerifier } from "./helpers.ts";
import {
  ACTION_PHRASES,
  CAPABILITY,
  POLICY,
  VERIFIER,
  actionVerdicts,
  publish,
  setupPlain,
  setupWithHub,
} from "./adr0010-fixtures.ts";

after(cleanupWorkspaces);

const mutate = (
  exportDir: string,
  thread: string,
  outboxName: string,
  edit: (outbox: { orderedItems: Record<string, unknown>[] }) => void,
) => mutateBundle(VERIFIER, exportDir, thread, outboxName, edit);

describe("ADR-0010 gate: the auction root and the direct root mean the same thing", () => {
  it("X7 — the auction root and the direct root produce identical action-check verdicts", async () => {
    // --- Root 1: the auction flow. Announce pins the policy/sufficiency;
    // Award derives the synthesizer (the `coverage` rule, over two domains
    // split across two bidders so neither alone covers the task and the
    // Award names a two-performer set — `ranking` derives no synthesizer at
    // all, so it cannot stand in for the pin this ADR generalizes).
    const AUCTION_AGENTS = ["a1", "a2"] as const;
    const {
      instance: auctionInstance,
      config: auctionConfig,
      clock: auctionClock,
      hub,
      hubKeys: auctionHubKeys,
    } = setupWithHub(AUCTION_AGENTS, "screening-auction");
    const transport = hubTransport(hub, auctionInstance.localTransport(), (target) => auctionInstance.nameOf(target) !== null);
    for (const name of AUCTION_AGENTS) {
      auctionInstance.publishAsInstance([hub.actorId], "urn:afp:thread:enroll", "hub", (envelope: HubEnvelope) =>
        enroll(envelope, {
          agent: auctionInstance.actorId(name),
          hub: hub.actorId,
          capabilities: [CAPABILITY],
          hubKey: auctionHubKeys.get(name)!.keyId,
        }),
      );
    }
    await auctionInstance.run(transport);

    const thread = "urn:afp:thread:screen-auction";
    const taskId = "urn:afp:task:screen-auction";
    const window = { opens: auctionClock.now().toISOString(), closes: new Date(auctionClock.now().getTime() + 600_000).toISOString() };
    hub.allocation.announce({
      taskId,
      thread,
      hub: hub.actorId,
      capability: CAPABILITY,
      content: "screen the application",
      correlationId: "screen-auction",
      bidWindow: window,
      selectionRule: { name: "coverage", params: { domains: ["intake", "risk"], minConfidence: 60 } as never },
      answerSufficiency: { count: 2 } as never,
      estimatorPolicy: "exclude",
      estimators: [],
      actionPolicy: POLICY,
    });
    const bids = [
      { name: "a1", coverage: { intake: 90 } },
      { name: "a2", coverage: { risk: 90 } },
    ];
    const payloads: { name: string; payload: { [key: string]: unknown } }[] = [];
    for (const { name, coverage } of bids) {
      const payload = bidPayload({
        task: taskId,
        bidder: auctionInstance.actorId(name),
        capabilityMatch: 80,
        estimatedCost: { unit: "EUR", value: 100 },
        estimatedLatency: "PT1H",
        coverage,
        nonce: `n-${name}`,
      });
      payloads.push({ name, payload });
      await hub.receive(
        auctionInstance.publish(name, [hub.actorId], thread, "hub", (envelope: HubEnvelope) => ({
          "@context": ["https://www.w3.org/ns/activitystreams", "https://afp.example/ns/v3"],
          id: envelope.activityId,
          actor: envelope.actor,
          to: [...envelope.to],
          published: envelope.published,
          context: envelope.thread,
          "afp:visibility": envelope.visibility,
          ...(envelope.prevActivity !== null ? { "afp:prevActivity": envelope.prevActivity } : {}),
          type: "afp:bidCommit",
          object: taskId,
          "afp:hub": hub.actorId,
          "afp:commitment": commitmentOf(payload),
        })).activity,
      );
    }
    auctionClock.jumpTo(new Date(new Date(window.closes).getTime() + 1000).toISOString());
    for (const { name, payload } of payloads) {
      await hub.receive(
        auctionInstance.publish(name, [hub.actorId], thread, "hub", (envelope: HubEnvelope) => ({
          "@context": ["https://www.w3.org/ns/activitystreams", "https://afp.example/ns/v3"],
          id: envelope.activityId,
          actor: envelope.actor,
          to: [...envelope.to],
          published: envelope.published,
          context: envelope.thread,
          "afp:visibility": envelope.visibility,
          ...(envelope.prevActivity !== null ? { "afp:prevActivity": envelope.prevActivity } : {}),
          type: "afp:BidReveal",
          object: { ...payload },
          "afp:hub": hub.actorId,
        })).activity,
      );
    }
    const awarded = hub.allocation.closeAuction(taskId, new Date(auctionClock.now().getTime() + 3600_000).toISOString())!;
    const awardObject = awarded.activity.object as Record<string, unknown>;
    const synthesizerId = awardObject["afp:synthesizer"] as string;
    assert.ok(synthesizerId, "the coverage rule over two split domains must derive a synthesizer");
    const synthesizerName = auctionInstance.nameOf(synthesizerId)!;

    // Multi-performer Award: each performer's Result carries a suffixed
    // variant of the task's correlationId (the Award-scoped shape this
    // ADR's leg-partition check explicitly steps aside for).
    const results = bids.map(({ name }) =>
      auctionInstance.publish(name, [], thread, "parties", (envelope) =>
        createResult(envelope, { resultId: `urn:afp:result:auction-${name}`, correlationId: `screen-auction-${name}`, content: "clean record" }),
      ),
    );
    const synthesis = auctionInstance.publish(synthesizerName, [], thread, "parties", (envelope) =>
      createSynthesis(envelope, {
        synthesisId: "urn:afp:synthesis:screen-auction",
        award: awardObject.id as string,
        method: "panel",
        answer: "cleared for onboarding",
        confidence: 88,
        contributingResults: results.map((r) => digestOf(r.activity)),
        assumptions: [],
        dissent: [],
        category: "afp:screen-ok",
      }),
    );
    const synthesisDigest = digestOf(synthesis.activity);
    publish(auctionInstance, synthesizerName, [], thread, {
      type: "afp:Act",
      object: taskId,
      ...actionStamp("advance", synthesisDigest, { policy: POLICY, category: "afp:screen-ok" }),
    });

    auctionInstance.publishAsInstance([], "urn:afp:thread:roster", "public", (envelope: HubEnvelope) =>
      vouch(envelope, { agent: hub.actorId, capabilities: ["afp:cap:hub"], keyCustody: "self" }),
    );
    const auctionExported = exportBundle(auctionInstance, auctionConfig.exportDir, [hub]);
    const auctionClean = runVerifier(VERIFIER, auctionConfig.exportDir, thread, ["--verbose"]);
    assert.equal(auctionClean.code, 0, `verifier failed:\n${auctionClean.output}`);
    assert.match(auctionClean.output, /action: .*answers within the pinned category set/);
    assert.match(auctionClean.output, /action: .*acts on a producible Synthesis/);
    assert.match(auctionClean.output, /action: .*is the action the answer permitted/);

    // --- Root 2: the direct flow — the same claim, no auction underneath.
    const DIRECT_AGENTS = ["coordinator", "s1"] as const;
    const { instance: directInstance, config: directConfig } = setupPlain(DIRECT_AGENTS);
    const directThread = "urn:afp:thread:screen-auction-parity";
    const directCoordinatorId = directInstance.actorId("coordinator");
    const directPins: TaskPins = {
      actionPolicy: POLICY,
      answerSufficiency: { count: 1 },
      synthesizer: directCoordinatorId,
    };
    directInstance.delegate({
      from: "coordinator",
      to: "s1",
      capability: CAPABILITY,
      content: "screen the application",
      thread: directThread,
      correlationId: "leg-s1",
      pins: directPins,
    });
    const directResult = directInstance.publish("s1", [], directThread, "parties", (envelope) =>
      createResult(envelope, { resultId: "urn:afp:result:direct-parity", correlationId: "leg-s1", content: "clean record" }),
    );
    const directSynthesis = directInstance.publish("coordinator", [], directThread, "parties", (envelope) =>
      createSynthesis(envelope, {
        synthesisId: "urn:afp:synthesis:screen-auction-parity",
        method: "panel",
        answer: "cleared for onboarding",
        confidence: 88,
        contributingResults: [digestOf(directResult.activity)],
        assumptions: [],
        dissent: [],
        category: "afp:screen-ok",
      }),
    );
    const directSynthesisDigest = digestOf(directSynthesis.activity);
    publish(directInstance, "coordinator", [], directThread, {
      type: "afp:Act",
      object: "urn:afp:task:screen-auction-parity",
      ...actionStamp("advance", directSynthesisDigest, { policy: POLICY, category: "afp:screen-ok" }),
    });
    const directExported = exportBundle(directInstance, directConfig.exportDir);
    const directClean = runVerifier(VERIFIER, directConfig.exportDir, directThread, ["--verbose"]);
    assert.equal(directClean.code, 0, `verifier failed:\n${directClean.output}`);
    // Agreement is only worth asserting once both sides are known to have
    // spoken: two empty verdict maps are deep-equal, and would report perfect
    // parity between two roots that checked nothing.
    for (const [label, verdicts] of [
      ["direct", actionVerdicts(directClean.output)],
      ["auction", actionVerdicts(auctionClean.output)],
    ] as const) {
      assert.deepEqual(
        Object.keys(verdicts).sort(),
        [...ACTION_PHRASES].sort(),
        `the ${label} root ran only ${Object.keys(verdicts)} — a check that never ran cannot agree with anything`,
      );
    }
    assert.deepEqual(
      actionVerdicts(directClean.output),
      actionVerdicts(auctionClean.output),
      "the clean direct-flow bundle and the clean auction bundle must agree on every action: verdict",
    );

    // --- The discriminating half: the SAME mutation — an afp:action the
    // pinned policy does not permit for the answered category — applied to
    // both roots must fail the SAME named check, not two different ones and
    // not one root silently.
    const auctionWrongAction = mutate(auctionExported.dir, thread, synthesizerName, (outbox) => {
      for (const activity of outbox.orderedItems) {
        if (activity["afp:actsOn"]) activity["afp:action"] = "hold-for-review";
      }
    });
    assert.notEqual(auctionWrongAction.code, 0);
    assert.match(auctionWrongAction.output, /FAIL \] action: .*is the action the answer permitted/);

    const directWrongAction = mutate(directExported.dir, directThread, "coordinator", (outbox) => {
      for (const activity of outbox.orderedItems) {
        if (activity["afp:actsOn"]) activity["afp:action"] = "hold-for-review";
      }
    });
    assert.notEqual(directWrongAction.code, 0);
    assert.match(directWrongAction.output, /FAIL \] action: .*is the action the answer permitted/);

    assert.deepEqual(
      actionVerdicts(auctionWrongAction.output),
      actionVerdicts(directWrongAction.output),
      "the fallback root is a second root, not a second meaning: the same mutation must produce the same action: verdicts under both",
    );

    auctionInstance.close();
    directInstance.close();
  });
});
