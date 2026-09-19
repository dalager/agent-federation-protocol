/**
 * ADR-0029 Decision 2 ("Watch") — the smallest hook into `ap/server.ts`.
 *
 * `GET /threads/:id/rendering` and `GET /agents/:name/timeline` run the same
 * read gate the outbox route runs (`authorizeRead`, `markUncacheable`,
 * `onGrantedFetch` on a grant-admitted fetch), then hand the admitted
 * activities to `render/rendering.ts`. A `parties` thread with nothing
 * admitted is a 404 — indistinguishable from a thread that does not exist,
 * the authorized-fetch rule ADR-0013 Decision 2 states for every other route.
 *
 * Shaped like `ports/webhook.ts`'s `matchWebhookRoute`/`handleWebhook` pair:
 * one function server.ts calls that returns whether it handled the request,
 * so the routing table in server.ts grows by a few lines, not a branch tree.
 */

import type { AfpInstance } from "../instance.ts";
import { authorizeRead, type ReadGateDeps } from "../federation/readGate.ts";
import type { RequestAuthHeaders } from "../federation/httpSig.ts";
import type { OutboxEntry } from "../store/outbox.ts";
import { renderThread, renderTimeline, narrativeText, bundleInfoFor } from "./rendering.ts";

export interface RenderingRouteContext {
  path: string;
  headers: RequestAuthHeaders & { "afp-membership-proof"?: string };
  accept: string;
  send: (status: number, body: unknown, contentType?: string) => Response;
  notFound: () => Response;
  markUncacheable: () => void;
}

type ReadOptions = (ReadGateDeps & { onGrantedFetch?: (info: { grant: string; auditor: string; path: string; at: Date }) => void }) | undefined;

/**
 * Filters `entries` exactly as the outbox route does: one `authorizeRead`
 * call, `admits` judges every entry, `markUncacheable` always, and
 * `onGrantedFetch` fires only *after* filtering — `admits` sets
 * `auth.viaGrant` as a side effect the first time a grant actually admits
 * something, so checking it before filtering would always see it unset.
 */
async function admittedEntries(
  read: ReadOptions,
  ctx: RenderingRouteContext,
  entries: readonly OutboxEntry[],
  now: () => Date,
): Promise<OutboxEntry[]> {
  if (!read) return entries.filter((entry) => entry.visibility === "public");

  const auth = await authorizeRead(read, { path: ctx.path, headers: ctx.headers });
  const admitted = entries.filter((entry) => auth.admits(entry.activity));
  ctx.markUncacheable();
  if (auth.viaGrant) {
    read.onGrantedFetch?.({ ...auth.viaGrant, path: ctx.path, at: now() });
  }
  return admitted;
}

function respond(ctx: RenderingRouteContext, rendering: ReturnType<typeof renderThread>): Response {
  return ctx.accept.includes("text/plain")
    ? ctx.send(200, narrativeText(rendering), "text/plain; charset=utf-8")
    : ctx.send(200, rendering, "application/json");
}

/**
 * Returns `true` when this call was one of the two rendering routes (handled
 * either way — success or 404) so `server.ts` falls through to its own
 * routes for everything else.
 */
/** The response, or `null` for "not a rendering route" (ADR-0036 Decision 3). */
export async function renderingRoute(instance: AfpInstance, read: ReadOptions, ctx: RenderingRouteContext): Promise<Response | null> {
  const threadMatch = ctx.path.match(/^\/threads\/([\w-]+)\/rendering$/);
  if (threadMatch) {
    const threadUrl = `${instance.config.origin}/threads/${threadMatch[1]}`;
    const entries = instance.outbox.byThread(threadUrl);

    const admitted = await admittedEntries(read, ctx, entries, () => instance.clock.now());

    if (admitted.length === 0) {
      return ctx.notFound();
    }

    const bundle = bundleInfoFor(instance.config.exportDir, threadUrl);
    const rendering = renderThread(admitted, { thread: threadUrl, bundle, now: instance.clock.now().toISOString() });
    return respond(ctx, rendering);
  }

  const timelineMatch = ctx.path.match(/^\/agents\/([\w-]+)\/timeline$/);
  if (timelineMatch) {
    const name = timelineMatch[1];
    if (!instance.specs.some((spec) => spec.name === name)) {
      return ctx.notFound();
    }
    const actorUrl = instance.actorId(name);
    const entries = instance.outbox.byActor(actorUrl);

    const admitted = await admittedEntries(read, ctx, entries, () => instance.clock.now());

    const rendering = renderTimeline(admitted, { actor: actorUrl, now: instance.clock.now().toISOString() });
    return respond(ctx, rendering);
  }

  return null;
}
