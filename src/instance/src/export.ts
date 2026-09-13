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

import { mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AfpInstance } from "./instance.ts";
import { AFP_CONTEXTS } from "./ap/documents.ts";
import type { JsonValue } from "./crypto/jcs.ts";
import { attachProof, digestOf } from "./crypto/proof.ts";
import { allKeyHistories, type KeyHistoryEntry } from "./crypto/keys.ts";
import { admittingGrant, summarize, type AgreementObject } from "./federation/grants.ts";
import { multibaseDecode } from "./crypto/multibase.ts";
import type { Visibility } from "./ap/activities.ts";

/**
 * A scoped export (ADR-0009 Decisions 4–5). Redaction is an export-time
 * transform — the record is never touched: an activity outside the scope's
 * threads is replaced in chain position by a digest-only stub, 1:1 and
 * deliberately so (a mechanism that hides scale is the launderer's feature
 * request), and an actor omitted entirely is a *declared* omission in the
 * manifest. Discretion is declared; deletion is detected.
 */
export interface ExportScope {
  /** Threads this bundle answers for; activities on other threads become stubs. */
  threads?: readonly string[];
  /**
   * ADR-0009 Decision 4 / ADR-0026 Decision 5 — the visibility floor. Every
   * activity *below* the floor becomes a stub. The floor is a custody
   * decision: "everything a regulator may see" is a statement about
   * disclosure class, not about which threads happened to be interesting.
   */
  visibilityAtLeast?: Visibility;
  /**
   * The agreement-grant scope: the bundle a counterparty is entitled to,
   * produced without a human judging each thread. Every activity the named
   * agreement's grants would not have admitted becomes a stub — the same
   * `admittingGrant` the boundary gate runs, so what a peer may read back is
   * exactly what it could have been sent.
   */
  agreement?: AgreementObject;
  /** Agents whose whole chain is withheld — declared, never silently absent. */
  omitActors?: readonly string[];
}

/**
 * The disclosure classes, most open first (07 § Four visibility classes). A
 * floor admits its own class and everything more open than it.
 */
const VISIBILITY_ORDER: Visibility[] = ["public", "hub", "parties", "internal"];

function atOrAboveFloor(visibility: string, floor: Visibility): boolean {
  const rank = VISIBILITY_ORDER.indexOf(visibility as Visibility);
  // An unknown or absent class is never treated as clearing a floor: the
  // export's job here is to withhold on doubt, not to guess a class.
  return rank !== -1 && rank <= VISIBILITY_ORDER.indexOf(floor);
}

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
  /**
   * ADR-0012 Decision 1: the hub's own signing-key history. Optional so a
   * federated hub that exports separately can decline to hand it over —
   * where it is absent the hub's chain resolves as it always did, against the
   * current document.
   */
  keyHistory?(): KeyHistoryEntry[];
}

export interface ReceivedSource {
  receivedActivities(): { digest: string; fromInstance: string; activity: { [key: string]: JsonValue } }[];
}

/** ADR-0012 Decision 3: `afp:retentionDuty` — present only when a caller declares one. */
export interface RetentionDuty {
  horizon: string; // e.g. "P5Y"
  basis: string; // e.g. "EU AI Act Art. 12"
}

/** One `afp:anchors` entry — an external anchor for one actor's chain head. */
export interface Anchor {
  actor: string;
  head: string;
  instant: string;
  anchorRef: string;
}

/** The two ADR-0012 Decision 3 fields — both optional, both off unless supplied. */
export interface ExportExtras {
  retentionDuty?: RetentionDuty;
  anchors?: readonly Anchor[];
}

