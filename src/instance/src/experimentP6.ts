/**
 * The P6 Lemonade experiment: the same five-member pool, the same equivocation,
 * the same backup-restore — but the underwriters deciding are real models
 * reading real exposure statements and a real met bulletin, instead of a
 * scripted split.
 *
 * The scenario is a parametric reinsurance trigger. Five reinsurers share one
 * contract: if Storm Dagmar crossed two pinned thresholds, four thousand
 * policyholders are paid automatically, with no loss adjuster and no argument.
 * The determination is one jointly ratified finding, and every member's
 * exposure to it is different, on the record, and known to everyone.
 *
 * The point of using models here is the same as the snow day's, one layer up:
 * **the disagreement has to be real.** The met office bulletin is genuinely
 * ambiguous on one of the two pinned parameters — the reference station's
 * 10-minute sustained wind sat a hair under the trigger while the gusts sailed
 * over it — and each underwriter reads that bulletin next to its own book. A
 * demo where everyone votes yes never tests the count, and a doomed round
 * needs a count worth testing.
 *
 * What is scripted, and honestly labelled as such:
 *
 *  - **Meridian's equivocation.** A model cannot be asked to defect, so the
 *    demo signs the *contradicting* half itself, at the same
 *    `(actor, round, phase, seqNo)`. Meridian's own determination is not
 *    scripted: the first half carries whatever its model actually concluded,
 *    and the scripted half is that answer's negation — so the verdict printed
 *    beside its name is one the record really carries. What happens
 *    afterwards is not scripted either: the hub recomputes `convicts()` on
 *    the two signed objects and reaches its own conclusion.
 *  - **Anchor's disk failure.** Also scripted, for the same reason, and it is
 *    the whole point of the row: on the wire it is the identical shape, and
 *    the record has to tell them apart without being told which is which.
 *
 * Everything else — who votes which way, whether the round is provably
 * doomed, what the actuator ends up instructed to do — falls out of what the
 * models actually say.
 *
 * Fails loudly rather than falling back: an experiment that quietly reverts to
 * scripted content would be reporting on nothing.
 */

import { NO_DECISION_CATEGORY } from "./ap/pins.ts";
import type { LlmEndpoint } from "./brains/openai.ts";
import { checkEndpoint, makeLlmBrain } from "./brains/openai.ts";
import {
  ACTION_POLICY,
  GOVERNANCE_OPTIONS,
  QUESTION,
  runP6Demo,
  type P6Assessment,
  type P6DemoResult,
} from "./demoP6.ts";

const CAPABILITY = "afp:cap:assess";

// The question and the action names come from the demo that signs them. They
// were restated here once, which is one edit away from a narration describing
// a round the record never opened.
export { QUESTION } from "./demoP6.ts";

/**
 * The met office bulletin, identical for everyone — this is the shared fact
 * base, and it is the contract's own reference station. It is ambiguous on
 * purpose, in exactly the way real parametric triggers are: one pinned
 * parameter cleared cleanly, the other sat inside the instrument's own error
 * bar. Nobody is being asked to guess; they are being asked to say what they
 * can justify.
 */
const BULLETIN = [
  "MET OFFICE — STORM DAGMAR, POST-EVENT BULLETIN (final)",
  "Reference station: Windward Point (the station named in the contract)",
  "",
  "The contract triggers only if BOTH pinned parameters were crossed:",
  "  P1  minimum central pressure at or below 960.0 hPa",
  "  P2  maximum 10-minute SUSTAINED wind at or above 32.0 m/s",
  "",
  "Measured at Windward Point:",
  "  P1  central pressure       957.4 hPa      (clears the threshold by 2.6 hPa)",
  "  P2  10-minute sustained    31.6 m/s       (0.4 m/s UNDER the threshold)",
  "      peak 3-second gust     41.2 m/s       (the contract does not name gusts)",
  "",
  "Instrument note: the Windward Point anemometer carries a stated accuracy of",
  "+/- 0.5 m/s, so 31.6 m/s does not separate from 32.0 m/s at this instrument's",
  "own resolution. The station logged no dropouts.",
  "Landfall track passed within the contract's named corridor.",
  "",
  "CONTRACT CLAUSE 7(c), reproduced here because it bears on P2:",
  "  'Where the reference station's P2 reading falls within its stated instrument",
  "   accuracy of the threshold, the parties SHALL have regard to any calibrated",
  "   secondary record of the same ten-minute window.'",
  "  The met office holds no secondary record. Members may hold their own.",
].join("\n");

