/**
 * Fixtures shared by the two ADR-0010 gates (`adr0010.test.ts`, the direct
 * flow; `adr0010-parity.test.ts`, the two roots held to one meaning).
 *
 * They live here rather than in `helpers.ts` because none of them is generic
 * scaffolding — the policy, the capability and the `action:` check phrases are
 * this ADR's subject matter, and a later gate that borrowed them would be
 * borrowing an argument, not a tool. The generic halves (instance/hub setup,
 * the raw-body publish, the mutate-and-replay harness) do live in `helpers.ts`,
 * where every gate can find them.
 */

import { join } from "node:path";

import type { AfpInstance } from "../src/instance.ts";
import type { ActionPolicy } from "../src/ap/pins.ts";
import { publishRaw, testHub, testInstance } from "./helpers.ts";

export const VERIFIER = join(import.meta.dirname, "..", "..", "verifier", "afp_verify.py");
export const CAPABILITY = "afp:cap:screen";

/** ADR-0010 Decision 4: every pinned policy declares its non-answer action. */
export const POLICY: ActionPolicy = {
  "afp:screen-ok": "advance",
  "afp:screen-flag": "hold-for-review",
  "afp:no-verdict": "hold-for-review",
};

/** A bare instance, no hub — the pure P1 shape the direct flow degenerates to. */
export function setupPlain(agentNames: readonly string[]) {
  return testInstance(agentNames, CAPABILITY);
}

/** An instance with a hub — only the ratified and auction-rooted flows need one. */
export function setupWithHub(agentNames: readonly string[], hubId: string) {
  const { instance, config, clock } = setupPlain(agentNames);
  const { hub, hubKeys } = testHub(instance, agentNames, hubId);
  return { instance, config, clock, hub, hubKeys };
}

/** Raw-body publish onto a thread, addressed to peers (`parties` visibility). */
export function publish(
  instance: AfpInstance,
  name: string,
  to: readonly string[],
  thread: string,
  body: { [key: string]: unknown },
) {
  return publishRaw(instance, name, to, thread, "parties", body);
}

export function synthesisOf(activity: Record<string, unknown>): Record<string, unknown> | undefined {
  const object = activity.object as Record<string, unknown> | undefined;
  return object?.type === "afp:Synthesis" ? object : undefined;
}

/**
 * The `action:` check family, by phrase. `action.py` names each check
 * `f"action: {label} <phrase>"`, and the `{label}` — a digest here, an
 * activity id there — differs between an Award-rooted bundle and a direct-flow
 * one. Reading the verdict per *phrase* rather than per exact line is what
 * lets two structurally different bundles be compared for identical verdicts.
 */
export const ACTION_PHRASES = [
  "answers within the pinned category set",
  "acts on a producible Synthesis",
  "traces to a pinned action policy",
  "is the action the answer permitted",
] as const;

export function actionVerdicts(output: string): Record<string, boolean> {
  const verdicts: Record<string, boolean> = {};
  for (const phrase of ACTION_PHRASES) {
    const match = output.match(new RegExp(`\\[\\s*(ok|FAIL)\\s*\\] action: .*${phrase}`));
    if (match) verdicts[phrase] = match[1] === "ok";
  }
  return verdicts;
}
