/**
 * P3 acceptance gate (ADR-0003): sealed bidding, recomputable selection,
 * award timeout → reauction, and the verifier extension — "any member
 * recomputes the published selection rule over the revealed bids and reaches
 * the same performer set and synthesizer; every reveal matches its commitment
 * hash" (05 § P3).
 */

import assert from "node:assert/strict";
import { readFileSync, writeFileSync, cpSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, describe, it } from "node:test";

import { runP3Demo, jumpClock } from "../src/demoP3.ts";
import { runRule, tieBreak, latencySeconds, type RevealedBid } from "../src/allocation/rules.ts";
import { bidPayload, commitmentOf } from "../src/allocation/activities.ts";
import { Allocator, type AllocatorHub } from "../src/allocation/allocator.ts";
import { openDb } from "../src/store/db.ts";
import { cleanupWorkspaces, runVerifier, workspace } from "./helpers.ts";

const VERIFIER = join(import.meta.dirname, "..", "..", "verifier", "afp_verify.py");

function bid(bidder: string, overrides: Partial<RevealedBid> = {}): RevealedBid {
  return {
    bidder,
    digest: `sha256:${bidder}`,
    capabilityMatch: 50,
    estimatedCostValue: 100,
    estimatedLatencySeconds: 60,
    coverage: {},
    ...overrides,
  };
}

/** An in-memory hub port: records what the allocator emits, no crypto. */
function fakeHub(members: string[]) {
  const emitted: { type: string; activity: { [key: string]: unknown } }[] = [];
  let t = new Date("2026-08-17T09:00:00.000Z").getTime();
  const hub: AllocatorHub = {
    hubId: "test-hub",
    actorId: "https://hub.test/actor",
    db: openDb(join(mkdtempSync(join(tmpdir(), "afp-alloc-")), "alloc.db")),
    members: () => members,
    now: () => new Date((t += 1000)),
    emit: (to, thread, visibility, build) => {
      const activity = build({
        activityId: `https://hub.test/activities/${emitted.length}`,
        actor: "https://hub.test/actor",
        to,
        thread,
        visibility,
        published: new Date(t).toISOString(),
        prevActivity: null,
      });
      emitted.push({ type: String(activity.type), activity });
      return { seq: emitted.length, digest: `sha256:emit-${emitted.length}`, activity } as never;
    },
  };
  return { hub, emitted, jumpTo: (iso: string) => (t = Math.max(t, new Date(iso).getTime())) };
}

const WINDOW = { opens: "2026-08-17T09:00:00.000Z", closes: "2026-08-17T09:10:00.000Z" };

function announceOn(allocator: Allocator, hubActor: string, rule: { name: string; params: never }) {
  allocator.announce({
    taskId: "https://hub.test/tasks/t1",
    thread: "urn:afp:thread:t1",
    hub: hubActor,
    capability: "afp:cap:x",
    content: "do t1",
    correlationId: "t1",
    bidWindow: WINDOW,
    selectionRule: rule,
    answerSufficiency: { count: 1 },
    estimatorPolicy: "exclude",
    estimators: ["https://a.test/estimator"],
  });
}

