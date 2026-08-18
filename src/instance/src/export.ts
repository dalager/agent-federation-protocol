/**
 * The export bundle — what you hand to someone who was not there.
 *
 * Everything a third party needs to check the record, and nothing else: no
 * private keys, no database, no instance access. Actor documents are included
 * because they are `public` anyway and carry the verification keys; the outboxes
 * carry the signed activities; artifacts travel as their own digests.
 *
 * Layout:
 *   MANIFEST.json          what this bundle contains
 *   instance.jsonld        the instance actor
 *   roster.jsonld          the signed roster
 *   actors/<name>.jsonld   agent actors, each with its Multikey
 *   outbox/<name>.jsonld   OrderedCollection, in chain order
 *   artifacts/sha256-<hex> raw bytes, named by digest
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AfpInstance } from "./instance.ts";
import { AFP_CONTEXTS } from "./ap/documents.ts";
import type { JsonValue } from "./crypto/jcs.ts";

export interface ExportSummary {
  dir: string;
  actors: number;
  activities: number;
  artifacts: number;
}

/** What the export needs from a hub — the actor-shaped surface only, no Hub import. */
export interface ExportableHub {
  actorId: string;
  actorDocument(): { [key: string]: JsonValue };
  outbox: { byActor(actorUrl: string): { activity: { [key: string]: JsonValue } }[] };
}

export function exportBundle(instance: AfpInstance, dir: string, hubs: ExportableHub[] = []): ExportSummary {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "actors"), { recursive: true });
  mkdirSync(join(dir, "outbox"), { recursive: true });
  mkdirSync(join(dir, "artifacts"), { recursive: true });

  writeJson(join(dir, "instance.jsonld"), instance.instanceDocument());
  writeJson(join(dir, "roster.jsonld"), instance.rosterDocument() as unknown as JsonValue);

  let activities = 0;
  const actorNames: string[] = [];

  const writeOutbox = (file: string, actorUrl: string): void => {
    const entries = instance.outbox.byActor(actorUrl);
    activities += entries.length;
    writeJson(join(dir, "outbox", `${file}.jsonld`), {
      "@context": AFP_CONTEXTS,
      id: `${actorUrl}/outbox`,
      type: "OrderedCollection",
      attributedTo: actorUrl,
      totalItems: entries.length,
      orderedItems: entries.map((entry) => entry.activity),
    });
  };

  // The instance's own outbox carries the Vouch/Disown trail the roster is
  // derived from. Without it a reader can verify *who* is on the roster but not
  // *how they got there* (01 § Vouch / disown).
  writeOutbox("instance", String(instance.instanceDocument().id));

  for (const spec of instance.specs) {
    actorNames.push(spec.name);
    writeJson(join(dir, "actors", `${spec.name}.jsonld`), instance.agentDocument(spec.name));
    writeOutbox(spec.name, instance.actorId(spec.name));
  }

  // Hub actors (P2): same shape as any agent — a document in actors/ and an
  // OrderedCollection outbox. A hub on the record is vouched onto the roster
  // like anyone else, so nothing here is a special case for the verifier.
  for (const hub of hubs) {
    // Prefixed so a hub whose id segment matches an agent name can never
    // overwrite that agent's actors/ or outbox/ file. The verifier matches
    // actors by URL, not by filename, so the prefix is purely a namespace.
    const name = `hub-${hub.actorId.split("/").pop() ?? hub.actorId}`;
    actorNames.push(name);
    writeJson(join(dir, "actors", `${name}.jsonld`), hub.actorDocument());
    const entries = hub.outbox.byActor(hub.actorId);
    activities += entries.length;
    writeJson(join(dir, "outbox", `${name}.jsonld`), {
      "@context": AFP_CONTEXTS,
      id: `${hub.actorId}/outbox`,
      type: "OrderedCollection",
      attributedTo: hub.actorId,
      totalItems: entries.length,
      orderedItems: entries.map((entry) => entry.activity),
    });
  }

  const artifacts = instance.artifacts.all();
  for (const ref of artifacts) {
    // Raw bytes on purpose: the verifier's job is to notice when they no longer
    // match their digest, so the export must not quietly refuse to carry them.
    const bytes = instance.artifacts.getRaw(ref.digest);
    if (bytes) writeFileSync(join(dir, "artifacts", ref.digest.replace(":", "-")), bytes);
  }

  writeJson(join(dir, "MANIFEST.json"), {
    format: "afp-export/1",
    instance: String(instance.instanceDocument().id),
    exportedAt: new Date().toISOString(),
    actors: actorNames,
    activities,
    artifacts: artifacts.length,
    cryptosuite: "eddsa-jcs-2022",
  });

  return { dir, actors: actorNames.length, activities, artifacts: artifacts.length };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
