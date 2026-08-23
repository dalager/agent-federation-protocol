/**
 * ADR-0021 gate — after the proof: conviction to consequence.
 *
 * Two sections at first, then a third: **Decision 1** (the membership-authority
 * binding) and **Decision 2** (the recomputable electorate) landed as W4's two
 * named slices, and **Decisions 3-5** follow here — recusal by declared cause,
 * conviction to governed consequence, and a proof with somewhere to go.
 *
 * What Decision 1 closes, and why it is first: `Hub.onUnenroll` checked
 * nothing at all until 2026-08-22 — no issuer binding, no seat, no membership
 * — and `writeAdmitted` puts `afp:Unenroll` in the door-knock class, so any
 * party holding any key that verified could remove any agent from any hub.
 * The verifier did not close it either: `check_enroll_authority` filtered on
 * `type != "afp:Enroll"` and returned, so the resulting bundle replayed clean.
 * Every rule that reads the Enroll trail — role, operator bucket, the pinned
 * electorate ADR-0021 Decision 2 will check — was reading a trail anyone could
 * edit.
 *
 *   node --experimental-sqlite --test test/adr0021.test.ts
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  castVote,
  enroll,
  equivocationProof,
  memberAdmit,
  memberExpel,
  offerProposal,
  unenroll,
} from "../src/hub/activities.ts";
import { keyCompromiseClaim } from "../src/ap/activities.ts";
import { digestOf } from "../src/crypto/proof.ts";
import { exportBundle } from "../src/export.ts";
import { vouch } from "../src/ap/activities.ts";
import { cleanupWorkspaces, mutateBundle, runVerifier, testHub, testInstance } from "./helpers.ts";
import { VERIFIER } from "./adr0010-fixtures.ts";

after(cleanupWorkspaces);

const CAPABILITY = "afp:cap:assess";
const AGENTS = ["victim", "bystander", "third"] as const;
const HUB_ID = "membership";
const OUTBOX_NAME = "hub-membership";

/** Two seats, both enrolled by their own instance — the lawful starting point. */
function bridge() {
  const { instance, config, clock } = testInstance([...AGENTS], CAPABILITY);
  const { hub } = testHub(instance, [...AGENTS], HUB_ID);
  const thread = `${config.origin}/threads/enroll`;
  for (const agent of AGENTS) {
    hub.receive(
      instance.publishAsInstance([hub.actorId], thread, "hub", (envelope) =>
        enroll(envelope, {
          agent: instance.actorId(agent),
          hub: hub.actorId,
          capabilities: [CAPABILITY],
          hubKey: `${instance.actorId(agent)}#${HUB_ID}`,
        }),
      ).activity,
    );
  }
  return { instance, config, clock, hub, thread };
}

type Bridge = ReturnType<typeof bridge>;

/** The hub is vouched onto the roster like any agent, then the bundle is written. */
function exportOf(t: Bridge) {
  t.instance.publishAsInstance([], `${t.config.origin}/threads/roster`, "public", (envelope) =>
    vouch(envelope, { agent: t.hub.actorId, capabilities: ["afp:cap:hub"], keyCustody: "self" }),
  );
  return exportBundle(t.instance, t.config.exportDir, [t.hub]);
}

