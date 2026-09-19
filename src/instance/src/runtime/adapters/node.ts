/**
 * ADR-0036 Decision 3 — the `node` request adapter.
 *
 * `createServer` lives here now, and it is the only thing in the request path
 * that knows `node:http` exists. It does three jobs and no others: turn an
 * `IncomingMessage` into a standard `Request`, hand it to the handler with
 * the peer address the port's `Peer` carries, and write the `Response` back.
 *
 * Draining and closing (`runtime/shutdown.ts`) stay the node profile's
 * concern, as Decision 3 says: a hosted actor has no process to drain.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

import type { Handler } from "../httpPort.ts";

/** Methods that cannot carry a body, per the fetch standard's `Request`. */
const BODILESS = new Set(["GET", "HEAD"]);

function toRequest(req: IncomingMessage, origin: string): Request {
  const url = new URL(req.url ?? "/", origin);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one);
  }

  const method = req.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (!BODILESS.has(method)) {
    // Streamed, not buffered: the body cap in `httpPort.readCappedBody` has
    // to be able to refuse before the whole payload is in memory, which it
    // cannot do if this adapter reads it first.
    init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return new Request(url, init);
}

async function writeResponse(response: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of response.headers) headers[name] = value;
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

/**
 * An HTTP server over one handler.
 *
 * `origin` only resolves the request URL — `IncomingMessage.url` is a path,
 * and `Request` needs an absolute one. It is the instance's configured
 * origin, exactly as `new URL(req.url, config.origin)` was before.
 */
export function serveHandler(handler: Handler, origin: string): Server {
  return createServer((req, res) => {
    const request = toRequest(req, origin);
    handler(request, { address: req.socket.remoteAddress ?? "unknown" })
      .then(async (response) => {
        await writeResponse(response, res);
        // A refused body was never read, so the sender may still be sending
        // one. Closing the socket is what stopped it before the port existed
        // (`req.destroy()` beside the 413) and is still the only way to stop
        // it (ADR-0025 Decision 4).
        if (response.status === 413) req.destroy();
      })
      .catch(() => {
        if (res.headersSent) {
          res.end();
          return;
        }
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal" }));
      });
  });
}
