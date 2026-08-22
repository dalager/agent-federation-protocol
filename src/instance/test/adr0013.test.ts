/**
 * ADR-0013 gate: authorized fetch — admission by class.
 *
 * Tested at the gate rather than over HTTP, deliberately. Every decision this
 * ADR makes is a disclosure decision — "may this requester see this activity"
 * — and those are worth asserting directly, one predicate at a time, rather
 * than inferred from what a socket returned. `readGate.ts` takes injected
 * deps precisely so this is possible without a server, a hub, or a key.
 *
 * The signature half is proven in `httpsig.test.ts` (the covered-header
 * discipline, including the POST downgrade); the wiring half — filtering,
 * resolve-then-judge, cache headers — is exercised by the P4 HTTP tests plus
 * the anonymous cases below, which are the compatibility proof that a server
 * with no gate configured behaves exactly as it did.
 *
 *   node --experimental-sqlite --test test/adr0013.test.ts
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import type { JsonValue } from "../src/crypto/jcs.ts";
import { signRequest } from "../src/federation/httpSig.ts";
import { authorizeRead, type ReadGateDeps } from "../src/federation/readGate.ts";
import { cleanupWorkspaces, testInstance } from "./helpers.ts";

after(cleanupWorkspaces);

const ALPHA = "https://alpha.example/actor";
const BRAVO = "https://bravo.example/actor";
const B_AGENT = "https://bravo.example/agents/b1";
const HUB = "https://alpha.example/hubs/engagement";
const NOW = new Date("2026-08-21T10:00:00.000Z");

/** An agreement whose grants admit `HUB` — the shape `admittingGrant` reads. */
const hubAgreement = {
  type: "afp:FederationAgreement",
  "afp:parties": [ALPHA, BRAVO],
  "afp:grants": [{ "afp:grantType": "hub", "afp:hub": HUB }],
} as unknown as { [key: string]: JsonValue };

function deps(over: Partial<ReadGateDeps> = {}): ReadGateDeps {
  return {
    fetchDocument: async () => null,
    isDenylisted: () => false,
    activeAgreementsWith: () => [hubAgreement],
    roleOf: () => "member",
    grants: () => [],
    now: () => NOW,
    ...over,
  };
}

/**
 * A REAL signed GET, resolved through the gate's own identity path.
 *
 * An earlier version of this file injected a requester by assigning the
 * property on the returned authorization. That test passed with the
 * deny-list fix removed — because `admits` closes over the *captured*
 * requester, so the assignment changed nothing and every case was silently
 * re-testing anonymity. A security test that cannot fail is worse than
 * absent, so identity is now established the way production does it: a
 * genuine signature over a genuine key, with the actor document served back
 * through `fetchDocument`.
 */
function signedGate(over: Partial<ReadGateDeps> = {}) {
  const { instance } = testInstance(["b1"], "afp:cap:assess");
  const agentId = instance.actorId("b1");
  const doc = instance.agentDocument("b1");
  const key = instance.key("b1");
  const path = "/agents/w/outbox";
  const headers = signRequest("GET", path, "alpha.example", "", key.keyId, key.privateKey, NOW);

  const d = deps({
    fetchDocument: async (url: string) => (url === agentId ? doc : null),
    ...over,
  });
  return { instance, agentId, path, headers, deps: d };
}

const activity = (visibility: string, extra: { [key: string]: JsonValue } = {}) =>
  ({ "afp:visibility": visibility, ...extra }) as { [key: string]: JsonValue };

describe("ADR-0013 gate: admission by class", () => {
  it("anonymous sees public and nothing else — today's behaviour, unchanged", async () => {
    const auth = await authorizeRead(deps(), { path: "/agents/w/outbox", headers: {} });
    assert.equal(auth.requester, null, "no signature is anonymity, not an error");
    assert.equal(auth.admits(activity("public")), true);
    assert.equal(auth.admits(activity("hub", { "afp:hub": HUB })), false);
    assert.equal(auth.admits(activity("parties", { to: [B_AGENT] })), false);
    assert.equal(auth.admits(activity("internal")), false);
  });

  it("an activity with no declared class is refused, not guessed at", async () => {
    const auth = await authorizeRead(deps(), { path: "/agents/w/outbox", headers: {} });
    assert.equal(auth.admits({} as { [key: string]: JsonValue }), false);
    assert.equal(auth.admits(activity("")), false);
  });

  it("`internal` is refused before the requester is even consulted", async () => {
    // Decision 3 makes this absolute: not to a peer, not to an agreement
    // holder, not under a grant. The ladder checks it above the requester
    // test, so no later branch can reach it.
    const auth = await authorizeRead(deps({ grants: () => [everythingGrant()] }), {
      path: "/agents/w/outbox",
      headers: {},
    });
    assert.equal(auth.admits(activity("internal", { context: "https://alpha.example/threads/t1" })), false);
    assert.equal(auth.viaGrant, undefined, "nothing about internal is recorded as a granted read");
  });
});

