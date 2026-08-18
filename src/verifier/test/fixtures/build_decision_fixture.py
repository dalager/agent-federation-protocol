#!/usr/bin/env python3
"""Builds a hand-crafted AFP export bundle containing one closed L0 vote.

This is a *test fixture generator*, not part of the verifier: the TypeScript
hub that emits real DecisionRecords is being built in parallel, so this
stands in until then. It reuses the verifier's own JCS canonicalizer (the
same independent Python implementation — no TypeScript involved) purely to
sign fixtures the way the spec says a real writer would.

    python3 build_decision_fixture.py <out-dir>

Produces a clean export where all three ADR-0002 Decision 3 checks pass:
tally recomputation, evidence-set completeness, snapshot discipline.
`mutate_decision_fixture.py` derives the three failing variants from it.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # -> src/verifier

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from jcs import canonical_bytes
from proof import CRYPTOSUITE, B58_ALPHABET, digest_of

INSTANCE = "https://hub.example/instance"
HUB = "https://hub.example/actor"
PROPOSER = "https://hub.example/agents/proposer"
VOTERS = [f"https://hub.example/agents/voter-{c}" for c in "abc"]
OUTSIDER = "https://hub.example/agents/voter-outsider"  # on the roster, never in the round's pinned snapshot
ROUND = "urn:afp:round:1"
THREAD = "urn:afp:thread:round-1"
CREATED = "2026-08-18T00:00:00.000Z"

CONTEXT = [
    "https://www.w3.org/ns/activitystreams",
    "https://afp.example/ns/v3",
    "https://w3id.org/security/data-integrity/v1",
]


def b58encode(data: bytes) -> str:
    leading = len(data) - len(data.lstrip(b"\x00"))
    number = int.from_bytes(data, "big")
    digits = []
    while number:
        number, rem = divmod(number, 58)
        digits.append(B58_ALPHABET[rem])
    return B58_ALPHABET[0] * leading + "".join(reversed(digits))


def make_key() -> tuple[Ed25519PrivateKey, str]:
    private = Ed25519PrivateKey.generate()
    raw = private.public_key().public_bytes_raw()
    return private, "z" + b58encode(b"\xed\x01" + raw)


def sign(document: dict, private: Ed25519PrivateKey, method_id: str) -> dict:
    """Attach an eddsa-jcs-2022 proof, per src/verifier/README.md's algorithm."""
    proof_config = {
        "type": "DataIntegrityProof",
        "cryptosuite": CRYPTOSUITE,
        "created": CREATED,
        "verificationMethod": method_id,
        "proofPurpose": "assertionMethod",
    }
    if "@context" in document:
        proof_config["@context"] = document["@context"]

    signing_input = (
        hashlib.sha256(canonical_bytes(proof_config)).digest()
        + hashlib.sha256(canonical_bytes(document)).digest()
    )
    signature = private.sign(signing_input)
    signed = dict(document)
    signed["proof"] = {k: v for k, v in proof_config.items() if k != "@context"}
    signed["proof"]["proofValue"] = "z" + b58encode(signature)
    return signed


def actor_doc(actor_id: str, method_id: str, multibase: str) -> dict:
    return {
        "@context": CONTEXT,
        "id": actor_id,
        "type": "Service" if actor_id == INSTANCE else "Person",
        "assertionMethod": [
            {"id": method_id, "type": "Multikey", "controller": actor_id, "publicKeyMultibase": multibase}
        ],
    }


class Fixture:
    """Live fixture state: signing keys plus each actor's outbox-in-progress,
    so a mutation script can mint one extra signed vote and persist it the
    same way the clean build did, instead of re-deriving signed bytes."""

    def __init__(self) -> None:
        self.keys: dict[str, Ed25519PrivateKey] = {}
        self.methods: dict[str, str] = {}
        self.outbox_by_actor: dict[str, list[dict]] = {}
        self.vote_hashes: dict[str, str] = {}

    def cast_vote(self, voter: str, value: str) -> str:
        vote = {
            "@context": CONTEXT,
            "id": f"{voter}/activities/vote",
            "type": "Create",
            "actor": voter,
            "to": [HUB],
            "published": CREATED,
            "context": THREAD,
            "afp:visibility": "public",
            "object": {
                "type": "afp:Vote",
                "afp:round": ROUND,
                "afp:quorumSnapshot": "sha256:mem-fixture",
                "value": value,
            },
        }
        vote = sign(vote, self.keys[voter], self.methods[voter])
        self.outbox_by_actor.setdefault(voter, []).append(vote)
        digest = digest_of(vote)
        self.vote_hashes[voter] = digest
        return digest

    def write_outbox(self, out_dir: Path, actor: str) -> None:
        name = actor.rsplit("/", 1)[-1]
        items = self.outbox_by_actor.get(actor, [])
        outbox = {
            "@context": CONTEXT,
            "id": f"{actor}/outbox",
            "type": "OrderedCollection",
            "attributedTo": actor,
            "totalItems": len(items),
            "orderedItems": items,
        }
        (out_dir / "outbox" / f"{name}.jsonld").write_text(json.dumps(outbox, indent=2))


