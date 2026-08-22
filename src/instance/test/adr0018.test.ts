/**
 * ADR-0018 gate — the round as a commitment.
 *
 * Scenario 11's morning in miniature: a round that has a bar to clear, a clock
 * it does not own, an outcome that binds parties who voted against it, and a
 * settlement the next day saying whether it was right.
 *
 * Every negative here is a *mutation* rather than a differently-built record,
 * because the question each one asks is "which check noticed" — an ADR whose
 * checks pass on clean bundles and say nothing on tampered ones has added
 * ceremony, not verification.
 *
 * The last case (G12) is the one that must never be dropped: a round built the
 * way every round was built before this ADR has to produce byte-identical
 * bytes and trigger none of the new checks. Additive is a claim; that case is
 * the evidence.
 *
 *   node --experimental-sqlite --test test/adr0018.test.ts
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import type { JsonValue } from "../src/crypto/jcs.ts";
import { digestOf } from "../src/crypto/proof.ts";
import { castVote, departure, enroll, NO_DECISION } from "../src/hub/activities.ts";
import { settleDecision } from "../src/allocation/activities.ts";
import { thresholdOf } from "../src/hub/quorum.ts";
import { exportBundle } from "../src/export.ts";
import { vouch } from "../src/ap/activities.ts";
import { cleanupWorkspaces, mutateBundle, runVerifier, testHub, testInstance } from "./helpers.ts";
import { VERIFIER } from "./adr0010-fixtures.ts";

after(cleanupWorkspaces);

const CAPABILITY = "afp:cap:assess";
const AGENTS = ["head", "caretaker", "s-head", "e-head"] as const;

/**
 * Four seats on one hub, every weight 1 (one instance, four pinned voters —
 * `lcm(4)/4`), so the pinned total is 4 and `majority-of-total` is 3. The
 * arithmetic is deliberately small enough to check by eye in the assertions.
 */
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
        }),
      ).activity,
    );
  }
  return { instance, config, clock, hub, thread: `${config.origin}/threads/snow` };
}

interface RoundOptions {
  quorumRule?: Parameters<typeof thresholdOf>[0];
  deadline?: string;
  binding?: "joint";
  votes: Readonly<Partial<Record<(typeof AGENTS)[number], string>>>;
}

/** Open a round, cast the given ballots, close it, and export the bundle. */
function runRound(t: ReturnType<typeof bridge>, name: string, options: RoundOptions) {
  const round = `${t.config.origin}/rounds/${name}`;
  const proposal = t.hub.proposeRound({
    round,
    thread: t.thread,
    question: "Close all three schools today?",
    options: ["yes", "no"],
    ...(options.quorumRule ? { quorumRule: options.quorumRule } : {}),
    ...(options.deadline ? { deadline: options.deadline } : {}),
    ...(options.binding ? { binding: options.binding } : {}),
  });
  const snapshot = String((proposal.activity.object as Record<string, unknown>)["afp:quorumSnapshot"]);

  for (const [agent, value] of Object.entries(options.votes)) {
    t.hub.receive(
      t.instance.publish(agent, [t.hub.actorId], t.thread, "hub", (envelope) =>
        castVote(envelope, {
          voteId: `${envelope.actor}/votes/${name}`,
          round,
          hub: t.hub.actorId,
          proposalHash: proposal.digest,
          quorumSnapshot: snapshot,
          value,
        }),
      ).activity,
    );
  }

  const decision = t.hub.closeRound(round);
  return { round, proposal, decision, object: decision.activity.object as Record<string, JsonValue> };
}

/** The hub is vouched onto the roster like any agent, then the bundle is written. */
function exportOf(t: ReturnType<typeof bridge>) {
  t.instance.publishAsInstance([], `${t.config.origin}/threads/roster`, "public", (envelope) =>
    vouch(envelope, { agent: t.hub.actorId, capabilities: ["afp:cap:hub"], keyCustody: "self" }),
  );
  return exportBundle(t.instance, t.config.exportDir, [t.hub]);
}

