/**
 * The instance: the adapter stack that implements the agent ports.
 *
 * Signing, the outbox chain, both dedupe layers, the trust gate, the delivery
 * queue and artifact handling all live behind this class. Brains see none of it
 * (`brains/port.ts`), and the record it produces carries no trace of the fact
 * that P1 dispatches in-process — gate check 11.
 */

import { mkdirSync } from "node:fs";
import type { Config } from "./config.ts";
import type { JsonValue } from "./crypto/jcs.ts";
import { loadOrCreateKeyPair, publicKeyFromMultibase, type KeyPair } from "./crypto/keys.ts";
import { attachProof, digestOf, verifyProof } from "./crypto/proof.ts";
import { openDb, type Db } from "./store/db.ts";
import { Outbox, type OutboxEntry } from "./store/outbox.ts";
import { SeenIds } from "./store/dedupe.ts";
import { Tasks } from "./store/tasks.ts";
import { Artifacts, type ArtifactRef } from "./store/artifacts.ts";
import { DeliveryQueue, type Transport } from "./store/queue.ts";
import {
  agentActor,
  agentActorId,
  instanceActor,
  instanceActorId,
  signedRoster,
  type AgentSpec,
} from "./ap/documents.ts";
import {
  acceptTask,
  correlationIdOf,
  createError,
  createResult,
  offerTask,
  type Envelope,
  type Visibility,
} from "./ap/activities.ts";
import type { Brain, BrainArtifact } from "./brains/port.ts";

export interface AgentRegistration {
  spec: AgentSpec;
  brain: Brain;
}

export type ReceiveOutcome =
  | { status: "dispatched" }
  | { status: "duplicate"; reason: string }
  | { status: "rejected"; reason: string };

