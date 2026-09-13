/**
 * ADR-0028: the adapter side of the two port-agent contracts. Free functions
 * over `AfpInstance`, in `instance/following.ts`'s style — thin delegating
 * methods live on the class, the substance lives here, to keep `instance.ts`
 * under its line ceiling.
 */

import type { JsonValue } from "../crypto/jcs.ts";
import { createAct, createError, createResult, type Visibility } from "../ap/activities.ts";
import { actionStamp } from "../allocation/actions.ts";
import type { TaskPins } from "../ap/pins.ts";
import type { OutboxEntry } from "../store/outbox.ts";
import type { ArtifactRef } from "../store/artifacts.ts";
import type { AfpInstance } from "../instance.ts";
import {
  correlationIdForExternal,
  idempotencyKeyOf,
  type ExternalActuator,
  type ExternalEvent,
  type ExternalInitiator,
} from "../ports/external.ts";

export type InitiateResult =
  | { status: "duplicate"; correlationId: string }
  | { status: "initiated"; correlationId: string; entry: OutboxEntry };

export interface InitiateOptions {
  to: string;
  thread: string;
  pins?: TaskPins;
  visibility?: Visibility;
}

/**
 * Turn an external event into a Task, deduping on the correlationId derived
 * from the initiator and the event's own external id (03 § External systems'
 * idempotency-key duty, applied on the read side): a redelivered webhook maps
 * to the same correlationId and the second delivery is dropped at P1 dedupe
 * (the pending-task table), publishing nothing (ADR-0028 gate G1).
 */
export function initiate(
  instance: AfpInstance,
  initiator: ExternalInitiator,
  event: ExternalEvent,
  options: InitiateOptions,
): InitiateResult {
  const correlationId = correlationIdForExternal(initiator.name, event.externalId);
  if (instance.tasks.get(correlationId)) {
    return { status: "duplicate", correlationId };
  }

  // ADR-0027 Decision 1: the payload enters as a hash-addressed artifact
  // through the same ingestion door every attachment comes through, carrying
  // the event's own sourceUrl so a brain later sees `external` provenance
  // (`inbox.ts` derives it from exactly this field). IngestionRefused
  // propagates — a payload that lies about its own type gets no Task.
  const ref: ArtifactRef = instance.artifacts.put(event.payload, event.mediaType, new Date(event.receivedAt), {
    sourceUrl: event.sourceUrl,
    fetchedAt: event.receivedAt,
  });

  const entry = instance.delegate({
    from: initiator.name,
    to: options.to,
    capability: initiator.capability,
    content: initiator.summarize(event).content,
    thread: options.thread,
    correlationId,
    attachments: [ref],
    pins: options.pins,
    visibility: options.visibility,
  });

  return { status: "initiated", correlationId, entry };
}

export interface ActuateOptions {
  action: string;
  correlationId: string;
  thread: string;
  /** Digest of what this action acts on (ADR-0006). */
  actsOn: string;
  /** Local name of the agent the intent and reconciliation activities address, if any. */
  to?: string;
}

export type ActuateResult =
  | { status: "refused"; error: OutboxEntry }
  | { status: "already-reconciled"; actuation: OutboxEntry; reconciliation: OutboxEntry }
  | { status: "reconciled"; actuation: OutboxEntry; reconciliation: OutboxEntry }
  | { status: "unreconciled"; actuation: OutboxEntry; error: OutboxEntry };

const CONTENT_HASH_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Carry out an admitted action against an external system and reconcile.
 *
 * Reconciliation is enforced here, not left to the actuator to remember
 * (ADR-0028 Decision 2): a receipt missing a reference or a well-formed
 * content hash becomes a recorded `afp:err:unreconciled`, never a silent
 * success. The intent — the acting activity carrying `afp:actsOn`/
 * `afp:action`/`afp:idempotencyKey` — is published *before* `act` is called,
 * from the outbox store rather than memory, so a crash between acting and
 * reconciling leaves a record a retry (a fresh `AfpInstance` over the same
 * data dir, calling `actuate` again with the same inputs) finds and reuses
 * rather than republishes.
 */
