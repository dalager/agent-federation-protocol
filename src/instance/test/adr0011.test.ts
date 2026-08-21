/**
 * ADR-0011 acceptance gate: supersession meets the irreversible world.
 *
 * Three claims, three flows:
 *
 *  1. A consequence that cannot be recalled can still be *disposed of* — the
 *     `annotate` disposition satisfies ADR-0007's existence check without
 *     commanding anything external, but only where irreversibility was
 *     declared at pin time by someone who did not yet know they would want it.
 *  2. A superseding ratification names the electorate it overturns, so a panel
 *     that changed between the two decisions is visible rather than implied —
 *     and a ratified substitution is what lets a changed panel answer a thread
 *     its pinned synthesizer no longer serves.
 *  3. A new ask on new information names the closed thread it continues, and
 *     that edge resolves — or is honestly out of scope, which under ADR-0009
 *     is not the same thing as missing.
 *
 * Composes with `adr0007.test.ts` rather than replacing it: the retraction
 * machinery itself is gated there, and this file exercises only what ADR-0011
 * adds on top.
 *
 *   node --experimental-sqlite --test test/adr0011.test.ts
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { digestOf } from "../src/crypto/proof.ts";
import { vouch, createResult } from "../src/ap/activities.ts";
import { validateIrrevocableActions, type ActionPolicy, type TaskPins } from "../src/ap/pins.ts";
import { exportBundle } from "../src/export.ts";
import { enroll, castVote, type Envelope as HubEnvelope } from "../src/hub/activities.ts";
import { hubTransport } from "../src/hub/hub.ts";
import { createSynthesis, bidPayload, commitmentOf } from "../src/allocation/activities.ts";
import { actionStamp, annotateStamp, dispositionStamp } from "../src/allocation/actions.ts";
import {
  cleanupWorkspaces,
  mutateBundle,
  publishRaw,
  runVerifier,
  testHub,
  testInstance,
} from "./helpers.ts";
import { VERIFIER } from "./adr0010-fixtures.ts";

after(cleanupWorkspaces);

const CAPABILITY = "afp:cap:assess";

/** `advance` is the one that reaches the outside world and stays there. */
const POLICY: ActionPolicy = {
  "assess-ok": "advance",
  "assess-flag": "hold-for-review",
  "afp:no-verdict": "hold-for-review",
};
const IRREVOCABLE = ["advance"] as const;

const publish = (
  instance: ReturnType<typeof testInstance>["instance"],
  name: string,
  thread: string,
  body: { [key: string]: unknown },
) => publishRaw(instance, name, [], thread, "parties", body);

const mutate = (
  dir: string,
  thread: string,
  outbox: string,
  edit: (o: { orderedItems: Record<string, unknown>[] }) => void,
) => mutateBundle(VERIFIER, dir, thread, outbox, edit);

