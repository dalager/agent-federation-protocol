/**
 * The federation boundary (ADR-0008): agreements, the two-tier gate, and the
 * boundary log — one module, because they are one decision surface.
 *
 * Agreement lifecycle is dual-Create (Decision 1's implementation note):
 * `attachProof` is single-proof by construction, so each party publishes its
 * own signed `Create{afp:FederationAgreement}` over a byte-identical agreement
 * object, whose digest is the agreement's identity. An agreement is ACTIVE
 * only while this instance holds both Creates over digest-equal objects and
 * `afp:expires` has not passed — one Create is an offer on the record, not a
 * permission.
 *
 * The gate runs — operated-by → deny-list → agreement → soft
 * reputation (defined skipped for direct grants) — and every refusal lands in
 * a hash-chained, instance-signed boundary log (Decision 3): tamper-evident,
 * local by necessity, never per-probe outbox activities (a stranger who can
 * make you write to your permanent record by knocking has a spam lever).
 */

import { createHash } from "node:crypto";
import type { JsonValue } from "../crypto/jcs.ts";
import { canonicalize } from "../crypto/jcs.ts";
import { digestOf } from "../crypto/proof.ts";
import { instantMillis } from "../crypto/time.ts";
import type { Db } from "../store/db.ts";
import type { Envelope } from "../ap/activities.ts";
import { AFP_CONTEXTS } from "../ap/documents.ts";
import { admittingGrant, summarize, type AgreementObject } from "./grants.ts";

export interface AgreementSpec {
  parties: readonly [string, string];
  grants: readonly { [key: string]: JsonValue }[];
  expires: string;
}

/** The byte-identical object both parties sign. Field order is irrelevant — JCS sorts. */
export function agreementObject(spec: AgreementSpec): AgreementObject {
  return {
    type: "afp:FederationAgreement",
    "afp:parties": [...spec.parties],
    "afp:grants": spec.grants.map((grant) => ({ ...grant })),
    "afp:expires": spec.expires,
  };
}

/** `Offer{afp:FederationAgreement}` — the handshake's first move (01). */
export function offerAgreement(envelope: Envelope, object: AgreementObject): { [key: string]: JsonValue } {
  return base(envelope, "Offer", object);
}

/** `Create{afp:FederationAgreement}` — one party's countersignature-by-publication. */
export function createAgreement(envelope: Envelope, object: AgreementObject): { [key: string]: JsonValue } {
  return base(envelope, "Create", object);
}

/** `afp:Defederate` — a signed activity in the ISSUING instance's own outbox:
 * advisory to the other side (which may never receive it), load-bearing on
 * one's own — the record shows when and why the door closed. */
export function defederate(envelope: Envelope, counterparty: string, reason: string): { [key: string]: JsonValue } {
  return {
    ...base(envelope, "afp:Defederate", counterparty),
    summary: reason,
  };
}

function base(envelope: Envelope, type: string, object: JsonValue): { [key: string]: JsonValue } {
  const activity: { [key: string]: JsonValue } = {
    "@context": AFP_CONTEXTS,
    id: envelope.activityId,
    type,
    actor: envelope.actor,
    to: [...envelope.to],
    published: envelope.published,
    context: envelope.thread,
    "afp:visibility": envelope.visibility,
    object,
  };
  if (envelope.prevActivity !== null) activity["afp:prevActivity"] = envelope.prevActivity;
  return activity;
}

export type GateOutcome =
  | { admitted: true; grant: { [key: string]: JsonValue }; agreement: AgreementObject }
  | { admitted: false; step: string; reason: string };

export class Federation {
  private readonly db: Db;
  private readonly selfActor: string;
  private readonly now: () => Date;

  constructor(db: Db, selfActor: string, now: () => Date) {
    this.db = db;
    this.selfActor = selfActor;
    this.now = now;
    // ADR-0032 Decision 4: fed_* tables come from openDb's migration now, not a
    // constructor-time exec — one door for schema, applied once at store open.
  }

  // ------------------------------------------------------------- agreements

  /** Record our own signed Create over the agreement object. */
  recordOwnCreate(object: AgreementObject, signedCreate: { [key: string]: JsonValue }): string {
    return this.record(object, "own_create_json", signedCreate);
  }

  /** Record the counterparty's signed Create, received through the inbox. The
   * object must be byte-identical to ours (digest equality) — a differing
   * object is a different agreement, not a countersignature. */
  recordTheirCreate(object: AgreementObject, signedCreate: { [key: string]: JsonValue }): string {
    return this.record(object, "their_create_json", signedCreate);
  }

