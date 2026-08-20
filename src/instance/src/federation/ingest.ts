/**
 * Boundary ingestion (ADR-0008 Decision 5): an agreement authenticates the
 * counterparty; it does not sanitize their output.
 *
 * A cross-boundary `Result` is third-party content twice over — it ran
 * attacker-controllable instructions in someone else's environment (04's
 * sandbox duty), and its prose is a stranger's text (03's port-ingestion
 * duty). Both duties are enforced here, at the receiving port, before
 * anything downstream trusts an attachment or reasons over the words.
 *
 * "We have an agreement with them" and "their output is safe to execute"
 * are unrelated claims.
 */

import { createHash } from "node:crypto";
import type { JsonValue } from "../crypto/jcs.ts";

export interface SandboxVerdict {
  ok: boolean;
  reason: string;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/** Magic-byte sniffing for the types the record commonly carries — a declared
 * content type that the bytes contradict is refused, not corrected. */
const MAGIC: [string, (bytes: Uint8Array) => boolean][] = [
  ["application/pdf", (b) => b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46],
  ["image/png", (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47],
  ["application/zip", (b) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b],
];

/**
 * 04's sandbox duty, mechanized: checksum verification against the declared
 * digest, size limit, content-type sniffing. Isolated *execution* of fetched
 * content is the operator's runtime concern; what this function guarantees is
 * that nothing downstream sees bytes that lied about what they are.
 */
export function sandboxAttachment(
  bytes: Uint8Array,
  declared: { digest: string; mediaType: string },
  maxBytes: number = DEFAULT_MAX_BYTES,
): SandboxVerdict {
  if (bytes.length > maxBytes) {
    return { ok: false, reason: `attachment is ${bytes.length} bytes, limit ${maxBytes}` };
  }
  const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (actual !== declared.digest) {
    return { ok: false, reason: `bytes hash to ${actual}, attachment declares ${declared.digest}` };
  }
  const sniff = MAGIC.find(([type]) => declared.mediaType.startsWith(type));
  if (sniff && !sniff[1](bytes)) {
    return { ok: false, reason: `bytes do not look like the declared ${declared.mediaType}` };
  }
  return { ok: true, reason: "" };
}

/**
 * 03's port-ingestion duty at the boundary: what a downstream brain acts on
 * is the receiving port's own bounded summary — the counterparty's prose is
 * evidence the record carries, never instructions. The summary is built from
 * structural fields only, hard-capped, and never includes `content`.
 */
export function summarizeForeignResult(activity: { [key: string]: JsonValue }, maxLength = 280): string {
  const object =
    activity.object && typeof activity.object === "object" && !Array.isArray(activity.object)
      ? (activity.object as { [key: string]: JsonValue })
      : {};
  const attachments = Array.isArray(object.attachment) ? (object.attachment as JsonValue[]).length : 0;
  const parts = [
    `foreign ${String(object.type ?? activity.type ?? "activity")}`,
    `from ${String(activity.actor ?? "<unknown>").split("/").pop()}`,
    `correlation ${String(object["afp:correlationId"] ?? "<none>")}`,
    `${attachments} attachment(s)`,
  ];
  return parts.join(", ").slice(0, maxLength);
}
