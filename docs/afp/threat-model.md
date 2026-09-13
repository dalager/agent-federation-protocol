# Threat model

ADR-0034 Decision 5. What the Agent Federation Protocol defends against, and what it
does not — collected once, so a security report can be told apart from a known limit
already stated somewhere in 03, 04, or an ADR. Nothing here is new; every claim and
every limit already exists in the document it is quoted from. This page is the index.

## Assets

- **The record** — the append-only, hash-chained, signed activity log each agent's
  instance keeps and exports. Its integrity is the entire product of P1
  ([ADR-0001](adr/0001-p1-stack.md)): "replay passes" is what the verifier attests to.
- **Keys** — the Ed25519 keypairs behind every actor and instance, custodied behind the
  signer port ([ADR-0026](adr/0026-key-custody-and-the-signer-port.md)) and rotated by
  runbook.
- **The store** — the SQLite-backed queue and hub replica a resident process holds
  ([ADR-0031](adr/0031-the-resident-process.md)); single-writer, not concurrent-safe
  across processes.
- **The ports** — the boundary every external byte crosses before it reaches a brain or
  leaves as a signed activity: the federation inbox, the webhook door
  ([ADR-0028](adr/0028-port-agents.md)), and the command surface
  ([ADR-0029](adr/0029-the-human-window-and-the-activitypub-premise.md)).
- **The human window** — the ActivityPub-projected surface a human uses to watch, approve
  and command, and the trust a human places in what it shows them.

## Adversaries

Scenario 16, ["The hostile edge"](scenarios/16-the-hostile-edge.md), walked five
adversary shapes against a built instance and is the cast this threat model reuses
rather than inventing a sixth vocabulary:

| Adversary | Shape | What it holds |
|---|---|---|
| **Mallory-the-stranger** | Never had an agreement with anyone | Valid keys, published; zero standing |
| **Judas** | A counterparty whose agreement is live, turning hostile mid-relationship | A real, current `afp:FederationAgreement`; a key document it controls |
| **The poisoned attachment** | Not an actor — a payload | Bytes that lie about their type, instruction-shaped text, or an undeclared media type |
| **The forger** | A validly keyed party asserting authority it was never granted | A real, working keypair; a signature that verifies; no grant naming it |
| **The flood** | Volume, not cunning | Nothing but a network connection and patience |

## Defended

| Claim | Mechanism | Gate |
|---|---|---|
| An unsigned or unagreed stranger is refused before any brain runs | Inbox parse, two-tier agreement-before-signature gate | `test/adr0008.test.ts`, `test/adr0025.test.ts` G1b/G3 |
| A counterparty's key substitution mid-relationship does not inherit the agreement's standing | `keyId` ↔ controller check | `test/adr0025.test.ts` G6 |
| A replayed signed request is refused inside the freshness window | Nonce/replay cache | `test/adr0025.test.ts` G9 |
| A flood is bounded per address, with a machine-readable backoff | Token bucket, `Retry-After` | `test/adr0025.test.ts` G8 |
| An oversized single request is refused without buffering the hostile payload whole | Streamed size cap | `test/adr0025.test.ts` G5, G7 |
| Bytes that lie about their type never reach a brain | Content-type sniffing at the port | `test/adr0027.test.ts` G1 |
| Instruction-shaped text cannot change the outcome or the action taken | Quarantined excerpt, pinned action | `test/adr0027.test.ts` G2, G6 |
| An undeclared media type never reaches an agent as bytes | `afp:consumes`-gated excerpting | `test/adr0027.test.ts` G4 |
| A signature that verifies is not treated as authority it was never granted | Roster / `afp:operatedBy` authority check | `test/gate.test.ts` (tail re-sign), `test/adr0005.test.ts` (cross-operator `Enroll` refusal) |
| An anonymous or unauthorized command changes nothing and gets a fixed reply | `ports/command.ts` polite reply | `test/adr0029.test.ts` G3(d) |
| Third-party content entering the record carries its own declared type and provenance, never spliced raw into a brain's prompt | Hash-addressed artifacts, port-produced bounded summaries | `test/adr0027.test.ts`, 03 § External systems |
| A forged authority claim over a federation boundary is refused | Co-signed `afp:FederationAgreement` check, checked against the grant that admits it | `test/federation.py` checks (`afp_verify`), `test/adr0008.test.ts` |

## Not defended / known limits

These are stated once, in the source below, and repeated here **word for word** so a
reporter can match a finding against a known limit before filing it.

1. **Prompt injection is not solved.**

   > This ADR does not claim to solve prompt injection. No port can; a model that reads
   > text can be steered by text.
   — [ADR-0027 § (introduction)](adr/0027-the-port-is-a-security-boundary.md)

   Why this is a limit, not a gap: a port can bound what reaches a brain and what a
   brain's conclusions can *cause* (ADR-0006's pinned-action rule); it cannot bound what
   words can make a model *want* to argue for. See Finding 91 below for the sharper edge
   of this same limit.

