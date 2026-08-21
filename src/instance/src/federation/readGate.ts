/**
 * Authorized fetch (ADR-0013) — the read half of the two-tier gate.
 *
 * ADR-0008 built the gate for the inbox `POST`: agreement → deny-list →
 * class. ADR-0013 Decision 1 refuses to fork it for `GET` — a peer that may
 * *send* an activity about a thread and a peer that may *read* it are
 * decided by one body of rules, so this module reuses the same primitives
 * (`admittingGrant`, `grantAdmits`, the agreement/deny-list stages already
 * on `Federation`) rather than reimplementing admission from scratch. The
 * only genuinely new stage is Decision 3's class predicate — "may this
 * requester see this class" — because the inbox never had to ask it.
 *
 * Identity resolution (`resolveRequester`) is lifted from the inline block
 * in `handleInboxPost` (`federation/inbox.ts`), parameterized for a
 * body-less `GET`: keyId → controller's actor document (unauthenticated —
 * the bootstrap invariant, Decision 2) → matching `assertionMethod` key →
 * `verifyRequest`. Any failure anywhere in that chain yields an anonymous
 * authorization, never an exception: a bad signature is a caller with fewer
 * rights, not an error condition.
 *
 * Decision 5 shapes what this module does *not* do: it never logs a
 * refusal. A read refusal is free, anonymous and unbounded, so recording
 * one would let any stranger write into the record. The one read this ADR
 * does log is a grant-admitted fetch (`viaGrant`), because the grant is
 * itself a recorded, expiring credential and its own reach must be
 * auditable — the caller records it, this module only marks it.
 *
 * Deps are injected exactly as `handleInboxPost` takes its deps: no
 * `AfpInstance` import, no database, no `Hub` import. This module is
 * testable without a server, by construction.
 */

import type { KeyObject } from "node:crypto";
import type { JsonValue } from "../crypto/jcs.ts";
import { publicKeyFromMultibase } from "../crypto/keys.ts";
import { verifyRequest } from "./httpSig.ts";
import { admittingGrant, type ActivitySummary } from "./grants.ts";
import { grantAdmits } from "./visibility.ts";

/** The requesting agent, and the operator (instance) it resolves to via
 * `afp:operatedBy` — the two-tier identity Decision 2 requires: agreement
 * and deny-list stages judge the operator, class stages judge the agent. */
export interface Requester {
  agent: string;
  operatedBy: string;
}

export interface ReadAuthorization {
  /** null = anonymous (no signature, or one that did not verify). */
  requester: Requester | null;
  /** May this specific activity be disclosed to this requester? */
  admits(activity: { [key: string]: JsonValue }): boolean;
  /** Set when an afp:AuditGrant widened what `admits` allows — the caller records the fetch. */
  viaGrant?: { grant: string; auditor: string };
}

export interface ReadGateDeps {
  fetchDocument: (url: string) => Promise<{ [key: string]: JsonValue } | null>;
  isDenylisted: (instanceActor: string) => boolean;
  activeAgreementsWith: (counterparty: string, at: Date) => { [key: string]: JsonValue }[];
  /** Role of an agent in a hub THIS instance hosts, or null. */
  roleOf: (hubActorId: string, agent: string) => string | null;
  /** Live afp:AuditGrant objects this instance has issued. */
  grants: () => { [key: string]: JsonValue }[];
  now: () => Date;
}

// ------------------------------------------------------------ identity

/**
 * keyId → controller actor document (unauthenticated GET, per the bootstrap
 * invariant) → the assertionMethod entry matching keyId → verified
 * signature → `afp:operatedBy`, or the actor itself when it *is* an
 * instance actor. Mirrors `handleInboxPost`'s inline resolution
 * (`federation/inbox.ts` lines ~74-153) verbatim in method, parameterized
 * for a body-less GET via `coveredHeaders("GET")` inside `verifyRequest`.
 *
 * Every failure — no keyId, no controller document, no matching key, a
 * signature that does not verify, an actor document that names no operator
 * — returns null. A `GET` gate never throws on a bad signature; it demotes
 * the caller to anonymous.
 */