export async function actuate(
  instance: AfpInstance,
  actuator: ExternalActuator,
  options: ActuateOptions,
): Promise<ActuateResult> {
  const to = options.to ? [instance.actorId(options.to)] : [];

  if (actuator.refuses?.includes(options.action)) {
    const error = instance.publish(actuator.name, to, options.thread, "parties", (envelope) =>
      createError(envelope, {
        errorId: `${envelope.actor}/errors/refused-${idempotencyKeyOf(options.correlationId, options.action)}`,
        correlationId: options.correlationId,
        code: "afp:err:refused-by-contract",
        reason: `${options.action} is refused by contract for actuator ${actuator.name}`,
      }),
    );
    return { status: "refused", error };
  }

  const key = idempotencyKeyOf(options.correlationId, options.action);
  const actorId = instance.actorId(actuator.name);

  const existing = instance.outbox
    .byThread(options.thread)
    .find((entry) => entry.actor === actorId && isIntentFor(entry, key));

  const intent = existing ?? publishIntent(instance, actuator, to, options, key);

  if (existing) {
    const reconciliation = findReconciliation(instance, options.thread, existing.digest);
    if (reconciliation) {
      return { status: "already-reconciled", actuation: existing, reconciliation };
    }
  }

  const receipt = await actuator.act(options.action, {
    correlationId: options.correlationId,
    thread: options.thread,
    actsOn: options.actsOn,
    idempotencyKey: key,
  });

  if (!receipt.externalRef || !receipt.contentHash || !CONTENT_HASH_RE.test(receipt.contentHash)) {
    const error = instance.publish(actuator.name, to, options.thread, "parties", (envelope) =>
      createError(envelope, {
        errorId: `${envelope.actor}/errors/unreconciled-${key}`,
        correlationId: options.correlationId,
        code: "afp:err:unreconciled",
        reason: `${actuator.name} returned without a usable external reference or content hash for ${options.action}`,
      }),
    );
    return { status: "unreconciled", actuation: intent, error };
  }

  const reconciliation = instance.publish(actuator.name, to, options.thread, "parties", (envelope) =>
    createResult(envelope, {
      resultId: `${envelope.actor}/results/reconcile-${key}`,
      correlationId: options.correlationId,
      content: `reconciled ${options.action}: ${receipt.externalRef}`,
      reconciliation: {
        externalRef: receipt.externalRef,
        contentHash: receipt.contentHash,
        observedAt: receipt.observedAt,
        idempotencyKey: key,
        reconciles: intent.digest,
      },
    }),
  );

  return { status: "reconciled", actuation: intent, reconciliation };
}

function isIntentFor(entry: OutboxEntry, key: string): boolean {
  return entry.activity["afp:idempotencyKey"] === key && entry.activity["afp:action"] !== undefined;
}

function publishIntent(
  instance: AfpInstance,
  actuator: ExternalActuator,
  to: readonly string[],
  options: ActuateOptions,
  key: string,
): OutboxEntry {
  return instance.publish(actuator.name, to, options.thread, "parties", (envelope) =>
    createAct(envelope, {
      actId: `${envelope.actor}/acts/${key}`,
      stamp: actionStamp(options.action, options.actsOn),
      correlationId: options.correlationId,
      idempotencyKey: key,
    }),
  );
}

/** A Result on `thread` whose `afp:reconciles` names `intentDigest`, if any. */
function findReconciliation(instance: AfpInstance, thread: string, intentDigest: string): OutboxEntry | null {
  for (const entry of instance.outbox.byThread(thread)) {
    const object = entry.activity.object as Record<string, JsonValue> | undefined;
    if (object?.type === "afp:Result" && object["afp:reconciles"] === intentDigest) return entry;
  }
  return null;
}