describe("ADR-0021 Decision 1 — a membership change is authorized", () => {
  it("G0a — an agent signing an Unenroll against a peer is refused, and the seat survives", async () => {
    const t = bridge();
    assert.equal(t.hub.members().length, 3, "all seats enrolled to begin with");

    // The attack, exactly as probed while writing the ADR: an *agent* — not
    // the operating instance — signs an Unenroll naming a peer. ADR-0005 D2
    // would reject this shape on an Enroll; before ADR-0021 nothing rejected
    // it on an Unenroll.
    const victim = t.instance.actorId("victim");
    const attack = t.instance.publish("bystander", [t.hub.actorId], t.thread, "hub", (envelope) =>
      unenroll(envelope, { agent: victim, hub: t.hub.actorId, reason: "because I said so" }),
    ).activity;
    await t.hub.receive(attack);

    assert.equal(t.hub.members().length, 3, "membership is unchanged");
    assert.ok(t.hub.members().includes(victim), "the victim keeps its seat");
    assert.equal(t.hub.roleOf(victim), "member", "and keeps its role");
    t.instance.close();
  });

  it("G0b — that same Unenroll spliced into a bundle fails unenroll:...by its own instance", async () => {
    const t = bridge();
    const victim = t.instance.actorId("victim");
    exportOf(t);

    // Published after the export so it lands at the tail of the instance
    // chain, then spliced in — the same mutation shape ADR-0020's gate uses.
    const attack = t.instance.publish("bystander", [t.hub.actorId], t.thread, "hub", (envelope) =>
      unenroll(envelope, { agent: victim, hub: t.hub.actorId, reason: "because I said so" }),
    ).activity;

    const mutated = mutateBundle(VERIFIER, t.config.exportDir, t.thread, OUTBOX_NAME, (outbox) => {
      outbox.orderedItems.push(attack as never);
    });
    assert.notEqual(mutated.code, 0, "an unauthorized Unenroll must not replay clean");
    assert.match(mutated.output, /FAIL \] unenroll: .* unenrolled by its own instance/);
    t.instance.close();
  });

  it("G0c — an instance unenrolling its own agent is admitted, and replays clean", async () => {
    const t = bridge();
    const victim = t.instance.actorId("victim");

    // Self-preemption stays lawful (01 § instance-level consequence): the
    // issuer and the operator are the same party.
    await t.hub.receive(
      t.instance.publishAsInstance([t.hub.actorId], t.thread, "hub", (envelope) =>
        unenroll(envelope, { agent: victim, hub: t.hub.actorId, reason: "withdrawing our own seat" }),
      ).activity,
    );

    assert.equal(t.hub.members().length, 2, "the seat is gone");
    assert.ok(!t.hub.members().includes(victim));

    exportOf(t);
    const clean = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.equal(clean.code, 0, `a self-issued Unenroll must replay clean:\n${clean.output}`);
    assert.match(clean.output, /ok\s*\] unenroll: .* unenrolled by its own instance/);
    t.instance.close();
  });

  it("G1 — a round pinning its whole electorate replays clean, with the family running", async () => {
    const t = bridge();
    const round = `${t.config.origin}/rounds/whole`;
    t.hub.proposeRound({ round, thread: t.thread, question: "ship it?", options: ["yes", "no"] });
    t.hub.closeRound(round);

    const object = t.hub.outbox
      .byActor(t.hub.actorId)
      .map((e) => e.activity.object as Record<string, unknown>)
      .find((o) => o?.type === "afp:Proposal")!;
    assert.equal(object["afp:excluded"], undefined, "nothing to declare, nothing emitted — W0.6");

    exportOf(t);
    const clean = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.equal(clean.code, 0, `a complete electorate must replay clean:\n${clean.output}`);
    assert.match(clean.output, /ok\s*\] electorate: .* accounts for every enrolled member/);
    assert.match(clean.output, /ok\s*\] round: .* quorum snapshot matches its voter list/);
    t.instance.close();
  });

  it("G2 — a proposal that omits a member and declares nothing fails the electorate check", async () => {
    const t = bridge();
    // Signed legitimately by a member rather than mutated after the fact: a
    // spliced edit to afp:voters would fail the signature check first, and a
    // gate row must fail for the reason it names.
    const voters = [t.instance.actorId("victim"), t.instance.actorId("bystander")]; // "third" omitted
    t.instance.publish("victim", [t.hub.actorId], t.thread, "hub", (envelope) =>
      offerProposal(envelope, {
        proposalId: `${envelope.actor}/proposals/silent-omission`,
        round: `${t.config.origin}/rounds/silent-omission`,
        hub: t.hub.actorId,
        question: "ship it?",
        options: ["yes", "no"],
        quorumSnapshot: digestOf([...voters].sort()),
        voters,
        weights: Object.fromEntries(voters.map((v) => [v, 1])),
      }),
    );
    exportOf(t);
    const out = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.notEqual(out.code, 0, "a silently disenfranchised member must not replay clean");
    assert.match(out.output, /FAIL \] electorate: .* accounts for every enrolled member/);
    assert.match(out.output, /neither pinned nor declared/);
    t.instance.close();
  });

  it("G3 — a snapshot digest over a different set fails the quorum-snapshot check", async () => {
    const t = bridge();
    const voters = AGENTS.map((a) => t.instance.actorId(a));
    t.instance.publish("victim", [t.hub.actorId], t.thread, "hub", (envelope) =>
      offerProposal(envelope, {
        proposalId: `${envelope.actor}/proposals/wrong-digest`,
        round: `${t.config.origin}/rounds/wrong-digest`,
        hub: t.hub.actorId,
        question: "ship it?",
        options: ["yes", "no"],
        quorumSnapshot: digestOf([...voters].sort().slice(1)), // a digest of a DIFFERENT set
        voters,
        weights: Object.fromEntries(voters.map((v) => [v, 1])),
      }),
    );
    exportOf(t);
    const out = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.notEqual(out.code, 0, "a snapshot naming one set and listing another must not replay clean");
    assert.match(out.output, /FAIL \] round: .* quorum snapshot matches its voter list/);
    t.instance.close();
  });

  it("G4 — a deliberately narrow electorate is admitted once it is declared", async () => {
    const t = bridge();
    const round = `${t.config.origin}/rounds/narrow`;
    // 02's proposer-declared electorate, still permitted — the change is that
    // the hub now signs a statement about whom it left out.
    t.hub.proposeRound({
      round,
      thread: t.thread,
      question: "ship it?",
      options: ["yes", "no"],
      voters: [t.instance.actorId("victim"), t.instance.actorId("bystander")],
    });
    t.hub.closeRound(round);

    const object = t.hub.outbox
      .byActor(t.hub.actorId)
      .map((e) => e.activity.object as Record<string, unknown>)
      .find((o) => o?.type === "afp:Proposal" && o["afp:round"] === round)!;
    const excluded = object["afp:excluded"] as { agent: string; "afp:status": string }[];
    assert.equal(excluded.length, 1, "the omitted seat is declared");
    assert.equal(excluded[0].agent, t.instance.actorId("third"));
    assert.equal(excluded[0]["afp:status"], "not-pinned", "live and left out — never mislabelled not-live");

    exportOf(t);
    const clean = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.equal(clean.code, 0, `a declared exclusion must replay clean:\n${clean.output}`);
    assert.match(clean.output, /ok\s*\] electorate: .* accounts for every enrolled member/);
    t.instance.close();
  });

  it("G17 — a proposal with no Enroll trail in the replay records unresolvable, not a failure", async () => {
    const voters = ["https://outsider.example/agents/a", "https://outsider.example/agents/b"];
    // An instance that hosts no hub and holds none of the hub's Enroll trail:
    // the question cannot be answered from these bytes, and "cannot answer"
    // must never read as "yes" (W0.5).
    const lone = testInstance(["outsider"], CAPABILITY, "https://outsider.example");
    const thread = `${lone.config.origin}/threads/x`;
    lone.instance.publish("outsider", [], thread, "hub", (envelope) =>
      offerProposal(envelope, {
        proposalId: `${envelope.actor}/proposals/orphan`,
        round: `${lone.config.origin}/rounds/orphan`,
        hub: `${lone.config.origin}/hubs/elsewhere`,
        question: "ship it?",
        options: ["yes", "no"],
        quorumSnapshot: digestOf([...voters].sort()),
        voters,
        weights: Object.fromEntries(voters.map((v) => [v, 1])),
      }),
    );
    const dir = mkdtempSync(join(tmpdir(), "afp-21-orphan-"));
    exportBundle(lone.instance, dir, []);

    const out = runVerifier(VERIFIER, dir, thread, ["--verbose"]);
    assert.equal(out.code, 0, `an unanswerable electorate check must not fail:\n${out.output}`);
    assert.match(out.output, /unresolvable: this replay carries no Enroll trail/);
    lone.instance.close();
  });

  it("G0d — a later Unenroll does not move a closed round's recomputed weights", async () => {
    const t = bridge();

    // Three seats under ONE operator is the shape that makes the defect
    // visible: ADR-0005 divides the operator's single weight among its live
    // pinned voters, so the round pins 1 each (lcm 3 / 3). Drop one seat from
    // the trail afterwards and the fold reads two operators — the departed
    // agent becomes its own, via `instances.get(v, v)` — which re-divides to
    // 2/1/1 and no longer matches what the round signed. Two seats would NOT
    // discriminate: both groupings yield 1/1, and the first draft of this row
    // passed with the fix reverted.
    //
    // A round is pinned and closed while all three seats are enrolled...
    const round = `${t.config.origin}/rounds/before`;
    t.hub.proposeRound({ round, thread: t.thread, question: "ship it?", options: ["yes", "no"] });
    t.hub.closeRound(round);

    // ...and only afterwards does the operator withdraw one of them. The
    // round's weights are recomputed from the trail as of the PROPOSAL's own
    // instant, so this must not reach backwards into signed history.
    t.clock.jumpTo("2026-08-17T10:00:00.000Z");
    await t.hub.receive(
      t.instance.publishAsInstance([t.hub.actorId], t.thread, "hub", (envelope) =>
        unenroll(envelope, { agent: t.instance.actorId("victim"), hub: t.hub.actorId, reason: "after the fact" }),
      ).activity,
    );

    exportOf(t);
    const clean = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.equal(clean.code, 0, `a post-close Unenroll must not disturb the closed round:\n${clean.output}`);
    assert.match(clean.output, /ok\s*\] weights: .* pinned weights honor declared control/);
    t.instance.close();
  });
});