describe("P3 selection rules are pure and deterministic", () => {
  it("ranking scores by the published weights and breaks ties by the protocol constant", () => {
    const rule = { name: "ranking", params: { weights: { capabilityMatch: 10, cost: -1 } } };
    const picked = runRule(rule, "task-1", [
      bid("https://a.test/a", { capabilityMatch: 80, estimatedCostValue: 100 }),
      bid("https://a.test/b", { capabilityMatch: 90, estimatedCostValue: 100 }),
    ])!;
    assert.deepEqual(picked.performers, ["https://a.test/b"]);
    assert.equal(picked.synthesizer, null);

    // Identical scores: the lower tie-break digest wins, and the choice is a
    // protocol constant — stable across runs and implementations.
    const tied = runRule(rule, "task-1", [bid("https://a.test/a"), bid("https://a.test/b")])!;
    const expected =
      tieBreak("task-1", "https://a.test/a") < tieBreak("task-1", "https://a.test/b")
        ? "https://a.test/a"
        : "https://a.test/b";
    assert.deepEqual(tied.performers, [expected]);
  });

  it("coverage picks the minimal covering set and names the broadest awardee synthesizer", () => {
    const rule = { name: "coverage", params: { domains: ["x", "y", "z"], minConfidence: 60 } };
    const bids = [
      bid("https://a.test/wide", { coverage: { x: 70, y: 70 } }),
      bid("https://a.test/z", { coverage: { z: 90, y: 59 } }), // y below threshold — not counted
      bid("https://a.test/solo-x", { coverage: { x: 95 } }),
    ];
    const picked = runRule(rule, "task-2", bids)!;
    assert.deepEqual(new Set(picked.performers), new Set(["https://a.test/wide", "https://a.test/z"]));
    assert.equal(picked.synthesizer, "https://a.test/wide"); // two eligible domains beats one

    // No bid set covers a domain nobody claims — no award, never a partial one.
    assert.equal(runRule({ name: "coverage", params: { domains: ["x", "q"], minConfidence: 60 } }, "t", bids), null);
  });

  it("a zero weight contributes zero even against an unparseable latency — never NaN", () => {
    // 0 * Infinity is NaN; a NaN sort key made one implementation first-wins
    // and the other input-order. Both now skip zero-weight terms entirely.
    const rule = { name: "ranking", params: { weights: { capabilityMatch: 10 } } };
    const picked = runRule(rule, "task-nan", [
      bid("https://a.test/a", { capabilityMatch: 50, estimatedLatencySeconds: latencySeconds("4 minutes") }),
      bid("https://a.test/b", { capabilityMatch: 90, estimatedLatencySeconds: latencySeconds("4 minutes") }),
    ])!;
    assert.deepEqual(picked.performers, ["https://a.test/b"]);
  });

  it("an unknown rule name throws — a verification failure, not a skip", () => {
    assert.throws(() => runRule({ name: "vibes", params: {} }, "t", [bid("https://a.test/a")]));
  });

  it("parses the ISO-8601 latency subset", () => {
    assert.equal(latencySeconds("PT4M"), 240);
    assert.equal(latencySeconds("PT1H30M5S"), 5405);
    assert.equal(latencySeconds("4 minutes"), Number.POSITIVE_INFINITY);
  });
});

