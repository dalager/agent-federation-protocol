/**
 * ADR-0022 gate — the P7 accounting stack.
 *
 * Slice one only: **Decision 2**, the contribution split. Decisions 1, 3, 4 and
 * 5 are written and unbuilt, and this file grows a section per slice rather
 * than pretending to cover what does not exist yet.
 *
 * What Decision 2 closes, and why it goes first: `afp:contributionSplit` has
 * been normative since v3.4 — campaign 1's finding 7 introduced it as co-work's
 * escape hatch — and no builder has ever emitted it and no check has ever read
 * it. So the one case where credit is genuinely ambiguous, two agents from two
 * operators on one Result, counted for nobody, silently. Scenario 13 found it
 * by walking a support pool whose commonest working pattern is exactly that
 * shape: one desk triages, another fixes, and the desk that does the most
 * co-work is the one the ledger sees least of.
 *
 * The second half is arithmetic. 03 specified the split as "a map of actor →
 * fraction summing to 1", which the AFP JCS numeric profile forbids outright in
 * a signed document — the identical wall ADR-0005 hit for `afp:voterWeights`
 * and solved with integer shares, in an ADR that post-dates 03's sentence and
 * was never carried back to it.
 *
 *   node --experimental-sqlite --test test/adr0022.test.ts
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { createResult, vouch } from "../src/ap/activities.ts";
import { exportBundle } from "../src/export.ts";
import { cleanupWorkspaces, mutateBundle, runVerifier, testInstance } from "./helpers.ts";
import { VERIFIER } from "./adr0010-fixtures.ts";

after(cleanupWorkspaces);

const CAPABILITY = "afp:cap:assess";
const CHECK = /contribution: .* co-authored result declares a well-formed split/;

/** Two agents on one instance — the smallest shape that can co-author anything. */
function pool() {
  const { instance, config, clock } = testInstance(["triage", "fixer"], CAPABILITY);
  return { instance, config, clock, thread: `${config.origin}/threads/ticket-4471` };
}

type Pool = ReturnType<typeof pool>;

function exportOf(t: Pool) {
  t.instance.publishAsInstance([], `${t.config.origin}/threads/roster`, "public", (envelope) =>
    vouch(envelope, { agent: t.instance.actorId("triage"), capabilities: [CAPABILITY], keyCustody: "instance" }),
  );
  return exportBundle(t.instance, t.config.exportDir);
}

/** The escalation shape: triage narrows it, the fixer closes it, one Result. */
function coAuthored(t: Pool, split: Record<string, number> | undefined, authors?: readonly string[]) {
  const triage = t.instance.actorId("triage");
  const fixer = t.instance.actorId("fixer");
  return t.instance.publish("fixer", [], t.thread, "public", (envelope) =>
    createResult(envelope, {
      resultId: `${envelope.actor}/results/ticket-4471`,
      correlationId: "ticket-4471",
      content: "payment sync restored; root cause was a stale idempotency key",
      attributedTo: authors ?? [triage, fixer],
      ...(split ? { contributionSplit: split } : {}),
    }),
  );
}