export function exportBundle(
  instance: AfpInstance,
  dir: string,
  hubs: ExportableHub[] = [],
  scope?: ExportScope,
  received?: ReceivedSource,
  extras?: ExportExtras,
): ExportSummary {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "actors"), { recursive: true });
  mkdirSync(join(dir, "outbox"), { recursive: true });
  mkdirSync(join(dir, "artifacts"), { recursive: true });

  // ADR-0012 Decision 4: afp:members — every file path this export writes,
  // relative to the bundle root, MANIFEST.json itself excluded. Tracked as
  // paths are written rather than reconstructed from a directory listing
  // after the fact, so the declaration can never drift from what actually
  // landed on disk.
  const members: string[] = [];

  writeJson(join(dir, "instance.jsonld"), instance.instanceDocument());
  members.push("instance.jsonld");
  writeJson(join(dir, "roster.jsonld"), instance.rosterDocument() as unknown as JsonValue);
  members.push("roster.jsonld");
  // ADR-0033 Decision 2: the policy travels with the record it governs — a
  // regulator asking "under what retention duty, what thread layout, which
  // models" reads one file.
  const policyDoc = instance.policyDocument();
  writeJson(join(dir, "policy.jsonld"), policyDoc as unknown as JsonValue);
  members.push("policy.jsonld");

  let activities = 0;
  const actorNames: string[] = [];

  // Exactly one scope predicate applies, chosen by which field the caller
  // set. Each one answers the same question — may this activity be disclosed
  // in this bundle — so everything downstream (the stub mechanism, the
  // ADR-0010 D5 pins guard, the received-activity filter) is unchanged by
  // adding a scope kind.
  const inScope = (activity: { [key: string]: JsonValue }): boolean => {
    if (!scope) return true;
    if (scope.threads !== undefined) return scope.threads.includes(String(activity.context ?? ""));
    if (scope.visibilityAtLeast !== undefined) {
      return atOrAboveFloor(String(activity["afp:visibility"] ?? ""), scope.visibilityAtLeast);
    }
    if (scope.agreement !== undefined) return admittingGrant(scope.agreement, summarize(activity)) !== null;
    return true;
  };

  /**
   * ADR-0010 Decision 5: pins are frame, not content. An export MUST NOT
   * withhold a thread's task-bearing activity while disclosing an answer on
   * that same thread — the answer would replay clean with the rules it was
   * judged under missing, and every pin, synthesizer, sufficiency and leg
   * check on it silently skipped.
   *
   * Today's scope grammar cannot produce that bundle: it scopes by *thread*,
   * so a thread is wholly in or wholly out. The guard is written against the
   * shape of the rule rather than the shape of today's scope, so the
   * visibility-floor and agreement-grant scoping ADR-0009 specifies inherits
   * the invariant instead of rediscovering the defect.
   *
   * Refusing rather than auto-disclosing is deliberate. A task activity
   * carries `content` and attachments, which may be exactly what the scope
   * was protecting; widening it is a decision the exporter must take with
   * knowledge the bundle does not contain.
   */
  const assertPinsTravelWithAnswers = (all: { [key: string]: JsonValue }[]): void => {
    if (!scope) return;
    const withheldTaskThreads = new Set<string>();
    const disclosedAnswerThreads = new Set<string>();
    for (const activity of all) {
      const thread = String(activity.context ?? "");
      const object = activity.object as { [key: string]: JsonValue } | undefined;
      const objectType = object && typeof object === "object" && !Array.isArray(object) ? String(object.type ?? "") : "";
      const isTask = (activity.type === "Offer" || activity.type === "Announce") && objectType === "afp:Task";
      const isAnswer = objectType === "afp:Synthesis" || typeof activity["afp:actsOn"] === "string";
      if (isTask && !inScope(activity)) withheldTaskThreads.add(thread);
      if (isAnswer && inScope(activity)) disclosedAnswerThreads.add(thread);
    }
    for (const thread of disclosedAnswerThreads) {
      if (withheldTaskThreads.has(thread)) {
        throw new Error(
          `export scope discloses an answer on ${thread} while withholding that thread's ` +
            `pins — widen the scope to include its task-bearing activity, or drop the thread ` +
            `(ADR-0010 Decision 5)`,
        );
      }
    }
  };

  const writeOutbox = (file: string, actorUrl: string): void => {
    const entries = instance.outbox.byActor(actorUrl);
    activities += entries.length;
    // ADR-0009 Decision 4: out-of-scope activities are replaced in chain
    // position by digest-only stubs — the following activity's afp:prevActivity
    // still resolves, contiguity is preserved, content is not disclosed.
    const items = entries.map((entry) =>
      inScope(entry.activity)
        ? entry.activity
        : ({ type: "afp:Redacted", "afp:digest": digestOf(entry.activity), "afp:visibility": "out-of-scope" } as {
            [key: string]: JsonValue;
          }),
    );
    writeJson(join(dir, "outbox", `${file}.jsonld`), {
      "@context": AFP_CONTEXTS,
      id: `${actorUrl}/outbox`,
      type: "OrderedCollection",
      attributedTo: actorUrl,
      totalItems: items.length,
      orderedItems: items,
    });
    members.push(`outbox/${file}.jsonld`);
  };

  // The instance's own outbox carries the Vouch/Disown trail the roster is
  // derived from. Without it a reader can verify *who* is on the roster but not
  // *how they got there* (01 § Vouch / disown).
  // ADR-0010 Decision 5, before a single byte is written: a bundle that would
  // disclose an answer without its pins is refused, not emitted and explained.
  assertPinsTravelWithAnswers([
    ...instance.outbox.byActor(String(instance.instanceDocument().id)).map((e) => e.activity),
    ...instance.specs.flatMap((spec) => instance.outbox.byActor(instance.actorId(spec.name)).map((e) => e.activity)),
    ...hubs.flatMap((hub) => hub.outbox.byActor(hub.actorId).map((e) => e.activity)),
    // Received bytes count as pin carriers too: a delegated thread's opening
    // Offer is the counterparty's, and under today's thread grammar it shares
    // the answer's fate — but the guard is written against the rule, not the
    // grammar, so a future scope that could split them inherits the refusal.
    ...(received?.receivedActivities().map((item) => item.activity) ?? []),
  ]);

  writeOutbox("instance", String(instance.instanceDocument().id));

  const omitted = new Set(scope?.omitActors ?? []);
  for (const spec of instance.specs) {
    if (omitted.has(spec.name)) continue; // declared in the manifest, not silently absent
    actorNames.push(spec.name);
    writeJson(join(dir, "actors", `${spec.name}.jsonld`), instance.agentDocument(spec.name));
    members.push(`actors/${spec.name}.jsonld`);
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
    members.push(`actors/${name}.jsonld`);
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
    members.push(`outbox/${name}.jsonld`);
  }

  // ADR-0009 Decision 3: what this instance received across the boundary,
  // verbatim — the bytes the joint replay checks against the sender's export.
  if (received) {
    // The same scope that stubs our own outboxes filters what we received:
    // a subject-scoped bundle that redacted every local activity on another
    // client's thread while shipping the counterparty's activities on that
    // same thread verbatim would leak through the back door what the stubs
    // closed at the front. Dropped rather than stubbed — received.jsonld is a
    // flat evidence collection, not a chain, so an absence leaves no hole for
    // the chain checks to misread, and ADR-0009's cross-check runs from
    // present-received to the sender's bundle, never the reverse.
    const items = received.receivedActivities().filter((item) => inScope(item.activity));
    if (items.length) {
      writeJson(join(dir, "received.jsonld"), {
        "@context": AFP_CONTEXTS,
        id: `${String(instance.instanceDocument().id)}/received`,
        type: "OrderedCollection",
        totalItems: items.length,
        orderedItems: items.map((item) => ({ "afp:from": item.fromInstance, "afp:activity": item.activity })),
      });
      members.push("received.jsonld");
    }
  }

  const artifacts = instance.artifacts.all();
  for (const ref of artifacts) {
    // Raw bytes on purpose: the verifier's job is to notice when they no longer
    // match their digest, so the export must not quietly refuse to carry them.
    const bytes = instance.artifacts.getRaw(ref.digest);
    if (bytes) {
      const file = ref.digest.replace(":", "-");
      writeFileSync(join(dir, "artifacts", file), bytes);
      members.push(`artifacts/${file}`);
    }
  }

  // ADR-0012 Decision 1: afp:keyHistory — every key that signed anything in
  // this bundle, oldest first: the instance actor, each in-scope agent, and
  // each hub whose outbox travels here. A hub signs its own activities, so
  // omitting its keys would leave the one chain in the bundle still resolvable
  // only against a current document — the exact gap this ADR closes.
  const keyHistoryEntries: JsonValue[] = [];
  const pushHistoryEntry = (controller: string, entry: KeyHistoryEntry): void => {
    keyHistoryEntries.push({
      "afp:actor": controller,
      id: entry.keyId,
      publicKeyMultibase: entry.publicKeyMultibase,
      ...(entry.validFrom !== undefined ? { "afp:validFrom": entry.validFrom } : {}),
      ...(entry.validUntil !== undefined ? { "afp:validUntil": entry.validUntil } : {}),
      ...(entry.retiredBy !== undefined ? { "afp:retiredBy": entry.retiredBy } : {}),
    });
  };
  // ADR-0026 Decision 3: every key that ever signed anything for this actor —
  // proof, hub-scoped, transport — not just the proof key.
  const collectKeyHistory = (name: string, controller: string): void => {
    for (const entry of allKeyHistories(instance.config.keyDir, name, controller)) {
      pushHistoryEntry(controller, entry);
    }
  };
  collectKeyHistory("instance", String(instance.instanceDocument().id));
  for (const spec of instance.specs) {
    if (omitted.has(spec.name)) continue; // no chain in the bundle, so no history to vouch for
    collectKeyHistory(spec.name, instance.actorId(spec.name));
  }
  for (const hub of hubs) {
    for (const entry of hub.keyHistory?.() ?? []) pushHistoryEntry(hub.actorId, entry);
  }

  // ADR-0033 Decision 2: when the policy declares a retention duty or anchors
  // and the caller passes none in `extras`, the manifest's take comes from
  // the policy — "stated here at the source". When both exist they must
  // agree, or this throws: a bundle that says two things about the same
  // obligation is the two-story failure this repo refuses everywhere.
  const policyRetentionDuty = instance.policy.retentionDuty;
  if (extras?.retentionDuty && policyRetentionDuty) {
    if (
      extras.retentionDuty.horizon !== policyRetentionDuty.horizon ||
      extras.retentionDuty.basis !== policyRetentionDuty.basis
    ) {
      throw new Error(
        `export: afp:retentionDuty disagrees between extras (${JSON.stringify(extras.retentionDuty)}) and ` +
          `the policy (${JSON.stringify(policyRetentionDuty)}) — a bundle must not say two things about its own retention duty`,
      );
    }
  }
  const resolvedRetentionDuty = extras?.retentionDuty ?? policyRetentionDuty;

  const sortAnchors = (anchors: readonly Anchor[]): Anchor[] => [...anchors].sort((a, b) => a.actor.localeCompare(b.actor));
  const policyAnchors = instance.policy.anchors;
  if (extras?.anchors && extras.anchors.length > 0 && policyAnchors && policyAnchors.length > 0) {
    if (JSON.stringify(sortAnchors(extras.anchors)) !== JSON.stringify(sortAnchors(policyAnchors))) {
      throw new Error(
        `export: afp:anchors disagrees between extras and the policy — a bundle must not say two things about its own anchors`,
      );
    }
  }
  const resolvedAnchors = extras?.anchors && extras.anchors.length > 0 ? extras.anchors : policyAnchors;

  const manifest: { [key: string]: JsonValue } = {
    "@context": AFP_CONTEXTS,
    format: "afp-export/1",
    instance: String(instance.instanceDocument().id),
    exportedAt: new Date().toISOString(),
    actors: actorNames,
    activities,
    artifacts: artifacts.length,
    cryptosuite: "eddsa-jcs-2022",
    "afp:keyHistory": keyHistoryEntries,
    "afp:members": [...members].sort(),
    // ADR-0033 Decision 2: the policy document this bundle was produced under.
    "afp:policy": { id: String(policyDoc.id), "afp:digest": digestOf(policyDoc as unknown as JsonValue) },
    ...(scope
      ? {
          // The manifest declares which scope produced this bundle, so a
          // replay can hold the bundle to the rule it claims rather than
          // inferring one from what happens to be present.
          "afp:exportScope": {
            ...(scope.threads !== undefined ? { "afp:threads": [...scope.threads] } : {}),
            ...(scope.visibilityAtLeast !== undefined
              ? { "afp:visibilityAtLeast": scope.visibilityAtLeast }
              : {}),
            ...(scope.agreement !== undefined ? { "afp:agreement": digestOf(scope.agreement) } : {}),
            "afp:omittedActors": [...(scope.omitActors ?? [])].map((name) => instance.actorId(name)),
          },
        }
      : {}),
    ...(resolvedRetentionDuty
      ? {
          "afp:retentionDuty": {
            "afp:horizon": resolvedRetentionDuty.horizon,
            "afp:basis": resolvedRetentionDuty.basis,
          },
        }
      : {}),
    ...(resolvedAnchors && resolvedAnchors.length > 0
      ? {
          "afp:anchors": resolvedAnchors.map((anchor) => ({
            "afp:actor": anchor.actor,
            "afp:head": anchor.head,
            "afp:instant": anchor.instant,
            "afp:anchorRef": anchor.anchorRef,
          })),
        }
      : {}),
  };

  // ADR-0012 Decision 1: the manifest becomes a signed document — the same
  // DataIntegrityProof and JCS canonicalization as everything else, from the
  // instance's *current* key, so the export's self-description stops being
  // the one part of a bundle anybody could edit freely.
  writeJson(join(dir, "MANIFEST.json"), attachProof(manifest, { signer: instance.signer("@instance") }));

  // ADR-0026 Decision 4: the last thing before the bundle is handed over —
  // nothing private may leave with it. Cheap, and the one accident an
  // operator cannot undo, because a bundle is the artefact that goes to a
  // regulator, a counterparty or a public archive.
  refusePrivateMaterial(dir, instance.config.keyPassphraseFile);

  return { dir, actors: actorNames.length, activities, artifacts: artifacts.length };
}

