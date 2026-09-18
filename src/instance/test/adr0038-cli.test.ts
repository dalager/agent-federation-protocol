/**
 * ADR-0038 gate, the CLI half: `npm run task` and `npm run show` against a
 * served instance (Decision 4 — a client that never opens the store). G6 and
 * G8–G10; the collection and the command form are `test/adr0038.test.ts`.
 * The harness is `test/adr0038-harness.ts`.
 *
 *   node --experimental-sqlite --test test/adr0038-cli.test.ts
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { systemClock } from "../src/instance.ts";
import { exportBundle } from "../src/export.ts";
import { cleanupWorkspaces, objectType, runVerifier } from "./helpers.ts";
import { heads, INSTANCE_DIR, showServe, taskServe, VERIFIER } from "./adr0038-harness.ts";

after(cleanupWorkspaces);

describe("ADR-0038 gate — the operator's own work, from the terminal", () => {
  it("G6 — the CLI: `npm run task` against a served instance signs as the controller and gets the same 200; with the controller key absent it fails by name and opens no store", async () => {
    // Wall clock: the CLI signs with `new Date()`, and the read gate checks skew against the instance's clock.
    const { instance, server, paths, agentsFile, controllers, origin, scheduler } = await taskServe({ clock: systemClock });
    try {
      const env = {
        ...process.env,
        AFP_DATA_DIR: paths.dataDir,
        AFP_ORIGIN: origin,
        AFP_CONTROLLERS: controllers.join(","),
        AFP_AGENTS_FILE: agentsFile,
        AFP_BRAIN: "stub",
        AFP_DEV: "1",
        AFP_LOG_LEVEL: "silent",
      };
      // Asynchronous on purpose: the served instance lives in *this* process,
      // so a synchronous exec would block the very event loop that has to
      // answer the child's POST (and the read gate's fetch of the
      // controller's actor document).
      const cli = async (args: string[], overrides: Record<string, string> = {}) =>
        (await promisify(execFile)(process.execPath, ["--disable-warning=ExperimentalWarning", "src/cli.ts", "task", ...args], {
          cwd: INSTANCE_DIR,
          env: { ...env, ...overrides },
          encoding: "utf8",
        })).stdout;

      const out = await cli(["worker", "Draft a readiness note.", "--as", "controller"]);
      const body = JSON.parse(out) as { task: string; thread: string; correlationId: string };
      assert.match(body.task, new RegExp(`^${instance.actorId("controller")}/activities/`));
      assert.equal(instance.outbox.byThread(body.thread).length, 1, "the Offer is on the record");
      await scheduler.tick("flush");
      assert.equal(instance.outbox.byThread(body.thread).length, 3, "…and performed on the next flush");

      // `--as` defaults to the first locally-held controller.
      const defaulted = JSON.parse(await cli(["worker", "Another job."])) as { task: string };
      assert.match(defaulted.task, new RegExp(`^${instance.actorId("controller")}/activities/`));

      // Key absent: a fresh data dir holds no `controller.pem`. Fails by name,
      // and the CLI never opened a store there — no db, no lock.
      const fresh = join(dirname(paths.dataDir), "cli-fresh");
      const head = instance.outbox.headDigest(instance.actorId("controller"));
      let failure: { code?: number; stderr?: string } | null = null;
      try {
        await cli(["worker", "Never sent."], { AFP_DATA_DIR: fresh });
      } catch (error) {
        failure = error as { code?: number; stderr?: string };
      }
      assert.ok(failure, "the CLI exits non-zero");
      assert.equal(failure!.code, 2);
      assert.match(String(failure!.stderr), /controller key for "controller" not found/);
      assert.match(String(failure!.stderr), /never mints/);
      assert.equal(existsSync(join(fresh, "afp.db.lock")), false, "no lock file appeared");
      assert.equal(existsSync(join(fresh, "afp.db")), false, "no store was created");
      assert.equal(instance.outbox.headDigest(instance.actorId("controller")), head, "the served instance is undisturbed");
      assert.equal((await fetch(`${origin}/actor`)).status, 200, "the served instance still answers");
    } finally {
      server.close();
      instance.close();
    }
  });

  it("G10 — the review loop by hand: task → show result → task --attach <digest> --thread <slug>: the reviewer gets the draft as bytes, the review lands on the draft's thread, a bad digest is refused, and the thread replays clean", async () => {
    const { instance, server, origin, slug, thread, show, task, post, scheduler, config, noStoreOpened } = await showServe();
    let exported: ReturnType<typeof exportBundle> | null = null;
    try {
      // (a) the draft's digest, off the Result `show result` prints.
      const draft = await show(["result", slug, "--json"]);
      assert.equal(draft.code, 0, draft.stderr);
      const result = JSON.parse(draft.stdout) as { object: { attachment: { "afp:digest": string; mediaType: string }[] } };
      const digest = result.object.attachment[0]["afp:digest"];
      assert.match(digest, /^sha256:[0-9a-f]{64}$/);
      assert.equal(result.object.attachment[0].mediaType, "text/markdown");

      // (b) hand the reviewer the draft by reference, on the draft's thread — a bare slug.
      const review = await task(["reviewer", "Review the attached draft.", "--attach", digest, "--thread", slug]);
      assert.equal(review.code, 0, review.stderr);
      const body = JSON.parse(review.stdout) as { task: string; thread: string; correlationId: string };
      assert.equal(body.thread, thread, "a bare slug resolves to the draft's thread");
      const offer = instance.outbox.byThread(thread).find((e) => e.activityId === body.task)!;
      const links = (offer.activity.object as { attachment: { "afp:digest": string }[] }).attachment;
      assert.deepEqual(links.map((l) => l["afp:digest"]), [digest], "the Offer carries the reference");

      await scheduler.tick("flush");
      await scheduler.tick("flush");
      const reviewer = instance.brainFor("reviewer") as { requests: { attachments: { digest: string; bytes?: Uint8Array; excerpt: string }[] }[] };
      assert.equal(reviewer.requests.length, 1);
      const seen = reviewer.requests[0].attachments[0];
      assert.equal(seen.digest, digest);
      assert.ok(seen.bytes instanceof Uint8Array, "consumes text/markdown: the bytes, not only an excerpt");
      assert.match(new TextDecoder().decode(seen.bytes), /^# worker: afp:cap:assess/, "and they are the draft");

      const shapes = instance.outbox.byThread(thread).map((e) => [e.activity.type, objectType(e.activity), e.actor.split("/").pop()]);
      assert.deepEqual(shapes, [
        ["Offer", "afp:Task", "controller"], ["Accept", "", "worker"], ["Create", "afp:Result", "worker"],
        ["Offer", "afp:Task", "controller"], ["Accept", "", "reviewer"], ["Create", "afp:Result", "reviewer"],
      ]);
      const rendered = await show(["thread", slug]);
      assert.equal(rendered.code, 0, rendered.stderr);
      const lines = rendered.stdout.trim().split("\n").slice(1);
      assert.equal(lines.length, 6);
      assert.match(lines[2], / worker Create\/afp:Result /);
      assert.match(lines[5], / reviewer Create\/afp:Result /);
      const all = await show(["result", slug, "--all"]);
      assert.equal(all.code, 0, all.stderr);
      assert.match(all.stdout, /^worker · .* · afp:producedBy: stub\n/);
      assert.match(all.stdout, /\n\nreviewer · .* · afp:producedBy: stub\n# reviewer: afp:cap:review\n/);
      assert.match(all.stdout, /# reviewer: afp:cap:review\n\n# worker: afp:cap:assess/, "the review echoes the draft it was handed");

      // (c) a digest the store does not hold, and something that is no digest: refused alike, chain unchanged.
      const before = heads(instance, ["controller", "reviewer"]);
      const unknown = await post("controller", "/agents/reviewer/command", { content: "@reviewer task Review.", attachments: [`sha256:${"0".repeat(64)}`] });
      const malformed = await post("controller", "/agents/reviewer/command", { content: "@reviewer task Review.", attachments: ["not-a-digest"] });
      const notAList = await post("controller", "/agents/reviewer/command", { content: "@reviewer task Review.", attachments: digest });
      for (const res of [unknown, malformed, notAList]) {
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, unknown.body);
      }
      assert.ok(typeof unknown.body.reply === "string");
      assert.deepEqual(heads(instance, ["controller", "reviewer"]), before);
      // The CLI refuses a non-digest itself, before signing (G10(b)); the
      // server-side refusal of one is the direct POST above.
      const viaCli = await task(["reviewer", "Review.", "--attach", "not-a-digest"]);
      assert.equal(viaCli.code, 2, "refused locally by name");
      assert.match(viaCli.stderr, /--attach needs a sha256:<hex> digest/);
      noStoreOpened();

      // (d) the thread replays clean — server down first, as the export cases do.
      await new Promise<void>((resolve) => server.close(() => resolve()));
      exported = exportBundle(instance, config.exportDir);
    } finally {
      if (!exported) server.close();
      instance.close();
    }
    const verdict = runVerifier(VERIFIER, exported!.dir, thread, ["--verbose"]);
    assert.equal(verdict.code, 0, verdict.output);
    assert.match(verdict.output, /PASSED/);
    assert.ok(origin.length > 0);
  });

  it("G10(b) — `--attach \"\"` and a bare `--attach` are refused locally by name, before anything is signed", async () => {
    const { instance, server, slug, task, noStoreOpened } = await showServe();
    try {
      const before = heads(instance, ["controller", "reviewer"]);
      const logBefore = instance.auditLog().length;

      // An unset shell variable: `--attach ""` must never become "a task with no attachment".
      const empty = await task(["reviewer", "Review the attached draft.", "--attach", "", "--thread", slug]);
      assert.equal(empty.code, 2);
      assert.equal(empty.stdout, "");
      assert.match(empty.stderr, /--attach needs a sha256:<hex> digest, got ""/);

      const dangling = await task(["reviewer", "Review the attached draft.", "--thread", slug, "--attach"]);
      assert.equal(dangling.code, 2);
      assert.match(dangling.stderr, /--attach needs a sha256:<hex> digest/);

      assert.deepEqual(heads(instance, ["controller", "reviewer"]), before, "nothing reached the instance");
      assert.equal(instance.auditLog().length, logBefore, "no request was signed, so nothing was refused server-side either");
      noStoreOpened();
    } finally {
      server.close();
      instance.close();
    }
  });

  it("G8 — `show status`, an anonymous rendering fetch, and `show thread` on a thread the controller is no party to: served, 404, and exit 1 without opening the store", async () => {
    const { instance, server, origin, slug, show, noStoreOpened } = await showServe();
    try {
      const status = await show(["status", "worker"]);
      assert.equal(status.code, 0, status.stderr);
      const body = JSON.parse(status.stdout) as { status: { chainHead: string; paused: boolean; pending: number } };
      assert.equal(body.status.chainHead, instance.outbox.headDigest(instance.actorId("worker")), "the chain head, as the controller");
      assert.equal(body.status.paused, false);

      const anonymous = await fetch(`${origin}/threads/${slug}/rendering`);
      assert.equal(anonymous.status, 404, "a parties thread to an anonymous caller is indistinguishable from no thread");

      // A thread the controller is no party to: the worker's own note, addressed to nobody.
      instance.publish("worker", [], `${origin}/threads/private-note`, "parties", (envelope) => ({
        "@context": ["https://www.w3.org/ns/activitystreams", "https://dalager.github.io/agent-federation-protocol/ns/v3.jsonld"],
        id: envelope.activityId,
        type: "Create",
        actor: envelope.actor,
        to: [],
        published: envelope.published,
        context: envelope.thread,
        "afp:visibility": envelope.visibility,
        ...(envelope.prevActivity !== null ? { "afp:prevActivity": envelope.prevActivity } : {}),
        object: { type: "Note", content: "nobody's business" },
      }));
      const refused = await show(["thread", "private-note"]);
      assert.equal(refused.code, 1);
      assert.equal(refused.stdout, "");
      assert.equal(refused.stderr.trim(), "not served to controller (404)", "one line, no speculation");
      // A full URL resolves to the same slug; a foreign thread URL is refused locally, before any request.
      const byUrl = await show(["thread", `${origin}/threads/private-note`]);
      assert.equal(byUrl.stderr.trim(), "not served to controller (404)");
      const foreign = await show(["thread", "https://other.example/threads/x"]);
      assert.equal(foreign.code, 2);
      assert.match(foreign.stderr, /not a thread under/);

      // `show agent` runs the timeline route; the worker's entries are all
      // `parties` and, under the finding below, none is admitted — the route
      // answers 200 with an empty narrative rather than 404, by design.
      const timeline = await show(["agent", "worker"]);
      assert.equal(timeline.code, 0, timeline.stderr);
      assert.match(timeline.stdout, /^Rendering of /);
      noStoreOpened();
    } finally {
      server.close();
      instance.close();
    }
  });

  // Admitted by ADR-0013 Decision 3 as revised under contact (2026-09-18):
  // the controller is self-operated (no self-agreement to check) and is the
  // Offer's author and the Accept/Result's addressee — a party to all three.
  it("G8(b) — `show thread <slug>` as the controller that delegated the task: the narrative names Offer, Accept and Result, and --json carries afp:bundle", async () => {
    const { instance, server, slug, show, noStoreOpened } = await showServe();
    try {
      const narrative = await show(["thread", slug]);
      assert.equal(narrative.code, 0, narrative.stderr);
      assert.match(narrative.stdout, /^Rendering of .*\/threads\/task-[0-9a-f]{12} — digest [0-9a-f]{64}, rendered .*, no export\n/);
      assert.match(narrative.stdout, /Offer\/afp:Task/);
      assert.match(narrative.stdout, /Accept/);
      assert.match(narrative.stdout, /Create\/afp:Result/);

      const json = await show(["thread", slug, "--json"]);
      assert.equal(json.code, 0, json.stderr);
      const rendering = JSON.parse(json.stdout) as { "afp:bundle": unknown; "afp:renderingDigest": string; narrative: string[] };
      assert.ok("afp:bundle" in rendering, "the bundle field the rendering already has (null before an export)");
      assert.equal(rendering["afp:bundle"], null);
      assert.equal(rendering.narrative.length, 3);
      noStoreOpened();
    } finally {
      server.close();
      instance.close();
    }
  });

  it("G9 — `show result <slug>` as the controller prints the performer's Result and afp:producedBy; --json yields the activity; before any flush it is `no result yet`; anonymous outbox omits it; no store opened", async () => {
    // The unperformed case first: a fresh task on the same served instance, no flush.
    const served = await showServe();
    const { instance, server, origin, slug, show, noStoreOpened, post } = served;
    try {
      const pending = await post("controller", "/agents/worker/command", { content: "@worker task Not yet performed." });
      const pendingSlug = String(pending.body.correlationId);
      assert.equal(instance.outbox.byThread(String(pending.body.thread)).length, 1, "Offer only");
      const early = await show(["result", pendingSlug]);
      assert.equal(early.code, 1);
      assert.equal(early.stdout, "");
      assert.equal(early.stderr.trim(), `no result yet on ${origin}/threads/${pendingSlug}`);

      // The performed task from the harness.
      const text = await show(["result", slug]);
      assert.equal(text.code, 0, text.stderr);
      const [header, ...rest] = text.stdout.split("\n");
      assert.match(header, /^worker · \d{4}-\d{2}-\d{2}T.* · afp:producedBy: stub$/);
      assert.match(rest.join("\n"), /# worker: afp:cap:assess/, "the Result's content, verbatim");
      assert.match(rest.join("\n"), /Assess the window\./);
      assert.match(text.stdout, /attachment: text\/markdown sha256:[0-9a-f]{64}/, "attachments are named, not fetched");
      // The next step, copy-pasteable, on stderr only — stdout stays the answer.
      const digest = /attachment: text\/markdown (sha256:[0-9a-f]{64})/.exec(text.stdout)![1];
      assert.equal(text.stderr.trim(), `next: npm run task -- <agent> "…" --attach ${digest} --thread ${slug}`);
      assert.doesNotMatch(text.stdout, /^next: /m);

      const json = await show(["result", slug, "--json"]);
      assert.equal(json.code, 0, json.stderr);
      assert.equal(json.stderr, "", "no hint in --json mode");
      const activity = JSON.parse(json.stdout) as { type: string; actor: string; context: string; object: { type: string; "afp:producedBy": string } };
      assert.equal(activity.type, "Create");
      assert.equal(activity.object.type, "afp:Result");
      assert.equal(activity.object["afp:producedBy"], "stub");
      assert.equal(activity.actor, instance.actorId("worker"));
      assert.equal(activity.context, `${origin}/threads/${slug}`);

      // `--agent` names the performer outright; `--all` lists in order (one here).
      const named = await show(["result", slug, "--agent", "worker", "--all", "--json"]);
      assert.equal(named.code, 0, named.stderr);
      assert.equal((JSON.parse(named.stdout) as unknown[]).length, 1);

      // The Result is `parties`: anonymous, the performer's outbox does not carry it.
      const anonymous = await fetch(`${origin}/agents/worker/outbox`);
      const anonymousBody = await anonymous.text();
      assert.ok(!anonymousBody.includes('"afp:Result"'), `no Result served anonymously (status ${anonymous.status}): ${anonymousBody.slice(0, 200)}`);

      // A thread the controller is no party to: the rendering's 404, same line.
      const refused = await show(["result", "nobody-elses"]);
      assert.equal(refused.code, 1);
      assert.equal(refused.stderr.trim(), "not served to controller (404)");
      noStoreOpened();
    } finally {
      server.close();
      instance.close();
    }
  });
});
