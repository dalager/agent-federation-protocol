/**
 * ADR-0031 Decision 2: `/healthz`, `/readyz`, `/metrics`.
 *
 * All three are unauthenticated (ADR-0013 Decision 2's bootstrap class — they
 * name no data, so anonymity costs nothing) and `Cache-Control: no-store`.
 * Shaped like `render/routes.ts`'s `renderingRoute`: one function server.ts
 * calls that reports whether it handled the request, so the routing table in
 * `ap/server.ts` grows by a few lines.
 */

import type { AfpInstance } from "../instance.ts";
import type { Scheduler } from "./scheduler.ts";
import { render as renderMetrics } from "./metrics.ts";
import type { JsonValue } from "../crypto/jcs.ts";
import { probeSelfCheck, probeSigner, probeStore } from "./probes.ts";

export interface HealthDeps {
  /** Absent (a server built without a scheduler) reports `scheduler-not-running`. */
  scheduler?: Scheduler;
  /**
   * ADR-0032 Decision 2's self-check: fetch this instance's own `/actor`
   * through the same fetch policy `serve` uses, and require its `id` to
   * equal the instance's own actor id. Injectable so a test can make it
   * fail or return a mismatched document; `serve` wires the real fetch.
   */
  fetchActor?: (url: string) => Promise<{ [key: string]: JsonValue } | null>;
  /**
   * Test-only override of the signer check: called in place of the default
   * sign-then-verify round trip. Throw to report the signer as unavailable.
   */
  signerProbe?: () => void;
}

export interface HealthRouteContext {
  path: string;
  /** Builds the response, applying whatever headers the caller has collected. */
  send: (status: number, body: unknown, contentType?: string) => Response;
  /** Sets `Cache-Control: no-store` on the response before `send`. */
  noStore: () => void;
}

/**
 * Runs the four checks in order, stopping at the first failure — `readyz`'s
 * body names only that one check, nothing else about the instance. The store,
 * signer, and self-check probes are shared with `afp config check`
 * (`runtime/probes.ts`) so the two never drift.
 */
async function checkReady(instance: AfpInstance, deps: HealthDeps): Promise<{ ok: true } | { ok: false; reason: string }> {
  const store = probeStore(instance);
  if (!store.ok) return store;

  const signer = probeSigner(instance, deps.signerProbe);
  if (!signer.ok) return signer;

  if (deps.fetchActor) {
    const selfCheck = await probeSelfCheck(instance, deps.fetchActor);
    if (!selfCheck.ok) return selfCheck;
  }

  if (!deps.scheduler) {
    return { ok: false, reason: "scheduler-not-running" };
  }
  const ticked = Object.values(deps.scheduler.lastTick).some((at) => at !== undefined);
  if (!ticked) {
    return { ok: false, reason: "scheduler-not-ticked" };
  }

  return { ok: true };
}

/** The response, or `null` for "not a health route" (ADR-0036 Decision 3). */
export async function healthRoute(instance: AfpInstance, deps: HealthDeps, ctx: HealthRouteContext): Promise<Response | null> {
  if (ctx.path === "/healthz") {
    ctx.noStore();
    return ctx.send(200, "ok", "text/plain");
  }

  if (ctx.path === "/readyz") {
    const result = await checkReady(instance, deps);
    ctx.noStore();
    return ctx.send(result.ok ? 200 : 503, result.ok ? { ok: true } : { ok: false, reason: result.reason }, "application/json");
  }

  if (ctx.path === "/metrics") {
    ctx.noStore();
    return ctx.send(200, renderMetrics(), "text/plain; version=0.0.4");
  }

  return null;
}