/** PEM headers for private material. Long literals; no false-positive risk. */
const PRIVATE_PEM_MARKERS = [
  "-----BEGIN PRIVATE KEY-----",
  "-----BEGIN RSA PRIVATE KEY-----",
  "-----BEGIN EC PRIVATE KEY-----",
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "-----BEGIN ENCRYPTED PRIVATE KEY-----",
];

/** Every base58btc multibase token long enough to be key or signature material. */
const MULTIBASE_TOKEN = /z[1-9A-HJ-NP-Za-km-z]{40,}/g;

/** The multicodec prefix of an Ed25519 *private* Multikey: varint 0x1300 → 0x80 0x26. */
const ED25519_PRIVATE_PREFIX = [0x80, 0x26];

/**
 * Is this multibase token an Ed25519 private key?
 *
 * Decided by **decoding**, not by matching the `z3we…` prefix as text. Every
 * `proofValue` in a bundle is `z` + base58btc of a 64-byte signature, so a
 * substring test for the private prefix hits one by chance roughly once in
 * 200k proofs — which is not "rare enough to ignore" when the consequence is
 * an export refusing to write. It was found exactly that way: an intermittent
 * gate failure on a bundle whose hub outbox happened to contain the four
 * characters inside a legitimate signature.
 */
function isPrivateMultikey(token: string): boolean {
  let bytes: Uint8Array;
  try {
    bytes = multibaseDecode(token);
  } catch {
    return false; // not decodable: not key material this function can claim
  }
  return (
    bytes.length === ED25519_PRIVATE_PREFIX.length + 32 &&
    bytes[0] === ED25519_PRIVATE_PREFIX[0] &&
    bytes[1] === ED25519_PRIVATE_PREFIX[1]
  );
}

