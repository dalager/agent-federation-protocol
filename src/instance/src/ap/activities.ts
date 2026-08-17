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
  attachments?: JsonValue[];
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
  if (result.attachments?.length) object.attachment = result.attachments;

  return { ...base(envelope, "Create"), object };
}

export interface ErrorSpec {
  errorId: string;
  correlationId: string;
  reason: string;
  /** Machine-readable class, e.g. `afp:err:undeliverable`. */
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