  private record(object: AgreementObject, column: "own_create_json" | "their_create_json", signed: { [key: string]: JsonValue }): string {
    const digest = digestOf(object);
    const parties = (object["afp:parties"] as JsonValue[]) ?? [];
    const counterparty = String(parties.find((p) => p !== this.selfActor) ?? "");
    this.db.run(
        `INSERT INTO fed_agreements (digest, object_json, counterparty, expires, ${column})
           VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (digest) DO UPDATE SET ${column} = excluded.${column}`,
        digest, JSON.stringify(object), counterparty, String(object["afp:expires"] ?? ""), JSON.stringify(signed));
    return digest;
  }

  /** Active = both Creates held over digest-equal objects, and not expired at `at`. */
  activeAgreementsWith(counterparty: string, at: Date = this.now()): AgreementObject[] {
    const rows = this.db.all(
        "SELECT object_json, expires FROM fed_agreements WHERE counterparty = ? AND own_create_json IS NOT NULL AND their_create_json IS NOT NULL",
        counterparty,
      ) as { object_json: string; expires: string }[];
    return rows
      .filter((row) => at.getTime() < instantMillis(row.expires))
      .map((row) => JSON.parse(row.object_json) as AgreementObject);
  }

  /** All agreements with a counterparty regardless of expiry — the late-outcome rule needs them. */
  agreementsWith(counterparty: string): AgreementObject[] {
    const rows = this.db.all(
        "SELECT object_json FROM fed_agreements WHERE counterparty = ? AND own_create_json IS NOT NULL AND their_create_json IS NOT NULL",
        counterparty,
      ) as { object_json: string }[];
    return rows.map((row) => JSON.parse(row.object_json) as AgreementObject);
  }

  /** Store an admitted cross-boundary activity verbatim (ADR-0009). */
  recordReceived(activity: { [key: string]: JsonValue }, fromInstance: string): void {
    this.db.run(
        "INSERT INTO fed_received (digest, from_instance, at, activity_json) VALUES (?, ?, ?, ?) ON CONFLICT (digest) DO NOTHING",
        digestOf(activity,
      ), fromInstance, this.now().toISOString(), JSON.stringify(activity));
  }

  receivedActivities(): { digest: string; fromInstance: string; activity: { [key: string]: JsonValue } }[] {
    const rows = this.db.all("SELECT * FROM fed_received ORDER BY at, digest") as Record<string, unknown>[];
    return rows.map((row) => ({
      digest: String(row.digest),
      fromInstance: String(row.from_instance),
      activity: JSON.parse(String(row.activity_json)),
    }));
  }

  /** Record an admitted cross-boundary correlation's acceptance instant. */
  recordAccept(correlationId: string, counterparty: string, published: string): void {
    this.db.run(
        "INSERT INTO fed_accepts (correlation_id, counterparty, published) VALUES (?, ?, ?) ON CONFLICT (correlation_id) DO NOTHING",
        correlationId, counterparty, published,
      );
  }

  acceptPublishedFor(correlationId: string): string | null {
    const row = this.db.get("SELECT published FROM fed_accepts WHERE correlation_id = ?",
      correlationId
    ) as { published?: string } | undefined;
    return row?.published ?? null;
  }

  denylist(instance: string, reason: string): void {
    this.db.run("INSERT INTO fed_denylist (instance, at, reason) VALUES (?, ?, ?) ON CONFLICT (instance) DO NOTHING",
      instance, this.now().toISOString(), reason
    );
  }

  isDenylisted(instance: string): boolean {
    return this.db.get("SELECT 1 FROM fed_denylist WHERE instance = ?", instance) !== undefined;
  }

  // ------------------------------------------------------------------ gate

