/**
 * ADR-0010 acceptance gate: pinning without an auction replays end to end.
 *
 * Scenario 09's shape, deliberately: a direct fan-out, no auction — one port
 * agent (`coordinator`) delegates a screening task to four screeners on one
 * thread, pinning `afp:actionPolicy`, `afp:answerSufficiency` and
 * `afp:synthesizer` on the Offer instead of an Announce that does not exist
 * in this flow. Every check this gate proves exists because the direct flow
 * disarmed it silently before ADR-0010: pin agreement across a fan-out, pins
 * preceding answers, a synthesizer with a name, a policy with a non-answer
 * key, and the one-hop `afp:actsOn` -> DecisionRecord binding that lets a
 * ratified flow act on the artifact it actually ratified.
 *
 * Three flows, three `it`s, because the second (the DecisionRecord hop) needs
 * a real quorum round and the others do not — forcing them into one flow
 * would either drag hub/ratification machinery into the plain direct-flow
 * cases or dilute the two-hop failure into a bundle that also has to stay
 * clean elsewhere. The fourth claim — that the auction root and this one mean
 * the same thing — is its own gate, in `adr0010-parity.test.ts`.
 *
 * Each flow follows adr0006.test.ts's shape: the raw-body `publish` escape
 * hatch, `exportBundle` + `runVerifier` for the clean pass, then
 * copy-the-bundle-and-edit-one-outbox `mutate` calls, asserting each
 * mutation's own named FAIL line rather than a failure count — editing a
 * signed activity also breaks its signature, and that is fine and expected.
 *
 *   node --experimental-sqlite --test test/adr0010.test.ts
 */

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, describe, it } from "node:test";

import { digestOf } from "../src/crypto/proof.ts";
import { vouch, createResult, createError } from "../src/ap/activities.ts";
import { validateActionPolicy, type TaskPins } from "../src/ap/pins.ts";
import { exportBundle } from "../src/export.ts";
import { enroll, castVote, type Envelope as HubEnvelope } from "../src/hub/activities.ts";
import { hubTransport } from "../src/hub/hub.ts";
import { createSynthesis } from "../src/allocation/activities.ts";
import { actionStamp } from "../src/allocation/actions.ts";
import { cleanupWorkspaces, mutateBundle, runVerifier } from "./helpers.ts";
import {
  CAPABILITY,
  POLICY,
  VERIFIER,
  publish,
  setupPlain,
  setupWithHub,
  synthesisOf,
} from "./adr0010-fixtures.ts";

after(cleanupWorkspaces);

/** This gate's mutations all replay against the one verifier. */
const mutate = (
  exportDir: string,
  thread: string,
  outboxName: string,
  edit: (outbox: { orderedItems: Record<string, unknown>[] }) => void,
) => mutateBundle(VERIFIER, exportDir, thread, outboxName, edit);

