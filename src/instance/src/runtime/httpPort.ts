/**
 * ADR-0036 Decision 3 — the request port.
 *
 * The public surface is a function from a request to a response, over the
 * standard `Request`/`Response` the platform gives both profiles. The `node`
 * adapter (`runtime/adapters/node.ts`) wraps it in `createServer`; a hosted
 * actor's adapter would *be* its fetch method. Nothing in `ap/server.ts` or
 * the two port endpoints names `node:http` any more.
 *
 * **The peer is a second argument, and the ADR said one.** ADR-0036 Decision 3
 * writes the port as `(request: Request) => Promise<Response>`. It cannot
 * quite be: ADR-0025 Decision 5's rate limiter buckets by source address, and
 * a standard `Request` has no such field — the address is a transport fact,
 * known to whatever accepted the connection and to nothing above it. The two
 * ways to carry it are a header the adapter injects, or a parameter. A header
 * is the worse one: `x-forwarded-for`-shaped smuggling is a real attack, the
 * adapter would have to strip a client-supplied copy before setting its own,
 * and a reader of the handler could not tell the two apart. A parameter
 * cannot be spoofed by anyone who is not the adapter. So the port is
 * `(request, peer)`, and this paragraph is the deviation's record.
 */

/** What the adapter knows about the far end, and the handler cannot learn from `Request`. */
export interface Peer {
  /** Source address for the per-address bucket (ADR-0025 D5); `"unknown"` when the adapter has none. */
  readonly address: string;
}

export type Handler = (request: Request, peer: Peer) => Promise<Response>;

/** A JSON body with an explicit content type — the shape every route here returns. */
export function jsonResponse(status: number, body: unknown, contentType = "application/json", headers: HeadersInit = {}): Response {
  const payload = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  return new Response(payload, { status, headers: { "content-type": contentType, ...headers } });
}

/** The body cap's answer, kept in one place so both doors refuse alike. */
export const TOO_LARGE = Symbol("payload too large");

/**
 * Read a request body, refusing past `cap` **before** the whole thing is in
 * memory (ADR-0025 Decision 4: "capped and refused before parsing, not after
 * buffering"). Counting as the stream arrives is what keeps that true — a
 * `content-length` check alone trusts the sender's arithmetic, and
 * `arrayBuffer()` buffers first and asks later.
 */
export async function readCappedBody(request: Request, cap: number): Promise<Uint8Array | typeof TOO_LARGE> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > cap) return TOO_LARGE;

  const stream = request.body;
  if (!stream) return new Uint8Array(0);

  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > cap) {
      await reader.cancel().catch(() => {});
      return TOO_LARGE;
    }
    chunks.push(value);
  }

  const body = new Uint8Array(received);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.length;
  }
  return body;
}