describe("P3 admission: sealed bids, windows, and the estimator wall", () => {
  it("rejects tampered reveals, out-of-window commits, strangers, and excluded estimators — all audit-logged", () => {
    const { hub, jumpTo } = fakeHub(["https://a.test/a", "https://a.test/b", "https://a.test/estimator"]);
    const allocator = new Allocator(hub);
    announceOn(allocator, hub.actorId, { name: "ranking", params: { weights: { capabilityMatch: 1 } } as never });

    const payload = bidPayload({
      task: "https://hub.test/tasks/t1",
      bidder: "https://a.test/a",
      capabilityMatch: 80,
      estimatedCost: { unit: "u", value: 10 },
      estimatedLatency: "PT1M",
      nonce: "n-1",
    });
    const commit = (actor: string, commitment: string, published: string) =>
      allocator.onCommit({ id: `c-${actor}`, type: "afp:bidCommit", actor, object: "https://hub.test/tasks/t1", published, "afp:commitment": commitment });

    commit("https://a.test/a", commitmentOf(payload), "2026-08-17T09:01:00.000Z");
    commit("https://a.test/a", "sha256:free-option", "2026-08-17T09:02:00.000Z"); // second, differing — a free option
    commit("https://a.test/b", "sha256:something", "2026-08-17T09:11:00.000Z"); // after close
    commit("https://stranger.test/s", "sha256:x", "2026-08-17T09:01:00.000Z"); // not enrolled
    commit("https://a.test/estimator", "sha256:y", "2026-08-17T09:01:00.000Z"); // excluded

    const bids = allocator.bids("https://hub.test/tasks/t1");
    assert.deepEqual(bids.map((b) => b.bidder), ["https://a.test/a"]);
    assert.equal(bids[0].commitment, commitmentOf(payload)); // the first commitment stands
    const outcomes = allocator.admissions("https://hub.test/tasks/t1");
    assert.equal(outcomes.length, 4);
    assert.match(outcomes.find((o) => o.reason.includes("differing"))!.reason, /second differing commitment/);
    assert.match(outcomes.find((o) => o.actor.endsWith("/estimator"))!.reason, /estimator excluded/);

    // A reveal whose payload does not hash to the commitment never lands.
    jumpTo("2026-08-17T09:10:01.000Z");
    const tampered = { ...payload, "afp:estimatedCost": { unit: "u", value: 5 } };
    allocator.onReveal({ id: "r-bad", type: "afp:BidReveal", actor: "https://a.test/a", object: tampered, published: "2026-08-17T09:10:05.000Z" });
    assert.equal(allocator.bids("https://hub.test/tasks/t1")[0].reveal, null);

    // The honest reveal does.
    allocator.onReveal({ id: "r-ok", type: "afp:BidReveal", actor: "https://a.test/a", object: payload, published: "2026-08-17T09:10:06.000Z" });
    assert.equal(allocator.bids("https://hub.test/tasks/t1")[0].revealDigest, commitmentOf(payload));
  });

  it("an unaccepted award is swept into a recorded Reauction awarding the next-ranked bidder", () => {
    const { hub, emitted, jumpTo } = fakeHub(["https://a.test/a", "https://a.test/b"]);
    const allocator = new Allocator(hub);
    announceOn(allocator, hub.actorId, { name: "ranking", params: { weights: { capabilityMatch: 1 } } as never });

    for (const [actor, match, nonce] of [["https://a.test/a", 90, "n-a"], ["https://a.test/b", 80, "n-b"]] as const) {
      const payload = bidPayload({
        task: "https://hub.test/tasks/t1", bidder: actor, capabilityMatch: match,
        estimatedCost: { unit: "u", value: 10 }, estimatedLatency: "PT1M", nonce,
      });
      allocator.onCommit({ id: `c-${actor}`, type: "afp:bidCommit", actor, object: "https://hub.test/tasks/t1", published: "2026-08-17T09:01:00.000Z", "afp:commitment": commitmentOf(payload) });
      allocator.onReveal({ id: `r-${actor}`, type: "afp:BidReveal", actor, object: payload, published: "2026-08-17T09:10:05.000Z" });
    }
    jumpTo("2026-08-17T09:10:10.000Z");
    const first = allocator.closeAuction("https://hub.test/tasks/t1", "2026-08-17T09:20:00.000Z")!;
    assert.deepEqual((first.activity.object as Record<string, unknown>)["afp:performers"], ["https://a.test/a"]);

    jumpTo("2026-08-17T09:20:01.000Z"); // no Accept arrived — the sweep fires
    // A fresh Allocator over the same SQLite file: the pending accept survives
    // a restart, like every other piece of the P1 deadline-sweep pattern.
    const restarted = new Allocator(hub);
    restarted.sweepAwards();
    const types = emitted.map((e) => e.type);
    assert.ok(types.includes("afp:Reauction"), `expected a Reauction in ${types}`);
    const second = emitted.at(-1)!.activity.object as Record<string, unknown>;
    assert.deepEqual(second["afp:performers"], ["https://a.test/b"]); // next-ranked, same pool
    // The reauction award records the pool exclusion, bound to the prior award.
    assert.equal(second["afp:priorAward"], String((first.activity.object as Record<string, unknown>).id));
    assert.deepEqual(second["afp:excludedBidders"], ["https://a.test/a"]);
    assert.equal(restarted.auction("https://hub.test/tasks/t1")!.status, "awarded");
  });

  it("a selection that misses the announced answer sufficiency is no award at all", () => {
    const { hub } = fakeHub(["https://a.test/a"]);
    const allocator = new Allocator(hub);
    allocator.announce({
      taskId: "https://hub.test/tasks/t1",
      thread: "urn:afp:thread:t1",
      hub: hub.actorId,
      capability: "afp:cap:x",
      content: "do t1",
      correlationId: "t1",
      bidWindow: WINDOW,
      selectionRule: { name: "ranking", params: { weights: { capabilityMatch: 1 } } as never },
      answerSufficiency: { count: 2 } as never, // one bidder can never satisfy this
      estimatorPolicy: "exclude",
      estimators: [],
    });
    const payload = bidPayload({
      task: "https://hub.test/tasks/t1", bidder: "https://a.test/a", capabilityMatch: 80,
      estimatedCost: { unit: "u", value: 10 }, estimatedLatency: "PT1M", nonce: "n",
    });
    allocator.onCommit({ id: "c", type: "afp:bidCommit", actor: "https://a.test/a", object: "https://hub.test/tasks/t1", published: "2026-08-17T09:01:00.000Z", "afp:commitment": commitmentOf(payload) });
    allocator.onReveal({ id: "r", type: "afp:BidReveal", actor: "https://a.test/a", object: payload, published: "2026-08-17T09:10:05.000Z" });

    assert.equal(allocator.closeAuction("https://hub.test/tasks/t1", "2026-08-17T09:20:00.000Z"), null);
    assert.equal(allocator.auction("https://hub.test/tasks/t1")!.status, "failed");
    assert.match(allocator.admissions("https://hub.test/tasks/t1").at(-1)!.reason, /answerSufficiency requires 2/);
  });
});