describe("ADR-0010 gate: pins on the direct Offer replay end to end", () => {
  it("the fan-out replays clean; each mutation fails its named pin/synthesis/action check", async () => {
    const AGENTS = ["coordinator", "s1", "s2", "s3", "s4", "helper"] as const;
    const { instance, config } = setupPlain(AGENTS);
    const thread = "urn:afp:thread:screen-1";
    const coordinatorId = instance.actorId("coordinator");

    // A policy missing its non-answer key is not yet a policy — the writer
    // refuses to build it, which is itself a check the clean pass proves.
    assert.throws(
      () => validateActionPolicy({ "afp:screen-ok": "advance" }),
      /missing a declared, non-empty afp:no-verdict action/,
    );

    // The pin set is built once and spread into every Offer of the fan-out —
    // the discipline ADR-0010 requires, so a divergent pin is a deliberate
    // mutation below, never an accident of construction here.
    const pins: TaskPins = {
      actionPolicy: POLICY,
      answerSufficiency: { count: 4 },
      synthesizer: coordinatorId,
    };

    for (const screener of ["s1", "s2", "s3", "s4"] as const) {
      instance.delegate({
        from: "coordinator",
        to: screener,
        capability: CAPABILITY,
        content: `screen the application (${screener}'s panel seat)`,
        thread,
        correlationId: `leg-${screener}`,
        pins,
      });
    }
    // s1 sub-delegates part of its seat to `helper`, on the same thread —
    // Decision 1's sub-delegation rule: it MUST copy the pin set
    // byte-identically. Same reference, so this is the "inherits" case,
    // proven by the clean pass; the mutation below strips it back off.
    instance.delegate({
      from: "s1",
      to: "helper",
      capability: CAPABILITY,
      content: "second opinion on s1's seat",
      thread,
      correlationId: "leg-s1-sub",
      pins,
    });

    const results = [
      instance.publish("s1", [], thread, "parties", (envelope) =>
        createResult(envelope, { resultId: "urn:afp:result:leg-s1", correlationId: "leg-s1", content: "clean record" }),
      ),
      instance.publish("s2", [], thread, "parties", (envelope) =>
        createResult(envelope, { resultId: "urn:afp:result:leg-s2", correlationId: "leg-s2", content: "clean record" }),
      ),
      instance.publish("s3", [], thread, "parties", (envelope) =>
        createResult(envelope, { resultId: "urn:afp:result:leg-s3", correlationId: "leg-s3", content: "clean record" }),
      ),
      instance.publish("s4", [], thread, "parties", (envelope) =>
        createResult(envelope, { resultId: "urn:afp:result:leg-s4", correlationId: "leg-s4", content: "clean record" }),
      ),
      instance.publish("helper", [], thread, "parties", (envelope) =>
        createResult(envelope, { resultId: "urn:afp:result:leg-s1-sub", correlationId: "leg-s1-sub", content: "concurs" }),
      ),
    ];

    // --- The pinned synthesizer answers — no afp:award, the fallback root.
    const synthesis = instance.publish("coordinator", [], thread, "parties", (envelope) =>
      createSynthesis(envelope, {
        synthesisId: "urn:afp:synthesis:screen-1",
        method: "panel",
        answer: "cleared for onboarding",
        confidence: 92,
        contributingResults: results.map((r) => digestOf(r.activity)),
        assumptions: [],
        dissent: [],
        category: "afp:screen-ok",
      }),
    );
    const synthesisDigest = digestOf(synthesis.activity);

    // --- The action: hash-bound, admissible under the pinned policy.
    publish(instance, "coordinator", [], thread, {
      type: "afp:Act",
      object: "urn:afp:task:screen-1",
      ...actionStamp("advance", synthesisDigest, { policy: POLICY, category: "afp:screen-ok" }),
    });

    const exported = exportBundle(instance, config.exportDir);
    const clean = runVerifier(VERIFIER, config.exportDir, thread, ["--verbose"]);
    assert.equal(clean.code, 0, `verifier failed:\n${clean.output}`);
    assert.match(clean.output, /pins: .*task activities agree on their pinned set/);
    assert.match(clean.output, /pins: .*pins precede the thread's first answer/);
    assert.match(clean.output, /pins: .*pinned afp:actionPolicy declares an afp:no-verdict action/);
    assert.match(clean.output, /synthesis: .*is emitted by the pinned synthesizer/);
    assert.match(clean.output, /synthesis: .*accounts for every leg of its thread/);
    assert.match(clean.output, /synthesis: .*meets the pinned answer-sufficiency count/);
    assert.match(clean.output, /action: .*answers within the pinned category set/);
    assert.match(clean.output, /action: .*acts on a producible Synthesis/);
    assert.match(clean.output, /action: .*is the action the answer permitted/);

    // 1 — divergent pins across the fan-out: s2's Offer pins a different
    // policy than its siblings.
    const divergentPins = mutate(exported.dir, thread, "coordinator", (outbox) => {
      for (const activity of outbox.orderedItems) {
        const object = activity.object as Record<string, unknown> | undefined;
        if (object?.["afp:correlationId"] === "leg-s2") {
          object["afp:actionPolicy"] = { ...POLICY, "afp:screen-ok": "escalate" };
        }
      }
    });
    assert.notEqual(divergentPins.code, 0);
    assert.match(divergentPins.output, /FAIL \] pins: .*task activities agree on their pinned set/);

    // 2 — an unpinned fifth Offer on the pinned thread: divergence, not
    // abstention. Cloned from an existing Offer and stripped of its pins, so
    // it is a genuine second task-bearing activity rather than an edited one.
    const unpinnedOffer = mutate(exported.dir, thread, "coordinator", (outbox) => {
      const template = outbox.orderedItems.find(
        (a) => (a.object as Record<string, unknown> | undefined)?.["afp:correlationId"] === "leg-s3",
      )!;
      const clone = JSON.parse(JSON.stringify(template));
      clone.id = "urn:afp:coordinator/activities/9999";
      const object = clone.object as Record<string, unknown>;
      object.id = "urn:afp:coordinator/tasks/leg-extra";
      object["afp:correlationId"] = "leg-extra";
      delete object["afp:actionPolicy"];
      delete object["afp:answerSufficiency"];
      delete object["afp:synthesizer"];
      outbox.orderedItems.push(clone);
    });
    assert.notEqual(unpinnedOffer.code, 0);
    assert.match(unpinnedOffer.output, /FAIL \] pins: .*task activities agree on their pinned set/);

    // 3 — the thread pinned wholly after its first answer. The check binds
    // the EARLIEST task-bearing activity on the thread, so it is not enough
    // to backdate one Offer among five — every Offer (all four of
    // coordinator's, and s1's sub-delegating one) has to move past the
    // thread's first Result, or whichever one is left earliest still passes.
    const lateOpeningDir = mkdtempSync(join(tmpdir(), "afp-adr10-mut-"));
    cpSync(exported.dir, lateOpeningDir, { recursive: true });
    for (const outboxName of ["coordinator", "s1"]) {
      const path = join(lateOpeningDir, "outbox", `${outboxName}.jsonld`);
      const outbox = JSON.parse(readFileSync(path, "utf8")) as { orderedItems: Record<string, unknown>[] };
      for (const activity of outbox.orderedItems) {
        if (activity.type === "Offer") activity.published = "2030-01-01T00:00:00.000Z";
      }
      writeFileSync(path, JSON.stringify(outbox, null, 2));
    }
    const lateOpening = runVerifier(VERIFIER, lateOpeningDir, thread, ["--verbose"]);
    assert.notEqual(lateOpening.code, 0);
    assert.match(lateOpening.output, /FAIL \] pins: .*pins precede the thread's first answer/);

    // 4 — a Synthesis from an actor who is not the pinned synthesizer.
    const wrongSynthesizer = mutate(exported.dir, thread, "coordinator", (outbox) => {
      for (const activity of outbox.orderedItems) {
        const synth = synthesisOf(activity);
        if (synth) {
          activity.actor = instance.actorId("s1");
          synth.attributedTo = instance.actorId("s1");
        }
      }
    });
    assert.notEqual(wrongSynthesizer.code, 0);
    assert.match(wrongSynthesizer.output, /FAIL \] synthesis: .*is emitted by the pinned synthesizer/);

    // 5 — an answer outside the policy's closed category set.
    const strayCategory = mutate(exported.dir, thread, "coordinator", (outbox) => {
      for (const activity of outbox.orderedItems) {
        const synth = synthesisOf(activity);
        if (synth) synth["afp:category"] = "vibes";
      }
    });
    assert.notEqual(strayCategory.code, 0);
    assert.match(strayCategory.output, /FAIL \] action: .*answers within the pinned category set/);

    // 10 — the sub-delegating Offer omits the pin set it must inherit. The
    // "inherits, passes" half of this case is the clean pass above.
    const unpinnedSubDelegation = mutate(exported.dir, thread, "s1", (outbox) => {
      for (const activity of outbox.orderedItems) {
        const object = activity.object as Record<string, unknown> | undefined;
        if (object?.["afp:correlationId"] === "leg-s1-sub") {
          delete object["afp:actionPolicy"];
          delete object["afp:answerSufficiency"];
          delete object["afp:synthesizer"];
        }
      }
    });
    assert.notEqual(unpinnedSubDelegation.code, 0);
    assert.match(unpinnedSubDelegation.output, /FAIL \] pins: .*task activities agree on their pinned set/);

    instance.close();
  });

  it("afp:actsOn follows the DecisionRecord hop once, and never twice", async () => {
    const AGENTS = ["coordinator", "s1", "s2", "s3", "s4"] as const;
    const { instance, config, clock, hub, hubKeys } = setupWithHub(AGENTS, "screening");
    const transport = hubTransport(hub, instance.localTransport(), (target) => instance.nameOf(target) !== null);
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

    const thread = "urn:afp:thread:screen-2";
    const coordinatorId = instance.actorId("coordinator");
    const pins: TaskPins = {
      actionPolicy: POLICY,
      answerSufficiency: { count: 4 },
      synthesizer: coordinatorId,
    };
    for (const screener of ["s1", "s2", "s3", "s4"] as const) {
      instance.delegate({
        from: "coordinator",
        to: screener,
        capability: CAPABILITY,
        content: `screen the application (${screener}'s panel seat)`,
        thread,
        correlationId: `leg-${screener}`,
        pins,
      });
    }
    const results = (["s1", "s2", "s3", "s4"] as const).map((name) =>
      instance.publish(name, [], thread, "parties", (envelope) =>
        createResult(envelope, { resultId: `urn:afp:result:hop-${name}`, correlationId: `leg-${name}`, content: "clean record" }),
      ),
    );
    const synthesisId = "urn:afp:synthesis:screen-2";
    const synthesis = instance.publish("coordinator", [], thread, "parties", (envelope) =>
      createSynthesis(envelope, {
        synthesisId,
        method: "panel",
        answer: "cleared for onboarding",
        confidence: 92,
        contributingResults: results.map((r) => digestOf(r.activity)),
        assumptions: [],
        dissent: [],
        category: "afp:screen-ok",
      }),
    );

    const ratify = async (round: string, outcomeId: string) => {
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
      return hub.closeRound(round);
    };

    // --- Case 6: afp:actsOn names a DecisionRecord whose afp:outcome names
    // the Synthesis — the one hop the verifier follows, and it resolves.
    const decision1 = await ratify("urn:afp:round:ratify-screen-2", synthesisId);
    const decision1Id = (decision1.activity.object as Record<string, unknown>).id as string;
    const decision1Digest = digestOf(decision1.activity);
    publish(instance, "coordinator", [], thread, {
      type: "afp:Act",
      object: "urn:afp:task:screen-2",
      ...actionStamp("advance", decision1Digest, { policy: POLICY, category: "afp:screen-ok" }),
    });

    instance.publishAsInstance([], "urn:afp:thread:roster", "public", (envelope: HubEnvelope) =>
      vouch(envelope, { agent: hub.actorId, capabilities: ["afp:cap:hub"], keyCustody: "self" }),
    );
    const exported = exportBundle(instance, config.exportDir, [hub]);
    const clean = runVerifier(VERIFIER, config.exportDir, thread, ["--verbose"]);
    assert.equal(clean.code, 0, `verifier failed:\n${clean.output}`);
    assert.match(clean.output, /decision: .*outcome names a producible Synthesis/);
    assert.match(clean.output, /action: .*acts on a producible Synthesis/);
    assert.match(clean.output, /action: .*is the action the answer permitted/);

    // --- Case 7: a second DecisionRecord whose afp:outcome names the FIRST
    // DecisionRecord, not a Synthesis — two hops never resolve. Built as its
    // own round in the same instance, exported and replayed separately so
    // the clean pass above stays clean.
    const decision2 = await ratify("urn:afp:round:ratify-screen-2-hop2", decision1Id);
    const decision2Digest = digestOf(decision2.activity);
    publish(instance, "s1", [], thread, {
      type: "afp:Act",
      object: "urn:afp:task:screen-2-hop2",
      "afp:action": "advance",
      "afp:actsOn": decision2Digest,
    });
    const exportedTwoHop = exportBundle(instance, config.exportDir, [hub]);
    const twoHop = runVerifier(VERIFIER, exportedTwoHop.dir, thread, ["--verbose"]);
    assert.notEqual(twoHop.code, 0);
    assert.match(twoHop.output, /FAIL \] action: .*acts on a producible Synthesis/);

    instance.close();
  });

  it("a partial panel closes afp:no-verdict, declaring the leg it could not fill", async () => {
    const AGENTS = ["coordinator", "s1", "s2", "s3", "s4"] as const;
    const { instance, config } = setupPlain(AGENTS);
    const thread = "urn:afp:thread:screen-3";
    const coordinatorId = instance.actorId("coordinator");
    const pins: TaskPins = {
      actionPolicy: POLICY,
      answerSufficiency: { count: 4 },
      synthesizer: coordinatorId,
    };
    for (const screener of ["s1", "s2", "s3", "s4"] as const) {
      instance.delegate({
        from: "coordinator",
        to: screener,
        capability: CAPABILITY,
        content: `screen the application (${screener}'s panel seat)`,
        thread,
        correlationId: `leg-${screener}`,
        pins,
      });
    }
    // Three legs answer; the fourth's brain fails and terminates the leg
    // with a typed Error instead of a Result.
    const results = (["s1", "s2", "s3"] as const).map((name) =>
      instance.publish(name, [], thread, "parties", (envelope) =>
        createResult(envelope, { resultId: `urn:afp:result:partial-${name}`, correlationId: `leg-${name}`, content: "clean record" }),
      ),
    );
    const errorS4 = instance.publish("s4", [], thread, "parties", (envelope) =>
      createError(envelope, {
        errorId: "urn:afp:error:leg-s4",
        correlationId: "leg-s4",
        reason: "screening brain failed to return a verdict",
        code: "afp:err:brain-failed",
      }),
    );

    const synthesis = instance.publish("coordinator", [], thread, "parties", (envelope) =>
      createSynthesis(envelope, {
        synthesisId: "urn:afp:synthesis:screen-3",
        method: "panel",
        answer: "panel could not reach a verdict on every seat",
        confidence: 40,
        contributingResults: results.map((r) => digestOf(r.activity)),
        assumptions: [],
        dissent: [],
        category: "afp:no-verdict",
        absentInputs: [{ correlationId: "leg-s4", errorCode: "afp:err:brain-failed", digest: digestOf(errorS4.activity) }],
      }),
    );
    const synthesisDigest = digestOf(synthesis.activity);
    publish(instance, "coordinator", [], thread, {
      type: "afp:Act",
      object: "urn:afp:task:screen-3",
      ...actionStamp("hold-for-review", synthesisDigest, { policy: POLICY, category: "afp:no-verdict" }),
    });

    const exported = exportBundle(instance, config.exportDir);
    const clean = runVerifier(VERIFIER, config.exportDir, thread, ["--verbose"]);
    assert.equal(clean.code, 0, `verifier failed:\n${clean.output}`);
    assert.match(clean.output, /synthesis: .*accounts for every leg of its thread/);
    assert.match(clean.output, /synthesis: .*meets the pinned answer-sufficiency count/);
    assert.match(clean.output, /action: .*answers within the pinned category set/);
    assert.match(clean.output, /action: .*is the action the answer permitted/);

    // 9 — the same partial panel, without afp:absentInputs: the missing leg
    // is silently dropped instead of declared.
    const undeclaredGap = mutate(exported.dir, thread, "coordinator", (outbox) => {
      for (const activity of outbox.orderedItems) {
        const synth = synthesisOf(activity);
        if (synth) delete synth["afp:absentInputs"];
      }
    });
    assert.notEqual(undeclaredGap.code, 0);
    assert.match(undeclaredGap.output, /FAIL \] synthesis: .*accounts for every leg of its thread/);

    // The escape the no-verdict category buys, withdrawn: three legs still
    // answer a sufficiency of four, but the Synthesis now claims an ordinary
    // verdict. This is the case Decision 4 exists for — without it, a panel
    // could answer short of its own pinned bar and call the result a screening.
    // `afp:no-verdict` is not a way to pass with less; it is the declaration
    // that less is what happened.
    const shortOfSufficiency = mutate(exported.dir, thread, "coordinator", (outbox) => {
      for (const activity of outbox.orderedItems) {
        const synth = synthesisOf(activity);
        if (synth) synth["afp:category"] = "afp:screen-ok";
      }
    });
    assert.notEqual(shortOfSufficiency.code, 0);
    assert.match(shortOfSufficiency.output, /FAIL \] synthesis: .*meets the pinned answer-sufficiency count/);

    instance.close();
  });
});