describe("ADR-0018 Decision 1 — the proposal declares its own terms", () => {
  it("thresholdOf is integer arithmetic over the pinned total, and refuses what it cannot compute", () => {
    const weights = { a: 1, b: 1, c: 1, d: 1 };
    assert.equal(thresholdOf({ "afp:form": "majority-of-total" }, weights), 3);
    assert.equal(thresholdOf({ "afp:form": "two-thirds-of-total" }, weights), 3);
    assert.equal(thresholdOf({ "afp:form": "explicit", "afp:threshold": 4 }, weights), 4);
    // The bar is over EVERY pinned seat, silent ones included (finding 52).
    assert.equal(thresholdOf({ "afp:form": "majority-of-total" }, { a: 2, b: 2, c: 2 }), 4);
    // Unknown or unusable forms are null — never silently treated as "no bar".
    assert.equal(thresholdOf({ "afp:form": "whatever-we-like" } as never, weights), null);
    assert.equal(thresholdOf({ "afp:form": "explicit", "afp:threshold": 1.5 }, weights), null);
    assert.equal(thresholdOf({ "afp:form": "explicit", "afp:threshold": 0 }, weights), null);
    assert.equal(thresholdOf({ "afp:form": "explicit", "afp:threshold": true as never }, weights), null);
  });

  it("G1 — an option that clears the pinned bar decides the round, and replays clean", () => {
    const t = bridge();
    const { proposal, object } = runRound(t, "cleared", {
      quorumRule: { "afp:form": "majority-of-total" },
      votes: { head: "yes", "s-head": "yes", "e-head": "yes" },
    });

    const pinned = proposal.activity.object as Record<string, JsonValue>;
    assert.deepEqual(pinned["afp:quorumRule"], { "afp:form": "majority-of-total" });
    assert.equal(object["afp:outcome"], "yes");
    assert.equal(object["afp:noDecisionReason"], undefined, "a decided round carries no reason");
    assert.equal((object["afp:weightTally"] as Record<string, number>).yes, 3);

    exportOf(t);
    const clean = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.equal(clean.code, 0, `verifier failed:\n${clean.output}`);
    assert.match(clean.output, /outcome cleared the pinned quorum rule/);
    t.instance.close();
  });

  it("G2 — the snow day: the winning option below the bar is afp:no-decision, not a winner", () => {
    const t = bridge();
    const { object } = runRound(t, "short", {
      quorumRule: { "afp:form": "majority-of-total" },
      // 2 for, 1 against, 1 silent: "yes" leads on 2 and the bar is 3.
      votes: { head: "yes", "s-head": "yes", "e-head": "no" },
    });

    assert.equal(object["afp:outcome"], NO_DECISION);
    assert.equal(object["afp:noDecisionReason"], "threshold-not-met");
    const tally = object["afp:weightTally"] as Record<string, number>;
    assert.equal(tally.yes, 2, "the tally still records what was actually cast");
    assert.equal(tally.abstain, 1, "and the silent seat's weight still lands in abstain");

    exportOf(t);
    const clean = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.equal(clean.code, 0, `verifier failed:\n${clean.output}`);
    assert.match(clean.output, /no-decision reason is justified/);
    t.instance.close();
  });

  it("G3 — a hub that declares a winner it did not earn fails replay (finding 51's check)", () => {
    const t = bridge();
    runRound(t, "short", {
      quorumRule: { "afp:form": "majority-of-total" },
      votes: { head: "yes", "s-head": "yes", "e-head": "no" },
    });
    exportOf(t);

    const mutated = mutateBundle(VERIFIER, t.config.exportDir, t.thread, "hub-bus-bridge", (outbox) => {
      for (const item of outbox.orderedItems) {
        const object = item.object as Record<string, unknown> | undefined;
        if (object?.type !== "afp:DecisionRecord") continue;
        object["afp:outcome"] = "yes";
        delete object["afp:noDecisionReason"];
      }
    });
    assert.notEqual(mutated.code, 0, "a fabricated winner must not replay clean");
    assert.match(mutated.output, /outcome cleared the pinned quorum rule/);
    t.instance.close();
  });

  it("G4 — a rule nobody can compute is a failure, never an ignored field", () => {
    const t = bridge();
    runRound(t, "cleared", {
      quorumRule: { "afp:form": "majority-of-total" },
      votes: { head: "yes", "s-head": "yes", "e-head": "yes" },
    });
    exportOf(t);

    const mutated = mutateBundle(VERIFIER, t.config.exportDir, t.thread, "hub-bus-bridge", (outbox) => {
      for (const item of outbox.orderedItems) {
        const object = item.object as Record<string, unknown> | undefined;
        if (object?.type !== "afp:Proposal") continue;
        object["afp:quorumRule"] = { "afp:form": "whatever-we-like" };
      }
    });
    assert.notEqual(mutated.code, 0);
    assert.match(mutated.output, /quorum rule is a known form/);
    t.instance.close();
  });

  it("the hub refuses to sign what it could not later defend", () => {
    const t = bridge();
    assert.throws(
      () =>
        t.hub.proposeRound({
          round: `${t.config.origin}/rounds/bad-rule`,
          thread: t.thread,
          question: "q?",
          options: ["yes", "no"],
          quorumRule: { "afp:form": "made-up" } as never,
        }),
      /form|rule/i,
      "an uncomputable rule must be refused at propose time, not discovered at replay",
    );
    assert.throws(
      () =>
        t.hub.proposeRound({
          round: `${t.config.origin}/rounds/bad-options`,
          thread: t.thread,
          question: "q?",
          options: ["yes", NO_DECISION],
        }),
      /no-decision/,
      "the reserved outcome is not an option anyone may offer",
    );
    t.instance.close();
  });
});