describe("ADR-0022 Decision 2 — co-authored work states who did how much of it", () => {
  it("G1 — a single-author Result is untouched, and emits nothing new", () => {
    const t = pool();
    const entry = t.instance.publish("fixer", [], t.thread, "public", (envelope) =>
      createResult(envelope, {
        resultId: `${envelope.actor}/results/ordinary`,
        correlationId: "ordinary",
        content: "restarted the worker",
      }),
    );
    const object = entry.activity.object as Record<string, unknown>;
    assert.equal(object.attributedTo, t.instance.actorId("fixer"), "still a bare string, not an array");
    assert.equal(object["afp:contributionSplit"], undefined, "nothing to divide, nothing emitted — W0.5");

    exportOf(t);
    const clean = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.equal(clean.code, 0, `an ordinary Result must replay clean:\n${clean.output}`);
    assert.doesNotMatch(clean.output, CHECK, "the check is conditional on material this bundle has none of");
    t.instance.close();
  });

  it("G2 — a co-authored Result with integer shares replays clean, and the family runs", () => {
    const t = pool();
    const triage = t.instance.actorId("triage");
    const fixer = t.instance.actorId("fixer");
    const entry = coAuthored(t, { [triage]: 1, [fixer]: 3 });

    const object = entry.activity.object as Record<string, unknown>;
    assert.deepEqual(object.attributedTo, [triage, fixer], "both authors on the record");
    assert.deepEqual(
      object["afp:contributionSplit"],
      { [triage]: 1, [fixer]: 3 },
      "integer shares — the denominator is their sum, never a fraction in a signed document",
    );

    exportOf(t);
    const clean = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.equal(clean.code, 0, `a well-formed split must replay clean:\n${clean.output}`);
    assert.match(clean.output, new RegExp(`ok\\s*\\] ${CHECK.source}`));
    t.instance.close();
  });

  it("G3 — the builder refuses a co-authored Result with no split, before anything is signed", () => {
    const t = pool();
    // 03 pairs its MUST with a fallback ("count such a Result for no one"),
    // which is a rule nobody keeps. The refusal is what gives it teeth, and it
    // happens at the port rather than at replay, where the record already
    // exists and nobody can be credited retroactively.
    assert.throws(() => coAuthored(t, undefined), /must state afp:contributionSplit/);
    t.instance.close();
  });

  it("G3b — the builder refuses a split that credits a stranger, or omits an author", () => {
    const t = pool();
    const triage = t.instance.actorId("triage");
    const fixer = t.instance.actorId("fixer");
    assert.throws(() => coAuthored(t, { [triage]: 1 }), /missing .*fixer/);
    assert.throws(
      () => coAuthored(t, { [triage]: 1, [fixer]: 1, [`${t.config.origin}/agents/nobody`]: 1 }),
      /not an author/,
    );
    t.instance.close();
  });

  it("G3c — the builder refuses a fractional or zero share", () => {
    const t = pool();
    const triage = t.instance.actorId("triage");
    const fixer = t.instance.actorId("fixer");
    // The JCS profile would refuse 0.25 at signing time anyway; refusing it
    // here names the actual rule instead of failing as a canonicalisation error.
    assert.throws(() => coAuthored(t, { [triage]: 0.25, [fixer]: 0.75 }), /positive integer/);
    assert.throws(() => coAuthored(t, { [triage]: 0, [fixer]: 4 }), /positive integer/);
    t.instance.close();
  });

  it("G4 — mutation: a split that omits one author fails the contribution check", () => {
    const t = pool();
    const triage = t.instance.actorId("triage");
    const fixer = t.instance.actorId("fixer");
    coAuthored(t, { [triage]: 1, [fixer]: 3 });
    exportOf(t);

    const out = mutateBundle(VERIFIER, t.config.exportDir, t.thread, "fixer", (outbox) => {
      for (const item of outbox.orderedItems) {
        const object = item.object as Record<string, unknown> | undefined;
        if (object?.type !== "afp:Result") continue;
        object["afp:contributionSplit"] = { [fixer]: 3 };
      }
    });
    assert.notEqual(out.code, 0, "an author with no share must not replay clean");
    assert.match(out.output, /FAIL \] contribution: .* declares a well-formed split/);
    assert.match(out.output, /author\(s\) with no share/);
    t.instance.close();
  });

  it("G6 — 03's fractions cannot be read at all: the numeric profile refuses them first", () => {
    const t = pool();
    const triage = t.instance.actorId("triage");
    const fixer = t.instance.actorId("fixer");
    coAuthored(t, { [triage]: 1, [fixer]: 3 });
    exportOf(t);

    const out = mutateBundle(VERIFIER, t.config.exportDir, t.thread, "fixer", (outbox) => {
      for (const item of outbox.orderedItems) {
        const object = item.object as Record<string, unknown> | undefined;
        if (object?.type !== "afp:Result") continue;
        object["afp:contributionSplit"] = { [triage]: 0.25, [fixer]: 0.75 };
      }
    });

    // Measured, and stronger than the ADR predicted: a fraction never reaches
    // the contribution check, because the JCS canonicaliser refuses to read a
    // signed document containing one. 03's "map of actor → fraction summing to
    // 1" is not awkward-but-workable — it is unreadable by this protocol's own
    // signing profile, which is why Decision 2a had to rewrite the sentence
    // rather than implement it.
    assert.notEqual(out.code, 0, "a fractional share must not replay clean");
    assert.match(out.output, /non-integer number 0\.75 is not allowed in a signed AFP document/);
    assert.match(out.output, /contribution:0/, "the accounting check never even runs — the profile got there first");
    t.instance.close();
  });

  it("G7 — mutation: a split on a single-author Result divides nothing, and fails", () => {
    const t = pool();
    const fixer = t.instance.actorId("fixer");
    t.instance.publish("fixer", [], t.thread, "public", (envelope) =>
      createResult(envelope, {
        resultId: `${envelope.actor}/results/solo`,
        correlationId: "solo",
        content: "restarted the worker",
      }),
    );
    exportOf(t);

    const out = mutateBundle(VERIFIER, t.config.exportDir, t.thread, "fixer", (outbox) => {
      for (const item of outbox.orderedItems) {
        const object = item.object as Record<string, unknown> | undefined;
        if (object?.type !== "afp:Result") continue;
        object["afp:contributionSplit"] = { [fixer]: 1 };
      }
    });
    assert.notEqual(out.code, 0, "a division of one is not a division");
    assert.match(out.output, /FAIL \] contribution: .* declares a well-formed split/);
    assert.match(out.output, /divides\s*\n?\s*nothing|divides nothing/);
    t.instance.close();
  });
});

