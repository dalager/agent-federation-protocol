# ADR-0027 — The port is a security boundary: what a brain is told, and what it may be told by

- **Status:** Accepted (2026-09-02), **built** (2026-09-10) — program claim **C3** of
  [ADR-0024](0024-the-road-to-production.md); group: **Security**
- **Date:** 2026-09-02
- **Applies to:** every agent–instance port (01 § ports & adapters): the brain port
  (`src/instance/src/brains/port.ts`), the federation boundary's ingestion
  (`federation/ingest.ts`), and the port agents [ADR-0028](0028-port-agents.md) adds
- **Builds on:** [ADR-0008](0008-p4-federation-stack.md) Decision 5 (both ingestion
  duties sited at the receiving port — built for cross-boundary Results only),
  [ADR-0006](0006-checkable-actuation.md) and [ADR-0010](0010-pinning-without-an-auction.md)
  (the pinned action policy bounds what an answer can cause), 03 § External systems
  (finding 19: third-party content enters as a hash-addressed artifact; the task text
  agents act on is the port's own bounded summary), 04 § Rationale externalization
  (`afp:producedBy`)
- **Driven by:** the review: `brains/openai.ts` concatenates the task content and the
  decoded bytes of every attachment into the user prompt verbatim; scenario 06's
  "reporter-authored text never becomes an instruction" and scenario 09's "applicant
  free text cannot steer the agents" are closed by spec prose that no code enforces

## Context

The spec has said the right thing since v3.14: a bug report is arbitrary text from whoever
could file it, and a port that splices it into a Task's `content` has handed a stranger
the prompt. It assigned the duty to the port. Two things then happened. The federation
boundary got its ingestion step — `ingest.ts` caps size, sniffs magic bytes against the
declared type, and refuses a lie — which is the *bytes* half of the duty. And the brain
port got no counterpart for the *words* half: the reference brain reads
`request.content` and every attachment's decoded bytes into one string and sends it to
the model.

This ADR does not claim to solve prompt injection. No port can; a model that reads text
can be steered by text. What a port *can* guarantee is three narrower things, and the
record can carry all three: what the brain was told was authored by whom; hostile
material reached it framed as data, in a fixed template the record names; and whatever
the brain concluded, the actions it could cause were bounded before it spoke. The third
already holds (ADR-0006). This ADR builds the first two and extends the bytes half to
every port.

## Decisions

### 1. Ingestion runs at every port, not only the federation boundary

`ingest.ts`'s duties — size cap, declared-type-versus-bytes check, refusal on
contradiction — apply to every artifact entering the instance: a local Task's
attachment, an external initiator's payload ([ADR-0028](0028-port-agents.md)), a
counterparty's Result. One implementation; the boundary stops being the only careful
door.

### 2. A brain receives a bounded task, and bytes only by declared need

`TaskRequest` gains `provenance` per input: `{ source: "delegator" | "counterparty" |
"external", author, digest }`. Attachments are delivered as **references** — digest,
declared type, size, and a bounded excerpt (first N KB of text types; nothing for binary)
— unless the agent's capability declaration says it consumes bytes
(`afp:consumes: ["image/png"]` on the actor document), in which case bytes of *that*
type are delivered and everything else stays a reference. `brains/openai.ts` stops
decoding attachments into the prompt.

### 3. Third-party text is quarantined, and the framing is on the record

Content whose provenance is `external` or `counterparty` is delivered to the brain inside
a delimited data block under a fixed preamble that states its origin and that it is data.
The prompt template that does the framing is versioned; its digest is appended to
`afp:producedBy` (`<model> @ <endpoint> ; template sha256:…`), so an auditor asking "what
was this brain told" can fetch the template and see the framing, not only the model.
Scenario 09's regulator gets the answer 04 promised.

### 4. A brain emits outcomes, never activities

Restated as a checked invariant: `Brain.handle` returns a `TaskOutcome`; the adapter
builds every activity. A brain's text cannot name an `afp:action`, a recipient, or a
visibility class. The action an outcome causes is `policy[category]` under the pins
(ADR-0006/0010), unchanged — that bound is what makes the injection ceiling low even
when the framing fails.

### 5. Reference brains run isolated

The `llm` brain's only network is the configured endpoint, checked against an allow-list
at startup; the `stub` brain has none. Brains have no filesystem access beyond the
artifact store, read-only. This is stated as the adapter's contract so a deployment that
writes its own brain knows what the reference one guarantees.

### 6. The guarantee is stated, and its limit is stated beside it

01 § ports & adapters gains a paragraph: what the port guarantees (provenance, framing,
bounded consequence), and what it cannot (a model's judgement under hostile text). The
scenario-06 and scenario-09 criteria that today read as closed by prose are re-walked
under [ADR-0030](0030-scenario-re-walks-and-the-coverage-index.md) against this text and
the gate below, and marked "narrowed to provenance and framing" if that is what holds.

## Options considered

| Option | Rejected because |
|---|---|
| A prompt-injection classifier at the port | A second model judging the first is a second attack surface and a false sense of coverage; the record can carry provenance and framing, not a verdict on intent |
| Never give brains bytes | Image classification is the spec's running example capability; declared consumption keeps the default safe and the exception explicit |
| Leave framing to each deployment's brain | Then `afp:producedBy` names a model and nothing else, and the regulator question in scenario 09 stays unanswerable from the record |

## Consequences

**Positive** — the record says what each brain was told and by whom; the default path
hands a model references, not bytes; the bytes half of the ingestion duty applies
everywhere.

**Negative** — brains that today rely on full attachment text need a capability
declaration or a summariser; the P1 demo's reviewer reads a source document and will
need `afp:consumes: ["text/markdown"]` or the excerpt bound raised.

**Accepted** — a scenario can still be steered by a sufficiently clever document. The
claim is provenance, framing and bounded consequence; nothing here should be read as
more.

## Implementation architecture

### W1. Files

| Package | Touches | Content |
|---|---|---|
| **WP-1 · ingest everywhere** | `federation/ingest.ts`, `instance.ts` (local attachment path), ADR-0028's initiator | Decision 1 |
| **WP-2 · bounded request** | `brains/port.ts`, `brains/openai.ts`, `brains/stub.ts`, `ap/documents.ts` (`afp:consumes`), `docs/ns/v3.jsonld` | Decisions 2, 4 |
| **WP-3 · framing** | `brains/prompt.ts` (new; the versioned template), `ap/activities.ts` (`afp:producedBy` shape) | Decision 3 |
| **WP-4 · isolation** | `config.ts` (endpoint allow-list), `brains/openai.ts` | Decision 5 |
| **WP-5 · gate + spec** | `test/adr0027.test.ts`, 01 § ports, 03 § External systems, 04 § Rationale externalization | Decision 6, W2 |

### W2. Gate matrix — `test/adr0027.test.ts`

| # | Case | Asserts |
|---|---|---|
| G1 | A local Task with an attachment whose bytes contradict its declared type | refused at the port, before any brain runs |
| G2 | An `external`-provenance attachment containing instruction-shaped text, stub brain | the outcome and the action are the same as with benign text; the record shows the quarantine framing and the template digest |
| G3 | The same, `llm` brain, recorded run | the prompt sent contains the framing block; `afp:producedBy` names the template digest |
| G4 | An agent without `afp:consumes` receives a PNG attachment | the brain sees a reference and an empty excerpt; no bytes |
| G5 | An agent with `afp:consumes: ["image/png"]` | receives the bytes for PNG and references for the rest |
| G6 | A brain outcome that "names" an action in its text | the action taken is `policy[category]`, not the text's |
| G7 | The `llm` brain with an endpoint outside the allow-list | refused at startup |
| G8 | Every shipped bundle replayed | unchanged |

## Build status

**Built (2026-09-10).** All five work packages, and the gate matrix passes G1–G8
(`test/adr0027.test.ts`, 9 cases — G8 plus one for the excerpt bound and the
`afp:producedBy` shape). The full gate is 294 checks green, every offline demo runs, and
the P1 export still verifies against the independent Python verifier.

Three notes on what was built versus what the ADR wrote:

- **Decision 1 is sited at `Artifacts.put`,** not spread across each port's own call site.
  Every artifact — a local Task's attachment, a brain's output, a counterparty's Result —
  comes through that one door, so the ingestion duty is enforced once and a refusal raises
  `IngestionRefused` rather than returning a verdict a caller can ignore. `ingest.ts`
  keeps the checking logic; the store calls it.
- **Provenance for an attachment is derived, not declared by the sender.** Evidence that
  entered from outside AFP carries `sourceUrl` in the artifact index (07), and that is what
  marks it `external` — whoever relayed it. An actor on this instance is the `delegator`;
  anyone else is a `counterparty`. `external` therefore already works without ADR-0028's
  port agents.
- **G2 is narrower than the ADR's wording.** A stub brain sends no prompt anywhere, so
  there is no template digest on its record; the test asserts behavioural equivalence
  under hostile versus benign text, the external provenance, and that rendering the
  request quarantines the stranger's words. The digest-on-the-record claim binds in G3,
  where a brain actually prompts. The test says so in place.

The scenario-06 and scenario-09 re-walks (Decision 6, second half) remain for
[ADR-0030](0030-scenario-re-walks-and-the-coverage-index.md).

## References

- 01 § The agent–instance boundary; 03 § External systems: keep the firehose behind the port
- [ADR-0008](0008-p4-federation-stack.md) Decision 5; `src/instance/src/federation/ingest.ts`
- Scenario 06 finding 19; scenario 09 § "Applicant free text cannot steer the agents"
- [ADR-0006](0006-checkable-actuation.md), [ADR-0010](0010-pinning-without-an-auction.md)
