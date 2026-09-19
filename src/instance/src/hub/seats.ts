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

type ActorDocument = { [key: string]: JsonValue };

export interface SeatDeps {
  db: Db;
  actorId: string;
  /**
   * ADR-0016 Decision 4/5: the hub actor this replica *is* — `replicaOf` when
   * set, else `actorId`. A `Follow` names the origin hub, and a replica that
   * matched only its own `actorId` would drop every seat carried to it
   * (ADR-0037 Decision 3, found by the G4 gate): the rest of the hub has
   * always compared against this identity, and the seat handlers now do too.
   */
  hubIdentity: string;
  fetchActor: (actorId: string) => ActorDocument | null;
  now: () => Date;
  emit: (to: readonly string[], thread: string, visibility: Visibility, build: (envelope: Envelope) => { [key: string]: JsonValue }) => OutboxEntry;
  members: () => string[];
  instanceOf: (agent: string) => string | null;
  removeAgent: (agent: string, byActor: string, activityId: string) => void;
  /**
   * ADR-0037 Decision 3: seats are CRDT state now, so these handlers move
   * them through `Hub`'s own OR-Set rather than through a table `hub_seats`
   * that no peer ever saw. The shape is the same shape `removeAgent` has —
   * the private replicated state stays behind `Hub`'s own methods.
   */
  hasSeat: (actor: string) => boolean;
  seatTags: (actor: string) => string[];
  seatFollow: (actor: string, followActivityId: string) => void;
  seatRevoke: (actor: string, undoActivityId: string) => void;
}

/**
 * `Follow{object: this hub}`: the actor must be an instance actor per its own
 * fetched document — same `Application`/`afp:Instance` check `inbox.ts` runs
 * — and the object must name this hub. Seats, replied with
 * `Accept{object: the Follow's id}`, `to` the follower.
 *
 * ADR-0037 Decision 3: a `relayed` Follow — one carried into this replica
 * inside an `Accept{afp:StateDeltas}` — seats its actor and stops there. The
 * replica that was actually asked answered already; a second `Accept` from
 * every peer that re-derives the seat would be the same activity said N
 * times, and `onEnroll` has always re-derived relayed state without
 * re-emitting for exactly that reason.
 */
export function onFollow(deps: SeatDeps, activity: { [key: string]: JsonValue }, relayed = false): void {
  const actor = String(activity.actor ?? "");
  const object = String(activity.object ?? "");
  if (object !== deps.actorId && object !== deps.hubIdentity) return;
  const doc = deps.fetchActor(actor);
  const docType = doc?.type;
  const isInstanceActor =
    docType === "Application" || (Array.isArray(docType) && (docType as JsonValue[]).includes("afp:Instance"));
  if (!isInstanceActor) return;

  deps.seatFollow(actor, String(activity.id));
  if (relayed) return;
  deps.emit([actor], String(activity.context ?? `${new URL(deps.actorId).origin}/threads/seats`), "public", (envelope) =>
    acceptFollow(envelope, String(activity.id), actor, deps.actorId),
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
  const target = String(activity.target ?? "");
  if (target !== deps.actorId && target !== deps.hubIdentity) return;
  if (!deps.hasSeat(actor)) return;
  const followId = String(activity.object ?? "");
  // Add-wins means an actor can hold more than one live tag (a re-Follow
  // whose Undo has not converged yet). A named `object` must be one of them.
  if (followId && !deps.seatTags(actor).includes(followId)) return;

  deps.seatRevoke(actor, String(activity.id));
  for (const agent of deps.members()) {
    if (deps.instanceOf(agent) === actor) deps.removeAgent(agent, actor, String(activity.id));
  }
}
