/**
 * The public HTTP surface.
 *
 * P1 dispatches in-process, so this server exists for the *outside*: actor
 * documents and the roster have to be publicly fetchable, because verifying a
 * signature requires fetching a key (07 § Four visibility classes).
 *
 * Everything else defaults closed. An unauthenticated stranger asking for a
 * `parties` activity gets **404, not 403** — non-existence and non-authorisation
 * must be indistinguishable, or probing yields a map of what exists.
 *
 * ADR-0013 adds the read half of the gate. When `options.read` is absent this
 * file behaves exactly as it always has — public-only, no signature read —
 * which is the compatibility proof, not an incidental property: every demo
 * and every one of the 100 existing tests calls `createHttpServer` without
 * `read` and must see byte-identical responses.
 */

import type { Server } from "node:http";
import { serveHandler } from "../runtime/adapters/node.ts";
import { jsonResponse, readCappedBody, TOO_LARGE, type Handler, type Peer } from "../runtime/httpPort.ts";
import type { AfpInstance } from "../instance.ts";
import { handleInboxPost, type InboxDeps } from "../federation/inbox.ts";
import { authorizeRead, type ReadAuthorization, type ReadGateDeps } from "../federation/readGate.ts";
import { AFP_CONTEXTS } from "./documents.ts";
import { webfingerResponse } from "./webfinger.ts";
import { nodeinfoDiscovery, nodeinfoDocument } from "./nodeinfo.ts";
import type { OutboxEntry } from "../store/outbox.ts";
import type { JsonValue } from "../crypto/jcs.ts";
import { RateLimiter } from "../federation/rateLimit.ts";
import { handleWebhook, matchWebhookRoute, type WebhookRoute } from "../ports/webhook.ts";
import { renderingRoute } from "../render/routes.ts";
import { handleCommandPost, matchCommandRoute } from "../ports/command.ts";
import { metrics } from "../runtime/metrics.ts";
import { healthRoute, type HealthDeps } from "../runtime/health.ts";

const AP_CONTENT_TYPE = "application/activity+json";

export interface ServerOptions {
  /** ADR-0008: when present, POST {actor}/inbox is live — the boundary's receiving half. */
  inbox?: Omit<InboxDeps, "selfOrigin" | "now">;
  /**
   * ADR-0013: when present, GET on non-`public` resources runs the same gate
   * the inbox runs. `onGrantedFetch` is the one read this ADR records
   * (Decision 5) — a fetch admitted under an `afp:AuditGrant`. Refusals are
   * never reported here: a read refusal is free and anonymous, and logging
   * it would hand a stranger a pen that writes into the record.
   */
  read?: ReadGateDeps & {
    onGrantedFetch?: (info: { grant: string; auditor: string; path: string; at: Date }) => void;
  };
  /**
   * Hubs hosted here, for serving their actor documents at GET /hubs/:id —
   * the route ADR-0002 described ("the hub is a route mounted next to the
   * agent actors") and nothing had needed until ADR-0014: a peer verifying a
   * presented membership proof resolves the hub's key from this document, so
   * it is public for the same bootstrap reason every actor document is.
   */
  /** ADR-0028 Decision 3: webhook initiators mounted at `POST /ports/:name/webhook`. */
  webhooks?: readonly WebhookRoute[];
  hubs?: readonly {
    hubId: string;
    actorDocument(): { [key: string]: JsonValue };
    /** ADR-0016 Decision 1: when present (with `inbox`), POST /hubs/:id/inbox is live. */
    receive?(activity: { [key: string]: JsonValue }): Promise<unknown>;
    /** ADR-0016 Decision 2: the write door — admission by the hub's own enrollment record. */
    writeAdmitted?(actor: string, activity: { [key: string]: JsonValue }): boolean;
    /** ADR-0017 Decision 4 (R5): instance actor ids with a live seat — GET /hubs/:id/followers. */
    followers?(): string[];
  }[];
  /** ADR-0031 Decision 2: `/healthz`, `/readyz`, `/metrics` — unauthenticated, no-store. */
  health?: HealthDeps;
}

/**
 * An AS2 collection response (ADR-0017 Decision 3): `@context` on the
 * document, `OrderedCollection` up to the page threshold, and
 * `OrderedCollectionPage` with `partOf`/`next`/`prev` beyond it.
 * `totalItems` is the collection's size; what a given requester may see is
 * expressed by what the items contain, not by shrinking the count.
 */
