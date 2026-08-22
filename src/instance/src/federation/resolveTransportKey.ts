/**
 * Shared HTTP-signature keyId resolution (ADR-0017 Decision 4, R1).
 *
 * `authentication` is the transport contract: an actor document's transport
 * key is published there under `#transport-key`, and this is where a
 * verifier should look first. `assertionMethod` is kept as a compatibility
 * fallback so hops signed with the older proof key (as every existing test
 * does) still verify during the transition window — it is not the contract.
 *
 * Object-proof verification (`proofVerifies` in inbox.ts, `verifySignature`
 * in hub.ts, the MembershipProof check in readGate.ts) must never call this
 * helper or read `authentication` — those stay assertionMethod-only.
 */

import type { KeyObject } from "node:crypto";
import type { JsonValue } from "../crypto/jcs.ts";
import { publicKeyFromMultibase } from "../crypto/keys.ts";

function findInMethods(methods: JsonValue[], keyId: string): KeyObject | null {
  for (const entry of methods) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const method = entry as { id?: JsonValue; publicKeyMultibase?: JsonValue };
      if (method.id === keyId && typeof method.publicKeyMultibase === "string") {
        try {
          return publicKeyFromMultibase(method.publicKeyMultibase);
        } catch {
          /* undecodable key: caller's verification fails on its own */
        }
      }
    }
  }
  return null;
}

/**
 * Resolve an HTTP-signature `keyId` against a controller document:
 * `authentication` first, then `assertionMethod` as the fallback.
 */
export function transportKeyFromDocument(
  doc: { [key: string]: JsonValue } | null,
  keyId: string,
): KeyObject | null {
  if (!doc) return null;

  const authentication = Array.isArray(doc.authentication) ? (doc.authentication as JsonValue[]) : [];
  const fromAuthentication = findInMethods(authentication, keyId);
  if (fromAuthentication) return fromAuthentication;

  const assertionMethod = Array.isArray(doc.assertionMethod) ? (doc.assertionMethod as JsonValue[]) : [];
  return findInMethods(assertionMethod, keyId);
}
