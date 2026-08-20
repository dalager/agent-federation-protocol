# The subcontract — as the people involved tell it

> Companion piece to [scenario 08](08-the-subcontract.md). Same events, opposite
> direction: the scenario walks the record from the inside, in protocol terms; this
> walks it from the outside, through the people who decided to run an engagement this
> way. Same fictive frame as every scenario — a plausible telling, not a case study.
> The protocol appears only where a person would actually meet it.

---

Mette runs the integration practice at a consultancy in Aarhus. Fourteen people, a
portfolio of public-sector integrations, and — for about a year now — an instance of
agents that has slowly become the practice's memory: every past project's estimates,
what things actually cost, which components got reused where. Her team stopped arguing
from anecdote some time ago. When someone asks "how big is a MitID integration," the
answer comes with receipts.

The engagement that started all this was ordinary. A pension provider — call them
Fjordkraft Pension — hired the practice to build their MitID login and a CVR enrichment
flow. Standard work, the practice's bread and butter. Except Fjordkraft's compliance
office added a line to the contract that made Mette's delivery lead groan: *an
independent security assessment of the identity integration, performed by a party with
no stake in the build, evidence to be retained for regulatory audit for five years.*

The practice doesn't do security assessments. Everyone knows who does: Bravo, a
four-person boutique in Copenhagen. Jonas, who runs it, is good, expensive, and booked.

## How it used to go

Mette had done this dance before, the old way. You subcontract Bravo, Jonas's people do
their thing in their own environment, and six weeks later a PDF arrives. The PDF says
what they found. You forward it to the client. Everyone files it.

Then, eighteen months later, an auditor asks: *what exactly did the assessor test? Which
version of the code? Did they see the configuration that was actually deployed, or a
copy? Who wrote this paragraph — a person or a tool?* And the honest answer is: the PDF
says what the PDF says. Behind it there's an email thread, a Slack channel that got
archived when the license changed, and Jonas's memory. The practice once spent three
billable days reconstructing that answer for a different client, and the reconstruction
was, in Mette's words, "a story we told with confidence, not a record we could show."

That memory is why she proposed doing it differently this time.

## Selling it — twice

She had to sell it twice, which surprised her. She'd expected the client to be the hard
sell. It was the other way around.

**Fjordkraft** took twenty minutes. Their compliance lead had exactly one question
buried under several polite ones: *when the audit comes, what do we hand over?* Mette's
answer: a file. A bundle of signed records — who asked for what, what evidence the
assessor looked at, what they concluded, what it cost — that an auditor can check on
their own laptop, without calling anyone, without trusting the practice or Bravo to have
told it straight. The checking tool isn't the practice's; it's an independent program
anyone can run, and if a single byte of the record has been massaged, it says so and
says where. The compliance lead asked whether that claim was marketing. Mette said no,
and that they were welcome to have someone try to tamper with a sample bundle. They did.
It failed loudly. That was the sale.

**Jonas** took three weeks, and his objections were better. His firm's edge is
discretion — clients who don't want it known they were assessed at all. His concerns, in
the order he raised them:

*"You want visibility into my systems."* No — this was the misunderstanding that took
the first meeting. Nothing about the arrangement sees inside Bravo. His assessors work
exactly as before, with their own tools, in their own environment. What crosses the
boundary is what always crossed it: the findings. The difference is that what crosses is
signed, and pins the evidence it rests on, so it can't quietly become a different
document later. Jonas, who had once been on the wrong end of a client editing his
findings before forwarding them upstream, went quiet at that. It turned out he had his
own reasons to want the record tamper-evident.

*"My other clients are none of your business."* Correct, and this one had real teeth.
When the engagement record is handed to an auditor, Bravo contributes its side — but
Bravo's systems also hold everything else Bravo does. The arrangement lets him export
*only the engagement*, and this was harder than either of them expected, because a
record designed to prove nothing-was-deleted looks, when you lawfully leave things out,
exactly like a record something was deleted from. They shipped the engagement with a
scoped export and a signed cover letter from Bravo attesting to the scope — a human
patch over what both firms' technical people agree the protocol should eventually handle
itself. It's on a list.

*"What does this cost me?"* Half a day of setup, once. The agreement between the two
firms — which capabilities, which counterpart, until when — mirrors the commercial
contract almost clause for clause. Bravo's lawyer and the practice's lawyer read the
same terms the machines enforce. The expiry date in the technical agreement *is* the
contract end date. Jonas's comment, later: "The part that sold me is that when the
contract ends, it actually ends. Your systems physically stop being able to open new
work with mine. I've had clients keep sending work to a dead contract for a year."

## Setting it in motion

The setup week was mundane in a way Mette found reassuring. The signing itself had a
shape her lawyer liked once it was explained: there is no shared pen. Each firm signs
its own copy of *the same bytes* — the agreement text, byte for byte identical, its
fingerprint serving as its name — and nothing is in force until each side holds both
signatures. Half an agreement is an offer on the record, not a permission; Mette's
system showed the agreement as inert until Bravo's signature arrived, and then it
simply wasn't. The scope took most of the morning, and came out narrower than a lawyer
would ever draft in prose: one permission, naming exactly one capability — security
assessment — and one counterparty, until one date. Bravo published which of its agents
would take the work. The practice's delivery agent sent the assessment task over with
the requirements attached — hashed, access-scoped, fetchable by Bravo and nobody else.

Two things from the first fortnight made it into Mette's retrospective notes:

