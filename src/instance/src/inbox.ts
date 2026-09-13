/**
 * The inbox pipeline.
 *
 * One ordered path for every inbound activity: verify the proof, run the trust
 * gate, dedupe on activity id, then dispatch by type. Anything that fails a step
 * is dropped *and* audit-logged — an inbox is a hint, never an instruction
 * (04 § Reliability).
 *
 * Split out of `instance.ts` so the adapter stack stays readable: that file owns
 * identity, signing and the outbound path; this one owns everything inbound.
 */

import type { JsonValue } from "./crypto/jcs.ts";
import { publicKeyFromMultibase } from "./crypto/keys.ts";
import { verifyProof } from "./crypto/proof.ts";
import { instanceActorId } from "./ap/documents.ts";
import { acceptTask, correlationIdOf, createError, createResult, rejectTask } from "./ap/activities.ts";
import { isAuthorizedController, parseCommand, politeReply } from "./federation/visibility.ts";
import { executeCommand } from "./ports/command.ts";
import { Artifacts } from "./store/artifacts.ts";
import {
  consumesBytes,
  excerptOf,
  type Provenance,
  type ProvenanceSource,
  type TaskAttachment,
} from "./brains/port.ts";
import type { AfpInstance, ReceiveOutcome } from "./instance.ts";

export class Inbox {
  private readonly instance: AfpInstance;

  constructor(instance: AfpInstance) {
    this.instance = instance;
  }

  /**
   * The inbox pipeline, in order: verify the proof, run the trust gate, dedupe
   * on activity id, then dispatch. Anything that fails a step is dropped with a
   * reason rather than processed.
   */
  async receive(activity: { [key: string]: JsonValue }): Promise<ReceiveOutcome> {
    const activityId = typeof activity.id === "string" ? activity.id : "";
    const actorUrl = String(activity.actor ?? "");
    if (!activityId) return this.dropDelivery("rejected", "", actorUrl, "activity has no id");

    const signerUrl = typeof activity["afp:actingAs"] === "string"
      ? instanceActorId(this.instance.config.origin)
      : actorUrl;
    const verification = this.verifySignature(activity, signerUrl);
    if (!verification.ok) {
      return this.dropDelivery("rejected", activityId, actorUrl, verification.reason);
    }

    // Trust gate. P1 is a single trust domain, so this short-circuits on
    // `operatedBy == self` (06) — there is no agreement to check and no
    // self-agreement to model.
    if (this.instance.nameOf(actorUrl) === null) {
      return this.dropDelivery(
        "rejected",
        activityId,
        actorUrl,
        `actor ${actorUrl} is not on this instance's roster`,
      );
    }

    if (!this.instance.seen.markSeen(activityId, this.instance.clock.now())) {
      return this.dropDelivery("duplicate", activityId, actorUrl, `activity ${activityId} already delivered`);
    }

    await this.dispatch(activity);
    return { status: "dispatched" };
  }

  /**
   * Entry for activities the federation boundary has already authenticated
   * and gated (ADR-0008/0009): the object proof was verified against the
   * sender's *fetched* actor document and the two-tier gate admitted it, so
   * the P1 local-roster check does not apply — a foreign actor is exactly
   * what the boundary exists to admit. Dedupe and audit run unchanged.
   */
  async receiveAdmitted(activity: { [key: string]: JsonValue }): Promise<ReceiveOutcome> {
    const activityId = typeof activity.id === "string" ? activity.id : "";
    const actorUrl = String(activity.actor ?? "");
    if (!activityId) return this.dropDelivery("rejected", "", actorUrl, "activity has no id");
    if (!this.instance.seen.markSeen(activityId, this.instance.clock.now())) {
      return this.dropDelivery("duplicate", activityId, actorUrl, `activity ${activityId} already delivered`);
    }
    await this.dispatch(activity);
    return { status: "dispatched" };
  }

  /**
   * Record a dropped delivery, then report it. Nothing is discarded silently.
   *
   * `"polite-reply"` (ADR-0029 Decision 2/3) is the fixed, read-only answer
   * to an unauthorized, unparseable or anonymous command — recorded here so
   * the attempt is on the operator's audit trail, never on the chain.
   */
  dropDelivery(
    outcome: "rejected" | "duplicate" | "polite-reply",
    activityId: string,
    actor: string,
    reason: string,
  ): ReceiveOutcome {
    this.instance.db
      .prepare("INSERT INTO audit_log (at, outcome, activity_id, actor, reason) VALUES (?, ?, ?, ?, ?)")
      .run(this.instance.clock.now().toISOString(), outcome, activityId || null, actor || null, reason);
    return { status: outcome, reason } as ReceiveOutcome;
  }

  /** The audit log of dropped deliveries, newest last. */
  auditLog(): { at: string; outcome: string; activityId: string | null; reason: string }[] {
    const rows = this.instance.db
      .prepare("SELECT at, outcome, activity_id, reason FROM audit_log ORDER BY id ASC")
      .all() as Record<string, unknown>[];
    return rows.map((row) => ({
      at: String(row.at),
      outcome: String(row.outcome),
      activityId: row.activity_id === null ? null : String(row.activity_id),
      reason: String(row.reason),
    }));
  }

