# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository:
<https://github.com/dalager/agent-federation-protocol/security/advisories/new>.
Do not open a public issue for a suspected vulnerability.

If you are reporting against a deployed instance rather than the spec or the
reference code, that instance's own policy document names a contact
(`afp:disclosure`, [ADR-0033](docs/afp/adr/0033-operator-obligations.md)) —
use it when you have one and are unsure whether the operator watches this
repository.

## What to expect

- **Acknowledgement within 5 business days.**
- **A fix, or a stated limit, within 90 days.** Some reports will resolve as
  "this is a known limit, not a finding" — see the threat model below; when
  that is the answer, we say so and point at where the limit is already
  documented, rather than staying silent.
- **Credit if you want it**, in the fix's commit or release notes.

These are commitments this repository makes to a reporter, not a promise of
a particular outcome.

## Scope

In scope:

- The transport ([ADR-0025](docs/afp/adr/0025-transport-hardening.md)) — TLS,
  fetch bounds, request signing, replay and flood protection.
- The ports ([ADR-0027](docs/afp/adr/0027-the-port-is-a-security-boundary.md)) —
  ingestion, content-type sniffing, quarantine, the pinned-action boundary.
- The record's checks — anything `afp_verify.py` or the TypeScript gate is
  supposed to catch and does not: a forged signature that verifies, an
  authority check that can be smuggled past, a chain that replays despite
  being tampered with.
- The human window ([ADR-0029](docs/afp/adr/0029-the-human-window-and-the-activitypub-premise.md)) —
  the command surface, the approval route.
- The policy document ([ADR-0033](docs/afp/adr/0033-operator-obligations.md)) —
  a deployment's published obligations, and whether the software actually
  holds to what it publishes.

Out of scope:

- **A model's judgement under hostile text.** Per
  [ADR-0027](docs/afp/adr/0027-the-port-is-a-security-boundary.md): "This ADR
  does not claim to solve prompt injection. No port can; a model that reads
  text can be steered by text." A report that a brain can be talked into
  saying something is not, by itself, a vulnerability in this sense — a
  report that the *port* failed to bound, frame, or attribute what reached
  the brain is.
- Anything the threat model
  ([docs/afp/threat-model.md](docs/afp/threat-model.md)) lists as a known
  limit rather than a defended claim.

When you are not sure which of these a finding is, the threat model is the
reference: it states, in one place, what this protocol defends against and
what it does not.

## Supported versions

The `0.9.x` line, at spec revision `3.35`, is supported. No release has been
cut yet — see the root [README § Releases](README.md#releases).
