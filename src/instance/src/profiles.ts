/**
 * Agent profiles: one declaration per agent, from which everything the record
 * carries about it is derived — roster capabilities (Vouch), hub enrollment,
 * sealed bid coverage, and (in LLM mode) the brain's persona prompt.
 *
 * The layering matches how the protocol consumes the information:
 *
 *  - `capabilities` — coarse, stable, an *addressing* vocabulary. Lands on the
 *    Vouch/roster and the Enroll; Announces filter on it. Short, namespaced,
 *    from one registry so two agents never invent two names for one thing.
 *  - `coverage` — fine-grained and per-question: domain → integer-percent
 *    confidence, declared under the bid commitment. Settlements grade these
 *    against actuals, so a confidence is a number the operator is willing to
 *    be judged on — not marketing.
 *  - `persona` — the only free text, generated *into* the system prompt
 *    together with the eligible coverage domains, never maintained apart from
 *    the declaration. The model answers as exactly the specialist it bid as.
 *
 * Deriving all of it from one structure is what keeps the record honest: a
 * second place stating the same fact is a place claim and behavior drift.
 */

import type { AgentSpec } from "./ap/documents.ts";
import type { BidFields } from "./allocation/activities.ts";

export interface AgentProfile {
  name: string;
  /** Coarse routable capability ids, e.g. `afp:cap:estimate`. */
  capabilities: readonly string[];
  /** One sentence of who this specialist is — becomes the LLM persona. */
  persona: string;
  /**
   * Declared sub-domain → confidence, integer percent (the JCS profile
   * forbids non-integer numbers). An empty map is meaningful: capable of the
   * task class in general but of none of this hub's announced domains — such
   * an agent declines on the record rather than bidding (03).
   */
  coverage: Readonly<Record<string, number>>;
  /** Bid metadata for estimation tasks: what performing costs *this bidder*. */
  bidPosture: { capabilityMatch: number; cost: { unit: string; value: number }; latency: string };
  /**
   * True for agents that frame budgets others may bid to earn — listed in the
   * announce's `afp:estimators`, and under hub policy `exclude` rejected at
   * bid admission (03 § Estimating what you may later be paid to do).
   */
  estimator?: boolean;
  keyCustody: "instance" | "self";
}

// ---------------------------------------------------------------- derivations

export function toAgentSpec(profile: AgentProfile, since: string): AgentSpec {
  return {
    name: profile.name,
    capabilities: [...profile.capabilities],
    keyCustody: profile.keyCustody,
    since,
  };
}

/** The domains this profile may claim at the rule's confidence floor. */
export function eligibleDomains(profile: AgentProfile, domains: readonly string[], minConfidence: number): string[] {
  return domains.filter((d) => (profile.coverage[d] ?? 0) >= minConfidence);
}

/** Profiles that bid on a coverage auction: at least one eligible domain, not an excluded estimator. */
export function biddersFor(profiles: readonly AgentProfile[], domains: readonly string[], minConfidence: number): AgentProfile[] {
  return profiles.filter((p) => !p.estimator && eligibleDomains(p, domains, minConfidence).length > 0);
}

/** Profiles that SHOULD `Reject` on the record: capable of the class, none of these domains. */
export function declinersFor(profiles: readonly AgentProfile[], domains: readonly string[], minConfidence: number): AgentProfile[] {
  return profiles.filter((p) => !p.estimator && eligibleDomains(p, domains, minConfidence).length === 0);
}

/** The sealed bid payload fields this profile commits to for one task. */
export function estimateBid(profile: AgentProfile, taskId: string, bidderActorId: string, slug: string): BidFields {
  return {
    task: taskId,
    bidder: bidderActorId,
    capabilityMatch: profile.bidPosture.capabilityMatch,
    estimatedCost: { ...profile.bidPosture.cost },
    estimatedLatency: profile.bidPosture.latency,
    coverage: { ...profile.coverage },
    nonce: `nonce-${profile.name}-${slug}`,
  };
}

