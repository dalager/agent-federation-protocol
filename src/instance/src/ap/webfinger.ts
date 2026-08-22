/**
 * WebFinger (RFC 7033), ADR-0017 Decision 4.
 *
 * Discovery surface, same bootstrap class as `/actor` (01: verifying a
 * signature requires fetching a key over an unauthenticated route) — this
 * route stays unauthenticated forever, for the same reason.
 *
 * `preferredUsername` per R4: the instance actor answers to the literal
 * `"instance"`; an agent to its spec name; a hub to its hub id. The `acct:`
 * lookup tries those three in that order; a `https:` resource is accepted
 * verbatim against the three actor ids. Anything else is 404 — no partial
 * matches, no probing surface beyond "does this exact subject exist".
 */

const INSTANCE_USERNAME = "instance";

export interface WebfingerDeps {
  origin: string;
  agentNames: readonly string[];
  hubIds: readonly string[];
}

interface Jrd {
  subject: string;
  aliases: string[];
  links: { rel: "self"; type: "application/activity+json"; href: string }[];
}

function actorIdFor(deps: WebfingerDeps, username: string): string | null {
  if (username === INSTANCE_USERNAME) return `${deps.origin}/actor`;
  if (deps.agentNames.includes(username)) return `${deps.origin}/agents/${username}`;
  if (deps.hubIds.includes(username)) return `${deps.origin}/hubs/${username}`;
  return null;
}

function jrdFor(subject: string, actorId: string): Jrd {
  return {
    subject,
    aliases: [actorId],
    links: [{ rel: "self", type: "application/activity+json", href: actorId }],
  };
}

export function webfingerResponse(
  deps: WebfingerDeps,
  resourceParam: string | null,
): { status: 200 | 400 | 404; body: unknown } {
  if (resourceParam === null || resourceParam === "") {
    return { status: 400, body: { error: "malformed resource" } };
  }

  if (resourceParam.startsWith("acct:")) {
    const rest = resourceParam.slice("acct:".length);
    const at = rest.indexOf("@");
    if (at < 0) return { status: 400, body: { error: "malformed resource" } };
    const username = rest.slice(0, at);
    const host = rest.slice(at + 1);
    let originHost: string;
    try {
      originHost = new URL(deps.origin).host;
    } catch {
      return { status: 400, body: { error: "malformed resource" } };
    }
    if (host !== originHost) return { status: 404, body: { error: "not found" } };
    const actorId = actorIdFor(deps, username);
    if (actorId === null) return { status: 404, body: { error: "not found" } };
    return { status: 200, body: jrdFor(resourceParam, actorId) };
  }

  if (resourceParam.startsWith("https:") || resourceParam.startsWith(deps.origin)) {
    const candidates = [
      `${deps.origin}/actor`,
      ...deps.agentNames.map((name) => `${deps.origin}/agents/${name}`),
      ...deps.hubIds.map((id) => `${deps.origin}/hubs/${id}`),
    ];
    if (!candidates.includes(resourceParam)) return { status: 404, body: { error: "not found" } };
    return { status: 200, body: jrdFor(resourceParam, resourceParam) };
  }

  return { status: 400, body: { error: "malformed resource" } };
}
