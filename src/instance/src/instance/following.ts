/**
 * ADR-0017 Decision 4 (R3): the instance actor's Follow/Undo trail toward
 * hubs it seeks a seat at. Extracted from `instance.ts` to stay under its
 * line ceiling — these are thin wrappers around `AfpInstance.publishAsInstance`
 * and its own outbox, not a second publishing path.
 */

import type { JsonValue } from "../crypto/jcs.ts";
import { follow, undoFollow } from "../ap/activities.ts";
import type { OutboxEntry } from "../store/outbox.ts";
import type { AfpInstance } from "../instance.ts";

const THREAD = "urn:afp:thread:seats";

/** `Follow{actor: instance, object: hubActorId}` — the door-knock for a seat. */
export function followHub(instance: AfpInstance, hubActorId: string): OutboxEntry {
  return instance.publishAsInstance([hubActorId], THREAD, "public", (envelope) => follow(envelope, hubActorId));
}

/**
 * `Undo{Follow}` of this instance's latest live Follow of `hubActorId`.
 * Throws if this instance never Followed that hub — there is nothing to undo.
 */
export function unfollowHub(instance: AfpInstance, hubActorId: string): OutboxEntry {
  const selfId = instance.instanceDocument().id as string;
  const priorFollow = latestFollow(instance, selfId, hubActorId);
  if (!priorFollow) throw new Error(`no prior Follow of ${hubActorId} to undo`);
  return instance.publishAsInstance([hubActorId], THREAD, "public", (envelope) =>
    undoFollow(envelope, priorFollow, hubActorId),
  );
}

/**
 * The hubs this instance currently follows — a replay of its own Follow/Undo
 * trail, latest activity per hub deciding whether the seat is still sought.
 */
export function followingIds(instance: AfpInstance): string[] {
  const selfId = instance.instanceDocument().id as string;
  const live = new Set<string>();
  for (const entry of instance.outbox.byActor(selfId)) {
    const activity = entry.activity as { [key: string]: JsonValue };
    const type = String(activity.type ?? "");
    if (type === "Follow") {
      const target = String(activity.object ?? "");
      if (target) live.add(target);
    } else if (type === "Undo") {
      const target = String(activity.target ?? "");
      if (target) live.delete(target);
    }
  }
  return [...live];
}

/** The most recent live Follow's activity id toward `hubActorId`, or null. */
function latestFollow(instance: AfpInstance, selfId: string, hubActorId: string): string | null {
  let current: string | null = null;
  for (const entry of instance.outbox.byActor(selfId)) {
    const activity = entry.activity as { [key: string]: JsonValue };
    const type = String(activity.type ?? "");
    if (type === "Follow" && String(activity.object ?? "") === hubActorId) {
      current = String(activity.id);
    } else if (type === "Undo" && String(activity.target ?? "") === hubActorId) {
      current = null;
    }
  }
  return current;
}