describe("ADR-0022 / finding 74 — a retired spelling still replays, and says so", () => {
  it("G9 — a bundle written under afp:bidCommit is read, and the fact is named", () => {
    const t = pool();
    t.instance.publish("fixer", [], t.thread, "public", (envelope) =>
      createResult(envelope, {
        resultId: `${envelope.actor}/results/pre-rename`,
        correlationId: "pre-rename",
        content: "written when the type had another name",
      }),
    );
    exportOf(t);

    // ADR-0017 Decision 5 renamed afp:bidCommit to afp:BidCommit with no
    // read-side compatibility, so every bundle older than 2026-08-22 replayed
    // as though its commitments did not exist — failing as "reveal with no
    // matching commitment", which names the wrong thing entirely.
    const out = mutateBundle(VERIFIER, t.config.exportDir, t.thread, "fixer", (outbox) => {
      const first = outbox.orderedItems[0] as Record<string, unknown>;
      outbox.orderedItems.push({ ...first, type: "afp:bidCommit" } as never);
    });
    // The spliced activity breaks the chain (it is a copy), so the replay fails
    // — but the vocabulary line must be there and must be the one that names
    // the retired spelling.
    assert.match(out.output, /vocabulary: .* uses the retired spelling afp:bidCommit/);
    assert.match(out.output, /the record is intact and its vocabulary is older than this verifier/);
    t.instance.close();
  });
});

// ---------------------------------------------------- Decisions 1 and 3 (slice two)

/**
 * The frame, and the digest that finally has a preimage.
 *
 * Scenario 13's four support desks recomputed the same quarter and got
 * different numbers without anyone misbehaving: one of them could not read a
 * fifth of the work, and nothing in the summary said so. These rows are that
 * scenario reduced to its smallest honest shape — one hub, one settled task,
 * one summary — plus the mutations that separate "this number is wrong" from
 * "this number was computed over a different set."
 */

import { computeContribution, contributionSummary, hubChainSlice, type SummaryFrame } from "../src/hub/summary.ts";
import { testHub } from "./helpers.ts";
import { bidPayload, commitmentOf } from "../src/allocation/activities.ts";
import { enroll } from "../src/hub/activities.ts";

const HUB_ID = "nightdesk";

