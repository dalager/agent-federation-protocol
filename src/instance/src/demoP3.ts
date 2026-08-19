/**
 * The P3 demo: local allocation (05 § P3, ADR-0003).
 *
 * Two auctions on one hub. A `ranking` auction picks a single load-test
 * performer; a `coverage` auction over four estimation domains awards a
 * two-agent coalition plus a deterministically named synthesizer (scenario
 * 04 — federated estimation). Sealed commit-reveal bidding, an explicit
 * decline, an estimator excluded at admission, a Synthesis ratified by an L0
 * round, and a Settlement linking estimates to actuals — all exported for the
 * Python verifier to recompute end to end.
 */

import { rmSync } from "node:fs";
import { loadConfig, type Config } from "./config.ts";
import { AfpInstance, type AgentRegistration, type Clock } from "./instance.ts";
import { CountingBrain } from "./brains/stub.ts";
import { exportBundle, type ExportSummary } from "./export.ts";
import { agentActor } from "./ap/documents.ts";
import { acceptTask, createResult, rejectTask, vouch } from "./ap/activities.ts";
import { loadOrCreateHubKeyPair, type KeyPair } from "./crypto/keys.ts";
import { enroll, castVote } from "./hub/activities.ts";
import { bidCommit, bidPayload, bidReveal, commitmentOf, createSynthesis, type BidFields } from "./allocation/activities.ts";
import { Hub, hubTransport } from "./hub/hub.ts";
import type { OutboxEntry } from "./store/outbox.ts";
import type { Transport } from "./store/queue.ts";

const HUB_ID = "estimation-hub";
const DOMAINS = ["infra", "data", "compliance", "licensing"];

/** A stepping clock the demo can jump forward — bid windows are real instants. */
export function jumpClock(start = "2026-08-17T09:00:00.000Z", stepMs = 1000) {
  let t = new Date(start).getTime();
  return {
    now: () => new Date((t += stepMs)),
    jumpTo(iso: string) {
      t = Math.max(t, new Date(iso).getTime());
    },
  };
}

/**
 * name → declared coverage (domain → confidence, in percent) for the
 * estimation bidders. Percent, not fractions: the AFP JCS profile forbids
 * non-integer numbers in signed documents, so every fractional quantity on
 * the wire is a scaled integer.
 */
const COVERAGE: Record<string, Record<string, number>> = {
  "a-infra": { infra: 90, data: 70 },
  "a-data": { data: 90 },
  "b-compliance": { compliance: 80, licensing: 50 },
  "b-licensing": { licensing: 90, compliance: 65 },
  "c-generalist": { infra: 65, data: 60, compliance: 60, licensing: 55 },
};

const RANKING_BIDS: Record<string, Omit<BidFields, "task" | "bidder" | "nonce" | "coverage">> = {
  "a-infra": { capabilityMatch: 80, estimatedCost: { unit: "afp:compute-unit", value: 140 }, estimatedLatency: "PT6M" },
  "a-data": { capabilityMatch: 95, estimatedCost: { unit: "afp:compute-unit", value: 120 }, estimatedLatency: "PT4M" },
  "c-generalist": { capabilityMatch: 70, estimatedCost: { unit: "afp:compute-unit", value: 90 }, estimatedLatency: "PT3M" },
};

/**
 * `afp:estimatedCost` on these bids is what performing the estimation work
 * costs the bidder (compute units) — never the migration-cost answer itself,
 * which lives in the Synthesis (03 "Precision": do not conflate them).
 */
const ESTIMATE_BIDS: Record<string, { cost: number; latency: string }> = {
  "a-infra": { cost: 30, latency: "PT2H" },
  "a-data": { cost: 25, latency: "PT1H" },
  "b-compliance": { cost: 20, latency: "PT3H" },
  "b-licensing": { cost: 35, latency: "PT4H" },
  "c-generalist": { cost: 60, latency: "PT8H" },
};

export interface P3DemoResult {
  instance: AfpInstance;
  hub: Hub;
  rankingAward: OutboxEntry;
  coverageAward: OutboxEntry;
  synthesis: OutboxEntry;
  ratification: OutboxEntry;
  settlement: OutboxEntry;
  exported: ExportSummary;
  threads: { ranking: string; estimate: string };
}

