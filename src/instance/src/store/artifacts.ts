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

export interface ArtifactRef {
  /** `sha256:<hex>` */
  digest: string;
  mediaType: string;
  size: number;
  /** Where the bytes are served from. */
  href: string;
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

  put(bytes: Uint8Array, mediaType: string, now = new Date()): ArtifactRef {
    const digest = `sha256:${sha256Hex(bytes)}`;
    const path = this.pathFor(digest);
    if (!existsSync(path)) writeFileSync(path, bytes);

    this.db
      .prepare(
        `INSERT INTO artifacts (digest, media_type, size, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (digest) DO NOTHING`,
      )
      .run(digest, mediaType, bytes.length, now.toISOString());

    return this.ref(digest, mediaType, bytes.length);
  }

  private ref(digest: string, mediaType: string, size: number): ArtifactRef {
    return {
      digest,
      mediaType,
      size,
      href: `${this.origin}/artifacts/${digest.replace(":", "-")}`,
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
    return this.ref(String(row.digest), String(row.media_type), Number(row.size));
  }

  all(): ArtifactRef[] {
    const rows = this.db
      .prepare("SELECT * FROM artifacts ORDER BY digest")
      .all() as Record<string, unknown>[];
    return rows.map((row) => this.ref(String(row.digest), String(row.media_type), Number(row.size)));
  }

  /** An AS2 `Link` carrying the mandatory hash-addressing properties. */
  static toLink(ref: ArtifactRef): Record<string, string | number> {
    return {
      type: "Link",
      href: ref.href,
      mediaType: ref.mediaType,
      "afp:digest": ref.digest,
      "afp:size": ref.size,
    };
  }
}
