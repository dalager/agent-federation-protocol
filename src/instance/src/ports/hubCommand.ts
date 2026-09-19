/**
 * ADR-0039 Decisions 2 and 3: the four hub acts an operator can run, as a
 * typed command on the instance actor's own port.
 *
 * `POST /actor/command` is the sibling of `POST /agents/:name/command`. The
 * agent-scoped route carries `pause`, `status`, `approve` and `task`, which
 * act on an agent; these four act on the *instance* — it is the instance that
 * holds a seat, and `followHub`/`enroll` publish as the instance actor.
 *
 * The body is typed rather than parsed. `federation/visibility.ts`'s grammar
 * is narrow because a `Create{Note}` mention carries a stranger's free text
 * and `parseCommand` is the one place that text is given a meaning; no
 * mention reaches this route (`inbox.ts`'s `onMention` dispatches to the
 * agent-scoped one alone), so there is no free text here to parse and the
 * grammar does not learn a fifth form.
 *
 * Every refusal is the caller's `politeReply`, for the reason ADR-0029 gave
 * it: identical shape whichever reason applies, so the endpoint is not an
 * oracle for the controller list or for what this instance holds.
 */

import type { AfpInstance } from "../instance.ts";
import type { JsonValue } from "../crypto/jcs.ts";
import { enroll, unenroll } from "../hub/activities.ts";
import { loadOrCreateHubKeyPair } from "../crypto/keys.ts";

export type HubVerb = "follow" | "unfollow" | "enroll" | "unenroll";

export interface HubCommand {
  verb: HubVerb;
  hub: string;
  agent?: string;
  capabilities?: readonly string[];
  role?: string;
  reason?: string;
}

/** What the port answers on success: the activity it put on the record, and nothing about what the hub will make of it. */
export interface HubCommandResult {
  published: string;
  verb: HubVerb;
  hub: string;
  agent?: string;
}

const VERBS = new Set<HubVerb>(["follow", "unfollow", "enroll", "unenroll"]);
const ROLES = new Set(["member", "observer"]);

function isAbsoluteUrl(value: unknown): value is string {
  if (typeof value !== "string" || !/^https?:/.test(value)) return false;
  try {
    // eslint-disable-next-line no-new
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decision 2: shape first, and the whole body at once. A malformed field is
 * a refusal with nothing published — never a partial act, and never a
 * message naming which field was wrong, since the reply is the polite one
 * either way. The reason is returned for the delivery log, which is where an
 * operator's own instance may say what it would not say to a requester.
 */
export function parseHubCommand(body: unknown): { command: HubCommand } | { refuse: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { refuse: "body is not an object" };
  const raw = body as { [key: string]: unknown };

  const verb = raw.verb;
  if (typeof verb !== "string" || !VERBS.has(verb as HubVerb)) {
    return { refuse: `unknown verb ${JSON.stringify(verb)}` };
  }
  if (!isAbsoluteUrl(raw.hub)) return { refuse: `hub is not an absolute URL: ${JSON.stringify(raw.hub)}` };

  const command: HubCommand = { verb: verb as HubVerb, hub: raw.hub };

  if (verb === "enroll" || verb === "unenroll") {
    if (typeof raw.agent !== "string" || !/^[\w-]+$/.test(raw.agent)) {
      return { refuse: `agent is not a local agent name: ${JSON.stringify(raw.agent)}` };
    }
    command.agent = raw.agent;
  }

  if (verb === "enroll") {
    if (raw.capabilities !== undefined) {
      if (!Array.isArray(raw.capabilities) || !raw.capabilities.every((c) => typeof c === "string" && c.length > 0)) {
        return { refuse: "capabilities is not a list of non-empty strings" };
      }
      command.capabilities = raw.capabilities as string[];
    }
    if (raw.role !== undefined) {
      if (typeof raw.role !== "string" || !ROLES.has(raw.role)) return { refuse: `role is not member/observer: ${JSON.stringify(raw.role)}` };
      command.role = raw.role;
    }
  }

  if (verb === "unenroll" && raw.reason !== undefined) {
    if (typeof raw.reason !== "string" || raw.reason.includes("\n")) return { refuse: "reason is not a single-line string" };
    command.reason = raw.reason;
  }

  return { command };
}

/** The last path segment of a hub actor url — the hub id the per-(agent, hub) key is minted under. */
function hubIdOf(hubActorUrl: string): string | null {
  const match = /\/hubs\/([\w-]+)$/.exec(new URL(hubActorUrl).pathname);
  return match ? match[1] : null;
}

/**
 * Decision 3. Each verb publishes one activity on the instance's own chain
 * and answers with its id. Delivery is the scheduler's: the activity lands in
 * the outbox and the flush loop carries it to `${hub}/inbox` as a signed
 * hop — which for a hub this instance hosts arrives at its own server and is
 * admitted by ADR-0037's self-operated waiver.
 *
 * `enroll` does not check for a seat. That gate is the hub's (ADR-0017
 * Decision 4 R2) and an `afp:Enroll` from a seatless instance is refused
 * *there*, on the record, with a reason; a second implementation of the rule
 * here would disagree with the hub the day they drifted.
 */
export function executeHubCommand(instance: AfpInstance, command: HubCommand): HubCommandResult | { refuse: string } {
  const hubId = hubIdOf(command.hub);

  if (command.verb === "follow") {
    return { published: String(instance.followHub(command.hub).activity.id), verb: command.verb, hub: command.hub };
  }

  if (command.verb === "unfollow") {
    try {
      return { published: String(instance.unfollowHub(command.hub).activity.id), verb: command.verb, hub: command.hub };
    } catch (error) {
      // `unfollowHub` throws when there is no live Follow to undo — a real
      // answer about this instance's own trail, not a hint about the hub.
      return { refuse: (error as Error).message };
    }
  }

  const agent = command.agent as string;
  if (!instance.specs.some((spec) => spec.name === agent)) {
    return { refuse: `${agent} is not an agent this instance holds` };
  }
  if (hubId === null) return { refuse: `${command.hub} is not a hub actor url` };

  const thread = `${instance.config.origin}/threads/hub-${hubId}`;

  if (command.verb === "unenroll") {
    const entry = instance.publishAsInstance([command.hub], thread, "hub", (envelope) =>
      unenroll(envelope, { agent: instance.actorId(agent), hub: command.hub, reason: command.reason ?? "withdrawn by the operator" }),
    );
    return { published: String(entry.activity.id), verb: command.verb, hub: command.hub, agent };
  }

  // The agent's own declared capabilities are the honest default: enrolling
  // an agent for something it does not advertise would put a claim on the
  // record its actor document contradicts.
  const spec = instance.specs.find((s) => s.name === agent)!;
  const capabilities = command.capabilities ?? spec.capabilities;
  const hubKey = loadOrCreateHubKeyPair(instance.config.keyDir, agent, instance.actorId(agent), hubId);
  const entry = instance.publishAsInstance([command.hub], thread, "hub", (envelope) =>
    enroll(envelope, {
      agent: instance.actorId(agent),
      hub: command.hub,
      capabilities: [...capabilities],
      hubKey: hubKey.keyId,
      ...(command.role ? { role: command.role } : {}),
    }),
  );
  return { published: String(entry.activity.id), verb: command.verb, hub: command.hub, agent };
}

/** The hubs this instance follows — `hub list`'s read half (Decision 4). */
export function hubsFollowed(instance: AfpInstance): { [key: string]: JsonValue } {
  return { following: instance.followingIds() };
}
