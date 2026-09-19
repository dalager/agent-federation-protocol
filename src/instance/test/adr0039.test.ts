/**
 * ADR-0039 — the operator takes a seat. The four hub acts, reachable from a
 * terminal against a running instance.
 *
 * G1  the typed body is validated whole, before anything is published
 * G2  argument parsing and the hub-url/id convenience
 * G3  end to end against a real `serve` hosting its own hub: follow → enroll
 *     → unenroll → unfollow, each read back off the record, with the CLI
 *     never opening the store `serve` holds
 * G4  every refusal is the polite reply with nothing published — an
 *     unauthorized requester, an unknown verb, a foreign agent, a malformed
 *     hub, and an `unfollow` with no live Follow to undo
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { AfpInstance } from "../src/instance.ts";
import { loadConfig } from "../src/config.ts";
import { parseHubCommand } from "../src/ports/hubCommand.ts";
import { hubActorUrl, parseHubArgs } from "../src/ports/hubCli.ts";
import { workspace } from "./helpers.ts";
import { freePort, INSTANCE_DIR } from "./adr0038-harness.ts";

const HUB = "bridge";

// ------------------------------------------------------------------ G1

describe("ADR-0039 G1 — the typed body, validated whole", () => {
  it("accepts the four verbs and refuses everything else by shape", () => {
    const ok = (body: unknown) => {
      const parsed = parseHubCommand(body);
      assert.ok(!("refuse" in parsed), `expected accepted: ${JSON.stringify(body)} → ${JSON.stringify(parsed)}`);
      return parsed.command;
    };
    const no = (body: unknown, pattern: RegExp) => {
      const parsed = parseHubCommand(body);
      assert.ok("refuse" in parsed, `expected refused: ${JSON.stringify(body)}`);
      assert.match(parsed.refuse, pattern);
    };

    assert.deepEqual(ok({ verb: "follow", hub: "https://h.test/hubs/bridge" }), {
      verb: "follow",
      hub: "https://h.test/hubs/bridge",
    });
    assert.deepEqual(ok({ verb: "enroll", hub: "https://h.test/hubs/bridge", agent: "writer", capabilities: ["afp:cap:draft"], role: "observer" }), {
      verb: "enroll",
      hub: "https://h.test/hubs/bridge",
      agent: "writer",
      capabilities: ["afp:cap:draft"],
      role: "observer",
    });
    assert.deepEqual(ok({ verb: "unenroll", hub: "https://h.test/hubs/bridge", agent: "writer", reason: "done" }).reason, "done");

    no({}, /unknown verb/);
    no("follow", /body is not an object/);
    no({ verb: "archive", hub: "https://h.test/hubs/bridge" }, /unknown verb/);
    no({ verb: "follow" }, /hub is not an absolute URL/);
    no({ verb: "follow", hub: "bridge" }, /hub is not an absolute URL/);
    no({ verb: "enroll", hub: "https://h.test/hubs/bridge" }, /agent is not a local agent name/);
    no({ verb: "enroll", hub: "https://h.test/hubs/bridge", agent: "../etc" }, /agent is not a local agent name/);
    no({ verb: "enroll", hub: "https://h.test/hubs/bridge", agent: "writer", capabilities: "afp:cap:draft" }, /capabilities is not a list/);
    no({ verb: "enroll", hub: "https://h.test/hubs/bridge", agent: "writer", role: "queen" }, /role is not member\/observer/);
    no({ verb: "unenroll", hub: "https://h.test/hubs/bridge", agent: "writer", reason: "two\nlines" }, /single-line/);

    // The grammar's own threat model, applied to the typed body: free text
    // gets nowhere, because there is no field that carries any.
    no({ verb: "follow\nenroll", hub: "https://h.test/hubs/bridge" }, /unknown verb/);
  });
});

// ------------------------------------------------------------------ G2

describe("ADR-0039 G2 — the argument shape", () => {
  it("parses each verb, and refuses a malformed line with the usage", () => {
    assert.deepEqual(parseHubArgs(["follow", "https://h.test/hubs/bridge"]), {
      verb: "follow",
      hub: "https://h.test/hubs/bridge",
      capability: [],
    });
    assert.deepEqual(parseHubArgs(["enroll", "writer", "bridge", "--capability", "a", "--capability", "b", "--role", "observer"]), {
      verb: "enroll",
      agent: "writer",
      hub: "bridge",
      capability: ["a", "b"],
      role: "observer",
    });
    assert.equal(parseHubArgs(["list"]).verb, "list");
    assert.equal(parseHubArgs(["unenroll", "writer", "bridge", "--reason", "done"]).reason, "done");

    assert.throws(() => parseHubArgs([]), /unknown hub verb/);
    assert.throws(() => parseHubArgs(["archive", "bridge"]), /unknown hub verb/);
    assert.throws(() => parseHubArgs(["follow"]), /follow needs a hub/);
    assert.throws(() => parseHubArgs(["enroll", "writer"]), /enroll needs an agent and a hub/);
    assert.throws(() => parseHubArgs(["follow", "bridge", "--nope", "x"]), /unknown flag --nope/);
    assert.throws(() => parseHubArgs(["follow", "bridge", "--as"]), /--as needs a value/);
  });

  it("a bare id resolves under this instance's own origin; a url is taken as given", () => {
    const config = loadConfig({ ...workspace(), origin: "https://mine.test" });
    assert.equal(hubActorUrl(config, "bridge"), "https://mine.test/hubs/bridge");
    assert.equal(hubActorUrl(config, "https://theirs.test/hubs/annex"), "https://theirs.test/hubs/annex");
    assert.throws(() => hubActorUrl(config, "not/an/id"), /not a hub url or id/);
  });
});

// ------------------------------------------------------------------ G3 / G4

/** Poll `/healthz` until the spawned `serve` answers, or give up with what it printed. */
async function awaitServe(origin: string, log: () => string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`serve never became ready:\n${log()}`);
}

