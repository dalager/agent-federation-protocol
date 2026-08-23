/**
 * The P7 Lemonade experiment: the same four desks, the same quarter, the same
 * arithmetic — but the judgements are made by real models reading real tickets
 * and their own desk's part in them, instead of a scripted table.
 *
 * **What a model is allowed to decide here, and what it is not, is the whole
 * design of this file.** Every other experiment in this repository hands the
 * model the value that lands on the record: a bid, a verdict, a vote. P7 cannot
 * do that with its central object, because a contribution summary anybody has
 * to take on trust is precisely the thing the phase exists to abolish. The
 * numbers are recomputed by two implementations from signed evidence, and no
 * model touches them.
 *
 * So the models are given the three judgements the record genuinely cannot
 * derive:
 *
 *  - **What the desk did.** The account of the work, which becomes the Result's
 *    content — narration that the record carries but never computes over.
 *  - **How a shared ticket divides.** Dayshift triaged it, Kestrel fixed it,
 *    and how much of it is whose is a *claim*, not a fact. The protocol's
 *    contribution is to make the claim explicit, signed, integer, and checkable
 *    against exactly the authors it names — not to settle it.
 *  - **Whether the quarter's summary stands.** Every voter can already
 *    recompute the numbers, so the question a desk actually answers is whether
 *    the *frame* is right: the period, the scope summed, what was counted
 *    unreadable, and the membership change inside it.
 *
 * The interesting result, and the one worth watching for on a run: the desks
 * argue — about the split, sometimes about the frame — and the arithmetic does
 * not move. A disagreement about a judgement stays a disagreement about a
 * judgement, rather than becoming two irreconcilable numbers.
 *
 * Fails loudly rather than falling back: an experiment that quietly reverts to
 * scripted content would be reporting on nothing.
 */

import type { LlmEndpoint } from "./brains/openai.ts";
import { checkEndpoint, makeLlmBrain } from "./brains/openai.ts";
import { runP7Demo, type P7Content, type P7DemoResult, type P7Judgement } from "./demoP7.ts";

const CAPABILITY = "afp:cap:support";

/** The tickets, as a support desk would actually read them. */
const TICKETS: Record<string, string> = {
  "ticket-4390-late-september": [
    "TICKET 4390 — sessions dropping after the maintenance window",
    "Reported 30 September, 23:52. Customer's staff are signed out every few minutes since the",
    "overnight release. Reproduced on two accounts. Session store TTL was reset by the deploy.",
  ].join("\n"),
  "ticket-4471-payment-sync": [
    "TICKET 4471 — payment sync failing for one customer",
    "Reported 04:10. Card payments reconcile but bank transfers do not, for one merchant only.",
    "First desk narrowed it: the merchant's webhook receipts carry a stale idempotency key, so",
    "every retry is discarded as a duplicate. Second desk traced the key to a cached credential",
    "and cleared it. Roughly three hours of narrowing, forty minutes of fixing.",
  ].join("\n"),
  "ticket-4517-webhook-retries": [
    "TICKET 4517 — webhook retries exhausted for two accounts",
    "Reported 01:30. Two accounts stopped receiving delivery callbacks. Retry budget was consumed",
    "by a downstream 502 that has since cleared; the queue needed draining and the budget reset.",
  ].join("\n"),
  "ticket-4502-tax-export": [
    "TICKET 4502 — tax filing export rejected",
    "Reported 22:15. CONTAINS CUSTOMER DATA: the attached filing is the customer's own return.",
    "Export rejected by the tax authority's schema validator on a field the customer left blank.",
  ].join("\n"),
  "ticket-4488-login-loop": [
    "TICKET 4488 — login loop on the mobile client",
    "Reported 03:05. Mobile users bounce between the login screen and the app shell. Token refresh",
    "returns a token the client rejects as already expired; the clock on one edge node had drifted.",
  ].join("\n"),
};

export interface Desk {
  name: string;
  label: string;
  persona: string;
  /** What this desk is like, in the words its own people would use. */
  character: string;
}

