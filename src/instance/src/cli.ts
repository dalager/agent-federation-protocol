/**
 * `afp <command>` — demo, export, serve.
 *
 * Run with: node --experimental-sqlite src/cli.ts <command>
 */

import { loadConfig } from "./config.ts";
import { endpointOf, runDemo } from "./demo.ts";
import { AfpInstance } from "./instance.ts";
// ADR-0038 Decision 1: `AFP_AGENTS_FILE`'s collection when set, the demo's otherwise.
import { agentCollection } from "./agents.ts";
import { checkEndpoint } from "./brains/openai.ts";
import { createHttpServer } from "./ap/server.ts";
import { exportBundle } from "./export.ts";
import { keyCompromiseClaim } from "./ap/activities.ts";
import { logger } from "./runtime/log.ts";
import type { Scheduler } from "./runtime/scheduler.ts";
import { metrics } from "./runtime/metrics.ts";

const command = process.argv[2] ?? "demo";

// ADR-0025 Decision 1: every demo (and `export`, which touches no network)
// runs over plain `http://127.0.0.1` origins by construction — that is the
// point of a demo. `serve` is the one command that runs a real deployment,
// so it is the one command left to the operator's own `AFP_DEV`.
if (!["serve", "config", "backup", "restore"].includes(command) && process.env.AFP_DEV === undefined) {
  process.env.AFP_DEV = "1";
}

/** Last path segment — enough of a name for console narration. */
const short = (url: unknown): string | undefined => String(url).split("/").pop();

/** `Offer{afp:Task}`-style label for an activity. */
function activityLabel(activity: { type?: unknown; object?: unknown }): string {
  const object = activity.object;
  const objectType =
    object && typeof object === "object" && !Array.isArray(object)
      ? String((object as Record<string, unknown>).type ?? "")
      : "";
  return objectType ? `${activity.type}{${objectType}}` : String(activity.type);
}