/**
 * A grant that names every class it could — used to prove that `internal` and
 * the deny-list are not among the things a grant can reach.
 *
 * Shape matters and cost me a debugging round: `grantAdmits` reads the
 * *activity wrapper* (`grant.object` must be the `afp:AuditGrant`), and
 * `scopeAdmits` keys on plain `hub`/`thread`/`period` rather than `afp:`-
 * prefixed names. A fixture that gets either wrong admits nothing, which
 * makes a security test pass for the most useless possible reason.
 */
function everythingGrant(auditor: string = B_AGENT): { [key: string]: JsonValue } {
  return {
    id: "https://alpha.example/activities/grant-1",
    type: "Create",
    object: {
      type: "afp:AuditGrant",
      "afp:auditor": auditor,
      "afp:visibilityClasses": ["hub", "parties", "internal"],
      "afp:scope": { hub: HUB },
      "afp:expires": "2026-12-31T00:00:00Z",
    },
  } as unknown as { [key: string]: JsonValue };
}

describe("ADR-0013 gate: a grant widens entitlement, and never past a refusal", () => {
  it("a deny-listed operator is refused even holding a live grant", async () => {
    // The ordinary predicate refuses a deny-listed requester and then the
    // grant branch runs — so a deny-list check placed only in the predicate
    // is one the grant path never performs. This case fails if that check is
    // removed from `findAdmittingGrant`; it was written after the gate was
    // built, and the gate did not survive it.
    const probe = signedGate();
    const g = signedGate({
      isDenylisted: () => true,
      grants: () => [everythingGrant(probe.agentId)],
    });
    probe.instance.close();
    const auth = await authorizeRead(g.deps, { path: g.path, headers: g.headers });
    assert.notEqual(auth.requester, null, "the signature must resolve, or this proves nothing");

    assert.equal(auth.admits(activity("hub", { "afp:hub": HUB, context: "https://alpha.example/threads/t1" })), false);
    assert.equal(auth.admits(activity("parties", { to: [g.agentId], context: "https://alpha.example/threads/t1" })), false);
    assert.equal(auth.viaGrant, undefined, "a refused read is never recorded as a granted one");
    g.instance.close();
  });

  it("`parties` admits the agent the activity names, and only what it names", async () => {
    // The positive control for the addressing predicate — without it the
    // refusal cases below could pass because `parties` never admits anyone.
    // Also pins the narrowing recorded in Decision 3: being the *operator of*
    // a named agent is not admission, because the addressing does not say it.
    const g = signedGate();
    const auth = await authorizeRead(g.deps, { path: g.path, headers: g.headers });
    assert.notEqual(auth.requester, null);
    const operator = auth.requester!.operatedBy;

    assert.equal(auth.admits(activity("parties", { to: [g.agentId] })), true, "named directly");
    assert.equal(auth.admits(activity("parties", { cc: [g.agentId] })), true, "cc counts as named");
    assert.equal(
      auth.admits(activity("parties", { to: [operator] })),
      false,
      "addressed to the operator, not to this agent — the agent is not the instance",
    );
    assert.equal(
      auth.admits(activity("parties", { to: ["https://elsewhere.example/agents/x"] })),
      false,
      "somebody else's mail",
    );
    g.instance.close();
  });

  it("the same requester, not deny-listed, is admitted to its hub", async () => {
    // The positive control: without it, the case above could pass for any
    // reason at all — a broken signature, a missing agreement, a typo in the
    // hub id — and still look like the deny-list working.
    const g = signedGate();
    const auth = await authorizeRead(g.deps, { path: g.path, headers: g.headers });
    assert.notEqual(auth.requester, null);
    assert.equal(auth.admits(activity("hub", { "afp:hub": HUB })), true);
    assert.equal(auth.admits(activity("internal", { "afp:hub": HUB })), false);
    g.instance.close();
  });
});