def build(out_dir: Path) -> Fixture:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "actors").mkdir(exist_ok=True)
    (out_dir / "outbox").mkdir(exist_ok=True)
    (out_dir / "artifacts").mkdir(exist_ok=True)

    fx = Fixture()
    participants = [PROPOSER, *VOTERS, OUTSIDER]

    for actor in [INSTANCE, *participants]:
        private, multibase = make_key()
        method_id = f"{actor}#ed25519-key"
        fx.keys[actor] = private
        fx.methods[actor] = method_id
        name = "instance" if actor == INSTANCE else actor.rsplit("/", 1)[-1]
        target = out_dir / "instance.jsonld" if actor == INSTANCE else out_dir / "actors" / f"{name}.jsonld"
        target.write_text(json.dumps(actor_doc(actor, method_id, multibase), indent=2))

    # Roster: self-custody for everyone, so authority checks stay simple.
    # The outsider IS enrolled generally (it has a roster entry and an
    # outbox) but is never named in this round's pinned voterWeights below —
    # exactly "an agent enrolled after round start" from 02's snapshot rule.
    roster_entries = [
        {
            "type": "afp:RosterEntry",
            "agent": agent,
            "status": "active",
            "afp:keyCustody": "self",
            "afp:capabilities": ["afp:cap:vote"],
            "since": CREATED,
        }
        for agent in participants
    ]
    roster = {
        "@context": CONTEXT,
        "id": f"{INSTANCE}/roster",
        "type": "OrderedCollection",
        "totalItems": len(roster_entries),
        "orderedItems": roster_entries,
    }
    (out_dir / "roster.jsonld").write_text(
        json.dumps(sign(roster, fx.keys[INSTANCE], fx.methods[INSTANCE]), indent=2)
    )

    fx.cast_vote(VOTERS[0], "candidate-x")
    fx.cast_vote(VOTERS[1], "candidate-x")
    fx.cast_vote(VOTERS[2], "candidate-y")

    # Explicit per-voter weights, recorded in the proposal per ADR-0002
    # Decision 3 — liveness-gated uniform weight at P2.
    voter_weights = {v: 1.0 for v in VOTERS}
    proposal = {
        "@context": CONTEXT,
        "id": f"{PROPOSER}/proposals/{ROUND.rsplit(':', 1)[-1]}",
        "type": "afp:Proposal",
        "actor": PROPOSER,
        "attributedTo": PROPOSER,
        "to": [HUB],
        "published": CREATED,
        "context": THREAD,
        "afp:visibility": "public",
        "afp:round": ROUND,
        "afp:hub": HUB,
        "afp:quorumSnapshot": "sha256:mem-fixture",
        "afp:voterWeights": voter_weights,
        "afp:candidates": ["candidate-x", "candidate-y"],
    }
    proposal = sign(proposal, fx.keys[PROPOSER], fx.methods[PROPOSER])
    fx.outbox_by_actor.setdefault(PROPOSER, []).append(proposal)

    counted_votes = [fx.vote_hashes[v] for v in VOTERS]
    weight_tally = {"candidate-x": 2.0, "candidate-y": 1.0}
    decision = {
        "@context": CONTEXT,
        "id": f"{HUB}/rounds/{ROUND.rsplit(':', 1)[-1]}/decision",
        "type": "afp:DecisionRecord",
        "actor": PROPOSER,
        "attributedTo": PROPOSER,
        "to": [HUB],
        "published": CREATED,
        "context": THREAD,
        "afp:visibility": "public",
        "afp:hub": HUB,
        "afp:round": ROUND,
        "afp:outcome": "candidate-x",
        "afp:quorumSnapshot": "sha256:mem-fixture",
        "afp:countedVotes": counted_votes,
        "afp:weightTally": weight_tally,
        "afp:prevActivity": digest_of(proposal),
    }
    decision = sign(decision, fx.keys[PROPOSER], fx.methods[PROPOSER])
    fx.outbox_by_actor.setdefault(PROPOSER, []).append(decision)

    for agent in participants:
        fx.write_outbox(out_dir, agent)
    fx.write_outbox(out_dir, INSTANCE)  # instance casts no votes; empty outbox

    (out_dir / "MANIFEST.json").write_text(json.dumps(
        {"cryptosuite": CRYPTOSUITE, "generatedBy": "test/fixtures/build_decision_fixture.py"},
        indent=2,
    ))

    return fx


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: build_decision_fixture.py <out-dir>")
    build(Path(sys.argv[1]))
    print(f"clean decision fixture written to {sys.argv[1]}")
