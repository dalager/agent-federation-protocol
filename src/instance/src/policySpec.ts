/**
 * ADR-0033 Decision 1: the `PolicySpec` shape and its validation, kept apart
 * from `ap/policy.ts` (which builds the signed wire document from it) for one
 * reason only: `config.ts` needs these types and `validatePolicySpec` to
 * assemble and validate `Config.policy`, and `config.ts` sits underneath
 * `crypto/keys.ts` (`keyPassphraseFromEnv`) which `crypto/proof.ts` depends
 * on — so a leaf file with no import of `ap/documents.ts` or
 * `crypto/proof.ts` is what keeps `config.ts` from closing that cycle.
 */

export type SeatPolicy = "follow-required" | "enroll-implies-seat";
export type ThreadLayoutForm = "per-subject" | "per-case" | "per-engagement" | "other";
export type CustodyMode = "file" | "remote" | "agent" | "remote-issued";
export type SubjectPrecondition = "any-member" | "proof-or-dispute-on-record";
export type ElectorateFloor = "refuse" | "no-decision:electorate-exhausted";

export interface RetentionDutySpec {
  horizon: string;
  basis: string;
}

export interface AnchorSpec {
  actor: string;
  head: string;
  instant: string;
  anchorRef: string;
}

export interface ThreadLayoutSpec {
  form: ThreadLayoutForm;
  note: string;
}

export interface CustodySpec {
  instance?: CustodyMode;
  agents?: CustodyMode;
  hub?: CustodyMode;
  /**
   * ADR-0035 Consequences: "remote-issued invites the misreading that the key
   * is never in host memory" — a one-year 'short-lived' key is the mode's
   * failure case, so the lifetime it publishes has to be a number an operator
   * committed to, not left implicit. Milliseconds, required whenever any
   * custody mode above is "remote-issued".
   */
  keyLifetimeMs?: number;
}

export interface BrainSpec {
  model: string;
  endpoint?: string;
}

export interface GovernanceSpec {
  subjectPrecondition: SubjectPrecondition;
  electorateFloor: ElectorateFloor;
}

export interface TermsSpec {
  url: string;
  digest: string;
}

export interface DeviationSpec {
  section: string;
  statement: string;
}

export interface DisclosureSpec {
  contact: string;
}

/** ADR-0033 Decision 1's table, mirrored one property at a time — every property optional. */
export interface PolicySpec {
  seatPolicy?: SeatPolicy;
  controllers?: readonly string[];
  defaultVisibility?: string;
  retentionDuty?: RetentionDutySpec;
  anchors?: readonly AnchorSpec[];
  threadLayout?: ThreadLayoutSpec;
  custody?: CustodySpec;
  brains?: readonly BrainSpec[];
  governance?: GovernanceSpec;
  terms?: TermsSpec;
  deviations?: readonly DeviationSpec[];
  disclosure?: DisclosureSpec;
}

