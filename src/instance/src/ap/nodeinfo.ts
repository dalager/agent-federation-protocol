/**
 * FEP-f1d5 NodeInfo: the well-known discovery document and the version
 * document it points at. Split out of `server.ts` to keep that file under
 * its line ceiling — these are pure builders, not a second HTTP surface.
 */

import { INSTANCE_VERSION, SPEC_REVISION } from "../version.ts";

export function nodeinfoDiscovery(origin: string): { [key: string]: unknown } {
  return {
    links: [
      {
        rel: "http://nodeinfo.diaspora.software/ns/schema/2.1",
        href: `${origin}/nodeinfo/2.1`,
      },
    ],
  };
}

export function nodeinfoDocument(agentCount: number): { [key: string]: unknown } {
  return {
    version: "2.1",
    software: {
      name: "afp-instance",
      version: INSTANCE_VERSION,
      repository: "https://github.com/dalager/agent-federation-protocol",
      homepage: "https://dalager.github.io/agent-federation-protocol",
    },
    protocols: ["activitypub"],
    services: { inbound: [], outbound: [] },
    openRegistrations: false,
    usage: { users: { total: 0 } },
    metadata: {
      agents: agentCount,
      afp: { cryptosuite: "eddsa-jcs-2022" },
      "afp:specRevision": SPEC_REVISION,
    },
  };
}
