/**
 * `afp <command>` — demo, export, serve.
 *
 * Run with: node --experimental-sqlite src/cli.ts <command>
 */

import { loadConfig } from "./config.ts";
import { endpointOf, runDemo } from "./demo.ts";
import { AfpInstance } from "./instance.ts";
import { agentRegistrations } from "./demo.ts";
import { checkEndpoint } from "./brains/openai.ts";
import { createHttpServer } from "./ap/server.ts";
import { exportBundle } from "./export.ts";

const command = process.argv[2] ?? "demo";

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
        console.log(`    (written by ${assessment.producedBy})\n`);
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
      console.log(`  ${who(demo.conviction.actor)} signed the same (round, phase, seqNo) twice:`);
      for (const half of demo.conviction.halves) {
        console.log(`    ${half.value.padEnd(4)} ${half.digest.slice(0, 22)}…  observedVotes: ${half.observed}`);
      }
      console.log("  the hub recomputed convicts() over the two signed objects, published an");
      console.log("  Announce{afp:EquivocationProof} carrying both of them verbatim, and zeroed the seat");
      console.log(`  the proof re-verified from its own two embedded votes: ${demo.conviction.verifiesStandalone}`);
      console.log("    — which is what makes it usable by someone holding nothing else\n");

      console.log("the same shape, and not a sanction (the finding-58 discriminator):");
      console.log(`  ${who(demo.restore.actor)} restored from backup and re-signed its vote`);
      console.log(`    same tuple: ${demo.restore.sameTupleAsFirst}   same value: yes   different bytes: ${demo.restore.duplicateDigest.slice(0, 22)}…`);
      console.log(`    convicted: ${demo.restore.convicted}  — values convict, hashes do not`);
      console.log(`  its lawful move was to re-vote at seqNo ${demo.restore.revoteSeqNo}, which superseded in place:`);
      console.log(`    receipts for that seat: ${demo.restore.receiptsForActor} (counted once, not zero, not twice)\n`);

      console.log("the arithmetic after the proof (ADR-0020 Decision 4):");
      for (const [option, weight] of Object.entries(demo.doom.attainable)) {
        console.log(`  attainable(${option.padEnd(3)}) = ${weight}  ${weight < demo.doom.bar ? "<" : ">="} bar ${demo.doom.bar}`);
      }
      console.log(`  doomed: ${demo.doom.doomed} — the zeroed seat stays in the denominator, it just cannot cast`);
      if (demo.noDecisionReason === "quorum-impossible") {
        console.log(`  ${who(demo.doom.demandedBy)} demanded the close: 71 hours of theatre became one activity\n`);
      } else {
        console.log("  not provably doomed on these votes — the round closed on its own terms\n");
      }

      console.log(`outcome:  ${demo.outcome}${demo.noDecisionReason ? ` (${demo.noDecisionReason})` : ""}`);
      console.log(`counted:  ${demo.countedVotes} votes — the convicted seat's ballot is not among them`);
      for (const [option, weight] of Object.entries(demo.weightTally).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${option.padEnd(10)} ${"█".repeat(Math.round(weight))} ${weight}`);
      }
      for (const [agent, status] of Object.entries(demo.uncounted)) {
        console.log(`  ${who(agent).padEnd(10)} ${status}`);
      }
      console.log("  the convicted seat's weight is the abstain row: it still counts toward the");
      console.log("  total the bar was computed over (Decision 4 — zeroing removes the ability to");
      console.log("  cast, never the electorate the rule was pinned against)");

      console.log(`\nthe stall recovery (ADR-0020 Decision 3):`);
      console.log(`  entitled successor: ${who(demo.succession.entitled)}`);
      if (demo.succession.skipped.length) {
        console.log(`  skipped:            ${demo.succession.skipped.map(who).join(", ")} — convicted in this round`);
      }
      console.log(`  it opened ${who(demo.succession.freshRound)} naming the stalled round by digest`);
      console.log("    reputation would have handed this to the equivocator: it has the pool's best");
      console.log("    settlement record. Snapshot order is dumb on purpose.\n");

      console.log(`the consequence (ADR-0019):`);
      console.log(`  ${who(demo.actuation.actor)} published afp:action ${demo.actuation.action}`);
      console.log(`  "${demo.actuation.notice}"\n`);

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

      console.log(demo.bulletin.split("\n").map((line) => `  ${line}`).join("\n"));
      console.log(`\nthe question:  ${demo.question}\n`);

      console.log("each underwriter read the same bulletin next to its own book, and answered:\n");
      for (const voter of demo.voters) {
        const agent = shortId(voter);
        const assessment = demo.assessments[agent];
        if (!assessment) continue;
        console.log(`  ${who(voter)} — ${assessment.verdict.toUpperCase()}`);
        console.log(`    "${wrap(assessment.rationale, "     ")}"`);
        console.log(`    (written by ${assessment.producedBy})\n`);
      }

      console.log("then one of them signed its answer twice.\n");
      console.log(`  ${who(demo.conviction.actor)} put its name to two ballots at the same round,`);
      console.log("  the same phase and the same sequence number — one saying yes, one saying no,");
      console.log("  each carrying the set of votes it claimed to have seen:\n");
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
      console.log(`  ${who(demo.restore.actor)} came back from a backup taken before it voted. It had`);
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
        console.log(`  ${who(demo.doom.demandedBy)} asked for the round to be closed on the arithmetic,`);
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
        console.log(`  and not ${demo.succession.skipped.map(who).join(", ")}, which the rule skipped for being convicted.`);
      }
      console.log("  The old rule was 'whoever has the best reputation' — and in this pool that is");
      console.log("  the member that just equivocated: a diligent underwriter for years, right up");
      console.log("  until this morning. The round now pins the order before anyone votes, and the");
      console.log("  order is dumb on purpose. Whoever opens the next round writes its deadline,");
      console.log("  its bar, its electorate and what may be done about the answer, so it is not a");
      console.log("  chore to hand out on popularity.\n");

      console.log("what actually happened to the money:\n");
      console.log(`  ${who(demo.actuation.actor)} carried it out, under the one action this round had`);
      console.log(`  already declared admissible for this outcome (${demo.actuation.action}):\n`);
      console.log(`    "${wrap(demo.actuation.notice, "     ")}"\n`);
      console.log("  That desk has no vote and never had one. It could not have chosen a different");
      console.log("  instruction: the round fixed the menu before the first ballot existed.\n");

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

    case "export": {
      const config = loadConfig();
      const instance = new AfpInstance(config, agentRegistrations(config));
      const summary = exportBundle(instance, config.exportDir);
      console.log(`exported ${summary.activities} activities to ${summary.dir}`);
      instance.close();
      break;
    }

    case "serve": {
      const config = loadConfig();
      const instance = new AfpInstance(config, agentRegistrations(config));

      // ADR-0008: the federation gate and signed inbox are live on a served
      // instance — POST {actor}/inbox verifies the HTTP Signature, then the
      // agreement gate, then dispatches like local delivery.
      const { Federation } = await import("./federation/federation.ts");
      const { fetchActorDocument } = await import("./federation/inbox.ts");
      const actorId = String(instance.instanceDocument().id);
      const federation = new Federation(instance.db, actorId, () => instance.clock.now());

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
      });
      server.listen(config.httpPort, () => {
        console.log(`AFP instance on http://localhost:${config.httpPort}  (origin: ${config.origin})`);
        console.log("  GET  /actor  /roster  /agents/:name  /agents/:name/outbox");
        console.log("  POST /actor/inbox  /agents/:name/inbox   (HTTP Signature + agreement gate)");
        console.log("  GET  above `public`: signed + gated (ADR-0013); unsigned sees `public` only, 404 otherwise");
      });
      break;
    }

    default:
      console.error(`unknown command: ${command}\nusage: cli.ts [demo|p2|p3|p3:llm|p4|p5|p5:llm|p6|p6:llm|export|serve]`);
      process.exit(1);
  }
}

await main();