/** One hub, two desks, one task announced, bid, awarded, answered and settled. */
async function quarter() {
  const { instance, config, clock } = testInstance(["triage", "fixer"], CAPABILITY);
  const { hub } = testHub(instance, ["triage", "fixer"], HUB_ID);
  const enrollThread = `${config.origin}/threads/enroll`;
  for (const agent of ["triage", "fixer"]) {
    await hub.receive(
      instance.publishAsInstance([hub.actorId], enrollThread, "hub", (envelope) =>
        enroll(envelope, {
          agent: instance.actorId(agent),
          hub: hub.actorId,
          capabilities: [CAPABILITY],
          hubKey: `${instance.actorId(agent)}#${HUB_ID}`,
        }),
      ).activity,
    );
  }

  const thread = `${config.origin}/threads/ticket-4471`;
  const taskId = `${hub.actorId}/tasks/ticket-4471`;
  const window = { opens: "2026-08-17T09:00:00.000Z", closes: "2026-08-17T10:00:00.000Z" };
  hub.allocation.announce({
    taskId,
    thread,
    hub: hub.actorId,
    capability: CAPABILITY,
    content: "payment sync failing for one customer",
    correlationId: "ticket-4471",
    bidWindow: window,
    selectionRule: { name: "ranking", params: { weights: { capabilityMatch: 1 } } as never },
    answerSufficiency: { count: 1 } as never,
    estimatorPolicy: "exclude",
    estimators: [],
  });

  const payload = bidPayload({
    task: taskId,
    bidder: instance.actorId("fixer"),
    capabilityMatch: 90,
    estimatedCost: { unit: "EUR", value: 100 },
    estimatedLatency: "PT1H",
    nonce: "nonce-4471",
  });
  await hub.receive(
    instance.publish("fixer", [hub.actorId], thread, "hub", (envelope) => ({
      "@context": ["https://www.w3.org/ns/activitystreams", "https://dalager.github.io/agent-federation-protocol/ns/v3.jsonld"],
      id: envelope.activityId,
      actor: envelope.actor,
      to: [...envelope.to],
      published: envelope.published,
      context: envelope.thread,
      "afp:visibility": envelope.visibility,
      ...(envelope.prevActivity !== null ? { "afp:prevActivity": envelope.prevActivity } : {}),
      type: "afp:BidCommit",
      object: taskId,
      "afp:hub": hub.actorId,
      "afp:commitment": commitmentOf(payload),
    })).activity,
  );
  clock.jumpTo(new Date(new Date(window.closes).getTime() + 1000).toISOString());
  await hub.receive(
    instance.publish("fixer", [hub.actorId], thread, "hub", (envelope) => ({
      "@context": ["https://www.w3.org/ns/activitystreams", "https://dalager.github.io/agent-federation-protocol/ns/v3.jsonld"],
      id: envelope.activityId,
      actor: envelope.actor,
      to: [...envelope.to],
      published: envelope.published,
      context: envelope.thread,
      "afp:visibility": envelope.visibility,
      ...(envelope.prevActivity !== null ? { "afp:prevActivity": envelope.prevActivity } : {}),
      type: "afp:BidReveal",
      object: { ...payload },
      "afp:hub": hub.actorId,
    })).activity,
  );
  hub.allocation.closeAuction(taskId, new Date(clock.now().getTime() + 3600_000).toISOString());

  // The escalation: triage narrowed it, the fixer closed it, one Result.
  const triage = instance.actorId("triage");
  const fixer = instance.actorId("fixer");
  instance.publish("fixer", [hub.actorId], thread, "hub", (envelope) =>
    createResult(envelope, {
      resultId: `${envelope.actor}/results/ticket-4471`,
      correlationId: "ticket-4471",
      content: "stale idempotency key",
      attributedTo: [triage, fixer],
      contributionSplit: { [triage]: 1, [fixer]: 3 },
    }),
  );
  const settlement = hub.allocation.settle(taskId, { [fixer]: { unit: "EUR", value: 110 } } as never);

  return { instance, config, clock, hub, thread, taskId, triage, fixer, settlement };
}

type Quarter = Awaited<ReturnType<typeof quarter>>;

function frameFor(t: Quarter, to: string, from = ""): SummaryFrame {
  return {
    periodRule: { form: "hub-observed", hub: t.hub.actorId, from, to },
    inputScope: { visibility: ["public", "hub"] },
    splitRule: { form: "declared-shares" },
    vocabulary: "v3.29",
  };
}