const VISIBILITY_CLASSES = new Set(["public", "hub", "parties", "internal"]);
const SEAT_POLICIES = new Set<SeatPolicy>(["follow-required", "enroll-implies-seat"]);
const THREAD_FORMS = new Set<ThreadLayoutForm>(["per-subject", "per-case", "per-engagement", "other"]);
const CUSTODY_MODES = new Set<CustodyMode>(["file", "remote", "agent", "remote-issued"]);
const SUBJECT_PRECONDITIONS = new Set<SubjectPrecondition>(["any-member", "proof-or-dispute-on-record"]);
const ELECTORATE_FLOORS = new Set<ElectorateFloor>(["refuse", "no-decision:electorate-exhausted"]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isAbsoluteUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    // eslint-disable-next-line no-new
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function isSha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

/**
 * Every problem with a `PolicySpec`, named — closed enums, non-empty
 * strings, `sha256:` digests, absolute URLs. Never throws; `loadConfig`'s
 * `validate()` reports these alongside every other configuration problem
 * (ADR-0032 Decision 3's discipline, carried here).
 */
export function validatePolicySpec(spec: PolicySpec): string[] {
  const problems: string[] = [];
  const push = (field: string, message: string): void => {
    problems.push(`${field} ${message}`);
  };

  if (spec.seatPolicy !== undefined && !SEAT_POLICIES.has(spec.seatPolicy)) {
    push("seatPolicy", `must be "follow-required" or "enroll-implies-seat", got ${JSON.stringify(spec.seatPolicy)}`);
  }

  if (spec.controllers !== undefined) {
    for (const controller of spec.controllers) {
      if (!/^https?:/.test(controller)) push("controllers", `"${controller}" is not an http(s) URL`);
    }
  }

  if (spec.defaultVisibility !== undefined && !VISIBILITY_CLASSES.has(spec.defaultVisibility)) {
    push("defaultVisibility", `must be one of public/hub/parties/internal, got ${JSON.stringify(spec.defaultVisibility)}`);
  }

  if (spec.retentionDuty !== undefined) {
    if (!isNonEmptyString(spec.retentionDuty.horizon)) push("retentionDuty.horizon", "must be a non-empty string");
    if (!isNonEmptyString(spec.retentionDuty.basis)) push("retentionDuty.basis", "must be a non-empty string");
  }

  for (const [index, anchor] of (spec.anchors ?? []).entries()) {
    if (!isNonEmptyString(anchor.actor)) push(`anchors[${index}].actor`, "must be a non-empty string");
    if (!isNonEmptyString(anchor.head)) push(`anchors[${index}].head`, "must be a non-empty string");
    if (!isNonEmptyString(anchor.instant)) push(`anchors[${index}].instant`, "must be a non-empty string");
    if (!isNonEmptyString(anchor.anchorRef)) push(`anchors[${index}].anchorRef`, "must be a non-empty string");
  }

  if (spec.threadLayout !== undefined) {
    if (!THREAD_FORMS.has(spec.threadLayout.form)) {
      push("threadLayout.form", `must be one of per-subject/per-case/per-engagement/other, got ${JSON.stringify(spec.threadLayout.form)}`);
    }
    if (!isNonEmptyString(spec.threadLayout.note)) push("threadLayout.note", "must be a non-empty string");
  }

  if (spec.custody !== undefined) {
    for (const key of ["instance", "agents", "hub"] as const) {
      const mode = spec.custody[key];
      if (mode !== undefined && !CUSTODY_MODES.has(mode)) {
        push(`custody.${key}`, `must be one of file/remote/agent/remote-issued, got ${JSON.stringify(mode)}`);
      }
    }
    const anyRemoteIssued = spec.custody.instance === "remote-issued" ||
      spec.custody.agents === "remote-issued" ||
      spec.custody.hub === "remote-issued";
    if (anyRemoteIssued && !(Number.isFinite(spec.custody.keyLifetimeMs) && (spec.custody.keyLifetimeMs as number) > 0)) {
      push("custody.keyLifetimeMs", "must be a positive number of milliseconds when any custody mode is remote-issued (ADR-0035 Consequences)");
    }
  }

  for (const [index, brain] of (spec.brains ?? []).entries()) {
    if (!isNonEmptyString(brain.model)) push(`brains[${index}].model`, "must be a non-empty string");
    if (brain.endpoint !== undefined && !isAbsoluteUrl(brain.endpoint)) {
      push(`brains[${index}].endpoint`, `"${brain.endpoint}" is not an absolute URL`);
    }
  }

  if (spec.governance !== undefined) {
    if (!SUBJECT_PRECONDITIONS.has(spec.governance.subjectPrecondition)) {
      push(
        "governance.subjectPrecondition",
        `must be "any-member" or "proof-or-dispute-on-record", got ${JSON.stringify(spec.governance.subjectPrecondition)}`,
      );
    }
    if (!ELECTORATE_FLOORS.has(spec.governance.electorateFloor)) {
      push(
        "governance.electorateFloor",
        `must be "refuse" or "no-decision:electorate-exhausted", got ${JSON.stringify(spec.governance.electorateFloor)}`,
      );
    }
  }

  if (spec.terms !== undefined) {
    if (!isAbsoluteUrl(spec.terms.url)) push("terms.url", `"${spec.terms.url}" is not an absolute URL`);
    if (!isSha256Digest(spec.terms.digest)) push("terms.digest", `"${spec.terms.digest}" is not a sha256: digest`);
  }

  for (const [index, deviation] of (spec.deviations ?? []).entries()) {
    if (!isNonEmptyString(deviation.section)) push(`deviations[${index}].section`, "must be a non-empty string");
    if (!isNonEmptyString(deviation.statement)) push(`deviations[${index}].statement`, "must be a non-empty string");
  }

  if (spec.disclosure !== undefined && !isNonEmptyString(spec.disclosure.contact)) {
    push("disclosure.contact", "must be a non-empty string");
  }

  return problems;
}
