/**
 * The served demo: scenario 15's production Tuesday, run rather than gated.
 *
 * Every other demo in this repository drives a library in-process. This one
 * boots the thing an operator actually deploys — `src/cli.ts serve`, as a
 * real child process, on a real port, taking the store's real lock — and
 * then does nothing but watch it and talk to it over HTTP. That distinction
 * is the whole point: [scenario 15](../../docs/afp/scenarios/15-the-production-tuesday.md)
 * had ten acceptance criteria classed "mechanism gated" with the note that
 * "the served surface has no demo of its own — `serve` is booted by the
 * gates, not by any `demo:*` script". This is that script.
 *
 * The six beats, in the scenario's own order:
 *
 *   1. 08:20  the process is up and says what it is — `/healthz`, `/readyz`
 *             walking store → signer → self-check → scheduler, and NodeInfo
 *             carrying the version and spec revision a counterparty reads.
 *   2. 13:00  a second writer is refused by name: `StoreLocked`, naming the
 *             pid that holds it (ADR-0031 Decision 4).
 *   3. 02:14  an overdue task becomes one `afp:Error` with
 *             `afp:err:deadline-missed`, on a tick nobody triggered, and a
 *             second tick adds nothing.
 *   4. 11:00  a peer that is down is retried by the flush loop, its
 *             `Retry-After` is honoured, and the queue drains without the
 *             operator touching anything.
 *   5. 13:00  `systemctl restart` is a drain: a real `SIGTERM` to a real
 *             process — stop accepting, finish in flight, final flush, stop
 *             the scheduler, release the lock, exit 0.
 *   6. 15:00  the deliverable is a directory: the store the drained process
 *             left behind exports, and the Python verifier replays it.
 *
 * **What is real here and what is staged.** The instance is real: the
 * process, the lock, the scheduler's own timers, the HTTP surface, the
 * signatures. The peer is a fake — thirty lines of `node:http` that refuses
 * the first delivery with `503 Retry-After` and accepts the second — because
 * the subject of beat 4 is *this* instance's retry discipline, not a second
 * instance's inbox (`demo:p4` federates two real instances). The clock is
 * the system clock, deliberately: a demo of a resident process that stubbed
 * its timers would be demonstrating the stub. The scheduler intervals are
 * pressed down to fractions of a second so a Tuesday fits in ten seconds,
 * which is configuration an operator has (`AFP_SWEEP_MS`, `AFP_FLUSH_MS`),
 * not a test seam.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { createServer as createHttpServer, type Server } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadConfig, type Config } from "./config.ts";
import { AfpInstance } from "./instance.ts";
import { registrationsFor } from "./agents.ts";
import { readAgentsFile } from "./agentsSpec.ts";
import { openDb, StoreLocked } from "./store/db.ts";
import { exportBundle, type ExportSummary } from "./export.ts";
import { vouch, type Envelope } from "./ap/activities.ts";
import type { JsonValue } from "./crypto/jcs.ts";

const CAPABILITY = "afp:cap:review";
/** Pressed down from the shipped defaults so a Tuesday fits in ten seconds. */
const SWEEP_MS = 250;
const FLUSH_MS = 250;

export type ServedDemoResult = {
  narration: string[];
  exported: ExportSummary;
  thread: string;
  origin: string;
  /** The child's whole stderr/stdout, JSON log lines included. */
  log: string;
  exitCode: number | null;
  readyz: { [key: string]: JsonValue };
  nodeinfo: { version: string; specRevision: string };
  lockRefusal: string;
  sweptOverdue: number;
  peerAttempts: number;
  deadLetters: number;
};