describe("ADR-0011 gate: the irreversible world, on the record", () => {
  it("an irrevocable consequence is disposed of by annotation — and only where declared", async () => {
    const { instance, config } = testInstance(["coordinator", "s1", "port"], CAPABILITY);
    const thread = "urn:afp:thread:irrevocable-1";
    const coordinatorId = instance.actorId("coordinator");

    // The writer refuses a declaration that names no action — the dead clause
    // an auditor would reasonably read as a live one.
    assert.throws(
      () => validateIrrevocableActions(POLICY, ["evaporate"]),
      /not a value of the pinned afp:actionPolicy/,
    );

    const pins: TaskPins = {
      actionPolicy: POLICY,
      answerSufficiency: { count: 1 },
      synthesizer: coordinatorId,
      irrevocableActions: [...IRREVOCABLE],
    };
    instance.delegate({
      from: "coordinator",
      to: "s1",
      capability: CAPABILITY,
      content: "assess the application",
      thread,
      correlationId: "leg-1",
      pins,
    });
    const result = instance.publish("s1", [], thread, "parties", (envelope) =>
      createResult(envelope, { resultId: "urn:afp:result:leg-1", correlationId: "leg-1", content: "clears" }),
    );
    const first = instance.publish("coordinator", [], thread, "parties", (envelope) =>
      createSynthesis(envelope, {
        synthesisId: "urn:afp:synthesis:irrevocable-first",
        method: "assessment",
        answer: "clear to advance",
        confidence: 90,
        contributingResults: [digestOf(result.activity)],
        assumptions: [],
        dissent: [],
        category: "assess-ok",
      }),
    );
    const firstDigest = digestOf(first.activity);

    // The irrevocable act: the application moves, and the world keeps it.
    const advance = publish(instance, "port", thread, {
      type: "afp:Act",
      object: "urn:afp:task:irrevocable-1",
      ...actionStamp("advance", firstDigest, { policy: POLICY, category: "assess-ok" }),
    });
    const advanceDigest = digestOf(advance.activity);

    // The answer is withdrawn — but the transition cannot be.
    const revised = instance.publish("coordinator", [], thread, "parties", (envelope) =>
      createSynthesis(envelope, {
        synthesisId: "urn:afp:synthesis:irrevocable-revised",
        method: "assessment",
        answer: "the schedule evidence was misread — this should have been flagged",
        confidence: 95,
        contributingResults: [digestOf(result.activity)],
        assumptions: [],
        dissent: [],
        category: "assess-flag",
        supersedes: firstDigest,
      }),
    );
    const revisedDigest = digestOf(revised.activity);

    // The writer refuses to claim an escape hatch its pins never opened.
    assert.throws(
      () =>
        annotateStamp(advanceDigest, revisedDigest, {
          irrevocableActions: ["hold-for-review"],
          disposedAction: "advance",
        }),
      /not in the pinned afp:irrevocableActions/,
    );
    publish(instance, "port", thread, {
      type: "afp:Act",
      object: "urn:afp:task:irrevocable-1",
      ...annotateStamp(advanceDigest, revisedDigest, {
        irrevocableActions: [...IRREVOCABLE],
        disposedAction: "advance",
      }),
      summary: "the application had already advanced; the transition cannot be recalled, only recorded",
    });

    const exported = exportBundle(instance, config.exportDir);
    const clean = runVerifier(VERIFIER, config.exportDir, thread, ["--verbose"]);
    assert.equal(clean.code, 0, `verifier failed:\n${clean.output}`);
    assert.match(clean.output, /pins: .*afp:irrevocableActions name actions the policy declares/);
    assert.match(clean.output, /supersession: .*annotates an action declared irrevocable/);
    assert.match(clean.output, /supersession: .*disposed of after its justification was withdrawn/);

    // 1 — the annotation removed entirely: ADR-0007's existing orphan check is
    // what must catch this, unchanged. The new form is an extra way to satisfy
    // that duty, never a way around it.
    const noDisposition = mutate(exported.dir, thread, "port", (outbox) => {
      outbox.orderedItems = outbox.orderedItems.filter((a) => !a["afp:disposes"]);
    });
    assert.notEqual(noDisposition.code, 0);
    assert.match(noDisposition.output, /FAIL \] supersession: .*disposed of after its justification was withdrawn/);

    // 2 — the escape hatch claimed where it was never declared: the pins now
    // declare a different action irrevocable, so annotating `advance` is the
    // undeclared claim this check exists to name.
    const undeclared = mutate(exported.dir, thread, "coordinator", (outbox) => {
      for (const activity of outbox.orderedItems) {
        const object = activity.object as Record<string, unknown> | undefined;
        if (object?.type === "afp:Task") object["afp:irrevocableActions"] = ["hold-for-review"];
      }
    });
    assert.notEqual(undeclared.code, 0);
    assert.match(undeclared.output, /FAIL \] supersession: .*annotates an action declared irrevocable/);

    // 3 — a declaration naming an action the policy does not contain.
    const deadClause = mutate(exported.dir, thread, "coordinator", (outbox) => {
      for (const activity of outbox.orderedItems) {
        const object = activity.object as Record<string, unknown> | undefined;
        if (object?.type === "afp:Task") object["afp:irrevocableActions"] = ["evaporate"];
      }
    });
    assert.notEqual(deadClause.code, 0);
    assert.match(deadClause.output, /FAIL \] pins: .*afp:irrevocableActions name actions the policy declares/);

    instance.close();
  });

  it("a superseding ratification names the electorate it overturns", async () => {
    const AGENTS = ["deps", "api", "sec"] as const;
    const { instance, config, clock } = testInstance(AGENTS, CAPABILITY);
    const { hub, hubKeys } = testHub(instance, AGENTS, "assess");
    const transport = hubTransport(hub, instance.localTransport(), (t) => instance.nameOf(t) !== null);
    for (const name of AGENTS) {
      instance.publishAsInstance([hub.actorId], "urn:afp:thread:enroll", "hub", (envelope: HubEnvelope) =>
        enroll(envelope, {
          agent: instance.actorId(name),
          hub: hub.actorId,
          capabilities: [CAPABILITY],
          hubKey: hubKeys.get(name)!.keyId,
        }),
      );
    }
    await instance.run(transport);
    const deps = instance.actorId("deps");

    const task = "urn:afp:task:panel-1";
    const thread = "urn:afp:thread:panel-1";
    const window = { opens: clock.now().toISOString(), closes: new Date(clock.now().getTime() + 600_000).toISOString() };
    hub.allocation.announce({
      taskId: task,
      thread,
      hub: hub.actorId,
      capability: CAPABILITY,
      content: "may we advance?",
      correlationId: "panel-1",
      bidWindow: window,
      selectionRule: { name: "ranking", params: { weights: { capabilityMatch: 1 } } as never },
      answerSufficiency: { count: 1 } as never,
      estimatorPolicy: "exclude",
      estimators: [],
      actionPolicy: POLICY,
      // ADR-0010 Decision 2 pins the synthesizer; the ranking rule derives
      // none, so the pin governs alone (absent is not unequal). That is what
      // makes the substitution below a real test of ADR-0011 Decision 3.
      synthesizer: deps,
    });
    const payload = bidPayload({
      task,
      bidder: deps,
      capabilityMatch: 90,
      estimatedCost: { unit: "EUR", value: 100 },
      estimatedLatency: "PT1H",
      nonce: "n-panel",
    });
    const toHub = (name: string, body: { [key: string]: unknown }) =>
      publishRaw(instance, name, [hub.actorId], thread, "hub", body);
    await hub.receive(
      toHub("deps", { type: "afp:bidCommit", object: task, "afp:hub": hub.actorId, "afp:commitment": commitmentOf(payload) }).activity,
    );
    clock.jumpTo(new Date(new Date(window.closes).getTime() + 1000).toISOString());
    await hub.receive(toHub("deps", { type: "afp:BidReveal", object: { ...payload }, "afp:hub": hub.actorId }).activity);
    const award = hub.allocation.closeAuction(task, new Date(clock.now().getTime() + 3600_000).toISOString())!;
    const awardId = (award.activity.object as Record<string, unknown>).id as string;

    const synth = (id: string, category: string, answer: string, supersedes?: string, author = "deps") =>
      toHub(author, {
        type: "Create",
        object: {
          id,
          type: "afp:Synthesis",
          "afp:award": awardId,
          "afp:method": "assessment",
          "afp:answer": answer,
          "afp:confidence": 88,
          "afp:contributingResults": [],
          "afp:assumptions": [],
          "afp:dissent": [],
          "afp:category": category,
          ...(supersedes ? { "afp:supersedes": supersedes } : {}),
          attributedTo: instance.actorId(author),
        },
      });

    const ratify = async (round: string, outcomeId: string, priorQuorumSnapshot?: string) => {
      const proposal = hub.proposeRound({ round, thread, question: `Ratify ${outcomeId}?`, options: [outcomeId, "reject"] });
      const snapshot = String((proposal.activity.object as Record<string, unknown>)["afp:quorumSnapshot"]);
      for (const name of AGENTS) {
        await hub.receive(
          instance.publish(name, [hub.actorId], thread, "hub", (envelope: HubEnvelope) =>
            castVote(envelope, {
              voteId: `${envelope.actor}/votes/${round}`,
              round,
              proposalHash: proposal.digest,
              quorumSnapshot: snapshot,
              value: outcomeId,
            }),
          ).activity,
        );
      }
      return { decision: hub.closeRound(round, { priorQuorumSnapshot }), snapshot };
    };

    const firstId = "urn:afp:synthesis:panel-first";
    const first = synth(firstId, "assess-ok", "clear to advance");
    const firstDigest = digestOf(first.activity);
    const ratified = await ratify("urn:afp:round:panel-first", firstId);

    const act = toHub("api", {
      type: "afp:Act",
      object: task,
      ...actionStamp("advance", firstDigest, { policy: POLICY, category: "assess-ok" }),
    });

    const revisedId = "urn:afp:synthesis:panel-revised";
    // ADR-0011 Decision 3: the superseding answer is emitted by `sec`, NOT the
    // pinned synthesizer. It is admissible only because the round below
    // ratifies it — a convened quorum outranks a pin written before the panel
    // changed, while an unratified answer keeps its pin or anyone supersedes
    // by simply being somebody else.
    const revised = synth(revisedId, "assess-flag", "the evidence was misread", firstDigest, "sec");
    const revisedDigest = digestOf(revised.activity);
    await ratify("urn:afp:round:panel-revised", revisedId, ratified.snapshot);

    toHub("api", {
      type: "afp:Act",
      object: task,
      ...dispositionStamp("hold-for-review", digestOf(act.activity), revisedDigest, {
        policy: POLICY,
        category: "assess-flag",
      }),
    });
    toHub("deps", {
      type: "Create",
      object: {
        id: "urn:afp:result:panel-1",
        type: "afp:Result",
        "afp:correlationId": "panel-1",
        content: "assessment revised",
        attributedTo: deps,
      },
    });
    instance.publishAsInstance([], "urn:afp:thread:roster", "public", (envelope: HubEnvelope) =>
      vouch(envelope, { agent: hub.actorId, capabilities: ["afp:cap:hub"], keyCustody: "self" }),
    );

    const exported = exportBundle(instance, config.exportDir, [hub]);
    const clean = runVerifier(VERIFIER, config.exportDir, thread, ["--verbose"]);
    assert.equal(clean.code, 0, `verifier failed:\n${clean.output}`);
    assert.match(clean.output, /supersession: .*names the electorate that ratified the answer it retracts/);
    // The substitution itself: `sec` is not the pinned synthesizer, and the
    // Synthesis it emitted is admissible anyway because a quorum ratified it.
    // This branch is the whole of Decision 3's second half, so it is asserted
    // as a *passing* check rather than inferred from the bundle being clean.
    assert.match(clean.output, /ok.*\] synthesis: .*is emitted by the pinned synthesizer/);

    // 3 — the same substitution, un-ratified: strip the outcome that makes the
    // superseding answer a quorum's. Without the quorum behind it, a Synthesis
    // from an unpinned actor is just someone else answering the thread, which
    // is what the pin exists to refuse.
    const unratifiedSubstitution = mutate(exported.dir, thread, `hub-assess`, (outbox) => {
      for (const activity of outbox.orderedItems) {
        const object = activity.object as Record<string, unknown> | undefined;
        if (object?.type === "afp:DecisionRecord" && object["afp:outcome"] === revisedId) {
          object["afp:outcome"] = "reject";
        }
      }
    });
    assert.notEqual(unratifiedSubstitution.code, 0);
    assert.match(unratifiedSubstitution.output, /FAIL \] synthesis: .*is emitted by the pinned synthesizer/);

    // 4 — the superseding ratification declares no prior electorate: continuity
    // asserted by silence, which is what Decision 3 refuses.
    const noPrior = mutate(exported.dir, thread, `hub-assess`, (outbox) => {
      for (const activity of outbox.orderedItems) {
        const object = activity.object as Record<string, unknown> | undefined;
        if (object?.type === "afp:DecisionRecord") delete object["afp:priorQuorumSnapshot"];
      }
    });
    assert.notEqual(noPrior.code, 0);
    assert.match(noPrior.output, /FAIL \] supersession: .*names the electorate that ratified the answer it retracts/);

    // 5 — it declares *an* electorate, but not the one that actually ratified
    // the answer being withdrawn. Presence was never the point.
    const wrongPrior = mutate(exported.dir, thread, `hub-assess`, (outbox) => {
      for (const activity of outbox.orderedItems) {
        const object = activity.object as Record<string, unknown> | undefined;
        if (object?.type === "afp:DecisionRecord" && object["afp:priorQuorumSnapshot"]) {
          object["afp:priorQuorumSnapshot"] = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
        }
      }
    });
    assert.notEqual(wrongPrior.code, 0);
    assert.match(wrongPrior.output, /FAIL \] supersession: .*names the electorate that ratified the answer it retracts/);

    instance.close();
  });

  it("a new ask names the closed thread it continues, and the edge resolves", async () => {
    const { instance, config } = testInstance(["coordinator", "s1"], CAPABILITY);
    const closed = "urn:afp:thread:prior-closed";
    const continued = "urn:afp:thread:prior-continued";
    const pins: TaskPins = { actionPolicy: POLICY, synthesizer: instance.actorId("coordinator") };

    // --- The first ask, answered and closed.
    instance.delegate({
      from: "coordinator",
      to: "s1",
      capability: CAPABILITY,
      content: "assess the original application",
      thread: closed,
      correlationId: "prior-leg",
      pins,
    });
    const priorResult = instance.publish("s1", [], closed, "parties", (envelope) =>
      createResult(envelope, { resultId: "urn:afp:result:prior", correlationId: "prior-leg", content: "flagged" }),
    );
    instance.publish("coordinator", [], closed, "parties", (envelope) =>
      createSynthesis(envelope, {
        synthesisId: "urn:afp:synthesis:prior",
        method: "assessment",
        answer: "flagged for review",
        confidence: 80,
        contributingResults: [digestOf(priorResult.activity)],
        assumptions: [],
        dissent: [],
        category: "assess-flag",
      }),
    );

    // --- The new ask: new information, not a claim that the old answer was
    // wrong on what it saw. The old outcome stands; the edge makes the
    // prehistory followable instead of narrated (ADR-0011 Decision 4).
    instance.delegate({
      from: "coordinator",
      to: "s1",
      capability: CAPABILITY,
      content: "assess the application again — the applicant filed corrected dates",
      thread: continued,
      correlationId: "continued-leg",
      pins,
      priorThread: closed,
    });
    instance.publish("s1", [], continued, "parties", (envelope) =>
      createResult(envelope, { resultId: "urn:afp:result:continued", correlationId: "continued-leg", content: "clears" }),
    );

    const exported = exportBundle(instance, config.exportDir);
    const clean = runVerifier(VERIFIER, config.exportDir, continued, ["--verbose"]);
    assert.equal(clean.code, 0, `verifier failed:\n${clean.output}`);
    assert.match(clean.output, /afp:priorThread resolves to a closed, unretracted thread/);

    // 6 — a thread claiming itself as its own prehistory. Always a finding:
    // there is no scope under which that is a lawful omission, unlike a prior
    // thread that is simply out of this bundle's declared scope.
    const selfReference = mutate(exported.dir, continued, "coordinator", (outbox) => {
      for (const activity of outbox.orderedItems) {
        const object = activity.object as Record<string, unknown> | undefined;
        if (object?.["afp:priorThread"]) object["afp:priorThread"] = continued;
      }
    });
    assert.notEqual(selfReference.code, 0);
    assert.match(selfReference.output, /FAIL \] thread: .*afp:priorThread/);

    instance.close();
  });
});