describe("ADR-0018 Decision 2 — the clock the round does not own", () => {
  it("G5 — a vote arriving after the deadline is dropped, and the round expires", () => {
    const t = bridge();
    const deadline = "2026-08-17T10:00:00.000Z";
    const round = `${t.config.origin}/rounds/late`;
    const proposal = t.hub.proposeRound({
      round,
      thread: t.thread,
      question: "Close all three schools today?",
      options: ["yes", "no"],
      quorumRule: { "afp:form": "majority-of-total" },
      deadline,
    });
    const snapshot = String((proposal.activity.object as Record<string, unknown>)["afp:quorumSnapshot"]);
    const ballot = (agent: string, value: string) =>
      t.instance.publish(agent, [t.hub.actorId], t.thread, "hub", (envelope) =>
        castVote(envelope, {
          voteId: `${envelope.actor}/votes/late`,
          round,
          hub: t.hub.actorId,
          proposalHash: proposal.digest,
          quorumSnapshot: snapshot,
          value,
        }),
      ).activity;

    t.hub.receive(ballot("head", "yes"));
    t.hub.receive(ballot("s-head", "yes"));
    // The buses leave the depot. Everything after this is too late to matter.
    t.clock.jumpTo("2026-08-17T10:30:00.000Z");
    t.hub.receive(ballot("e-head", "yes"));

    assert.equal(t.hub.roundVotes(round).length, 2, "the late ballot earns no receipt");
    const object = t.hub.closeRound(round).activity.object as Record<string, JsonValue>;
    assert.equal(object["afp:outcome"], NO_DECISION);
    assert.equal(object["afp:noDecisionReason"], "expired", "past the deadline, the reason is the clock");
    const uncounted = object["afp:uncounted"] as { agent: string; "afp:status": string }[];
    const late = uncounted.find((u) => u.agent === t.instance.actorId("e-head"));
    assert.equal(late?.["afp:status"], "silent", "a late voter is silent, never an abstainer");

    exportOf(t);
    const clean = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.equal(clean.code, 0, `verifier failed:\n${clean.output}`);
    t.instance.close();
  });

  it("the deadline is compared as an instant, not as a string", () => {
    const t = bridge();
    // Second-precision and millisecond-precision spellings of one moment.
    // String comparison orders them differently ('.' < 'Z'), so a hub that
    // compared strings would admit a vote here that its own verifier — which
    // reads this field through `instant_millis` — later refuses.
    const round = `${t.config.origin}/rounds/spelling`;
    const proposal = t.hub.proposeRound({
      round,
      thread: t.thread,
      question: "Close all three schools today?",
      options: ["yes", "no"],
      deadline: "2026-08-17T10:00:00Z",
    });
    const snapshot = String((proposal.activity.object as Record<string, unknown>)["afp:quorumSnapshot"]);
    t.clock.jumpTo("2026-08-17T10:30:00.000Z");
    t.hub.receive(
      t.instance.publish("head", [t.hub.actorId], t.thread, "hub", (envelope) =>
        castVote(envelope, {
          voteId: `${envelope.actor}/votes/spelling`,
          round,
          hub: t.hub.actorId,
          proposalHash: proposal.digest,
          quorumSnapshot: snapshot,
          value: "yes",
        }),
      ).activity,
    );
    assert.equal(t.hub.roundVotes(round).length, 0, "10:30 is past 10:00 however the deadline is spelled");
    t.instance.close();
  });

  it("G6 — a late vote spliced into the evidence set fails replay", () => {
    const t = bridge();
    const deadline = "2026-08-17T10:00:00.000Z";
    const round = `${t.config.origin}/rounds/late`;
    const proposal = t.hub.proposeRound({
      round,
      thread: t.thread,
      question: "Close all three schools today?",
      options: ["yes", "no"],
      deadline,
    });
    const snapshot = String((proposal.activity.object as Record<string, unknown>)["afp:quorumSnapshot"]);
    t.hub.receive(
      t.instance.publish("head", [t.hub.actorId], t.thread, "hub", (envelope) =>
        castVote(envelope, {
          voteId: `${envelope.actor}/votes/late`,
          round,
          hub: t.hub.actorId,
          proposalHash: proposal.digest,
          quorumSnapshot: snapshot,
          value: "yes",
        }),
      ).activity,
    );
    // Published after the deadline and never admitted — but its bytes exist.
    t.clock.jumpTo("2026-08-17T10:30:00.000Z");
    const lateVote = t.instance.publish("s-head", [t.hub.actorId], t.thread, "hub", (envelope) =>
      castVote(envelope, {
        voteId: `${envelope.actor}/votes/late`,
        round,
        hub: t.hub.actorId,
        proposalHash: proposal.digest,
        quorumSnapshot: snapshot,
        value: "yes",
      }),
    ).activity;
    t.hub.closeRound(round);
    exportOf(t);

    const lateDigest = digestOf(lateVote);
    const mutated = mutateBundle(VERIFIER, t.config.exportDir, t.thread, "hub-bus-bridge", (outbox) => {
      for (const item of outbox.orderedItems) {
        const object = item.object as Record<string, unknown> | undefined;
        if (object?.type !== "afp:DecisionRecord") continue;
        (object["afp:countedVotes"] as string[]).push(lateDigest);
      }
    });
    assert.notEqual(mutated.code, 0, "counting a vote cast after the deadline must fail");
    assert.match(mutated.output, /counted votes respect the deadline/);
    t.instance.close();
  });
});

