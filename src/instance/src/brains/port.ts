/**
 * The agent port.
 *
 * This file is the whole contract between an agent's brain and the instance.
 * Nothing here mentions ActivityPub, signatures, SQLite or HTTP — that is the
 * point of the ports-and-adapters boundary in 01: the instance is the adapter
 * stack, and a brain is portable across instance implementations because the
 * port is protocol-defined rather than implementation-defined.
 *
 * A brain that grows an import from `../ap/` has broken the boundary.
 *
 * ADR-0027 makes the port a *security* boundary as well as a portability one.
 * What it guarantees is three narrow things: the brain is told who authored
 * each input; hostile material arrives framed as data under a versioned
 * template the record names; and the actions an answer can cause were bounded
 * before the brain spoke (ADR-0006/0010). What it cannot guarantee is a
 * model's judgement under hostile text. Nothing here should be read as more.
 */

/** An artifact handed to or produced by a brain, already materialised. */
export interface BrainArtifact {
  mediaType: string;
  bytes: Uint8Array;
}

/**
 * ADR-0027 Decision 2: where an input came from.
 *
 * `delegator` — an actor on this instance asked for the work.
 * `counterparty` — an actor on another instance did (ADR-0008's boundary).
 * `external` — the bytes entered from outside AFP entirely: a fetched page, a
 *   client submission, a bug report. Nobody vouched for this text.
 */
export type ProvenanceSource = "delegator" | "counterparty" | "external";

export interface Provenance {
  readonly source: ProvenanceSource;
  /** Actor URL, or the source URL for `external` material. */
  readonly author: string;
  /** Present for attachments: the artifact's `sha256:…`. */
  readonly digest?: string;
}

/** True when this provenance means "a stranger wrote this" (Decision 3). */
export function isThirdParty(provenance: Provenance): boolean {
  return provenance.source === "counterparty" || provenance.source === "external";
}

/** How much of a text attachment a brain sees without declaring consumption. */
export const EXCERPT_MAX_BYTES = 8 * 1024;

/**
 * ADR-0027 Decision 2: an attachment reaches a brain as a *reference* —
 * digest, declared type, size, and a bounded excerpt of text — unless the
 * agent declared `afp:consumes` for this media type, in which case `bytes` is
 * populated too. The default path hands a model references, not bytes.
 */
export interface TaskAttachment {
  readonly digest: string;
  readonly mediaType: string;
  readonly size: number;
  /** First `EXCERPT_MAX_BYTES` of text types; empty string for binary. */
  readonly excerpt: string;
  readonly provenance: Provenance;
  /** Populated only when the agent's capability declaration consumes this type. */
  readonly bytes?: Uint8Array;
}

export interface TaskRequest {
  /** Which capability was asked for. */
  capability: string;
  /** Free-text instruction. */
  content: string;
  /** Who authored `content` (Decision 2). */
  provenance: Provenance;
  /** Inputs, already digest-verified and bounded by the adapter (Decision 2). */
  attachments: TaskAttachment[];
  /** Thread the task belongs to — brains may use it for continuity, nothing more. */
  thread: string;
}

/**
 * The text of an attachment as this brain is allowed to see it: the full
 * decoded bytes when the agent declared consumption, the bounded excerpt
 * otherwise. Brains should use this rather than reaching for `bytes`.
 */
export function textOf(attachment: TaskAttachment): string {
  if (attachment.bytes && isTextual(attachment.mediaType)) {
    return new TextDecoder().decode(attachment.bytes);
  }
  return attachment.excerpt;
}

/** Media types an excerpt makes sense for. Everything else is opaque. */
export function isTextual(mediaType: string): boolean {
  const type = mediaType.split(";")[0].trim().toLowerCase();
  return (
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/ld+json" ||
    type.endsWith("+json") ||
    type.endsWith("+xml")
  );
}

/** The bounded excerpt for a set of bytes — empty for binary types. */
export function excerptOf(
  bytes: Uint8Array,
  mediaType: string,
  maxBytes: number = EXCERPT_MAX_BYTES,
): string {
  if (!isTextual(mediaType)) return "";
  return new TextDecoder().decode(bytes.subarray(0, maxBytes));
}

export type TaskOutcome =
  | {
      ok: true;
      content: string;
      attachments?: BrainArtifact[];
      summary?: string;
      /**
       * What produced this — a model id, a rule-engine version, anything the
       * brain wants on the record. The adapter copies it onto the Result as
       * `afp:producedBy`, so an auditor asking "what made this claim" does not
       * have to take the agent's word for it. ADR-0027 Decision 3 appends the
       * framing template's digest, so "what was this brain told" is answerable
       * too.
       */
      producedBy?: string;
    }
  | { ok: false; reason: string };

export interface Brain {
  /** Local name, e.g. "writer". The adapter maps it to an actor URL. */
  readonly name: string;
  readonly capabilities: readonly string[];
  /**
   * ADR-0027 Decision 2: media types this brain consumes as *bytes*. Anything
   * not listed arrives as a reference and an excerpt. Mirrors `afp:consumes`
   * on the actor document.
   */
  readonly consumes?: readonly string[];
  /**
   * Decision 4, restated as the port's shape: a brain returns an outcome, not
   * an activity. A brain's text cannot name an `afp:action`, a recipient or a
   * visibility class — the adapter builds every activity, and the action an
   * outcome causes is `policy[category]` under the pins.
   */
  handle(request: TaskRequest): Promise<TaskOutcome>;
}

/** True when this brain advertises `capability`. */
export function canHandle(brain: Brain, capability: string): boolean {
  return brain.capabilities.includes(capability);
}

/** True when this brain declared it consumes `mediaType` as bytes. */
export function consumesBytes(consumes: readonly string[] | undefined, mediaType: string): boolean {
  if (!consumes || consumes.length === 0) return false;
  const type = mediaType.split(";")[0].trim().toLowerCase();
  return consumes.some((declared) => declared.trim().toLowerCase() === type);
}

/**
 * ADR-0027: material the instance itself composed — a demo's brief, an
 * operator's question, a workflow's own intermediate output — handed to a
 * brain the process already owns, without crossing an inbox.
 *
 * This path is `delegator` provenance by construction and carries bytes: the
 * operator is not a stranger to their own instance. It exists so the direct
 * call sites in the demos state their provenance explicitly rather than
 * inheriting a default, and so a reader can tell them apart from the port's
 * admitting path in `inbox.materialize`, which is where Decision 2's bounds
 * actually bite.
 */
export function localAttachment(
  bytes: Uint8Array,
  mediaType: string,
  author: string,
): TaskAttachment {
  return {
    digest: "",
    mediaType,
    size: bytes.length,
    excerpt: excerptOf(bytes, mediaType),
    provenance: { source: "delegator", author },
    bytes,
  };
}

/** `delegator` provenance for an instance's own words. */
export function localProvenance(author: string): Provenance {
  return { source: "delegator", author };
}
