/**
 * ADR-0038 Decision 1: the agent collection from configuration.
 *
 * `AFP_AGENTS_FILE` names a JSON array, one entry per agent, shaped on
 * `profiles.ts`'s `AgentProfile` so the record's derivations stay one
 * declaration: the entry's `capabilities` land on the Vouch/roster, its
 * `persona` becomes the `llm` brain's system prompt, its `consumes` becomes
 * `afp:consumes`. `serve`, `keys`, `export` and `config check` all boot the
 * collection through `agentCollection(config)` below; when the variable is
 * unset the answer is byte-for-byte `demo.ts`'s writer/reviewer, so every
 * demo, fixture and gate written before this file is unchanged.
 *
 * Three brains, because three things an operator wants from an entry:
 *
 *  - `llm`  — `makeLlmBrain` against the configured endpoint, the entry's
 *             persona framed the way `WRITER_PROMPT` frames its own.
 *  - `stub` — `makeEchoBrain`, deterministic and offline, for a served
 *             instance that must answer without a model behind it.
 *  - `none` — an actor the instance HOLDS and nothing performs for: its key
 *             is minted under instance custody and it sits on the roster,
 *             which is how a human controller holds an actor "under instance
 *             custody" (ADR-0029 Decision 2) without writing a program. An
 *             Offer addressed to it is `Reject`ed on the record by
 *             `inbox.ts`, the way a paused agent's is — never left to hang.
 *
 * `keyCustody` is always `"instance"`: `"self"` means the agent supplies its
 * own signer (ADR-0026's `agent` adapter), which a JSON file cannot carry, so
 * it is refused here by name rather than silently downgraded. Validation is
 * the boundary: every problem is named at once, in `config check`'s `agents`
 * line, in the style of `policySpec.ts`.
 */

import { existsSync, readFileSync } from "node:fs";
import type { Config } from "./config.ts";
import type { AgentRegistration } from "./instance.ts";
import type { Brain, TaskOutcome } from "./brains/port.ts";
import { makeEchoBrain } from "./brains/stub.ts";
import { makeLlmBrain } from "./brains/openai.ts";
import { agentRegistrations, endpointOf } from "./demo.ts";

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
 * The persona, framed the way `WRITER_PROMPT` frames the demo's writer: the
 * audited-workflow setting, explicit assumptions, no questions back. The
 * operator writes who the agent is; the framing is the instance's.
 */
export function personaPrompt(persona: string): string {
  return [
    persona.trim(),
    "You are working inside an audited agent workflow.",
    "Answer the brief as a short markdown note. State every assumption you rely on",
    "explicitly, in its own sentence, because a reviewer will check them.",
    "Do not ask questions; produce the answer.",
  ].join(" ");
}

/** The `none` brain: advertises what the entry declares and performs nothing — `inbox.ts` Rejects before this is reached. */
function heldBrain(name: string, capabilities: readonly string[]): Brain {
  return {
    name,
    capabilities,
    async handle(): Promise<TaskOutcome> {
      return { ok: false, reason: `${name} is a held actor: nothing performs for it` };
    },
  };
}

function brainFor(config: Config, entry: AgentEntry): Brain {
  switch (entry.brain) {
    case "llm":
      return makeLlmBrain(entry.name, entry.capabilities, personaPrompt(entry.persona ?? ""), endpointOf(config), {
        ...(entry.consumes ? { consumes: entry.consumes } : {}),
      });
    case "stub":
      return makeEchoBrain(entry.name, entry.capabilities, entry.consumes);
    case "none":
      return heldBrain(entry.name, entry.capabilities);
  }
}

/** Registrations for validated entries — the shape `AfpInstance` takes. */
export function registrationsFor(config: Config, entries: readonly AgentEntry[]): AgentRegistration[] {
  return entries.map((entry) => ({
    spec: {
      name: entry.name,
      capabilities: [...entry.capabilities],
      ...(entry.consumes ? { consumes: [...entry.consumes] } : {}),
      keyCustody: entry.keyCustody,
      since: entry.since,
    },
    brain: brainFor(config, entry),
    ...(entry.brain === "none" ? { held: true } : {}),
  }));
}

/**
 * The collection a `cli.ts` command boots: `AFP_AGENTS_FILE`'s when it is
 * set, the demo's otherwise. A file with problems throws them all at once —
 * `config check` reports the same list without throwing (`agentsCheck`).
 */
export function agentCollection(config: Config): AgentRegistration[] {
  if (!config.agentsFile) return agentRegistrations(config);
  const { entries, problems } = readAgentsFile(config.agentsFile);
  if (problems.length > 0) {
    throw new Error(`AFP_AGENTS_FILE ${config.agentsFile}: ${problems.join("; ")}`);
  }
  return registrationsFor(config, entries);
}

/** `config check`'s `agents` line: ok with a count or the demo note, FAIL naming every problem. */
export function agentsCheck(config: Config): { ok: boolean; reason: string } {
  if (!config.agentsFile) return { ok: true, reason: "demo collection (AFP_AGENTS_FILE unset)" };
  const { entries, problems } = readAgentsFile(config.agentsFile);
  if (problems.length > 0) return { ok: false, reason: problems.join("; ") };
  return { ok: true, reason: `${entries.length} from AFP_AGENTS_FILE` };
}
