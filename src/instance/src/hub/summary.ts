/**
 * ADR-0022 Decisions 1 and 3 — the contribution summary, and the frame that
 * makes it recomputable.
 *
 * Kept apart from `hub.ts` for the reason `electorate.ts` and `equivocation.ts`
 * are: these are pure functions over signed activities, they are the parity
 * twins of `src/verifier/summary.py`, and an auditor comparing the two
 * implementations should find each half self-contained in one file.
 *
 * **A summary is not a hub artifact.** 04 is deliberate that `afp:computedBy`
 * is "a field, not a privileged role" — anyone holding the record may compute
 * one, which is the entire reason the object is worth having. So nothing here
 * touches the hub's database or its keys: `computeContribution` takes a pool of
 * activities and returns numbers, and any member can call it over whatever it
 * can read.
 *
 * What campaign 10 found, and what this file answers: **a sum is only as
 * recomputable as its input set is agreed.** Two honest members recomputing the
 * same quarter got different numbers and neither had done anything wrong — one
 * of them simply could not read a fifth of the work (07's visibility classes,
 * ADR-0013's read gate, both behaving correctly). So the summary declares its
 * frame — which events, over which window, seen under which classes — and
 * counts what it could not read rather than quietly summing without it.
 */

import type { JsonValue } from "../crypto/jcs.ts";
import { digestOf } from "../crypto/proof.ts";
import type { Envelope, Visibility } from "../ap/activities.ts";
import { AFP_CONTEXTS } from "../ap/documents.ts";
import { lcmOf } from "./weights.ts";

type Activity = { [key: string]: JsonValue };

/**
 * ADR-0022 Decision 1: the four things a second party needs in order to sum the
 * same set. A closed registry per field — an unrecognised form fails rather
 * than falling through to a default (W0.4), because a frame nobody can resolve
 * is exactly the unfalsifiable claim this decision exists to remove.
 */
export interface SummaryFrame {
  /**
   * `hub-observed`: the period is the half-open interval of the hub's own
   * chain between two of its activity digests — `(from, to]`.
   *
   * Wall-clock `afp:period` stays on the summary as narration and is never
   * what the arithmetic selects on. `published` is self-asserted (campaign 7's
   * finding 45), so a task that straddles a quarter boundary would otherwise
   * belong to whichever quarter its own author said it did. The hub's chain is
   * the one order every member observes identically and no member can move.
   */
  periodRule: { form: "hub-observed"; hub: string; from: string; to: string };
  /** The visibility classes the computer summed over — what it was entitled to read. */
  inputScope: { visibility: readonly Visibility[] };
  /** `declared-shares`: credit follows `afp:contributionSplit` (Decision 2). */
  splitRule: { form: "declared-shares" };
  /** The vocabulary version this was computed under (finding 74). */
  vocabulary: string;
}

export interface ContributionTotals {
  /** The common denominator every credit is expressed over — integers only. */
  denominator: number;
  /** operator → credited numerator. Divide by `denominator` for tasks-equivalent. */
  credited: Record<string, number>;
  /**
   * operator → count of settled tasks whose Result this computer could not
   * read. Known to have happened (the hub sequenced the settlement and the
   * award names the performer) and impossible to credit in detail.
   */
  unreadable: Record<string, number>;
  /** The digests summed, sorted — Decision 3's preimage. */
  inputs: string[];
}

function objectOf(activity: Activity): Record<string, JsonValue> | null {
  const object = activity.object;
  if (typeof object !== "object" || object === null || Array.isArray(object)) return null;
  return object as Record<string, JsonValue>;
}

function payloadOf(activity: Activity, type: string): Record<string, JsonValue> | null {
  const object = objectOf(activity);
  return object && object.type === type ? object : null;
}

/**
 * The hub's own activities in `(from, to]`, in chain order.
 *
 * Walked backwards from `to` along `afp:prevActivity` rather than sorted by
 * `published`: the chain is the hub's own assertion of order and it is the
 * thing this rule exists to rely on. A `from` that never appears means the
 * interval is unresolvable, which the caller must treat as such — never as an
 * empty period, which would silently sum nothing and pass.
 */
