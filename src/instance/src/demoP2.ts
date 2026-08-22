/**
 * The P2 demo: "30 agents agree on the best policy" (05 § P2).
 *
 * A local hub beside the agents — same process, same dispatch port, no
 * network. Thirty voters enroll, an L0 weighted-quorum round runs over a
 * pinned membership snapshot, and the round closes with a signed
 * `Create{afp:DecisionRecord}` any member (or stranger) can recompute.
 * The export includes the hub's own outbox, so the Python verifier replays
 * the whole thing — decision checks included.
 */

import { rmSync } from "node:fs";
import { loadConfig, type Config } from "./config.ts";
import { AfpInstance, type AgentRegistration, type Clock } from "./instance.ts";
import { CountingBrain } from "./brains/stub.ts";
import { fixedClock } from "./demo.ts";
import { exportBundle, type ExportSummary } from "./export.ts";
import { agentActor } from "./ap/documents.ts";
import { vouch } from "./ap/activities.ts";
import { loadOrCreateHubKeyPair, type KeyPair } from "./crypto/keys.ts";
import { enroll, castVote, type Envelope } from "./hub/activities.ts";
import { Hub, hubTransport } from "./hub/hub.ts";
import type { OutboxEntry } from "./store/outbox.ts";

const HUB_ID = "policy-hub";
const VOTERS = 30;
const QUESTION = "Which policy best protects codebase integrity?";
const OPTIONS = ["signed-commits", "review-quorum", "trunk-freeze"] as const;

/** Deterministic ballot: voters lean signed-commits, a few abstain by omission. */
function ballotOf(index: number): string | null {
  if (index % 10 === 9) return null; // v9, v19, v29 abstain
  if (index % 3 === 2) return "review-quorum";
  if (index % 7 === 6) return "trunk-freeze";
  return "signed-commits";
}

export interface P2DemoResult {
  instance: AfpInstance;
  hub: Hub;
  decision: OutboxEntry;
  exported: ExportSummary;
  thread: string;
}

export async function runP2Demo(options: { fresh?: boolean; config?: Partial<Config>; clock?: Clock } = {}): Promise<P2DemoResult> {
  const config = loadConfig(options.config);
  if (options.fresh) rmSync(config.dataDir, { recursive: true, force: true });

  const ROUND = `${config.origin}/rounds/codebase-integrity`;
  const THREAD = `${config.origin}/threads/codebase-integrity`;

  const since = "2026-08-17T00:00:00Z";
  const agents: AgentRegistration[] = Array.from({ length: VOTERS }, (_, i) => ({
    spec: { name: `v${i}`, capabilities: ["afp:cap:vote"], keyCustody: "instance" as const, since },
    brain: new CountingBrain(`v${i}`, ["afp:cap:vote"], () => ({ ok: true, content: "n/a" })),
  }));
  const instance = new AfpInstance(config, agents, options.clock ?? fixedClock());

  // Hub-scoped keys (ADR-0002 Decision 4), published in each agent's actor document.
  const hubKeys = new Map<string, KeyPair>();
  for (const { spec } of agents) {
    hubKeys.set(spec.name, loadOrCreateHubKeyPair(config.keyDir, spec.name, instance.actorId(spec.name), HUB_ID));
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
  const transport = hubTransport(hub, instance.localTransport(), (target) => instance.nameOf(target) !== null);

  // Enroll all thirty, then open the round over the pinned membership.
  for (const { spec } of agents) {
    instance.publishAsInstance([hub.actorId], `${config.origin}/threads/enroll`, "hub", (envelope: Envelope) =>
      enroll(envelope, {
        agent: instance.actorId(spec.name),
        hub: hub.actorId,
        capabilities: ["afp:cap:vote"],
        hubKey: hubKeys.get(spec.name)!.keyId,
      }),
    );
  }
  await instance.run(transport);

  const proposal = hub.proposeRound({ round: ROUND, thread: THREAD, question: QUESTION, options: OPTIONS });
  const proposalObject = proposal.activity.object as Record<string, unknown>;
  const quorumSnapshot = String(proposalObject["afp:quorumSnapshot"]);

  for (let i = 0; i < VOTERS; i++) {
    const value = ballotOf(i);
    if (value === null) continue;
    instance.publish(`v${i}`, [hub.actorId], THREAD, "hub", (envelope: Envelope) =>
      castVote(envelope, {
        voteId: `${envelope.actor}/votes/${ROUND}`,
        round: ROUND,
        proposalHash: proposal.digest,
        quorumSnapshot,
        value,
      }),
    );
  }
  await instance.run(transport);

  const decision = hub.closeRound(ROUND);

  // The hub goes on the record like anyone else: vouched onto the roster,
  // self-custody, so replay authority comes from the record itself.
  instance.publishAsInstance([], `${config.origin}/threads/roster`, "public", (envelope: Envelope) =>
    vouch(envelope, { agent: hub.actorId, capabilities: ["afp:cap:hub"], keyCustody: "self" }),
  );
  const exported = exportBundle(instance, config.exportDir, [hub]);

  return { instance, hub, decision, exported, thread: THREAD };
}
