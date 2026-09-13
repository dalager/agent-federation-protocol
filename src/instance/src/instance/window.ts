/**
 * ADR-0029 Decision 3: the fediverse window's dual-publish.
 *
 * Extracted from `instance.ts` to hold it under its line ceiling —
 * `AfpInstance.emit` calls `maybeShadow` once, after appending and enqueuing
 * the activity it just signed. With `AFP_FEDIVERSE_WINDOW` unset,
 * `maybeShadow` returns immediately: no extra activity, no changed sequence
 * number, byte-identical to every run before this ADR (gate G4).
 *
 * When the flag is on, an event 04 lists as operator-visible gets a
 * `public` `Create{Note}` shadow — built by `federation/visibility.ts`
 * `shadowNote` plus the envelope fields `emit` supplies — published through
 * the instance's own `publish`/`publishAsInstance` (so it is signed, chained,
 * and its `afp:prevActivity` is the chain head left by the activity it
 * shadows) with `to: []`: nothing is delivered, followers read the public
 * outbox (Decision 3's "followable by AFP-aware software and by anything
 * that can read a public outbox").
 */

import { shadowNote } from "../federation/visibility.ts";
import type { Envelope, Visibility } from "../ap/activities.ts";
import { instanceActorId } from "../ap/documents.ts";
import type { JsonValue } from "../crypto/jcs.ts";
import type { AfpInstance } from "../instance.ts";

/** 04's operator-visible set, split by which field of the activity carries the type — `afp:Award` carries it on both. */
const OPERATOR_VISIBLE_OBJECT_TYPES = new Set([
  "afp:Task",
  "afp:Award",
  "afp:Result",
  "afp:Synthesis",
  "afp:DecisionRecord",
  "afp:Vouch",
  "afp:Disown",
  "afp:Error",
  "afp:Act",
]);
const OPERATOR_VISIBLE_ACTIVITY_TYPES = new Set(["afp:Award", "afp:Vouch", "afp:Disown"]);

function objectTypeOf(activity: { [key: string]: JsonValue }): string | null {
  const object = activity.object;
  if (!object || typeof object !== "object" || Array.isArray(object)) return null;
  const type = (object as { [key: string]: JsonValue }).type;
  return typeof type === "string" ? type : null;
}

/**
 * The label `shadowNote` uses in its default content line, or `null` when
 * `activity` is not one of the operator-visible events — the guard that
 * also, by construction, keeps a shadow from shadowing a shadow: a
 * `Create{Note}` shadow's own object type is `"Note"`, which is not, and
 * never will be, in either set below.
 */
function operatorVisibleType(activity: { [key: string]: JsonValue }): string | null {
  const objectType = objectTypeOf(activity);
  if (objectType && OPERATOR_VISIBLE_OBJECT_TYPES.has(objectType)) return objectType;
  const activityType = typeof activity.type === "string" ? activity.type : null;
  if (activityType && OPERATOR_VISIBLE_ACTIVITY_TYPES.has(activityType)) return activityType;
  return null;
}

/** A shadow is a summary, not a projection (04 § Dual-publish) — the same bound `render/rendering.ts` puts on a `public` excerpt. */
const SUMMARY_LIMIT = 120;

/** A public string field an already-`public` activity may safely re-surface as the shadow's `publicSummary`, bounded — never gated content (ADR-0008b's rule: `hub`/`parties`/`internal` get type + actor tail + thread, nothing else). */
function publicSummaryOf(activity: { [key: string]: JsonValue }): string | undefined {
  const candidates: JsonValue[] = [activity.content, activity.summary];
  const object = activity.object;
  if (object && typeof object === "object" && !Array.isArray(object)) {
    const inner = object as { [key: string]: JsonValue };
    candidates.push(inner.content, inner.summary);
  }
  const text = candidates.find((value): value is string => typeof value === "string");
  if (text === undefined) return undefined;
  return text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT)}…` : text;
}

export function maybeShadow(
  instance: AfpInstance,
  activity: { [key: string]: JsonValue },
  options: { actor: string; thread: string; visibility: Visibility },
): void {
  if (!instance.config.fediverseWindow) return;

  const type = operatorVisibleType(activity);
  if (type === null) return;

  const machineId = String(activity.id ?? "");
  const publicSummary = options.visibility === "public" ? publicSummaryOf(activity) : undefined;

  const build = (envelope: Envelope): { [key: string]: JsonValue } => {
    const note = shadowNote(activity, { type, actor: envelope.actor, thread: envelope.thread }, { publicSummary });
    const object = note.object as { [key: string]: JsonValue };
    return {
      ...note,
      id: envelope.activityId,
      to: [...envelope.to],
      published: envelope.published,
      context: envelope.thread,
      "afp:visibility": envelope.visibility,
      ...(envelope.prevActivity !== null ? { "afp:prevActivity": envelope.prevActivity } : {}),
      // 04's "a Link attachment pointing at the machine-readable activity".
      object: { ...object, attachment: { type: "Link", href: machineId } },
    };
  };

  const name = instance.nameOf(options.actor);
  if (name) {
    instance.publish(name, [], options.thread, "public", build);
    return;
  }
  if (options.actor === instanceActorId(instance.config.origin)) {
    instance.publishAsInstance([], options.thread, "public", build);
  }
  // Neither a registered agent nor the instance actor: nothing this instance
  // can sign as, so no shadow (should not arise — `emit`'s own callers are
  // always one of the two).
}