export interface Desk {
  /** Local agent name, as seated on the windward hub. Protocol-side identity. */
  agent: string;
  operator: string;
  /** Who this is, in words a claims director would use. Narration-side identity. */
  label: string;
  /** One sentence of whose desk this is — becomes the model's persona. */
  persona: string;
  /** This member's own book: what a yes costs it, and what a no costs it. */
  exposure: string;
  /**
   * What this member, and only this member, holds on clause 7(c) — the
   * calibrated secondary record the met office does not have. This is the
   * snow day's lesson one layer up: a shared fact base alone produces
   * unanimity, and a count that is never contested is never tested. Here the
   * split is a property of who kept which instrument, not something written
   * in to make the demo interesting.
   */
  privateRecord: string;
}

/**
 * The pool, and the exposures the standing contract pins. Everyone can read
 * everyone's incentive — that is the difference between this scenario and the
 * snow day, where nobody could verify anybody's evidence. Here the record
 * knows exactly who benefits from every outcome, including the outcome of no
 * outcome.
 */
const DESKS: readonly Desk[] = [
  {
    agent: "atl-uw",
    operator: "atlas",
    label: "Atlas Re — underwriter (hosts the hub)",
    persona: "the underwriter at Atlas Re",
    exposure: [
      "ATLAS RE — our position on this trigger",
      "",
      "- We pay 18m on a yes. It is a moderate hit and it is fully reserved.",
      "- We host the pool's hub. We gain nothing from any particular answer and we",
      "  are the member most likely to be blamed for a messy one.",
      "- Our reinsurance auditors will read this determination line by line.",
    ].join("\n"),
    privateRecord: [
      "ATLAS RE — what we hold on clause 7(c)",
      "",
      "- Nothing. We keep no instrument of our own anywhere near the corridor.",
      "- So for us clause 7(c) has nothing to have regard to, and P2 rests on the",
      "  reference station's own number.",
    ].join("\n"),
  },
  {
    agent: "mer-uw",
    operator: "meridian",
    label: "Meridian Re — underwriter",
    persona: "the underwriter at Meridian Re",
    exposure: [
      "MERIDIAN RE — our position on this trigger",
      "",
      "- We pay 24m on a yes.",
      "- If the round reaches NO DECISION, our retrocession contract moves the whole",
      "  dispute to arbitration, on terms our own counsel drafted. Our modelled",
      "  recovery there is materially better than either a yes or a no here.",
      "- In other words: of the three ways this can end, the one that pays us best",
      "  is the one where the pool fails to answer at all.",
    ].join("\n"),
    privateRecord: [
      "MERIDIAN RE — what we hold on clause 7(c)",
      "",
      "- Nothing calibrated. We have a rooftop unit 40 km inland; it is not",
      "  calibrated and it is nowhere near the corridor, so it is not a 7(c) record.",
    ].join("\n"),
  },
  {
    agent: "pel-uw",
    operator: "pelican",
    label: "Pelican Re — underwriter",
    persona: "the underwriter at Pelican Re",
    exposure: [
      "PELICAN RE — our position on this trigger",
      "",
      "- We pay 71m on a yes. It is the largest single exposure in the pool and it",
      "  would be our worst quarter in nine years.",
      "- We pay nothing on a no.",
      "- Our own reading of the contract wording has always been that P2 means",
      "  sustained wind and nothing else, because that is what it says.",
    ].join("\n"),
    privateRecord: [
      "PELICAN RE — what we hold on clause 7(c)",
      "",
      "- We run a calibrated met mast 4 km inland of the corridor. Over the same",
      "  ten-minute window it recorded 30.9 m/s sustained.",
      "- Calibration certificate is current; the mast is 4 km from the reference",
      "  station and slightly more sheltered.",
      "- Read with the reference station's 31.6, our record points the same way.",
    ].join("\n"),
  },
  {
    agent: "anc-uw",
    operator: "anchor",
    label: "Anchor Syndicate — underwriter",
    persona: "the underwriter at Anchor Syndicate",
    exposure: [
      "ANCHOR SYNDICATE — our position on this trigger",
      "",
      "- We pay 6m on a yes. Small, and priced for.",
      "- We have no position worth defending either way, which is roughly why the",
      "  pool put us on the drafting committee for the parametric wording.",
      "- Our infrastructure is having a bad week; our primary node is unreliable.",
    ].join("\n"),
    privateRecord: [
      "ANCHOR SYNDICATE — what we hold on clause 7(c)",
      "",
      "- No instrument. What we have is the drafting committee's minute from when",
      "  this wording was agreed, which we kept because we sat on that committee:",
      "  '7(c) was added so that a reading inside the error bar is not treated as a",
      "   miss by default. It is not a licence to substitute a friendlier station.'",
      "- We have never had to apply it before.",
    ].join("\n"),
  },
  {
    agent: "har-uw",
    operator: "harbor",
    label: "Harbor Mutual — underwriter",
    persona: "the underwriter at Harbor Mutual",
    exposure: [
      "HARBOR MUTUAL — our position on this trigger",
      "",
      "- We RECEIVE 31m on a yes: we are the ceding side of this layer.",
      "- We receive nothing on a no.",
      "- We are aware that this makes us the member with the most obvious reason to",
      "  want a yes, and that everyone else can read that too.",
    ].join("\n"),
    privateRecord: [
      "HARBOR MUTUAL — what we hold on clause 7(c)",
      "",
      "- The port authority's anemometer sits 1.2 km from Windward Point, on the",
      "  same exposed headland, and we hold its log because we underwrite the port.",
      "- Over the identical ten-minute window it recorded 33.1 m/s sustained.",
      "- It was calibrated five weeks ago; the certificate is attached to the log.",
      "- We are aware of how this looks coming from us. The log is the log.",
    ].join("\n"),
  },
];