const PAGE_SIZE = 50;
function collectionDocument(
  collectionId: string,
  items: unknown[],
  totalItems: number,
  pageParam: string | null,
): { [key: string]: unknown } {
  if (pageParam === null && items.length <= PAGE_SIZE) {
    return { "@context": AFP_CONTEXTS, id: collectionId, type: "OrderedCollection", totalItems, orderedItems: items };
  }
  if (pageParam === null) {
    return { "@context": AFP_CONTEXTS, id: collectionId, type: "OrderedCollection", totalItems, first: `${collectionId}?page=1` };
  }
  const page = Math.max(1, Number.parseInt(pageParam, 10) || 1);
  const start = (page - 1) * PAGE_SIZE;
  const slice = items.slice(start, start + PAGE_SIZE);
  const lastPage = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  return {
    "@context": AFP_CONTEXTS,
    id: `${collectionId}?page=${page}`,
    type: "OrderedCollectionPage",
    partOf: collectionId,
    totalItems,
    ...(page > 1 ? { prev: `${collectionId}?page=${page - 1}` } : {}),
    ...(page < lastPage ? { next: `${collectionId}?page=${page + 1}` } : {}),
    orderedItems: slice,
  };
}

/** Every outbox entry, anywhere, whose activity JSON mentions this digest — the artifact-visibility query, resource-agnostic. */
function referencingEntries(instance: AfpInstance, digest: string): OutboxEntry[] {
  const rows = instance.db.all("SELECT * FROM outbox WHERE activity_json LIKE ?", `%${digest}%`) as Record<string, unknown>[];
  return rows.map((row) => ({
    activityId: String(row.activity_id),
    actor: String(row.actor),
    seq: Number(row.seq),
    thread: row.thread === null ? null : String(row.thread),
    digest: String(row.digest),
    prevActivity: row.prev_activity === null ? null : String(row.prev_activity),
    visibility: String(row.visibility),
    published: String(row.published),
    activity: JSON.parse(String(row.activity_json)),
  }));
}

/**
 * The public surface as a request handler (ADR-0036 Decision 3). `Request`
 * in, `Response` out, no `node:http` anywhere below this line — the node
 * adapter and a hosted actor's fetch method are both callers of this.
 */
