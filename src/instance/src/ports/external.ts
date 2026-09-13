/**
 * The port an external system meets, on both edges.
 *
 * Same discipline as `brains/port.ts`: no ActivityPub, no signatures, no
 * SQLite, no import from `../ap/`. An adapter (`instance/external.ts`) turns
 * these two contracts into activities; nothing here knows an activity exists.
 *
 * ADR-0028 Decision 1. `ExternalInitiator` is the read side — it turns an
 * event the outside world produced into a Task, never touching the record
 * itself. `ExternalActuator` is the write side — it carries out an admitted
 * action against the external system and reports what happened, never
 * publishing anything itself (the adapter does that, so the reconciliation
 * duty is the adapter's to enforce, not the port's to remember — Decision 2).
 */

import { createHash } from "node:crypto";

/** One event as it arrived from outside AFP, before anything vouches for it. */
export interface ExternalEvent {
  /** The external system's own id for this event — a webhook delivery id, a comment id. */
  readonly externalId: string;
  readonly payload: Uint8Array;
  readonly mediaType: string;
  /** Where this event came from — becomes the artifact's `afp:sourceUrl`. */
  readonly sourceUrl: string;
  readonly receivedAt: string;
}

/**
 * Turns an external event into a Task. Enrolled as a `requester` (ADR-0004):
 * it may ask and report actuals, never bid or vote.
 */
export interface ExternalInitiator {
  /** Local agent name this initiator is enrolled as. */
  readonly name: string;
  /** The capability every Task this initiator opens asks for. */
  readonly capability: string;
  /**
   * The port's own bounded summary of `event` — never the raw payload. This
   * is what a brain sees as the Task's `content`; the payload itself enters
   * the record only as a hash-addressed artifact (03 § External systems).
   */
  summarize(event: ExternalEvent): { content: string };
}

/** What an actuation needs to bind to the record before it runs. */
export interface Justification {
  readonly correlationId: string;
  readonly thread: string;
  /** Digest of what this action acts on (ADR-0006). */
  readonly actsOn: string;
  readonly idempotencyKey: string;
}

/** What the external system says happened, once the actuator has finished. */
export interface ActuationReceipt {
  /** A branch name, a comment marker, a request token — whatever the external system will answer to. */
  readonly externalRef: string;
  /** `sha256:` + 64 hex — the content hash of what was created or changed. */
  readonly contentHash: string;
  /** RFC3339 instant the actuator observed the outcome. */
  readonly observedAt: string;
}

/**
 * Executes an admitted action against an external system. Enrolled as an
 * `actuator` (ADR-0019): reads everything, votes nowhere.
 */
export interface ExternalActuator {
  readonly name: string;
  /**
   * Action names this adapter refuses by contract, before ever calling `act`
   * — the git-forge adapter's `merge` is the ADR's example: a human's act,
   * never one this code path may take.
   */
  readonly refuses?: readonly string[];
  act(action: string, justification: Justification): Promise<ActuationReceipt>;
}

/**
 * `sha256(utf8(correlationId) ‖ 0x00 ‖ utf8(action))`, hex.
 *
 * The `‖` in 03 and the ADR is concatenation with a `0x00` separator between
 * the two UTF-8 strings — spelled out here because the spec writes the symbol
 * and a verifier has to be able to recompute the same bytes from it.
 */
export function idempotencyKeyOf(correlationId: string, action: string): string {
  const hash = createHash("sha256");
  hash.update(Buffer.from(correlationId, "utf8"));
  hash.update(Buffer.from([0x00]));
  hash.update(Buffer.from(action, "utf8"));
  return hash.digest("hex");
}

/**
 * A deterministic `correlationId` for one external event at one initiator, so
 * a redelivered webhook maps to the same id and hits P1 dedupe (the
 * pending-task table keyed by `correlationId`) rather than opening a second
 * Task.
 */
export function correlationIdForExternal(portName: string, externalId: string): string {
  const hash = createHash("sha256");
  hash.update(Buffer.from(portName, "utf8"));
  hash.update(Buffer.from([0x00]));
  hash.update(Buffer.from(externalId, "utf8"));
  return `urn:afp:ext:${hash.digest("hex")}`;
}
