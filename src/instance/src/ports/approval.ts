/**
 * The human as a port agent (ADR-0028 Decision 4): scenario 01's kickoff and
 * approval. `ApprovalPort`'s "external system" is a person with latency; the
 * controller binding is the instance's own policy — ADR-0029 Decision 2 says
 * this stands in for ADR-0033's signed policy document until it exists (see
 * `Config.controllers` in `config.ts`).
 *
 * An unauthorized or off-policy answer is refused before anything is
 * published (G7's first half): ADR-0029's premise is that a stranger's
 * attempt is not the record's business, so no activity is minted for it. An
 * authorized answer enters the record as an ordinary actuation, through the
 * same `instance.actuate` every other external outcome reconciles through —
 * the human's decision is as checkable as the one the agents took, and
 * distinct from it.
 */

import { createHash } from "node:crypto";
import type { AfpInstance } from "../instance.ts";
import type { ExternalActuator, Justification, ActuationReceipt } from "../ports/external.ts";
import type { ActionPolicy } from "../ap/pins.ts";
import { admissibleAction } from "../allocation/actions.ts";
import type { ActuateResult } from "../instance/external.ts";

export interface ApprovalPort {
  present(record: {
    decisionRecordDigest: string;
    thread: string;
    summary: string;
    options: readonly string[];
  }): Promise<{ decision: string; by: string; note?: string }>;
}

export class ApprovalRefused extends Error {
  readonly by: string;
  constructor(message: string, by: string) {
    super(message);
    this.name = "ApprovalRefused";
    this.by = by;
  }
}

export interface ApproveThroughPortOptions {
  actuatorName: string;
  decisionRecordDigest: string;
  thread: string;
  summary: string;
  /** Pins `approve`/`reject` (or whatever categories this decision names) to actions. */
  policy: ActionPolicy;
  correlationId: string;
}

/** `sha256:` + sha256 hex of `${decisionRecordDigest}\0${decision}\0${by}` — what the reconciliation's `afp:contentHash` binds to. */
function approvalContentHash(decisionRecordDigest: string, decision: string, by: string): string {
  const hash = createHash("sha256");
  hash.update(Buffer.from(decisionRecordDigest, "utf8"));
  hash.update(Buffer.from([0x00]));
  hash.update(Buffer.from(decision, "utf8"));
  hash.update(Buffer.from([0x00]));
  hash.update(Buffer.from(by, "utf8"));
  return `sha256:${hash.digest("hex")}`;
}

export async function approveThroughPort(
  instance: AfpInstance,
  port: ApprovalPort,
  options: ApproveThroughPortOptions,
): Promise<ActuateResult & { decision: string; by: string }> {
  const answer = await port.present({
    decisionRecordDigest: options.decisionRecordDigest,
    thread: options.thread,
    summary: options.summary,
    options: Object.keys(options.policy),
  });

  // Unauthorized: refused before anything is published — a forgery-shaped
  // event is not the record's business (ADR-0029's premise).
  if (!(instance.policy.controllers ?? []).includes(answer.by)) {
    throw new ApprovalRefused(`${answer.by} is not an authorized controller`, answer.by);
  }

  let action: string;
  try {
    action = admissibleAction(options.policy, answer.decision);
  } catch {
    throw new ApprovalRefused(`${answer.decision} is not a decision the pinned policy admits`, answer.by);
  }

  // The observation instant is the port's own answer time, taken from the
  // instance clock rather than `Date.now()` so a deterministic test clock
  // governs it too.
  const observedAt = instance.clock.now().toISOString();
  const actuator: ExternalActuator = {
    name: options.actuatorName,
    async act(_action: string, _j: Justification): Promise<ActuationReceipt> {
      return {
        externalRef: answer.by,
        contentHash: approvalContentHash(options.decisionRecordDigest, answer.decision, answer.by),
        observedAt,
      };
    },
  };

  const result = await instance.actuate(actuator, {
    action,
    correlationId: options.correlationId,
    thread: options.thread,
    actsOn: options.decisionRecordDigest,
  });

  return { ...result, decision: answer.decision, by: answer.by };
}
