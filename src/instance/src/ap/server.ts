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
 */

import { createServer, type Server } from "node:http";
import type { AfpInstance } from "../instance.ts";
import { handleInboxPost, type InboxDeps } from "../federation/inbox.ts";

const AP_CONTENT_TYPE = "application/activity+json";

export interface ServerOptions {
  /** ADR-0008: when present, POST {actor}/inbox is live — the boundary's receiving half. */
  inbox?: Omit<InboxDeps, "selfOrigin" | "now">;
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

    if (req.method === "POST" && options.inbox && (path === "/actor/inbox" || /^\/agents\/[\w-]+\/inbox$/.test(path))) {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        handleInboxPost(
          { ...options.inbox!, selfOrigin: instance.config.origin, now: () => instance.clock.now() },
          path,
          {
            host: String(req.headers.host ?? ""),
            date: String(req.headers.date ?? ""),
            digest: String(req.headers.digest ?? ""),
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

    try {
      if (path === "/actor") return send(200, instance.instanceDocument());
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
        // Only `public` activities are served unauthenticated. P1's task traffic
        // is `parties`, so this collection is legitimately empty — the full
        // record travels in the export, under the operator's control.
        const items = instance.outbox
          .byActor(instance.actorId(name))
          .filter((entry) => entry.visibility === "public")
          .map((entry) => entry.activity);
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
        const ref = instance.artifacts.lookup(digest);
        // `get` re-hashes before returning, so bytes that no longer match their
        // own name are indistinguishable from an absent artifact.
        const bytes = ref ? instance.artifacts.get(digest) : null;
        if (!ref || !bytes) return notFound();

        // An artifact inherits the visibility of the activity that referenced
        // it. Serve it unauthenticated only if every such activity is `public`;
        // otherwise a stranger gets 404, like any other closed resource.
        if (!instance.artifactIsPublic(digest)) return notFound();

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
  });
}
