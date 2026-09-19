/**
 * ADR-0031 Decision 1: the resident scheduler.
 *
 * Four loops, each idempotent, each safe alongside inbox traffic: `sweep`
 * (`instance.sweepOverdue()`), `flush` (`instance.queue.flush` against a real
 * clock, with dead letters surfaced the same way `instance.run` always has —
 * `instance.recordDeadLetters`, factored out there so this loop does not
 * duplicate it), `converge` (one `Offer{afp:Digest}` per configured hub
 * replica toward one peer per tick, round-robin — 02's decaying fan-out on
 * the scheduled path — plus an urgent push toward every peer the moment the
 * hub admits an `Enroll`, `Unenroll` or a conviction proof, via the
 * `Hub.onUrgent` hook), and `heartbeat` (the optional `afp:BoundaryDigest`,
 * off by default).
 *
 * Liveness registers are excluded from convergence — that is ADR-0016
 * Decision 3, already enforced inside `Hub.syncVector`/`offerSync`; nothing
 * here re-implements it.
 *
 * Every tick is wrapped so one throwing loop never stops the others: the
 * throw is logged and swallowed, and `lastTick` records only successful
 * completions — a served instance's `/readyz` (the next agent's WP-2) reads
 * this to say the scheduler is alive.
 */

import type { AfpInstance } from "../instance.ts";
import type { Transport } from "../store/queue.ts";
import type { Hub } from "../hub/hub.ts";
import type { Federation } from "../federation/federation.ts";
import { createBoundaryDigest } from "../ap/activities.ts";
import { logger } from "./log.ts";
import { Schedule, type Jitter, type LoopName, type LoopSpec } from "./schedule.ts";
import { metrics } from "./metrics.ts";

const log = logger("scheduler");

export { type LoopName } from "./schedule.ts";

export interface HubReplica {
  readonly hub: Hub;
  /** Actor URLs of the other replicas of the same hub — 02's peer set. */
  readonly peers: readonly string[];
  /**
   * How this hub's own outbound queue (a `Hub` carries a `DeliveryQueue`
   * distinct from `instance.queue`) reaches a peer — a signed HTTP hop when
   * hub-hosting is remote, or a direct call when the peers share a process.
   * Defaults to the scheduler's instance-level `transport`.
   */
  readonly transport?: Transport;
}

export interface SchedulerConfig {
  readonly sweepMs: number;
  readonly flushMs: number;
  readonly convergeMs: number;
  /** `0` disables the heartbeat loop entirely — no timer is even armed. */
  readonly heartbeatMs: number;
  readonly jitterMs: number;
}

export interface SchedulerDeps {
  readonly instance: AfpInstance;
  readonly transport: Transport;
  /** Hub replicas this process runs and keeps converged. Empty for `serve`, which hosts none of its own. */
  readonly hubReplicas?: readonly HubReplica[];
  /** Required only when `heartbeatMs > 0`: the federation boundary whose digest is published. */
  readonly federation?: Federation;
  readonly config: SchedulerConfig;
}

/** One round-robin cursor per hub, so `converge` advances through peers across ticks rather than always hitting the first. */
class RoundRobin {
  private readonly cursors = new Map<Hub, number>();

  next(hub: Hub, peers: readonly string[]): string | null {
    if (peers.length === 0) return null;
    const at = this.cursors.get(hub) ?? 0;
    this.cursors.set(hub, (at + 1) % peers.length);
    return peers[at % peers.length];
  }
}

export class Scheduler {
  private readonly deps: SchedulerDeps;
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly roundRobin = new RoundRobin();
  private urgentHooksInstalled = false;
  /** ADR-0031 Decision 2: last successful exchange per hub, for `afp_converge_lag_seconds`. */
  private readonly lastExchange = new Map<string, Date>();