// ---------------------------------------------------------------- Decisions 3-5

/**
 * The far side of the moment of conviction. ADR-0020 stopped exactly there:
 * it rules what convicts, who inherits a stalled round, when a doomed round
 * may close and how silence fails. What a conviction *means*, whom it
 * punishes, whether it can be undone, who judges the judged, and where the
 * proof goes afterwards were all left for here.
 *
 * The through-line every row below is testing: **the proof is about a key;
 * every consequence is about a party.**
 */

const GOV_POLICY = { yes: "expel-member", no: "retain-member", "afp:no-decision": "retain-member" } as const;

/** The one lawful `afp:EquivocationProof` these rows are built on: a real pair, really convicted. */
async function convictThird(t: Bridge): Promise<{ proofDigest: string; convicted: string }> {
  const convicted = t.instance.actorId("third");
  const round = `${t.config.origin}/rounds/l1`;
  const proposal = t.hub.proposeRound({
    round,
    thread: t.thread,
    question: "ship it?",
    options: ["yes", "no"],
    level: 1,
  });
  const snapshot = String((proposal.activity.object as Record<string, unknown>)["afp:quorumSnapshot"]);
  const ballot = (value: string) =>
    t.instance.publish("third", [t.hub.actorId], t.thread, "hub", (envelope) =>
      castVote(envelope, {
        voteId: `${envelope.actor}/votes/l1/${value}`,
        round,
        hub: t.hub.actorId,
        proposalHash: proposal.digest,
        quorumSnapshot: snapshot,
        value,
        phase: "prepare",
        seqNo: 1,
      }),
    ).activity;

  // Two ballots, same (actor, round, phase, seqNo), different values: the hub
  // assembles and publishes the proof itself on seeing the second.
  await t.hub.receive(ballot("yes"));
  await t.hub.receive(ballot("no"));
  t.hub.closeRound(round);

  const proof = t.hub.outbox
    .byActor(t.hub.actorId)
    .find((entry) => (entry.activity.object as Record<string, unknown>)?.type === "afp:EquivocationProof");
  assert.ok(proof, "the hub publishes the proof it recomputed — ADR-0020 Decision 5, path B");
  return { proofDigest: proof.digest, convicted };
}

