/**
 * ADR-0021 gate — after the proof: conviction to consequence.
 *
 * Slice one only: **Decision 1**, the membership-authority binding. Decisions
 * 2-5 are written but unbuilt, and this file grows a section per slice rather
 * than pretending to cover what does not exist yet.
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

import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { enroll, offerProposal, unenroll } from "../src/hub/activities.ts";
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
