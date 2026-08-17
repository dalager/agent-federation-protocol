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
export const AFP_CONTEXT = "https://afp.example/ns/v3";

/** Every AFP document carries the same three contexts. */
export const AFP_CONTEXTS: JsonValue = [AS2_CONTEXT, AFP_CONTEXT, DATA_INTEGRITY_CONTEXT];

export type KeyCustody = "self" | "instance";

export interface AgentSpec {
  /** Local name; the actor URL is `${origin}/agents/${name}`. */
  name: string;
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
): { [key: string]: JsonValue } {
  const id = instanceActorId(origin);
  return {
    "@context": AFP_CONTEXTS,
    id,
    type: ["Application", "afp:Instance"],
    name,
    "afp:operator": operator,
    inbox: `${origin}/inbox`,
    outbox: `${origin}/outbox`,
    "afp:roster": `${origin}/roster`,
    "afp:policy": `${origin}/.well-known/afp-policy`,
    "afp:visibility": "public",
    assertionMethod: [multikey(key)],
  };
}

export function agentActor(
  origin: string,
  spec: AgentSpec,
  key: KeyPair,
): { [key: string]: JsonValue } {
  const id = agentActorId(origin, spec.name);
  return {
    "@context": AFP_CONTEXTS,
    id,
    type: "Service",
    name: spec.name,
    "afp:operatedBy": instanceActorId(origin),
    "afp:capabilities": [...spec.capabilities],
    inbox: `${id}/inbox`,
    outbox: `${id}/outbox`,
    "afp:visibility": "public",
    assertionMethod: [multikey(key)],
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
      agent: agentActorId(origin, agent.name),
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