/** A member-signed proposal with a hand-built electorate — the shape a mutation row needs. */
function memberProposal(
  t: Bridge,
  name: string,
  voters: readonly string[],
  excluded: readonly Record<string, unknown>[],
  extra: Record<string, unknown> = {},
) {
  return t.instance.publish("victim", [t.hub.actorId], t.thread, "hub", (envelope) => {
    const activity = offerProposal(envelope, {
      proposalId: `${envelope.actor}/proposals/${name}`,
      round: `${t.config.origin}/rounds/${name}`,
      hub: t.hub.actorId,
      question: "ship it?",
      options: ["yes", "no"],
      quorumSnapshot: digestOf([...voters].sort()),
      voters: [...voters],
      weights: Object.fromEntries(voters.map((v) => [v, 1])),
    });
    const object = activity.object as Record<string, unknown>;
    object["afp:excluded"] = excluded.map((entry) => ({ ...entry }));
    Object.assign(object, extra);
    return activity;
  }).activity;
}

describe("ADR-0021 Decision 3 — recusal is declared, caused, and recomputable", () => {
  it("G5 — an equivocator recused with its own proof as cause replays clean", async () => {
    const t = bridge();
    const { proofDigest, convicted } = await convictThird(t);

    const round = `${t.config.origin}/rounds/after-conviction`;
    const proposal = t.hub.proposeRound({
      round,
      thread: t.thread,
      question: "ship it?",
      options: ["yes", "no"],
      recused: [{ agent: convicted, cause: { "afp:form": "equivocation-proof", "afp:proof": proofDigest } }],
    });
    t.hub.closeRound(round);

    const object = proposal.activity.object as Record<string, JsonValue>;
    const excluded = object["afp:excluded"] as { agent: string; "afp:status": string; "afp:cause": unknown }[];
    assert.deepEqual(
      excluded.find((e) => e.agent === convicted),
      { agent: convicted, "afp:status": "recused", "afp:cause": { "afp:form": "equivocation-proof", "afp:proof": proofDigest } },
      "the exclusion says who, and why, in a form the record resolves",
    );
    assert.ok(!(object["afp:voters"] as string[]).includes(convicted), "the recused seat is not in the electorate");

    // The denominator moved because the SNAPSHOT moved (Decision 3's table),
    // not because a proof lowered a bar — ADR-0020's ruling is untouched.
    const weights = object["afp:voterWeights"] as Record<string, number>;
    assert.equal(Object.keys(weights).length, 2, "the bar is computed over the remainder, in the open, before any vote");

    exportOf(t);
    const clean = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.equal(clean.code, 0, `a caused recusal must replay clean:\n${clean.output}`);
    assert.match(clean.output, /ok\s*\] recusal: .* has a resolvable cause/);
    t.instance.close();
  });

  it("G5b — the hub refuses to sign a recusal whose cause it cannot resolve", async () => {
    const t = bridge();
    // The estimator wall, transplanted: a proposer may recuse the convicted
    // and the accused, and nobody else. Refusing here rather than emitting a
    // claim the verifier will reject is ADR-0018's discipline for an
    // unrecomputable quorum rule, applied to an unrecomputable exclusion.
    assert.throws(
      () =>
        t.hub.proposeRound({
          round: `${t.config.origin}/rounds/wishful`,
          thread: t.thread,
          question: "ship it?",
          options: ["yes", "no"],
          recused: [
            {
              agent: t.instance.actorId("third"),
              cause: { "afp:form": "equivocation-proof", "afp:proof": "sha256:not-on-any-record" },
            },
          ],
        }),
      /does not resolve/,
    );
    t.instance.close();
  });

  it("G6 — a recusal citing a proof that convicts somebody else fails the cause check", async () => {
    const t = bridge();
    const { proofDigest } = await convictThird(t);
    const victim = t.instance.actorId("victim");
    const bystander = t.instance.actorId("bystander");
    const third = t.instance.actorId("third");

    // The partition still holds — every member is accounted for — so this row
    // can only fail for the reason it names: the cited proof convicts `third`,
    // and the entry recuses `bystander`.
    memberProposal(t, "borrowed-proof", [victim, third], [
      { agent: bystander, "afp:status": "recused", "afp:cause": { "afp:form": "equivocation-proof", "afp:proof": proofDigest } },
    ]);

    exportOf(t);
    const out = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.notEqual(out.code, 0, "recusing an opponent on somebody else's conviction must not replay clean");
    assert.match(out.output, /FAIL \] recusal: .* has a resolvable cause/);
    t.instance.close();
  });

  it("G7 — a governance-subject cause on a round pinning no subject fails the cause check", async () => {
    const t = bridge();
    const victim = t.instance.actorId("victim");
    const bystander = t.instance.actorId("bystander");
    const third = t.instance.actorId("third");

    memberProposal(t, "no-subject", [victim, bystander], [
      { agent: third, "afp:status": "recused", "afp:cause": { "afp:form": "governance-subject" } },
    ]);

    exportOf(t);
    const out = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.notEqual(out.code, 0, "a cause with nothing to resolve against must not replay clean");
    assert.match(out.output, /FAIL \] recusal: .* has a resolvable cause/);
    t.instance.close();
  });

  it("G8 — an operator with two seats, one recused, carries its whole weight on the seat that remains", async () => {
    const t = bridge();
    const { proofDigest, convicted } = await convictThird(t);

    // Three seats, one operator: the pinned weights are 1/1/1 (lcm 3 ÷ 3).
    // Recuse one and the SAME `voterWeights` recomputes over the remainder —
    // 1/1 (lcm 2 ÷ 2). No second weight function exists, and an implementer
    // who finds themselves writing one has taken a wrong turn (W0.1).
    const round = `${t.config.origin}/rounds/remainder`;
    const proposal = t.hub.proposeRound({
      round,
      thread: t.thread,
      question: "ship it?",
      options: ["yes", "no"],
      recused: [{ agent: convicted, cause: { "afp:form": "equivocation-proof", "afp:proof": proofDigest } }],
    });
    const object = proposal.activity.object as Record<string, JsonValue>;
    const weights = object["afp:voterWeights"] as Record<string, number>;
    assert.deepEqual(
      Object.values(weights).sort(),
      [1, 1],
      "the remainder is weighed by the one arithmetic ADR-0005 pinned, not by a recusal-specific rule",
    );
    assert.equal(weights[convicted], undefined, "a recused seat has no weight, because it is not in the electorate");
    t.hub.closeRound(round);
    t.instance.close();
  });
});

