/**
 * Activity builders for the P1 flow: `Offer{afp:Task}` → `Accept`/`Reject` →
 * `Create{afp:Result}` or `Create{afp:Error}`.
 *
 * Two invariants are enforced here by construction rather than by review:
 *
 *  - `visibility` is a required argument, so no code path can publish an
 *    activity without a declared read class (gate check 5);
 *  - `correlationId` (one task) and `context` (one thread) are separate
 *    parameters, so the collision found by scenario 02 cannot be reintroduced.
 */

import type { JsonValue } from "../crypto/jcs.ts";
import { AFP_CONTEXTS } from "./documents.ts";

export type Visibility = "public" | "hub" | "parties" | "internal";

export interface Envelope {
  activityId: string;
  actor: string;
  to: readonly string[];
  /** Thread id — groups every activity of one case. Never a task id. */
  thread: string;
  visibility: Visibility;
  published: string;
  /** Digest of this actor's previous activity; null only for its first. */
  prevActivity: string | null;
}

function base(envelope: Envelope, type: string): { [key: string]: JsonValue } {
  const activity: { [key: string]: JsonValue } = {
    "@context": AFP_CONTEXTS,
    id: envelope.activityId,
    type,
    actor: envelope.actor,
    to: [...envelope.to],
    published: envelope.published,
    context: envelope.thread,
    "afp:visibility": envelope.visibility,
  };
  if (envelope.prevActivity !== null) activity["afp:prevActivity"] = envelope.prevActivity;
  return activity;
}

export interface TaskSpec {
  taskId: string;
  capability: string;
  correlationId: string;
  content: string;
  deadline?: string;
  /** What produced any attached work product — symmetric with `ResultSpec`. */
  producedBy?: string;
  attachments?: JsonValue[];
}

export function offerTask(envelope: Envelope, task: TaskSpec): { [key: string]: JsonValue } {
  const object: { [key: string]: JsonValue } = {
    id: task.taskId,
    type: "afp:Task",
    "afp:capability": task.capability,
    "afp:correlationId": task.correlationId,
    content: task.content,
  };
  if (task.deadline) object["afp:deadline"] = task.deadline;
  if (task.producedBy) object["afp:producedBy"] = task.producedBy;
  if (task.attachments?.length) object.attachment = task.attachments;

  return { ...base(envelope, "Offer"), object };
}

export function acceptTask(
  envelope: Envelope,
  offerId: string,
  correlationId: string,
): { [key: string]: JsonValue } {
  return {
    ...base(envelope, "Accept"),
    object: offerId,
    "afp:correlationId": correlationId,
  };
}

export function rejectTask(
  envelope: Envelope,
  offerId: string,
  correlationId: string,
  reason: string,
): { [key: string]: JsonValue } {
  return {
    ...base(envelope, "Reject"),
    object: offerId,
    "afp:correlationId": correlationId,
    summary: reason,
  };
}

export interface ResultSpec {
  resultId: string;
  correlationId: string;
  content: string;
  summary?: string;
  /** What produced the content — a model id, a rule-engine version. */
  producedBy?: string;
  attachments?: JsonValue[];
  /**
   * ADR-0004 Decision 2: the asset this result started from (id + version) and
   * the delivered adaptation's own digest — closing the reuse loop.
   */
  reused?: { asset: string; version: string; digest: string };
}

export function createResult(envelope: Envelope, result: ResultSpec): { [key: string]: JsonValue } {
  const object: { [key: string]: JsonValue } = {
    id: result.resultId,
    type: "afp:Result",
    "afp:correlationId": result.correlationId,
    content: result.content,
    attributedTo: envelope.actor,
  };
  if (result.summary) object.summary = result.summary;
  // Provenance stops at the agent-instance port unless the workflow externalizes
  // it (04 § Rationale externalization). Naming the producer is the cheapest
  // useful externalization there is.
  if (result.producedBy) object["afp:producedBy"] = result.producedBy;
  if (result.attachments?.length) object.attachment = result.attachments;
  if (result.reused) {
    object["afp:reused"] = { asset: result.reused.asset, version: result.reused.version, digest: result.reused.digest };
  }

  return { ...base(envelope, "Create"), object };
}

export interface ErrorSpec {
  errorId: string;
  correlationId: string;
  reason: string;
  /**
   * Machine-readable class, e.g. `afp:err:undeliverable` — or
   * `afp:err:insufficient-information` (03, scenario 06 finding 22): the task
   * as posed cannot be completed, and the thread closes honestly rather than
   * parking forever on a reply that may never come.
   */
  code: string;
}

/**
 * `Create{afp:Error}` — the typed failure outcome AS2 lacks.
 *
 * Dead-lettered deliveries surface through here: a delivery that exhausted its
 * attempts is a recorded local Error, never a silent drop (gate check 4).
 */
export function createError(envelope: Envelope, spec: ErrorSpec): { [key: string]: JsonValue } {
  return {
    ...base(envelope, "Create"),
    object: {
      id: spec.errorId,
      type: "afp:Error",
      "afp:correlationId": spec.correlationId,
      "afp:errorCode": spec.code,
      content: spec.reason,
      attributedTo: envelope.actor,
    },
  };
}

export interface VouchSpec {
  agent: string;
  capabilities: readonly string[];
  keyCustody: "self" | "instance";
}

/**
 * `afp:Vouch` — the instance adds or confirms a roster entry.
 *
 * The roster is a *projection* of these; assembling one straight from
 * configuration would make admission the side-channel act this activity exists
 * to prevent (01 § Vouch / disown).
 */
export function vouch(envelope: Envelope, spec: VouchSpec): { [key: string]: JsonValue } {
  return {
    ...base(envelope, "afp:Vouch"),
    object: {
      type: "afp:RosterEntry",
      agent: spec.agent,
      status: "active",
      "afp:keyCustody": spec.keyCustody,
      "afp:capabilities": [...spec.capabilities],
      since: envelope.published,
    },
  };
}

/** `afp:Disown` — the instance removes an agent from its roster. */
export function disown(
  envelope: Envelope,
  agent: string,
  reason: string,
): { [key: string]: JsonValue } {
  return {
    ...base(envelope, "afp:Disown"),
    object: { type: "afp:RosterEntry", agent, status: "removed", since: envelope.published },
    summary: reason,
  };
}

/** Read `afp:correlationId` from an activity or its object. */
export function correlationIdOf(activity: { [key: string]: JsonValue }): string | null {
  const direct = activity["afp:correlationId"];
  if (typeof direct === "string") return direct;

  const object = activity.object;
  if (object && typeof object === "object" && !Array.isArray(object)) {
    const nested = (object as { [key: string]: JsonValue })["afp:correlationId"];
    if (typeof nested === "string") return nested;
  }
  return null;
}
