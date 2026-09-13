/**
 * ADR-0029 Decision 2 ("Watch") — the 04 § Renderings convention as code.
 *
 * 04 says a rendering SHOULD be derived mechanically from a verified export
 * and SHOULD carry the bundle digest and the verifier's result alongside the
 * narrative, so a reader can check the story against the record it claims to
 * summarize. These are pure functions over activities the *caller* has
 * already filtered through the read gate (ADR-0013) — this module never
 * filters by visibility itself, because a rendering built here from
 * unfiltered activities would be a second, unaudited gate with its own bugs.
 *
 * The narrative line is built from an activity's *shape* — type, object
 * type, actor tail, correlation id, category/action/outcome, error code,
 * external ref — never from `content`/`summary`, except a bounded excerpt
 * (<=120 chars) and only for `public` activities. This mirrors
 * `visibility.ts`'s `shadowNote`: a rendering must not be a projection of
 * gated payloads (04 § Mastodon interop's confidentiality rule, generalized
 * to every reader, not just a stock fediverse follower).
 *
 * `afp:bundle` is populated from an on-disk `MANIFEST.json`/`VERDICT.json`
 * pair when one exists for the rendered thread — this instance runs no
 * in-process verifier (that is the Python tool), so the verdict is read back
 * from wherever an operator chose to store it, or is the literal string
 * "unverified" when nothing was stored. This function never fabricates a
 * verdict.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { JsonValue } from "../crypto/jcs.ts";
import { AFP_CONTEXTS } from "../ap/documents.ts";
import { digestOf } from "../crypto/proof.ts";
import { correlationIdOf } from "../ap/activities.ts";
import type { OutboxEntry } from "../store/outbox.ts";

const EXCERPT_LIMIT = 120;

export interface BundleInfo {
  "afp:manifestDigest": string;
  "afp:exportedAt": JsonValue;
  "afp:verdict": string;
}

export interface Rendering {
  "@context": JsonValue;
  type: "afp:Rendering";
  "afp:thread"?: string;
  "afp:actor"?: string;
  "afp:renderedAt": string;
  "afp:renders": string[];
  "afp:renderingDigest": string;
  "afp:chainHeads": { [actor: string]: string };
  "afp:bundle"?: BundleInfo | null;
  narrative: string[];
}

/** The name tail of an actor id — everything after the last '/'. Same rule
 * `visibility.ts`'s `shadowNote` uses, kept local rather than shared to avoid
 * this module depending on `federation/visibility.ts` for one line. */
function actorTail(actorId: string): string {
  const parts = actorId.split("/");
  return parts[parts.length - 1] || actorId;
}

function objectOf(activity: { [key: string]: JsonValue }): { [key: string]: JsonValue } | null {
  const object = activity.object;
  return object && typeof object === "object" && !Array.isArray(object) ? (object as { [key: string]: JsonValue }) : null;
}

function stringField(source: { [key: string]: JsonValue } | null, key: string): string | null {
  return source && typeof source[key] === "string" ? String(source[key]) : null;
}

/** One human-readable line for one activity — shape only, plus a bounded,
 * `public`-only excerpt. Never reads `content`/`summary` for any other class. */
function narrativeLine(activity: { [key: string]: JsonValue }): string {
  const object = objectOf(activity);
  const published = stringField(activity, "published") ?? "";
  const actor = stringField(activity, "actor") ?? "";
  const type = stringField(activity, "type") ?? "";
  const objectType = stringField(object, "type");
  const shape = objectType ? `${type}/${objectType}` : type;

  const clauses: string[] = [];
  const correlationId = correlationIdOf(activity);
  if (correlationId) clauses.push(`correlation ${correlationId}`);
  const category = stringField(object, "afp:category");
  if (category) clauses.push(`category ${category}`);
  const action = stringField(activity, "afp:action") ?? stringField(object, "afp:action");
  if (action) clauses.push(`action ${action}`);
  const outcome = stringField(object, "afp:outcome");
  if (outcome) clauses.push(`outcome ${outcome}`);
  const errorCode = stringField(object, "afp:errorCode");
  if (errorCode) clauses.push(`error ${errorCode}`);
  const externalRef = stringField(object, "afp:externalRef");
  if (externalRef) clauses.push(`ref ${externalRef}`);

  const visibility = stringField(activity, "afp:visibility");
  if (visibility === "public") {
    const text = stringField(object, "content") ?? stringField(activity, "content") ?? stringField(object, "summary");
    if (text) {
      const excerpt = text.length > EXCERPT_LIMIT ? `${text.slice(0, EXCERPT_LIMIT)}…` : text;
      clauses.push(`"${excerpt}"`);
    }
  }

  const clause = clauses.length > 0 ? clauses.join(", ") : "(no further detail)";
  return `${published} ${actorTail(actor)} ${shape} — ${clause}`;
}