/** Injected so demos and tests produce byte-identical records on every run. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class AfpInstance {
  readonly db: Db;
  readonly outbox: Outbox;
  readonly seen: SeenIds;
  readonly tasks: Tasks;
  readonly artifacts: Artifacts;
  readonly queue: DeliveryQueue;

  private readonly keys = new Map<string, KeyPair>();
  private readonly agents = new Map<string, AgentRegistration>();
  private counter = 0;

  readonly config: Config;
  private readonly clock: Clock;

  constructor(
    config: Config,
    agents: readonly AgentRegistration[],
    clock: Clock = systemClock,
  ) {
    this.config = config;
    this.clock = clock;
    mkdirSync(config.dataDir, { recursive: true });
    this.db = openDb(config.dbPath);
    this.outbox = new Outbox(this.db);
    this.seen = new SeenIds(this.db, config.seenIdTtlMs);
    this.tasks = new Tasks(this.db);
    this.artifacts = new Artifacts(this.db, config.artifactDir, config.origin);
    this.queue = new DeliveryQueue(this.db, config.maxDeliveryAttempts, config.backoffBaseMs);

    this.keys.set(
      "@instance",
      loadOrCreateKeyPair(config.keyDir, "instance", instanceActorId(config.origin)),
    );
    for (const agent of agents) {
      this.agents.set(agent.spec.name, agent);
      this.keys.set(
        agent.spec.name,
        loadOrCreateKeyPair(
          config.keyDir,
          agent.spec.name,
          agentActorId(config.origin, agent.spec.name),
        ),
      );
    }
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- documents

  get specs(): AgentSpec[] {
    return [...this.agents.values()].map((agent) => agent.spec);
  }

  instanceDocument(): { [key: string]: JsonValue } {
    return instanceActor(
      this.config.origin,
      this.config.operator,
      this.config.instanceName,
      this.key("@instance"),
    );
  }

  agentDocument(name: string): { [key: string]: JsonValue } {
    const agent = this.agents.get(name);
    if (!agent) throw new Error(`unknown agent ${name}`);
    return agentActor(this.config.origin, agent.spec, this.key(name));
  }

  rosterDocument(created?: string) {
    return signedRoster(this.config.origin, this.specs, this.key("@instance"), created);
  }

  actorId(name: string): string {
    return agentActorId(this.config.origin, name);
  }

  private nameOf(actorUrl: string): string | null {
    for (const name of this.agents.keys()) {
      if (this.actorId(name) === actorUrl) return name;
    }
    return null;
  }

  private key(name: string): KeyPair {
    const key = this.keys.get(name);
    if (!key) throw new Error(`no key for ${name}`);
    return key;
  }

  // ----------------------------------------------------------------- outbound

  /**
   * Sign an activity, append it to its actor's chain, and enqueue delivery.
   *
   * `keyCustody` decides which key signs. At `instance` custody the instance
   * key signs and the activity is tagged `afp:actingAs` — attribution stays on
   * the agent while accountability sits with the instance (01 § Key custody).
   */
  publish(
    actorName: string,
    to: readonly string[],
    thread: string,
    visibility: Visibility,
    build: (envelope: Envelope) => { [key: string]: JsonValue },
  ): OutboxEntry {
    const agent = this.agents.get(actorName);
    if (!agent) throw new Error(`unknown agent ${actorName}`);

    const actor = this.actorId(actorName);
    const now = this.clock.now().toISOString();
    const seq = this.outbox.nextSeq(actor);

    const envelope: Envelope = {
      activityId: `${actor}/activities/${String(seq).padStart(4, "0")}`,
      actor,
      to,
      thread,
      visibility,
      published: now,
      prevActivity: this.outbox.headDigest(actor),
    };

    let activity = build(envelope);
    const custody = agent.spec.keyCustody;
    const signer = custody === "instance" ? this.key("@instance") : this.key(actorName);
    if (custody === "instance") activity["afp:actingAs"] = actor;

    const signed = attachProof(activity, {
      privateKey: signer.privateKey,
      verificationMethod: signer.keyId,
      created: now,
    }) as unknown as { [key: string]: JsonValue };

    const entry = this.outbox.append(signed);
    for (const target of to) this.queue.enqueue(target, signed, this.clock.now());
    return entry;
  }

  /** Delegate a task: publish the Offer and open the pending-task row. */
  delegate(options: {
    from: string;
    to: string;
    capability: string;
    content: string;
    thread: string;
    correlationId: string;
    attachments?: ArtifactRef[];
    deadline?: string;
    visibility?: Visibility;
  }): OutboxEntry {
    const target = this.actorId(options.to);
    const entry = this.publish(
      options.from,
      [target],
      options.thread,
      options.visibility ?? "parties",
      (envelope) =>
        offerTask(envelope, {
          taskId: `${envelope.actor}/tasks/${options.correlationId}`,
          capability: options.capability,
          correlationId: options.correlationId,
          content: options.content,
          deadline: options.deadline,
          attachments: (options.attachments ?? []).map((ref) => Artifacts.toLink(ref) as JsonValue),
        }),
    );

    this.tasks.open(
      {
        correlationId: options.correlationId,
        thread: options.thread,
        delegator: this.actorId(options.from),
        performer: target,
        deadline: options.deadline ?? null,
      },
      this.clock.now(),
    );

    return entry;
  }

  // ------------------------------------------------------------------ inbound

  /**
   * The inbox pipeline, in order: verify the proof, run the trust gate, dedupe
   * on activity id, then dispatch. Anything that fails a step is dropped with a
   * reason rather than processed.
   */
  async receive(activity: { [key: string]: JsonValue }): Promise<ReceiveOutcome> {
    const activityId = typeof activity.id === "string" ? activity.id : "";
    const actorUrl = String(activity.actor ?? "");
    if (!activityId) return this.drop("rejected", "", actorUrl, "activity has no id");

    const signerUrl = typeof activity["afp:actingAs"] === "string"
      ? instanceActorId(this.config.origin)
      : actorUrl;
    const verification = this.verifySignature(activity, signerUrl);
    if (!verification.ok) {
      return this.drop("rejected", activityId, actorUrl, verification.reason);
    }

    // Trust gate. P1 is a single trust domain, so this short-circuits on
    // `operatedBy == self` (06) — there is no agreement to check and no
    // self-agreement to model.
    if (this.nameOf(actorUrl) === null) {
      return this.drop(
        "rejected",
        activityId,
        actorUrl,
        `actor ${actorUrl} is not on this instance's roster`,
      );
    }

    if (!this.seen.markSeen(activityId, this.clock.now())) {
      return this.drop("duplicate", activityId, actorUrl, `activity ${activityId} already delivered`);
    }

    await this.dispatch(activity);
    return { status: "dispatched" };
  }

  /** Record a dropped delivery, then report it. Nothing is discarded silently. */
  private drop(
    outcome: "rejected" | "duplicate",
    activityId: string,
    actor: string,
    reason: string,
  ): ReceiveOutcome {
    this.db
      .prepare("INSERT INTO audit_log (at, outcome, activity_id, actor, reason) VALUES (?, ?, ?, ?, ?)")
      .run(this.clock.now().toISOString(), outcome, activityId || null, actor || null, reason);
    return { status: outcome, reason } as ReceiveOutcome;
  }

  /** The audit log of dropped deliveries, newest last. */
  auditLog(): { at: string; outcome: string; activityId: string | null; reason: string }[] {
    const rows = this.db
      .prepare("SELECT at, outcome, activity_id, reason FROM audit_log ORDER BY id ASC")
      .all() as Record<string, unknown>[];
    return rows.map((row) => ({
      at: String(row.at),
      outcome: String(row.outcome),
      activityId: row.activity_id === null ? null : String(row.activity_id),
      reason: String(row.reason),
    }));
  }

  private verifySignature(
    activity: { [key: string]: JsonValue },
    signerUrl: string,
  ): { ok: true } | { ok: false; reason: string } {
    const instanceId = instanceActorId(this.config.origin);
    const name = signerUrl === instanceId ? "@instance" : this.nameOf(signerUrl);
    if (name === null) return { ok: false, reason: `no known key for signer ${signerUrl}` };

    const publicKey = publicKeyFromMultibase(this.key(name).publicKeyMultibase);
    const result = verifyProof(activity, publicKey);
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  }

  private async dispatch(activity: { [key: string]: JsonValue }): Promise<void> {
    const type = String(activity.type ?? "");
    const object = activity.object;
    const objectType =
      object && typeof object === "object" && !Array.isArray(object)
        ? String((object as { [key: string]: JsonValue }).type ?? "")
        : "";

    if (type === "Offer" && objectType === "afp:Task") return this.onTaskOffered(activity);
    if (type === "Accept") return this.onAccepted(activity);
    if (type === "Create" && objectType === "afp:Result") return this.onResult(activity);
    if (type === "Create" && objectType === "afp:Error") return this.onError(activity);
    // Unknown types are recorded as received and otherwise ignored — an inbox is
    // a hint, never an instruction (04 § Reliability).
  }

  private async onTaskOffered(activity: { [key: string]: JsonValue }): Promise<void> {
    const task = activity.object as { [key: string]: JsonValue };
    const correlationId = String(task["afp:correlationId"] ?? "");
    const thread = String(activity.context ?? "");
    const performerUrl = firstRecipient(activity);
    const performerName = performerUrl ? this.nameOf(performerUrl) : null;
    if (!performerName) return;

    const performer = this.agents.get(performerName)!;

    // Dedupe layer 2: the same *task* arriving as a genuinely new activity.
    // A hit replays the cached outcome; the brain is not invoked again.
    const cached = this.tasks.cachedResult(correlationId, performerUrl!);
    if (cached) {
      this.queue.enqueue(String(activity.actor ?? ""), cached, this.clock.now());
      return;
    }

    this.publish(performerName, [String(activity.actor ?? "")], thread, "parties", (envelope) =>
      acceptTask(envelope, String(activity.id ?? ""), correlationId),
    );

    const attachments = this.materialize(task.attachment);
    const outcome = await performer.brain.handle({
      capability: String(task["afp:capability"] ?? ""),
      content: String(task.content ?? ""),
      attachments,
      thread,
    });

    const delegator = String(activity.actor ?? "");
    if (!outcome.ok) {
      const entry = this.publish(performerName, [delegator], thread, "parties", (envelope) =>
        createError(envelope, {
          errorId: `${envelope.actor}/errors/${correlationId}`,
          correlationId,
          code: "afp:err:brain-failed",
          reason: outcome.reason,
        }),
      );
      this.tasks.cacheResult(correlationId, performerUrl!, entry.activity, this.clock.now());
      return;
    }

    const produced = (outcome.attachments ?? []).map((artifact) =>
      Artifacts.toLink(this.artifacts.put(artifact.bytes, artifact.mediaType, this.clock.now())) as JsonValue,
    );

    const entry = this.publish(performerName, [delegator], thread, "parties", (envelope) =>
      createResult(envelope, {
        resultId: `${envelope.actor}/results/${correlationId}`,
        correlationId,
        content: outcome.content,
        summary: outcome.summary,
        attachments: produced,
      }),
    );
    this.tasks.cacheResult(correlationId, performerUrl!, entry.activity, this.clock.now());
  }

  private async onAccepted(activity: { [key: string]: JsonValue }): Promise<void> {
    const correlationId = correlationIdOf(activity);
    if (correlationId) this.tasks.setState(correlationId, "accepted", this.clock.now());
  }

  private async onResult(activity: { [key: string]: JsonValue }): Promise<void> {
    const correlationId = correlationIdOf(activity);
    if (correlationId) this.tasks.setState(correlationId, "completed", this.clock.now());
  }

  private async onError(activity: { [key: string]: JsonValue }): Promise<void> {
    const correlationId = correlationIdOf(activity);
    if (correlationId) this.tasks.setState(correlationId, "failed", this.clock.now());
  }

  /**
   * Turn attachment Links into bytes for a brain, discarding anything whose
   * digest does not match — a brain never sees unverified evidence.
   */
  private materialize(attachment: JsonValue | undefined): BrainArtifact[] {
    if (!Array.isArray(attachment)) return [];
    const out: BrainArtifact[] = [];
    for (const link of attachment) {
      if (!link || typeof link !== "object" || Array.isArray(link)) continue;
      const digest = (link as { [key: string]: JsonValue })["afp:digest"];
      const mediaType = (link as { [key: string]: JsonValue }).mediaType;
      if (typeof digest !== "string") continue;
      const bytes = this.artifacts.get(digest);
      if (!bytes) continue;
      out.push({ mediaType: typeof mediaType === "string" ? mediaType : "application/octet-stream", bytes });
    }
    return out;
  }

  // ------------------------------------------------------------------ running

  /** In-process transport. P4 swaps this for signed HTTP without touching brains. */
  localTransport(): Transport {
    return {
      name: "local",
      deliver: async (target, activity) => {
        const name = this.nameOf(target);
        if (!name) throw new Error(`no local actor at ${target}`);
        await this.receive(activity);
      },
    };
  }

  /**
   * Drain the delivery queue until quiet, then record every dead letter as a
   * local `afp:Error` so an exhausted delivery is never a silent drop.
   */
  async run(transport: Transport = this.localTransport()): Promise<void> {
    for (let pass = 0; pass < 8; pass++) {
      const report = await this.queue.drain(transport, this.clock.now());

      for (const dead of report.deadLettered) {
        const sender = this.nameOf(String(dead.activity.actor ?? ""));
        if (!sender) continue;
        this.publish(
          sender,
          [],
          String(dead.activity.context ?? "urn:afp:thread:local"),
          "internal",
          (envelope) =>
            createError(envelope, {
              errorId: `${envelope.actor}/errors/undeliverable-${dead.id}`,
              correlationId: correlationIdOf(dead.activity) ?? dead.activityId,
              code: "afp:err:undeliverable",
              reason: `delivery to ${dead.target} failed after ${dead.attempts} attempts: ${dead.lastError}`,
            }),
        );
      }

      if (report.delivered === 0 && report.deadLettered.length === 0) break;
    }
  }

  /** Digest of an activity as recorded in the chain — exposed for tests. */
  static digest(activity: { [key: string]: JsonValue }): string {
    return digestOf(activity);
  }
}

function firstRecipient(activity: { [key: string]: JsonValue }): string | null {
  const to = activity.to;
  if (Array.isArray(to) && to.length > 0 && typeof to[0] === "string") return to[0];
  return typeof to === "string" ? to : null;
}
