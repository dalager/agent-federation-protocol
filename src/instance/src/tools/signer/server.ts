/**
 * `tools/signer/` — ADR-0035 Decision 3's file-backed reference
 * implementation of the remote signing service contract: `POST /sign` and
 * `GET /keys/{keyId}`, behind mutual TLS, with the client certificate bound
 * to the keyId it may sign for.
 *
 * This is the reference an operator's real KMS/HSM proxy conforms to, and
 * the one `test/adr0035.test.ts` runs the gate against. Zero dependencies
 * (ADR-0001) — `node:https`/`node:crypto`/`node:fs` only.
 *
 * Authorization is the service's own, never the client's assertion: a
 * signer that trusted whatever `keyId` it was asked for would have moved
 * the trust boundary without narrowing it. Here that means a client
 * certificate's SHA-256 fingerprint must appear in the keyId's authorized
 * list — an operator's real deployment might instead check a cert's CN or
 * SAN, but the shape (the *service* decides, never the caller) is what the
 * contract requires.
 */

import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TLSSocket } from "node:tls";
import { createPrivateKey, createPublicKey, sign as nodeSign, type KeyObject } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeEd25519Multikey } from "../../crypto/multibase.ts";

export interface SignerServerOptions {
  /** Directory holding `<safeKeyId>.pem` private keys, one per keyId this service can sign with. */
  keyDir: string;
  /** This service's own TLS identity. */
  cert: string;
  key: string;
  /** The CA that issued client certificates — required for mutual TLS. */
  ca: string;
  /** keyId -> the sha256 fingerprints (colon-hex, as Node reports them) authorized to sign with it. */
  authorizedFingerprints: Readonly<Record<string, readonly string[]>>;
  /** 0 (the default) binds an ephemeral port — what tests want; a deployment names one. */
  port?: number;
  host?: string;
}

export interface SignerServerHandle {
  readonly server: Server;
  readonly url: string;
  /** How many `/sign` calls this instance has served — the gate's "exactly one call" assertions read this. */
  readonly signCount: number;
  close(): Promise<void>;
}

function safeName(keyId: string): string {
  return keyId.replace(/[^a-zA-Z0-9]/g, "_");
}

function rawPublicKeyOf(publicKey: KeyObject): Uint8Array {
  const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32));
}

function loadPrivateKey(keyDir: string, keyId: string): KeyObject | undefined {
  const path = join(keyDir, `${safeName(keyId)}.pem`);
  if (!existsSync(path)) return undefined;
  return createPrivateKey(readFileSync(path, "utf8"));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

export function startSignerServer(options: SignerServerOptions): Promise<SignerServerHandle> {
  const state = { signCount: 0 };

  const server = createServer(
    {
      cert: options.cert,
      key: options.key,
      ca: options.ca,
      // Mutual TLS: an unauthenticated client never reaches a handler —
      // the same discipline Decision 3 asks of every implementation of
      // this contract.
      requestCert: true,
      rejectUnauthorized: true,
    },
    (req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        try {
          const socket = req.socket as TLSSocket;
          const peer = socket.getPeerCertificate();
          const fingerprint = peer?.fingerprint256 ?? "";
          const url = new URL(req.url ?? "/", "https://signer.local");

          if (req.method === "GET" && url.pathname.startsWith("/keys/")) {
            const keyId = decodeURIComponent(url.pathname.slice("/keys/".length));
            const privateKey = loadPrivateKey(options.keyDir, keyId);
            if (!privateKey) {
              sendJson(res, 404, { error: "unknown keyId" });
              return;
            }
            const publicKeyMultibase = encodeEd25519Multikey(rawPublicKeyOf(createPublicKey(privateKey)));
            sendJson(res, 200, { keyId, publicKeyMultibase });
            return;
          }

          if (req.method === "POST" && url.pathname === "/sign") {
            const parsed = JSON.parse(await readBody(req)) as {
              keyId?: string;
              alg?: string;
              message?: string;
            };
            const keyId = parsed.keyId ?? "";
            const allowed = options.authorizedFingerprints[keyId] ?? [];
            if (!allowed.includes(fingerprint)) {
              sendJson(res, 403, { error: "the client certificate is not authorized for this keyId" });
              return;
            }
            const privateKey = loadPrivateKey(options.keyDir, keyId);
            if (!privateKey) {
              sendJson(res, 404, { error: "unknown keyId" });
              return;
            }
            if (parsed.alg !== "ed25519") {
              sendJson(res, 400, { error: `unsupported alg ${String(parsed.alg)}` });
              return;
            }
            // The message, never a digest (ADR-0035 Decision 3): Ed25519
            // hashes internally, so signing a caller-supplied digest would
            // never verify over the original bytes.
            const message = Buffer.from(parsed.message ?? "", "base64");
            // Deterministic Ed25519: the same message under the same key
            // always yields the same signature, which is what makes a
            // retried /sign safe (G7).
            const signature = nodeSign(null, message, privateKey);
            state.signCount += 1;
            sendJson(res, 200, { signature: signature.toString("base64") });
            return;
          }

          sendJson(res, 404, { error: "not found" });
        } catch (error) {
          sendJson(res, 500, { error: (error as Error).message });
        }
      })();
    },
  );

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;
      resolve({
        server,
        url: `https://${options.host ?? "127.0.0.1"}:${port}`,
        get signCount() {
          return state.signCount;
        },
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}