async function resolveRequester(
  deps: ReadGateDeps,
  path: string,
  headers: { host?: string; date?: string; signature?: string },
): Promise<Requester | null> {
  const keyId = /keyId="([^"]+)"/.exec(headers.signature ?? "")?.[1] ?? null;
  if (!keyId) return null;

  const controller = keyId.split("#")[0];
  const controllerDoc = await deps.fetchDocument(controller);
  if (!controllerDoc) return null;

  const resolvedKeys = new Map<string, KeyObject>();
  const methods = Array.isArray(controllerDoc.assertionMethod) ? (controllerDoc.assertionMethod as JsonValue[]) : [];
  for (const entry of methods) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const method = entry as { id?: JsonValue; publicKeyMultibase?: JsonValue };
      if (method.id === keyId && typeof method.publicKeyMultibase === "string") {
        try {
          resolvedKeys.set(keyId, publicKeyFromMultibase(method.publicKeyMultibase));
        } catch {
          /* undecodable key: verification below fails on its own */
        }
      }
    }
  }
  if (!resolvedKeys.has(keyId)) return null;

  const resolveKey = (id: string): KeyObject | null => resolvedKeys.get(id) ?? null;
  const verified = verifyRequest("GET", path, headers, "", resolveKey, deps.now());
  if (!verified.ok) return null;

  const docType = controllerDoc.type;
  const isInstanceActor =
    docType === "Application" || (Array.isArray(docType) && (docType as JsonValue[]).includes("afp:Instance"));
  const operatedBy =
    typeof controllerDoc["afp:operatedBy"] === "string"
      ? String(controllerDoc["afp:operatedBy"])
      : isInstanceActor
        ? controller // an instance actor speaks for itself
        : null;
  if (!operatedBy) return null;

  return { agent: controller, operatedBy };
}

// -------------------------------------------------------------- shape

function stringField(activity: { [key: string]: JsonValue }, key: string): string | null {
  return typeof activity[key] === "string" ? String(activity[key]) : null;
}

function actorList(activity: { [key: string]: JsonValue }, key: "to" | "cc"): string[] {
  const value = activity[key];
  if (!Array.isArray(value)) return typeof value === "string" ? [value] : [];
  return value.filter((v): v is string => typeof v === "string");
}

/** `afp:hub` on the activity itself, or on its object — same shape as
 * `summarize()` in `grants.ts`, needed here because a resource's summary is
 * built from a full activity rather than an inbound envelope. */
function hubOf(activity: { [key: string]: JsonValue }): string | null {
  const own = stringField(activity, "afp:hub");
  if (own) return own;
  const object = activity.object;
  if (object && typeof object === "object" && !Array.isArray(object)) {
    return stringField(object as { [key: string]: JsonValue }, "afp:hub");
  }
  return null;
}

// ------------------------------------------------------------ predicates

/** Decision 3's `hub` row: an active, non-deny-listed agreement whose grants
 * admit that hub (reusing `admittingGrant` with a read-shaped summary), AND
 * the requesting agent holds any role in that hub — enrollment is
 * answerable only for hubs this instance hosts (`roleOf`'s scope). */
function admitsHub(deps: ReadGateDeps, requester: Requester, activity: { [key: string]: JsonValue }): boolean {
  const hub = hubOf(activity);
  if (hub === null) return false;
  if (deps.isDenylisted(requester.operatedBy)) return false;

  const summary: ActivitySummary = { type: "", objectType: "", capability: null, hub };
  const active = deps.activeAgreementsWith(requester.operatedBy, deps.now());
  const grantAdmitsHub = active.some((agreement) => admittingGrant(agreement, summary) !== null);
  if (!grantAdmitsHub) return false;

  return deps.roleOf(hub, requester.agent) !== null;
}

