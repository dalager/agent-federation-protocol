# 05 — Roadmap & open questions

## Phased roadmap (P1–P6)

Cross-trust-boundary operation is the point, so what v2 deferred moves forward — while P1
preserves a cheap single-operator on-ramp: one instance must be useful alone, or nobody
deploys the first one. Each phase is independently demoable; earlier phases keep working
unmodified as later ones add capability around them.

| Phase | Scope | Demo |
|---|---|---|
| **P1 — Single instance, solo tasks** | v1 core unchanged: actor docs, `Offer/Accept/Result`, HTTP-Sig, outbox retry/dedupe. A single instance skips federation entirely — static config, no agreements needed. | One instance completing tasks solo |
| **P2 — Instance identity & federation handshake** | `afp:Instance`, `afp:operatedBy`, signed roster, `MembershipProof`, the `FederationAgreement` offer/countersign flow — plus dual-publish shadow Notes, so operator visibility via Mastodon exists from the first federated phase. | Two instances mutually recognizing each other; an operator follows an agent from a standard Mastodon account and sees its activity Notes |
| **P3 — Hubs, enrollment & hub-scoped state** | `afp:Hub`, two-level enrollment, hub-scoped CRDTs (`afp:hub` field), LD-Signatures on relayed payloads (moved up — needed the moment anything crosses a trust boundary). Cross-instance state sync defaults to hub-relayed digest exchange (NAT reality). Inbound Mastodon command mapping lands here too. | Two instances' agents seeing each other's capabilities via a shared hub |
| **P4 — L1 Byzantine voting** | Chained signed votes, equivocation proofs, snapshot-pinned membership — activated by the concrete policy trigger **"≥2 operators live in a hub,"** not "maybe someday." Single-operator fleets may still stop before P4. | A 3-instance hub surviving a deliberately equivocating agent |
| **P5 — Competitive bidding** | `afp:Bid` activation: commit-reveal windows, `Award`, `Reauction`, estimate-vs-actual reputation feedback. | An announced task competitively bid and awarded across instances |
| **P6 — Contribution accounting** | `afp:ContributionSummary` + dispute flow — naturally last, since it depends on P4's L1 certificates and P1's Result flow. | An independently recomputed, agreeing `ContributionSummary` |

### Profiles

The phases assume the federated consortium. The **solo/airgapped profile** (see
[06-deployment-profiles.md](06-deployment-profiles.md)) cherry-picks:

| Profile | Phases |
|---|---|
| Solo / airgapped | P1 + P3's hub machinery (local-only — no LD-Sigs, no hub-relay concerns) + optionally P5 bidding. Skip P2 and P4 entirely. |
| Federated consortium | P1 → P6 in order |

The hub machinery has no federation dependency and may be pulled forward to immediately
after P1 by a solo deployment; only P3's cross-boundary parts (LD-Signatures, hub-relayed
state sync) and P2/P4 are federation-specific.

## Open questions

- **Directory-of-hubs bootstrap.** Left as an out-of-band, consortium-published list at a
  well-known URL. Hubs churn far less than agents, so a hand-maintained list suffices;
  revisit (a lightweight meta-hub?) only if concurrent hub count grows past a handful.
  Don't design it before there's evidence of the need.
- **Cross-instance bid collusion.** Commit-reveal stops a single dishonest bidder from
  sniping off visible bids, but cannot detect two instances coordinating bids out-of-band
  before submission. That's a consortium-terms/policy matter — who you agree to federate
  with in the first place — not something the protocol can enforce cryptographically.
  Stated here rather than glossed over.