export async function runServedDemo(
  options: { fresh?: boolean; config?: Partial<Config> & { dataDir?: string; exportDir?: string } } = {},
): Promise<ServedDemoResult> {
  const dataDir = options.config?.dataDir ?? "./data-served";
  const exportDir = options.config?.exportDir ?? "./export-served";
  if (options.fresh) {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(exportDir, { recursive: true, force: true });
  }

  const narration: string[] = [];
  const say = (line: string) => narration.push(line);

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const peer = await flakyPeer();
  const thread = `${origin}/threads/tuesday`;

  let child: ChildProcess | undefined;
  try {
    // ------------------------------------------------------------------
    // Yesterday afternoon: the work that will be overdue, and the delivery
    // that will find its peer down. Written by an in-process instance on
    // the very data directory `serve` is about to boot from, before it
    // takes the lock — the operator's own instance, which is how every
    // activity in scenario 15 got there.
    const config = loadConfig({ dataDir, exportDir, origin, devMode: true, brain: "stub" });
    const agentsFile = writeAgentsFile(dataDir);
    // The same collection three times over: this setup instance, the `serve`
    // child (from `AFP_AGENTS_FILE`), and the instance that exports after the
    // drain. An export knows an agent's outbox only for agents it holds, so a
    // collection that drifted between them would produce a bundle the
    // verifier calls incomplete — which is how this demo found out.
    const collection = () => registrationsFor(config, readAgentsFile(agentsFile).entries);
    const setup = new AfpInstance(config, collection());

    setup.delegate({
      from: "kasper",
      to: "estimator",
      capability: CAPABILITY,
      content: "estimate the MitID refresh",
      thread,
      correlationId: "q3-mitid-refresh",
      // Yesterday afternoon's deadline, which passed at 02:00 while nobody
      // was running anything.
      deadline: "2026-09-15T02:00:00.000Z",
    });
    setup.publish("kasper", [peer.actorId], `${origin}/threads/partner`, "parties", (envelope: Envelope) =>
      vouch(envelope, { agent: peer.actorId, capabilities: [CAPABILITY], keyCustody: "self" }),
    );
    setup.close();
    say(`seeded:   one task due 02:00 (thread ${thread.split("/").pop()}), one delivery addressed to the partner at ${peer.origin}`);

    // ------------------------------------------------------------------
    // Beat 1 — the process is up, and says what it is.
    child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "src/cli.ts", "serve"], {
      cwd: import.meta.dirname ? join(import.meta.dirname, "..") : process.cwd(),
      env: {
        ...process.env,
        AFP_DATA_DIR: dataDir,
        AFP_EXPORT_DIR: exportDir,
        AFP_ORIGIN: origin,
        AFP_PORT: String(port),
        AFP_AGENTS_FILE: agentsFile,
        AFP_BRAIN: "stub",
        AFP_DEV: "1",
        AFP_SWEEP_MS: String(SWEEP_MS),
        AFP_FLUSH_MS: String(FLUSH_MS),
        AFP_CONVERGE_MS: "0",
        AFP_HEARTBEAT_MS: "0",
        AFP_JITTER_MS: "0",
        // The retry the partner asks for, in a demo's patience rather than
        // a Tuesday's: the peer answers Retry-After: 1.
        AFP_BACKOFF_BASE_MS: "200",
        AFP_BACKOFF_CEILING_MS: "2000",
        AFP_RATE_LIMIT_PER_ADDRESS: "1000",
      },
    });
    let log = "";
    child.stdout?.on("data", (chunk) => (log += String(chunk)));
    child.stderr?.on("data", (chunk) => (log += String(chunk)));
    const exited = new Promise<number | null>((resolve) => child?.on("exit", (code) => resolve(code)));

    await until(async () => (await get(`${origin}/healthz`)).ok, () => `serve never became ready:\n${log}`);
    say(`serve:    listening on ${origin} — pid ${child.pid}, scheduler at sweep ${SWEEP_MS}ms / flush ${FLUSH_MS}ms`);

    say(`/healthz: 200 — the process is alive, which is all /healthz ever claims`);

    // `/readyz` is asked before the scheduler's first tick on purpose. A
    // process that is listening is not a process that is ready, and the
    // interesting half of ADR-0031 Decision 2 is the failure: a 503 that
    // names the line that failed rather than the word "unhealthy".
    const early = await get(`${origin}/readyz`);
    say(
      early.status === 200
        ? `/readyz:  200 before the first sweep — the scheduler had already ticked`
        : `/readyz:  ${early.status} ${compact(early.body)} — not "unhealthy": the line that failed, by name`,
    );

    await until(async () => (await get(`${origin}/readyz`)).status === 200, () => `/readyz never became ready:\n${log}`);
    const readyzResponse = await get(`${origin}/readyz`);
    const readyz = JSON.parse(readyzResponse.body) as { [key: string]: JsonValue };
    say(`          ${readyzResponse.status} ${compact(readyzResponse.body)} — store, signer, self-check, scheduler, in that order`);

    const nodeinfoBody = JSON.parse((await get(`${origin}/nodeinfo/2.1`)).body) as {
      software: { version: string };
      metadata: { [key: string]: string };
    };
    const nodeinfo = { version: nodeinfoBody.software.version, specRevision: nodeinfoBody.metadata["afp:specRevision"] };
    say(`nodeinfo: version ${nodeinfo.version}, spec revision ${nodeinfo.specRevision} — what a counterparty fetches instead of asking`);

    // ------------------------------------------------------------------
    // Beat 2 — the colleague who runs a script against the live directory.
    let lockRefusal = "";
    try {
      openDb(join(dataDir, "afp.db")).close();
      throw new Error("the store let a second writer in, which is the bug ADR-0031 Decision 4 exists to prevent");
    } catch (error) {
      if (!(error instanceof StoreLocked)) throw error;
      lockRefusal = error.message;
      say(`lock:     ${lockRefusal}`);
    }

    // ------------------------------------------------------------------
    // Beat 3 — 02:14, on a tick nobody triggered.
    await until(
      async () => counter(await metricsText(origin), "afp_sweep_overdue_total") >= 1,
      () => `the sweep never recorded the overdue task:\n${log}`,
    );
    const afterFirst = await metricsText(origin);
    const sweptOverdue = counter(afterFirst, "afp_sweep_overdue_total");
    say(
      `sweep:    afp_sweep_overdue_total ${sweptOverdue} after ${counter(afterFirst, 'afp_scheduler_ticks_total{loop="sweep"}')} ticks — ` +
        `the deadline passed and the instance said so, with no script running`,
    );

    // A second, third and fourth tick go by; the counter does not move,
    // because the task is already failed (ADR-0031 D1's "and nothing on the
    // second").
    const ticksBefore = counter(afterFirst, 'afp_scheduler_ticks_total{loop="sweep"}');
    await until(
      async () => counter(await metricsText(origin), 'afp_scheduler_ticks_total{loop="sweep"}') >= ticksBefore + 3,
      () => `the sweep loop stopped ticking:\n${log}`,
    );
    const afterMore = await metricsText(origin);
    if (counter(afterMore, "afp_sweep_overdue_total") !== sweptOverdue) {
      throw new Error("a later sweep tick recorded the same overdue task twice");
    }
    say(
      `          three more ticks (${counter(afterMore, 'afp_scheduler_ticks_total{loop="sweep"}')} total), ` +
        `afp_sweep_overdue_total still ${sweptOverdue} — one overdue task is one error, not one per tick`,
    );

    // ------------------------------------------------------------------
    // Beat 4 — the partner is down, and nothing is the operator's to do.
    // `afp_queue_depth` carries `pending` and `dead`; a delivered item leaves
    // the pending series rather than joining a third one, which is why the
    // scenario watches one number rise and fall rather than two.
    let peakPending = 0;
    await until(
      async () => {
        const text = await metricsText(origin);
        peakPending = Math.max(peakPending, counter(text, 'afp_queue_depth{state="pending"}'));
        return peer.attempts() >= 2 && counter(text, 'afp_queue_depth{state="pending"}') === 0;
      },
      () => `the delivery never landed — peer saw ${peer.attempts()} attempt(s):\n${log}`,
    );
    const drained = await metricsText(origin);
    const deadLetters = counter(drained, "afp_dead_letters_total");
    say(
      `flush:    the partner refused attempt 1 with 503 Retry-After: 1; attempt ${peer.attempts()} landed. ` +
        `afp_queue_depth{state="pending"} rose to ${peakPending} and fell to ${counter(drained, 'afp_queue_depth{state="pending"}')}, ` +
        `dead-lettered ${deadLetters}`,
    );
    say(`          the operator did nothing. afp_dead_letters_total is the one number that would have paged him, and it is ${deadLetters}`);

    // ------------------------------------------------------------------
    // Beat 5 — a restart is a drain. A real SIGTERM to a real process.
    child.kill("SIGTERM");
    const exitCode = await exited;
    if (exitCode !== 0) throw new Error(`serve exited ${exitCode}, not 0:\n${log}`);
    for (const expected of ["draining", "drained"]) {
      if (!log.includes(`"msg":"${expected}"`)) throw new Error(`the journal has no "${expected}" line:\n${log}`);
    }
    say(`shutdown: SIGTERM -> "draining" -> "drained" -> exit ${exitCode} — stopped accepting, finished in flight, released the lock`);

    // ------------------------------------------------------------------
    // Beat 6 — the deliverable is a directory.
    const after = new AfpInstance(config, collection());
    const errors = after.outbox
      .byThread(thread)
      .filter((entry) => objectTypeOf(entry.activity) === "afp:Error");
    if (errors.length !== 1) throw new Error(`expected exactly one afp:Error in the store, found ${errors.length}`);
    say(`record:   the lock is free again, and the store holds one afp:Error — ${errorCodeOf(errors[0].activity)}, signed like anything else`);

    // ADR-0009 Decision 4's scope, used for what it is for: this bundle
    // answers for the Tuesday's thread. Beat 4's delivery to the partner is
    // on its own thread and becomes a declared stub — the partner is a fake
    // with no key, so no co-signed `afp:FederationAgreement` names it, and a
    // bundle that shipped that hop as authentic would be claiming a
    // relationship this demo never concluded.
    const exported = exportBundle(after, exportDir, [], { threads: [thread] });
    say(`export:   ${exported.activities} activities -> ${exported.dir} (scoped to the Tuesday's thread; the partner hop ships as a declared stub)`);
    after.close();

    return {
      narration,
      exported,
      thread,
      origin,
      log,
      exitCode,
      readyz,
      nodeinfo,
      lockRefusal,
      sweptOverdue,
      peerAttempts: peer.attempts(),
      deadLetters,
    };
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    await peer.close();
  }
}

