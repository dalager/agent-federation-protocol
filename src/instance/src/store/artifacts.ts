/**
 * Hash-addressed artifact store.
 *
 * Content addressing needs no database: the filename *is* the digest. The index
 * table only carries media type and size so the HTTP surface can answer without
 * sniffing. `afp:digest` is mandatory on every attachment and a fetcher that
 * gets non-matching bytes MUST discard them (07 § Artifacts).
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db.ts";
import { sha256Hex } from "../crypto/proof.ts";
import { sandboxAttachment } from "../federation/ingest.ts";

export interface ArtifactRef {
  /** `sha256:<hex>` */
  digest: string;
  mediaType: string;
  size: number;
  /** Where the bytes are served from. */
  href: string;
  /** Where evidence obtained outside AFP came from (07 § Artifacts). */
  sourceUrl?: string;
  fetchedAt?: string;
}

/** Provenance for evidence that entered from outside AFP. */
export interface ExternalSource {
  sourceUrl: string;
  fetchedAt: string;
}

/**
 * ADR-0027 Decision 1: what a port throws when bytes contradict what they
 * claim to be. Distinct from a generic Error so a caller at a boundary can
 * turn it into a refusal on the record instead of a crash.
 */
export class IngestionRefused extends Error {
  constructor(reason: string) {
    super(`ingestion refused: ${reason}`);
    this.name = "IngestionRefused";
  }
}

export class Artifacts {
  private readonly db: Db;
  private readonly dir: string;
  private readonly origin: string;

  constructor(db: Db, dir: string, origin: string) {
    this.db = db;
    this.dir = dir;
    this.origin = origin;
    mkdirSync(this.dir, { recursive: true });
  }

  private pathFor(digest: string): string {
    return join(this.dir, digest.replace(":", "-"));
  }

  /**
   * Store bytes under their own digest.
   *
   * `source` records where evidence came from when it entered from outside AFP —
   * a fetched page, a client submission, an operator's brief. Without it the
   * trail stops at "the agent said so" (07 § Artifacts).
   *
   * ADR-0027 Decision 1: this is the door every artifact comes through — a
   * local Task's attachment, a brain's output, a counterparty's Result — so
   * the ingestion duty is enforced here rather than only at the federation
   * boundary. The digest half is free (we compute it); what this adds is the
   * size cap and the declared-type-versus-bytes check, and a contradiction is
   * refused rather than corrected.
   */
  put(
    bytes: Uint8Array,
    mediaType: string,
    now = new Date(),
    source?: ExternalSource,
  ): ArtifactRef {
    const digest = `sha256:${sha256Hex(bytes)}`;
    const verdict = sandboxAttachment(bytes, { digest, mediaType });
    if (!verdict.ok) throw new IngestionRefused(verdict.reason);
    const path = this.pathFor(digest);
    if (!existsSync(path)) writeFileSync(path, bytes);

    this.db
      .prepare(
        `INSERT INTO artifacts (digest, media_type, size, created_at, source_url, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (digest) DO NOTHING`,
      )
      .run(
        digest,
        mediaType,
        bytes.length,
        now.toISOString(),
        source?.sourceUrl ?? null,
        source?.fetchedAt ?? null,
      );

    return this.ref(digest, mediaType, bytes.length, source);
  }

  private ref(
    digest: string,
    mediaType: string,
    size: number,
    source?: ExternalSource,
  ): ArtifactRef {
    return {
      digest,
      mediaType,
      size,
      href: `${this.origin}/artifacts/${digest.replace(":", "-")}`,
      ...(source ? { sourceUrl: source.sourceUrl, fetchedAt: source.fetchedAt } : {}),
    };
  }

  /**
   * Read bytes back, checking them against the digest they are stored under.
   *
   * Returns null when the artifact is missing *or* when the bytes on disk no
   * longer hash to their own name — a tampered artifact is indistinguishable
   * from an absent one as far as any caller is concerned.
   */
  get(digest: string): Uint8Array | null {
    const path = this.pathFor(digest);
    if (!existsSync(path)) return null;
    const bytes = new Uint8Array(readFileSync(path));
    return `sha256:${sha256Hex(bytes)}` === digest ? bytes : null;
  }

  /** Raw bytes, whatever they now hash to — used only by the export writer. */
  getRaw(digest: string): Uint8Array | null {
    const path = this.pathFor(digest);
    return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
  }

  lookup(digest: string): ArtifactRef | null {
    const row = this.db
      .prepare("SELECT * FROM artifacts WHERE digest = ?")
      .get(digest) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.ref(String(row.digest), String(row.media_type), Number(row.size), sourceOf(row));
  }

  all(): ArtifactRef[] {
    const rows = this.db
      .prepare("SELECT * FROM artifacts ORDER BY digest")
      .all() as Record<string, unknown>[];
    return rows.map((row) =>
      this.ref(String(row.digest), String(row.media_type), Number(row.size), sourceOf(row)),
    );
  }

  /** An AS2 `Link` carrying the mandatory hash-addressing properties. */
  static toLink(ref: ArtifactRef): Record<string, string | number> {
    const link: Record<string, string | number> = {
      type: "Link",
      href: ref.href,
      mediaType: ref.mediaType,
      "afp:digest": ref.digest,
      "afp:size": ref.size,
    };
    if (ref.sourceUrl) link["afp:sourceUrl"] = ref.sourceUrl;
    if (ref.fetchedAt) link["afp:fetchedAt"] = ref.fetchedAt;
    return link;
  }
}

function sourceOf(row: Record<string, unknown>): ExternalSource | undefined {
  return row.source_url
    ? { sourceUrl: String(row.source_url), fetchedAt: String(row.fetched_at ?? "") }
    : undefined;
}
