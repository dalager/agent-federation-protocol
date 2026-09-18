/**
 * Actor documents and the signed roster.
 *
 * The instance actor and roster are published at P1 even though no peer reads
 * them yet: `afp:keyCustody` is declared *on a roster entry*, so without a
 * roster there is nowhere to state how an agent is wired, and adding
 * `afp:operatedBy` to already-published actor documents later would change
 * their trust semantics (ADR-0001).
 */

import type { JsonValue } from "../crypto/jcs.ts";
import { attachProof, DATA_INTEGRITY_CONTEXT, type SignedDocument } from "../crypto/proof.ts";
import type { KeyPair } from "../crypto/keys.ts";
import type { Custody, Signer } from "../crypto/signer.ts";

export const AS2_CONTEXT = "https://www.w3.org/ns/activitystreams";
export const AFP_CONTEXT = "https://dalager.github.io/agent-federation-protocol/ns/v3.jsonld";

/** Every AFP document carries the same three contexts. */
export const AFP_CONTEXTS: JsonValue = [AS2_CONTEXT, AFP_CONTEXT, DATA_INTEGRITY_CONTEXT];

export type KeyCustody = "self" | "instance";

export interface AgentSpec {
  /** Local name; the actor URL is `${origin}/agents/${name}` unless `url` overrides it. */
  name: string;
  /**
   * Exact actor URL, when it is not the default `/agents/<name>` shape — a
   * vouched hub actor under `/hubs/`, for instance. Roster entries derived
   * from the Vouch trail carry the URL the Vouch named (01 § Vouch / disown).
   */
  url?: string;
  capabilities: readonly string[];
  /**
   * ADR-0027 Decision 2: media types this agent consumes as *bytes*. Absent or
   * empty means the port hands it references and bounded excerpts only. An
   * exception to the safe default has to be declared, and the declaration is
   * published — an auditor can see which agents were given raw material.
   */
  consumes?: readonly string[];
  keyCustody: KeyCustody;
  since: string;
}

export function instanceActorId(origin: string): string {
  return `${origin}/actor`;
}

export function agentActorId(origin: string, name: string): string {
  return `${origin}/agents/${name}`;
}

/**
 * The instance actor: an AS2 `Application` also typed `afp:Instance`.
 *
 * Actor documents are necessarily `public` — signature verification requires a
 * key fetch (07 § Four visibility classes).
 */
export function instanceActor(
  origin: string,
  operator: string,
  name: string,
  key: KeyPair,
  /** ADR-0017 Decision 4 (R1): HTTP-signature key, published under `authentication`. */
  transportKey: KeyPair,
  /**
   * ADR-0035 Decision 2: `remote-issued` custody's root key(s) — never held
   * locally, so the instance never signs with one of these directly, but
   * their public halves publish here so a stranger can resolve an
   * `afp:KeyDelegation`'s own signature against a key this actor document
   * named *before* any theft, rather than against a value the delegation
   * activity merely asserts about itself (the circularity ADR-0026 Decision
   * 1 already closed for the manifest signature).
   */
  rootKeys: readonly PublishedKey[] = [],
): { [key: string]: JsonValue } {
  const id = instanceActorId(origin);
  return {
    "@context": AFP_CONTEXTS,
    id,
    type: ["Application", "afp:Instance"],
    name,
    // R4: the literal WebFinger username for the instance actor.
    preferredUsername: "instance",
    "afp:operator": operator,
    // `<id>/inbox` and `<id>/outbox`, matching the routes the server actually
    // mounts — an actor document must never advertise a URL that is not
    // served (ADR-0017 Decision 3).
    inbox: `${id}/inbox`,
    outbox: `${id}/outbox`,
    // R5: derived collection replaying this actor's own Follow/Undo trail.
    following: `${id}/following`,
    "afp:roster": `${origin}/roster`,
    "afp:policy": `${origin}/afp/policy`,
    "afp:visibility": "public",
    assertionMethod: [multikey(key), ...rootKeys.map(multikey)],
    authentication: [multikey(transportKey)],
  };
}

export function agentActor(
  origin: string,
  spec: AgentSpec,
  key: PublishedKey,
  /**
   * Hub-scoped verification methods (ADR-0002 Decision 4), published alongside
   * the P1 `assertionMethod` key rather than replacing it — keys cannot be
   * backfilled onto an already-published actor document.
   */
  hubKeys: readonly PublishedKey[] = [],
  /** ADR-0017 Decision 4 (R1): HTTP-signature key, published under `authentication`. */
  transportKey?: PublishedKey,
): { [key: string]: JsonValue } {
  const id = agentActorId(origin, spec.name);
  return {
    "@context": AFP_CONTEXTS,
    id,
    type: "Service",
    name: spec.name,
    // R4: the WebFinger username for an agent is its spec name.
    preferredUsername: spec.name,
    "afp:operatedBy": instanceActorId(origin),
    "afp:capabilities": [...spec.capabilities],
    ...(spec.consumes && spec.consumes.length > 0 ? { "afp:consumes": [...spec.consumes] } : {}),
    inbox: `${id}/inbox`,
    outbox: `${id}/outbox`,
    "afp:visibility": "public",
    assertionMethod: [multikey(key), ...hubKeys.map(multikey)],
    ...(transportKey ? { authentication: [multikey(transportKey)] } : {}),
  };
}

export function hubActorId(origin: string, hubId: string): string {
  return `${origin}/hubs/${hubId}`;
}