async function main(): Promise<void> {
  switch (command) {
    case "demo": {
      const config = loadConfig();
      if (config.brain === "llm") {
        // Fail early with something actionable rather than after two dead tasks.
        const problem = await checkEndpoint(endpointOf(config));
        if (problem) {
          console.error(`\nbrain endpoint unavailable: ${problem}`);
          console.error("start the server, pick another with AFP_LLM_BASE_URL / AFP_LLM_MODEL,");
          console.error("or run offline with AFP_BRAIN=stub\n");
          process.exit(1);
        }
        console.log(`brains: ${config.llmModel} @ ${config.llmBaseUrl}`);
      } else {
        console.log("brains: deterministic stubs (offline)");
      }

      const { instance, thread, exported } = await runDemo({ fresh: true });
      const entries = instance.outbox.byThread(thread);

      console.log(`\nthread ${thread} — ${entries.length} activities\n`);
      for (const entry of entries) {
        console.log(
          `  ${String(entry.seq).padStart(2)}  ${short(entry.actor)?.padEnd(9)} ${activityLabel(entry.activity).padEnd(20)} ${entry.visibility}`,
        );
      }

      const queue = instance.queue.stats();
      console.log(
        `\ndelivery: ${queue.delivered} delivered, ${queue.pending} pending, ${queue.dead} dead-lettered`,
      );
      console.log(
        `export:   ${exported.activities} activities, ${exported.artifacts} artifacts -> ${exported.dir}`,
      );
      console.log(`\nverify it:  python3 ../verifier/afp_verify.py ${exported.dir} --thread ${thread}\n`);
      instance.close();
      break;
    }

    case "p2": {
      const { runP2Demo } = await import("./demoP2.ts");
      // Own export dir: ./export is the checked-in P1 reference bundle.
      const { instance, hub, decision, exported, thread } = await runP2Demo({
        fresh: true,
        config: { exportDir: "./export-p2" },
      });

      const object = decision.activity.object as Record<string, unknown>;
      const tally = object["afp:weightTally"] as Record<string, number>;
      const counted = (object["afp:countedVotes"] as string[]).length;

      console.log(`\nhub ${hub.actorId}`);
      console.log(`round ${object["afp:round"]} — ${hub.members().length} enrolled, ${counted} votes counted\n`);
      for (const [option, weight] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${option.padEnd(16)} ${"█".repeat(Math.round(weight))} ${weight}`);
      }
      console.log(`\noutcome:  ${object["afp:outcome"]}  (afp:DecisionRecord ${decision.activity.id})`);
      console.log(`export:   ${exported.activities} activities -> ${exported.dir}`);
      console.log(`\nverify it:  python3 ../verifier/afp_verify.py ${exported.dir} --thread ${thread} --verbose\n`);
      instance.close();
      break;
    }

    case "p3": {
      const { runP3Demo } = await import("./demoP3.ts");
      const { instance, hub, rankingAward, coverageAward, synthesis, ratification, exported, threads } =
        await runP3Demo({ fresh: true, config: { exportDir: "./export-p3" } });

      const short = (url: unknown) => String(url).split("/").pop();
      const rank = rankingAward.activity.object as Record<string, unknown>;
      const cov = coverageAward.activity.object as Record<string, unknown>;
      const decision = ratification.activity.object as Record<string, unknown>;

      console.log(`\nhub ${hub.actorId} — ${hub.members().length} enrolled\n`);
      console.log(`ranking  auction load-42: winner ${short((rank["afp:performers"] as string[])[0])}`);
      console.log(
        `coverage auction q-88:    coalition [${(cov["afp:performers"] as string[]).map(short).join(", ")}], synthesizer ${short(cov["afp:synthesizer"])}`,
      );
      for (const decline of hub.allocation.declines(String(cov["afp:task"]))) {
        console.log(`  declined: ${short(decline.actor)} — ${decline.reason}`);
      }
      for (const entry of hub.allocation.admissions(String(cov["afp:task"]))) {
        console.log(`  admission ${entry.outcome}: ${short(entry.actor)} — ${entry.reason}`);
      }
      console.log(`\nsynthesis ${String((synthesis.activity.object as Record<string, unknown>).id)}`);
      console.log(`ratified: ${decision["afp:outcome"]} (round ${decision["afp:round"]})`);
      console.log(`export:   ${exported.activities} activities -> ${exported.dir}`);
      console.log(`\nverify it:  python3 ../verifier/afp_verify.py ${exported.dir} --thread ${threads.estimate} --verbose\n`);
      instance.close();
      break;
    }

    case "p3:llm": {
      const config = loadConfig();
      const { runP3Experiment } = await import("./experimentP3.ts");
      const short = (url: unknown) => String(url).split("/").pop();

      console.log(`brains: ${config.llmModel} @ ${config.llmBaseUrl}\n`);
      const { instance, hub, coverageAward, synthesis, ratification, settlement, exported, threads, partials } =
        await runP3Experiment({ endpoint: endpointOf(config), config: { exportDir: "./export-p3-llm" } });

      const cov = coverageAward.activity.object as Record<string, unknown>;
      const syn = synthesis.activity.object as Record<string, unknown>;
      const decision = ratification.activity.object as Record<string, unknown>;
      const dissent = syn["afp:dissent"] as { actor: string; summary: string }[];

      console.log(`hub ${hub.actorId} — ${hub.members().length} agents enrolled`);
      console.log(`coalition [${(cov["afp:performers"] as string[]).map(short).join(", ")}], synthesizer ${short(cov["afp:synthesizer"])}\n`);
      for (const partial of partials) {
        console.log(`--- ${partial.name} ---`);
        console.log(partial.content.trim().split("\n").slice(0, 6).join("\n"), "\n");
      }
      console.log(`synthesis: ${JSON.stringify(syn["afp:answer"])} confidence ${syn["afp:confidence"]}%`);
      console.log(`method:    ${syn["afp:method"]}`);
      for (const entry of dissent) console.log(`dissent:   ${short(entry.actor)} — ${entry.summary}`);
      if (!dissent.length) console.log("dissent:   none recorded");
      console.log(`ratified:  ${decision["afp:outcome"] === syn.id ? "yes" : `no (${decision["afp:outcome"]})`}`);
      console.log(`settled:   ${(settlement.activity.object as Record<string, unknown>)["afp:synthesis"] ? "bound to synthesis" : "recorded"}`);
      console.log(`export:    ${exported.activities} activities -> ${exported.dir}`);
      console.log(`\nverify it:  python3 ../verifier/afp_verify.py ${exported.dir} --thread ${threads.estimate} --verbose\n`);
      instance.close();
      break;
    }

    case "p4": {
      const { runP4Demo } = await import("./demoP4.ts");
      const demo = await runP4Demo();

      console.log(`\nalpha   ${demo.alpha.origin}  (a-lead)`);
      console.log(`beta    ${demo.beta.origin}  (b-assessor, b-private)`);
      console.log(`mallory ${demo.mallory.origin}  (m-probe)\n`);

      console.log(`agreement: alpha <-> beta, direct-delegation grant for afp:cap:assess`);
      console.log(`           dual-Create, expires ${demo.agreementExpires}`);
      console.log(`           active on alpha: ${demo.alpha.federation.activeAgreementsWith(demo.beta.actorId).length}, on beta: ${demo.beta.federation.activeAgreementsWith(demo.alpha.actorId).length}\n`);

      console.log(`mallory's signed probe:   ${demo.probeRefusal}`);
      console.log(`mallory's unsigned POST:  ${demo.unsignedStatus} before the gate ever runs\n`);

      // ADR-0013 — the read half, same gate, same port.
      console.log("signed GET of b-assessor's outbox (same URL, three callers):");
      console.log(`   alpha (agreed, named)   ${demo.reads.alpha} activities`);
      console.log(`   mallory (signed only)   ${demo.reads.mallory}`);
      console.log(`   anonymous (unsigned)    ${demo.reads.anonymous}`);
      console.log("   a valid signature with no agreement behind it reads exactly what a stranger reads\n");

      console.log(`delegation ${demo.delegationThread} — alpha's record:`);
      for (const entry of demo.alpha.instance.outbox.byThread(demo.delegationThread)) {
        console.log(
          `  ${String(entry.seq).padStart(2)}  ${short(entry.actor)?.padEnd(10)} ${activityLabel(entry.activity)}  (own outbox)`,
        );
      }
      // What crossed the boundary inbound sits in the received store, verified
      // and gate-admitted — never in alpha's own chain.
      for (const received of demo.alpha.federation.receivedActivities()) {
        if (received.activity.context !== demo.delegationThread) continue;
        console.log(
          `   -  ${short(received.activity.actor)?.padEnd(10)} ${activityLabel(received.activity)}  (received across the boundary)`,
        );
      }

      console.log(`\nbeta's boundary log (${demo.boundaryLog.length} entries, hash-chained):`);
      for (const entry of demo.boundaryLog) {
        console.log(`  ${entry.step.padEnd(10)} ${entry.reason} — ${short(entry.actor)}`);
      }
      console.log(`boundary digest: ${demo.boundaryDigest["afp:entryCount"]} entries, root ${String(demo.boundaryDigest["afp:logRoot"]).slice(0, 26)}…\n`);

      console.log(`export:   alpha full     — ${demo.exports.alpha.activities} activities -> ${demo.exports.alpha.dir}`);
      console.log(`          beta  scoped   — ${demo.exports.beta.activities} activities -> ${demo.exports.beta.dir}`);
      console.log(`          (beta's other-client thread is redaction stubs; b-private a declared omission)`);
      console.log(`\nverify it:  python3 ../verifier/afp_verify.py export-p4/alpha export-p4/beta --verbose\n`);
      await demo.close();
      break;
    }

    case "p5": {
      const { runP5Demo } = await import("./demoP5.ts");
      const demo = await runP5Demo();
      const shortAgent = (url: string): string => url.split("/").pop() ?? url;

      console.log(`\nalpha  ${demo.alpha.origin}  (n-noc, n-telemetry) — hosts the bridge at /hubs/bridge/inbox`);
      console.log(`bravo  ${demo.bravo.origin}  (s-noc)`);
      console.log(`gamma  ${demo.gamma.origin}  (e-noc, e-watcher, e-notify)\n`);

      console.log(`the bridge seats ${demo.members.length}, foreign seats enrolled through the real inbox`);
      console.log(`  observer: ${shortAgent(demo.observer)} — reads at hub visibility, never decides`);
      console.log(`  actuator: ${shortAgent(demo.actuation.actor)} — reads everything, decides nothing, carries the outcome out\n`);

      console.log("the round declares its own terms before a vote exists (ADR-0018, ADR-0019):");
      console.log(`  bar       ${demo.quorumBar.rule} over a pinned total of ${demo.quorumBar.total}`);
      console.log(`  deadline  ${demo.deadline}`);
      console.log(`  binding   joint — an outvoted member departs on the record or the record shows nothing`);
      console.log(`  policy    one admissible action per outcome, afp:no-decision included\n`);

      console.log("the write door (ADR-0016 Decision 2):");
      console.log(`  unenrolled agent, valid operator      ${demo.rogueStatus} {"error":"refused"}`);
      console.log(`  same write, valid membership proof    ${demo.provenRogueStatus} — identical: the proof is a read credential`);
      console.log(`  enrolled observer's vote              ${demo.observerVoteStatus} at the door, dead in the handler`);
      console.log(`  member votes tallied                  ${demo.talliedVotes} (the observer's not among them)\n`);

      console.log(`outcome:  ${demo.outcome}${demo.noDecisionReason ? ` (${demo.noDecisionReason})` : ""}`);
      for (const [option, weight] of Object.entries(demo.weightTally).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${option.padEnd(16)} ${"█".repeat(Math.round(weight))} ${weight}`);
      }

      console.log("\nafp:uncounted on the closing DecisionRecord:");
      for (const [agent, status] of Object.entries(demo.uncounted)) {
        console.log(`  ${shortAgent(agent).padEnd(12)} ${status}`);
      }

      console.log(`\nthe consequence (ADR-0019) — bound to the decision, not improvised:`);
      console.log(`  ${shortAgent(demo.actuation.actor)} published afp:action ${demo.actuation.action}`);
      console.log(`  the round itself declared that action admissible for outcome "${demo.outcome}"`);
      if (demo.departed.length) {
        console.log(`  departure recorded: ${demo.departed.map(shortAgent).join(", ")} — bound, and saying otherwise`);
      } else {
        console.log("  no departures: nobody was outvoted on a binding outcome");
      }

      console.log(`\nreplica convergence (Offer{afp:Digest} / Accept{afp:StateDeltas}, over sockets):`);
      console.log(`  seats: ${demo.replicaSeats.before} bare -> ${demo.replicaSeats.afterPull} after one pull -> ${demo.replicaSeats.afterSecondPull} after a second (idempotent)`);
      console.log(`  synced stores: ${demo.syncStores.join(", ")}`);
      console.log(`  (liveness is absent by design — hub-generated, re-observed per replica)\n`);

      console.log("the kill criterion — the hub's host dies mid-task:");
      console.log(`  in-flight mesh delegation completed:  ${demo.meshCompleted} (the hub never sat on the payload path)`);
      console.log(`  new write toward the dead hub:        fails to its caller (${demo.deadHubWriteError || "connection refused"})\n`);

      console.log(`export:  alpha (with the bridge) — ${demo.exports.alpha.activities} activities -> ${demo.exports.alpha.dir}`);
      console.log(`         bravo                   — ${demo.exports.bravo.activities} activities -> ${demo.exports.bravo.dir}`);
      console.log(`         gamma                   — ${demo.exports.gamma.activities} activities -> ${demo.exports.gamma.dir}`);
      console.log(`\nverify it:  python3 ../verifier/afp_verify.py export-p5/alpha export-p5/bravo export-p5/gamma --thread ${demo.incidentThread} --verbose\n`);
      await demo.close();
      break;
    }

    case "p5:llm": {
      const config = loadConfig();
      const { runP5Experiment } = await import("./experimentP5.ts");
      const shortAgent = (url: string): string => url.split("/").pop() ?? url;
      const wrap = (text: string, indent: string): string =>
        text
          .split(/\s+/)
          .reduce<string[]>((lines, word) => {
            const last = lines[lines.length - 1];
            if (last !== undefined && `${last} ${word}`.length <= 76) lines[lines.length - 1] = `${last} ${word}`;
            else lines.push(word);
            return lines;
          }, [])
          .join(`\n${indent}`);

      console.log(`brains: ${config.llmModel} @ ${config.llmBaseUrl}\n`);
      console.log("It snowed overnight. Three schools share one bus company, so the buses can only");
      console.log("run one timetable: the three of them close together, or none of them does.");
      console.log("It is 05:30. The message to parents has to go out at 06:00.\n");
      console.log("Each head teacher can see their own car park, their own roads, their own staff —");
      console.log("and nobody else's. That is why they need somewhere shared to decide.\n");

      const demo = await runP5Experiment({ endpoint: endpointOf(config) });
      const who = (agent: string): string => demo.labels[agent] ?? agent;

      console.log(`  Hilltop   ${demo.alpha.origin}  in town — also hosts the shared noticeboard`);
      console.log(`  Riverside ${demo.bravo.origin}  out in the valley`);
      console.log(`  Central   ${demo.gamma.origin}  middle of town\n`);
      console.log(`the question:  ${demo.question}\n`);

      console.log("each head teacher read what was in front of them, and answered:\n");
      for (const [agent, assessment] of Object.entries(demo.assessments)) {
        console.log(`  ${who(agent)} — ${assessment.verdict.toUpperCase()}`);
        console.log(`    "${wrap(assessment.rationale, "     ")}"`);
        console.log(`    (written by ${wroteIt(assessment.producedBy)})\n`);
      }

      console.log("what the noticeboard did with those answers:");
      console.log(`  votes counted     ${demo.talliedVotes} of ${demo.members.length} seats`);
      for (const [option, weight] of Object.entries(demo.weightTally).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${option.padEnd(10)} ${"█".repeat(Math.round(weight))} ${weight}`);
      }
      console.log(`  the decision      ${demo.outcome}`);
      console.log("    it was told each answer and none of the reasons, so anyone can recount");
      console.log("    the vote later without being able to see a single school's car park.\n");
      for (const [agent, status] of Object.entries(demo.uncounted)) {
        console.log(`  ${status}: ${who(shortAgent(agent))}`);
        console.log(`    recorded as "${status}", not as an abstention — the record does not`);
        console.log("    pretend to know what someone who never answered would have said.\n");
      }
      console.log(`  ${who("e-watcher")} was let in the door (${demo.observerVoteStatus}) and its vote thrown away.`);
      console.log("    It reads every school's traffic and formed the strongest opinion in the");
      console.log("    room. Reading and deciding are separate permissions, and the count above");
      console.log("    is where you can see which one it actually holds.\n");
      console.log(`  someone with no seat at all was refused (${demo.rogueStatus}) — and refused again (${demo.provenRogueStatus})`);
      console.log("    while holding up a genuine pass, because a pass proves you may read.\n");

      console.log("the bar, and the message that had to go out either way:");
      console.log(`  the round pinned ${demo.quorumBar.rule} over a total of ${demo.quorumBar.total}, before anyone voted`);
      console.log(`  and a deadline of ${demo.deadline} — the world's clock, not the noticeboard's`);
      if (demo.noDecisionReason) {
        console.log(`  the schools did not clear it (${demo.noDecisionReason}), so nothing was decided —`);
        console.log("  which is a recorded fact, not a silence, and it still releases the desk:");
      } else {
        console.log(`  the outcome cleared it, so "${demo.outcome}" is the decision:`);
      }
      console.log(`\n    "${wrap(demo.actuation.notice, "     ")}"`);
      console.log(`\n  sent by ${who("e-notify")}, under the action the round itself declared`);
      console.log(`  admissible for this outcome (${demo.actuation.action}). It votes on nothing,`);
      console.log("  and this is the only kind of thing it is allowed to publish.");
      if (demo.departed.length) {
        console.log(`\n  ${demo.departed.map((a) => who(shortAgent(a))).join(", ")} recorded a departure: bound by a`);
        console.log("  joint decision it voted against, and saying so on its own chain rather");
        console.log("  than quietly doing otherwise.\n");
      } else {
        console.log("");
      }

      console.log("then the school hosting the noticeboard loses power:");
      console.log(`  a new vote sent to it     bounces back to the sender (${demo.deadHubWriteError || "connection refused"})`);
      console.log("    it fails loudly at whoever sent it, instead of disappearing quietly.");
      console.log(`  a question already in the air  still gets answered: ${demo.meshCompleted}`);
      if (demo.meshResult) {
        console.log("\n  Riverside had already asked Central why the three of them disagreed. That");
        console.log("  question went school to school and never through the noticeboard, so the");
        console.log("  answer arrived anyway — and it is on the record:\n");
        console.log(`    ${wrap(demo.meshResult.content.trim(), "    ")}`);
        console.log(`\n    the record also says what wrote it: ${demo.meshResult.producedBy}`);
      }

      console.log(`\nexport:  alpha (with the bridge) — ${demo.exports.alpha.activities} activities -> ${demo.exports.alpha.dir}`);
      console.log(`         bravo                   — ${demo.exports.bravo.activities} activities -> ${demo.exports.bravo.dir}`);
      console.log(`         gamma                   — ${demo.exports.gamma.activities} activities -> ${demo.exports.gamma.dir}`);
      console.log(`\nverify it:  python3 ../verifier/afp_verify.py export-p5-llm/alpha export-p5-llm/bravo export-p5-llm/gamma --thread ${demo.incidentThread} --verbose\n`);
      await demo.close();
      break;
    }

    case "p6": {
      const { runP6Demo } = await import("./demoP6.ts");
      const demo = await runP6Demo();
      const who = (url: string | null): string => (url ? (url.split("/").pop() ?? url) : "nobody");

      console.log(`\natlas    ${demo.atlas.origin}  (atl-uw, atl-pay) — hosts windward`);
      console.log(`meridian ${demo.meridian.origin}  (mer-uw) — profits if the round fails to close`);
      console.log(`pelican  ${demo.pelican.origin}  (pel-uw)`);
      console.log(`anchor   ${demo.anchor.origin}  (anc-uw)`);
      console.log(`harbor   ${demo.harbor.origin}  (har-uw)\n`);
      console.log("five reinsurers, one parametric contract: if Storm Dagmar crossed two pinned");
      console.log("thresholds, 4,000 policyholders are paid automatically. One determination,");
      console.log("jointly binding, with money on the answer — and on the failure to answer.\n");

      console.log("the round declares its terms before a vote exists (ADR-0018/0019/0020):");
      console.log(`  level     1 — five operators live in this hub, so every ballot is a chained tuple`);
      console.log(`  bar       ${demo.quorumBar.rule} ${demo.quorumBar.threshold} of a pinned total of ${demo.quorumBar.total}`);
      console.log(`  deadline  ${demo.deadline}  (the contract's 72-hour determination window)`);
      console.log(`  binding   joint — one determination, no per-member payout`);
      console.log(`  policy    one admissible action per outcome, afp:no-decision included`);
      console.log(`  succession ${demo.succession.rule} — who may inherit this round if it stalls\n`);

      console.log("the prepare phase:");
      for (const voter of demo.voters) {
        const agent = who(voter);
        const assessment = demo.assessments[agent];
        console.log(`  ${agent.padEnd(8)} ${assessment ? assessment.verdict.padEnd(4) : "—   "} ${assessment?.rationale ?? ""}`);
      }

      console.log(`\none signature, two votes (ADR-0020 Decision 2):`);
      console.log(`  ${who(demo.conviction.actor)} signed the same (round, phase, seqNo) twice — the first`);
      console.log("  carrying its own assessment above, the second contradicting it:");
      for (const half of demo.conviction.halves) {
        console.log(`    ${half.value.padEnd(4)} ${half.digest.slice(0, 22)}…  observedVotes: ${half.observed}`);
      }
      console.log("  the hub recomputed convicts() over the two signed objects, published an");
      console.log("  Announce{afp:EquivocationProof} carrying both of them verbatim, and zeroed the seat");
      console.log(`  the proof re-verified from its own two embedded votes: ${demo.conviction.verifiesStandalone}`);
      console.log("    — which is what makes it usable by someone holding nothing else\n");

      console.log("the same shape on the wire, and not a sanction:");
      console.log(`  ${who(demo.restore.actor)} restored from backup and re-signed its vote`);
      console.log(`    same tuple: ${demo.restore.sameTupleAsFirst}   same value: ${demo.restore.value}   different bytes: ${demo.restore.duplicateDigest.slice(0, 22)}…`);
      console.log(`    convicted: ${demo.restore.convicted}  — values convict, hashes do not`);
      console.log(`  its lawful move was to re-vote at seqNo ${demo.restore.revoteSeqNo}, which superseded in place:`);
      console.log(`    receipts for that seat: ${demo.restore.receiptsForActor} (counted once, not zero, not twice)\n`);

      console.log("the arithmetic after the proof (ADR-0020 Decision 4):");
      for (const [option, weight] of Object.entries(demo.doom.attainable)) {
        console.log(`  attainable(${option.padEnd(3)}) = ${weight}  ${weight < demo.doom.bar ? "<" : ">="} bar ${demo.doom.bar}`);
      }
      console.log("    (every seat that can still cast has cast — nothing further is coming)");
      console.log(`  doomed: ${demo.doom.doomed} — the zeroed seat stays in the denominator, it just cannot cast`);
      if (demo.noDecisionReason === "quorum-impossible") {
        console.log(`  ${who(demo.doom.demandedBy)} demanded the close: 71 hours of theatre became one activity\n`);
      } else {
        console.log("  not provably doomed on these votes — the round closed on its own terms\n");
      }

      console.log(`outcome:  ${demo.outcome}${demo.noDecisionReason ? ` (${demo.noDecisionReason})` : ""}`);
      console.log(`counted:  ${demo.countedVotes} of ${demo.voters.length} pinned seats — the convicted seat's ballots are not among them`);
      for (const [option, weight] of Object.entries(demo.weightTally).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${option.padEnd(10)} ${"█".repeat(Math.round(weight))} ${weight}`);
      }
      for (const [agent, status] of Object.entries(demo.uncounted)) {
        const gloss =
          agent === demo.conviction.actor && status === "silent"
            ? "  — no ballot of its was counted; the two it signed were dropped by the proof."
            : "";
        console.log(`  ${who(agent).padEnd(10)} ${status}${gloss}`);
      }
      if (demo.uncounted[demo.conviction.actor] === "silent") {
        console.log("    (ADR-0014's registry has 'silent' and 'declined' and no third status for");
        console.log("     'answered, and convicted for how' — the record cannot tell those apart yet)");
      }
      console.log("  the convicted seat's weight is the abstain row: it still counts toward the");
      console.log("  total the bar was computed over (Decision 4 — zeroing removes the ability to");
      console.log("  cast, never the electorate the rule was pinned against)");

      console.log(`\nthe stall recovery (ADR-0020 Decision 3):`);
      console.log(`  entitled successor: ${who(demo.succession.entitled)}`);
      if (demo.succession.skipped.length) {
        console.log(`  skipped:            ${demo.succession.skipped.map(who).join(", ")} — convicted in this round`);
      }
      console.log(`  it opened ${who(demo.succession.freshRound)}, naming the stalled round by digest — and that round`);
      console.log("  still carries the stalled round's five-seat snapshot, because it was pinned");
      console.log("  before the pool had decided anything about the equivocator's seat");
      console.log("    reputation would have handed this to the equivocator: it has the pool's best");
      console.log("    settlement record. Snapshot order is dumb on purpose.\n");

      console.log(`the consequence (ADR-0019):`);
      console.log(`  ${who(demo.actuation.actor)} published afp:action ${demo.actuation.action}`);
      console.log(`  "${demo.actuation.notice}"\n`);

      console.log("the accused answers (ADR-0021 Decision 4a):");
      console.log(`  ${demo.claim.byOperator}'s instance published a key-compromise claim, on its own chain:`);
      console.log(`    the key it says was captured:  #${demo.claim.verificationMethod.split("#")[1] ?? "?"} (the one that signed both ballots)`);
      console.log(`    captured since:               ${demo.claim.since}  — before the round opened`);
      console.log(`  the seat's weight afterwards:   still zero (${demo.claim.weightStillZero})`);
      console.log("    a claim is not evidence: it gates nothing, delays nothing, reverses nothing.");
      console.log("    What it buys is that zeroed and zeroed-contested are now different states,");
      console.log("    which is the difference between a sanction and an incident");
      console.log(`  held by the other four operators: ${demo.claim.heldByPeers}`);
      console.log("    no grant in the pool's agreements admits a claim across the boundary, so they");
      console.log("    read it in the joint case file — a gap, stated rather than hidden\n");

      console.log("what the pool did about it (ADR-0021 Decisions 2-4):");
      console.log(`  subject:    ${who(demo.governance.subject)} — pinned in the proposal, so the act is checkable`);
      console.log(`  recused:    ${demo.governance.recusal.status} by cause ${demo.governance.recusal.form}`);
      console.log(`              ${demo.governance.recusal.proof.slice(0, 30)}…`);
      console.log("              the accused is out of its own sanction round by a rule anyone recomputes —");
      console.log("              and the proposer could not have recused anybody else");
      console.log(`  electorate: ${demo.governance.electorate.length} seats, bar ${demo.governance.bar} of a pinned total of ${demo.governance.total}`);
      console.log("              smaller because the SNAPSHOT moved, never because a proof lowered it\n");
      for (const [agent, judgment] of Object.entries(demo.governance.judgments)) {
        console.log(`    ${agent.padEnd(8)} ${judgment.verdict.padEnd(4)} ${judgment.rationale}`);
      }
      console.log(`\n  outcome:  ${demo.governance.outcome} -> afp:action ${demo.governance.action}`);
      for (const [option, weight] of Object.entries(demo.governance.weightTally).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${option.padEnd(10)} ${"█".repeat(Math.round(weight))} ${weight}`);
      }
      if (demo.governance.expelledBy) {
        console.log(`  carried out by ${who(demo.governance.expelledBy)}, binding to the DecisionRecord by afp:actsOn`);
        console.log("    — a member, never the hub's own key, whatever the hub's role as sequencer (02)");
      }
      console.log(`  member-role seats: ${demo.governance.membersBefore} -> ${demo.governance.membersAfter}\n`);

      console.log(`the next determination — ${who(demo.nextRound.round)}, pinned after the expulsion:`);
      console.log(`  ${demo.nextRound.voters} seats, ${demo.nextRound.excluded} declared exclusions — nothing to declare, because the membership`);
      console.log("  itself is smaller. Conviction zeroes a seat; only governance removes one.");
      console.log(`  ${who(demo.succession.freshRound)}'s own snapshot is untouched by any of this: it was pinned before`);
      console.log("  the expulsion and a closed or open round's electorate never moves backwards\n");

      for (const [name, summary] of Object.entries(demo.exports)) {
        console.log(`export:  ${name.padEnd(9)} ${String(summary.activities).padStart(3)} activities -> ${summary.dir}`);
      }
      console.log(
        `\nverify it:  python3 ../verifier/afp_verify.py ${Object.keys(demo.exports).map((n) => `${demo.exportRoot}/${n}`).join(" ")} --verbose\n`,
      );
      await demo.close();
      break;
    }

    case "p6:llm": {
      const config = loadConfig();
      const { runP6Experiment } = await import("./experimentP6.ts");
      const shortId = (url: string | null): string => (url ? (url.split("/").pop() ?? url) : "nobody");
      const wrap = (text: string, indent: string): string =>
        text
          .split(/\s+/)
          .reduce<string[]>((lines, word) => {
            const last = lines[lines.length - 1];
            if (last !== undefined && `${last} ${word}`.length <= 76) lines[lines.length - 1] = `${last} ${word}`;
            else lines.push(word);
            return lines;
          }, [])
          .join(`\n${indent}`);

      console.log(`brains: ${config.llmModel} @ ${config.llmBaseUrl}\n`);
      console.log("Storm Dagmar has been and gone. Five reinsurers share one contract, and it is");
      console.log("the kind that pays out on measurements rather than on loss adjusters: if the");
      console.log("storm crossed two pinned thresholds, four thousand policyholders are paid");
      console.log("today, automatically. The five of them have to agree that it did.\n");
      console.log("They are not neutral, and everybody knows it — each member's exposure is");
      console.log("written into the contract the round references. One of them does best of all");
      console.log("if the pool simply fails to answer.\n");

      const demo = await runP6Experiment({ endpoint: endpointOf(config) });
      const who = (url: string | null): string => demo.labels[shortId(url)] ?? shortId(url);
      // The labels are written for a list ("Meridian Re — underwriter"); mid-sentence
      // that dash reads as an interruption, so prose gets the name alone.
      const name = (url: string | null): string => who(url).split(" — ")[0];
      // The endpoint is named once, in the header. Repeating it under every verdict
      // is nine copies of a fact the reader already has.
      const wroteIt = (producedBy: string): string => producedBy.split(" @ ")[0];

      console.log(demo.bulletin.split("\n").map((line) => `  ${line}`).join("\n"));
      console.log(`\nthe question:  ${demo.question}\n`);

      console.log("each underwriter read the same bulletin next to its own book, and answered:\n");
      for (const voter of demo.voters) {
        const agent = shortId(voter);
        const assessment = demo.assessments[agent];
        if (!assessment) continue;
        console.log(`  ${who(voter)} — ${assessment.verdict.toUpperCase()}`);
        console.log(`    "${wrap(assessment.rationale, "     ")}"`);
        console.log(`    (written by ${wroteIt(assessment.producedBy)})\n`);
      }

      console.log("then one of them signed its answer twice.\n");
      console.log(`  ${name(demo.conviction.actor)} put its name to two ballots at the same round, the same phase`);
      console.log("  and the same sequence number — the first carrying the answer it gave above, the");
      console.log("  second contradicting it, each with the set of votes it claimed to have seen:\n");
      for (const half of demo.conviction.halves) {
        console.log(`    ${half.value.padEnd(4)} ${half.digest.slice(0, 30)}…   (claimed to have seen ${half.observed} votes)`);
      }
      console.log("\n  If two camps each believe a different count is forming, neither of them ever");
      console.log("  assembles a majority, the determination dies of old age at the deadline, and");
      console.log("  the dispute goes to an arbitration panel on terms this member's own lawyers");
      console.log("  wrote. Failing to decide is not a neutral outcome; here it is worth money.\n");
      console.log(`  It did not survive the two copies meeting. The hub recomputed the test itself`);
      console.log(`  and published a proof carrying both signed ballots inside it. Anyone can check`);
      console.log(`  that proof holding nothing else — including this program, which just did: ${demo.conviction.verifiesStandalone}.`);
      console.log("  The seat's weight went to zero for this round and every later one. Nobody");
      console.log("  voted on that, and nobody had to: it is arithmetic over two signatures.\n");

      console.log("and then a disk failed, which looks exactly the same.\n");
      console.log(`  ${name(demo.restore.actor)} came back from a backup taken before it voted. It had`);
      console.log("  no memory of voting, so it honestly signed the same answer again — same round,");
      console.log("  same sequence number, same value, but a later timestamp and a longer list of");
      console.log("  votes it had seen by then. Different bytes. The same shape as the equivocator.\n");
      console.log(`    convicted: ${demo.restore.convicted}`);
      console.log("  What convicts is contradicting yourself, not being byte-different. So the");
      console.log("  duplicate was dropped, and the lawful way back — re-vote at a higher sequence");
      console.log(`  number — replaced the old ballot in place: ${demo.restore.receiptsForActor} ballot for that seat, counted once.`);
      console.log("  If the record could not tell these two apart, every node that ever restores");
      console.log("  from backup would be a cheat, which over five years is all of them.\n");

      console.log(
        demo.doom.doomed
          ? "what was left could not reach the bar:\n"
          : "and then the count, with one seat unable to cast:\n",
      );
      for (const [option, weight] of Object.entries(demo.doom.attainable)) {
        console.log(`    even if every remaining seat voted ${option.padEnd(3)}: ${weight}  (the bar is ${demo.doom.bar})`);
      }
      if (demo.noDecisionReason === "quorum-impossible") {
        console.log("\n  With one seat unable to cast and the rest split, no answer could get there —");
        console.log("  and that was provable from the record the moment the proof landed, with the");
        console.log(`  deadline (${demo.deadline}) still days away.`);
        console.log(`  ${name(demo.doom.demandedBy)} asked for the round to be closed on the arithmetic,`);
        console.log("  and it was: seventy-one hours of waiting for a foregone conclusion became one");
        console.log("  activity. The reason is on the record and anyone can recompute it.\n");
      } else {
        console.log("\n  A bar was still reachable on these votes, so the round closed on its own");
        console.log("  terms rather than early.\n");
      }

      console.log(`  outcome:  ${demo.outcome}${demo.noDecisionReason ? ` (${demo.noDecisionReason})` : ""}`);
      for (const [option, weight] of Object.entries(demo.weightTally).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${option.padEnd(10)} ${"█".repeat(Math.round(weight))} ${weight}`);
      }
      console.log("    the convicted seat still counts toward the total the bar was computed over —");
      console.log("    it lost the ability to vote, not its place in the electorate. A proof that");
      console.log("    could shrink the denominator would be a way to make a contested round");
      console.log("    easier to win with one stolen key.\n");

      console.log("who gets to ask the question again:\n");
      console.log(`  ${who(demo.succession.entitled)}`);
      if (demo.succession.skipped.length) {
        console.log(`  and not ${demo.succession.skipped.map(name).join(", ")}, which the rule skipped for being convicted.`);
      }
      console.log("  The old rule was 'whoever has the best reputation' — and in this pool that is");
      console.log("  the member that just equivocated: a diligent underwriter for years, right up");
      console.log("  until this morning. The round now pins the order before anyone votes, and the");
      console.log("  order is dumb on purpose. Whoever opens the next round writes its deadline,");
      console.log("  its bar, its electorate and what may be done about the answer, so it is not a");
      console.log("  chore to hand out on popularity.\n");
      console.log(`  It opened ${shortId(demo.succession.freshRound)} straight away, naming the stalled round by digest. That`);
      console.log("  round still pins all five seats, including the convicted one — it was written");
      console.log("  before the pool had decided anything about that seat, and a round's electorate");
      console.log("  is fixed the moment it is signed.\n");

      console.log("what actually happened to the money:\n");
      console.log(`  ${who(demo.actuation.actor)} carried it out, under the one action this round had`);
      console.log(`  already declared admissible for this outcome (${demo.actuation.action}):\n`);
      console.log(`    "${wrap(demo.actuation.notice, "     ")}"\n`);
      console.log("  That desk has no vote and never had one. It could not have chosen a different");
      console.log("  instruction: the round fixed the menu before the first ballot existed.\n");

      console.log("the accused answered.\n");
      console.log(`  ${demo.claim.byOperator}'s operator published a signed statement on its own chain: the key`);
      console.log(`  that put its name to those two ballots (${demo.claim.verificationMethod.split("/").pop()})`);
      console.log(`  had been in somebody else's hands since ${demo.claim.since.slice(0, 10)} — before the round opened.\n`);
      console.log(`    the seat's weight after it: still zero (${demo.claim.weightStillZero})`);
      console.log("  A claim is not evidence. It cannot be checked, it delays nothing and it reverses");
      console.log("  nothing — anything else would be an exculpation any convicted party could fire at");
      console.log("  will. What it buys is that the record can now tell a sanction from an incident,");
      console.log("  which it could not say at all before. Whether it is true is a question for the");
      console.log("  members, not for the arithmetic.\n");
      if (!demo.claim.heldByPeers) {
        console.log("  Worth stating rather than hiding: no grant in the pool's agreements admits a");
        console.log("  claim across the boundary, so the other four operators do not hold a copy. They");
        console.log("  read it where you are about to — in the case files, replayed together.\n");
      }

      console.log("so the pool voted on the seat.\n");
      console.log(`  The round names its subject — ${name(demo.governance.subject)} — and recuses it by a`);
      console.log(`  cause anyone can resolve: the ${demo.governance.recusal.form} that convicted it. The accused`);
      console.log("  does not vote on its own expulsion, and the proposer could not have recused");
      console.log("  anybody else, because a cause that does not resolve fails the replay by name.\n");
      console.log(`  ${demo.governance.electorate.length} seats vote, and the bar is ${demo.governance.bar} of ${demo.governance.total}. The denominator is smaller than this`);
      console.log("  morning's because the snapshot never contained the recused seat — not because a");
      console.log("  proof lowered it. A proof that could lower a bar would make a contested round");
      console.log("  easier to win with one stolen key.\n");
      for (const [agent, judgment] of Object.entries(demo.governance.judgments)) {
        console.log(`  ${demo.labels[agent] ?? agent} — ${judgment.verdict.toUpperCase()}`);
        console.log(`    "${wrap(judgment.rationale, "     ")}"`);
        console.log(`    (written by ${wroteIt(judgment.producedBy)})\n`);
      }
      console.log(`  outcome:  ${demo.governance.outcome} -> ${demo.governance.action}`);
      for (const [option, weight] of Object.entries(demo.governance.weightTally).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${option.padEnd(10)} ${"█".repeat(Math.round(weight))} ${weight}`);
      }
      if (demo.governance.expelledBy) {
        console.log(`\n  ${name(demo.governance.expelledBy)} carried it out, naming the decision it acts on.`);
        console.log("  A member, never the hub: the hub sequences this pool and signs its proposals,");
        console.log("  and a membership act signed with the hub's own key is refused by the replay —");
        console.log("  otherwise whoever runs the server quietly decides who is in the room.");
      }
      console.log(`  member-role seats: ${demo.governance.membersBefore} -> ${demo.governance.membersAfter}\n`);
      console.log(`  A further round — ${shortId(demo.nextRound.round)}, pinned after the expulsion — takes ${demo.nextRound.voters} seats and`);
      console.log(`  declares ${demo.nextRound.excluded} exclusions: there is nothing left to declare, because the membership`);
      console.log(`  itself is smaller now. ${shortId(demo.succession.freshRound)} is untouched by that and still reads five, which`);
      console.log("  is the point: conviction zeroed a seat, the pool removed one, and neither");
      console.log("  reached backwards into a round that was already signed.\n");

      for (const [name, summary] of Object.entries(demo.exports)) {
        console.log(`export:  ${name.padEnd(9)} ${String(summary.activities).padStart(3)} activities -> ${summary.dir}`);
      }
      console.log("\nfive case files, five separate operators, one command to replay them together —");
      console.log("and the replay scans every ballot in every bundle for a signature that voted");
      console.log("twice, so concealing one is as detectable as telling two stories about anything");
      console.log("else. Here there was nothing to conceal: the proof was published.\n");
      console.log(
        `verify it:  python3 ../verifier/afp_verify.py ${Object.keys(demo.exports).map((n) => `${demo.exportRoot}/${n}`).join(" ")} --verbose\n`,
      );
      await demo.close();
      break;
    }

    case "p7": {
      const { runP7Demo } = await import("./demoP7.ts");
      const demo = await runP7Demo();
      // Origins are 127.0.0.1:<random port> in this demo, so every url reads
      // alike until it is mapped back to the desk that owns it.
      const nameOfOrigin = new Map(Object.entries(demo.desks).map(([name, d]) => [d.origin, name]));
      const op = (url: string): string => {
        const origin = url.split("/").slice(0, 3).join("/");
        return nameOfOrigin.get(origin) ?? origin;
      };
      const who = (url: string): string => `${op(url)}'s ${url.split("/").pop()}`;

      console.log("\nfour support desks share one out-of-hours queue for one software vendor, and");
      console.log("one quarterly retainer, split by who actually did the work:\n");
      for (const [name, d] of Object.entries(demo.desks)) {
        console.log(`  ${name.padEnd(10)} ${d.origin}  (${d.agents.join(", ")})${name === "northwind" ? " — hosts nightdesk" : ""}`);
      }
      console.log("\nnobody in this demo misbehaves. They still cannot agree on the number.\n");

      console.log("the quarter, as the hub's own chain (ADR-0022 Decision 1):");
      console.log(`  opens after  ${demo.period.from.slice(0, 26)}…  (${demo.period.opensAfter})`);
      console.log(`  closes at    ${demo.period.to.slice(0, 26)}…  (${demo.period.closesAt})`);
      console.log("  a half-open interval of digests — not a window over self-asserted `published`");
      console.log("  values, which cannot carry a cross-operator ordering claim at all\n");

      console.log("the tickets:");
      for (const ticket of demo.tickets) {
        const mark = ticket.inPeriod ? " " : "×";
        const authors = ticket.authors.length > 1 ? `${ticket.authors.length} authors` : "1 author";
        console.log(`  ${mark} ${ticket.slug.padEnd(30)} ${ticket.visibility.padEnd(8)} ${authors}`);
      }
      console.log("  × settled before the period opened — its timestamp is minutes from the edge,");
      console.log("    and no honest desk can be talked into counting it\n");

      console.log("a seat ends inside the quarter (ADR-0021, reused unchanged):");
      console.log(`  ${who(demo.expulsion.agent)} — round outcome '${demo.expulsion.outcome}', member-role seats ${demo.expulsion.membersBefore} -> ${demo.expulsion.membersAfter}`);
      console.log("  it had already worked, and been settled for, a ticket earlier in the quarter");
      console.log("  the work it was credited before that keeps its credit: accounting is");
      console.log("  forward-scoped, exactly as conviction is\n");

      console.log(`the first summary — computed by ${op(demo.draft.computedBy)}, over what it is entitled to read:`);
      console.log(`  scope        ${demo.draft.scope.join(", ")}`);
      console.log(`  denominator  ${demo.draft.denominator}`);
      for (const [operator, credited] of Object.entries(demo.draft.credited).sort()) {
        console.log(`    ${op(operator).padEnd(11)} ${"█".repeat(Math.round((credited / demo.draft.denominator) * 4))} ${credited / demo.draft.denominator} ${credited === demo.draft.denominator ? "ticket " : "tickets"}`);
      }
      for (const [operator, count] of Object.entries(demo.draft.unreadable).sort()) {
        console.log(`    ${op(operator).padEnd(11)} + ${count} settled task(s) it may not read — counted, never dropped`);
      }
      console.log("  this is an honest number computed by an honest desk. It is also wrong, and");
      console.log("  the record can say why rather than leaving two members to argue\n");

      console.log("the dispute (04 § Disputes, with evidence):");
      console.log(`  ${op(demo.dispute.by)} disputes it on ground '${demo.dispute.ground}'`);
      console.log(`  evidence: ${demo.dispute.evidence[0].slice(0, 30)}…`);
      console.log("  a dispute citing nothing checkable is a claim — refused at the port, and");
      console.log("  failed at replay. The arithmetic adjudicates; the dispute only points\n");

      console.log(`the correction — computed by ${op(demo.ratified.computedBy)}, which is a party to that ticket:`);
      console.log(`  scope        ${demo.ratified.scope.join(", ")}`);
      console.log(`  denominator  ${demo.ratified.denominator}`);
      for (const [operator, credited] of Object.entries(demo.ratified.credited).sort()) {
        console.log(`    ${op(operator).padEnd(11)} ${"█".repeat(Math.round((credited / demo.ratified.denominator) * 4))} ${credited / demo.ratified.denominator} ${credited === demo.ratified.denominator ? "ticket " : "tickets"}`);
      }
      console.log(`  unreadable   ${Object.keys(demo.ratified.unreadable).length === 0 ? "none — it could read the whole period" : JSON.stringify(demo.ratified.unreadable)}`);
      console.log(`  membership   ${demo.ratified.membership.map((m) => `${who(m.agent)} — ${m.act}`).join(", ") || "no change"}`);
      console.log(`  supersedes   ${demo.ratified.supersedes.split("/").pop()}`);
      console.log("  the escalation is credited 1:3 between the desk that triaged it and the desk");
      console.log("  that fixed it — integer shares, because a fraction cannot be canonicalised\n");

      console.log("and the dispute ends:");
      console.log(`  ratified by ${demo.ratified.round.split("/").pop()} — an ordinary round whose outcome names the summary,`);
      console.log("  which is 04's own ratification idiom and not a second consensus path.");
      console.log("  Exactly one summary now stands for this period; a second would fail replay\n");

      for (const [name, summary] of Object.entries(demo.exports)) {
        console.log(`export:  ${name.padEnd(10)} ${String(summary.activities).padStart(3)} activities -> ${summary.dir}`);
      }
      console.log(
        `\nverify it:  python3 ../verifier/afp_verify.py ${Object.keys(demo.exports).map((n) => `${demo.exportRoot}/${n}`).join(" ")} --verbose\n`,
      );
      await demo.close();
      break;
    }

    case "p7:llm": {
      const config = loadConfig();
      const { runP7Experiment } = await import("./experimentP7.ts");
      const wrapAt = (text: string, indent: string): string =>
        text
          .split(/\s+/)
          .reduce<string[]>((lines, word) => {
            const last = lines[lines.length - 1];
            if (last !== undefined && `${last} ${word}`.length <= 76) lines[lines.length - 1] = `${last} ${word}`;
            else lines.push(word);
            return lines;
          }, [])
          .join(`\n${indent}`);

      console.log(`brains: ${config.llmModel} @ ${config.llmBaseUrl}\n`);
      console.log("Four small support companies cover one software vendor's customers overnight,");
      console.log("between them, out of one shared queue. At the end of the quarter the vendor pays");
      console.log("one retainer, and it is split by who actually did the work.\n");
      console.log("Nobody in what follows misbehaves. They still do not agree, and the interesting");
      console.log("part is exactly which things they can disagree about and which they cannot.\n");

      const demo = await runP7Experiment({ endpoint: endpointOf(config) });
      const label = (name: string): string => demo.labels[name] ?? name;
      const opOf = (url: string): string => {
        const origin = url.split("/").slice(0, 3).join("/");
        const found = Object.entries(demo.desks).find(([, d]) => d.origin === origin);
        return found ? label(found[0]) : origin;
      };

      console.log("the quarter's tickets, worked over real sockets by four separate operators:\n");
      for (const ticket of demo.tickets) {
        const judged = demo.judgements.resolved[ticket.slug];
        console.log(`  ${ticket.inPeriod ? " " : "×"} ${ticket.slug}${ticket.visibility === "parties" ? "  (customer data)" : ""}`);
        if (judged?.content) console.log(`      "${wrapAt(judged.content, "       ")}"`);
      }
      console.log("\n  × was settled before the quarter opened. The boundary is two digests on the");
      console.log("    hub's own chain, so no desk can move a ticket across it by dating it\n");

      if (demo.judgements.split) {
        console.log("one ticket was worked by two desks, and that is the one thing here the record");
        console.log("cannot derive for itself:\n");
        console.log(`  ${label("kestrel")} fixed what ${label("dayshift")} had narrowed, and had to state the`);
        console.log(`  division on the shared record: ${demo.judgements.split.content}`);
        console.log(`    "${wrapAt(demo.judgements.split.rationale, "     ")}"`);
        console.log(`    (written by ${demo.judgements.split.producedBy.split(" @ ")[0]})\n`);
        console.log("  Whole numbers, because a fraction cannot be canonicalised in a signed");
        console.log("  document at all. The protocol does not settle this claim — it makes it");
        console.log("  explicit, signed, and checkable against exactly the authors it names.\n");
      }

      console.log("a seat ended halfway through:\n");
      console.log(`  ${opOf(demo.expulsion.agent)} was expelled by a vote of the other desks, and the work it`);
      console.log("  had already done keeps its credit. Accounting is forward-scoped for the same");
      console.log("  reason conviction is: what was accepted was accepted, and a later act does not");
      console.log("  reach back and un-do the night somebody worked.\n");

      console.log(`then ${opOf(demo.draft.computedBy)} added the quarter up — over what it is entitled to read:\n`);
      for (const [operator, credited] of Object.entries(demo.draft.credited).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${opOf(operator).padEnd(30)} ${credited / demo.draft.denominator}`);
      }
      for (const [operator, count] of Object.entries(demo.draft.unreadable).sort()) {
        console.log(`    ${opOf(operator).padEnd(30)} + ${count} settled ticket(s) it may not read`);
      }
      console.log("\n  That last line is the whole of P7. One ticket carried a customer's own tax");
      console.log("  filing, so it is served to nobody unentitled — correctly, and including three");
      console.log("  competitor desks in the same pool. The summary could have said nothing and");
      console.log("  simply come out lower. Instead it counts what it could not read, and an honest");
      console.log("  difference stops being indistinguishable from a fraud.\n");

      console.log(`  ${opOf(demo.dispute.by)} — which holds that ticket — disputed it, with evidence:`);
      console.log(`    ground '${demo.dispute.ground}', citing ${demo.dispute.evidence[0].slice(0, 24)}…`);
      console.log("    A dispute that cites nothing checkable is a claim, and this object exists so");
      console.log("    that a challenge resolves against the record instead.\n");

      console.log(`  and recomputed it over the wider scope:\n`);
      for (const [operator, credited] of Object.entries(demo.ratified.credited).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${opOf(operator).padEnd(30)} ${credited / demo.ratified.denominator}`);
      }
      console.log("\n  Both numbers were honest. Neither desk did anything wrong. What changed is");
      console.log("  that the record can now say *why* they differ.\n");

      console.log("the desks voted on whether that is the quarter's record:\n");
      for (const [seat, judged] of Object.entries(demo.judgements.ratify)) {
        const [deskName, seatName] = seat.split("/");
        console.log(`  ${`${label(deskName)} · ${seatName}`.padEnd(34)} ${judged.stand ? "STAND" : "REJECT"}`);
        console.log(`    "${wrapAt(judged.rationale, "     ")}"`);
        console.log(`    (written by ${judged.producedBy.split(" @ ")[0]})\n`);
      }
      console.log(`  outcome:  ${demo.terminal.ratified ? "ratified" : `not ratified (${demo.terminal.outcome})`}`);
      for (const [option, weight] of Object.entries(demo.terminal.tally).sort((a, b) => b[1] - a[1])) {
        const shown = option.startsWith("http") ? "the corrected summary" : option;
        console.log(`    ${shown.padEnd(24)} ${"█".repeat(Math.round(weight))} ${weight}`);
      }
      console.log(
        demo.terminal.ratified
          ? "\n  One summary now stands for this quarter. A second ratified one would fail the\n  replay by name, which is what it means for a dispute to end.\n"
          : "\n  The pool did not ratify it, so nothing stands for this quarter yet — a lawful\n  state, and one the record says out loud rather than leaving to be assumed.\n",
      );

      console.log("  Note what the models were never asked. Not one of them computed a number:");
      console.log("  the arithmetic is recomputed from signed evidence by two implementations, and");
      console.log("  a summary anybody had to take on trust is the thing this phase abolishes. They");
      console.log("  were asked the three questions the record genuinely cannot answer — what they");
      console.log("  did, how a shared ticket divides, and whether the frame is the right one.\n");

      for (const [name, summary] of Object.entries(demo.exports)) {
        console.log(`export:  ${name.padEnd(10)} ${String(summary.activities).padStart(3)} activities -> ${summary.dir}`);
      }
      console.log(
        `\nverify it:  python3 ../verifier/afp_verify.py ${Object.keys(demo.exports).map((n) => `${demo.exportRoot}/${n}`).join(" ")} --verbose\n`,
      );
      await demo.close();
      break;
    }

    case "p8": {
      const { runP8Demo } = await import("./demoP8.ts");
      console.log("\na tracker's webhook, a sealed triage panel, a pull request, a crash that");
      console.log("opens no second one, and a merge that stays a human's act (ADR-0028):\n");
      const demo = await runP8Demo({ fresh: true, config: { dataDir: "./data-p8", exportDir: "./export-p8" } });
      for (const line of demo.narration) console.log(line);
      console.log(`\nverify it:  python3 ../verifier/afp_verify.py ${demo.exported.dir} --thread ${demo.thread} --verbose\n`);
      demo.instance.close();
      break;
    }

    case "p8:llm": {
      const config = loadConfig();
      const { runP8Experiment } = await import("./experimentP8.ts");
      console.log(`brains: ${config.llmModel} @ ${config.llmBaseUrl}\n`);
      console.log("the same tracker webhook and forced crash — this time the triage panel's");
      console.log("verdict comes from a real model reading the report itself.\n");
      const demo = await runP8Experiment({ endpoint: endpointOf(config) });
      for (const line of demo.narration) console.log(line);
      console.log(`\nverify it:  python3 ../verifier/afp_verify.py ${demo.exported.dir} --thread ${demo.thread} --verbose\n`);
      demo.instance.close();
      break;
    }

    case "export": {
      const config = loadConfig();
      const instance = new AfpInstance(config, agentCollection(config));
      const summary = exportBundle(instance, config.exportDir);
      console.log(`exported ${summary.activities} activities to ${summary.dir}`);
      instance.close();
      break;
    }

    // ADR-0026 Decision 2: rotation and revocation as an operator surface.
    //   afp keys list  [<actor>]
    //   afp keys rotate <actor> [--kind proof|transport|hub:<id>] [--at <instant>]
    //   afp keys revoke <actor> <keyId> --since <instant> [--claim <proofDigest>]
    //
    // Deliberately does NOT construct an AfpInstance: a revocation with no
    // successor leaves the store with no active key, which the loader refuses
    // by design — so booting an instance here would make `keys rotate`
    // impossible to run at exactly the moment an operator needs it.
    case "keys": {
      const config = loadConfig();
      const { parseKind, rotateKey, revokeKey, locate, RevocationRefused } = await import("./instance/keyOps.ts");
      const { allKeyHistories } = await import("./crypto/keys.ts");
      const { openDb } = await import("./store/db.ts");
      const db = openDb(config.dbPath);
      const deps = { keyDir: config.keyDir, origin: config.origin, db };
      try {
        const sub = process.argv[3];
        const flag = (name: string): string | undefined => {
          const at = process.argv.indexOf(`--${name}`);
          return at === -1 ? undefined : process.argv[at + 1];
        };

        if (sub === "list") {
          const actors = process.argv[4]
            ? [process.argv[4]]
            : ["@instance", ...agentCollection(config).map((r) => r.spec.name)];
          for (const actor of actors) {
            const { controller, file } = locate(deps, actor, { kind: "proof" });
            console.log(`\n${actor}  (${controller})`);
            for (const entry of allKeyHistories(config.keyDir, file, controller)) {
              const window = `${entry.validFrom ?? "—"} .. ${entry.validUntil ?? "active"}`;
              console.log(`  ${entry.keyId.split("#")[1].padEnd(24)} ${window}${entry.retiredBy ? `  ${entry.retiredBy}` : ""}`);
            }
          }
          break;
        }

        if (sub === "rotate") {
          const actor = process.argv[4];
          if (!actor) {
            throw new Error(
              "usage: keys rotate <actor> [--kind proof|transport|hub:<id>] [--at <instant>] [--root remote]",
            );
          }
          const kind = parseKind(flag("kind"));
          const at = flag("at") ? new Date(flag("at")!) : new Date();

          if (flag("root") === "remote") {
            // ADR-0035 Decision 2: the root key lives on a remote signer and
            // signs one thing — the afp:KeyDelegation introducing this
            // rotation's successor. Configuration must name where it is;
            // guessing would mean signing with the wrong root silently.
            if (!config.signerUrl || !config.signerRootKeyId) {
              throw new Error("--root remote requires AFP_SIGNER_URL and AFP_SIGNER_ROOT_KEY_ID to be configured");
            }
            const { rotateKeyWithRemoteRoot } = await import("./instance/keyOps.ts");
            const { successor, delegation } = await rotateKeyWithRemoteRoot(deps, actor, kind, at, {
              url: config.signerUrl,
              keyId: config.signerRootKeyId,
              clientCertFile: config.signerClientCertFile,
              clientKeyFile: config.signerClientKeyFile,
              caFile: config.signerCaFile,
              lifetimeMs: config.issuedKeyLifetimeMs,
            });
            console.log(`rotated ${actor} (${flag("kind") ?? "proof"}) at ${at.toISOString()} — root: remote (${config.signerRootKeyId})`);
            console.log(`  successor: ${successor.keyId}`);
            console.log(`  afp:KeyDelegation published: ${delegation.activityId}`);
            console.log(`  the retired key keeps its interval — everything it signed in-interval still verifies`);
            console.log(`  next: re-export so the new afp:keyHistory and delegation travel, and hand peers the updated actor document`);
            break;
          }

          const successor = rotateKey(deps, actor, kind, at);
          console.log(`rotated ${actor} (${flag("kind") ?? "proof"}) at ${at.toISOString()}`);
          console.log(`  successor: ${successor.keyId}`);
          console.log(`  the retired key keeps its interval — everything it signed in-interval still verifies`);
          console.log(`  next: re-export so the new afp:keyHistory travels, and hand peers the updated actor document`);
          break;
        }

        if (sub === "revoke") {
          const actor = process.argv[4];
          const keyId = process.argv[5];
          const since = flag("since");
          if (!actor || !keyId || !since) {
            throw new Error("usage: keys revoke <actor> <keyId> --since <instant> [--claim <proofDigest>]");
          }
          try {
            revokeKey(deps, actor, parseKind(flag("kind")), keyId, new Date(since));
          } catch (error) {
            if (error instanceof RevocationRefused) {
              console.error(`\nrefused: ${error.message}\n`);
              process.exit(2);
            }
            throw error;
          }
          console.log(`revoked ${keyId} as of ${since}`);
          const claim = flag("claim");
          if (claim) {
            // The claim is published on the instance's own chain, so this one
            // path does need an instance — and can have one, because the
            // instance key is not the key being revoked in the case that
            // matters. If it is, mint the successor first.
            const instance = new AfpInstance(config, agentCollection(config));
            try {
              const published = instance.publishAsInstance(
                [],
                `${config.origin}/threads/key-custody`,
                "public",
                (envelope) => keyCompromiseClaim(envelope, { proof: claim, verificationMethod: keyId, since }),
              );
              console.log(`  published afp:KeyCompromiseClaim ${published.activityId}`);
              console.log(`  a claim is not evidence: it lets the record tell zeroed from zeroed-contested,`);
              console.log(`  and changes no weight by itself (ADR-0021 Decision 4a)`);
            } finally {
              instance.close();
            }
          }
          console.log(`  no successor was minted — "what signs next" is a separate decision (ADR-0012 D2)`);
          console.log(`  next: keys rotate ${actor}${flag("kind") ? ` --kind ${flag("kind")}` : ""}, then re-export`);
          break;
        }

        console.error("usage: keys [list|rotate|revoke] …");
        process.exit(1);
      } finally {
        db.close();
      }
      break;
    }

    case "config": {
      const sub = process.argv[3];
      if (sub !== "check") {
        console.error("usage: config check [--offline]");
        process.exit(1);
        break;
      }
      const config = loadConfig();
      const { runConfigCheck } = await import("./runtime/configCheck.ts");
      const offline = process.argv.includes("--offline");
      let fetchActor: import("./runtime/configCheck.ts").RunConfigCheckOptions["fetchActor"];
      if (!offline) {
        const { fetchActorDocument } = await import("./federation/inbox.ts");
        fetchActor = (url: string) =>
          fetchActorDocument(url, { devMode: config.devMode, trustedNets: config.trustedNets });
      }
      const result = await runConfigCheck(config, { offline, fetchActor });

      for (const problem of result.problems) {
        console.log(`FAIL  ${problem.field} (${problem.env}): ${problem.message}`);
      }
      for (const line of result.lines) {
        console.log(`${line.ok ? "ok  " : "FAIL"}  ${line.name}${line.reason ? ` — ${line.reason}` : ""}`);
      }
      process.exit(result.allOk ? 0 : 1);
      break;
    }

    case "backup": {
      const config = loadConfig();
      const dir = process.argv[3];
      if (!dir) {
        console.error("usage: backup <dir>");
        process.exit(1);
        break;
      }
      const { backupStore } = await import("./store/backup.ts");
      const log = logger("cli:backup");
      const manifest = await backupStore(dir, {
        dbPath: config.dbPath,
        artifactDir: config.artifactDir,
        origin: config.origin,
      });
      console.log(`backup written to ${dir}`);
      console.log(`  ${manifest.artifacts} artifacts, schema version ${manifest.schemaVersion}, taken ${manifest.takenAt}`);
      console.log("  keys were NOT included — back those up separately (README § Backup, ADR-0026 Decision 6)");
      log.info("backup", { dir });
      break;
    }

    case "restore": {
      const config = loadConfig();
      const dir = process.argv[3];
      if (!dir) {
        console.error("usage: restore <dir> [--force]");
        process.exit(1);
        break;
      }
      const force = process.argv.includes("--force");
      const { restoreStore, RestoreRefused } = await import("./store/backup.ts");
      const log = logger("cli:restore");
      try {
        const { restoredAt, manifest } = restoreStore(dir, {
          dbPath: config.dbPath,
          artifactDir: config.artifactDir,
          origin: config.origin,
          force,
        });
        console.log(`restored from ${dir} at ${restoredAt} (backup taken ${manifest.takenAt})`);
        console.log("  a restore point was recorded — a same-value duplicate vote after this instant");
        console.log("  is explained by that record, not equivocation (ADR-0020 Decision 2)");
        console.log("  reminder: exports under AFP_EXPORT_DIR were not restored — retention is the");
        console.log("  operator's afp:retentionDuty (ADR-0012)");
        log.info("restore", { dir, restoredAt });
      } catch (error) {
        if (error instanceof RestoreRefused) {
          console.error(`refused: ${error.message}`);
          process.exit(2);
        }
        throw error;
      }
      break;
    }

    // ADR-0038 Decision 4: hand a served instance's agent a job. Never opens
    // the store — `serve` holds its lock — and never mints a key; the body
    // lives in `ports/taskCli.ts`.
    //   afp task <agent> "<brief>" [--as <controller>] [--capability <id>] [--thread <url>] [--deadline <iso>] [--url <base>]
    case "task": {
      const config = loadConfig();
      const { parseTaskArgs, runTaskCli } = await import("./ports/taskCli.ts");
      let result: Awaited<ReturnType<typeof runTaskCli>>;
      try {
        result = await runTaskCli(config, parseTaskArgs(process.argv.slice(3)));
      } catch (error) {
        console.error(`\nrefused: ${(error as Error).message}\n`);
        process.exit(2);
      }
      console.log(JSON.stringify(result.body, null, 2));
      const refused = result.status !== 200 || (typeof result.body === "object" && result.body !== null && "reply" in result.body);
      if (refused) {
        console.error(`\n${result.url} answered ${result.status} as ${result.controller} — the polite reply means the instance declined; see README § Handing an agent a job`);
        process.exit(1);
      }
      break;
    }

    // ADR-0038 Decision 4, the read side: watch a served instance as a
    // signed reader. Same client plumbing as `task` — no store, no minting.
    //   afp show thread <url-or-slug> | agent <name> | status <name>  [--as <controller>] [--url <base>] [--json]
    case "show": {
      const config = loadConfig();
      const { parseShowArgs, runShowCli } = await import("./ports/showCli.ts");
      let result: Awaited<ReturnType<typeof runShowCli>>;
      try {
        result = await runShowCli(config, parseShowArgs(process.argv.slice(3)));
      } catch (error) {
        console.error(`\nrefused: ${(error as Error).message}\n`);
        process.exit(2);
      }
      if (result.refused) {
        console.error(result.refused);
        process.exit(1);
      }
      console.log(result.output);
      break;
    }

    case "serve": {
      const config = loadConfig();
      const instance = new AfpInstance(config, agentCollection(config));
      const log = logger("cli:serve");

      // ADR-0008: the federation gate and signed inbox are live on a served
      // instance — POST {actor}/inbox verifies the HTTP Signature, then the
      // agreement gate, then dispatches like local delivery.
      const { Federation } = await import("./federation/federation.ts");
      const { fetchActorDocument: fetchActorDocumentRaw } = await import("./federation/inbox.ts");
      const { httpTransport } = await import("./federation/transport.ts");
      const { Scheduler } = await import("./runtime/scheduler.ts");
      const { installShutdown } = await import("./runtime/shutdown.ts");
      const actorId = String(instance.instanceDocument().id);
      const federation = new Federation(instance.db, actorId, () => instance.clock.now());
      // ADR-0025: this instance's own policy — not the env-inferred default
      // every demo relies on — since `serve` is the one command allowed to
      // run in production mode.
      const fetchActorDocument = (url: string) =>
        fetchActorDocumentRaw(url, { devMode: config.devMode, trustedNets: config.trustedNets });

      // ADR-0031 Decision 2: `/readyz`'s self-check reuses `serve`'s own
      // fetch policy (dev mode fetches loopback directly) — the same
      // function the inbox's boundary uses to resolve a sender's key.
      // `scheduler` is filled in below, once it exists — this object is the
      // one `createHttpServer` closes over, so mutating it afterward is
      // seen by every request.
      const health: { scheduler?: Scheduler; fetchActor: typeof fetchActorDocument } = {
        fetchActor: fetchActorDocument,
      };

      // ADR-0013: the read half of the same gate. Without this the server
      // would serve `public` and 404 everything else to everyone — the
      // mechanism would exist and be reachable by nobody, which is the
      // "specified but not built" failure one layer down.
      const server = createHttpServer(instance, {
        inbox: {
          federation,
          receive: (activity) => instance.receiveAdmitted(activity),
          fetchDocument: fetchActorDocument,
        },
        read: {
          selfActor: actorId,
          fetchDocument: fetchActorDocument,
          isDenylisted: (who) => federation.isDenylisted(who),
          activeAgreementsWith: (counterparty, at) => federation.activeAgreementsWith(counterparty, at),
          // Enrollment is answerable only for hubs this instance hosts
          // (ADR-0013 Decision 3). `serve` runs no hub, so no `hub`-class
          // activity is admitted here — a stricter answer than a wrong one.
          roleOf: () => null,
          grants: () => [],
          now: () => instance.clock.now(),
        },
        health,
      });
      // Outbound delivery for the scheduler's `flush` loop: local targets
      // (this instance's own agents) short-circuit to in-process dispatch;
      // everything else is a signed HTTP hop.
      const transport = httpTransport({
        signer: instance.transportSigner("@instance"),
        now: () => instance.clock.now(),
        isLocal: (target) => instance.nameOf(target) !== null,
        local: instance.localTransport(),
      });

      // `serve` hosts no hub of its own, so `converge` has no replicas
      // unless a future embedding program supplies them (WP-1's scope: the
      // scheduler generalizes ADR-0025's real-time loop; wiring a resident
      // hub into `serve` is not this ADR's claim).
      const scheduler = new Scheduler({
        instance,
        transport,
        hubReplicas: [],
        federation,
        config: config.scheduler,
      });
      health.scheduler = scheduler;
      metrics.trackQueue(() => instance.queue.stats());
      scheduler.start();

      installShutdown({ server, scheduler, instance, transport, timeoutMs: 10_000 });

      server.listen(config.httpPort, () => {
        log.info("listening", { url: `http://localhost:${config.httpPort}`, origin: config.origin });
        log.info("routes", {
          read: "GET /actor /roster /agents/:name /agents/:name/outbox",
          inbox: "POST /actor/inbox /agents/:name/inbox   (HTTP Signature + agreement gate)",
          gate: "GET above `public`: signed + gated (ADR-0013); unsigned sees `public` only, 404 otherwise",
        });
      });
      break;
    }

    default:
      console.error(`unknown command: ${command}\nusage: cli.ts [demo|p2|p3|p3:llm|p4|p5|p5:llm|p6|p6:llm|p7|p7:llm|p8|p8:llm|export|keys|serve|task|show|config|backup|restore]`);
      process.exit(1);
  }
}

await main();