/** Decision 3's `parties` row: the requester's agent is named in `to`/`cc`,
 * or is itself the operating instance of a named actor (ADR-0005). No grant
 * type is required — the addressing is the entitlement — but an active,
 * non-deny-listed agreement with the requester's operator still gates it,
 * exactly as it gates every other cross-boundary read. */
function admitsParties(deps: ReadGateDeps, requester: Requester, activity: { [key: string]: JsonValue }): boolean {
  if (deps.isDenylisted(requester.operatedBy)) return false;

  const named = [...actorList(activity, "to"), ...actorList(activity, "cc")];
  const namedDirectly = named.includes(requester.agent);
  // The requester is itself an instance actor (it authenticated as its own
  // operator) and that same instance is named directly on the activity —
  // "an instance may read what its own agent was sent" for the case where
  // the instance signs on its own behalf. Resolving an *individual* named
  // agent's operator would need an extra document fetch per candidate,
  // which this predicate does not perform (see report to the integrator).
  const namedAsOperator = requester.agent === requester.operatedBy && named.includes(requester.operatedBy);
  if (!namedDirectly && !namedAsOperator) return false;

  return deps.activeAgreementsWith(requester.operatedBy, deps.now()).length > 0;
}

// -------------------------------------------------------------- gate

export async function authorizeRead(
  deps: ReadGateDeps,
  request: { path: string; headers: { host?: string; date?: string; signature?: string } },
): Promise<ReadAuthorization> {
  const requester = await resolveRequester(deps, request.path, request.headers);

  const authorization: ReadAuthorization = {
    requester,
    admits: () => false,
  };

  authorization.admits = (activity: { [key: string]: JsonValue }): boolean => {
    const visibility = stringField(activity, "afp:visibility");

    // public admits unconditionally, even anonymous; internal admits no one,
    // not even a grant holder (Decision 3 — absolute, deliberately).
    if (visibility === "public") return true;
    if (visibility === "internal") return false;
    if (requester === null) return false;

    if (visibility === "hub" && admitsHub(deps, requester, activity)) return true;
    if (visibility === "parties" && admitsParties(deps, requester, activity)) return true;

    // A4/A5: a live afp:AuditGrant widens admission for hub/parties classes
    // it names — never a bypass, checked after the ordinary predicate has
    // already failed, and never reached for internal (handled above).
    if (visibility === "hub" || visibility === "parties") {
      const grant = findAdmittingGrant(deps, requester, visibility, activity);
      if (grant) {
        authorization.viaGrant = { grant: String(grant.id ?? ""), auditor: requester.agent };
        return true;
      }
    }
    return false;
  };

  return authorization;
}

function findAdmittingGrant(
  deps: ReadGateDeps,
  requester: Requester,
  visibility: string,
  activity: { [key: string]: JsonValue },
): { [key: string]: JsonValue } | null {
  // A grant widens entitlement; it never bypasses the gate (ADR-0013
  // Decision 3). The ordinary predicates check the deny-list and then fail,
  // and this branch runs *after* them — so without this line a deny-listed
  // operator holding a live grant would be admitted by the very path that
  // was supposed to be the narrow one. Refusing an operator is the one
  // decision nothing may widen.
  if (deps.isDenylisted(requester.operatedBy)) return null;

  const thread = stringField(activity, "context") ?? "";
  const at = deps.now().toISOString();
  for (const grant of deps.grants()) {
    if (grantAdmits(grant, { auditor: requester.agent, thread, visibility, at })) return grant;
  }
  return null;
}

// Re-exported so callers assembling the read-shaped summary (A3's "read
// summary" for outbox collections and artifacts) can reuse the same type
// `admittingGrant` already agrees on, without importing grants.ts twice
// under different names.
export type { ActivitySummary };