describe("P3 acceptance gate: the auction replays end to end", () => {
  after(() => cleanupWorkspaces());

  it("the demo export passes the independent verifier, and targeted mutations fail it", async () => {
    const config = workspace();
    const { instance, hub, coverageAward, exported, threads } = await runP3Demo({
      fresh: true,
      config,
      clock: jumpClock(),
    });

    // Writer-side recomputation: the Award's performer set and synthesizer come
    // back out of the pure rule over the stored reveals — no hub state involved.
    const awardObject = coverageAward.activity.object as Record<string, unknown>;
    const auction = hub.allocation.auction(String(awardObject["afp:task"]))!;
    const declines = hub.allocation.declines(auction.taskId);
    assert.equal(declines.length, 1); // declining is a record, not an inference
    assert.equal(auction.status, "awarded");

    const clean = runVerifier(VERIFIER, config.exportDir, threads.estimate, ["--verbose"]);
    assert.equal(clean.code, 0, `verifier failed:\n${clean.output}`);
    assert.match(clean.output, /award/i);

    // Mutation 1: delete the synthesizer's BidReveal — an Award naming a bid
    // whose reveal is absent is "a counted vote you cannot produce."
    const mutate = (name: string, edit: (outbox: { orderedItems: Record<string, unknown>[] }) => void) => {
      const dir = mkdtempSync(join(tmpdir(), "afp-p3-mut-"));
      cpSync(exported.dir, dir, { recursive: true });
      const path = join(dir, "outbox", `${name}.jsonld`);
      const outbox = JSON.parse(readFileSync(path, "utf8"));
      edit(outbox);
      outbox.totalItems = outbox.orderedItems.length;
      writeFileSync(path, JSON.stringify(outbox, null, 2));
      return runVerifier(VERIFIER, dir, threads.estimate, ["--verbose"]);
    };

    const synthesizerName = instance.nameOf(String(awardObject["afp:synthesizer"]))!;
    const withoutReveal = mutate(synthesizerName, (outbox) => {
      outbox.orderedItems = outbox.orderedItems.filter((a) => a.type !== "afp:BidReveal");
    });
    assert.notEqual(withoutReveal.code, 0);
    assert.match(withoutReveal.output, /FAIL.*(winning|unproducible|reveal)/i);

    // Mutation 2: rewrite the Award's performer set — selection recomputation
    // must notice the swap even before the broken signature does.
    const withSwappedWinners = mutate(`hub-${hub.hubId}`, (outbox) => {
      for (const activity of outbox.orderedItems) {
        const object = activity.object as Record<string, unknown> | undefined;
        if (activity.type === "afp:Award" && object?.["afp:task"] === auction.taskId) {
          object["afp:performers"] = [instance.actorId("d-secops")];
        }
      }
    });
    assert.notEqual(withSwappedWinners.code, 0);
    assert.match(withSwappedWinners.output, /FAIL \] award: .*recomputed performers/i);

    // Mutation 3: keep the right performers but cite the wrong evidence —
    // afp:winningBids must be exactly the recomputed winners' bid digests.
    const withForeignEvidence = mutate(`hub-${hub.hubId}`, (outbox) => {
      for (const activity of outbox.orderedItems) {
        const object = activity.object as Record<string, unknown> | undefined;
        if (activity.type === "afp:Award" && object?.["afp:task"] === auction.taskId) {
          object["afp:winningBids"] = [...(object["afp:winningBids"] as string[])].reverse().slice(0, 1);
        }
      }
    });
    assert.notEqual(withForeignEvidence.code, 0);
    assert.match(withForeignEvidence.output, /FAIL \] award: .*winningBids are the recomputed winners/i);

    instance.close();
  });
});