  verifySignature(
    activity: { [key: string]: JsonValue },
    signerUrl: string,
  ): { ok: true } | { ok: false; reason: string } {
    const instanceId = instanceActorId(this.instance.config.origin);
    const name = signerUrl === instanceId ? "@instance" : this.instance.nameOf(signerUrl);
    if (name === null) return { ok: false, reason: `no known key for signer ${signerUrl}` };

    const publicKey = publicKeyFromMultibase(this.instance.key(name).publicKeyMultibase);
    const result = verifyProof(activity, publicKey);
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  }

  async dispatch(activity: { [key: string]: JsonValue }): Promise<void> {
    const type = String(activity.type ?? "");
    const object = activity.object;
    const objectType =
      object && typeof object === "object" && !Array.isArray(object)
        ? String((object as { [key: string]: JsonValue }).type ?? "")
        : "";

    if (type === "Offer" && objectType === "afp:Task") return this.onTaskOffered(activity);
    if (type === "Accept") return this.onAccepted(activity);
    if (type === "Create" && objectType === "afp:Result") return this.onResult(activity);
    if (type === "Create" && objectType === "afp:Error") return this.onError(activity);
    // ADR-0029 Decision 3: the Mastodon carrier for the command grammar — a
    // `Create{Note}` addressed to one of this instance's agents is a mention.
    // This is the ONE call site in the instance that parses a stranger's free
    // text (G3's "no other path"); every other inbound type above is a typed
    // `afp:*` activity the boundary already trusts.
    if (type === "Create" && objectType === "Note") return this.onMention(activity);
    // Unknown types are recorded as received and otherwise ignored — an inbox is
    // a hint, never an instruction (04 § Reliability).
  }

  /**
   * ADR-0029 Decision 3: a `Create{Note}` mentioning one of this instance's
   * agents. An authorized controller's parsed command runs through the same
   * `executeCommand` the HTTP route calls (`ports/command.ts`) — one
   * decision function, two carriers. Everyone and everything else — a
   * stranger, an unparseable note, a controller naming the wrong agent — is
   * dropped with the fixed polite reply recorded in the audit log; delivering
   * that reply to a real Mastodon inbox is ADR-0023 L18, parked (04 §
   * Mastodon interop), so it goes no further than this log line.
   */
  private async onMention(activity: { [key: string]: JsonValue }): Promise<void> {
    const activityId = String(activity.id ?? "");
    const sender = String(activity.actor ?? "");
    const note = activity.object as { [key: string]: JsonValue };
    const content = typeof note?.content === "string" ? note.content : "";
    const thread = typeof activity.context === "string" ? activity.context : undefined;

    // The sender is already verified — `receive` checked the proof, or the
    // boundary checked the hop signature — so, unlike the HTTP route's
    // anonymous case, every refusal here has a known author and is recorded
    // (ADR-0013 Decision 5's line: identity known, cost paid).
    const recipient = firstRecipient(activity);
    const name = recipient ? this.instance.nameOf(recipient) : null;
    if (!name) {
      this.dropDelivery("polite-reply", activityId, sender, `${politeReply(content)} (no local agent addressed)`);
      return;
    }

    if (!isAuthorizedController(sender, { controllers: this.instance.config.controllers })) {
      this.dropDelivery("polite-reply", activityId, sender, politeReply(content));
      return;
    }

    const command = parseCommand(content, this.instance.actorId(name));
    if (!command || (command.command !== "approve" && command.target !== name)) {
      this.dropDelivery("polite-reply", activityId, sender, politeReply(content));
      return;
    }

    const result = await executeCommand(this.instance, { agentName: name, by: sender, command, thread, content });
    if ("reply" in result) {
      this.dropDelivery("polite-reply", activityId, sender, "approve target not admissible");
    }
  }

