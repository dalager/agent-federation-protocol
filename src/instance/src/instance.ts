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
import { loadOrCreateKeyPair, loadOrCreateTransportKeyPair, type KeyPair } from "./crypto/keys.ts";
import { attachProof, digestOf } from "./crypto/proof.ts";
import { openDb, type Db } from "./store/db.ts";
import { Outbox, type OutboxEntry } from "./store/outbox.ts";
import { InboxLog } from "./store/inboxLog.ts";
import { SeenIds } from "./store/dedupe.ts";
import { Tasks } from "./store/tasks.ts";
import { Artifacts, type ArtifactRef } from "./store/artifacts.ts";
import { DeliveryQueue, type Transport } from "./store/queue.ts";
import {
  agentActor,
  agentActorId,
  deriveRoster,
  instanceActor,
  instanceActorId,
  signedRoster,
  type AgentSpec,
} from "./ap/documents.ts";
import {
  correlationIdOf,
  createError,
  disown,
  offerTask,
  vouch,
  type Envelope,
  type Visibility,
} from "./ap/activities.ts";
import { validateActionPolicy, validateIrrevocableActions, type TaskPins } from "./ap/pins.ts";
import type { Brain } from "./brains/port.ts";
import { Inbox } from "./inbox.ts";

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
  readonly inboxLog: InboxLog;
  readonly seen: SeenIds;
  readonly tasks: Tasks;
  readonly artifacts: Artifacts;
  readonly queue: DeliveryQueue;

  private readonly keys = new Map<string, KeyPair>();
  private readonly agents = new Map<string, AgentRegistration>();

  readonly config: Config;
  readonly clock: Clock;
  private pipeline: Inbox | null = null;

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
    this.inboxLog = new InboxLog(this.db);
    this.seen = new SeenIds(this.db, config.seenIdTtlMs);
    this.tasks = new Tasks(this.db);
    this.artifacts = new Artifacts(this.db, config.artifactDir, config.origin);
    this.queue = new DeliveryQueue(this.db, config.maxDeliveryAttempts, config.backoffBaseMs);

    const instanceId = instanceActorId(config.origin);
    this.keys.set("@instance", loadOrCreateKeyPair(config.keyDir, "instance", instanceId));
    this.keys.set("@instance:transport", loadOrCreateTransportKeyPair(config.keyDir, "instance", instanceId));
    for (const agent of agents) {
      this.agents.set(agent.spec.name, agent);
      const agentId = agentActorId(config.origin, agent.spec.name);
      this.keys.set(agent.spec.name, loadOrCreateKeyPair(config.keyDir, agent.spec.name, agentId));
      this.keys.set(`${agent.spec.name}:transport`, loadOrCreateTransportKeyPair(config.keyDir, agent.spec.name, agentId));
    }

    this.provision();
  }

  close(): void {
    this.db.close();
  }

  /** The inbound half of the adapter stack. */
  get inbox(): Inbox {
    this.pipeline ??= new Inbox(this);
    return this.pipeline;
  }

  /** Accept an inbound activity. Delegates to the inbox pipeline. */
  async receive(activity: { [key: string]: JsonValue }): Promise<ReceiveOutcome> {
    return this.inbox.receive(activity);
  }

  /** Boundary-admitted delivery (ADR-0008): trust was established at the gate. */
  async receiveAdmitted(activity: { [key: string]: JsonValue }): Promise<ReceiveOutcome> {
    return this.inbox.receiveAdmitted(activity);
  }

  /** The audit log of dropped deliveries, newest last. */
  auditLog(): { at: string; outcome: string; activityId: string | null; reason: string }[] {
    return this.inbox.auditLog();
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
      this.transportKey("@instance"),
    );
  }

  agentDocument(name: string): { [key: string]: JsonValue } {
    const agent = this.agents.get(name);
    if (!agent) throw new Error(`unknown agent ${name}`);
    return agentActor(this.config.origin, agent.spec, this.key(name), [], this.transportKey(name));
  }

  /**
   * The roster — a projection of the `Vouch`/`Disown` trail, never a reading of
   * configuration. The replay itself lives with the other document builders
   * (`ap/documents.ts` § `deriveRoster`), which is also where its byte-stability
   * is explained.
   */
  rosterDocument() {
    const { members, lastChange } = deriveRoster(this.outbox.byActor(instanceActorId(this.config.origin)));
    return signedRoster(this.config.origin, members, this.key("@instance"), lastChange || undefined);
  }

  /**
   * Record a `Vouch` for any registered agent that has not been vouched for yet.
   *
   * Idempotent: re-opening an existing instance adds nothing, because the trail
   * already carries the admission.
   */
  private provision(): void {
    const vouched = new Set(
      this.rosterDocument().orderedItems instanceof Array
        ? (this.rosterDocument().orderedItems as Record<string, JsonValue>[]).map((entry) =>
            String(entry.agent),
          )
        : [],
    );

    for (const agent of this.agents.values()) {
      const agentUrl = this.actorId(agent.spec.name);
      if (vouched.has(agentUrl)) continue;
      this.publishAsInstance([], "urn:afp:thread:roster", "public", (envelope) =>
        vouch(envelope, {
          agent: agentUrl,
          capabilities: agent.spec.capabilities,
          keyCustody: agent.spec.keyCustody,
        }),
      );
    }
  }

  /**
   * True when every activity referencing this artifact is `public`.
   *
   * Artifacts inherit the visibility of what referenced them (07 § Artifacts),
   * so an artifact attached to a `parties` Task is not world-readable even
   * though its URL is guessable from the digest.
   */
  artifactIsPublic(digest: string): boolean {
    const referencing = this.db
      .prepare("SELECT visibility, activity_json FROM outbox WHERE activity_json LIKE ?")
      .all(`%${digest}%`) as Record<string, unknown>[];
    return referencing.length > 0 && referencing.every((row) => String(row.visibility) === "public");
  }

  /** Remove an agent from the roster, on the record. */
  disownAgent(name: string, reason: string): OutboxEntry {
    return this.publishAsInstance([], "urn:afp:thread:roster", "public", (envelope) =>
      disown(envelope, this.actorId(name), reason),
    );
  }

  actorId(name: string): string {
    return agentActorId(this.config.origin, name);
  }

  /** The brain registered for an agent — used by workflows that drive it directly. */
  brainFor(name: string): Brain | null {
    return this.agents.get(name)?.brain ?? null;
  }

  /** Local name for an actor URL on this instance, or null if it is a stranger. */
  nameOf(actorUrl: string): string | null {
    for (const name of this.agents.keys()) {
      if (this.actorId(name) === actorUrl) return name;
    }
    return null;
  }

  key(name: string): KeyPair {
    const key = this.keys.get(name);
    if (!key) throw new Error(`no key for ${name}`);
    return key;
  }

  /** The transport (HTTP-signature) key for `"@instance"` or an agent name. */
  transportKey(name: string): KeyPair {
    return this.key(`${name}:transport`);
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

    const custody = agent.spec.keyCustody;
    return this.emit({
      actor: this.actorId(actorName),
      signerName: custody === "instance" ? "@instance" : actorName,
      // Instance-custody signatures name the agent they act for, so the
      // authority rule can bind signer to actor on replay (04 § Signature is
      // not authority).
      actingAs: custody === "instance" ? this.actorId(actorName) : null,
      to,
      thread,
      visibility,
      build,
    });
  }

  /**
   * Publish from the instance actor itself.
   *
   * The instance has an outbox from P1 onward because `Vouch`/`Disown` live in
   * it: admission has to be a recorded, signed act rather than a side-channel
   * one (01 § Vouch / disown).
   */
  publishAsInstance(
    to: readonly string[],
    thread: string,
    visibility: Visibility,
    build: (envelope: Envelope) => { [key: string]: JsonValue },
  ): OutboxEntry {
    return this.emit({
      actor: instanceActorId(this.config.origin),
      signerName: "@instance",
      actingAs: null,
      to,
      thread,
      visibility,
      build,
    });
  }

  private emit(options: {
    actor: string;
    signerName: string;
    actingAs: string | null;
    to: readonly string[];
    thread: string;
    visibility: Visibility;
    build: (envelope: Envelope) => { [key: string]: JsonValue };
  }): OutboxEntry {
    const now = this.clock.now().toISOString();
    const seq = this.outbox.nextSeq(options.actor);

    const envelope: Envelope = {
      activityId: `${options.actor}/activities/${String(seq).padStart(4, "0")}`,
      actor: options.actor,
      to: options.to,
      thread: options.thread,
      visibility: options.visibility,
      published: now,
      prevActivity: this.outbox.headDigest(options.actor),
    };

    const activity = options.build(envelope);
    if (options.actingAs) activity["afp:actingAs"] = options.actingAs;

    const signer = this.key(options.signerName);
    const signed = attachProof(activity, {
      privateKey: signer.privateKey,
      verificationMethod: signer.keyId,
      created: now,
    }) as unknown as { [key: string]: JsonValue };

    const entry = this.outbox.append(signed);
    for (const target of options.to) this.queue.enqueue(target, signed, this.clock.now());
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
    producedBy?: string;
    visibility?: Visibility;
    /**
     * ADR-0010 Decision 1: the direct flow's pin carrier. A fan-out passes the
     * same `pins` value to every Offer of the thread — they are compared as a
     * whole set at replay, and building one per Offer is how a publisher ships
     * two stories by accident.
     */
    pins?: TaskPins;
    /**
     * ADR-0011 Decision 4: the closed thread this ask continues, when the
     * claim is new information rather than that the old answer was wrong on
     * what it saw. Beside the pins, deliberately not among them.
     */
    priorThread?: string;
  }): OutboxEntry {
    if (options.pins?.actionPolicy) {
      validateActionPolicy(options.pins.actionPolicy);
      // ADR-0011 Decision 1: the escape hatch is only ever as honest as its
      // declaration, so a name that names no action is refused here rather
      // than read as live by whoever audits the annotation years later.
      if (options.pins.irrevocableActions?.length) {
        validateIrrevocableActions(options.pins.actionPolicy, options.pins.irrevocableActions);
      }
    }
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
          producedBy: options.producedBy,
          attachments: (options.attachments ?? []).map((ref) => Artifacts.toLink(ref) as JsonValue),
          pins: options.pins,
          priorThread: options.priorThread,
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
    this.sweepOverdue();

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

    this.sweepOverdue();
  }

  /**
   * Close out tasks whose deadline has passed with no outcome.
   *
   * "Thinking" and "dead" look identical over an async inbox (04 § Reliability),
   * so a performer that simply never answers would otherwise leave a pending
   * task open forever and the thread would never reach a terminal outcome. The
   * delegator records the timeout itself, as an `afp:Error` on the same thread.
   */
  sweepOverdue(): number {
    const overdue = this.tasks.overdue(this.clock.now());

    for (const task of overdue) {
      const delegator = this.nameOf(task.delegator);
      if (!delegator) continue;
      this.publish(delegator, [], task.thread, "parties", (envelope) =>
        createError(envelope, {
          errorId: `${envelope.actor}/errors/deadline-${task.correlationId}`,
          correlationId: task.correlationId,
          code: "afp:err:deadline-missed",
          reason: `no outcome from ${task.performer} by ${task.deadline}`,
        }),
      );
      this.tasks.setState(task.correlationId, "failed", this.clock.now());
    }

    return overdue.length;
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
