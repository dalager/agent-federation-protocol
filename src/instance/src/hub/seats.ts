/**
 * ADR-0017 Decision 4 (R3): the hub's half of Follow/Accept/Undo — extracted
 * from `hub.ts` to keep that file from growing past its line ceiling. Pure
 * handlers over the minimal slice of `Hub` they need; `removeAgent` (the
 * shared mass-unenroll body) stays on `Hub` itself, since it touches private
 * CRDT state these handlers have no business reaching directly.
 */

import type { JsonValue } from "../crypto/jcs.ts";
import type { Db } from "../store/db.ts";
import type { OutboxEntry } from "../store/outbox.ts";
import { acceptFollow, type Envelope, type Visibility } from "./activities.ts";
import { hasSeat, revokeSeat, saveSeat, seatFollowActivity } from "./store.ts";

type ActorDocument = { [key: string]: JsonValue };

export interface SeatDeps {
  db: Db;
  actorId: string;
  fetchActor: (actorId: string) => ActorDocument | null;
  now: () => Date;
  emit: (to: readonly string[], thread: string, visibility: Visibility, build: (envelope: Envelope) => { [key: string]: JsonValue }) => OutboxEntry;
  members: () => string[];
  instanceOf: (agent: string) => string | null;
  removeAgent: (agent: string, byActor: string, activityId: string) => void;
}

/**
 * `Follow{object: this hub}`: the actor must be an instance actor per its own
 * fetched document — same `Application`/`afp:Instance` check `inbox.ts` runs
 * — and the object must name this hub. Seats, replied with
 * `Accept{object: the Follow's id}`, `to` the follower.
 */
export function onFollow(deps: SeatDeps, activity: { [key: string]: JsonValue }): void {
  const actor = String(activity.actor ?? "");
  const object = String(activity.object ?? "");
  if (object !== deps.actorId) return;
  const doc = deps.fetchActor(actor);
  const docType = doc?.type;
  const isInstanceActor =
    docType === "Application" || (Array.isArray(docType) && (docType as JsonValue[]).includes("afp:Instance"));
  if (!isInstanceActor) return;

  saveSeat(deps.db, actor, String(activity.id), deps.now().toISOString());
  deps.emit([actor], String(activity.context ?? "urn:afp:thread:seats"), "public", (envelope) =>
    acceptFollow(envelope, String(activity.id), actor),
  );
}

/**
 * `Undo{Follow}`: the actor must own the seat it is revoking — `target`
 * names this hub, and a named `object` (the Follow id) must match that
 * actor's own live seat. Revoking mass-unenrolls every agent this instance
 * enrolled (`instanceOf(agent) === actor`).
 */
export function onUndoFollow(deps: SeatDeps, activity: { [key: string]: JsonValue }): void {
  const actor = String(activity.actor ?? "");
  if (String(activity.target ?? "") !== deps.actorId) return;
  if (!hasSeat(deps.db, actor)) return;
  const followId = String(activity.object ?? "");
  if (followId && followId !== seatFollowActivity(deps.db, actor)) return;

  revokeSeat(deps.db, actor, deps.now().toISOString());
  for (const agent of deps.members()) {
    if (deps.instanceOf(agent) === actor) deps.removeAgent(agent, actor, String(activity.id));
  }
}