  async onTaskOffered(activity: { [key: string]: JsonValue }): Promise<void> {
    const task = activity.object as { [key: string]: JsonValue };
    const correlationId = String(task["afp:correlationId"] ?? "");
    const thread = String(activity.context ?? "");
    const performerUrl = firstRecipient(activity);
    const performerName = performerUrl ? this.instance.nameOf(performerUrl) : null;
    if (!performerName) return;

    // ADR-0029 Decision 2 ("Command"): a paused performer never reaches its
    // brain — the delegator gets the same Reject shape a stranger's brain
    // failure would produce, so a paused agent looks, from the outside,
    // exactly like one that declined the task.
    if (this.instance.isPaused(performerName)) {
      this.instance.publish(performerName, [String(activity.actor ?? "")], thread, "parties", (envelope) =>
        rejectTask(envelope, String(activity.id ?? ""), correlationId, "paused by controller"),
      );
      return;
    }

    const performer = this.instance.agents.get(performerName)!;

    // Dedupe layer 2: the same *task* arriving as a genuinely new activity.
    // A hit replays the cached outcome; the brain is not invoked again.
    const cached = this.instance.tasks.cachedResult(correlationId, performerUrl!);
    if (cached) {
      this.instance.queue.enqueue(String(activity.actor ?? ""), cached, this.instance.clock.now());
      return;
    }

    this.instance.publish(performerName, [String(activity.actor ?? "")], thread, "parties", (envelope) =>
      acceptTask(envelope, String(activity.id ?? ""), correlationId),
    );

    const delegator = String(activity.actor ?? "");
    const provenance = this.provenanceOf(delegator);
    const attachments = this.materialize(task.attachment, provenance, performer.brain.consumes);
    const outcome = await performer.brain.handle({
      capability: String(task["afp:capability"] ?? ""),
      content: String(task.content ?? ""),
      provenance,
      attachments,
      thread,
    });

    if (!outcome.ok) {
      const entry = this.instance.publish(performerName, [delegator], thread, "parties", (envelope) =>
        createError(envelope, {
          errorId: `${envelope.actor}/errors/${correlationId}`,
          correlationId,
          code: "afp:err:brain-failed",
          reason: outcome.reason,
        }),
      );
      this.instance.tasks.cacheResult(correlationId, performerUrl!, entry.activity, this.instance.clock.now());
      return;
    }

    const produced = (outcome.attachments ?? []).map((artifact) =>
      Artifacts.toLink(this.instance.artifacts.put(artifact.bytes, artifact.mediaType, this.instance.clock.now())) as JsonValue,
    );

    const entry = this.instance.publish(performerName, [delegator], thread, "parties", (envelope) =>
      createResult(envelope, {
        resultId: `${envelope.actor}/results/${correlationId}`,
        correlationId,
        content: outcome.content,
        summary: outcome.summary,
        producedBy: outcome.producedBy,
        attachments: produced,
      }),
    );
    this.instance.tasks.cacheResult(correlationId, performerUrl!, entry.activity, this.instance.clock.now());
  }

  async onAccepted(activity: { [key: string]: JsonValue }): Promise<void> {
    const correlationId = correlationIdOf(activity);
    if (correlationId) this.instance.tasks.setState(correlationId, "accepted", this.instance.clock.now());
  }

  async onResult(activity: { [key: string]: JsonValue }): Promise<void> {
    const correlationId = correlationIdOf(activity);
    if (correlationId) this.instance.tasks.setState(correlationId, "completed", this.instance.clock.now());
  }

  async onError(activity: { [key: string]: JsonValue }): Promise<void> {
    const correlationId = correlationIdOf(activity);
    if (correlationId) this.instance.tasks.setState(correlationId, "failed", this.instance.clock.now());
  }

  /**
   * ADR-0027 Decision 2: turn attachment Links into what a brain is allowed to
   * see.
   *
   * Every attachment arrives as a *reference* — digest, declared type, size,
   * and a bounded excerpt of text — carrying the provenance of whoever put it
   * there. Bytes are added only for the media types the agent declared it
   * consumes (`afp:consumes`). Anything whose digest does not match is
   * discarded: a brain never sees unverified evidence.
   */
  materialize(
    attachment: JsonValue | undefined,
    authored: Provenance,
    consumes?: readonly string[],
  ): TaskAttachment[] {
    if (!Array.isArray(attachment)) return [];
    const out: TaskAttachment[] = [];
    for (const link of attachment) {
      if (!link || typeof link !== "object" || Array.isArray(link)) continue;
      const digest = (link as { [key: string]: JsonValue })["afp:digest"];
      const mediaType = (link as { [key: string]: JsonValue }).mediaType;
      if (typeof digest !== "string") continue;
      const bytes = this.instance.artifacts.get(digest);
      if (!bytes) continue;
      const type = typeof mediaType === "string" ? mediaType : "application/octet-stream";

      // Evidence that entered from outside AFP is `external` whoever relayed
      // it: nobody vouched for a fetched page or a client submission.
      const record = this.instance.artifacts.lookup(digest);
      const provenance: Provenance = record?.sourceUrl
        ? { source: "external", author: record.sourceUrl, digest }
        : { ...authored, digest };

      out.push({
        digest,
        mediaType: type,
        size: bytes.length,
        excerpt: excerptOf(bytes, type),
        provenance,
        ...(consumesBytes(consumes, type) ? { bytes } : {}),
      });
    }
    return out;
  }

  /**
   * ADR-0027 Decision 2: who authored an inbound activity's words. An actor on
   * this instance is the `delegator`; anyone else is a `counterparty`, whatever
   * agreement stands with them — "we have an agreement" and "their text is safe
   * to obey" are unrelated claims (ADR-0008 Decision 5).
   */
  provenanceOf(actorUrl: string): Provenance {
    const local = actorUrl.startsWith(`${this.instance.config.origin}/`);
    const source: ProvenanceSource = local ? "delegator" : "counterparty";
    return { source, author: actorUrl };
  }

}

function firstRecipient(activity: { [key: string]: JsonValue }): string | null {
  const to = activity.to;
  if (Array.isArray(to) && to.length > 0 && typeof to[0] === "string") return to[0];
  return typeof to === "string" ? to : null;
}
