/**
 * ADR-0038 Decision 1: the agent collection from configuration.
 *
 * `AFP_AGENTS_FILE` names a JSON array, one entry per agent, shaped on
 * `profiles.ts`'s `AgentProfile` so the record's derivations stay one
 * declaration: the entry's `capabilities` land on the Vouch/roster, its
 * `persona` becomes the `llm` brain's system prompt, its `consumes` becomes
 * `afp:consumes`, and its `brain` kind lands on the published policy's
 * `afp:brains` (`config.ts` `assemblePolicy`, through `agentsSpec.ts`).
 * `serve`, `keys`, `export` and `config check` all boot the collection
 * through `agentCollection(config)` below; when the variable is unset the
 * answer is byte-for-byte `demo.ts`'s writer/reviewer, so every demo,
 * fixture and gate written before this file is unchanged.
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
 * The file's shape and validation live in `agentsSpec.ts` (a leaf, so
 * `config.ts` can read brain kinds without a cycle) and are re-exported
 * here. `keyCustody` is always `"instance"`: `"self"` means the agent
 * supplies its own signer (ADR-0026's `agent` adapter), which a JSON file
 * cannot carry, so it is refused by name rather than silently downgraded.
 */

import type { Config } from "./config.ts";
import type { AgentRegistration } from "./instance.ts";
import type { Brain, TaskOutcome } from "./brains/port.ts";
import { makeEchoBrain } from "./brains/stub.ts";
import { makeLlmBrain } from "./brains/openai.ts";
import { agentRegistrations, endpointOf } from "./demo.ts";
import { readAgentsFile, type AgentEntry } from "./agentsSpec.ts";

export { AGENT_NAME, DEFAULT_SINCE, readAgentsFile, validateAgentEntries, type AgentBrainKind, type AgentEntry } from "./agentsSpec.ts";

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
