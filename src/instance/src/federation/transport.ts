/**
 * The boundary on the seams that exist (ADR-0008 Decision 6): `HttpTransport`
 * implements the same `Transport.deliver(target, activity)` port every
 * in-process delivery already crosses — so retry, backoff and dead-lettering
 * (P1's queue) come along unchanged. A cross-boundary delivery is a signed
 * `POST {target}/inbox`; a non-2xx response throws, which is precisely what
 * the queue's retry machinery expects of a failed hop.
 */

import type { JsonValue } from "../crypto/jcs.ts";
import type { Transport } from "../store/queue.ts";
import { signRequest } from "./httpSig.ts";
import type { KeyObject } from "node:crypto";

export interface HttpTransportDeps {
  /** The hop's signing identity — the instance key, not an agent's. */
  keyId: string;
  privateKey: KeyObject;
  now: () => Date;
  /** Which targets are local (handled elsewhere) vs cross-boundary. */
  isLocal: (target: string) => boolean;
  /** Fallback for local targets, so one transport serves both worlds. */
  local: Transport;
}

export function httpTransport(deps: HttpTransportDeps): Transport {
  return {
    name: "http",
    deliver: async (target: string, activity: { [key: string]: JsonValue }): Promise<void> => {
      if (deps.isLocal(target)) return deps.local.deliver(target, activity);

      const inbox = new URL(`${target}/inbox`);
      const body = JSON.stringify(activity);
      const headers = signRequest("POST", inbox.pathname, inbox.host, body, deps.keyId, deps.privateKey, deps.now());

      const response = await fetch(inbox, {
        method: "POST",
        headers: {
          "content-type": "application/activity+json",
          host: headers.host,
          date: headers.date,
          digest: headers.digest,
          signature: headers.signature,
        },
        body,
      });
      if (!response.ok) {
        throw new Error(`inbox POST to ${inbox} refused: ${response.status}`);
      }
    },
  };
}
