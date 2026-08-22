/**
 * ADR-0019 gate — acting on a decision.
 *
 * Scenario 11's 06:00 message: the party that must send it is the one party
 * that must not vote, the rulebook it acts under was pinned in the proposal
 * before anyone voted, and the record has to hold all of that without ever
 * letting the actuator near the electorate.
 *
 * The case worth reading first is G6. ADR-0018 shipped a guard saying a
 * `no-decision` round could not be acted on; grounding this ADR in ADR-0010
 * Decision 4 showed that guard was the parked-application failure wearing a
 * safety hat. G6 is the amendment demonstrated: a round that failed to decide
 * still releases its actuator, through the policy's reserved key.
 *
 *   node --experimental-sqlite --test test/adr0019.test.ts
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import type { JsonValue } from "../src/crypto/jcs.ts";
import { castVote, enroll, NO_DECISION, type Envelope } from "../src/hub/activities.ts";
import { decisionActionStamp, admissibleAction } from "../src/allocation/actions.ts";
import { NO_DECISION_CATEGORY, validateProposalActionPolicy } from "../src/ap/pins.ts";
import { exportBundle } from "../src/export.ts";
import { vouch } from "../src/ap/activities.ts";
import { cleanupWorkspaces, mutateBundle, runVerifier, testHub, testInstance } from "./helpers.ts";
import { VERIFIER } from "./adr0010-fixtures.ts";

after(cleanupWorkspaces);

const CAPABILITY = "afp:cap:assess";
/** Three heads decide; `notify` carries the decision out and never votes. */
const AGENTS = ["head", "s-head", "e-head", "notify"] as const;

/** The rulebook, pinned in the proposal before any vote exists. */
const POLICY = {
  yes: "send-closure-message",
  no: "send-open-message",
  [NO_DECISION_CATEGORY]: "send-undecided-message",
} as const;

function bridge() {
  const { instance, config, clock } = testInstance([...AGENTS], CAPABILITY);
  const { hub } = testHub(instance, [...AGENTS], "bus-bridge");
  const enrollThread = `${config.origin}/threads/enroll`;
  for (const agent of AGENTS) {
    hub.receive(
      instance.publishAsInstance([hub.actorId], enrollThread, "hub", (envelope) =>
        enroll(envelope, {
          agent: instance.actorId(agent),
          hub: hub.actorId,
          capabilities: [CAPABILITY],
          hubKey: `${instance.actorId(agent)}#hub-bus-bridge`,
          // The whole point of the role: reads everything, decides nothing.
          role: agent === "notify" ? "actuator" : "member",
        }),
      ).activity,
    );
  }
  return { instance, config, clock, hub, thread: `${config.origin}/threads/snow` };
}

/** Publish a raw-bodied activity as `name`, addressed to the hub, `hub` visibility. */
function publish(t: ReturnType<typeof bridge>, name: string, body: { [key: string]: unknown }) {
  return t.instance.publish(name, [t.hub.actorId], t.thread, "hub", (envelope: Envelope) => ({
    "@context": ["https://www.w3.org/ns/activitystreams", "https://dalager.github.io/agent-federation-protocol/ns/v3.jsonld"],
    id: envelope.activityId,
    actor: envelope.actor,
    to: [...envelope.to],
    published: envelope.published,
    context: envelope.thread,
    "afp:visibility": envelope.visibility,
    ...(envelope.prevActivity !== null ? { "afp:prevActivity": envelope.prevActivity } : {}),
    ...body,
  }) as never);
}

/**
 * Run one round to a decision. `votes` maps agent → ballot; the electorate is
 * the three heads, since `notify` is an actuator and can never be pinned.
 */
function decide(
  t: ReturnType<typeof bridge>,
  name: string,
  votes: Readonly<Record<string, string>>,
  extra: { quorumRule?: { "afp:form": "majority-of-total" } } = {},
) {
  const round = `${t.config.origin}/rounds/${name}`;
  const proposal = t.hub.proposeRound({
    round,
    thread: t.thread,
    question: "Close all three schools today?",
    options: ["yes", "no"],
    pins: { actionPolicy: POLICY, irrevocableActions: ["send-closure-message", "send-open-message"] },
    ...extra,
  });
  const snapshot = String((proposal.activity.object as Record<string, unknown>)["afp:quorumSnapshot"]);
  for (const [agent, value] of Object.entries(votes)) {
    t.hub.receive(
      publish(t, agent, {
        type: "Create",
        object: {
          id: `${t.instance.actorId(agent)}/votes/${name}`,
          type: "afp:Vote",
          "afp:hub": t.hub.actorId,
          "afp:round": round,
          "afp:proposalHash": proposal.digest,
          "afp:quorumSnapshot": snapshot,
          value,
        },
      }).activity,
    );
  }
  const decision = t.hub.closeRound(round);
  return {
    round,
    proposal,
    decision,
    outcome: String((decision.activity.object as Record<string, JsonValue>)["afp:outcome"]),
  };
}

