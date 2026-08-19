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
        const object = entry.activity.object;
        const objectType =
          object && typeof object === "object" && !Array.isArray(object)
            ? String((object as Record<string, unknown>).type ?? "")
            : "";
        const label = objectType ? `${entry.activity.type}{${objectType}}` : String(entry.activity.type);
        const actor = String(entry.actor).split("/").pop();
        console.log(
          `  ${String(entry.seq).padStart(2)}  ${actor?.padEnd(9)} ${label.padEnd(20)} ${entry.visibility}`,
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
      const server = createHttpServer(instance);
      server.listen(config.httpPort, () => {
        console.log(`AFP instance on http://localhost:${config.httpPort}`);
        console.log("  GET /actor  /roster  /agents/:name  /agents/:name/outbox");
        console.log("  everything above `public` returns 404 to an unauthenticated fetch");
      });
      break;
    }

    default:
      console.error(`unknown command: ${command}\nusage: cli.ts [demo|p2|p3|export|serve]`);
      process.exit(1);
  }
}

await main();
