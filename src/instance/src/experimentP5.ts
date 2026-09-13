/**
 * The P5 Lemonade experiment: the same shared hub, the same transport, the
 * same kill — but the agents deciding are real models reading real evidence
 * from a local Lemonade endpoint instead of stubs that always say "yes".
 *
 * The scenario is a snow day. Three schools — Hilltop, Riverside and Central —
 * share one bus company, and the buses can only run one timetable. So none of
 * the three can close on its own: if Riverside closes, its nine buses stop,
 * and the drivers those buses free up cannot be re-timetabled onto Hilltop's
 * routes before morning. One decision, taken together, before the 06:00
 * message to parents: **close all three schools today?**
 *
 * Each school office can see its own car park, its own roads and its own
 * staff. None of them can see the others'. That is not a limitation of the
 * demo — it is the whole reason the shared hub exists, and it is why the
 * three of them can look at one storm and honestly reach different answers.
 *
 * What is worth watching, and why the mechanics matter here rather than in the
 * abstract:
 *
 *  - Each school votes its own conclusion from its own evidence. Riverside is
 *    snowed in; Hilltop and Central are in town, where the ploughs came
 *    through at five. A demo where everyone agrees never tests the count.
 *  - The hub is told the answer, never the reasoning. That is what lets a
 *    parent — or an auditor a year later — recompute the outcome without
 *    being able to see anyone's car park.
 *  - The parent-notification desk reads every school's traffic, because it has
 *    to write the 06:00 message. It still gets no vote. Reading and deciding
 *    are separate permissions, and the count shows which one it holds.
 *  - Hilltop's caretaker holds a seat and is out gritting the yard, so he
 *    never votes. The record says "silent" rather than pretending he
 *    abstained.
 *  - When the hub's host dies mid-task, the question Riverside had already
 *    sent Central is a real model call. It still gets answered, because the
 *    hub was never carrying it.
 *
 * Fails loudly rather than falling back: an experiment that quietly reverts to
 * stub content would be reporting on nothing.
 */

import type { LlmEndpoint } from "./brains/openai.ts";
import { checkEndpoint, makeLlmBrain } from "./brains/openai.ts";
import { runP5Demo, type P5Assessment, type P5DemoResult } from "./demoP5.ts";
import type { Brain } from "./brains/port.ts";
import { localAttachment, localProvenance } from "./brains/port.ts";

const CAPABILITY = "afp:cap:assess";

/** The question the bridge round asks, worded once and reused everywhere. */
export const QUESTION = "Close all three schools today because of the snow?";

export interface Desk {
  /** Local agent name, as enrolled on the bridge. Protocol-side identity. */
  agent: string;
  operator: string;
  /** Who this is, in words a parent would use. Narration-side identity. */
  label: string;
  /** One sentence of whose desk this is — becomes the model's persona. */
  persona: string;
  /** What this desk, and only this desk, can see at 05:30. */
  evidence: string;
}

/**
 * The evidence, split the way a real morning splits it: nobody holds the whole
 * picture, and the disagreement between the desks is a property of the split
 * rather than something written in to make the demo interesting.
 */
const DESKS: readonly Desk[] = [
  {
    agent: "n-noc",
    operator: "alpha",
    label: "Hilltop School — head teacher",
    persona: "the head teacher of Hilltop School, in town",
    evidence: [
      "HILLTOP SCHOOL — what we can see from here, 05:30",
      "",
      "- 3 cm of snow on the playground. It stopped falling around 04:00.",
      "- The council ploughed our street at 05:05. Car park is cleared and gritted.",
      "- 4 of our 31 staff have phoned in to say they cannot get out of their village.",
      "- Our 6 bus routes are all on ploughed roads. The bus company says they will run.",
      "- Heating is on and the building is at 19°C.",
      "- Forecast: no further snow today; -1°C, so what is down will stay down.",
      "- We cannot see the state of the roads out at Riverside or in Central's part of town.",
    ].join("\n"),
  },
  {
    agent: "s-noc",
    operator: "bravo",
    label: "Riverside School — head teacher",
    persona: "the head teacher of Riverside School, out in the valley",
    evidence: [
      "RIVERSIDE SCHOOL — what we can see from here, 05:30",
      "",
      "- The valley road, which is the only road to the school, is blocked by a fallen tree.",
      "- The council says the tree will be cleared 'sometime this morning'. No time given.",
      "- 3 of our 9 bus routes are on lanes that have not been ploughed at all.",
      "- 210 of our 400 pupils live along those three routes.",
      "- Last night's heating oil delivery could not get through. The building is at 12°C",
      "  and falling. We have enough oil for about four hours of heating.",
      "- 2 of our 22 staff have made it in. The rest are on the far side of the tree.",
      "- We cannot see what the roads are like in town.",
    ].join("\n"),
  },
  {
    agent: "e-noc",
    operator: "gamma",
    label: "Central School — head teacher",
    persona: "the head teacher of Central School, in the middle of town",
    evidence: [
      "CENTRAL SCHOOL — what we can see from here, 05:30",
      "",
      "- 2 cm of snow, the main road outside is clear and wet, buses are already moving on it.",
      "- All 21 staff live in town. 6 have already texted to say they are on their way in.",
      "- We have spare capacity: we could take another 60 children for the day if asked.",
      "- Last February we closed on a forecast like this one and the snow never arrived.",
      "  We lost a whole teaching day and the parents' association wrote to the governors.",
      "- Every closure costs roughly 180 working parents a day off, across our families alone.",
      "- We have no way of knowing what the valley road looks like this morning.",
    ].join("\n"),
  },
];

