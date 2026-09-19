/**
 * ADR-0029 Decision 2 ("Command") and Decision 3 (the Mastodon carrier).
 *
 * `executeCommand` is the one place a parsed, authorized command becomes an
 * effect on the record; two carriers call it — the HTTP route
 * `POST /agents/:name/command` (`commandRoute`, hooked into `ap/server.ts`
 * the way `render/routes.ts` hooks in) and the inbox's `Create{Note}`
 * mention (`inbox.ts` `dispatch` → `onMention`). Neither carrier decides
 * what a command *means*; this module does, which is what makes "no other
 * path parses stranger free text" (gate G3) true by construction rather than
 * by convention — see the one call site each carrier has for
 * `parseCommand`.
 *
 * Every refusal — unauthorized, unparseable, misdirected, anonymous, or an
 * `approve` naming a thread with no pinned `approve` action — answers with
 * the fixed `politeReply` (04 § Mastodon interop / Participation inbound):
 * identical shape whichever reason applies, so the endpoint is not an oracle
 * for the grammar or the controller list.
 */

import { createHash } from "node:crypto";
import { jsonResponse, readCappedBody, TOO_LARGE } from "../runtime/httpPort.ts";
import type { AfpInstance } from "../instance.ts";
import { authorizeRead, type ReadGateDeps } from "../federation/readGate.ts";
import type { RequestAuthHeaders } from "../federation/httpSig.ts";
import { isAuthorizedController, parseCommand, politeReply, type Command } from "../federation/visibility.ts";
import type { ActionPolicy } from "../ap/pins.ts";
import type { JsonValue } from "../crypto/jcs.ts";
import { ApprovalRefused, approveThroughPort, type ApprovalPort } from "./approval.ts";
import { executeHubCommand, parseHubCommand } from "./hubCommand.ts";

export interface CommandRouteContext {
  path: string;
  headers: RequestAuthHeaders;
  /** Raw request body bytes — what the POST signature's content-digest covers. */
  body: string;
  send: (status: number, body: unknown) => void;
}

type ReadOptions = ReadGateDeps | undefined;

function polite(): { reply: string } {
  return { reply: politeReply("") };
}

/**
 * The pinned `afp:actionPolicy` for `thread`: the first task-bearing
 * activity in chain order that carries one — an `Offer{afp:Task}` (the
 * direct flow) or an `Offer{afp:Proposal}` (a hub round). `ap/pins.ts`
 * `buildPinSet` puts the pin on the object in both cases, so one field
 * lookup covers both carriers without knowing which one this thread used.
 */
function pinnedPolicy(instance: AfpInstance, thread: string): ActionPolicy | null {
  for (const entry of instance.outbox.byThread(thread)) {
    const object = entry.activity.object;
    if (!object || typeof object !== "object" || Array.isArray(object)) continue;
    const policy = (object as { [key: string]: JsonValue })["afp:actionPolicy"];
    if (policy && typeof policy === "object" && !Array.isArray(policy)) return policy as ActionPolicy;
  }
  return null;
}

/**
 * `approve-` + the first 16 hex characters of sha256(thread \0 actsOn) —
 * deterministic, so the same `approve` replayed against the same thread and
 * decision record reuses one actuation intent; `instance.actuate`'s own
 * idempotency key does the rest of the dedupe work.
 */
function approveCorrelationId(thread: string, actsOn: string): string {
  const hash = createHash("sha256")
    .update(Buffer.from(thread, "utf8"))
    .update(Buffer.from([0x00]))
    .update(Buffer.from(actsOn, "utf8"))
    .digest("hex");
  return `approve-${hash.slice(0, 16)}`;
}

/**
 * `task-` + the first 12 hex characters of sha256(controller \0 brief \0
 * instant) — the thread slug and correlationId of a `task` command, derived
 * the way `approveCorrelationId` is rather than minted at random, so the
 * same brief from the same controller at the same instant names one task.
 */
function taskSlug(controller: string, content: string, published: string): string {
  const hash = createHash("sha256")
    .update(Buffer.from(controller, "utf8"))
    .update(Buffer.from([0x00]))
    .update(Buffer.from(content, "utf8"))
    .update(Buffer.from([0x00]))
    .update(Buffer.from(published, "utf8"))
    .digest("hex");
  return `task-${hash.slice(0, 12)}`;
}

const VISIBILITY_CLASSES: ReadonlySet<string> = new Set(["public", "hub", "parties", "internal"]);