/**
 * `afp:Hub` — an AS2 `Group` (ADR-0002 Decision 1). It reaches agents through
 * the same inbox/outbox shape as any other actor: no field here differs from
 * what a hub running as a separate federated service would publish.
 */
export function hubActor(
  origin: string,
  hubId: string,
  key: KeyPair,
  operatedBy?: string,
  /** ADR-0017 Decision 4 (R1): HTTP-signature key, published under `authentication`. */
  transportKey?: KeyPair,
): { [key: string]: JsonValue } {
  const id = hubActorId(origin, hubId);
  return {
    "@context": AFP_CONTEXTS,
    id,
    type: ["Group", "afp:Hub"],
    name: hubId,
    // R4: the WebFinger username for a hub is its hub id.
    preferredUsername: hubId,
    inbox: `${id}/inbox`,
    outbox: `${id}/outbox`,
    // R5: derived collection — active seats, served publicly.
    followers: `${id}/followers`,
    "afp:visibility": "public",
    // ADR-0016: the shared hub is one member's server (ADR-0014's headline),
    // and the document now says whose — which is also what lets hub-authored
    // transport traffic (the anti-entropy exchange) cross a boundary gate
    // that judges operators.
    ...(operatedBy ? { "afp:operatedBy": operatedBy } : {}),
    assertionMethod: [multikey(key)],
    ...(transportKey ? { authentication: [multikey(transportKey)] } : {}),
  };
}

/**
 * What a document needs to publish a key: the public half and its identity.
 * A `KeyPair` satisfies this structurally, and so does the public view of a
 * signer whose private half the instance never holds (ADR-0026 `agent`
 * custody) — which is the point of taking the narrower shape here.
 */
export interface PublishedKey {
  keyId: string;
  controller: string;
  publicKeyMultibase: string;
  /**
   * ADR-0026 Decision 1: where this key's private half lives, published so an
   * auditor can see custody without being able to reach it. Informational and
   * never a capability — a document claiming `remote` proves nothing about
   * where the key really is; it states what the operator says, which is what
   * ADR-0033 turns into an obligation.
   *
   * Omitted for the `assertionMethod` proof key, whose custody the roster
   * already carries per agent as `afp:keyCustody` (Decision 1's own division:
   * the roster for the proof key, the key entry for the ones the roster does
   * not cover).
   */
  custody?: Custody;
}

function multikey(key: PublishedKey): JsonValue {
  return {
    id: key.keyId,
    type: "Multikey",
    controller: key.controller,
    publicKeyMultibase: key.publicKeyMultibase,
    ...(key.custody !== undefined ? { "afp:custody": key.custody } : {}),
  };
}

/**
 * The roster's membership, **replayed from the instance's own `Vouch`/`Disown`
 * trail** rather than read from configuration — admission is a recorded act,
 * and assembling the roster from config would make it the side-channel the
 * trail exists to prevent.
 *
 * Returns the members and the instant of the last membership change, which is
 * what makes the signed document byte-stable: `created` is that instant, not
 * the time of the request, so two fetches produce identical bytes and an
 * auditor comparing copies sees tampering rather than noise (01 § Vouch /
 * disown).
 */
export function deriveRoster(
  entries: readonly { activity: { [key: string]: JsonValue }; published: string }[],
): { members: AgentSpec[]; lastChange: string } {
  const members = new Map<string, AgentSpec>();
  let lastChange = "";

  for (const entry of entries) {
    const type = String(entry.activity.type ?? "");
    const object = entry.activity.object as Record<string, JsonValue> | undefined;
    const agentUrl = typeof object?.agent === "string" ? object.agent : null;
    if (!agentUrl || (type !== "afp:Vouch" && type !== "afp:Disown")) continue;

    const name = agentUrl.split("/").pop() ?? agentUrl;
    if (type === "afp:Vouch") {
      const capabilities = Array.isArray(object?.["afp:capabilities"])
        ? (object["afp:capabilities"] as JsonValue[]).map(String)
        : [];
      members.set(name, {
        name,
        url: agentUrl,
        capabilities,
        keyCustody: String(object?.["afp:keyCustody"] ?? "instance") as AgentSpec["keyCustody"],
        since: String(object?.since ?? entry.published),
      });
    } else {
      members.delete(name);
    }
    lastChange = entry.published;
  }

  return { members: [...members.values()], lastChange };
}

/**
 * The roster, signed as a whole so membership verifies from a cached copy with
 * no live roundtrip (gate check 9).
 */
export function signedRoster(
  origin: string,
  agents: readonly AgentSpec[],
  instanceSigner: Signer,
  created?: string,
): SignedDocument {
  const roster: { [key: string]: JsonValue } = {
    "@context": AFP_CONTEXTS,
    id: `${origin}/roster`,
    type: "OrderedCollection",
    attributedTo: instanceActorId(origin),
    totalItems: agents.length,
    "afp:visibility": "public",
    orderedItems: agents.map((agent) => ({
      // A fragment id under the roster URL: entries are referenced later
      // (audits cite them), and a referenced AS2 object carries an id
      // (ADR-0017 Decision 6, critique finding 3.7).
      id: `${origin}/roster#${agent.name}`,
      type: "afp:RosterEntry",
      agent: agent.url ?? agentActorId(origin, agent.name),
      status: "active",
      "afp:keyCustody": agent.keyCustody,
      since: agent.since,
    })),
  };

  return attachProof(roster, { signer: instanceSigner, created });
}