/**
 * The seat that watches and forms a view, and is still not asked (observer).
 * Distinct from the desk that sends the message (`e-notify`, an actuator):
 * ADR-0019 keeps those two apart because an actuator may publish nothing but
 * actuations, so a seat that also casts a — refused — vote can never hold it.
 */
const WATCHER: Desk = {
  agent: "e-watcher",
  operator: "gamma",
  label: "the district's duty officer (observer)",
  persona:
    "the district's duty officer, listening to the schools' call and answerable to the governors for it",
  evidence: [
    "DUTY OFFICER — what we can see, 05:30",
    "",
    "- The message to parents must go out by 06:00. After that, families have already left home",
    "  and a closure causes more harm than it prevents.",
    "- A closure message can be sent once. There is no correcting it at 06:40.",
    "- One school reports its building is at 12°C with about four hours of oil left.",
    "- This desk can read what all three schools have posted to the bridge.",
    "- This desk has no vote, and knows it.",
  ].join("\n"),
};

/**
 * The reply format, verbatim. Kept on its own lines rather than folded into a
 * paragraph: a small local model follows a two-line template it can see the
 * shape of, and stops following one that has been flattened into prose.
 */
const REPLY_FORMAT = [
  "Reply with exactly two lines and nothing else:",
  "VERDICT: yes",
  "BECAUSE: <one sentence, under 25 words, naming the one fact that decided it>",
  "Write 'no' instead of 'yes' on the VERDICT line if what you can see does not justify closing.",
].join("\n");

function deskPrompt(desk: Desk): string {
  return (
    [
      `You are ${desk.persona}. It is 05:30.`,
      "You are on a conference call with the two other schools. You can see only your own",
      "school's situation, which is written below. You cannot see theirs, and you must not",
      "invent what they can see.",
      `The three of you are voting on one question: ${QUESTION}`,
      "The three schools share one bus company and must close together or not at all.",
      "Closing keeps children out of the cold; it also costs every working parent a day.",
      "Vote for what you can actually justify from what is in front of you. Do not vote to",
      "close on the possibility that one of the others may be worse off than you — you cannot",
      "see them, and combining the three views is what the vote itself is for. Someone has to",
      "be willing to say 'my school is fine' when their school is fine, or the count means",
      "nothing.",
    ].join(" ") + `\n\n${REPLY_FORMAT}`
  );
}

function watcherPrompt(desk: Desk): string {
  return (
    [
      `You are ${desk.persona}. It is 05:30.`,
      "You listen to the schools' call. You have no vote and you know it.",
      "Say what you would put in the message to parents if the decision were yours.",
    ].join(" ") + `\n\n${REPLY_FORMAT}`
  );
}

/** The persona for the question still in flight when the hub's host dies. */
const CORRELATION_PROMPT = [
  "You are a school district's duty officer at 05:45 on a snowy morning.",
  "You have been handed what each school said on the call and how each of them voted.",
  "In at most four sentences, in plain English and with no jargon: say what one",
  "difference between the schools best explains why they disagreed, name the single",
  "thing someone could check in the next fifteen minutes that would settle it, and say",
  "who should go and check it. Do not repeat the inputs back. No preamble.",
].join(" ");

const encoder = new TextEncoder();

async function ask(
  endpoint: LlmEndpoint,
  desk: Desk,
  system: string,
): Promise<{ text: string; producedBy: string }> {
  const brain = makeLlmBrain(desk.agent, [CAPABILITY], system, endpoint);
  const outcome = await brain.handle({
    capability: CAPABILITY,
    content: `${QUESTION}\n\nWhat you can see:`,
    provenance: localProvenance(desk.agent),
    attachments: [localAttachment(encoder.encode(desk.evidence), "text/markdown", desk.agent)],
    thread: "",
  });
  if (!outcome.ok) throw new Error(`model call for ${desk.agent} failed: ${outcome.reason}`);
  return { text: outcome.content, producedBy: outcome.producedBy ?? endpoint.model };
}

