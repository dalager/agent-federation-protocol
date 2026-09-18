/**
 * ADR-0033 Decision 1: the signed `afp:Policy` document — the place an
 * operator states what the protocol correctly leaves to them: the seat
 * policy, the authorized controllers, the default visibility, the retention
 * duty and its anchors, the thread layout, key custody, the brains in use,
 * the governance answers to ADR-0021's open questions, the consortium terms,
 * accepted deviations, and a disclosure contact.
 *
 * Every property is optional in the schema and every one present is a
 * stated obligation (Decision 1) — `/afp/policy` (`ap/server.ts`) serves this
 * document, `export.ts` carries it in every bundle (Decision 2), and
 * `src/verifier/policy.py` (WP-3) checks the record against it.
 *
 * The `PolicySpec` shape and `validatePolicySpec` live in `../policySpec.ts`,
 * a leaf file `config.ts` can import without closing a cycle through
 * `ap/documents.ts` → `crypto/proof.ts` → `crypto/keys.ts` → `config.ts`;
 * this file re-exports them so every other caller reaches both from one
 * place.
 */

import type { JsonValue } from "../crypto/jcs.ts";
import { attachProof, DATA_INTEGRITY_CONTEXT, type SignedDocument } from "../crypto/proof.ts";
import type { Signer } from "../crypto/signer.ts";
import { AS2_CONTEXT, AFP_CONTEXT, AFP_CONTEXTS, instanceActorId } from "./documents.ts";
import { validatePolicySpec, type PolicySpec } from "../policySpec.ts";

export * from "../policySpec.ts";

function jsonOf(spec: PolicySpec): { [key: string]: JsonValue } {
  const wire: { [key: string]: JsonValue } = {};
  if (spec.seatPolicy !== undefined) wire["afp:seatPolicy"] = spec.seatPolicy;
  if (spec.controllers !== undefined) wire["afp:controllers"] = [...spec.controllers];
  if (spec.defaultVisibility !== undefined) wire["afp:defaultVisibility"] = spec.defaultVisibility;
  if (spec.retentionDuty !== undefined) {
    wire["afp:retentionDuty"] = {
      "afp:horizon": spec.retentionDuty.horizon,
      "afp:basis": spec.retentionDuty.basis,
    };
  }
  if (spec.anchors !== undefined) {
    wire["afp:anchors"] = spec.anchors.map((anchor) => ({
      "afp:actor": anchor.actor,
      "afp:head": anchor.head,
      "afp:instant": anchor.instant,
      "afp:anchorRef": anchor.anchorRef,
    }));
  }
  if (spec.threadLayout !== undefined) {
    wire["afp:threadLayout"] = {
      "afp:form": spec.threadLayout.form,
      "afp:note": spec.threadLayout.note,
    };
  }
  if (spec.custody !== undefined) {
    const custody: { [key: string]: JsonValue } = {};
    if (spec.custody.instance !== undefined) custody["afp:instance"] = spec.custody.instance;
    if (spec.custody.agents !== undefined) custody["afp:agents"] = spec.custody.agents;
    if (spec.custody.hub !== undefined) custody["afp:hub"] = spec.custody.hub;
    // ADR-0035 Consequences: the mode alone invites the misreading that a
    // remote-issued key never sits in host memory — publishing its lifetime
    // is what makes the compromise window a number a stranger can check
    // rather than a claim.
    if (spec.custody.keyLifetimeMs !== undefined) custody["afp:keyLifetimeMs"] = spec.custody.keyLifetimeMs;
    wire["afp:custody"] = custody;
  }
  if (spec.brains !== undefined) {
    wire["afp:brains"] = spec.brains.map((brain) => ({
      "afp:model": brain.model,
      ...(brain.endpoint !== undefined ? { "afp:endpoint": brain.endpoint } : {}),
    }));
  }
  if (spec.governance !== undefined) {
    wire["afp:governance"] = {
      "afp:subjectPrecondition": spec.governance.subjectPrecondition,
      "afp:electorateFloor": spec.governance.electorateFloor,
    };
  }
  if (spec.terms !== undefined) {
    wire["afp:terms"] = { "afp:url": spec.terms.url, "afp:digest": spec.terms.digest };
  }
  if (spec.deviations !== undefined) {
    wire["afp:deviations"] = spec.deviations.map((deviation) => ({
      "afp:section": deviation.section,
      "afp:statement": deviation.statement,
    }));
  }
  if (spec.disclosure !== undefined) {
    wire["afp:disclosure"] = { "afp:contact": spec.disclosure.contact };
  }
  return wire;
}

/**
 * The signed `afp:Policy` object at `${origin}/afp/policy` (ADR-0017 Decision
 * 5). `published` is threaded through as the proof's own `created` so the
 * signed bytes are stable for a given instant — the same discipline
 * `signedRoster` uses for `created`.
 */
export function policyDocument(origin: string, spec: PolicySpec, signer: Signer, published: string): SignedDocument {
  const document: { [key: string]: JsonValue } = {
    "@context": AFP_CONTEXTS,
    id: `${origin}/afp/policy`,
    type: "afp:Policy",
    attributedTo: instanceActorId(origin),
    published,
    ...jsonOf(spec),
  };
  return attachProof(document, { signer, created: published });
}

// Re-exported for callers that only need the contexts (documents.ts already
// exports these; kept here too so `ap/policy.ts` is self-sufficient to read).
export { AS2_CONTEXT, AFP_CONTEXT, AFP_CONTEXTS, DATA_INTEGRITY_CONTEXT };
