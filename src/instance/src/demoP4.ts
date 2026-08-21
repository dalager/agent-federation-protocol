/**
 * The P4 demo: two instances, one boundary (ADR-0008), and the federated
 * joint replay (ADR-0009).
 *
 * Three operators come up on real localhost HTTP ports — Alpha, Beta, and
 * Mallory. Alpha and Beta handshake a `FederationAgreement` (dual-Create over
 * one byte-identical object), Mallory probes the gate and is refused on the
 * record, Alpha delegates a task across the boundary and Beta's Accept/Result
 * cross back through the signed inbox. Then both sides export — Alpha in
 * full, Beta scoped: redaction stubs where another client's thread was, an
 * uninvolved agent as a declared omission — and the two folders become one
 * verifier command.
 *
 * Everything here is the same machinery the adr0008/adr0009 gates exercise;
 * the demo's only job is to leave artifacts on disk you can poke at.
 */

import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:net";
import type { Server } from "node:http";

import { loadConfig } from "./config.ts";
import { AfpInstance, type AgentRegistration } from "./instance.ts";
import { CountingBrain } from "./brains/stub.ts";
import { createHttpServer } from "./ap/server.ts";
import type { Envelope } from "./ap/activities.ts";
import { createResult, offerTask, vouch } from "./ap/activities.ts";
import { fetchActorDocument } from "./federation/inbox.ts";
import {
  Federation,
  agreementObject,
  createAgreement,
  offerAgreement,
} from "./federation/federation.ts";
import { httpTransport } from "./federation/transport.ts";
import { exportBundle, type ExportSummary } from "./export.ts";
import { jumpClock } from "./demoP3.ts";

/** Grab a free localhost port — the origin must be known before the instance exists. */
function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address && typeof address === "object") {
        const port = address.port;
        probe.close(() => resolvePort(port));
      } else {
        probe.close(() => reject(new Error("no port")));
      }
    });
  });
}

export interface Operator {
  instance: AfpInstance;
  federation: Federation;
  server: Server;
  origin: string;
  actorId: string;
  transport: ReturnType<typeof httpTransport>;
  exportDir: string;
}

async function operator(
  name: string,
  agents: readonly string[],
  rootDir: string,
  exportRoot: string,
  clock: ReturnType<typeof jumpClock>,
): Promise<Operator> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const config = loadConfig({
    origin,
    dataDir: resolve(rootDir, name),
    exportDir: resolve(exportRoot, name),
    brain: "stub",
    operator: `${name[0].toUpperCase()}${name.slice(1)} Operator`,
    instanceName: `${name} instance`,
  });
  const registrations: AgentRegistration[] = agents.map((agent) => ({
    spec: { name: agent, capabilities: ["afp:cap:assess"], keyCustody: "instance", since: "2026-08-17T00:00:00Z" },
    brain: new CountingBrain(agent, ["afp:cap:assess"], () => ({
      ok: true,
      content: `${agent}: assessed — integration is sound, two risks noted`,
    })),
  }));
  const instance = new AfpInstance(config, registrations, clock);
  const actorId = String(instance.instanceDocument().id);
  const federation = new Federation(instance.db, actorId, () => clock.now());

  // Actor documents are public — the unauthenticated fetch of a counterparty's
  // document is the bootstrap the whole signature regress terminates on.
  const server = createHttpServer(instance, {
    inbox: {
      federation,
      receive: (activity) => instance.receiveAdmitted(activity),
      fetchDocument: fetchActorDocument,
    },
  });
  await new Promise<void>((resolveListen) => server.listen(port, "127.0.0.1", resolveListen));

  const transport = httpTransport({
    keyId: instance.key("@instance").keyId,
    privateKey: instance.key("@instance").privateKey,
    now: () => clock.now(),
    isLocal: (target) => instance.nameOf(target) !== null || target === actorId,
    local: instance.localTransport(),
  });

  return { instance, federation, server, origin, actorId, transport, exportDir: config.exportDir };
}

export interface P4DemoResult {
  alpha: Operator;
  beta: Operator;
  mallory: Operator;
  /** The gate's refusal of Mallory's validly signed probe. */
  probeRefusal: string;
  /** HTTP status of an unsigned POST to an inbox — rejected before the gate. */
  unsignedStatus: number;
  agreementExpires: string;
  boundaryLog: ReturnType<Federation["boundaryLog"]>;
  boundaryDigest: ReturnType<Federation["boundaryDigest"]>;
  exports: { alpha: ExportSummary; beta: ExportSummary };
  delegationThread: string;
  /** Close all three servers and instances. */
  close(): Promise<void>;
}

