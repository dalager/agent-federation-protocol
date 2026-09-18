/**
 * Operator visibility (ADR-0008 Decision 6, row F8): shadow Notes,
 * the inbound command grammar, and `afp:AuditGrant` — the read side of the
 * federation boundary, aimed at a human rather than a peer instance.
 *
 * 04's Mastodon-interop section sets the constraint this module answers to:
 * a stock Mastodon server only understands `Create{Note}` and friends, so
 * every operator-visible event needs a lossy, human-readable shadow
 * alongside the typed `afp:*` activity that actually carries the payload.
 * That shadow must never leak what the payload was gated to hide — a
 * `parties`-visibility activity's Note says only its type and thread, never
 * its content — so `shadowNote` is deliberately a *summary*, not a
 * projection.
 *
 * Inbound, 04 is equally deliberate about the narrowness: command parsing
 * from arbitrary fediverse strangers is an injection surface, so the grammar
 * accepts exactly three forms and an unauthorized or unparseable mention
 * gets a fixed, polite, read-only reply — never an error, never a hint about
 * what *would* have parsed.
 *
 * `afp:AuditGrant` (07 § the auditor role) is the third piece: a signed,
 * expiring credential naming an auditor, a scope, and the visibility classes
 * it unlocks. `grantAdmits` is the fetch-time check a `GET` runs against it —
 * instant comparison only, per `../crypto/time.ts`'s warning that comparing
 * ISO strings directly silently inverts real orderings.
 */

import type { JsonValue } from "../crypto/jcs.ts";
import { digestOf } from "../crypto/proof.ts";
import { instantMillis } from "../crypto/time.ts";
import type { Envelope } from "../ap/activities.ts";
import { AFP_CONTEXTS } from "../ap/documents.ts";

// ------------------------------------------------------------ shadow Notes

export interface ShadowSource {
  /** The AFP activity type being shadowed, e.g. "afp:Bid", "Create". */
  type: string;
  /** The acting actor's id — only its name tail is surfaced ("…/agents/a1" -> "a1"). */
  actor: string;
  /** Thread id, carried through so a human can find the machine record. */
  thread: string;
}

export interface ShadowOptions {
  /** Set only for activities whose class permits saying more than type+thread
   * (public, non-sensitive events); omitted for hub/parties/internal. */
  publicSummary?: string;
}

/** The name tail of an actor id — everything after the last '/'. */
function actorTail(actorId: string): string {
  const parts = actorId.split("/");
  return parts[parts.length - 1] || actorId;
}

/**
 * `Create{Note}` shadowing one AFP activity for the human ("shadow") timeline.
 *
 * The content line is built from the activity's *shape* (type, actor,
 * thread), never from its object/payload: a `parties`-visibility activity
 * (a direct Offer/Result between two agents) must not have its payload
 * reconstructable from what a stock Mastodon follower sees. `publicSummary`
 * is the one deliberate escape hatch, for activities already `public` —
 * callers pass it only when the shadowed activity itself carries no
 * confidentiality expectation.
 */
export function shadowNote(activity: { [key: string]: JsonValue }, source: ShadowSource, opts: ShadowOptions = {}): { [key: string]: JsonValue } {
  const digest = digestOf(activity);
  const content = opts.publicSummary ?? `${source.type} — ${actorTail(source.actor)} (${source.thread})`;
  return {
    "@context": AFP_CONTEXTS,
    type: "Create",
    actor: source.actor,
    object: {
      type: "Note",
      content,
      published: String(activity.published ?? ""),
      attributedTo: source.actor,
    },
    "afp:shadowOf": digest,
  };
}

// -------------------------------------------------------- inbound commands

export type Command =
  | { command: "pause"; target: string }
  | { command: "status"; target: string }
  | { command: "approve"; target: string }
  /** ADR-0038 Decision 2: the controller's brief on one line, `@<name> task <text>`. */
  | { command: "task"; target: string; content: string };

const MENTION_COMMAND = /^@(\S+)\s+(pause|status)$/;
const TASK_COMMAND = /^@(\S+)\s+task\s+(\S.*)$/;

/**
 * The narrow grammar 04 authorizes: exactly `@<name> pause`, `@<name>
 * status`, a bare `approve` reply, or — ADR-0038 Decision 2's fourth form —
 * `@<name> task <brief>`. `mentionedActor` supplies the target for
 * `approve`, which names no one itself (it replies on a governance thread,
 * so its target is context, not text). Anything else — extra tokens,
 * punctuation payloads, multiline strings, prompt-injection attempts —
 * returns null; this function never tries to be clever about partial
 * matches, because a stranger's free text is the threat model.
 *
 * `task` is the one form that carries free text past the parse: the brief
 * is returned verbatim (one line, the no-newline rule above stands) and
 * what may be done with it is `ports/command.ts`'s decision, gated on the
 * requester resolving to an actor this instance holds.
 */
