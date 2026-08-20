/**
 * The receiving half of the boundary (ADR-0008 Decisions 2, 3, 6): HTTP
 * Signature verification, then the gate, then the same dispatch the local
 * transport feeds. Verify-then-gate before any parsing beyond the envelope —
 * the resident surface stays as small as the trust model allows.
 *
 * The bootstrap that makes any of this possible: actor documents are
 * `public`, so the unauthenticated fetch of a counterparty's actor document
 * anchors verification of everything above `public`. The regress terminates
 * by visibility design, and P4 depends on it staying that way.
 *
 * Handshake traffic (`Offer`/`Create{afp:FederationAgreement}`) bypasses the
 * grant check by construction — it is the door-knock that establishes the
 * relationship — but never the signature check or the deny-list. An
 * unsolicited countersignature parks an inert half-row: nothing activates
 * until this instance publishes its own Create over the same object digest.
 */

import type { KeyObject } from "node:crypto";
import type { JsonValue } from "../crypto/jcs.ts";
import { publicKeyFromMultibase } from "../crypto/keys.ts";
import { verifyRequest } from "./httpSig.ts";
import type { Federation } from "./federation.ts";

export interface InboxDeps {
  federation: Federation;
  selfOrigin: string;
  now: () => Date;
  /** Deliver an admitted activity into the instance — the same dispatch local transport feeds. */
  receive: (activity: { [key: string]: JsonValue }) => Promise<unknown>;
  /** Unauthenticated GET of a remote JSON document (actor documents are public). */
  fetchDocument: (url: string) => Promise<{ [key: string]: JsonValue } | null>;
}

export interface InboxOutcome {
  status: number;
  body: { [key: string]: JsonValue };
}

function isHandshake(activity: { [key: string]: JsonValue }): boolean {
  const object = activity.object;
  return (
    !!object &&
    typeof object === "object" &&
    !Array.isArray(object) &&
    (object as { [key: string]: JsonValue }).type === "afp:FederationAgreement" &&
    (activity.type === "Offer" || activity.type === "Create")
  );
}

export async function handleInboxPost(
  deps: InboxDeps,
  path: string,
  headers: { host?: string; date?: string; digest?: string; signature?: string },
  body: string,
): Promise<InboxOutcome> {
  // 1 — transport authentication, before any parsing beyond the envelope.
  const resolvedKeys = new Map<string, KeyObject>();
  const resolveKey = (keyId: string): KeyObject | null => resolvedKeys.get(keyId) ?? null;

  // Resolve the keyId's controller document once, unauthenticated (public).
  const keyId = /keyId="([^"]+)"/.exec(headers.signature ?? "")?.[1] ?? null;
  if (keyId) {
    const controller = keyId.split("#")[0];
    const doc = await deps.fetchDocument(controller);
    const methods = Array.isArray(doc?.assertionMethod) ? (doc!.assertionMethod as JsonValue[]) : [];
    for (const entry of methods) {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const method = entry as { id?: JsonValue; publicKeyMultibase?: JsonValue };
        if (method.id === keyId && typeof method.publicKeyMultibase === "string") {
          try {
            resolvedKeys.set(keyId, publicKeyFromMultibase(method.publicKeyMultibase));
          } catch {
            /* undecodable key: verification below fails with its own reason */
          }
        }
      }
    }
  }

  const transport = verifyRequest("POST", path, headers, body, resolveKey, deps.now());
  if (!transport.ok) {
    // 04's rule: unsigned or invalid deliveries are audit-logged and dropped.
    return { status: 401, body: { error: "transport authentication failed" } };
  }

  let activity: { [key: string]: JsonValue };
  try {
    activity = JSON.parse(body);
  } catch {
    return { status: 400, body: { error: "body is not JSON" } };
  }

  // 2 — resolve the sending agent's operator from its own published document.
  const actor = String(activity.actor ?? "");
  const actorDoc = actor ? await deps.fetchDocument(actor) : null;
  const docType = actorDoc?.type;
  const isInstanceActor =
    docType === "Application" || (Array.isArray(docType) && (docType as JsonValue[]).includes("afp:Instance"));
  const operatedBy =
    actorDoc && typeof actorDoc["afp:operatedBy"] === "string"
      ? String(actorDoc["afp:operatedBy"])
      : isInstanceActor
        ? actor // an instance actor speaks for itself
        : null;

  // 3 — handshake traffic establishes the relationship the gate would check.
  if (isHandshake(activity)) {
    if (operatedBy && deps.federation.isDenylisted(operatedBy)) {
      return { status: 403, body: { error: "refused" } };
    }
    if (activity.type === "Create") {
      const object = activity.object as { [key: string]: JsonValue };
      deps.federation.recordTheirCreate(object, activity);
    }
    await deps.receive(activity);
    return { status: 202, body: { accepted: true } };
  }

  // 4 — the two-tier gate. A refusal is logged (hash-chained) and opaque:
  // the response says no more than the visibility design allows.
  const outcome = deps.federation.gate(activity, operatedBy);
  if (!outcome.admitted) {
    // Decision 4's late-outcome path: a Result/Error on a correlation whose
    // Accept predates the agreement's expiry remains deliverable until the
    // correlation reaches its terminal outcome.
    const object = activity.object as { [key: string]: JsonValue } | undefined;
    const objectType = object && typeof object === "object" && !Array.isArray(object) ? String(object.type ?? "") : "";
    const correlation =
      object && typeof object === "object" && !Array.isArray(object) && typeof object["afp:correlationId"] === "string"
        ? String(object["afp:correlationId"])
        : null;
    if (
      operatedBy &&
      correlation &&
      (objectType === "afp:Result" || objectType === "afp:Error") &&
      deps.federation.lateOutcomeAdmissible(operatedBy, deps.federation.acceptPublishedFor(correlation))
    ) {
      await deps.receive(activity);
      return { status: 202, body: { accepted: true } };
    }
    return { status: 403, body: { error: "refused" } };
  }

  // An admitted Accept pins its correlation's acceptance instant — what a
  // post-expiry outcome will later ride.
  if (operatedBy && activity.type === "Accept") {
    const correlation =
      typeof activity["afp:correlationId"] === "string" ? String(activity["afp:correlationId"]) : null;
    if (correlation) deps.federation.recordAccept(correlation, operatedBy, String(activity.published ?? ""));
  }

  await deps.receive(activity);
  return { status: 202, body: { accepted: true } };
}
