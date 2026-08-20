/**
 * Grant admissibility (ADR-0008 Decision 1) — the pure half of the boundary
 * gate, shared in shape with `src/verifier/federation.py`, which reimplements
 * it from the spec description; the raw-JSON parity harness diffs the two.
 *
 * A grant admits an activity or it does not; the gate checks each inbound
 * activity against *the grant that admits it*, never "some grant exists":
 *
 * - a `direct-delegation` grant admits the P1 delegation flow —
 *   `Offer{afp:Task}` on a capability the grant names, and the
 *   `Accept`/`Create{afp:Result}`/`Create{afp:Error}` traffic that answers it;
 * - a `hub` grant admits activities addressed to the named hub
 *   (`afp:hub` on the activity or its object) — load-bearing at P5, matched
 *   here so scenario 03's one-grant agreement is the degenerate case today.
 *
 * Grants do not cross-admit, and an unknown grant type admits nothing — the
 * closed-set discipline every registry before this one applies.
 */

import type { JsonValue } from "../crypto/jcs.ts";

export interface AgreementObject {
  [key: string]: JsonValue;
}

/** What the gate needs to know about one inbound activity to match a grant. */
export interface ActivitySummary {
  type: string;
  objectType: string;
  /** `afp:capability` of the announced/offered task, when the activity carries one. */
  capability: string | null;
  /** `afp:hub` on the activity or its object, when present. */
  hub: string | null;
}

const DELEGATION_TYPES = new Set(["Offer", "Accept", "Create", "Reject"]);
const DELEGATION_OBJECTS = new Set(["afp:Task", "afp:Result", "afp:Error", ""]);

/**
 * The first grant in the agreement that admits this activity, or null. Order
 * is the agreement's own — deterministic because the agreement is signed bytes.
 */
export function admittingGrant(
  agreement: AgreementObject,
  activity: ActivitySummary,
): { [key: string]: JsonValue } | null {
  const grants = Array.isArray(agreement["afp:grants"]) ? (agreement["afp:grants"] as JsonValue[]) : [];
  for (const entry of grants) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const grant = entry as { [key: string]: JsonValue };
    const grantType = grant["afp:grantType"];

    if (grantType === "hub") {
      if (activity.hub !== null && activity.hub === grant["afp:hub"]) return grant;
      continue;
    }

    if (grantType === "direct-delegation") {
      // Hub-addressed traffic never rides a delegation grant (no cross-admit).
      if (activity.hub !== null) continue;
      if (!DELEGATION_TYPES.has(activity.type)) continue;
      if (!DELEGATION_OBJECTS.has(activity.objectType)) continue;
      if (activity.type === "Offer" || activity.objectType === "afp:Task") {
        // The opening move must name a granted capability.
        const capabilities = Array.isArray(grant["afp:capabilities"])
          ? (grant["afp:capabilities"] as JsonValue[])
          : [];
        if (activity.capability === null || !capabilities.includes(activity.capability)) continue;
      }
      // Responses (Accept / Result / Error / Reject) ride the relationship the
      // grant establishes; the expiry rule (Decision 4) is what constrains
      // them in time, not re-matching a capability they do not carry.
      return grant;
    }
    // Unknown grant type: admits nothing.
  }
  return null;
}

/** Extract the summary the gate matches on, from a raw activity. */
export function summarize(activity: { [key: string]: JsonValue }): ActivitySummary {
  const object = activity.object;
  const objectRecord =
    object && typeof object === "object" && !Array.isArray(object) ? (object as { [key: string]: JsonValue }) : null;
  const hub =
    typeof activity["afp:hub"] === "string"
      ? String(activity["afp:hub"])
      : objectRecord && typeof objectRecord["afp:hub"] === "string"
        ? String(objectRecord["afp:hub"])
        : null;
  return {
    type: String(activity.type ?? ""),
    objectType: objectRecord ? String(objectRecord.type ?? "") : "",
    capability: objectRecord && typeof objectRecord["afp:capability"] === "string" ? String(objectRecord["afp:capability"]) : null,
    hub,
  };
}
