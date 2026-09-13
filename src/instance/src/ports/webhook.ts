/**
 * The webhook initiator (ADR-0028 Decision 3, first bullet): scenario 06's
 * opening — an external tracker's delivery, dedup'd and summarized in the
 * port's own words before it ever reaches a brain.
 *
 * Same discipline as `ports/external.ts`: no ActivityPub, no SQLite. The HTTP
 * route (`handleWebhook`) is the one place this file touches the wire; it
 * mirrors `ap/server.ts`'s own inbox handling — capped and signature-checked
 * before anything is parsed (ADR-0025 Decision 4, applied here too).
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AfpInstance } from "../instance.ts";
import type { TaskPins } from "../ap/pins.ts";
import type { Visibility } from "../ap/activities.ts";
import { IngestionRefused } from "../store/artifacts.ts";
import type { ExternalEvent, ExternalInitiator } from "../ports/external.ts";

/** `POST /ports/<name>/webhook` route configuration — one per mounted webhook. */
export interface WebhookRoute {
  readonly name: string;
  /** HMAC-SHA256 shared secret this route verifies deliveries against. */
  readonly secret: string;
  readonly initiator: ExternalInitiator;
  readonly to: string;
  readonly thread: string;
  readonly pins?: TaskPins;
  readonly visibility?: Visibility;
}

/**
 * The port's own bounded summary of a webhook delivery — never the raw
 * payload (03 § External systems; scenario 06 finding 19). The payload
 * itself reaches the record only as the attachment `initiate` puts.
 */
export function webhookInitiator(options: {
  name: string;
  capability: string;
  summarize?: (event: ExternalEvent) => string;
}): ExternalInitiator {
  const summarize =
    options.summarize ??
    ((event: ExternalEvent) =>
      `External event ${event.externalId} received from ${event.sourceUrl} (${event.mediaType}, ${event.payload.length} bytes); investigate.`);
  return {
    name: options.name,
    capability: options.capability,
    summarize: (event) => ({ content: summarize(event) }),
  };
}

/**
 * HMAC-SHA256 hex over the raw body, header of the form `sha256=<hex>`.
 * Length-checked before `timingSafeEqual`, which throws on a length mismatch
 * rather than answering false — the check that would leak whether an early
 * length guess was close.
 */
export function verifyWebhookSignature(secret: string, body: Uint8Array, header: string | undefined): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const presented = header.slice("sha256=".length);
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(presented, "utf8"), Buffer.from(expected, "utf8"));
}

/**
 * `POST /ports/<name>/webhook`. Refuses (401) a missing or wrong signature
 * before parsing anything; requires `x-afp-external-id` (400 if absent);
 * `sourceUrl` is the declared `x-afp-source-url` header, falling back to the
 * route's own URL. A redelivered webhook — dropped at P1 dedupe — is still a
 * 202 from the sender's view (G1): initiated and duplicate both answer 202.
 */
export function handleWebhook(
  instance: AfpInstance,
  route: WebhookRoute,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const cap = instance.config.maxInboxBodyBytes;
  const chunks: Buffer[] = [];
  let received = 0;
  let overCap = false;
  req.on("data", (chunk: Buffer) => {
    if (overCap) return;
    received += chunk.length;
    if (received > cap) {
      overCap = true;
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "payload too large" }));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (overCap) return;
    const body = Buffer.concat(chunks);
    const signature = String(req.headers["x-afp-signature"] ?? "") || undefined;
    if (!verifyWebhookSignature(route.secret, body, signature)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad signature" }));
      return;
    }

    const externalId = String(req.headers["x-afp-external-id"] ?? "");
    if (!externalId) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "missing x-afp-external-id" }));
      return;
    }

    const sourceUrl =
      String(req.headers["x-afp-source-url"] ?? "") || `${instance.config.origin}/ports/${route.name}/webhook`;
    const mediaType = String(req.headers["content-type"] ?? "") || "application/octet-stream";

    const event: ExternalEvent = {
      externalId,
      payload: new Uint8Array(body),
      mediaType,
      sourceUrl,
      receivedAt: instance.clock.now().toISOString(),
    };

    try {
      const result = instance.initiate(route.initiator, event, {
        to: route.to,
        thread: route.thread,
        pins: route.pins,
        visibility: route.visibility,
      });
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: result.status, correlationId: result.correlationId }));
    } catch (error) {
      if (error instanceof IngestionRefused) {
        res.writeHead(422, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "ingestion refused", reason: error.message }));
        return;
      }
      // Anything else is the instance's own fault (an initiator naming no
      // registered agent, say). A throw here would escape the request's
      // event handler as an uncaught exception and take the process down —
      // the answer is a 500 with no detail, and the record untouched.
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    }
  });
}

/**
 * Matches `POST /ports/<name>/webhook` against the configured routes, or
 * `null` when the path/method does not name a mounted webhook — the smallest
 * hook `ap/server.ts` needs (Decision 3).
 */
export function matchWebhookRoute(
  routes: readonly WebhookRoute[],
  method: string,
  path: string,
): WebhookRoute | null {
  if (method !== "POST") return null;
  const match = path.match(/^\/ports\/([\w-]+)\/webhook$/);
  if (!match) return null;
  return routes.find((route) => route.name === match[1]) ?? null;
}
