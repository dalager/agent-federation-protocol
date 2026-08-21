/**
 * The boundary on the seams that exist (ADR-0008 Decision 6): `HttpTransport`
 * implements the same `Transport.deliver(target, activity)` port every
 * in-process delivery already crosses — so retry, backoff and dead-lettering
 * (P1's queue) come along unchanged. A cross-boundary delivery is a signed
 * `POST {target}/inbox`; a non-2xx response throws, which is precisely what
 * the queue's retry machinery expects of a failed hop.
 *
 * Double-knocking (ADR-0017 Decision 2): a delivery leads with the native
 * RFC 9421 signature; a 400/401 answer earns one retry signed draft-cavage,
 * and whichever scheme the peer accepted is cached per origin so the next
 * delivery knocks once. Any other failure (403, 5xx, network) is a failed
 * hop, not a scheme negotiation — it throws for the retry queue unchanged.
 */

import type { JsonValue } from "../crypto/jcs.ts";
import type { Transport } from "../store/queue.ts";
import { signRequest, signRequestCavage } from "./httpSig.ts";
import type { KeyObject } from "node:crypto";

type Scheme = "rfc9421" | "cavage";

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

function signedHeaders(
  scheme: Scheme,
  deps: HttpTransportDeps,
  inbox: URL,
  body: string,
): Record<string, string> {
  const common = { "content-type": "application/activity+json" };
  if (scheme === "cavage") {
    const s = signRequestCavage("POST", inbox.pathname, inbox.host, body, deps.keyId, deps.privateKey, deps.now());
    return { ...common, host: s.host, date: s.date, ...(s.digest ? { digest: s.digest } : {}), signature: s.signature };
  }
  const s = signRequest("POST", inbox.pathname, inbox.host, body, deps.keyId, deps.privateKey, deps.now());
  return {
    ...common,
    host: s.host,
    date: s.date,
    ...(s["content-digest"] ? { "content-digest": s["content-digest"] } : {}),
    "signature-input": s["signature-input"],
    signature: s.signature,
  };
}

export function httpTransport(deps: HttpTransportDeps): Transport {
  /** Per-origin scheme preference learned by double-knocking. */
  const preferred = new Map<string, Scheme>();

  return {
    name: "http",
    deliver: async (target: string, activity: { [key: string]: JsonValue }): Promise<void> => {
      if (deps.isLocal(target)) return deps.local.deliver(target, activity);

      const inbox = new URL(`${target}/inbox`);
      const body = JSON.stringify(activity);

      const first: Scheme = preferred.get(inbox.origin) ?? "rfc9421";
      let response = await fetch(inbox, { method: "POST", headers: signedHeaders(first, deps, inbox, body), body });

      // A 400/401 on the leading scheme means "I did not understand or accept
      // this signature" — knock again with the other scheme before declaring
      // the hop failed. Anything else is not a scheme problem.
      if ((response.status === 400 || response.status === 401) && !preferred.has(inbox.origin)) {
        const second: Scheme = first === "rfc9421" ? "cavage" : "rfc9421";
        const retry = await fetch(inbox, { method: "POST", headers: signedHeaders(second, deps, inbox, body), body });
        if (retry.ok) {
          preferred.set(inbox.origin, second);
          return;
        }
        response = retry;
      } else if (response.ok) {
        preferred.set(inbox.origin, first);
      }

      if (!response.ok) {
        throw new Error(`inbox POST to ${inbox} refused: ${response.status}`);
      }
    },
  };
}