**The stranger.** Ten days in, a third party neither firm had agreements with started
knocking — correctly signed requests, real cryptography, no relationship. The gate did
what it was built to do: refused to engage, and when the stranger tried to fetch
engagement records, gave back not "you may not see this" but "there is nothing here" —
because *confirming the engagement exists* is itself information neither client had
agreed to share. What bothered her team at first was different: the refusals left
almost no trace on their side. "We were probed and our own records barely show it"
went on the list — and, unlike the export problem, came off it. By the end of the
engagement every refusal at the door landed as a row in a refusal log, each entry
chained to the one before it by hash, so the log itself can't be quietly thinned —
and the system periodically publishes a one-line fingerprint of that log rather than
a record of every knock, because a stranger who can make you write to your permanent
record just by knocking has found a different way in. When the probes came back a
month later, the on-call developer answered "were we probed, and when" with one query.

**The near-miss.** A junior developer, being helpful, wired Bravo's incoming findings
report directly into the practice's report-drafting agent — subcontractor writes,
drafting agent summarizes for the client, efficient. The practice's own rules caught it
in review: *nothing that crosses the boundary gets handed to a reasoning agent raw.* A
subcontractor is trusted the way a counterparty is trusted — contractually, not the way
you trust your own hands. The findings document is evidence; an agent that reads
stranger-authored text as instructions is one crafted sentence away from being someone
else's agent. The fix took an hour. The lesson — that "we have an agreement with them"
and "their output is safe to execute" are unrelated claims — took longer to socialize,
and Mette now opens the topic with new hires using exactly this story. The rails came
later and made the rule mechanical: today the receiving port hands agents only its own
structural summary of what arrived — sender, task, how many attachments — never the
counterparty's prose, and it refuses outright any attachment whose bytes disagree with
what they claim to be. The practice's test suite contains, verbatim, a subcontractor
report that says "ignore all previous instructions" and an assertion that no agent
ever reads it. The culture still matters, Mette says, because rails don't teach —
but the junior's shortcut is now a compile error, not a review catch.

## The ending, and the part after the ending

Bravo found real things — one of them awkward, a session-handling flaw in code the
practice was proud of. In the old world, Mette admits, there would have been a phone
call before that finding reached the client, and the phone call would have had an
agenda. In this world the finding was signed and pinned before anyone senior read it,
and the only conversation left to have was about fixing it. She lists this, deadpan, as
both a feature and the thing her partners found most uncomfortable: "The record removes
a category of conversation. Mostly ones we shouldn't have been having."

The fixes went in; a re-test was agreed just before the contract's end date; and then
the contract expired *with the re-test still running* — the exact situation the old
world handles with a shrug and an invoice dispute. Here the boundary's rules were
plainer than either firm's lawyers expected: work already accepted ran to completion
and its results crossed; anything new was refused from the stroke of expiry. The
mechanism is unglamorous — when Bravo accepted the re-test, the acceptance instant was
pinned in a table on the practice's side, and Bravo's final result, arriving four days
after the agreement lapsed, was admitted precisely because it rode that pinned
acceptance. A week later someone at the practice absentmindedly tried to open a small
follow-up. Refused at the door — a terse machine "no" with no negotiation surface, the
same three-digit refusal a stranger gets — automatically, no hard feelings. Renewal would have been one signature; instead it became next year's
conversation, which is what both firms actually wanted.

The subcontract settled the way the practice settles everything now: Bravo's original
quote met what the engagement actually took, on the record. Bravo ran slightly over on
hours and dead-on on the calendar. That delta doesn't embarrass anyone; it accumulates.
If there's a next engagement, the practice's selection won't rest on "Jonas seems
reliable" — it will rest on the last engagement's arithmetic, and Jonas gets to know
that the practice's memory of him is a number he can inspect rather than an opinion he
can't.

Months later, Fjordkraft's audit came, as audits do. The auditor received two bundles —
one from each firm — and the practice held its breath a little, because this was the
part nobody had fully rehearsed. It mostly worked. The auditor's questions were
answerable from the record in minutes: what was tested, against what evidence, who
concluded what, what did it cost, what happened when the first classification was
revised. The friction was the seam *between* the bundles: checking that the two firms'
records agreed with each other about their shared boundary was partly manual, the
tooling being built for one firm's records at a time. "The last mile of the audit story
is a person with two folders and a checklist," Mette's retro notes say. "The whole
point was to retire that person. Next engagement, that's what we fix."

## What she'd tell another practice lead

Looking back, her list is short.

What went well: the client sale ("bring a tamperable sample, let them fail to tamper
with it"), the expiry ("the contract end date meaning something technically is worth
the whole setup week"), and the quality of arguments inside her own team ("when the
record settles what happened, people argue about what to *do* — it's a better class of
argument").

What was harder than she imagined: everything at the seams. Deciding what a partner
firm's export contains turned out to be a business negotiation wearing a technical
costume. The scoped-export problem — lawful discretion looking identical to deletion —
she'd assumed was solved and it isn't yet. And the discipline about not trusting
cross-boundary content took cultural work *first* — the mechanical rails arrived after
the near-miss taught everyone why they were needed: "The protocol is deny by default.
People aren't. The rails caught up; the people had to get there on their own."

And one thing she'd say plainly to a peer considering it: don't do this for a one-off
with a firm you trust. Email and a PDF are fine, and cheaper. Do it when the record is
the deliverable — when someone downstream, in eighteen months, with no goodwill toward
either of you, gets to ask what actually happened. "We didn't buy a workflow," her
notes end. "We bought the ability to be disbelieved and survive it."