/**
 * Scan every file in a written bundle for private key material and throw
 * rather than let it be handed over. Throws *after* the write so the caller
 * sees the offending directory and can inspect it; the refusal is the point,
 * not tidiness.
 */
export function refusePrivateMaterial(dir: string, passphraseFile?: string): void {
  const passphrase = passphraseFile && existsSync(passphraseFile)
    ? readFileSync(passphraseFile, "utf8").trim()
    : "";

  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      const bytes = readFileSync(path);
      // Artifacts are arbitrary bytes; a marker check over them is still
      // right — an operator attaching their own key file to a Task is exactly
      // the accident this catches.
      const text = bytes.toString("utf8");
      for (const marker of PRIVATE_PEM_MARKERS) {
        if (text.includes(marker)) {
          throw new Error(
            `export refused: ${path} contains private key material (${marker}) — ` +
              `a bundle is what leaves the operator's hands and must carry public halves only`,
          );
        }
      }
      for (const token of text.match(MULTIBASE_TOKEN) ?? []) {
        if (isPrivateMultikey(token)) {
          throw new Error(
            `export refused: ${path} carries an Ed25519 private Multikey (${token.slice(0, 12)}…) — ` +
              `a bundle is what leaves the operator's hands and must carry public halves only`,
          );
        }
      }
      if (passphrase.length > 0 && text.includes(passphrase)) {
        throw new Error(`export refused: ${path} contains the key passphrase`);
      }
    }
  };

  walk(dir);
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