/**
 * Read the two lines back. A verdict that cannot be read is an error, never a
 * silent default: guessing here would put an unearned value in the count, and
 * the count is the thing the record exists to make checkable.
 */
function parseVerdict(text: string, agent: string): { verdict: string; rationale: string } {
  const verdictLine = text.split("\n").find((line) => /^\s*\**VERDICT/i.test(line));
  const match = verdictLine ? /\b(yes|no)\b/i.exec(verdictLine) : null;
  if (!match) throw new Error(`${agent} returned no readable VERDICT line:\n${text.slice(0, 300)}`);

  const becauseLine = text.split("\n").find((line) => /^\s*\**BECAUSE/i.test(line)) ?? "";
  const rationale = becauseLine
    .replace(/^\s*\**BECAUSE\**\s*:?\s*/i, "")
    .replace(/\**\s*$/, "")
    .trim();

  return { verdict: match[1].toLowerCase(), rationale: rationale || "(no reason given)" };
}

export interface P5ExperimentResult extends P5DemoResult {
  question: string;
  /** Agent name → the desk behind it, so narration can use names not agent ids. */
  desks: Record<string, Desk>;
  /** Agent names with a seat but no desk here — the caretaker who never votes. */
  labels: Record<string, string>;
}

/** Seats that hold no evidence and cast no vote, but appear in the record. */
const SILENT_SEATS: Record<string, string> = {
  "n-telemetry": "Hilltop's caretaker — out gritting the yard, never votes",
  // ADR-0019's actuator: reads every school's traffic, votes on nothing, and
  // is the only seat allowed to publish the one activity that matters at 06:00.
  "e-notify": "the parent-notification desk (actuator)",
};

export async function runP5Experiment(
  options: { endpoint: LlmEndpoint; rootDir?: string; exportRoot?: string },
): Promise<P5ExperimentResult> {
  const problem = await checkEndpoint(options.endpoint);
  if (problem) throw new Error(`brain endpoint unavailable: ${problem}`);

  const desks = new Map<string, Desk>([...DESKS, WATCHER].map((desk) => [desk.agent, desk]));

  const result = await runP5Demo({
    rootDir: options.rootDir ?? "./data-p5-llm",
    exportRoot: options.exportRoot ?? "./export-p5-llm",
    content: {
      async assess(_operator, agent, role): Promise<P5Assessment> {
        const desk = desks.get(agent)!;
        const system = role === "observer" ? watcherPrompt(desk) : deskPrompt(desk);
        const { text, producedBy } = await ask(options.endpoint, desk, system);
        return { ...parseVerdict(text, agent), producedBy, content: text };
      },
      // Only e-noc runs a task in this demo — the question Riverside sends
      // Central while the hub's host is dying. Everyone else keeps the stub
      // brain, so the experiment spends model calls on what it is showing.
      brainFor(_operator, agent): Brain | null {
        return agent === "e-noc"
          ? makeLlmBrain(agent, [CAPABILITY], CORRELATION_PROMPT, options.endpoint)
          : null;
      },
      /**
       * The 06:00 message itself (ADR-0019). The desk that writes it has no
       * vote and never had one; the action it is allowed to take was fixed by
       * the round before anyone voted, and all it supplies is the wording.
       */
      notice(outcome, action): string {
        const wording: Record<string, string> = {
          "declare-sev-1": "All three schools are closed today. Do not travel.",
          "hold-at-sev-2": "All three schools are open as normal. Allow extra time.",
          "escalate-to-duty-directors":
            "No decision was reached by 06:00. Schools open; a further message will follow.",
        };
        return wording[action] ?? `${action} (outcome ${outcome})`;
      },
      meshBrief(assessments): string {
        // The observer is labelled as one: an unlabelled fourth "vote" would
        // read to the model as a counted dissent, which it is not.
        const views = Object.entries(assessments)
          .map(([agent, assessment]) => {
            const who = desks.get(agent)?.label ?? agent;
            return agent === "e-watcher"
              ? `- ${who} has no vote, but would have said ${assessment.verdict}: ${assessment.rationale}`
              : `- ${who} voted ${assessment.verdict}: ${assessment.rationale}`;
          })
          .join("\n");
        return `The three schools have voted on whether to close. They said:\n${views}\n\nWork out why they disagreed.`;
      },
    },
  });

  return {
    ...result,
    question: QUESTION,
    desks: Object.fromEntries(desks),
    labels: { ...SILENT_SEATS, ...Object.fromEntries([...desks].map(([agent, desk]) => [agent, desk.label])) },
  };
}