/** `sha256` hex over `JSON.stringify(sortedDigests)` — the JSON array of the
 * rendered digests in lexical order, no whitespace — what a reader checks
 * the narrative against, per 04's convention. Sorted so the digest is a
 * property of the *set* rendered, independent of the chain-order the caller
 * passed in; stated byte-exactly so a second implementation can recompute it. */
function renderingDigestOf(digests: readonly string[]): string {
  const sorted = [...digests].sort();
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

function chainHeadsOf(entries: readonly OutboxEntry[]): { [actor: string]: string } {
  const heads: { [actor: string]: string } = {};
  for (const entry of entries) {
    // Entries arrive in the caller's chosen order (thread order for
    // `renderThread`, seq order for `renderTimeline`); the last one seen per
    // actor is that actor's head among the *admitted* entries, which is what
    // a reader can actually verify against — not necessarily the actor's
    // true chain head if some of its activities were gated out.
    heads[entry.actor] = entry.digest;
  }
  return heads;
}

/**
 * `<exportDir>/MANIFEST.json` and `<exportDir>/VERDICT.json`, read back for
 * one thread. Tolerant of a missing export directory or a manifest that does
 * not list the thread — both simply yield `null`, never a thrown error, so a
 * rendering route can call this on every request without a stat-then-open
 * race against an operator running `exportBundle` concurrently.
 */
export function bundleInfoFor(exportDir: string, thread: string): BundleInfo | null {
  const manifestPath = join(exportDir, "MANIFEST.json");
  if (!existsSync(manifestPath)) return null;

  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch {
    return null;
  }

  let manifest: { [key: string]: JsonValue };
  try {
    manifest = JSON.parse(raw);
  } catch {
    return null;
  }

  const scope = manifest["afp:exportScope"];
  const threads =
    scope && typeof scope === "object" && !Array.isArray(scope) ? (scope as { [key: string]: JsonValue })["afp:threads"] : undefined;
  // An unscoped export (no `afp:exportScope.afp:threads`) answers for every
  // thread; a scoped one answers only for the threads it names.
  if (Array.isArray(threads) && !threads.includes(thread)) return null;

  const manifestDigest = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  const exportedAt = manifest.exportedAt ?? null;

  let verdict = "unverified";
  const verdictPath = join(exportDir, "VERDICT.json");
  if (existsSync(verdictPath)) {
    try {
      const stored = JSON.parse(readFileSync(verdictPath, "utf8")) as { verdict?: unknown };
      if (typeof stored.verdict === "string" && stored.verdict.length > 0) verdict = stored.verdict;
    } catch {
      // an unparseable VERDICT.json is not a verdict — stay "unverified"
    }
  }

  return { "afp:manifestDigest": manifestDigest, "afp:exportedAt": exportedAt, "afp:verdict": verdict };
}

function buildRendering(entries: readonly OutboxEntry[], now: string): Omit<Rendering, "afp:bundle"> {
  const digests = entries.map((entry) => digestOf(entry.activity));
  return {
    "@context": AFP_CONTEXTS,
    type: "afp:Rendering",
    "afp:renderedAt": now,
    "afp:renders": digests,
    "afp:renderingDigest": renderingDigestOf(digests),
    "afp:chainHeads": chainHeadsOf(entries),
    narrative: entries.map((entry) => narrativeLine(entry.activity)),
  };
}

/** A thread's rendering, over the activities the caller already admitted
 * through the read gate — `afp:bundle` from the export directory, or `null`
 * when no export covers this thread. */
export function renderThread(
  entries: readonly OutboxEntry[],
  options: { thread: string; bundle: BundleInfo | null; now: string },
): Rendering {
  return {
    ...buildRendering(entries, options.now),
    "afp:thread": options.thread,
    "afp:bundle": options.bundle,
  };
}

/** One actor's timeline rendering, over its admitted activities. No
 * `afp:bundle` — exports are thread-scoped, an actor's timeline is not. */
export function renderTimeline(entries: readonly OutboxEntry[], options: { actor: string; now: string }): Rendering {
  return {
    ...buildRendering(entries, options.now),
    "afp:actor": options.actor,
  };
}

/** The plain-text form: a header line naming the rendering digest and the
 * bundle/verdict, then one narrative line per activity. */
export function narrativeText(rendering: Rendering): string {
  const subject = rendering["afp:thread"] ?? rendering["afp:actor"] ?? "";
  const bundle = rendering["afp:bundle"];
  const bundleNote = bundle === undefined ? "" : bundle === null ? ", no export" : `, bundle ${bundle["afp:manifestDigest"]} (${bundle["afp:verdict"]})`;
  const header = `Rendering of ${subject} — digest ${rendering["afp:renderingDigest"]}, rendered ${rendering["afp:renderedAt"]}${bundleNote}`;
  return [header, ...rendering.narrative].join("\n");
}