  readonly lastTick: { sweep?: Date; flush?: Date; converge?: Date; heartbeat?: Date } = {};

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
    // Installed at construction, not on the first tick: G3's urgent push
    // must fire before any `tick("converge")` is ever called.
    this.installUrgentHooks();
  }

  /**
   * The four loops as data (ADR-0036 Decision 4). The node driver arms a
   * timer per entry below; a hosted driver folds them into one alarm through
   * `schedule()`. A `heartbeatMs` of `0` is off, and `Schedule` drops it for
   * the same reason `start` never armed it.
   */
  private specs(): readonly LoopSpec[] {
    const { config } = this.deps;
    return [
      { name: "sweep", intervalMs: config.sweepMs, jitterMs: config.jitterMs },
      { name: "flush", intervalMs: config.flushMs, jitterMs: config.jitterMs },
      { name: "converge", intervalMs: config.convergeMs, jitterMs: config.jitterMs },
      { name: "heartbeat", intervalMs: config.heartbeatMs, jitterMs: config.jitterMs },
    ];
  }

  /**
   * A `Schedule` over this scheduler's loops, starting now — what a hosted
   * driver arms its single alarm from. The node driver does not use it: its
   * timers *are* its schedule, and giving it two would be two answers to
   * "when does flush run".
   */
  schedule(startedAtMs = this.deps.instance.clock.now().getTime(), jitter?: Jitter): Schedule {
    return new Schedule(this.specs(), startedAtMs, jitter);
  }

  /**
   * Run every loop due at `nowMs` and report which ran — the hosted
   * profile's tick. Sequential on purpose: the loops share one store and one
   * writer (ADR-0031 Decision 4), and `tick` already swallows and logs a
   * failure, so one bad loop cannot stop the others.
   */
  async runDue(schedule: Schedule, nowMs: number): Promise<readonly LoopName[]> {
    const ran = schedule.due(nowMs);
    for (const name of ran) await this.tick(name);
    return ran;
  }

  /** Arm every enabled loop's real timer. Each `unref()`s so a lone scheduler never keeps the process alive. */
  start(): void {
    for (const spec of this.specs()) {
      if (spec.intervalMs > 0) this.arm(spec.name, spec.intervalMs, spec.jitterMs);
    }
  }

  stop(): void {
    for (const timer of this.timers.splice(0)) clearInterval(timer);
  }

  private arm(name: LoopName, intervalMs: number, jitterMs: number): void {
    const timer = setInterval(
      () => {
        this.tick(name).catch(() => {
          /* tick() already catches and logs; this exists only to satisfy the interval callback's void contract */
        });
      },
      intervalMs + (jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0),
    );
    timer.unref?.();
    this.timers.push(timer);
  }

  /**
   * `Hub.onUrgent`: the moment an admitted Enroll/Unenroll/proof dispatches,
   * push an `offerSync` toward every configured peer of that hub immediately
   * rather than waiting for the next `converge` tick — 02's decaying fan-out,
   * triggered rather than timed.
   */
  private installUrgentHooks(): void {
    if (this.urgentHooksInstalled) return;
    this.urgentHooksInstalled = true;
    for (const replica of this.deps.hubReplicas ?? []) {
      replica.hub.onUrgent = async () => {
        for (const peer of replica.peers) {
          try {
            replica.hub.pushSync(peer);
          } catch (error) {
            log.warn("urgent pushSync failed", { peer, error: String(error) });
          }
        }
        try {
          await replica.hub.run(replica.transport ?? this.deps.transport);
        } catch (error) {
          log.warn("urgent offerSync delivery failed", { error: String(error) });
        }
      };
    }
  }

  /**
   * Run one loop once, synchronously awaited — the deterministic form the
   * ADR's gate asks for ("fake timers"): a test drives `tick(name)` against
   * an injected/jumped clock instead of real timers. Never throws: a failing
   * loop is logged at `warn`/`error` and `lastTick` for that name is simply
   * not advanced.
   */
  async tick(name: LoopName): Promise<void> {
    try {
      switch (name) {
        case "sweep":
          await this.tickSweep();
          break;
        case "flush":
          await this.tickFlush();
          break;
        case "converge":
          await this.tickConverge();
          break;
        case "heartbeat":
          await this.tickHeartbeat();
          break;
      }
      const at = this.deps.instance.clock.now();
      this.lastTick[name] = at;
      metrics.tick(name, Math.floor(at.getTime() / 1000));
    } catch (error) {
      log.error(`${name} tick failed`, { error: String(error) });
    }
  }

  private async tickSweep(): Promise<void> {
    const missed = this.deps.instance.sweepOverdue();
    metrics.sweptOverdue(missed);
    log.debug("sweep", { missed });
  }

  private async tickFlush(): Promise<void> {
    const report = await this.deps.instance.queue.flush(this.deps.transport, this.deps.instance.clock.now());
    this.deps.instance.recordDeadLetters(report.deadLettered);
    metrics.deadLettered(report.deadLettered.length);
    if (report.deadLettered.length > 0) log.warn("dead-lettered deliveries", { count: report.deadLettered.length });
    log.debug("flush", { delivered: report.delivered, retried: report.retried, dead: report.deadLettered.length });
  }

  private async tickConverge(): Promise<void> {
    this.installUrgentHooks();
    for (const replica of this.deps.hubReplicas ?? []) {
      const peer = this.roundRobin.next(replica.hub, replica.peers);
      if (peer === null) continue;
      replica.hub.offerSync(peer);
      log.debug("converge", { hub: replica.hub.actorId, peer });
    }
    // Each hub's own outbound queue (distinct from `instance.queue`) is
    // drained here too: an `Offer{afp:Digest}` that never leaves the queue
    // converges nothing, and neither does the `Accept{afp:StateDeltas}` a
    // peer's hub enqueues in reply.
    for (const replica of this.deps.hubReplicas ?? []) {
      try {
        await replica.hub.run(replica.transport ?? this.deps.transport);
        const hubId = replica.hub.actorId;
        this.lastExchange.set(hubId, this.deps.instance.clock.now());
        metrics.trackConvergeLag(hubId, () => {
          const last = this.lastExchange.get(hubId);
          return last ? (this.deps.instance.clock.now().getTime() - last.getTime()) / 1000 : Infinity;
        });
      } catch (error) {
        log.warn("converge delivery failed", { hub: replica.hub.actorId, error: String(error) });
      }
    }
  }

  private async tickHeartbeat(): Promise<void> {
    const { instance, federation } = this.deps;
    if (!federation) {
      log.warn("heartbeat tick skipped: no federation configured");
      return;
    }
    const digest = federation.boundaryDigest();
    instance.publishAsInstance(
      [],
      `${instance.config.origin}/threads/boundary`,
      "internal",
      (envelope) => createBoundaryDigest(envelope, digest),
    );
    log.debug("heartbeat", digest);
  }
}