// ---------------------------------------------------------------- the peer

/**
 * A partner that is down, then is not. It serves an actor document (so the
 * transport can find an inbox the way AP §7.1 says to — never by convention)
 * and refuses the first inbox POST with `503 Retry-After: 1`, which is the
 * shape ADR-0025's backoff and `peer_backoff` are written against.
 */
async function flakyPeer(): Promise<{ origin: string; actorId: string; attempts: () => number; close: () => Promise<void> }> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const actorId = `${origin}/actor`;
  let attempts = 0;

  const server: Server = createHttpServer((request, response) => {
    if (request.url === "/actor") {
      response.writeHead(200, { "content-type": "application/activity+json" });
      response.end(JSON.stringify({ id: actorId, type: "Service", inbox: `${actorId}/inbox` }));
      return;
    }
    if (request.url === "/actor/inbox" && request.method === "POST") {
      request.resume();
      attempts++;
      if (attempts === 1) {
        response.writeHead(503, { "retry-after": "1" });
        response.end("catching up");
        return;
      }
      response.writeHead(202);
      response.end("");
      return;
    }
    response.writeHead(404);
    response.end("");
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    origin,
    actorId,
    attempts: () => attempts,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// --------------------------------------------------------------- plumbing

/**
 * Inside the data directory, never beside it: `dirname(dataDir)` is the
 * repository root for the default `./data-served`, and a demo that wrote
 * `agents.json` there would overwrite the checkout's own. (It did, once.)
 */
function writeAgentsFile(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, "agents.json");
  writeFileSync(
    file,
    JSON.stringify(
      [
        { name: "kasper", capabilities: [CAPABILITY], brain: "none" },
        // Deliberately brainless: the estimator that would answer this task
        // is the *partner's*, and the partner is off-stage all day — which is
        // scenario 15's cast note and the precondition for beat 3. An agent
        // that answered would make the deadline moot.
        { name: "estimator", capabilities: [CAPABILITY], brain: "none" },
      ],
      null,
      2,
    ),
  );
  return file;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address && typeof address === "object") {
        const found = address.port;
        probe.close(() => resolve(found));
      } else {
        probe.close(() => reject(new Error("no port")));
      }
    });
  });
}