/** Publish the summary as an ordinary member would — nobody is privileged here. */
function publishSummary(t: Quarter, frame: SummaryFrame, edit?: (object: Record<string, unknown>) => void) {
  const pool = t.hub.outbox
    .actors()
    .flatMap((actor) => t.hub.outbox.byActor(actor).map((e) => e.activity))
    .concat(t.instance.outbox.actors().flatMap((a) => t.instance.outbox.byActor(a).map((e) => e.activity)));
  const totals = computeContribution(pool, frame, (agent) => t.hub.instanceOf(agent) ?? agent)!;
  return t.instance.publish("triage", [], t.thread, "public", (envelope) => {
    const activity = contributionSummary(envelope, {
      summaryId: `${envelope.actor}/summaries/2026-q3`,
      hub: t.hub.actorId,
      computedBy: t.instance.instanceDocument().id as string,
      frame,
      totals,
    });
    if (edit) edit(activity.object as Record<string, unknown>);
    return activity;
  });
}

function exportQuarter(t: Quarter) {
  t.instance.publishAsInstance([], `${t.config.origin}/threads/roster`, "public", (envelope) =>
    vouch(envelope, { agent: t.hub.actorId, capabilities: ["afp:cap:hub"], keyCustody: "self" }),
  );
  return exportBundle(t.instance, t.config.exportDir, [t.hub]);
}