/**
 * The reply format, verbatim. Kept on its own lines rather than folded into a
 * paragraph: a small local model follows a two-line template it can see the
 * shape of, and stops following one that has been flattened into prose.
 */
/** The seat question's own two-line template — `yes` expels, and it says so. */
const REPLY_FORMAT_SEAT = [
  "Reply with exactly two lines and nothing else:",
  "VERDICT: expel",
  "BECAUSE: <one sentence, under 25 words, giving the reason a fellow member would have to answer>",
  "Write 'keep' instead of 'expel' to let the member keep its seat.",
].join("\n");

const REPLY_FORMAT = [
  "Reply with exactly two lines and nothing else:",
  "VERDICT: yes",
  "BECAUSE: <one sentence, under 25 words, naming the one measurement that decided it>",
  "Write 'no' instead of 'yes' on the VERDICT line if the pinned thresholds were not both crossed.",
].join("\n");

/**
 * The governance question (ADR-0021 Decision 4b). A different question from the
 * determination, asked of the same desks: not "what do the measurements say"
 * but "what do we do about a member we have just proved equivocated, who says
 * its key was captured".
 *
 * Deliberately not loaded either way. A model told the claim is worthless
 * votes to expel every time and the round stops testing anything; a model told
 * to be merciful never expels. It is given the proof, the claim, and its own
 * book, and asked what it can justify — which is the same standard the
 * determination itself was asked to meet.
 */
function judgePrompt(desk: Desk): string {
  return (
    [
      `You are ${desk.persona}.`,
      "The pool has proved — cryptographically, and anyone can recompute it — that one member",
      "signed two contradicting ballots in the determination that just failed. That member's",
      "weight is already zero; nobody voted on that and nobody had to. What you are voting on",
      "now is whether it keeps its seat in the pool at all.",
      "Its operator says the signing key was captured. That statement is on the record and it",
      "is not evidence: nothing about it can be checked. It is also not nothing.",
      "You are being asked what you can justify to the other members, not what your book would",
      "prefer. Your vote is signed with your name on it and the accused is recused from this",
      "round, so it cannot vote on its own seat.",
    ].join(" ") + `\n\n${REPLY_FORMAT_SEAT}`
  );
}

function deskPrompt(desk: Desk): string {
  return (
    [
      `You are ${desk.persona}.`,
      "The pool is making one determination together, and it is wired to money: if the",
      "answer is yes, four thousand policyholders are paid automatically.",
      `The question is exactly this: ${QUESTION}`,
      "The contract triggers only if BOTH pinned parameters were crossed. You are being",
      "asked what the measurements support, not what your book would prefer — every other",
      "member can read your exposure, and this determination is signed with your name on",
      "it. If one threshold was not crossed, say no, even where a yes would suit you. If",
      "both were crossed, say yes, even where a yes is expensive.",
      "You have been given three things: the met office bulletin, which every member has;",
      "your own book; and whatever your own desk holds under clause 7(c), which the others",
      "cannot see. Reason from those and do not invent what anyone else is holding.",
    ].join(" ") + `\n\n${REPLY_FORMAT}`
  );
}

const encoder = new TextEncoder();

async function ask(
  endpoint: LlmEndpoint,
  desk: Desk,
  question: { system: string; content: string; attachments: readonly string[] },
): Promise<{ text: string; producedBy: string }> {
  const brain = makeLlmBrain(desk.agent, [CAPABILITY], question.system, endpoint);
  const outcome = await brain.handle({
    capability: CAPABILITY,
    content: question.content,
    attachments: question.attachments.map((text) => ({
      mediaType: "text/markdown",
      bytes: encoder.encode(text),
    })),
    thread: "",
  });
  if (!outcome.ok) throw new Error(`model call for ${desk.agent} failed: ${outcome.reason}`);
  return { text: outcome.content, producedBy: outcome.producedBy ?? endpoint.model };
}