describe("ADR-0021 Decision 4 — conviction is cryptographic, consequence is governed", () => {
  /** A governance round about `subject`, carried to a ratified decision. */
  function governanceRound(t: Bridge, name: string, subject: string, cause: Record<string, unknown>) {
    const round = `${t.config.origin}/rounds/${name}`;
    const proposal = t.hub.proposeRound({
      round,
      thread: t.thread,
      question: `Expel ${subject}?`,
      options: ["yes", "no"],
      pins: { actionPolicy: { ...GOV_POLICY } },
      governanceSubject: subject,
      recused: [{ agent: subject, cause: cause as never }],
    });
    const snapshot = String((proposal.activity.object as Record<string, unknown>)["afp:quorumSnapshot"]);
    for (const name_ of ["victim", "bystander"]) {
      if (t.instance.actorId(name_) === subject) continue;
      t.hub.receive(
        t.instance.publish(name_, [t.hub.actorId], t.thread, "hub", (envelope) =>
          castVote(envelope, {
            voteId: `${envelope.actor}/votes/${name}`,
            round,
            hub: t.hub.actorId,
            proposalHash: proposal.digest,
            quorumSnapshot: snapshot,
            value: "yes",
          }),
        ).activity,
      );
    }
    const decision = t.hub.closeRound(round);
    assert.equal((decision.activity.object as Record<string, JsonValue>)["afp:outcome"], "yes");
    return { round, decision, proposal };
  }

  it("G9 — a governance round expels its subject, with the subject recused from its own sanction", async () => {
    const t = bridge();
    const { proofDigest, convicted } = await convictThird(t);
    const { decision, proposal } = governanceRound(t, "expel-third", convicted, {
      "afp:form": "equivocation-proof",
      "afp:proof": proofDigest,
    });

    // The accused is out of its own electorate — and out of the denominator —
    // by a rule anyone can recompute, which is what makes the round honest.
    const object = proposal.activity.object as Record<string, JsonValue>;
    assert.equal(object["afp:governanceSubject"], convicted);
    assert.ok(!(object["afp:voters"] as string[]).includes(convicted), "the accused does not vote on its own expulsion");

    // The consequence is a *member's* act, bound to the decision by afp:actsOn.
    await t.hub.receive(
      t.instance.publish("victim", [t.hub.actorId], t.thread, "hub", (envelope) =>
        memberExpel(envelope, {
          agent: convicted,
          hub: t.hub.actorId,
          decisionDigest: decision.digest,
          action: "expel-member",
        }),
      ).activity,
    );
    assert.ok(!t.hub.members().includes(convicted), "the seat is gone, by ratified decision rather than by fiat");

    exportOf(t);
    const clean = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.equal(clean.code, 0, `a ratified expulsion must replay clean:\n${clean.output}`);
    assert.match(clean.output, /ok\s*\] membership: .* actuates its round's declared action/);
    t.instance.close();
  });

  it("G10 — an expulsion naming an agent its round never decided about fails by name", async () => {
    const t = bridge();
    const { proofDigest, convicted } = await convictThird(t);
    const { decision } = governanceRound(t, "expel-wrong", convicted, {
      "afp:form": "equivocation-proof",
      "afp:proof": proofDigest,
    });

    // A round about `third` cannot expel `bystander`, however ratified it was.
    const stray = t.instance.publish("victim", [t.hub.actorId], t.thread, "hub", (envelope) =>
      memberExpel(envelope, {
        agent: t.instance.actorId("bystander"),
        hub: t.hub.actorId,
        decisionDigest: decision.digest,
        action: "expel-member",
      }),
    ).activity;
    await t.hub.receive(stray);
    assert.ok(t.hub.members().includes(t.instance.actorId("bystander")), "the hub refuses it at the door too");

    exportOf(t);
    const out = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.notEqual(out.code, 0, "an expulsion of somebody the round never named must not replay clean");
    assert.match(out.output, /FAIL \] membership: .* names the subject its round decided/);
    t.instance.close();
  });

  it("G10b — an expulsion signed by the hub's own key is not a ratified act", async () => {
    const t = bridge();
    const { proofDigest, convicted } = await convictThird(t);
    const { decision } = governanceRound(t, "expel-by-hub", convicted, {
      "afp:form": "equivocation-proof",
      "afp:proof": proofDigest,
    });

    // 02, verbatim and load-bearing: hub governance "requires a weighted
    // quorum vote among current instance members … never a signature from the
    // hub's own key." ADR-0014 made the hub the sequencing authority that
    // signs proposals, and that habit walks straight into this.
    const byHub = t.hub.emit([t.instance.actorId("victim")], t.thread, "hub", (envelope) =>
      memberExpel(envelope, {
        agent: convicted,
        hub: t.hub.actorId,
        decisionDigest: decision.digest,
        action: "expel-member",
      }),
    );
    assert.ok(byHub, "the hub can physically sign one — which is exactly why the rule must be checked");

    exportOf(t);
    const out = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.notEqual(out.code, 0, "a self-signed expulsion must not replay clean");
    assert.match(out.output, /FAIL \] membership: .* actuates its round's declared action/);
    t.instance.close();
  });

  it("G11 — a compromise claim by the agent's own instance is recorded, and changes nothing", async () => {
    const t = bridge();
    const { proofDigest, convicted } = await convictThird(t);

    await t.hub.receive(
      t.instance.publishAsInstance([t.hub.actorId], t.thread, "hub", (envelope) =>
        keyCompromiseClaim(envelope, {
          proof: proofDigest,
          // The method that ACTUALLY signed the convicting votes: under
          // instance custody an agent's activities are signed by its operating
          // instance's key, so a claim naming the agent's own key would be
          // answering about a key the proof never used — which the verifier
          // refuses, and rightly.
          verificationMethod: `${t.instance.instanceDocument().id}#ed25519-key`,
          since: "2026-08-16T00:00:00.000Z",
          content: "the key was captured before the round opened",
        }),
      ).activity,
    );

    // W0.3, the invariant an implementer is most tempted to break: a claim is
    // not evidence. The weight stays zero, and the round that follows the
    // claim still refuses the convicted seat's ballot.
    const round = `${t.config.origin}/rounds/after-claim`;
    const proposal = t.hub.proposeRound({ round, thread: t.thread, question: "ship it?", options: ["yes", "no"] });
    const voters = (proposal.activity.object as Record<string, JsonValue>)["afp:voters"] as string[];
    assert.ok(voters.includes(convicted), "the seat is still enrolled — a claim is not an expulsion either");
    t.hub.closeRound(round);

    exportOf(t);
    const clean = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.equal(clean.code, 0, `a claim from the right party must replay clean:\n${clean.output}`);
    assert.match(clean.output, /ok\s*\] claim: .* is published by the agent's own instance/);
    t.instance.close();
  });

  it("G12 — a compromise claim published by anyone else fails by name", async () => {
    const t = bridge();
    const { proofDigest, convicted } = await convictThird(t);

    // Signed by an *agent* rather than by the instance that operates the
    // convicted seat: the same standing question Vouch and Disown answer.
    t.instance.publish("bystander", [t.hub.actorId], t.thread, "hub", (envelope) =>
      keyCompromiseClaim(envelope, {
        proof: proofDigest,
        verificationMethod: `${t.instance.instanceDocument().id}#ed25519-key`,
        since: "2026-08-16T00:00:00.000Z",
      }),
    );

    exportOf(t);
    const out = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.notEqual(out.code, 0, "a claim by a party with no standing must not replay clean");
    assert.match(out.output, /FAIL \] claim: .* is published by the agent's own instance/);
    t.instance.close();
  });

  it("G13 — restoration is forward-scoped: the restored seat votes in the next round, never the last one", async () => {
    const t = bridge();
    const { proofDigest, convicted } = await convictThird(t);
    const { decision } = governanceRound(t, "restore-third", convicted, {
      "afp:form": "equivocation-proof",
      "afp:proof": proofDigest,
    });

    // A round pinned BEFORE the restoration lands. Its arithmetic is signed
    // history the moment it closes, and nothing may move it afterwards (W0.4).
    const before = `${t.config.origin}/rounds/before-restore`;
    const beforeProposal = t.hub.proposeRound({
      round: before,
      thread: t.thread,
      question: "ship it?",
      options: ["yes", "no"],
    });

    await t.hub.receive(
      t.instance.publish("victim", [t.hub.actorId], t.thread, "hub", (envelope) =>
        memberAdmit(envelope, {
          agent: convicted,
          hub: t.hub.actorId,
          decisionDigest: decision.digest,
          action: "expel-member",
        }),
      ).activity,
    );

    const after = `${t.config.origin}/rounds/after-restore`;
    const afterProposal = t.hub.proposeRound({
      round: after,
      thread: t.thread,
      question: "ship it?",
      options: ["yes", "no"],
    });

    // The same seat votes in both rounds. Observed through the record rather
    // than through the hub's internals: the earlier round, pinned while the
    // conviction stood, counts nothing from it; the later one counts it.
    for (const [round, proposal] of [[before, beforeProposal], [after, afterProposal]] as const) {
      const snapshot = String((proposal.activity.object as Record<string, unknown>)["afp:quorumSnapshot"]);
      await t.hub.receive(
        t.instance.publish("third", [t.hub.actorId], t.thread, "hub", (envelope) =>
          castVote(envelope, {
            voteId: `${envelope.actor}/votes/${round.split("/").pop()}`,
            round,
            hub: t.hub.actorId,
            proposalHash: proposal.digest,
            quorumSnapshot: snapshot,
            value: "yes",
          }),
        ).activity,
      );
    }

    const beforeCounted = (t.hub.closeRound(before).activity.object as Record<string, JsonValue>)["afp:countedVotes"];
    const afterCounted = (t.hub.closeRound(after).activity.object as Record<string, JsonValue>)["afp:countedVotes"];
    assert.equal((beforeCounted as string[]).length, 0, "a round pinned while the conviction stood keeps its arithmetic");
    assert.equal((afterCounted as string[]).length, 1, "restoration takes effect forward, from the decision that granted it");

    exportOf(t);
    const clean = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.equal(clean.code, 0, `a ratified restoration must replay clean:\n${clean.output}`);
    t.instance.close();
  });
});