function exportOf(t: ReturnType<typeof bridge>) {
  t.instance.publishAsInstance([], `${t.config.origin}/threads/roster`, "public", (envelope) =>
    vouch(envelope, { agent: t.hub.actorId, capabilities: ["afp:cap:hub"], keyCustody: "self" }),
  );
  return exportBundle(t.instance, t.config.exportDir, [t.hub]);
}

describe("ADR-0019 Decisions 1 & 3 — the proposal is the rulebook, and the actor is checked", () => {
  it("G1 — an actuator carries out a decided round, under the policy the round pinned", () => {
    const t = bridge();
    const { proposal, decision, outcome } = decide(t, "decided", {
      head: "no",
      "s-head": "no",
      "e-head": "yes",
    });
    assert.equal(outcome, "no");

    const pinned = proposal.activity.object as Record<string, JsonValue>;
    assert.deepEqual(pinned["afp:actionPolicy"], POLICY, "the rulebook is on the proposal, pre-vote");

    // The category IS the outcome — there is no Synthesis here to carry one.
    publish(t, "notify", {
      type: "Create",
      object: { id: `${t.config.origin}/acts/notify-1`, type: "afp:Act", content: "all three schools open as normal" },
      ...decisionActionStamp("send-open-message", decision.digest, { policy: POLICY, outcome }),
    });

    exportOf(t);
    const clean = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.equal(clean.code, 0, `verifier failed:\n${clean.output}`);
    assert.match(clean.output, /acts on a producible justification/);
    assert.match(clean.output, /admissible under the round's pinned policy/);
    assert.match(clean.output, /actor is enrolled in the deciding hub/);
    t.instance.close();
  });

  it("the writer refuses an action its own round never admitted", () => {
    assert.equal(admissibleAction(POLICY, "no"), "send-open-message");
    assert.throws(
      () => decisionActionStamp("send-closure-message", "sha256:x", { policy: POLICY, outcome: "no" }),
      /not admissible/,
      "claiming the other outcome's action is refused before it can be signed",
    );
  });

  it("G2 — an action the pinned policy does not admit for that outcome fails replay", () => {
    const t = bridge();
    const { decision, outcome } = decide(t, "decided", { head: "no", "s-head": "no", "e-head": "yes" });
    publish(t, "notify", {
      type: "Create",
      object: { id: `${t.config.origin}/acts/notify-1`, type: "afp:Act", content: "…" },
      ...decisionActionStamp("send-open-message", decision.digest, { policy: POLICY, outcome }),
    });
    exportOf(t);

    const mutated = mutateBundle(VERIFIER, t.config.exportDir, t.thread, "notify", (outbox) => {
      for (const item of outbox.orderedItems) {
        if (item["afp:actsOn"]) item["afp:action"] = "send-closure-message";
      }
    });
    assert.notEqual(mutated.code, 0, "sending the closure message on an 'open' decision must fail");
    assert.match(mutated.output, /admissible under the round's pinned policy/);
    t.instance.close();
  });

  it("G3 — an action by an agent enrolled in no hub fails replay", () => {
    const t = bridge();
    const { decision, outcome } = decide(t, "decided", { head: "no", "s-head": "no", "e-head": "yes" });
    // `outsider` is rostered on this instance and enrolled in no hub at all —
    // a well-formed action from a stranger to the decision.
    const outsider = testInstance(["outsider"], CAPABILITY);
    outsider.instance.close();

    publish(t, "notify", {
      type: "Create",
      object: { id: `${t.config.origin}/acts/notify-1`, type: "afp:Act", content: "…" },
      ...decisionActionStamp("send-open-message", decision.digest, { policy: POLICY, outcome }),
    });
    exportOf(t);

    const mutated = mutateBundle(VERIFIER, t.config.exportDir, t.thread, "notify", (outbox) => {
      for (const item of outbox.orderedItems) {
        if (!item["afp:actsOn"]) continue;
        // Re-point the action at an agent the Enroll trail never seated.
        item.actor = `${t.config.origin}/agents/outsider`;
      }
    });
    assert.notEqual(mutated.code, 0);
    assert.match(mutated.output, /actor is enrolled in the deciding hub|is not on the roster/);
    t.instance.close();
  });
});

describe("ADR-0019 Decision 2 — the actuator reads everything and decides nothing", () => {
  it("G7 — an actuator is never pinned into a quorum snapshot", () => {
    const t = bridge();
    const { proposal, decision } = decide(t, "decided", { head: "yes", "s-head": "yes", "e-head": "yes" });
    const voters = (proposal.activity.object as Record<string, JsonValue>)["afp:voters"] as string[];
    assert.equal(voters.length, 3, "three heads, and the notification desk is not among them");
    assert.ok(!voters.includes(t.instance.actorId("notify")), "an actuator can never appear in afp:voters");

    publish(t, "notify", {
      type: "Create",
      object: { id: `${t.config.origin}/acts/notify-1`, type: "afp:Act", content: "…" },
      ...decisionActionStamp("send-closure-message", decision.digest, { policy: POLICY, outcome: "yes" }),
    });
    exportOf(t);
    const clean = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.equal(clean.code, 0, `verifier failed:\n${clean.output}`);
    // ADR-0018's own check still holds with a fourth role in the vocabulary.
    assert.match(clean.output, /pinned voters are member-role agents/);
    t.instance.close();
  });

  it("G4 — an actuator publishing anything but an actuation fails replay", () => {
    const t = bridge();
    decide(t, "decided", { head: "no", "s-head": "no", "e-head": "yes" });
    // No `afp:actsOn`: an ordinary Result, on a hub thread, from the one role
    // whose entire warrant is carrying decisions out.
    publish(t, "notify", {
      type: "Create",
      object: {
        id: `${t.config.origin}/results/notify-opinion`,
        type: "afp:Result",
        "afp:correlationId": "opinion",
        content: "for what it is worth, I would have closed",
        attributedTo: t.instance.actorId("notify"),
      },
    });
    exportOf(t);

    const report = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.notEqual(report.code, 0, "an actuator's opinion is not an actuation");
    assert.match(report.output, /actuator publishes only actuation activities/);
    t.instance.close();
  });
});

describe("ADR-0019 — the pinned policy must answer every outcome", () => {
  it("G5 — a policy that cannot answer one of its own outcomes is refused at pin time", () => {
    const t = bridge();
    assert.throws(
      () => validateProposalActionPolicy({ yes: "a", [NO_DECISION_CATEGORY]: "c" }, ["yes", "no"]),
      /no/,
      "an option with no admissible action leaves the actuator parked on that outcome",
    );
    assert.throws(
      () => validateProposalActionPolicy({ yes: "a", no: "b" }, ["yes", "no"]),
      /no-decision/,
      "and a round that fails to decide must still release whoever was waiting",
    );
    assert.throws(
      () =>
        t.hub.proposeRound({
          round: `${t.config.origin}/rounds/bad`,
          thread: t.thread,
          question: "q?",
          options: ["yes", "no"],
          pins: { actionPolicy: { yes: "a", [NO_DECISION_CATEGORY]: "c" } },
        }),
      /no/,
      "the hub refuses to sign a rulebook with a hole in it",
    );
    t.instance.close();
  });
});

describe("ADR-0019 — composing with ADR-0018", () => {
  it("G6 — a round that failed to decide still releases its actuator (ADR-0018 W6, amended)", () => {
    const t = bridge();
    // Two of three vote, one for each option, one head silent: nothing clears
    // a majority of the pinned total, so ADR-0018 closes this afp:no-decision.
    const { decision, outcome } = decide(
      t,
      "undecided",
      { head: "yes", "s-head": "no" },
      { quorumRule: { "afp:form": "majority-of-total" } },
    );
    assert.equal(outcome, NO_DECISION, "the round did not decide");

    // The 06:00 message still has to go out. The reserved key is what makes
    // that admissible rather than improvised.
    publish(t, "notify", {
      type: "Create",
      object: {
        id: `${t.config.origin}/acts/notify-undecided`,
        type: "afp:Act",
        content: "no decision reached; schools open, watch for a further message",
      },
      ...decisionActionStamp("send-undecided-message", decision.digest, { policy: POLICY, outcome }),
    });

    exportOf(t);
    const clean = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.equal(clean.code, 0, `verifier failed:\n${clean.output}`);
    assert.match(clean.output, /admissible under the round's pinned policy/);
    t.instance.close();
  });

  it("G8 — a governance thread has no task-bearing activity, and that is not a redaction hole", () => {
    const t = bridge();
    const { decision, outcome } = decide(t, "decided", { head: "no", "s-head": "no", "e-head": "yes" });
    publish(t, "notify", {
      type: "Create",
      object: { id: `${t.config.origin}/acts/notify-1`, type: "afp:Act", content: "…" },
      ...decisionActionStamp("send-open-message", decision.digest, { policy: POLICY, outcome }),
    });
    exportOf(t);

    const clean = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.equal(clean.code, 0, `verifier failed:\n${clean.output}`);
    // ADR-0010 Decision 5 asks whether the rules an answer was judged under
    // travelled with it. For a round, the proposal IS that carrier.
    assert.doesNotMatch(clean.output, /discloses an answer with the pins it was judged under/);
    t.instance.close();
  });
});