/**
 * Read the two lines back. A verdict that cannot be read is an error, never a
 * silent default: guessing here would put an unearned value in a count that is
 * wired to a payment.
 */
function parseVerdict(
  text: string,
  agent: string,
  options: readonly string[] = ["yes", "no"],
): { verdict: string; rationale: string } {
  const verdictLine = text.split("\n").find((line) => /^\s*\**VERDICT/i.test(line));
  const match = verdictLine ? new RegExp(`\\b(${options.join("|")})\\b`, "i").exec(verdictLine) : null;
  if (!match) throw new Error(`${agent} returned no readable VERDICT line:\n${text.slice(0, 300)}`);

  const becauseLine = text.split("\n").find((line) => /^\s*\**BECAUSE/i.test(line)) ?? "";
  const rationale = becauseLine
    .replace(/^\s*\**BECAUSE\**\s*:?\s*/i, "")
    .replace(/\**\s*$/, "")
    .trim();

  return { verdict: match[1].toLowerCase(), rationale: rationale || "(no reason given)" };
}

export interface P6ExperimentResult extends P6DemoResult {
  question: string;
  bulletin: string;
  /** Agent name → the desk behind it, so narration can use names not agent ids. */
  desks: Record<string, Desk>;
  /** Every seat's human label, including the actuator that never votes. */
  labels: Record<string, string>;
}

/** Seats that hold no book and cast no vote, but appear in the record. */
const SILENT_SEATS: Record<string, string> = {
  // ADR-0019's actuator: reads everything, decides nothing, and is the only
  // seat allowed to publish the activity that moves money.
  "atl-pay": "Atlas Re's payments desk (actuator)",
};

export async function runP6Experiment(
  options: { endpoint: LlmEndpoint; rootDir?: string; exportRoot?: string },
): Promise<P6ExperimentResult> {
  const problem = await checkEndpoint(options.endpoint);
  if (problem) throw new Error(`brain endpoint unavailable: ${problem}`);

  const desks = new Map<string, Desk>(DESKS.map((desk) => [desk.agent, desk]));

  const result = await runP6Demo({
    rootDir: options.rootDir ?? "./data-p6-llm",
    exportRoot: options.exportRoot ?? "./export-p6-llm",
    content: {
      async assess(_operator, agent): Promise<P6Assessment> {
        const desk = desks.get(agent)!;
        const { text, producedBy } = await ask(options.endpoint, desk, {
          system: deskPrompt(desk),
          content: `${QUESTION}\n\nThe bulletin, and your own book:`,
          attachments: [BULLETIN, desk.exposure, desk.privateRecord],
        });
        return { ...parseVerdict(text, agent), producedBy, content: text };
      },
      /**
       * The seat question (ADR-0021 Decision 4b). The same desks, weighing the
       * proof against the accused operator's statement about it — and the
       * accused is not among them, because the round recused it by a cause the
       * record resolves.
       */
      async judge(_operator, agent, dossier): Promise<P6Assessment> {
        const desk = desks.get(agent)!;
        const { text, producedBy } = await ask(options.endpoint, desk, {
          system: judgePrompt(desk),
          content: "Does this member keep its seat in the pool?\n\nThe case, and your own book:",
          attachments: [dossier, desk.exposure],
        });
        return { ...parseVerdict(text, agent, GOVERNANCE_OPTIONS), producedBy, content: text };
      },
      /**
       * The payment instruction itself (ADR-0019). The desk that carries it
       * out has no vote and never had one; the action it may take was fixed by
       * the round before anyone voted, and all it supplies is the wording.
       */
      notice(outcome, action): string {
        // Keyed off the round's own pinned policy rather than off restated
        // string literals: if the demo ever renames an action, this map fails
        // to compile instead of silently falling through to the `${action}`
        // default and printing a placeholder where the money instruction goes.
        const wording: Record<(typeof ACTION_POLICY)[keyof typeof ACTION_POLICY], string> = {
          [ACTION_POLICY.yes]:
            "Trigger determined. Releasing the parametric payment to all 4,000 covered policyholders today.",
          [ACTION_POLICY.no]:
            "Thresholds not crossed. The file is closed with no payment; policyholders are notified of the measurements.",
          [ACTION_POLICY[NO_DECISION_CATEGORY]]:
            "The pool could not reach a determination. The file goes to the arbitration panel; no payment is released today.",
        };
        return wording[action as keyof typeof wording] ?? `${action} (outcome ${outcome})`;
      },
    },
  });

  return {
    ...result,
    question: QUESTION,
    bulletin: BULLETIN,
    desks: Object.fromEntries(desks),
    labels: { ...SILENT_SEATS, ...Object.fromEntries([...desks].map(([agent, desk]) => [agent, desk.label])) },
  };
}