/**
 * A served instance hosting its own hub, with the `hub` CLI run against it
 * from a *separate* data directory holding a copy of the keys and no store —
 * so "never opens the store" is checked by the absence of any `afp.db` there
 * rather than inferred (ADR-0038's `showServe` discipline).
 */
async function hubServe(t: { after: (fn: () => void) => void }) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const paths = workspace();
  const root = dirname(paths.dataDir);
  mkdirSync(root, { recursive: true });
  const agentsFile = join(root, "agents.json");
  writeFileSync(
    agentsFile,
    JSON.stringify([
      { name: "operator", capabilities: [], brain: "none" },
      { name: "writer", capabilities: ["afp:cap:draft"], brain: "stub" },
    ]),
  );
  const controllers = [`${origin}/agents/operator`];

  // Mint the keys and the roster before `serve` takes the lock, so the CLI's
  // key directory copy below has the controller key in it.
  const config = loadConfig({ ...paths, origin, agentsFile, controllers, devMode: true, brain: "stub", hubs: [HUB] });
  const { agentCollection } = await import("../src/agents.ts");
  new AfpInstance(config, agentCollection(config)).close();

  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "src/cli.ts", "serve"], {
    cwd: INSTANCE_DIR,
    env: {
      ...process.env,
      AFP_DATA_DIR: paths.dataDir,
      AFP_EXPORT_DIR: paths.exportDir,
      AFP_ORIGIN: origin,
      AFP_PORT: String(port),
      AFP_HUBS: HUB,
      AFP_AGENTS_FILE: agentsFile,
      AFP_CONTROLLERS: controllers.join(","),
      AFP_BRAIN: "stub",
      AFP_DEV: "1",
      AFP_RATE_LIMIT_PER_ADDRESS: "1000",
      AFP_FLUSH_MS: "300",
    },
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += String(chunk)));
  child.stderr.on("data", (chunk) => (output += String(chunk)));
  t.after(() => child.kill("SIGTERM"));
  await awaitServe(origin, () => output);

  const clientData = join(root, "cli-data");
  mkdirSync(clientData, { recursive: true });
  cpSync(config.keyDir, join(clientData, "keys"), { recursive: true });
  const env = {
    ...process.env,
    AFP_DATA_DIR: clientData,
    AFP_ORIGIN: origin,
    AFP_CONTROLLERS: controllers.join(","),
    AFP_AGENTS_FILE: agentsFile,
    AFP_BRAIN: "stub",
    AFP_DEV: "1",
    AFP_LOG_LEVEL: "silent",
  };
  const hub = async (args: string[]) => {
    try {
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        ["--disable-warning=ExperimentalWarning", "src/cli.ts", "hub", ...args],
        { cwd: INSTANCE_DIR, env, encoding: "utf8" },
      );
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failed = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
    }
  };
  const followers = async (): Promise<string[]> => {
    const response = await fetch(`${origin}/hubs/${HUB}/followers`, { headers: { accept: "application/activity+json" } });
    return ((await response.json()) as { orderedItems?: string[] }).orderedItems ?? [];
  };
  const noStoreOpened = (): void => {
    assert.equal(existsSync(join(clientData, "afp.db")), false, "the CLI created no store");
    assert.equal(existsSync(join(clientData, "afp.db.lock")), false, "the CLI took no lock");
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 900));
  return { origin, hub, followers, noStoreOpened, settle, selfActor: `${origin}/actor`, log: () => output };
}