describe("ADR-0021 Decision 5 — the proof gets a destination", () => {
  it("G14 — an Enroll citing a genuine proof against the enrolling agent replays clean", async () => {
    const t = bridge();
    const { proofDigest, convicted } = await convictThird(t);
    const proofActivity = t.hub.outbox.byActor(t.hub.actorId).find((e) => e.digest === proofDigest)!.activity;

    // Inline, verbatim, and not by digest alone: the bundle's artifacts/
    // channel needs an object to hang an attachment on, and an afp:Enroll's
    // object is a bare agent URL. The proof is self-contained by construction
    // (ADR-0020 Decision 1 embeds both signed votes), so a bundle that cites
    // one can carry one.
    t.instance.publishAsInstance([t.hub.actorId], t.thread, "hub", (envelope) =>
      enroll(envelope, {
        agent: convicted,
        hub: t.hub.actorId,
        capabilities: [CAPABILITY],
        hubKey: `${convicted}#${HUB_ID}`,
        evidence: [{ "afp:digest": proofDigest, "afp:object": proofActivity }],
        priorProofs: [proofDigest],
      }),
    );

    exportOf(t);
    const clean = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.equal(clean.code, 0, `a cited, honest conviction must replay clean:\n${clean.output}`);
    assert.match(clean.output, /ok\s*\] evidence: .* cited proof convicts the enrolling agent/);
    t.instance.close();
  });

  it("G16 — an empty prior-proof declaration contradicted by the record is falsified by name", async () => {
    const t = bridge();
    const { convicted } = await convictThird(t);

    // Nobody is obliged to volunteer their history. A signed denial the same
    // case file contradicts is a finding — ADR-0020 Decision 5's searchlight
    // shape, applied to a self-declaration.
    t.instance.publishAsInstance([t.hub.actorId], t.thread, "hub", (envelope) =>
      enroll(envelope, {
        agent: convicted,
        hub: t.hub.actorId,
        capabilities: [CAPABILITY],
        hubKey: `${convicted}#${HUB_ID}`,
        priorProofs: [],
      }),
    );

    exportOf(t);
    const out = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.notEqual(out.code, 0, "a denial the record contradicts must not replay clean");
    assert.match(out.output, /FAIL \] evidence: .* prior-proof declaration is not contradicted/);
    t.instance.close();
  });
});