export function hubChainSlice(pool: readonly Activity[], hub: string, from: string, to: string): Activity[] | null {
  const byDigest = new Map<string, Activity>();
  for (const activity of pool) {
    if (activity.actor === hub) byDigest.set(digestOf(activity), activity);
  }
  const slice: Activity[] = [];
  let cursor = byDigest.get(to);
  if (!cursor) return null;
  while (cursor) {
    const digest = digestOf(cursor);
    if (digest === from) return slice.reverse();
    slice.push(cursor);
    const prev = cursor["afp:prevActivity"];
    cursor = typeof prev === "string" ? byDigest.get(prev) : undefined;
  }
  // Ran off the head of the chain without meeting `from`: the interval does not
  // resolve in this pool.
  return from === "" ? slice.reverse() : null;
}

/**
 * ADR-0022 Decision 2's arithmetic, applied: `agent → share` over a common
 * denominator. A single-author Result is the whole of itself.
 */
export function creditOf(result: Record<string, JsonValue>): { agent: string; share: number; denominator: number }[] {
  const attributed = result.attributedTo;
  const split = result["afp:contributionSplit"];
  if (Array.isArray(attributed) && attributed.length > 1 && split && typeof split === "object" && !Array.isArray(split)) {
    const shares = split as Record<string, number>;
    const denominator = Object.values(shares).reduce((sum, share) => sum + share, 0);
    return Object.entries(shares).map(([agent, share]) => ({ agent, share, denominator }));
  }
  const sole = typeof attributed === "string" ? attributed : Array.isArray(attributed) ? String(attributed[0]) : "";
  return sole ? [{ agent: sole, share: 1, denominator: 1 }] : [];
}

/**
 * ADR-0022 Decisions 1 and 3 — recompute a period's contribution from the pool.
 *
 * The join is protocol-level, not conventional: the hub's chain slice gives the
 * settlements it sequenced in the period; each settlement names its task; the
 * task's own `Announce` gives the thread; the Results on that thread are the
 * work. Nothing here reads a naming convention, so a deployment that numbers
 * its correlation ids differently recomputes identically.
 *
 * `resolveOperator` maps an agent to the instance that operates it — the same
 * Enroll-trail fold ADR-0005 buckets weights by. An agent it cannot resolve is
 * credited under its own URL rather than dropped: an unknown operator is a
 * visible oddity, and a dropped credit is an invisible one.
 */
export function computeContribution(
  poolIn: readonly Activity[],
  frame: SummaryFrame,
  resolveOperator: (agent: string) => string,
): ContributionTotals | null {
  // Deduplicated by digest before anything is counted, and this is not
  // defensive tidying: in a joint replay the merged pool legitimately holds the
  // same Result twice — the author's own copy, and the verbatim copy a
  // counterparty received across the boundary (ADR-0009). Summing the pool as
  // given credits that work twice, which is a wrong number arrived at from an
  // entirely correct record.
  const byDigest = new Map<string, Activity>();
  for (const activity of poolIn) byDigest.set(digestOf(activity), activity);
  const pool = [...byDigest.values()];

  const slice = hubChainSlice(pool, frame.periodRule.hub, frame.periodRule.from, frame.periodRule.to);
  if (slice === null) return null;

  const settlements = slice.filter((activity) => payloadOf(activity, "afp:Settlement") !== null);
  const announces = new Map<string, Activity>();
  for (const activity of pool) {
    const task = payloadOf(activity, "afp:Task");
    if (task && typeof task.id === "string") announces.set(task.id, activity);
  }

  const scope = new Set(frame.inputScope.visibility);
  const readable = (activity: Activity): boolean => scope.has(String(activity["afp:visibility"]) as Visibility);

  const rows: { agent: string; share: number; denominator: number }[] = [];
  const unreadable: Record<string, number> = {};
  const inputs = new Set<string>();

  for (const settlement of settlements) {
    inputs.add(digestOf(settlement));
    const object = payloadOf(settlement, "afp:Settlement")!;
    const taskId = String(object["afp:task"] ?? "");
    const announce = announces.get(taskId);
    const thread = announce ? String(announce.context ?? "") : "";
    const results = thread
      ? pool.filter((a) => a.context === thread && payloadOf(a, "afp:Result") !== null && readable(a))
      : [];

    if (results.length === 0) {
      // The hub sequenced a settlement, so the work happened; this computer
      // cannot see the Result that says who did it. Counted, never estimated
      // and never silently skipped (W0.2). Attributed through the settlement's
      // own entries, which the hub published and everyone can read.
      const settled = object["afp:settles"];
      const actors = Array.isArray(settled)
        ? settled.map((entry) => String((entry as Record<string, JsonValue>)?.actor ?? "")).filter(Boolean)
        : [];
      for (const operator of new Set((actors.length ? actors : ["unattributed"]).map(resolveOperator))) {
        unreadable[operator] = (unreadable[operator] ?? 0) + 1;
      }
      continue;
    }

    for (const result of results) {
      inputs.add(digestOf(result));
      rows.push(...creditOf(payloadOf(result, "afp:Result")!));
    }
  }

  // Integer arithmetic only (W0.1): scale every share to the least common
  // multiple of the denominators, exactly as a proposal scales seats.
  const denominator = rows.length ? lcmOf(rows.map((row) => row.denominator)) : 1;
  const credited: Record<string, number> = {};
  for (const row of rows) {
    const operator = resolveOperator(row.agent);
    credited[operator] = (credited[operator] ?? 0) + (row.share * denominator) / row.denominator;
  }

  return { denominator, credited, unreadable, inputs: [...inputs].sort() };
}