2. **The bound the port gives is a size, not a verdict.**

   > The claim stays exactly this size: provenance, framing, and the bounded consequence
   — [03 § External systems: keep the firehose behind the port](03-coordination.md#external-systems-keep-the-firehose-behind-the-port)

   Why this is a limit, not a gap: the port labels who wrote what and bounds what acting
   on it can cause; it never claims to judge whether a document was trying to steer
   anyone. That judgment is out of scope by design (see limit 1).

3. **Verifiable rejection is impossible in the negative.**

   > Verifiable rejection is impossible in the negative.
   — [ADR-0008 Decision 3](adr/0008-p4-federation-stack.md)

   Why this is a limit, not a gap: a boundary stranger appears in no roster, no
   agreement, no announce — there is no commitment point an export could ever point at
   to prove a probe was *not* logged. The duty ADR-0008 states is therefore local (a
   hash-chained, instance-signed boundary log of what one instance itself rejected),
   never a record that proves the absence of unlogged attempts elsewhere.

4. **Read refusals are not logged.**

   > And read refusals are not logged — which is where an implementer will most
   > reasonably go wrong.
   — [ADR-0013 Decision 5](adr/0013-authorized-fetch.md)

   Why this is a limit, not a gap: logging a read refusal would hand any stranger a pen
   that writes into the operator's own record — a denial of service against the log
   itself, and a permanent transcript of what strangers guessed. The tradeoff is
   deliberate. Scenario 16 (Finding 94, below) notes that the built stack applies this
   silence to *every* refusal, not only reads, though ADR-0013's own reasoning was
   scoped to the read gate's confirmation-leakage risk specifically.

5. **A task done by another operator's agent ran in an environment this protocol does
   not control.**

   > **Sandboxing untrusted results** — a task done by another operator's agent ran
   > attacker-controllable instructions in *their* environment; sandbox the *result*:
   > checksum verification, content-type sniffing, size limits, isolated execution of
   > anything fetched, before trusting a `Result.attachment`.
   — [04 § Security & trust](04-operations.md#security--trust)

   Why this is a limit, not a gap: AFP sandboxes the *result* a foreign agent hands
   back, because it has no authority over what that agent's own environment did to
   produce it. The record can bound and check the artifact; it cannot vouch for the
   process on the other side of the federation boundary.

6. **A resident process can page.**

   > a resident process can page. That is what production means.
   — [ADR-0031 § Consequences](adr/0031-the-resident-process.md#consequences)

   Why this is a limit, not a gap: running unattended (retries, sweeps, convergence,
   health) is exactly what turns "a demo you run by hand" into "a service that can wake
   someone at 3 a.m." This is an accepted operational cost of production readiness, not
   a defect.

7. **The reference port adapters are fakes.**

   > the fakes are fakes
   — [ADR-0028 § Consequences](adr/0028-port-agents.md#consequences)

   Why this is a limit, not a gap: "a real forge behaves differently under rate limits
   and partial failures; the reference adapters are contracts with proof, not
   products." A deployment's own adapter for a real external system inherits none of
   the reference adapter's behavior for free — only its contract.

### Scenario 16's open findings (as of 2026-09-13)

Six findings the adversarial walkthrough raised and left as accepted narrowings or
candidates, not defended claims:

8. > A refused stranger's attempt is not recorded as a security event.
   — [scenarios/16-the-hostile-edge.md, Finding 90](scenarios/16-the-hostile-edge.md#walkthrough)

9. > Quarantine bounds action, not argument.
   — [scenarios/16-the-hostile-edge.md, Finding 91](scenarios/16-the-hostile-edge.md#walkthrough)

10. > The per-address bucket is proven per-address; the resources beneath it are not
    > proven to survive a flood from one address.
    — [scenarios/16-the-hostile-edge.md, Finding 92](scenarios/16-the-hostile-edge.md#walkthrough)

11. > Refusals across mechanisms are not correlated.
    — [scenarios/16-the-hostile-edge.md, Finding 93](scenarios/16-the-hostile-edge.md#walkthrough)

12. > "Refusals are not logged" is universal in practice and scoped in its stated
    > reasoning.
    — [scenarios/16-the-hostile-edge.md, Finding 94](scenarios/16-the-hostile-edge.md#walkthrough)

13. > A counterparty's key substitution is caught only because ADR-0025 G6 exists — and
    > its gate reasons about the *actor's* controller, not the *agreement's* scope.
    — [scenarios/16-the-hostile-edge.md, Finding 95](scenarios/16-the-hostile-edge.md#walkthrough)

None of these six is a defended claim reclassified as a limit after the fact — they are
the scenario's own accepted narrowings, named here so a reporter who rediscovers one of
them by probing gets pointed at the existing candidate rather than filing it as new.

## Using this document

A report that reproduces a **Defended** row failing is a finding. A report that
restates a **Not defended / known limit** row is not — point the reporter here. A report
that finds something in neither table is new territory: file it, and if it holds up,
this document (and, likely, `SECURITY.md`'s scope list) gets a new row.