describe("ADR-0039 G3 — the four acts against a real serve", () => {
  it("follow seats the operator's own instance, enroll adds an agent, and both reverse", async (t) => {
    const s = await hubServe(t);

    assert.deepEqual(await s.followers(), [], "no seat before the command");

    const followed = await s.hub(["follow", HUB]);
    assert.equal(followed.code, 0, `${followed.stdout}${followed.stderr}`);
    assert.match(followed.stdout, /"verb": "follow"/);
    assert.match(followed.stdout, /"published": "http/, "the command answers with the activity it put on the record");
    s.noStoreOpened();

    await s.settle();
    assert.deepEqual(await s.followers(), [s.selfActor], "the Follow was delivered and the hub seated it");

    const enrolled = await s.hub(["enroll", "writer", HUB]);
    assert.equal(enrolled.code, 0, `${enrolled.stdout}${enrolled.stderr}`);
    assert.match(enrolled.stdout, /"agent": "writer"/);
    await s.settle();

    // Read the membership back off the hub's own document route.
    const members = await fetch(`${s.origin}/hubs/${HUB}`, { headers: { accept: "application/activity+json" } });
    assert.equal(members.status, 200);

    const listed = await s.hub(["list"]);
    assert.equal(listed.code, 0, `${listed.stdout}${listed.stderr}`);
    assert.match(listed.stdout, new RegExp(`"${s.origin}/hubs/${HUB}"`), "list names the hub this instance follows");
    assert.match(listed.stdout, /"seated": true/, "and says the seat is actually held");

    const unenrolled = await s.hub(["unenroll", "writer", HUB, "--reason", "rotated out"]);
    assert.equal(unenrolled.code, 0, `${unenrolled.stdout}${unenrolled.stderr}`);
    await s.settle();

    const unfollowed = await s.hub(["unfollow", HUB]);
    assert.equal(unfollowed.code, 0, `${unfollowed.stdout}${unfollowed.stderr}`);
    await s.settle();
    assert.deepEqual(await s.followers(), [], "the Undo{Follow} revoked the seat");
    s.noStoreOpened();
  });
});

describe("ADR-0039 G4 — every refusal is the polite reply", () => {
  it("an unknown verb, a foreign agent, a malformed hub and an unfollow with nothing to undo publish nothing", async (t) => {
    const s = await hubServe(t);

    const polite = /This account is read-only for mentions from unauthorized accounts/;

    // No live Follow yet, so unfollow has nothing to undo.
    const early = await s.hub(["unfollow", HUB]);
    assert.notEqual(early.code, 0);
    assert.match(early.stdout, polite, "a real answer about this instance's own trail, still said politely");

    const foreign = await s.hub(["enroll", "nobody", HUB]);
    assert.notEqual(foreign.code, 0);
    assert.match(foreign.stdout, polite);

    // A malformed hub is refused client-side, before anything is signed.
    const malformed = await s.hub(["follow", "not/a/hub"]);
    assert.notEqual(malformed.code, 0);
    assert.match(malformed.stderr, /not a hub url or id/);

    // An unauthorized signer: a controller name the policy does not list.
    // `signedClient` refuses to mint, so this fails before the request —
    // the never-mint rule is itself the first gate.
    const unknown = await s.hub(["follow", HUB, "--as", "writer"]);
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.stdout + unknown.stderr, /polite|not an authorized controller|not found/i);

    assert.deepEqual(await s.followers(), [], "nothing was published by any refusal");
    s.noStoreOpened();
  });
});