  /**
   * The two-tier gate (01, amended by ADR-0008; order stated as executed per
   * ADR-0016 T6e): operated-by binding → deny-list → agreement grant.
   * Check 4 (hub-scoped reputation, soft) is defined
   * skipped for direct-delegation traffic — no hub, no reputation to weigh.
   *
   * `operatedBy` is the sending agent's `afp:operatedBy`, resolved by the
   * caller from the counterparty's published actor document (the fetch
   * bootstrap: actor documents are public).
   */
  gate(activity: { [key: string]: JsonValue }, operatedBy: string | null): GateOutcome {
    const summary = summarize(activity);
    const refuse = (step: string, reason: string): GateOutcome => {
      this.logRejection(activity, step, reason);
      return { admitted: false, step, reason };
    };

    if (!operatedBy) {
      return refuse("operated-by", "sender's actor document names no afp:operatedBy — no operator to hold an agreement with");
    }
    if (this.isDenylisted(operatedBy)) {
      return refuse("denylist", `${operatedBy} is deny-listed`);
    }

    const at = this.now();
    const active = this.activeAgreementsWith(operatedBy, at);

    // Decision 4: a response on an in-time-accepted correlation outlives the
    // agreement. The caller passes responsibility for the Accept-in-time
    // lookup via lateOutcomeAdmissible(); the gate handles the common path.
    for (const agreement of active) {
      const grant = admittingGrant(agreement, summary);
      if (grant) return { admitted: true, grant, agreement };
    }

    const anyAgreement = this.agreementsWith(operatedBy);
    if (anyAgreement.length === 0) {
      return refuse("agreement", `no agreement with ${operatedBy} — hard reject, unopened`);
    }
    return refuse(
      "agreement",
      `no active grant admits ${summary.type}{${summary.objectType}}` +
        (summary.capability ? ` on ${summary.capability}` : "") +
        ` — agreements with ${operatedBy} exist but are expired or do not cover it`,
    );
  }

  /** Decision 4's late-outcome path: a Result/Error after expiry is admissible
   * iff its correlation was accepted in time. The caller supplies the Accept's
   * published instant (from its own record of the counterparty's Accept). */
  lateOutcomeAdmissible(counterparty: string, acceptPublished: string | null): boolean {
    if (acceptPublished === null) return false;
    const acceptAt = instantMillis(acceptPublished);
    return this.agreementsWith(counterparty).some((agreement) => acceptAt < instantMillis(String(agreement["afp:expires"] ?? "")));
  }

  // ---------------------------------------------------------- boundary log

  private logRejection(activity: { [key: string]: JsonValue }, step: string, reason: string): void {
    const prev = this.db.get("SELECT entry_hash FROM fed_boundary_log ORDER BY seq DESC LIMIT 1") as { entry_hash?: string } | undefined;
    const entry = {
      at: this.now().toISOString(),
      actor: String(activity.actor ?? "<none>"),
      claimed_type: String(activity.type ?? "<none>"),
      step,
      reason,
      activity_digest: digestOf(activity),
    };
    const hash = createHash("sha256")
      .update(canonicalize(entry as unknown as JsonValue))
      .update(prev?.entry_hash ?? "genesis")
      .digest("hex");
    this.db.run(
        "INSERT INTO fed_boundary_log (at, actor, claimed_type, step, reason, activity_digest, entry_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
        entry.at, entry.actor, entry.claimed_type, entry.step, entry.reason, entry.activity_digest, hash,
      );
  }

  boundaryLog(): { at: string; actor: string; claimedType: string; step: string; reason: string; entryHash: string }[] {
    const rows = this.db.all("SELECT * FROM fed_boundary_log ORDER BY seq") as Record<string, unknown>[];
    return rows.map((row) => ({
      at: String(row.at),
      actor: String(row.actor),
      claimedType: String(row.claimed_type),
      step: String(row.step),
      reason: String(row.reason),
      entryHash: String(row.entry_hash),
    }));
  }

  /** Recompute the chain — a tampered row breaks every hash after it. */
  verifyBoundaryLog(): boolean {
    const rows = this.db.all("SELECT * FROM fed_boundary_log ORDER BY seq") as Record<string, unknown>[];
    let prev = "genesis";
    for (const row of rows) {
      const entry = {
        at: String(row.at),
        actor: String(row.actor),
        claimed_type: String(row.claimed_type),
        step: String(row.step),
        reason: String(row.reason),
        activity_digest: String(row.activity_digest),
      };
      const expected = createHash("sha256").update(canonicalize(entry as unknown as JsonValue)).update(prev).digest("hex");
      if (expected !== String(row.entry_hash)) return false;
      prev = expected;
    }
    return true;
  }

  /** `afp:BoundaryDigest` payload — the outbox carries a heartbeat-sized
   * commitment; the log carries the detail (Decision 3). */
  boundaryDigest(): { [key: string]: JsonValue } {
    const count = this.db.get("SELECT COUNT(*) AS n FROM fed_boundary_log") as { n: number };
    const head = this.db.get("SELECT entry_hash FROM fed_boundary_log ORDER BY seq DESC LIMIT 1") as { entry_hash?: string } | undefined;
    return {
      type: "afp:BoundaryDigest",
      "afp:entryCount": Number(count.n),
      "afp:logRoot": head?.entry_hash ? `sha256:${head.entry_hash}` : "genesis",
    };
  }
}
