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
    "afp:policy": `${origin}/.well-known/afp-policy`,
    "afp:visibility": "public",
    assertionMethod: [multikey(key)],
    authentication: [multikey(transportKey)],
  };
}

export function agentActor(
  origin: string,
  spec: AgentSpec,
  key: KeyPair,
  /**
   * Hub-scoped verification methods (ADR-0002 Decision 4), published alongside
   * the P1 `assertionMethod` key rather than replacing it — keys cannot be
   * backfilled onto an already-published actor document.
   */
  hubKeys: readonly KeyPair[] = [],
  /** ADR-0017 Decision 4 (R1): HTTP-signature key, published under `authentication`. */
  transportKey?: KeyPair,
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

function multikey(key: KeyPair): JsonValue {
  return {
    id: key.keyId,
    type: "Multikey",
    controller: key.controller,
    publicKeyMultibase: key.publicKeyMultibase,
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
  instanceKey: KeyPair,
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
      type: "afp:RosterEntry",
      agent: agent.url ?? agentActorId(origin, agent.name),
      status: "active",
      "afp:keyCustody": agent.keyCustody,
      since: agent.since,
    })),
  };

  return attachProof(roster, {
    privateKey: instanceKey.privateKey,
    verificationMethod: instanceKey.keyId,
    created,
  });
}
