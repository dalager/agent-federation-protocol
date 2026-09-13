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
import { buildPinSet, type TaskPins } from "./pins.ts";

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
  /**
   * ADR-0010 Decision 1: the direct flow's carrier for the same pins the
   * Announce carries — published before any answer exists, on the same
   * `afp:Task` object, so a target-known delegation is checkable without a
   * degenerate one-bidder auction.
   */
  pins?: TaskPins;
  /**
   * ADR-0011 Decision 4: names the closed thread this one continues, when this
   * task opens a new ask on new information rather than revising the existing
   * answer. Deliberately NOT part of the pin set — it identifies this thread's
   * prehistory, not anything about the answer, so a fan-out's opening Offer
   * may carry it while the rest do not without that reading as pin divergence.
   */
  priorThread?: string;
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
  // ADR-0010 Decision 1: pins live on the task-bearing activity, and a fan-out
  // of several Offers on one thread must carry a byte-identical set of them —
  // which is why they are built once, as one value, rather than field by field.
  if (task.pins) Object.assign(object, buildPinSet(task.pins));
  // ADR-0011 Decision 4: outside buildPinSet on purpose — prehistory, not a pin.
  if (task.priorThread) object["afp:priorThread"] = task.priorThread;

  // AS2 Offer means "offering object *to target*" (Vocab §3.1); the party
  // being offered the task is named as `target`, not only as an addressee
  // (ADR-0017 Decision 6, closing critique finding 1.6).
  const target: JsonValue = envelope.to.length === 1 ? envelope.to[0] : [...envelope.to];

  return { ...base(envelope, "Offer"), ...(envelope.to.length > 0 ? { target } : {}), object };
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
  /**
   * ADR-0022 Decision 2 / 03 § Co-work: the authors, where a Result truly has
   * no single one. Absent, `attributedTo` is the emitting actor alone and
   * nothing changes — which is every Result this repository has ever written.
   */
  attributedTo?: readonly string[];
  /**
   * ADR-0022 Decision 2a: actor → **positive integer share**; the denominator
   * is their sum. 03 specified this as "a map of actor → fraction summing to
   * 1", which the AFP JCS numeric profile cannot express — the identical wall
   * ADR-0005 hit for vote weights and solved with integer shares over an LCM
   * denominator. Shares scale to a common denominator the same way; no second
   * arithmetic is introduced, and an implementer writing a rounding rule has
   * taken a wrong turn.
   */
  contributionSplit?: Readonly<Record<string, number>>;
  /**
   * ADR-0028 Decision 2: the reconciliation a port agent's adapter owes for an
   * external side effect — the external reference, the content hash of what
   * was created, when it was observed, the idempotency key it was presented
   * under, and the digest of the actuation activity this Result reconciles.
   * A Result built without it is byte-identical to one from before this
   * decision existed.
   */
  reconciliation?: {
    externalRef: string;
    contentHash: string;
    observedAt: string;
    idempotencyKey: string;
    reconciles: string;
  };
}