const DESKS: readonly Desk[] = [
  {
    name: "northwind",
    label: "Northwind (hosts the queue)",
    persona: "the shift lead at Northwind Support",
    character: [
      "NORTHWIND — who we are",
      "",
      "- We host the queue and we take the largest share of the volume, including",
      "  most of the tickets that carry customer data.",
      "- We are the desk most likely to be blamed for a messy quarter and the one",
      "  least able to argue we did not see something.",
    ].join("\n"),
  },
  {
    name: "dayshift",
    label: "Dayshift",
    persona: "the shift lead at Dayshift Support",
    character: [
      "DAYSHIFT — who we are",
      "",
      "- We triage. We reproduce, narrow, and hand over; we rarely close a ticket",
      "  ourselves, and our entire contribution is the first half of somebody",
      "  else's work.",
      "- We are aware that this makes us the desk a naive ledger sees least of,",
      "  and that saying so about our own share looks exactly like special",
      "  pleading.",
    ].join("\n"),
  },
  {
    name: "kestrel",
    label: "Kestrel",
    persona: "the shift lead at Kestrel Support",
    character: [
      "KESTREL — who we are",
      "",
      "- Small and senior. We take the escalations nobody else can close, usually",
      "  after another desk has already spent hours narrowing them.",
      "- A fix that takes us forty minutes often takes somebody else three hours",
      "  of work to hand us.",
    ].join("\n"),
  },
  {
    name: "lantern",
    label: "Lantern",
    persona: "the shift lead at Lantern Support",
    character: [
      "LANTERN — who we are",
      "",
      "- Mid-sized, steady, and — as of six weeks into this quarter — no longer in",
      "  the pool. Our seat was ended by a vote of the other desks.",
      "- The work we did before that was accepted and settled at the time.",
    ].join("\n"),
  },
];

const encoder = new TextEncoder();

async function ask(
  endpoint: LlmEndpoint,
  agent: string,
  system: string,
  content: string,
  attachments: readonly string[],
): Promise<{ text: string; producedBy: string }> {
  const brain = makeLlmBrain(agent, [CAPABILITY], system, endpoint);
  const outcome = await brain.handle({
    capability: CAPABILITY,
    content,
    attachments: attachments.map((text) => ({ mediaType: "text/markdown", bytes: encoder.encode(text) })),
    thread: "",
  });
  if (!outcome.ok) throw new Error(`model call for ${agent} failed: ${outcome.reason}`);
  return { text: outcome.content, producedBy: outcome.producedBy ?? endpoint.model };
}

/** Read one labelled line back, or fail — never a silent default. */
function line(text: string, label: string, agent: string): string {
  const found = text.split("\n").find((l) => new RegExp(`^\\s*\\**${label}`, "i").test(l));
  if (!found) throw new Error(`${agent} returned no readable ${label} line:\n${text.slice(0, 300)}`);
  return found
    .replace(new RegExp(`^\\s*\\**${label}\\**\\s*:?\\s*`, "i"), "")
    .replace(/\**\s*$/, "")
    .trim();
}

const RESOLVE_FORMAT = [
  "Reply with exactly two lines and nothing else:",
  "FIX: <one sentence, under 20 words, saying what you did — this goes on the record>",
  "NOTE: <one sentence a colleague would read next to it>",
].join("\n");

const SPLIT_FORMAT = [
  "Reply with exactly two lines and nothing else:",
  "SHARES: <a>:<b>   (two whole numbers, first the desk that triaged, second the desk that fixed)",
  "BECAUSE: <one sentence, under 25 words, that the other desk would have to answer>",
].join("\n");

const RATIFY_FORMAT = [
  "Reply with exactly two lines and nothing else:",
  "VERDICT: stand",
  "BECAUSE: <one sentence, under 25 words, naming the part of the frame that decided it>",
  "Write 'reject' instead of 'stand' if this summary should not be the quarter's record.",
].join("\n");

export interface P7ExperimentResult extends P7DemoResult {
  tickets: P7DemoResult["tickets"];
  /** The ticket text every judgement was made against. */
  briefs: Record<string, string>;
  /** Desk name → the people behind it, for narration that reads like people. */
  labels: Record<string, string>;
}