describe("ADR-0018 Decision 3 — a binding outcome, and the record of leaving it", () => {
  function departingRound() {
    const t = bridge();
    const { round, decision } = runRound(t, "binding", {
      quorumRule: { "afp:form": "majority-of-total" },
      binding: "joint",
      votes: { head: "no", caretaker: "no", "s-head": "no", "e-head": "yes" },
    });
    return { t, round, decision, decisionDigest: decision.digest };
  }

  it("G7 — an outvoted member departs on the record, and the hub lists it", () => {
    const { t, round, decisionDigest } = departingRound();
    const leaving = t.instance.publish("e-head", [t.hub.actorId], t.thread, "hub", (envelope) =>
      departure(envelope, {
        departureId: `${envelope.actor}/departures/binding`,
        hub: t.hub.actorId,
        round,
        decision: decisionDigest,
        reason: "our building is at 12°C; we are sending our families home",
      }),
    ).activity;
    t.hub.receive(leaving);

    const listed = t.hub.roundDepartures(round);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].actor, t.instance.actorId("e-head"));

    exportOf(t);
    const clean = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.equal(clean.code, 0, `verifier failed:\n${clean.output}`);
    assert.match(clean.output, /departure: .* names a producible DecisionRecord/);
    assert.match(clean.output, /departure: .* is by a pinned voter of that round/);
    t.instance.close();
  });

  it("G8 — a departure by a member the proposer never pinned fails replay", () => {
    const t = bridge();
    const round = `${t.config.origin}/rounds/narrow`;
    // The electorate is proposer-declared (02): every agent here is an enrolled
    // member, and this round pins only three of them. `caretaker` is seated,
    // rostered, and simply not part of this decision — so its departure departs
    // nothing, which is exactly what V8 exists to say.
    const proposal = t.hub.proposeRound({
      round,
      thread: t.thread,
      question: "Close all three schools today?",
      options: ["yes", "no"],
      binding: "joint",
      voters: AGENTS.filter((a) => a !== "caretaker").map((a) => t.instance.actorId(a)),
    });
    const snapshot = String((proposal.activity.object as Record<string, unknown>)["afp:quorumSnapshot"]);
    for (const agent of ["head", "s-head", "e-head"]) {
      t.hub.receive(
        t.instance.publish(agent, [t.hub.actorId], t.thread, "hub", (envelope) =>
          castVote(envelope, {
            voteId: `${envelope.actor}/votes/narrow`,
            round,
            hub: t.hub.actorId,
            proposalHash: proposal.digest,
            quorumSnapshot: snapshot,
            value: agent === "e-head" ? "yes" : "no",
          }),
        ).activity,
      );
    }
    const decision = t.hub.closeRound(round);

    t.instance.publish("caretaker", [t.hub.actorId], t.thread, "hub", (envelope) =>
      departure(envelope, {
        departureId: `${envelope.actor}/departures/narrow`,
        hub: t.hub.actorId,
        round,
        decision: decision.digest,
        reason: "I never voted on this and I am not bound by it",
      }),
    );
    exportOf(t);

    const report = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.notEqual(report.code, 0, "an unpinned agent's departure must not replay clean");
    assert.match(report.output, /is by a pinned voter of that round/);
    t.instance.close();
  });
});