export function createHandler(instance: AfpInstance, options: ServerOptions = {}): Handler {
  // ADR-0025 Decision 5: one bucket per source address, shared across every
  // route this server answers — cheap, unauthenticated, and the first thing
  // a hostile burst meets. In-memory and keyed on transport facts the
  // instance has no reason to know, so the server owns these; Decision 7's
  // replay cache is a store over `instance.db` and is owned there, next to
  // the activity-id dedupe it is the signature-level twin of.
  const addressLimiter = new RateLimiter(instance.config.rateLimitPerAddress, instance.config.rateLimitPerAddressWindowMs);
  const actorLimiter = new RateLimiter(instance.config.rateLimitPerActor, instance.config.rateLimitPerActorWindowMs);

  return async (request: Request, peer: Peer): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const remoteAddress = peer.address;

    const nowMs = instance.clock.now().getTime();
    if (!addressLimiter.allow(remoteAddress, nowMs)) {
      metrics.rateLimited("address");
      return jsonResponse(429, { error: "rate limited" }, "application/json", {
        "Retry-After": String(addressLimiter.retryAfterSeconds(remoteAddress, nowMs)),
      });
    }

    // Header bag in the shape the gate and the inbox already take.
    const header = (name: string): string => request.headers.get(name) ?? "";

    // ADR-0017 Decision 3: `application/ld+json` with the AS2 profile is
    // honoured as equivalent to `application/activity+json` (AP §3.2) — a
    // caller that asks for the profile form gets it back.
    const acceptHeader = header("accept");
    const negotiatedType =
      acceptHeader.includes("application/ld+json") && acceptHeader.includes("https://www.w3.org/ns/activitystreams")
        ? 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"'
        : AP_CONTENT_TYPE;

    // Headers the old code set on the response object before writing it.
    // Collected here and applied at send time, which is the same thing in a
    // different order: nothing could observe them until the write either.
    const extra: Record<string, string> = {};
    const send = (status: number, body: unknown, contentType = negotiatedType): Response =>
      jsonResponse(status, body, contentType, extra);
    const notFound = (): Response => send(404, { error: "not found" }, "application/json");

    // Decision 6: a response that depended on who asked must never be
    // storable by a cache that will serve it to somebody who did not ask.
    // `no-store` is load-bearing; `Vary: Signature` is belt to that braces.
    const markUncacheable = (): void => {
      extra["Cache-Control"] = "private, no-store";
      extra["Vary"] = "Signature";
    };

    // ADR-0028 Decision 3: a webhook initiator's own door, capped and
    // signature-checked the same way the inbox is, ahead of it so it never
    // falls through to the inbox's activity-shaped parsing.
    const webhookRoute = matchWebhookRoute(options.webhooks ?? [], method, path);
    if (webhookRoute) return handleWebhook(instance, webhookRoute, request);

    // ADR-0016 Decision 1: the hub's inbox is this same receiving
    // implementation with `receive` bound to the hub — not a second front
    // door. The boundary's checks run identically; Decision 2's enrollment
    // door (`admitWrite`) is the one addition, and only here.
    const hubInboxMatch = method === "POST" && options.inbox ? path.match(/^\/hubs\/([\w-]+)\/inbox$/) : null;
    const inboxHub = hubInboxMatch ? options.hubs?.find((h) => h.hubId === hubInboxMatch[1] && h.receive) : undefined;

    if (method === "POST" && options.inbox && (inboxHub || path === "/actor/inbox" || /^\/agents\/[\w-]+\/inbox$/.test(path))) {
      // ADR-0025 Decision 4: capped and refused before parsing, not after
      // buffering — a hostile body never gets far enough to be JSON.parse'd.
      const raw = await readCappedBody(request, instance.config.maxInboxBodyBytes);
      if (raw === TOO_LARGE) return jsonResponse(413, { error: "payload too large" });
      const body = new TextDecoder().decode(raw);

      try {
        const outcome = await handleInboxPost(
          {
            ...options.inbox!,
            replay: instance.seenSignatures,
            actorRateLimit: actorLimiter,
            ...(inboxHub
              ? {
                  receive: (activity: { [key: string]: JsonValue }) => inboxHub.receive!(activity),
                  ...(inboxHub.writeAdmitted
                    ? { admitWrite: (actor: string, activity: { [key: string]: JsonValue }) => inboxHub.writeAdmitted!(actor, activity) }
                    : {}),
                }
              : {}),
            selfOrigin: instance.config.origin,
            now: () => instance.clock.now(),
          },
          path,
          {
            host: header("host"),
            date: header("date"),
            digest: header("digest") || undefined,
            "content-digest": header("content-digest") || undefined,
            "signature-input": header("signature-input") || undefined,
            signature: header("signature"),
          },
          body,
        );
        // ADR-0017 Decision 3: an admitted delivery is recorded, so the
        // inbox has a collection to serve its owner. Refusals leave no
        // trace here — the log records admissions, not attempts.
        if (outcome.status === 202) {
          try {
            instance.inboxLog.record(path, JSON.parse(body), instance.clock.now());
          } catch {
            /* an unparseable body cannot have been admitted */
          }
        }
        return send(outcome.status, outcome.body, "application/json");
      } catch {
        return send(500, { error: "internal" }, "application/json");
      }
    }

    // ADR-0029 Decision 2 ("Command"): `POST /agents/:name/command`, body-read
    // and dispatched in `ports/command.ts` — the same webhook-shaped seam
    // `handleWebhook`/`matchWebhookRoute` use above, kept out of this file to
    // hold it under its line ceiling.
    if (matchCommandRoute(method, path)) return handleCommandPost(instance, options.read, request, path);

    if (method !== "GET") return notFound();

    // GET headers a signed read carries — no `digest`, since a GET has no
    // body (ADR-0013 Decision 1: the covered set is derived from the method).
    const readHeaders = {
      host: header("host"),
      date: header("date"),
      "signature-input": header("signature-input") || undefined,
      signature: header("signature"),
      // ADR-0014: a presented membership proof — outside the signature's
      // covered set on purpose (the set is method-derived and stays that way);
      // the proof is hub-signed and names its agent, so it needs no binding to
      // this particular request to be safe.
      "afp-membership-proof": header("afp-membership-proof") || undefined,
    };

    try {
      // ADR-0031 Decision 2: health/readiness/metrics — unauthenticated,
      // ahead of every gated route, the same shape as `renderingRoute`.
      const health = options.health
        ? await healthRoute(instance, options.health, { path, send, noStore: () => { extra["Cache-Control"] = "no-store"; } })
        : null;
      if (health) return health;

      // ADR-0029 Decision 2 ("Watch"): renderings, gated identically to the
      // outbox/artifact routes above — same `authorizeRead` call, same
      // `markUncacheable`, same `onGrantedFetch` on a grant-admitted fetch.
      const rendered = await renderingRoute(instance, options.read, {
        path,
        headers: readHeaders,
        accept: acceptHeader,
        send,
        notFound,
        markUncacheable,
      });
      if (rendered) return rendered;

      // `/actor`, `/roster`, `/agents/:name`, `/afp/policy`
      // stay unauthenticated forever (Decision 2, the bootstrap invariant):
      // verifying a signature requires fetching a key over one of these
      // routes, so gating them would make every signature unverifiable in
      // one move. This is not an oversight — it is load-bearing.
      if (path === "/actor") return send(200, instance.instanceDocument());

      // ADR-0017 Decision 4: WebFinger, the same unauthenticated bootstrap
      // class as `/actor` — a stranger needs a way in before it has any
      // key to verify a signature with.
      if (path === "/.well-known/webfinger") {
        const result = webfingerResponse(
          {
            origin: instance.config.origin,
            agentNames: instance.specs.map((s) => s.name),
            hubIds: (options.hubs ?? []).map((h) => h.hubId),
          },
          url.searchParams.get("resource"),
        );
        extra["Access-Control-Allow-Origin"] = "*";
        return send(result.status, result.body, "application/jrd+json");
      }

      const hubMatch = path.match(/^\/hubs\/([\w-]+)$/);
      if (hubMatch) {
        const hub = options.hubs?.find((h) => h.hubId === hubMatch[1]);
        if (!hub) return notFound();
        return send(200, hub.actorDocument());
      }
      if (path === "/roster") return send(200, instance.rosterDocument());

      // ADR-0017 Decision 4 (R5): derived, public collections — the seat
      // and Follow/Undo trail is the governance record, same publicity
      // rationale as the roster.
      if (path === "/actor/following") {
        const ids = instance.followingIds();
        return send(200, collectionDocument(`${instance.instanceDocument().id}/following`, ids, ids.length, url.searchParams.get("page")));
      }
      const followersMatch = path.match(/^\/hubs\/([\w-]+)\/followers$/);
      if (followersMatch) {
        const hub = options.hubs?.find((h) => h.hubId === followersMatch[1] && h.followers);
        if (!hub) return notFound();
        const ids = hub.followers!();
        return send(200, collectionDocument(`${hub.actorDocument().id}/followers`, ids, ids.length, url.searchParams.get("page")));
      }

      const agentMatch = path.match(/^\/agents\/([\w-]+)$/);
      if (agentMatch) {
        const name = agentMatch[1];
        if (!instance.specs.some((spec) => spec.name === name)) return notFound();
        return send(200, instance.agentDocument(name));
      }

      // ADR-0017 Decision 3: every advertised outbox is served — agent,
      // instance actor, hosted hub — by one implementation, gated the same
      // way, paged past a threshold.
      const outboxActorId = ((): string | null => {
        if (path === "/actor/outbox") return `${instance.config.origin}/actor`;
        const agentOutbox = path.match(/^\/agents\/([\w-]+)\/outbox$/);
        if (agentOutbox) {
          return instance.specs.some((spec) => spec.name === agentOutbox[1]) ? instance.actorId(agentOutbox[1]) : null;
        }
        const hubOutbox = path.match(/^\/hubs\/([\w-]+)\/outbox$/);
        if (hubOutbox && options.hubs?.some((h) => h.hubId === hubOutbox[1])) {
          return `${instance.config.origin}/hubs/${hubOutbox[1]}`;
        }
        return null;
      })();
      if (outboxActorId !== null) {
        const entries = instance.outbox.byActor(outboxActorId);

        let auth: ReadAuthorization | null = null;
        let items: { [key: string]: unknown }[];
        if (options.read) {
          // One gate call per request; every entry is judged against it.
          // An anonymous caller's `admits` is `public`-only by construction
          // (Decision 2), which is exactly today's filter — the
          // compatibility proof.
          auth = await authorizeRead(options.read, { path, headers: readHeaders });
          items = entries.filter((entry) => auth!.admits(entry.activity)).map((entry) => entry.activity);
          markUncacheable();
          if (auth.viaGrant) {
            options.read.onGrantedFetch?.({ ...auth.viaGrant, path, at: instance.clock.now() });
          }
        } else {
          // Only `public` activities are served unauthenticated. P1's task
          // traffic is `parties`, so this collection is legitimately empty
          // — the full record travels in the export, under the operator's
          // control.
          items = entries.filter((entry) => entry.visibility === "public").map((entry) => entry.activity);
        }

        return send(200, collectionDocument(`${outboxActorId}/outbox`, items, entries.length, url.searchParams.get("page")));
      }

      // ADR-0017 Decision 3: a GET on an inbox serves the received-delivery
      // log — to its owner. Anyone else gets the gate's ordinary answer,
      // 404, indistinguishable from the route not existing; that is the
      // authorized-fetch rule, not an unrouted hole.
      if (path === "/actor/inbox" || /^\/(agents|hubs)\/[\w-]+\/inbox$/.test(path)) {
        if (!options.read) return notFound();
        const auth = await authorizeRead(options.read, { path, headers: readHeaders });
        markUncacheable();
        const self = `${instance.config.origin}/actor`;
        const owner = auth.requester !== null && (auth.requester.agent === self || auth.requester.operatedBy === self);
        if (!owner) return notFound();
        const items = instance.inboxLog.byRecipient(path);
        return send(200, collectionDocument(`${instance.config.origin}${path}`, items, items.length, url.searchParams.get("page")));
      }

      const artifactMatch = path.match(/^\/artifacts\/(sha256-[0-9a-f]{64})$/);
      if (artifactMatch) {
        const digest = artifactMatch[1].replace("-", ":");

        // Resolve the resource and judge entitlement independently, then
        // combine at the end (Decision 4: resolve-then-judge). Neither
        // branch short-circuits the other — an absent artifact and an
        // unauthorized one must cost the same work and return the same
        // answer, or the timing difference becomes the oracle `404` exists
        // to deny.
        const ref = instance.artifacts.lookup(digest);
        const bytes = ref ? instance.artifacts.get(digest) : null;
        const referencing = referencingEntries(instance, digest);

        let auth: ReadAuthorization | null = null;
        let admitted: boolean;
        if (options.read) {
          auth = await authorizeRead(options.read, { path, headers: readHeaders });
          // Decision 7: the narrowest rule. Every activity referencing this
          // artifact must be admitted — one `parties` reference the
          // requester cannot see still hides it. Never "any".
          admitted = referencing.length > 0 && referencing.every((entry) => auth!.admits(entry.activity));
        } else {
          // Present rule, unchanged: served only if every referencing
          // activity is `public`.
          admitted = referencing.length > 0 && referencing.every((entry) => entry.visibility === "public");
        }

        if (!ref || !bytes || !admitted) return notFound();

        if (options.read) {
          markUncacheable();
          if (auth?.viaGrant) {
            options.read.onGrantedFetch?.({ ...auth.viaGrant, path, at: instance.clock.now() });
          }
        }

        return new Response(bytes, {
          status: 200,
          headers: { ...extra, "content-type": ref.mediaType, "content-length": String(ref.size) },
        });
      }

      // ADR-0017 Decision 5: the canonical path lives at an unreserved
      // location; the old `/.well-known/` path keeps serving the same body
      // as a transition alias. ADR-0033 Decision 1: the body is now the
      // signed `afp:Policy` document — unauthenticated bootstrap, like
      // every other actor/roster fetch, since verifying anything against
      // it starts with reading it.
      if (path === "/afp/policy" || path === "/.well-known/afp-policy") {
        return send(200, instance.policyDocument() as unknown as JsonValue);
      }

      // ADR-0039 Decision 4: the hubs this instance seeks a seat at, derived
      // from its own Follow/Undo trail. Unauthenticated for the reason the
      // trail itself is: `followHub` publishes at `public` visibility, so
      // this route discloses nothing the outbox does not already serve — it
      // saves a reader replaying the trail themselves.
      if (path === "/afp/following") {
        return send(200, { following: instance.followingIds() } as unknown as JsonValue);
      }

      // ADR-0017 Decision 5: FEP-f1d5 NodeInfo — the discovery link and the
      // version document it points at, both unauthenticated like every
      // other bootstrap route.
      if (path === "/.well-known/nodeinfo") {
        return send(200, nodeinfoDiscovery(instance.config.origin), "application/json");
      }
      if (path === "/nodeinfo/2.1") {
        return send(200, nodeinfoDocument(instance.specs.length, instance.config.profile), "application/json");
      }

      return notFound();
    } catch {
      return notFound();
    }
  };
}

/**
 * The same surface, served over `node:http` — ADR-0036 Decision 3's `node`
 * adapter, kept at this name and signature because twenty-three call sites
 * and every demo say it.
 */
export function createHttpServer(instance: AfpInstance, options: ServerOptions = {}): Server {
  return serveHandler(createHandler(instance, options), instance.config.origin);
}