export interface ExecuteCommandOptions {
  /** Local name of the agent the command addresses. */
  agentName: string;
  /** The controller actor URL that issued it — already authorized by the caller. */
  by: string;
  command: Command;
  /** `approve` (required) and `task` (optional; defaults to a derived thread). */
  thread?: string;
  actsOn?: string;
  /** `approve` only — the note/command text, carried into the actuation's summary. */
  content?: string;
  /** `task` only (ADR-0038 Decision 2): the capability asked for — defaults to the agent's first advertised one. */
  capability?: string;
  /** `task` only: an ISO instant. */
  deadline?: string;
  /** `task` only: defaults to `"parties"`. */
  visibility?: string;
  /** `task` only: `sha256:` digests of artifacts the store already holds — references, never bytes. */
  attachments?: readonly string[];
}

const ARTIFACT_DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * Run an authorized, parsed command against the record.
 *
 * Callers have already checked `isAuthorizedController` and `parseCommand`
 * (and, for `pause`/`status`, that the parsed target names this same
 * agent) — this function's only remaining refusal is a policy shape
 * `approve` cannot use: no `thread`/`actsOn`, no task-bearing activity on
 * that thread, or one whose pinned policy has no `approve` action. That
 * refusal is the same polite reply as every other one, because a controller
 * naming a thread that never pinned an approve/reject is not this
 * endpoint's business to explain (04's fixed-reply rule applies to the
 * whole surface, not only to unauthorized signers).
 */
export async function executeCommand(instance: AfpInstance, options: ExecuteCommandOptions): Promise<{ [key: string]: JsonValue }> {
  const { command } = options;

  if (command.command === "status") {
    const actorUrl = instance.actorId(options.agentName);
    return {
      status: {
        agent: actorUrl,
        chainHead: instance.outbox.headDigest(actorUrl),
        pending: instance.tasks.openCountForPerformer(actorUrl),
        paused: instance.isPaused(options.agentName),
      },
    };
  }

  if (command.command === "pause") {
    // Idempotent: a second `pause` finds the agent already paused and does
    // nothing further (`PausedAgents.pause` is `Set.add`).
    instance.pauseAgent(options.agentName);
    return { paused: true };
  }

  if (command.command === "task") return executeTask(instance, options, command.content);

  // command.command === "approve"
  if (!options.thread || !options.actsOn) return polite();
  const policy = pinnedPolicy(instance, options.thread);
  if (!policy || typeof policy.approve !== "string" || !policy.approve) return polite();

  // The human's answer enters the record through ADR-0028's own path — an
  // `ApprovalPort` whose `present` just returns the decision this command
  // already carries, so `approveThroughPort` runs the identical checks
  // (authorized controller, policy admits the decision) and the identical
  // actuation/reconciliation shape a webhook-driven approval would produce.
  const port: ApprovalPort = { present: async () => ({ decision: "approve", by: options.by }) };
  try {
    const result = await approveThroughPort(instance, port, {
      actuatorName: options.agentName,
      decisionRecordDigest: options.actsOn,
      thread: options.thread,
      summary: options.content ?? "approve",
      policy,
      correlationId: approveCorrelationId(options.thread, options.actsOn),
    });
    if (result.status === "reconciled" || result.status === "already-reconciled") {
      return { approved: true, actuation: result.actuation.activityId, reconciliation: result.reconciliation.activityId };
    }
    if (result.status === "unreconciled") {
      return { approved: true, actuation: result.actuation.activityId, error: result.error.activityId };
    }
    return { approved: false, error: result.error.activityId };
  } catch (err) {
    if (err instanceof ApprovalRefused) return polite();
    throw err;
  }
}

/**
 * ADR-0038 Decision 2: `@<name> task <brief>` becomes an `Offer{afp:Task}`
 * from the controller's own held actor to the agent — `instance.delegate`,
 * the same call every demo makes, no new wire vocabulary.
 *
 * The requester must resolve to an actor this instance holds, over and
 * above being a listed controller: the Offer is *signed* as the delegator,
 * and only an actor whose key this instance holds can be signed for. A
 * listed controller on another instance is authorized to `pause`, `status`
 * and `approve` — none of which publishes as them — but cannot delegate
 * from here, and gets the same polite reply as anything else refused: the
 * endpoint is not an oracle for which controllers are local.
 *
 * Provenance: the brief enters the brain as `delegator` material by
 * construction — `inbox.ts`'s `provenanceOf` sees an Offer from an actor
 * under this origin, which is ADR-0027's `localProvenance`: the operator is
 * not a stranger to their own instance.
 */
