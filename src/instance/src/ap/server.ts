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

import { createServer, type Server } from "node:http";
import type { AfpInstance } from "../instance.ts";
import { handleInboxPost, type InboxDeps } from "../federation/inbox.ts";
import { authorizeRead, type ReadAuthorization, type ReadGateDeps } from "../federation/readGate.ts";
import type { OutboxEntry } from "../store/outbox.ts";
import type { JsonValue } from "../crypto/jcs.ts";

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
  hubs?: readonly {
    hubId: string;
    actorDocument(): { [key: string]: JsonValue };
    /** ADR-0016 Decision 1: when present (with `inbox`), POST /hubs/:id/inbox is live. */
    receive?(activity: { [key: string]: JsonValue }): Promise<unknown>;
    /** ADR-0016 Decision 2: the write door — admission by the hub's own enrollment record. */
    writeAdmitted?(actor: string, activity: { [key: string]: JsonValue }): boolean;
  }[];
}

/** Every outbox entry, anywhere, whose activity JSON mentions this digest — the artifact-visibility query, resource-agnostic. */
function referencingEntries(instance: AfpInstance, digest: string): OutboxEntry[] {
  const rows = instance.db
    .prepare("SELECT * FROM outbox WHERE activity_json LIKE ?")
    .all(`%${digest}%`) as Record<string, unknown>[];
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

export function createHttpServer(instance: AfpInstance, options: ServerOptions = {}): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", instance.config.origin);
    const path = url.pathname;

    const send = (status: number, body: unknown, contentType = AP_CONTENT_TYPE): void => {
      const payload = typeof body === "string" ? body : JSON.stringify(body, null, 2);
      res.writeHead(status, { "content-type": contentType });
      res.end(payload);
    };
    const notFound = (): void => send(404, { error: "not found" }, "application/json");

    // Decision 6: a response that depended on who asked must never be
    // storable by a cache that will serve it to somebody who did not ask.
    // `no-store` is load-bearing; `Vary: Signature` is belt to that braces.
    const markUncacheable = (): void => {
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Vary", "Signature");
    };

    // ADR-0016 Decision 1: the hub's inbox is this same receiving
    // implementation with `receive` bound to the hub — not a second front
    // door. The boundary's checks run identically; Decision 2's enrollment
    // door (`admitWrite`) is the one addition, and only here.
    const hubInboxMatch = req.method === "POST" && options.inbox ? path.match(/^\/hubs\/([\w-]+)\/inbox$/) : null;
    const inboxHub = hubInboxMatch ? options.hubs?.find((h) => h.hubId === hubInboxMatch[1] && h.receive) : undefined;

    if (req.method === "POST" && options.inbox && (inboxHub || path === "/actor/inbox" || /^\/agents\/[\w-]+\/inbox$/.test(path))) {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        handleInboxPost(
          {
            ...options.inbox!,
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
            host: String(req.headers.host ?? ""),
            date: String(req.headers.date ?? ""),
            digest: String(req.headers.digest ?? "") || undefined,
            "content-digest": String(req.headers["content-digest"] ?? "") || undefined,
            "signature-input": String(req.headers["signature-input"] ?? "") || undefined,
            signature: String(req.headers.signature ?? ""),
          },
          body,
        )
          .then((outcome) => send(outcome.status, outcome.body, "application/json"))
          .catch(() => send(500, { error: "internal" }, "application/json"));
      });
      return;
    }

    if (req.method !== "GET") return notFound();

    // GET headers a signed read carries — no `digest`, since a GET has no
    // body (ADR-0013 Decision 1: the covered set is derived from the method).
    const readHeaders = {
      host: String(req.headers.host ?? ""),
      date: String(req.headers.date ?? ""),
      "signature-input": String(req.headers["signature-input"] ?? "") || undefined,
      signature: String(req.headers.signature ?? ""),
      // ADR-0014: a presented membership proof — outside the signature's
      // covered set on purpose (the set is method-derived and stays that way);
      // the proof is hub-signed and names its agent, so it needs no binding to
      // this particular request to be safe.
      "afp-membership-proof": String(req.headers["afp-membership-proof"] ?? "") || undefined,
    };

    (async () => {
      try {
        // `/actor`, `/roster`, `/agents/:name`, `/.well-known/afp-policy`
        // stay unauthenticated forever (Decision 2, the bootstrap invariant):
        // verifying a signature requires fetching a key over one of these
        // routes, so gating them would make every signature unverifiable in
        // one move. This is not an oversight — it is load-bearing.
        if (path === "/actor") return send(200, instance.instanceDocument());

        const hubMatch = path.match(/^\/hubs\/([\w-]+)$/);
        if (hubMatch) {
          const hub = options.hubs?.find((h) => h.hubId === hubMatch[1]);
          if (!hub) return notFound();
          return send(200, hub.actorDocument());
        }
        if (path === "/roster") return send(200, instance.rosterDocument());

        const agentMatch = path.match(/^\/agents\/([\w-]+)$/);
        if (agentMatch) {
          const name = agentMatch[1];
          if (!instance.specs.some((spec) => spec.name === name)) return notFound();
          return send(200, instance.agentDocument(name));
        }

        const outboxMatch = path.match(/^\/agents\/([\w-]+)\/outbox$/);
        if (outboxMatch) {
          const name = outboxMatch[1];
          if (!instance.specs.some((spec) => spec.name === name)) return notFound();

          const entries = instance.outbox.byActor(instance.actorId(name));

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

          return send(200, {
            id: `${instance.actorId(name)}/outbox`,
            type: "OrderedCollection",
            totalItems: items.length,
            orderedItems: items,
          });
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

          res.writeHead(200, { "content-type": ref.mediaType, "content-length": String(ref.size) });
          return res.end(Buffer.from(bytes));
        }

        if (path === "/.well-known/afp-policy") {
          return send(
            200,
            {
              "afp:cryptosuite": "eddsa-jcs-2022",
              "afp:phase": "P1",
              "afp:federation": "none",
              "afp:defaultVisibility": "internal",
            },
            "application/json",
          );
        }

        return notFound();
      } catch {
        return notFound();
      }
    })();
  });
}
