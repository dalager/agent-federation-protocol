/**
 * ADR-0038 Decision 1: the `AFP_AGENTS_FILE` shape and its validation, kept
 * apart from `agents.ts` (which builds brains and registrations from it) for
 * the same reason `policySpec.ts` sits apart from `ap/policy.ts`: `config.ts`
 * needs to read the file's brain kinds to derive the published policy's
 * `brains` (ADR-0033 Decision 1 — the policy states what the instance
 * actually runs), and `agents.ts` imports `Config` from `config.ts`. A leaf
 * module with no import of either is what keeps that from closing a cycle.
 */

import { existsSync, readFileSync } from "node:fs";
import type { BrainSpec } from "./policySpec.ts";

export type AgentBrainKind = "llm" | "stub" | "none";

export interface AgentEntry {
  readonly name: string;
  readonly capabilities: readonly string[];
  readonly brain: AgentBrainKind;
  /** One or two sentences of who this specialist is — the `llm` brain's persona. */
  readonly persona?: string;
  /** ADR-0027 Decision 2: media types this agent consumes as bytes. */
  readonly consumes?: readonly string[];
  readonly keyCustody: "instance";
  readonly since: string;
}

/** The `since` the demo pins its roster to — kept so a file-built roster is as deterministic as the demo's. */
export const DEFAULT_SINCE = "2026-08-17T00:00:00Z";
export const AGENT_NAME = /^[a-z][a-z0-9-]*$/;
const BRAIN_KINDS: ReadonlySet<string> = new Set(["llm", "stub", "none"]);
const KNOWN_KEYS: ReadonlySet<string> = new Set(["name", "capabilities", "brain", "persona", "consumes", "keyCustody", "since"]);

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

/**
 * Every problem with a parsed agents file, named — never throws. The entry is
 * identified by its `name` when it has one, by its index otherwise, so a
 * report reads "kasper: unknown key foo" rather than "[2]: …" where it can.
 */
export function validateAgentEntries(raw: unknown): { entries: AgentEntry[]; problems: string[] } {
  const problems: string[] = [];
  const entries: AgentEntry[] = [];
  if (!Array.isArray(raw)) {
    return { entries, problems: ["file must be a JSON array of agent entries"] };
  }

  const seen = new Set<string>();
  raw.forEach((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      problems.push(`[${index}]: entry must be an object`);
      return;
    }
    const record = item as Record<string, unknown>;
    const label = typeof record.name === "string" && record.name.length > 0 ? record.name : `[${index}]`;
    const push = (message: string): void => {
      problems.push(`${label}: ${message}`);
    };
    let ok = true;

    for (const key of Object.keys(record)) {
      if (!KNOWN_KEYS.has(key)) {
        push(`unknown key "${key}"`);
        ok = false;
      }
    }
    if (typeof record.name !== "string" || !AGENT_NAME.test(record.name)) {
      push(`name must match ${AGENT_NAME}, got ${JSON.stringify(record.name)}`);
      ok = false;
    } else if (seen.has(record.name)) {
      push("duplicate name");
      ok = false;
    } else {
      seen.add(record.name);
    }
    if (!isStringList(record.capabilities)) {
      push("capabilities must be an array of non-empty strings");
      ok = false;
    }
    if (typeof record.brain !== "string" || !BRAIN_KINDS.has(record.brain)) {
      push(`brain must be one of llm/stub/none, got ${JSON.stringify(record.brain)}`);
      ok = false;
    }
    if (record.persona !== undefined && (typeof record.persona !== "string" || record.persona.trim().length === 0)) {
      push("persona must be a non-empty string when present");
      ok = false;
    }
    if (record.brain === "llm" && typeof record.persona !== "string") {
      push('an "llm" entry needs a persona — it becomes the system prompt');
      ok = false;
    }
    if (record.consumes !== undefined && !isStringList(record.consumes)) {
      push("consumes must be an array of non-empty strings");
      ok = false;
    }
    if (record.keyCustody !== undefined && record.keyCustody !== "instance") {
      push(
        `keyCustody must be "instance" (got ${JSON.stringify(record.keyCustody)}) — "self" needs a signer this file cannot supply (ADR-0026 agent adapter)`,
      );
      ok = false;
    }
    if (record.since !== undefined && (typeof record.since !== "string" || Number.isNaN(Date.parse(record.since)))) {
      push(`since must be an ISO instant, got ${JSON.stringify(record.since)}`);
      ok = false;
    }
    if (!ok) return;

    entries.push({
      name: record.name as string,
      capabilities: [...(record.capabilities as string[])],
      brain: record.brain as AgentBrainKind,
      ...(typeof record.persona === "string" ? { persona: record.persona } : {}),
      ...(record.consumes !== undefined ? { consumes: [...(record.consumes as string[])] } : {}),
      keyCustody: "instance",
      since: typeof record.since === "string" ? record.since : DEFAULT_SINCE,
    });
  });

  return { entries, problems };
}

/** Read and validate `AFP_AGENTS_FILE`. A missing or unparseable file is a named problem, not a throw. */
export function readAgentsFile(path: string): { entries: AgentEntry[]; problems: string[] } {
  if (!existsSync(path)) return { entries: [], problems: [`${path} does not exist`] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { entries: [], problems: [`${path} is not valid JSON: ${(error as Error).message}`] };
  }
  return validateAgentEntries(raw);
}

/**
 * ADR-0033 Decision 1 meets ADR-0038: the `afp:brains` a collection actually
 * runs — the union over its entries, deduplicated, in first-appearance
 * order. `stub` contributes `{ model: "stub" }` (what `makeEchoBrain` writes
 * into `afp:producedBy`), `llm` contributes the configured model and
 * endpoint (`producedByLine`'s prefix), `none` contributes nothing. An
 * all-`none` collection yields `[]`: no brain runs, no Result is ever
 * produced, and the verifier reads an empty list as "not declared" rather
 * than failing anything — the honest statement, where publishing a model
 * nothing runs would be the very mismatch this derivation exists to close.
 */
export function derivedBrains(entries: readonly AgentEntry[], llm: { model: string; endpoint: string }): BrainSpec[] {
  const brains: BrainSpec[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const spec: BrainSpec | null =
      entry.brain === "stub" ? { model: "stub" } : entry.brain === "llm" ? { model: llm.model, endpoint: llm.endpoint } : null;
    if (!spec) continue;
    const key = `${spec.model}\0${spec.endpoint ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    brains.push(spec);
  }
  return brains;
}