/**
 * Collection-level sanity, checked at build time rather than discovered as a
 * failed auction at runtime: the non-estimator profiles must jointly cover
 * every announced domain at the confidence floor — otherwise no bid set can
 * satisfy the coverage rule and every announce is dead on arrival.
 */
export function assertCoverage(profiles: readonly AgentProfile[], domains: readonly string[], minConfidence: number): void {
  const covered = new Set(biddersFor(profiles, domains, minConfidence).flatMap((p) => eligibleDomains(p, domains, minConfidence)));
  const gaps = domains.filter((d) => !covered.has(d));
  if (gaps.length) {
    throw new Error(
      `agent collection cannot cover announced domain(s) at confidence >= ${minConfidence}: ${gaps.join(", ")} — ` +
        "no coverage auction over these domains can ever award",
    );
  }
}

// -------------------------------------------------- the P3 estimation panel

export const PANEL_DOMAINS = ["infra", "data", "compliance", "licensing"] as const;
export const PANEL_MIN_CONFIDENCE = 60;

/**
 * The panel behind the P3 demo and the Lemonade experiment. Overlap is a
 * feature: c-generalist and b-licensing both claim compliance, which gives
 * the coverage rule real choices and the synthesizer a cross-check. d-secops
 * covers none of the announced domains — the on-record decliner. e-estimator
 * framed the budget and is walled off at bid admission.
 */
export const ESTIMATION_PANEL: readonly AgentProfile[] = [
  {
    name: "a-infra",
    capabilities: ["afp:cap:estimate"],
    persona: "cloud infrastructure engineer specializing in lift-and-shift migrations and dual-run cutovers",
    coverage: { infra: 90, data: 70 },
    bidPosture: { capabilityMatch: 80, cost: { unit: "afp:compute-unit", value: 30 }, latency: "PT2H" },
    keyCustody: "instance",
  },
  {
    name: "a-data",
    capabilities: ["afp:cap:estimate"],
    persona: "data platform engineer focused on high-volume transactional store migrations",
    coverage: { data: 90 },
    bidPosture: { capabilityMatch: 80, cost: { unit: "afp:compute-unit", value: 25 }, latency: "PT1H" },
    keyCustody: "instance",
  },
  {
    name: "b-compliance",
    capabilities: ["afp:cap:estimate"],
    persona: "payments compliance officer with PCI-DSS audit experience",
    coverage: { compliance: 80, licensing: 50 },
    bidPosture: { capabilityMatch: 80, cost: { unit: "afp:compute-unit", value: 20 }, latency: "PT3H" },
    keyCustody: "instance",
  },
  {
    name: "b-licensing",
    capabilities: ["afp:cap:estimate"],
    persona: "software-licensing counsel with payments-industry vendor experience",
    coverage: { licensing: 90, compliance: 65 },
    bidPosture: { capabilityMatch: 80, cost: { unit: "afp:compute-unit", value: 35 }, latency: "PT4H" },
    keyCustody: "instance",
  },
  {
    name: "c-generalist",
    capabilities: ["afp:cap:estimate"],
    persona: "solution architect who has run several end-to-end platform migrations",
    coverage: { infra: 65, data: 60, compliance: 60, licensing: 55 },
    bidPosture: { capabilityMatch: 80, cost: { unit: "afp:compute-unit", value: 60 }, latency: "PT8H" },
    keyCustody: "instance",
  },
  {
    name: "d-secops",
    capabilities: ["afp:cap:estimate"],
    persona: "security operations",
    coverage: {},
    bidPosture: { capabilityMatch: 40, cost: { unit: "afp:compute-unit", value: 50 }, latency: "PT8H" },
    keyCustody: "instance",
  },
  {
    name: "e-estimator",
    capabilities: ["afp:cap:estimate"],
    persona: "programme controller who framed the migration budget",
    coverage: { infra: 70, data: 70, compliance: 70, licensing: 70 },
    bidPosture: { capabilityMatch: 90, cost: { unit: "afp:compute-unit", value: 10 }, latency: "PT1H" },
    estimator: true,
    keyCustody: "instance",
  },
];