describe("ADR-0018 Decision 4 — grading the decision the morning after", () => {
  function settledRound() {
    const t = bridge();
    // The record decides "no"; e-head dissents with "yes".
    const { round, decision } = runRound(t, "graded", {
      quorumRule: { "afp:form": "explicit", "afp:threshold": 2 },
      votes: { head: "no", caretaker: "no", "e-head": "yes" },
    });
    return { t, round, decision, decisionDigest: decision.digest };
  }

  it("G9 — a settlement on the decision, crediting the dissenter the world proved right", () => {
    const { t, round, decision, decisionDigest } = settledRound();
    assert.equal((decision.activity.object as Record<string, JsonValue>)["afp:outcome"], "no");

    t.hub.emit([], t.thread, "hub", (envelope) =>
      settleDecision(envelope, {
        settlementId: `${t.hub.actorId}/settlements/graded`,
        hub: t.hub.actorId,
        decision: decisionDigest,
        round,
        observedOutcome: "yes",
        dissentVindicated: [t.instance.actorId("e-head")],
      }),
    );

    exportOf(t);
    const clean = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.equal(clean.code, 0, `verifier failed:\n${clean.output}`);
    assert.match(clean.output, /settlement: .* vindicated dissenters voted the observed outcome/);
    t.instance.close();
  });

  it("G10 — standing cannot be handed to someone who voted with the majority", () => {
    const { t, round, decisionDigest } = settledRound();
    t.hub.emit([], t.thread, "hub", (envelope) =>
      settleDecision(envelope, {
        settlementId: `${t.hub.actorId}/settlements/graded`,
        hub: t.hub.actorId,
        decision: decisionDigest,
        round,
        observedOutcome: "yes",
        // `head` voted "no" — the decided outcome. Not a dissenter, and not
        // vindicated: this is the check that makes the credit mechanical.
        dissentVindicated: [t.instance.actorId("head")],
      }),
    );
    exportOf(t);
    const report = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.notEqual(report.code, 0);
    assert.match(report.output, /vindicated dissenters voted the observed outcome/);
    t.instance.close();
  });

  it("G11 — a round is settled once; a second account of the same morning fails", () => {
    const { t, round, decisionDigest } = settledRound();
    for (const suffix of ["a", "b"]) {
      t.hub.emit([], t.thread, "hub", (envelope) =>
        settleDecision(envelope, {
          settlementId: `${t.hub.actorId}/settlements/graded-${suffix}`,
          hub: t.hub.actorId,
          decision: decisionDigest,
          round,
          observedOutcome: suffix === "a" ? "yes" : "no",
        }),
      );
    }
    exportOf(t);
    const report = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.notEqual(report.code, 0);
    assert.match(report.output, /settles its round once/);
    t.instance.close();
  });
});

describe("ADR-0018 — the compatibility gate", () => {
  it("G12 — a round built the old way is byte-identical and triggers none of the new checks", () => {
    const t = bridge();
    const { proposal, object } = runRound(t, "plain", {
      votes: { head: "yes", caretaker: "yes", "s-head": "no", "e-head": "no" },
    });

    const pinned = proposal.activity.object as Record<string, JsonValue>;
    for (const key of ["afp:quorumRule", "afp:deadline", "afp:binding"]) {
      assert.equal(pinned[key], undefined, `${key} must be absent from a round that pinned none`);
    }
    // A tie on 2-2 with no rule: argmax picks the first option in declared
    // order, exactly as it did before this ADR existed.
    assert.equal(object["afp:outcome"], "yes");
    assert.equal(object["afp:noDecisionReason"], undefined);

    exportOf(t);
    const clean = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.equal(clean.code, 0, `verifier failed:\n${clean.output}`);
    assert.doesNotMatch(clean.output, /quorum rule is a known form/);
    assert.doesNotMatch(clean.output, /counted votes respect the deadline/);
    assert.doesNotMatch(clean.output, /no-decision/);
    t.instance.close();
  });
});