export function createResult(envelope: Envelope, result: ResultSpec): { [key: string]: JsonValue } {
  const authors = result.attributedTo ? [...result.attributedTo] : null;
  const object: { [key: string]: JsonValue } = {
    id: result.resultId,
    type: "afp:Result",
    "afp:correlationId": result.correlationId,
    content: result.content,
    attributedTo: authors && authors.length > 1 ? authors : (authors?.[0] ?? envelope.actor),
  };
  // ADR-0022 Decision 2b: the MUST binds the writer. 03 states a requirement
  // ("the emitting instances MUST also state a contribution split") and a
  // fallback in the same breath ("absent it, verifiers count such a Result for
  // no one") — and a rule with a defined fallback is a rule nobody keeps. It
  // has been normative since v3.4 and implemented never, which is exactly how
  // the most collaborative operator became the least visible one in the
  // ledger. Refused here, before anything is signed, rather than left for a
  // verifier to notice about a record that already exists.
  if (authors && authors.length > 1) {
    const split = result.contributionSplit;
    if (!split) {
      throw new Error(
        `a Result attributed to ${authors.length} actors must state afp:contributionSplit (03, ADR-0022): ${authors.join(", ")}`,
      );
    }
    const keys = Object.keys(split);
    const missing = authors.filter((actor) => !(actor in split));
    const strangers = keys.filter((actor) => !authors.includes(actor));
    if (missing.length || strangers.length) {
      throw new Error(
        `afp:contributionSplit must name exactly the attributedTo set (ADR-0022)` +
          (missing.length ? `; missing ${missing.join(", ")}` : "") +
          (strangers.length ? `; not an author: ${strangers.join(", ")}` : ""),
      );
    }
    for (const [actor, share] of Object.entries(split)) {
      if (!Number.isInteger(share) || share < 1) {
        throw new Error(
          `afp:contributionSplit share for ${actor} must be a positive integer, got ${share} — ` +
            `the JCS numeric profile forbids fractions in a signed document (ADR-0005, ADR-0022)`,
        );
      }
    }
    object["afp:contributionSplit"] = { ...split };
  } else if (result.contributionSplit) {
    throw new Error("afp:contributionSplit on a single-author Result divides nothing (ADR-0022)");
  }
  if (result.summary) object.summary = result.summary;
  // Provenance stops at the agent-instance port unless the workflow externalizes
  // it (04 § Rationale externalization). Naming the producer is the cheapest
  // useful externalization there is.
  if (result.producedBy) object["afp:producedBy"] = result.producedBy;
  if (result.attachments?.length) object.attachment = result.attachments;
  if (result.reused) {
    object["afp:reused"] = { asset: result.reused.asset, version: result.reused.version, digest: result.reused.digest };
  }
  if (result.reconciliation) {
    object["afp:externalRef"] = result.reconciliation.externalRef;
    object["afp:contentHash"] = result.reconciliation.contentHash;
    object["afp:observedAt"] = result.reconciliation.observedAt;
    object["afp:idempotencyKey"] = result.reconciliation.idempotencyKey;
    object["afp:reconciles"] = result.reconciliation.reconciles;
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

/**
 * `Create{afp:ControlTransfer}` — the instance declares who now operates it
 * (ADR-0005 amendment: declared change of control).
 *
 * Published by the transferring instance actor on its own outbox chain, same
 * class as `Vouch`/`Disown`: a change of control is a recorded, signed act,
 * never an inference. `afp:operatedBy` names the *new* operator — another
 * instance actor, for the declared-common-control case scenario 12's finding
 * 63 describes — and takes effect from this activity's own `published`. No
 * retroactivity: a snapshot pinned before this activity existed is untouched.
 */
export function controlTransfer(envelope: Envelope, operatedBy: string): { [key: string]: JsonValue } {
  return {
    ...base(envelope, "Create"),
    object: {
      id: `${envelope.activityId}#control-transfer`,
      type: "afp:ControlTransfer",
      "afp:operatedBy": operatedBy,
      since: envelope.published,
    },
  };
}

/**
 * `Create{afp:KeyCompromiseClaim}` — ADR-0021 Decision 4a.
 *
 * Published by the convicted agent's **own instance** on its own chain: the
 * same self-referential class as `Vouch`, `Disown` and `ControlTransfer`, held
 * to the same standard, because a valid signature from the instance that
 * operates the agent is exactly the entitlement the record needs for a party
 * to say something about itself.
 *
 * It changes **nothing** automatically, and an implementer must resist the
 * obvious wrong turn: a claim is not evidence and must never gate, delay or
 * reverse zeroing, which stays automatic and stays where ADR-0020 put it.
 * What the claim buys is that the record can tell `zeroed` from
 * `zeroed-contested` — the difference between a sanction and an incident,
 * which was previously unsayable. Argue it in a governance round; the record
 * carries the argument, not the verdict.
 */
export function keyCompromiseClaim(
  envelope: Envelope,
  spec: { proof: string; verificationMethod: string; since: string; content?: string },
): { [key: string]: JsonValue } {
  const object: { [key: string]: JsonValue } = {
    id: `${envelope.activityId}#key-compromise-claim`,
    type: "afp:KeyCompromiseClaim",
    "afp:proof": spec.proof,
    "afp:verificationMethod": spec.verificationMethod,
    "afp:since": spec.since,
  };
  if (spec.content) object.content = spec.content;
  return { ...base(envelope, "Create"), object };
}

/**
 * `Follow{actor, object: target}` (ADR-0017 Decision 4, R3) — the instance
 * actor's door-knock at a hub, published `public` as governance trail, same
 * class as Vouch/Disown.
 */
export function follow(envelope: Envelope, target: string): { [key: string]: JsonValue } {
  return { ...base(envelope, "Follow"), object: target };
}

/**
 * `Undo{Follow}` — revokes a prior Follow. `object` names the Follow
 * activity id being undone; `target` names the hub, for cheap resolution
 * without dereferencing the object.
 */
export function undoFollow(envelope: Envelope, followActivityId: string, target: string): { [key: string]: JsonValue } {
  return { ...base(envelope, "Undo"), object: followActivityId, target };
}

/** Read `afp:correlationId` from an activity or its object. */
/**
 * ADR-0028: the acting activity a port agent's adapter records *before* the
 * external write — `Create{afp:Act}` with the ADR-0006 stamp and the
 * idempotency key at the top level, where `afp:action`/`afp:actsOn` already
 * live, so the retry lookup and the verifier read one shape.
 */
export function createAct(
  envelope: Envelope,
  spec: {
    actId: string;
    /** `afp:action` and `afp:actsOn`, from `allocation/actions.ts`'s stamps. */
    stamp: { [key: string]: JsonValue };
    correlationId: string;
    idempotencyKey: string;
  },
): { [key: string]: JsonValue } {
  return {
    ...base(envelope, "Create"),
    object: { id: spec.actId, type: "afp:Act" },
    ...spec.stamp,
    "afp:idempotencyKey": spec.idempotencyKey,
    "afp:correlationId": spec.correlationId,
  };
}

/**
 * ADR-0031 Decision 1 / ADR-0008 Decision 3: the optional heartbeat —
 * `Create{afp:BoundaryDigest}` on the instance's own chain, `internal`
 * visibility (it is the operator's own commitment to the boundary log, not a
 * federated claim). `digest` is `federation.boundaryDigest()`'s payload,
 * unmodified — the outbox carries the heartbeat-sized commitment; the
 * boundary log itself carries the detail.
 */
export function createBoundaryDigest(
  envelope: Envelope,
  digest: { [key: string]: JsonValue },
): { [key: string]: JsonValue } {
  return {
    ...base(envelope, "Create"),
    object: { ...digest, id: `${envelope.actor}/boundary-digests/${envelope.activityId.split("/").pop()}` },
  };
}

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
