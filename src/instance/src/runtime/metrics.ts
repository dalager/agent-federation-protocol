/**
 * ADR-0031 Decision 2: `GET /metrics`.
 *
 * Counts only — no ids, no actors, no thread names. A tiny Prometheus text
 * exposition registry: a counter (optionally labeled) and a gauge, both
 * rendered as `# HELP` / `# TYPE` plus one sample line per series, the
 * format `/metrics` clients already expect.
 *
 * This is a module-level default registry (`metrics`) that the sites below
 * import and increment inline — the inbox's `dropDelivery`/admitted path,
 * the server's two 429 branches, and the scheduler's loops. A test calls
 * `metrics.reset()` between cases rather than constructing its own registry,
 * since the sites all close over this one.
 */

type Labels = Record<string, string>;

function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${JSON.stringify(labels[k])}`).join(",");
}

function renderLabels(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  return `{${keys.map((k) => `${k}="${labels[k]}"`).join(",")}}`;
}

interface SeriesMeta {
  readonly kind: "counter" | "gauge";
  readonly help: string;
  readonly labelNames: readonly string[];
}

/** A single named counter, sliced by an optional set of label values. */
export class Counter {
  private readonly values = new Map<string, number>();

  inc(labels: Labels = {}, by = 1): void {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }

  /** For rendering: every label combination touched so far, with its value. */
  entries(): { labels: Labels; value: number }[] {
    return [...this.values.entries()].map(([key, value]) => ({ labels: parseKey(key), value }));
  }
}

/** A single named gauge — set fresh each read, never accumulated. */
export class Gauge {
  private value: (() => number) | number = 0;

  /** A static value, or a function evaluated at render time (e.g. `queue.stats()`, `lastTick`). */
  set(value: (() => number) | number): void {
    this.value = value;
  }

  read(): number {
    return typeof this.value === "function" ? this.value() : this.value;
  }
}

/** Per-label gauge, for series like `afp_queue_depth{state=...}` computed fresh at render time. */
export class LabeledGauge {
  private readonly sources = new Map<string, () => number>();

  set(labels: Labels, source: () => number): void {
    this.sources.set(labelKey(labels), source);
  }

  entries(): { labels: Labels; value: number }[] {
    return [...this.sources.entries()].map(([key, source]) => ({ labels: parseKey(key), value: source() }));
  }
}

/** Prometheus text exposition's own spellings for the values `Number` can't render as-is. */
function formatNumber(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "+Inf";
  if (value === -Infinity) return "-Inf";
  return String(value);
}

function parseKey(key: string): Labels {
  if (key === "") return {};
  const labels: Labels = {};
  for (const part of key.split(",")) {
    const eq = part.indexOf("=");
    const name = part.slice(0, eq);
    const value = JSON.parse(part.slice(eq + 1)) as string;
    labels[name] = value;
  }
  return labels;
}

/** The registry `render()` walks. */
class Registry {
  private readonly meta = new Map<string, SeriesMeta>();
  private readonly counters = new Map<string, Counter>();
  private readonly gauges = new Map<string, Gauge>();
  private readonly labeledGauges = new Map<string, LabeledGauge>();

  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    this.meta.set(name, { kind: "counter", help, labelNames });
    const existing = this.counters.get(name);
    if (existing) return existing;
    const created = new Counter(labelNames);
    this.counters.set(name, created);
    return created;
  }

  gauge(name: string, help: string): Gauge {
    this.meta.set(name, { kind: "gauge", help, labelNames: [] });
    const existing = this.gauges.get(name);
    if (existing) return existing;
    const created = new Gauge();
    this.gauges.set(name, created);
    return created;
  }

  labeledGauge(name: string, help: string, labelNames: readonly string[]): LabeledGauge {
    this.meta.set(name, { kind: "gauge", help, labelNames });
    const existing = this.labeledGauges.get(name);
    if (existing) return existing;
    const created = new LabeledGauge();
    this.labeledGauges.set(name, created);
    return created;
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, meta] of this.meta) {
      lines.push(`# HELP ${name} ${meta.help}`);
      lines.push(`# TYPE ${name} ${meta.kind}`);
      const counter = this.counters.get(name);
      const gauge = this.gauges.get(name);
      const labeledGauge = this.labeledGauges.get(name);
      if (counter) {
        const entries = counter.entries();
        if (entries.length === 0 && meta.labelNames.length === 0) {
          lines.push(`${name} 0`);
        }
        for (const { labels, value } of entries) lines.push(`${name}${renderLabels(labels)} ${formatNumber(value)}`);
      } else if (gauge) {
        lines.push(`${name} ${formatNumber(gauge.read())}`);
      } else if (labeledGauge) {
        for (const { labels, value } of labeledGauge.entries()) lines.push(`${name}${renderLabels(labels)} ${formatNumber(value)}`);
      }
    }
    return `${lines.join("\n")}\n`;
  }

  /** Tests only: a fresh registry without recreating every call site's reference. */
  reset(): void {
    this.meta.clear();
    this.counters.clear();
    this.gauges.clear();
    this.labeledGauges.clear();
    installSeries(this);
  }
}