/** Decision 3's preimage, stated once and computed identically on both sides. */
export function inputHashOf(inputs: readonly string[]): string {
  return digestOf([...inputs].sort() as unknown as JsonValue);
}

export interface SummarySpec {
  summaryId: string;
  hub: string;
  computedBy: string;
  frame: SummaryFrame;
  totals: ContributionTotals;
  /** Human-readable narration only — never what the arithmetic selects on. */
  period?: { start: string; end: string };
  /** Decision 5: the ratified summary this one corrects, by activity digest. */
  supersedes?: string;
}

/**
 * `Create{afp:ContributionSummary}` — a **draft** until an ADR-0018 round
 * ratifies it (Decision 5). Publishing one is not a claim of authority, and 04
 * never gave anyone that authority in the first place: the object exists so
 * that nobody's arithmetic has to be trusted.
 */
export function contributionSummary(envelope: Envelope, spec: SummarySpec): { [key: string]: JsonValue } {
  const frame: { [key: string]: JsonValue } = {
    "afp:periodRule": {
      "afp:form": spec.frame.periodRule.form,
      "afp:hub": spec.frame.periodRule.hub,
      "afp:from": spec.frame.periodRule.from,
      "afp:to": spec.frame.periodRule.to,
    },
    "afp:inputScope": { "afp:visibility": [...spec.frame.inputScope.visibility] },
    "afp:splitRule": { "afp:form": spec.frame.splitRule.form },
    "afp:vocabulary": spec.frame.vocabulary,
  };

  const object: { [key: string]: JsonValue } = {
    id: spec.summaryId,
    type: "afp:ContributionSummary",
    "afp:hub": spec.hub,
    "afp:computedBy": spec.computedBy,
    "afp:frame": frame,
    "afp:denominator": spec.totals.denominator,
    "afp:entries": Object.keys(spec.totals.credited)
      .sort()
      .map((operator) => ({ "afp:operator": operator, "afp:credited": spec.totals.credited[operator] })),
    "afp:inputHash": inputHashOf(spec.totals.inputs),
  };
  if (spec.period) object["afp:period"] = { start: spec.period.start, end: spec.period.end };
  // Emitted only when there is something to declare (W0.5) — but an empty
  // census and an absent one are different claims, so a computer that read
  // everything says so with an empty list rather than by omission.
  object["afp:unreadable"] = Object.keys(spec.totals.unreadable)
    .sort()
    .map((operator) => ({ "afp:operator": operator, "afp:count": spec.totals.unreadable[operator] }));
  if (spec.supersedes) object["afp:supersedes"] = spec.supersedes;

  return {
    "@context": AFP_CONTEXTS,
    id: envelope.activityId,
    type: "Create",
    actor: envelope.actor,
    to: [...envelope.to],
    published: envelope.published,
    context: envelope.thread,
    "afp:visibility": envelope.visibility,
    ...(envelope.prevActivity !== null ? { "afp:prevActivity": envelope.prevActivity } : {}),
    object,
  };
}