describe("ADR-0021 Decision 4d — a revocation is not an eraser", () => {
  it("G16b — a cut backdated before the convicting votes fails, and the proof stands", async () => {
    const t = bridge();
    const { convicted } = await convictThird(t);
    exportOf(t);

    // The attack ADR-0012 never named, running the other way from the hazard
    // it did: revocation *cuts*, and `check_key_intervals` fails anything the
    // key signed after the cut. So the sanctioned party republishes its own
    // key history with the cut dated before its equivocating votes — the two
    // embedded votes now sit past it, ADR-0020's V2 requires both to verify,
    // and the proof that convicted it evaporates. Nobody's signature is
    // forged; the evidence is simply declared to have been signed by a key
    // that was already dead.
    const dir = mkdtempSync(join(tmpdir(), "afp-21-revoke-"));
    cpSync(t.config.exportDir, dir, { recursive: true });
    const manifestPath = join(dir, "MANIFEST.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const instanceActor = String(t.instance.instanceDocument().id);
    for (const entry of manifest["afp:keyHistory"] as Record<string, unknown>[]) {
      if (entry["afp:actor"] !== instanceActor) continue;
      entry["afp:validUntil"] = "2026-08-01T00:00:00.000Z"; // long before any vote was cast
      entry["afp:retiredBy"] = "revocation";
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const out = runVerifier(VERIFIER, dir, t.thread, ["--verbose"]);
    assert.notEqual(out.code, 0, "a backdated revocation must not quietly retire the evidence");
    assert.match(out.output, /FAIL \] claim: .* revocation does not predate a proof against it/);
    assert.ok(convicted, "the conviction is what the cut was aimed at");
    t.instance.close();
  });
});

describe("ADR-0021 Decision 5b — a citation that cannot be resolved is not a citation that passed", () => {
  it("G15 — a foreign Enroll citing a proof whose signer this replay does not publish records unresolvable", async () => {
    // The case the P6 demo taught us to expect, and the one an implementer
    // gets wrong first: an enrollment at a NEW hub is exactly the situation
    // where the accused's own bundle is absent by definition. The hub host
    // must weigh a citation whose signing key it has never seen.
    const host = bridge();
    const foreign = testInstance(["stranger"], CAPABILITY, "https://stranger.example");
    const strangerId = foreign.instance.actorId("stranger");
    const foreignThread = `${foreign.config.origin}/threads/enroll`;

    // The foreign operator's own conviction, assembled on its own chain: two
    // ballots at one (actor, round, phase, seqNo), differing in value.
    const foreignRound = `${foreign.config.origin}/rounds/elsewhere`;
    const ballot = (value: string) =>
      foreign.instance.publish("stranger", [], foreignThread, "hub", (envelope) =>
        castVote(envelope, {
          voteId: `${envelope.actor}/votes/${value}`,
          round: foreignRound,
          proposalHash: "sha256:elsewhere",
          quorumSnapshot: "sha256:elsewhere",
          value,
          phase: "prepare",
          seqNo: 1,
        }),
      ).activity;
    const proof = foreign.instance.publishAsInstance([], foreignThread, "hub", (envelope) =>
      equivocationProof(envelope, {
        proofId: `${foreign.config.origin}/proofs/stranger`,
        hub: `${foreign.config.origin}/hubs/elsewhere`,
        round: foreignRound,
        votes: [ballot("yes"), ballot("no")],
      }),
    ).activity;

    // The stranger's instance enrolls it at OUR hub, declaring the conviction
    // rather than hiding it — the honest move Decision 5a exists to reward.
    const enrollment = foreign.instance.publishAsInstance([host.hub.actorId], foreignThread, "hub", (envelope) =>
      enroll(envelope, {
        agent: strangerId,
        hub: host.hub.actorId,
        capabilities: [CAPABILITY],
        hubKey: `${strangerId}#${HUB_ID}`,
        evidence: [{ "afp:digest": digestOf(proof), "afp:object": proof }],
      }),
    ).activity;

    host.instance.publishAsInstance([], `${host.config.origin}/threads/roster`, "public", (envelope) =>
      vouch(envelope, { agent: host.hub.actorId, capabilities: ["afp:cap:hub"], keyCustody: "self" }),
    );
    exportBundle(host.instance, host.config.exportDir, [host.hub], undefined, {
      receivedActivities: () => [
        { digest: digestOf(enrollment), fromInstance: String(foreign.instance.instanceDocument().id), activity: enrollment },
      ],
    });

    const out = runVerifier(VERIFIER, host.config.exportDir, host.thread, ["--verbose"]);
    // Three-valued, and the third value is recorded rather than swallowed: the
    // pair genuinely convicts (recomputable without any key at all), but the
    // signer's key lives in a bundle nobody handed us. A reader sees
    // `unresolvable` and knows to ask for the other bundle — which is the
    // whole point, and the opposite of a check that passed vacuously.
    assert.equal(out.code, 0, `an unresolvable citation must not fail the replay:\n${out.output}`);
    assert.match(out.output, /ok\s*\] evidence: .* cited proof convicts the enrolling agent/);
    assert.match(out.output, /unresolvable: this replay publishes no key for/);
    host.instance.close();
    foreign.instance.close();
  });
});