/** The pinned series (Decision 2) — declared once so `reset()` and first load agree. */
function installSeries(registry: Registry): {
  admissions: Counter;
  refusals: Counter;
  rateLimitRefusals: Counter;
  queueDepth: LabeledGauge;
  deadLetters: Counter;
  sweepOverdue: Counter;
  schedulerTicks: Counter;
  schedulerLastTick: LabeledGauge;
  convergeLag: LabeledGauge;
  processStart: Gauge;
} {
  const admissions = registry.counter("afp_inbox_admissions_total", "Inbound activities admitted past the trust gate");
  const refusals = registry.counter("afp_inbox_refusals_total", "Inbound deliveries refused, by class", ["class"]);
  const rateLimitRefusals = registry.counter("afp_ratelimit_refusals_total", "Requests refused by a rate-limit bucket, by scope", ["scope"]);
  const queueDepth = registry.labeledGauge("afp_queue_depth", "Delivery queue depth, by state", ["state"]);
  const deadLetters = registry.counter("afp_dead_letters_total", "Deliveries moved to the dead-letter state");
  const sweepOverdue = registry.counter("afp_sweep_overdue_total", "Overdue tasks recorded as afp:Error deadline-missed by a sweep tick");
  const schedulerTicks = registry.counter("afp_scheduler_ticks_total", "Scheduler loop ticks completed, by loop", ["loop"]);
  const schedulerLastTick = registry.labeledGauge("afp_scheduler_last_tick_seconds", "Unix seconds of each loop's last completed tick", ["loop"]);
  const convergeLag = registry.labeledGauge("afp_converge_lag_seconds", "Seconds since a hub replica's last successful exchange, by hub", ["hub"]);
  const processStart = registry.gauge("afp_process_start_time_seconds", "Unix seconds when this process started");
  processStart.set(Math.floor(Date.now() / 1000));
  return { admissions, refusals, rateLimitRefusals, queueDepth, deadLetters, sweepOverdue, schedulerTicks, schedulerLastTick, convergeLag, processStart };
}

const registry = new Registry();
const series = installSeries(registry);

/** The default registry's rendered text — what `/metrics` returns. */
export function render(): string {
  return registry.render();
}

/** Tests only: clear every series and start over (a fresh process-start timestamp included). */
export function reset(): void {
  registry.reset();
  Object.assign(series, installSeries(registry));
}

export const metrics = {
  render,
  reset,
  /** One admitted inbound activity (`inbox.receive`/`receiveAdmitted`'s dispatched path). */
  inboxAdmitted(): void {
    series.admissions.inc();
  },
  /** One refused/duplicate/polite-reply inbound delivery (`inbox.dropDelivery`'s outcome). */
  inboxRefused(outcome: "rejected" | "duplicate" | "polite-reply"): void {
    series.refusals.inc({ class: outcome });
  },
  /** One request turned away by a rate-limit bucket, by scope. */
  rateLimited(scope: "address" | "actor"): void {
    series.rateLimitRefusals.inc({ scope });
  },
  /** Reads `queue.stats()` fresh at every render — a gauge, not a counter. */
  trackQueue(stats: () => { pending: number; dead: number }): void {
    series.queueDepth.set({ state: "pending" }, () => stats().pending);
    series.queueDepth.set({ state: "dead" }, () => stats().dead);
  },
  deadLettered(count: number): void {
    if (count > 0) series.deadLetters.inc({}, count);
  },
  sweptOverdue(count: number): void {
    if (count > 0) series.sweepOverdue.inc({}, count);
  },
  tick(loop: string, atSeconds: number): void {
    series.schedulerTicks.inc({ loop });
    series.schedulerLastTick.set({ loop }, () => atSeconds);
  },
  /** Registers a hub's converge-lag source — seconds since its last successful exchange. */
  trackConvergeLag(hubId: string, secondsSinceLastExchange: () => number): void {
    series.convergeLag.set({ hub: hubId }, secondsSinceLastExchange);
  },
};
