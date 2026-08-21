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
      console.log(`gamma  ${demo.gamma.origin}  (e-noc, e-watcher)\n`);

      console.log(`the bridge seats ${demo.members.length}, foreign seats enrolled through the real inbox`);
      console.log(`  observer: ${shortAgent(demo.observer)} — reads at hub visibility, never decides\n`);

      console.log("the write door (ADR-0016 Decision 2):");
      console.log(`  unenrolled agent, valid operator      ${demo.rogueStatus} {"error":"refused"}`);
      console.log(`  same write, valid membership proof    ${demo.provenRogueStatus} — identical: the proof is a read credential`);
      console.log(`  enrolled observer's vote              ${demo.observerVoteStatus} at the door, dead in the handler`);
      console.log(`  member votes tallied                  ${demo.talliedVotes} (the observer's not among them)\n`);

      console.log("afp:uncounted on the closing DecisionRecord:");
      for (const [agent, status] of Object.entries(demo.uncounted)) {
        console.log(`  ${shortAgent(agent).padEnd(12)} ${status}`);
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
      console.error(`unknown command: ${command}\nusage: cli.ts [demo|p2|p3|p4|p5|export|serve]`);
      process.exit(1);
  }
}

await main();