function executeTask(instance: AfpInstance, options: ExecuteCommandOptions, brief: string): { [key: string]: JsonValue } {
  const controller = instance.nameOf(options.by);
  if (controller === null) return polite();

  const spec = instance.specs.find((candidate) => candidate.name === options.agentName);
  if (!spec) return polite();
  const capability = options.capability ?? spec.capabilities[0];
  if (!capability || !spec.capabilities.includes(capability)) return polite();

  if (options.deadline !== undefined && Number.isNaN(Date.parse(options.deadline))) return polite();
  const visibility = options.visibility ?? "parties";
  if (!VISIBILITY_CLASSES.has(visibility)) return polite();

  // Attachments are references to what the store already holds, never
  // bytes: the command port takes no content. ADR-0027's boundary — the
  // operator may point a brain at evidence already on the record (a draft
  // `show result` named by digest), but cannot smuggle new bytes past
  // `artifacts.put`'s provenance through a command. A digest the store does
  // not hold, or one that is not a digest, is refused like everything else.
  const attachments = [];
  for (const digest of options.attachments ?? []) {
    if (!ARTIFACT_DIGEST.test(digest)) return polite();
    const ref = instance.artifacts.lookup(digest);
    if (!ref) return polite();
    attachments.push(ref);
  }

  const published = instance.clock.now().toISOString();
  const slug = taskSlug(options.by, brief, published);
  const thread = options.thread ?? `${instance.config.origin}/threads/${slug}`;

  const entry = instance.delegate({
    from: controller,
    to: options.agentName,
    capability,
    content: brief,
    thread,
    correlationId: slug,
    ...(options.deadline !== undefined ? { deadline: options.deadline } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    visibility: visibility as "public" | "hub" | "parties" | "internal",
  });
  return { task: entry.activityId, thread, correlationId: slug };
}

/**
 * `POST /agents/:name/command` — the local carrier for ADR-0029 Decision 2.
 * Shaped like `render/routes.ts`'s `renderingRoute`: one function `ap/server.ts`
 * calls, returning whether it handled the request, so the routing table
 * there grows by a few lines rather than a branch tree.
 *
 * A refusal from a *verified* signer is recorded in the audit log before the
 * answer — identity known, the signature paid for the line — never on the
 * chain (ADR-0029 Decision 2). An anonymous or non-verifying request is
 * answered and NOT recorded: ADR-0013 Decision 5's rule, unchanged here —
 * a free, anonymous, unbounded refusal logged is a pen any stranger can
 * write into the operator's store with, and it proves only that somebody
 * asked. The rate limiter bounds the asking; nothing records it.
 */
export async function commandRoute(instance: AfpInstance, read: ReadOptions, ctx: CommandRouteContext): Promise<boolean> {
  // ADR-0039 Decision 1: the instance actor's own command port, addressed
  // where the acting actor is. Same authorization, same polite refusal; a
  // typed body instead of the grammar (Decision 2).
  if (ctx.path === "/actor/command") return actorCommandRoute(instance, read, ctx);

  const match = ctx.path.match(/^\/agents\/([\w-]+)\/command$/);
  if (!match) return false;
  const name = match[1];
  if (!instance.specs.some((spec) => spec.name === name)) {
    ctx.send(404, { error: "not found" });
    return true;
  }

  const refuse = (actor: string, reason: string): void => {
    if (actor) instance.inbox.dropDelivery("polite-reply", "", actor, reason);
    ctx.send(200, polite());
  };

  let body: { content?: unknown; thread?: unknown; actsOn?: unknown; capability?: unknown; deadline?: unknown; visibility?: unknown; attachments?: unknown };
  try {
    body = JSON.parse(ctx.body || "{}");
  } catch {
    body = {};
  }
  const content = typeof body.content === "string" ? body.content : "";
  const thread = typeof body.thread === "string" ? body.thread : undefined;
  const actsOn = typeof body.actsOn === "string" ? body.actsOn : undefined;
  // ADR-0038 Decision 2: `task`'s optional structured fields beside the brief.
  const capability = typeof body.capability === "string" ? body.capability : undefined;
  const deadline = typeof body.deadline === "string" ? body.deadline : undefined;
  const visibility = typeof body.visibility === "string" ? body.visibility : undefined;
  // Anything but an array of strings is treated as "attachments present and
  // malformed" — one bad entry refuses the whole command, never a partial send.
  const attachments = body.attachments === undefined
    ? undefined
    : Array.isArray(body.attachments) && body.attachments.every((d) => typeof d === "string")
      ? (body.attachments as string[])
      : ["malformed"];

  if (!read) {
    refuse("", "no read gate configured — every command request is anonymous");
    return true;
  }

  const auth = await authorizeRead(read, { path: ctx.path, headers: ctx.headers, method: "POST", body: ctx.body });
  const requester = auth.requester;
  if (!requester) {
    refuse("", "no verifying signature — anonymous");
    return true;
  }
  if (!isAuthorizedController(requester.agent, { controllers: instance.policy.controllers ?? [] })) {
    refuse(requester.agent, `${requester.agent} is not an authorized controller`);
    return true;
  }

  const agentActorUrl = instance.actorId(name);
  const command = parseCommand(content, agentActorUrl);
  // `pause`/`status` name their target inside the mention text itself
  // (`@<name> pause`); the target must be this same route's `:name`, or the
  // request is misdirected rather than authorized for the agent it landed
  // on. `approve` names no one in its text (bare `approve`), so its target
  // is `agentActorUrl` by construction and never fails this check.
  if (!command || (command.command !== "approve" && command.target !== name)) {
    refuse(requester.agent, "unparseable or misdirected command");
    return true;
  }

  const result = await executeCommand(instance, {
    agentName: name,
    by: requester.agent,
    command,
    thread,
    actsOn,
    content,
    capability,
    deadline,
    visibility,
    attachments,
  });

  // `executeCommand` itself falls back to the polite reply for an `approve`
  // whose thread/policy will not admit it, or a `task` from a controller
  // this instance does not hold / for a capability the agent does not
  // advertise — logged the same way every other refusal on this route is.
  if ("reply" in result) {
    instance.inbox.dropDelivery("polite-reply", "", requester.agent, `${command.command} target not admissible`);
  }
  ctx.send(200, result);
  return true;
}

/** `true` for a `POST` on `/agents/:name/command` — `ap/server.ts`'s one-line dispatch check, mirrored on `matchWebhookRoute`'s shape. */
export function matchCommandRoute(method: string, path: string): boolean {
  return method === "POST" && (path === "/actor/command" || /^\/agents\/[\w-]+\/command$/.test(path));
}

/**
 * ADR-0039 Decisions 1–3: `POST /actor/command`. Authorization is the
 * agent-scoped route's, to the letter — a verifying signature through the
 * read gate, whose actor is on the policy's `afp:controllers` — and the
 * refusal is the same `politeReply`. What differs is below it: a typed body,
 * validated whole before anything is published, and four verbs that act on
 * the instance rather than on an agent.
 */
async function actorCommandRoute(instance: AfpInstance, read: ReadOptions, ctx: CommandRouteContext): Promise<boolean> {
  const refuse = (actor: string, reason: string): void => {
    if (actor) instance.inbox.dropDelivery("polite-reply", "", actor, reason);
    ctx.send(200, polite());
  };

  if (!read) {
    refuse("", "no read gate configured — every command request is anonymous");
    return true;
  }
  const auth = await authorizeRead(read, { path: ctx.path, headers: ctx.headers, method: "POST", body: ctx.body });
  const requester = auth.requester;
  if (!requester) {
    refuse("", "no verifying signature — anonymous");
    return true;
  }
  if (!isAuthorizedController(requester.agent, { controllers: instance.policy.controllers ?? [] })) {
    refuse(requester.agent, `${requester.agent} is not an authorized controller`);
    return true;
  }

  let body: unknown;
  try {
    body = JSON.parse(ctx.body || "{}");
  } catch {
    body = null;
  }
  const parsed = parseHubCommand(body);
  if ("refuse" in parsed) {
    refuse(requester.agent, parsed.refuse);
    return true;
  }

  const result = executeHubCommand(instance, parsed.command);
  if ("refuse" in result) {
    refuse(requester.agent, result.refuse);
    return true;
  }
  ctx.send(200, result);
  return true;
}

/**
 * The raw-`http` half of the route: body-capped and read exactly like the
 * inbox POST (`ap/server.ts`'s own block) and like `ports/webhook.ts`'s
 * `handleWebhook` — a signed command's signature covers the body digest, so
 * the bytes must be complete and untouched before `commandRoute` (and the
 * read gate inside it) ever sees them. Kept out of `ap/server.ts` to hold
 * that file under its line ceiling.
 */
export async function handleCommandPost(instance: AfpInstance, read: ReadOptions, request: Request, path: string): Promise<Response> {
  const raw = await readCappedBody(request, instance.config.maxInboxBodyBytes);
  if (raw === TOO_LARGE) return jsonResponse(413, { error: "payload too large" });
  const body = new TextDecoder().decode(raw);

  // `commandRoute` answers through a `send` callback rather than by
  // returning, because it decides mid-flight whether it handled the path at
  // all. Capturing what it sent keeps that contract and still hands one
  // Response back to the port.
  let answer: Response | null = null;
  const send = (status: number, respBody: unknown): void => {
    answer = jsonResponse(status, JSON.stringify(respBody, null, 2));
  };

  try {
    const handled = await commandRoute(instance, read, {
      path,
      headers: {
        host: request.headers.get("host") ?? "",
        date: request.headers.get("date") ?? "",
        digest: request.headers.get("digest") ?? undefined,
        "content-digest": request.headers.get("content-digest") ?? undefined,
        "signature-input": request.headers.get("signature-input") ?? undefined,
        signature: request.headers.get("signature") ?? "",
      },
      body,
      send,
    });
    if (!handled) return jsonResponse(404, { error: "not found" });
  } catch {
    return jsonResponse(500, { error: "internal" });
  }
  return answer ?? jsonResponse(500, { error: "internal" });
}