export async function runP3Demo(
  options: { fresh?: boolean; config?: Partial<Config>; clock?: Clock & { jumpTo(iso: string): void } } = {},
): Promise<P3DemoResult> {
  const config = loadConfig(options.config);
  if (options.fresh) rmSync(config.dataDir, { recursive: true, force: true });
  const clock = options.clock ?? jumpClock();

  const since = "2026-08-17T00:00:00Z";
  const names = [...Object.keys(COVERAGE), "d-secops", "e-estimator"];
  const agents: AgentRegistration[] = names.map((name) => ({
    spec: { name, capabilities: ["afp:cap:estimate"], keyCustody: "instance" as const, since },
    brain: new CountingBrain(name, ["afp:cap:estimate"], () => ({ ok: true, content: "n/a" })),
  }));
  const instance = new AfpInstance(config, agents, clock);

  const hubKeys = new Map<string, KeyPair>();
  for (const name of names) {
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
    instanceActorId: String(instance.instanceDocument().id),
    maxDeliveryAttempts: config.maxDeliveryAttempts,
    backoffBaseMs: config.backoffBaseMs,
    fetchActor,
    now: () => instance.clock.now(),
  });
  const transport: Transport = hubTransport(hub, instance.localTransport(), (t) => instance.nameOf(t) !== null);

  for (const name of names) {
    instance.publishAsInstance([hub.actorId], "urn:afp:thread:enroll", "hub", (envelope) =>
      enroll(envelope, {
        agent: instance.actorId(name),
        hub: hub.actorId,
        capabilities: ["afp:cap:estimate"],
        hubKey: hubKeys.get(name)!.keyId,
      }),
    );
  }
  await instance.run(transport);

  const runAuction = async (auction: {
    slug: string;
    thread: string;
    capability: string;
    content: string;
    rule: { name: string; params: { [key: string]: unknown } };
    sufficiency: { [key: string]: unknown };
    bidders: string[];
    bidOf: (name: string) => BidFields;
    windowCloses: string;
  }) => {
    const taskId = `${hub.actorId}/tasks/${auction.slug}`;
    hub.allocation.announce({
      taskId,
      thread: auction.thread,
      hub: hub.actorId,
      capability: auction.capability,
      content: auction.content,
      correlationId: auction.slug,
      bidWindow: { opens: "2026-08-17T09:00:00.000Z", closes: auction.windowCloses },
      selectionRule: auction.rule as never,
      answerSufficiency: auction.sufficiency as never,
      estimatorPolicy: "exclude",
      estimators: [instance.actorId("e-estimator")],
    });

    // Sealed phase: commits only. The estimator tries anyway and is rejected
    // at admission (Decision 6); d-secops declines on the record (03).
    const payloads = new Map<string, { [key: string]: never }>();
    for (const name of auction.bidders) {
      const payload = bidPayload(auction.bidOf(name));
      payloads.set(name, payload as never);
      instance.publish(name, [hub.actorId], auction.thread, "hub", (envelope) =>
        bidCommit(envelope, { task: taskId, hub: hub.actorId, commitment: commitmentOf(payload) }),
      );
    }
    const estimatorPayload = bidPayload({
      task: taskId, bidder: instance.actorId("e-estimator"), capabilityMatch: 90,
      estimatedCost: { unit: "afp:compute-unit", value: 10 }, estimatedLatency: "PT1H", nonce: `nonce-e-${auction.slug}`,
    });
    instance.publish("e-estimator", [hub.actorId], auction.thread, "hub", (envelope) =>
      bidCommit(envelope, { task: taskId, hub: hub.actorId, commitment: commitmentOf(estimatorPayload) }),
    );
    instance.publish("d-secops", [hub.actorId], auction.thread, "hub", (envelope) =>
      rejectTask(envelope, taskId, auction.slug, "not my domain: security operations, not estimation"),
    );
    await instance.run(transport);

    // Reveal phase, after the window closes.
    clock.jumpTo(auction.windowCloses);
    for (const name of auction.bidders) {
      instance.publish(name, [hub.actorId], auction.thread, "hub", (envelope) =>
        bidReveal(envelope, { hub: hub.actorId, payload: payloads.get(name)! }),
      );
    }
    await instance.run(transport);

    const awardEntry = hub.allocation.closeAuction(taskId, new Date(clock.now().getTime() + 600_000).toISOString())!;
    const awardObject = awardEntry.activity.object as Record<string, never>;
    const performers = (awardObject["afp:performers"] as string[]).map((url) => instance.nameOf(url)!);

    // The v1 flow, seeded by a Bid instead of a direct Offer (03 step 4). Each
    // performer's leg is its own task, so a coalition never reuses one
    // correlationId across performers (03 § Correlation vs. threading).
    const results = new Map<string, OutboxEntry>();
    for (const name of performers) {
      instance.publish(name, [hub.actorId], auction.thread, "hub", (envelope) =>
        acceptTask(envelope, String(awardObject.id), `${auction.slug}--${name}`),
      );
      results.set(
        name,
        instance.publish(name, [hub.actorId], auction.thread, "hub", (envelope) =>
          createResult(envelope, {
            resultId: `${envelope.actor}/results/${auction.slug}`,
            correlationId: `${auction.slug}--${name}`,
            content: `partial answer from ${name} for ${auction.slug}`,
            producedBy: "stub-brain/1",
          }),
        ),
      );
    }
    await instance.run(transport);
    return { taskId, awardEntry, awardObject, performers, results };
  };

  const ranking = await runAuction({
    slug: "load-42",
    thread: "urn:afp:thread:load-test",
    capability: "afp:cap:load-test",
    content: "Run the checkout load test against staging",
    rule: { name: "ranking", params: { weights: { capabilityMatch: 10, cost: -1, latencySeconds: -1 } } },
    sufficiency: { count: 1 },
    bidders: Object.keys(RANKING_BIDS),
    bidOf: (name) => ({
      task: `${hub.actorId}/tasks/load-42`,
      bidder: instance.actorId(name),
      nonce: `nonce-${name}-load-42`,
      ...RANKING_BIDS[name],
    }),
    windowCloses: "2026-08-17T09:10:00.000Z",
  });

  const estimate = await runAuction({
    slug: "q-88",
    thread: "urn:afp:thread:q-88-migration-estimate",
    capability: "afp:cap:estimate",
    content: "Estimate the total cost of the payments-platform migration",
    rule: { name: "coverage", params: { domains: DOMAINS, minConfidence: 60 } },
    sufficiency: { coverage: DOMAINS, count: 2 },
    bidders: Object.keys(COVERAGE),
    bidOf: (name) => ({
      task: `${hub.actorId}/tasks/q-88`,
      bidder: instance.actorId(name),
      capabilityMatch: 80,
      estimatedCost: { unit: "afp:compute-unit", value: ESTIMATE_BIDS[name].cost },
      estimatedLatency: ESTIMATE_BIDS[name].latency,
      coverage: COVERAGE[name],
      nonce: `nonce-${name}-q-88`,
    }),
    windowCloses: "2026-08-17T09:30:00.000Z",
  });

  // The synthesizer the Award names reconciles the partial answers (04).
  const synthesizerName = instance.nameOf(String(estimate.awardObject["afp:synthesizer"]))!;
  const dissenter = estimate.performers.find((name) => name !== synthesizerName) ?? synthesizerName;
  const synthesis = instance.publish(synthesizerName, [hub.actorId], "urn:afp:thread:q-88-migration-estimate", "hub", (
    envelope,
  ) =>
    createSynthesis(envelope, {
      synthesisId: `${envelope.actor}/syntheses/q-88`,
      award: String(estimate.awardObject.id),
      method: "sum-of-disjoint-ranges",
      answer: { unit: "kDKK", low: 9000, high: 11700 },
      confidence: 72,
      contributingResults: [...estimate.results.values()].map((entry) => entry.digest),
      assumptions: ["dual-run parallel period", "network segmentation contains PCI scope"],
      dissent: [
        {
          actor: instance.actorId(dissenter),
          summary: "Q3 deadline unachievable at any cost: 14-week licensing lead time",
          result: estimate.results.get(dissenter)!.digest,
        },
      ],
    }),
  );
  await instance.run(transport);

  // Ratification rides P2's L0 voting (Decision 4): the round's outcome
  // literally names the Synthesis.
  const round = "urn:afp:round:q-88-ratify";
  const synthesisId = String((synthesis.activity.object as Record<string, unknown>).id);
  const proposal = hub.proposeRound({
    round,
    thread: "urn:afp:thread:q-88-migration-estimate",
    question: `Ratify the synthesis ${synthesisId}?`,
    options: [synthesisId, "reject"],
  });
  const quorumSnapshot = String((proposal.activity.object as Record<string, unknown>)["afp:quorumSnapshot"]);
  for (const name of names) {
    instance.publish(name, [hub.actorId], "urn:afp:thread:q-88-migration-estimate", "hub", (envelope) =>
      castVote(envelope, {
        voteId: `${envelope.actor}/votes/${round}`,
        round,
        proposalHash: proposal.digest,
        quorumSnapshot,
        value: name === dissenter ? "reject" : synthesisId,
      }),
    );
  }
  await instance.run(transport);
  const ratification = hub.closeRound(round);

  // Settlement (Decision 5): actuals arrive, divergence goes on the record,
  // and the vindicated dissenter is noted — no score is computed from any of it.
  const settlementEntry = hub.allocation.settle(
    estimate.taskId,
    Object.fromEntries(
      estimate.performers.map((name) => [
        instance.actorId(name),
        { "afp:actualCost": { unit: "afp:compute-unit", value: ESTIMATE_BIDS[name].cost + 5 }, "afp:actualLatency": "PT6H" },
      ]),
    ),
    [instance.actorId(dissenter)],
    synthesisId,
  );

  instance.publishAsInstance([], "urn:afp:thread:roster", "public", (envelope) =>
    vouch(envelope, { agent: hub.actorId, capabilities: ["afp:cap:hub"], keyCustody: "self" }),
  );
  const exported = exportBundle(instance, config.exportDir, [hub]);

  return {
    instance,
    hub,
    rankingAward: ranking.awardEntry,
    coverageAward: estimate.awardEntry,
    synthesis,
    ratification,
    settlement: settlementEntry,
    exported,
    threads: { ranking: "urn:afp:thread:load-test", estimate: "urn:afp:thread:q-88-migration-estimate" },
  };
}