export async function runP7Experiment(
  options: { endpoint: LlmEndpoint; rootDir?: string; exportRoot?: string },
): Promise<P7ExperimentResult> {
  const problem = await checkEndpoint(options.endpoint);
  if (problem) throw new Error(`brain endpoint unavailable: ${problem}`);

  const desks = new Map(DESKS.map((d) => [d.name, d]));

  const content: P7Content = {
    async resolve(ticket, deskName): Promise<P7Judgement> {
      const desk = desks.get(deskName)!;
      const { text, producedBy } = await ask(
        options.endpoint,
        deskName,
        `You are ${desk.persona}. You have just closed a support ticket out of hours. Write what ` +
          `you did, plainly, the way it would read in the record a customer's auditor may see.` +
          `\n\n${RESOLVE_FORMAT}`,
        "What did you do about this ticket?",
        [TICKETS[ticket] ?? ticket, desk.character],
      );
      return { content: line(text, "FIX", deskName), rationale: line(text, "NOTE", deskName), producedBy };
    },

    /**
     * The split. Deliberately asked of the desk that *fixed* it, and asked in
     * full knowledge that the answer is self-interested — every other desk can
     * read this claim, it is signed with the fixer's name on it, and the ledger
     * carries it forever. That is the entire enforcement the protocol offers on
     * a judgement it cannot derive, and it is worth watching a model behave
     * under it.
     */
    async split(ticket, authors) {
      const desk = desks.get("kestrel")!;
      const { text, producedBy } = await ask(
        options.endpoint,
        "kestrel",
        `You are ${desk.persona}. Two desks worked one ticket: another desk triaged it — reproduced ` +
          `it, narrowed it, and handed it over — and you fixed it. You must now state, on the shared ` +
          `record, how the credit for that ticket divides between the two of you, as whole numbers. ` +
          `Every other desk will read this claim, it is signed with your name, and it is what the ` +
          `quarter's retainer is split by. State what you can justify to the desk that handed it to ` +
          `you, not what flatters your own share.\n\n${SPLIT_FORMAT}`,
        "How does the credit for this ticket divide?",
        [TICKETS[ticket] ?? ticket, desk.character],
      );
      const raw = line(text, "SHARES", "kestrel");
      const match = /(\d+)\s*[:/]\s*(\d+)/.exec(raw);
      if (!match) throw new Error(`kestrel returned no readable SHARES pair: ${raw}`);
      const triage = Number(match[1]);
      const fixer = Number(match[2]);
      if (!Number.isInteger(triage) || !Number.isInteger(fixer) || triage < 1 || fixer < 1) {
        throw new Error(`shares must be whole numbers of at least 1, got ${raw}`);
      }
      return {
        shares: { [authors[0]]: triage, [authors[1]]: fixer },
        content: raw,
        rationale: line(text, "BECAUSE", "kestrel"),
        producedBy,
      };
    },

    async ratify(deskName, view) {
      const desk = desks.get(deskName)!;
      const { text, producedBy } = await ask(
        options.endpoint,
        deskName,
        `You are ${desk.persona}. The pool's quarter has been added up, and you can recompute every ` +
          `number in it yourself from the same signed record — so that is not what you are voting on. ` +
          `You are voting on whether this is the right account of the quarter: the period it covers, ` +
          `the work it was able to read, what it counted as unreadable, and the membership change ` +
          `inside it. Vote for what you can justify to the other desks.\n\n${RATIFY_FORMAT}`,
        "Does this summary stand as the quarter's record?",
        [view, desk.character],
      );
      const verdict = line(text, "VERDICT", deskName).toLowerCase();
      if (!/stand|reject/.test(verdict)) throw new Error(`${deskName} returned no readable VERDICT: ${verdict}`);
      return {
        stand: verdict.includes("stand"),
        content: verdict,
        rationale: line(text, "BECAUSE", deskName),
        producedBy,
      };
    },
  };

  const result = await runP7Demo({
    rootDir: options.rootDir ?? "./data-p7-llm",
    exportRoot: options.exportRoot ?? "./export-p7-llm",
    content,
  });

  return {
    ...result,
    briefs: TICKETS,
    labels: Object.fromEntries(DESKS.map((d) => [d.name, d.label])),
  };
}