async function get(url: string): Promise<{ ok: boolean; status: number; body: string }> {
  try {
    const response = await fetch(url);
    return { ok: response.ok, status: response.status, body: await response.text() };
  } catch {
    return { ok: false, status: 0, body: "" };
  }
}

/** One-line JSON, for a narration line that has to fit on a terminal. */
function compact(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body));
  } catch {
    return body.trim();
  }
}

async function metricsText(origin: string): Promise<string> {
  return (await get(`${origin}/metrics`)).body;
}

/** One `afp_…` series out of the text exposition, by exact series name. */
function counter(text: string, series: string): number {
  for (const line of text.split("\n")) {
    if (line.startsWith("#")) continue;
    const at = line.lastIndexOf(" ");
    if (at < 0) continue;
    if (line.slice(0, at) === series) return Number(line.slice(at + 1));
  }
  return 0;
}

async function until(condition: () => Promise<boolean>, fail: () => string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(fail());
}

function objectTypeOf(activity: { [key: string]: JsonValue }): string {
  const object = activity.object;
  return object && typeof object === "object" && !Array.isArray(object)
    ? String((object as Record<string, JsonValue>).type ?? "")
    : "";
}

function errorCodeOf(activity: { [key: string]: JsonValue }): string {
  const object = activity.object;
  if (object && typeof object === "object" && !Array.isArray(object)) {
    return String((object as Record<string, JsonValue>)["afp:errorCode"] ?? "afp:Error");
  }
  return "afp:Error";
}
