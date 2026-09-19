/**
 * ADR-0036 Decision 4 — the schedule, as data rather than as four timers.
 *
 * ADR-0031 Decision 1 gave the resident process four loops, each with its own
 * interval and jitter, each armed with its own `setInterval`. That is right
 * for a profile with a process to keep alive and wrong for one without: a
 * platform actor is evicted when idle and woken by a single alarm, so it
 * needs to ask "when is the next loop due" and, on waking, "which ones are
 * due now".
 *
 * Both questions are the same fold over the same per-loop state, so it lives
 * here and neither driver owns it. The node driver keeps its timers and the
 * behaviour they had; a hosted driver would call `dueAt` to set one alarm and
 * `due` to find what to run — and the two cannot disagree about *when* a loop
 * runs, because they are reading one answer.
 *
 * Jitter is drawn **once per loop**, and the resulting period is reused for
 * every re-arm — because that is exactly what the node driver does.
 * `arm()` passes `interval + jitter` to `setInterval`, which draws once and
 * then repeats that same period forever. ADR-0031 D1 wants two instances
 * restarted together to stop landing on the same instant, and a fixed
 * offset achieves that permanently; re-drawing each time would also work,
 * but it would be a *different* rule from the one the resident process
 * runs, and two profiles disagreeing about when `flush` fires is the thing
 * this file exists to prevent.
 */

export type LoopName = "sweep" | "flush" | "converge" | "heartbeat";

export interface LoopSpec {
  readonly name: LoopName;
  /** Base interval in milliseconds. A loop with `0` is off and never becomes due. */
  readonly intervalMs: number;
  readonly jitterMs: number;
}

/** Deterministic in tests, random in production — the same seam `arm` had inline. */
export type Jitter = (jitterMs: number) => number;

export const defaultJitter: Jitter = (jitterMs) => (jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0);

/**
 * Per-loop next-due state. Constructed with the instant the schedule starts,
 * so the first due time for each loop is one interval after it — which is
 * what `setInterval` does, and what a first alarm must therefore agree with.
 */
export class Schedule {
  private readonly specs: readonly LoopSpec[];
  /** Each loop's period: its interval plus the one jitter draw it keeps. */
  private readonly period = new Map<LoopName, number>();
  private readonly next = new Map<LoopName, number>();

  constructor(specs: readonly LoopSpec[], startedAtMs: number, jitter: Jitter = defaultJitter) {
    this.specs = specs.filter((spec) => spec.intervalMs > 0);
    for (const spec of this.specs) {
      const period = spec.intervalMs + jitter(spec.jitterMs);
      this.period.set(spec.name, period);
      this.next.set(spec.name, startedAtMs + period);
    }
  }

  /**
   * The earliest instant any loop is next due, or `null` when nothing is
   * enabled. A hosted driver sets its single alarm to this.
   */
  dueAt(): number | null {
    let earliest: number | null = null;
    for (const at of this.next.values()) {
      if (earliest === null || at < earliest) earliest = at;
    }
    return earliest;
  }

  /**
   * The loops due at `nowMs`, in declaration order, each re-armed for its
   * next run. Re-arming from `nowMs` rather than from the missed due time is
   * deliberate: an actor that slept through three intervals should run the
   * loop once and carry on, not run it three times to catch up. The loops are
   * idempotent (ADR-0031 D1), so the backlog is in the work they find, not in
   * the number of times they are called.
   */
  due(nowMs: number): readonly LoopName[] {
    const ready: LoopName[] = [];
    for (const spec of this.specs) {
      const at = this.next.get(spec.name);
      if (at !== undefined && at <= nowMs) {
        ready.push(spec.name);
        this.next.set(spec.name, nowMs + (this.period.get(spec.name) ?? spec.intervalMs));
      }
    }
    return ready;
  }
}