export function parseCommand(noteContent: string, mentionedActor: string): Command | null {
  if (typeof noteContent !== "string") return null;
  if (noteContent.includes("\n")) return null;
  const trimmed = noteContent.trim();
  if (trimmed.length === 0) return null;

  if (trimmed === "approve") return { command: "approve", target: mentionedActor };

  const task = TASK_COMMAND.exec(trimmed);
  if (task !== null) return { command: "task", target: task[1], content: task[2].trim() };

  const match = MENTION_COMMAND.exec(trimmed);
  if (match === null) return null;
  const [, name, verb] = match;
  return { command: verb as "pause" | "status", target: name };
}

/** Exact match against the instance's `afp:policy` controller list — no prefix
 * matching, no `alsoKnownAs` inference here (that binding happens before
 * this call, at Note-origin verification). */
export function isAuthorizedController(actorUrl: string, policy: { controllers: string[] }): boolean {
  return policy.controllers.includes(actorUrl);
}

/** 04's fixed rule: an unauthorized or unparseable mention gets at most a
 * polite read-only reply, never an error and never a hint about the
 * grammar — that hint is itself part of the injection surface. */
export function politeReply(_noteContent: string): string {
  return "This account is read-only for mentions from unauthorized accounts. No action was taken.";
}

// --------------------------------------------------------- afp:AuditGrant

export interface AuditGrantScope {
  thread?: string;
  hub?: string;
  period?: { from: string; to: string };
}

export interface AuditGrantSpec {
  auditor: string;
  scope: AuditGrantScope;
  visibilityClasses: readonly string[];
  expires: string;
}

/** `afp:AuditGrant` (07 § the auditor role) — envelope pattern copied from
 * `federation.ts`'s `base()`: same shape, different object type. A grant
 * never unlocks `internal` and never crosses to another operator's data —
 * both are enforced by the caller choosing what to grant, not by this
 * builder, which is a pure representation of the spec passed in. */
export function auditGrant(envelope: Envelope, spec: AuditGrantSpec): { [key: string]: JsonValue } {
  const object: { [key: string]: JsonValue } = {
    type: "afp:AuditGrant",
    "afp:auditor": spec.auditor,
    "afp:scope": { ...spec.scope } as JsonValue,
    "afp:visibilityClasses": [...spec.visibilityClasses],
    "afp:expires": spec.expires,
  };
  const activity: { [key: string]: JsonValue } = {
    "@context": AFP_CONTEXTS,
    id: envelope.activityId,
    type: "Create",
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

export interface AuditRequest {
  auditor: string;
  thread: string;
  visibility: string;
  /** ISO instant of the fetch attempt; compared via `instantMillis`, never
   * as a string — see `../crypto/time.ts`. */
  at: string;
}

/** Does `grant` admit `request`? Every dimension must hold: auditor identity,
 * scope (thread/hub/period, whichever the grant carries — a grant with none
 * of the three admits nothing, deliberately, rather than defaulting open),
 * unlocked visibility class, and instant-before-expiry. */
export function grantAdmits(grant: { [key: string]: JsonValue }, request: AuditRequest): boolean {
  const object = grant.object as { [key: string]: JsonValue } | undefined;
  if (object === undefined || object.type !== "afp:AuditGrant") return false;

  if (object["afp:auditor"] !== request.auditor) return false;

  const classes = (object["afp:visibilityClasses"] as JsonValue[] | undefined) ?? [];
  if (!classes.includes(request.visibility)) return false;

  const scope = (object["afp:scope"] as { [key: string]: JsonValue } | undefined) ?? {};
  const scoped = scopeAdmits(scope, request);
  if (!scoped) return false;

  const expires = object["afp:expires"];
  if (typeof expires !== "string") return false;
  return instantMillis(request.at) < instantMillis(expires);
}

function scopeAdmits(scope: { [key: string]: JsonValue }, request: AuditRequest): boolean {
  if (typeof scope["thread"] === "string") return scope["thread"] === request.thread;
  if (typeof scope["hub"] === "string") return true; // hub-scoped: any thread under that hub is admitted by the caller's own filtering
  if (scope["period"] !== undefined && typeof scope["period"] === "object" && scope["period"] !== null) {
    const period = scope["period"] as { [key: string]: JsonValue };
    const from = period["from"];
    const to = period["to"];
    if (typeof from !== "string" || typeof to !== "string") return false;
    const at = instantMillis(request.at);
    return instantMillis(from) <= at && at < instantMillis(to);
  }
  return false;
}

// ------------------------------------------------------- Mastodon delivery
//
// Out of scope (ADR-0008 Decision 2's recorded wart): actually delivering a
// shadow Note to a real Mastodon inbox needs draft-cavage HTTP signatures
// signed with an RSA key, carried alongside this instance's Ed25519 multikey
// — Mastodon's inbox pipeline does not verify `eddsa-jcs-2022`/Ed25519 HTTP
// signatures. That means a second, RSA keypair per actor, a second
// signing/verification path, and a compatibility shim picking the algorithm
// per recipient. None of that is implemented here; this module produces the
// Note *representation* only, and stops before the wire.