describe("ADR-0022 Decisions 1 and 3 — a summary declares its frame", () => {
  it("G10 — a summary over a hub-observed period replays clean, and its hash recomputes", async () => {
    const t = await quarter();
    const frame = frameFor(t, t.settlement.digest);
    const entry = publishSummary(t, frame);
    const object = entry.activity.object as Record<string, unknown>;

    // The escalation's split lands as integers over a common denominator: one
    // task, 1:3 between two agents of one operator, so the operator carries the
    // whole of it — the same shape ADR-0005 produces for seats.
    assert.equal(object["afp:denominator"], 4, "the denominator is the shares' sum, not a fraction");
    const entries = object["afp:entries"] as { "afp:operator": string; "afp:credited": number }[];
    assert.equal(entries.length, 1);
    assert.equal(entries[0]["afp:credited"], 4, "one whole task, credited in denominator units");
    assert.deepEqual(object["afp:unreadable"], [], "nothing was unreadable, and the census says so rather than omitting it");

    exportQuarter(t);
    const clean = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.equal(clean.code, 0, `a framed summary must replay clean:\n${clean.output}`);
    assert.match(clean.output, /ok\s*\] contribution: .* summary frame is a known form/);
    assert.match(clean.output, /ok\s*\] contribution: .* input hash matches the set its frame declares/);
    assert.match(clean.output, /ok\s*\] contribution: .* unreadable inputs are counted, not dropped/);
    t.instance.close();
  });

  it("G11 — mutation: a summary with no frame is a number in a signed envelope", async () => {
    const t = await quarter();
    publishSummary(t, frameFor(t, t.settlement.digest));
    exportQuarter(t);

    const out = mutateBundle(VERIFIER, t.config.exportDir, t.thread, "triage", (outbox) => {
      for (const item of outbox.orderedItems) {
        const object = item.object as Record<string, unknown> | undefined;
        if (object?.type !== "afp:ContributionSummary") continue;
        delete object["afp:frame"];
      }
    });
    assert.notEqual(out.code, 0, "an unframed summary must not replay clean");
    assert.match(out.output, /FAIL \] contribution: .* summary frame is a known form/);
    assert.match(out.output, /number in a signed envelope/);
    t.instance.close();
  });

  it("G12 — mutation: an unknown period form fails rather than defaulting", async () => {
    const t = await quarter();
    publishSummary(t, frameFor(t, t.settlement.digest));
    exportQuarter(t);

    const out = mutateBundle(VERIFIER, t.config.exportDir, t.thread, "triage", (outbox) => {
      for (const item of outbox.orderedItems) {
        const object = item.object as Record<string, unknown> | undefined;
        if (object?.type !== "afp:ContributionSummary") continue;
        const frame = object["afp:frame"] as Record<string, unknown>;
        (frame["afp:periodRule"] as Record<string, unknown>)["afp:form"] = "wall-clock";
      }
    });
    assert.notEqual(out.code, 0, "a closed registry stays closed — W0.4");
    assert.match(out.output, /FAIL \] contribution: .* summary frame is a known form/);
    assert.match(out.output, /unknown afp:periodRule form 'wall-clock'/);
    t.instance.close();
  });

  it("G13 — mutation: an input hash over a different set fails by name", async () => {
    const t = await quarter();
    publishSummary(t, frameFor(t, t.settlement.digest), (object) => {
      // The shape finding 69 describes: a digest that reads exactly like a
      // check and is not one, because nothing ever said what it was over.
      object["afp:inputHash"] = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    });
    exportQuarter(t);

    const out = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.notEqual(out.code, 0, "an unrecomputable input hash must not replay clean");
    assert.match(out.output, /FAIL \] contribution: .* input hash matches the set its frame declares/);
    t.instance.close();
  });

  it("G14 — a scope that cannot read the work counts it instead of dropping it", async () => {
    const t = await quarter();
    // The scenario-13 case, exactly: the computer is entitled to `public` only,
    // and the Result it must credit is `hub`. The work still happened — the hub
    // sequenced the settlement in the open — so the summary says so.
    const narrow: SummaryFrame = { ...frameFor(t, t.settlement.digest), inputScope: { visibility: ["public"] } };
    const entry = publishSummary(t, narrow);
    const object = entry.activity.object as Record<string, unknown>;

    assert.deepEqual(object["afp:entries"], [], "nothing could be credited in detail");
    const census = object["afp:unreadable"] as { "afp:operator": string; "afp:count": number }[];
    assert.equal(census.length, 1, "and the gap is counted, per operator");
    assert.equal(census[0]["afp:count"], 1);

    exportQuarter(t);
    const clean = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.equal(clean.code, 0, `a declared partial view is legitimate, and must replay clean:\n${clean.output}`);
    assert.match(clean.output, /ok\s*\] contribution: .* unreadable inputs are counted, not dropped/);
    t.instance.close();
  });

  it("G15 — mutation: a partial view that claims to have read everything fails", async () => {
    const t = await quarter();
    const narrow: SummaryFrame = { ...frameFor(t, t.settlement.digest), inputScope: { visibility: ["public"] } };
    publishSummary(t, narrow, (object) => {
      // This is the whole of finding 70: a summary that summed a partial view
      // and says nothing about it is indistinguishable from one that summed
      // everything — which is how two honest members disagreed with no way to
      // tell an entitlement gap from a fraud.
      object["afp:unreadable"] = [];
    });
    exportQuarter(t);

    const out = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.notEqual(out.code, 0, "a silent partial view must not replay clean");
    assert.match(out.output, /FAIL \] contribution: .* unreadable inputs are counted, not dropped/);
    assert.match(out.output, /declared census disagrees with the recomputed one/);
    t.instance.close();
  });

  it("G16 — an interval this replay cannot resolve is unresolvable, never a pass", async () => {
    const t = await quarter();
    publishSummary(t, frameFor(t, t.settlement.digest), (object) => {
      const frame = object["afp:frame"] as Record<string, unknown>;
      (frame["afp:periodRule"] as Record<string, unknown>)["afp:to"] = "sha256:not-in-this-replay";
    });
    exportQuarter(t);

    const out = runVerifier(VERIFIER, t.config.exportDir, t.thread, ["--verbose"]);
    assert.equal(out.code, 0, `an unanswerable arithmetic check must not fail the replay:\n${out.output}`);
    assert.match(out.output, /unresolvable: this replay does not carry the hub chain/);
    t.instance.close();
  });

  it("G17 — the chain slice is walked, not sorted: a `from` outside the chain does not resolve", async () => {
    const t = await quarter();
    const pool = t.hub.outbox.byActor(t.hub.actorId).map((e) => e.activity);
    assert.ok(hubChainSlice(pool, t.hub.actorId, "", t.settlement.digest), "a full-chain interval resolves");
    assert.equal(
      hubChainSlice(pool, t.hub.actorId, "sha256:elsewhere", t.settlement.digest),
      null,
      "and an interval whose start is not on this chain is null, never an empty period",
    );
    t.instance.close();
  });
});