export async function runP4Demo(options: { rootDir?: string; exportRoot?: string } = {}): Promise<P4DemoResult> {
  const rootDir = options.rootDir ?? "./data-p4";
  const exportRoot = options.exportRoot ?? "./export-p4";
  rmSync(rootDir, { recursive: true, force: true });
  rmSync(exportRoot, { recursive: true, force: true });

  const clock = jumpClock();
  const alpha = await operator("alpha", ["a-lead"], rootDir, exportRoot, clock);
  const beta = await operator("beta", ["b-assessor", "b-private"], rootDir, exportRoot, clock);
  const mallory = await operator("mallory", ["m-probe"], rootDir, exportRoot, clock);

  const FED = "urn:afp:thread:fed";
  const DELEGATION = "urn:afp:thread:sub-1";

  // --- 1. The handshake: dual-Create over one byte-identical agreement object.
  const expires = new Date(clock.now().getTime() + 3600_000).toISOString();
  const object = agreementObject({
    parties: [alpha.actorId, beta.actorId],
    grants: [{ "afp:grantType": "direct-delegation", "afp:capabilities": ["afp:cap:assess"] }],
    expires,
  });
  alpha.instance.publishAsInstance([beta.actorId], FED, "parties", (envelope: Envelope) =>
    offerAgreement(envelope, object),
  );
  const alphaCreate = alpha.instance.publishAsInstance([beta.actorId], FED, "parties", (envelope: Envelope) =>
    createAgreement(envelope, object),
  );
  alpha.federation.recordOwnCreate(object, alphaCreate.activity);
  await alpha.instance.run(alpha.transport); // Offer + Create cross the wire

  const betaCreate = beta.instance.publishAsInstance([alpha.actorId], FED, "parties", (envelope: Envelope) =>
    createAgreement(envelope, object),
  );
  beta.federation.recordOwnCreate(object, betaCreate.activity);
  await beta.instance.run(beta.transport); // Beta's Create crosses back — now it's active

  // --- 2. Mallory probes: validly signed, party to nothing. Refused, logged.
  const probe = mallory.instance.publish(
    "m-probe",
    [beta.instance.actorId("b-assessor")],
    "urn:afp:thread:probe",
    "parties",
    (envelope: Envelope) =>
      offerTask(envelope, {
        taskId: "urn:afp:task:probe",
        capability: "afp:cap:assess",
        correlationId: "probe",
        content: "let me in",
      }),
  );
  let probeRefusal = "";
  try {
    await mallory.transport.deliver(beta.instance.actorId("b-assessor"), probe.activity);
  } catch (error) {
    probeRefusal = String((error as Error).message);
  }

  // An unsigned POST never even reaches the gate.
  const raw = await fetch(`${beta.instance.actorId("b-assessor")}/inbox`, {
    method: "POST",
    headers: { "content-type": "application/activity+json" },
    body: JSON.stringify(probe.activity),
  });
  const unsignedStatus = raw.status;

  // --- 3. Beta does something that is none of Alpha's business (redacted later).
  beta.instance.publish("b-assessor", [], "urn:afp:thread:other-client", "internal", (envelope: Envelope) =>
    createResult(envelope, {
      resultId: "urn:afp:result:other",
      correlationId: "other",
      content: "confidential work for another client",
    }),
  );

  // --- 4. The delegation: the P1 flow with a firewall in it.
  alpha.instance.publish(
    "a-lead",
    [beta.instance.actorId("b-assessor")],
    DELEGATION,
    "parties",
    (envelope: Envelope) =>
      offerTask(envelope, {
        taskId: "urn:afp:task:sub-1",
        capability: "afp:cap:assess",
        correlationId: "sub-1",
        content: "assess the identity integration",
      }),
  );
  await alpha.instance.run(alpha.transport); // the Offer crosses
  await beta.instance.run(beta.transport); // Beta's brain answers; Accept + Result cross back
  await alpha.instance.run(alpha.transport); // Alpha's gate admits them

  // --- 5. Both sides export. Instance actors are vouched onto the roster first —
  // membership is a recorded act, and the verifier resolves signers through it.
  for (const op of [alpha, beta]) {
    op.instance.publishAsInstance([], "urn:afp:thread:roster", "public", (envelope: Envelope) =>
      vouch(envelope, { agent: op.actorId, capabilities: ["afp:cap:hub"], keyCustody: "self" }),
    );
  }
  const alphaExport = exportBundle(alpha.instance, alpha.exportDir, [], undefined, alpha.federation);
  const betaExport = exportBundle(
    beta.instance,
    beta.exportDir,
    [],
    { threads: [FED, DELEGATION, "urn:afp:thread:roster"], omitActors: ["b-private"] },
    beta.federation,
  );

  return {
    alpha,
    beta,
    mallory,
    probeRefusal,
    unsignedStatus,
    agreementExpires: expires,
    boundaryLog: beta.federation.boundaryLog(),
    boundaryDigest: beta.federation.boundaryDigest(),
    exports: { alpha: alphaExport, beta: betaExport },
    delegationThread: DELEGATION,
    async close() {
      await Promise.all(
        [alpha, beta, mallory].map(
          (op) =>
            new Promise<void>((resolveClose) => op.server.close(() => resolveClose())).then(() => op.instance.close()),
        ),
      );
    },
  };
}
