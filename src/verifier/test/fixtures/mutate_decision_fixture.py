#!/usr/bin/env python3
"""Derives the three ADR-0002 Decision 3 mutations from a clean decision fixture.

Mirrors P1's existing "mutate a clean bundle" pattern (see ../../README.md):
copy the clean export, then break exactly one thing.

    python3 mutate_decision_fixture.py <base-dir>

Writes <base-dir>/{clean,mistally,missing-vote,outside-snapshot}/.
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_decision_fixture import build, sign, PROPOSER  # noqa: E402


def _decision_outbox_path(export: Path) -> Path:
    return export / "outbox" / "proposer.jsonld"


def mistally(export: Path, fx) -> None:
    """Check 1 — tally recomputation must fail: the declared total no longer
    matches what the counted votes actually add up to.

    Re-signed after the mutation, on purpose: this isolates the fault to the
    arithmetic check alone, rather than also tripping the general signature
    check the way a naive post-hoc edit would — a hub bug that mis-sums
    before signing is exactly what this check exists to catch.
    """
    path = _decision_outbox_path(export)
    outbox = json.loads(path.read_text())
    decision = outbox["orderedItems"][-1]
    assert decision["type"] == "afp:DecisionRecord"
    unsigned = {k: v for k, v in decision.items() if k != "proof"}
    unsigned["afp:weightTally"] = dict(unsigned["afp:weightTally"], **{"candidate-x": 99.0})
    outbox["orderedItems"][-1] = sign(unsigned, fx.keys[PROPOSER], fx.methods[PROPOSER])
    path.write_text(json.dumps(outbox, indent=2))


def missing_vote(export: Path) -> None:
    """Check 2 — evidence-set completeness must fail: a counted vote's hash
    stays in afp:countedVotes, but the vote activity itself is deleted."""
    voter_path = export / "outbox" / "voter-c.jsonld"
    outbox = json.loads(voter_path.read_text())
    outbox["orderedItems"] = []
    outbox["totalItems"] = 0
    voter_path.write_text(json.dumps(outbox, indent=2))


def build_and_mutate(base_dir: Path) -> dict[str, Path]:
    clean = base_dir / "clean"
    shutil.rmtree(clean, ignore_errors=True)
    fx = build(clean)

    variants: dict[str, Path] = {"clean": clean}

    target = base_dir / "mistally"
    shutil.rmtree(target, ignore_errors=True)
    shutil.copytree(clean, target)
    mistally(target, fx)
    variants["mistally"] = target

    target = base_dir / "missing-vote"
    shutil.rmtree(target, ignore_errors=True)
    shutil.copytree(clean, target)
    missing_vote(target)
    variants["missing-vote"] = target

    # Check 3 — snapshot discipline must fail: mint one more, validly signed
    # vote from the outsider (on the roster, but never in the proposal's
    # pinned voterWeights) and have the decision count it. Re-signed after
    # the mutation for the same reason as mistally() above.
    target = base_dir / "outside-snapshot"
    shutil.rmtree(target, ignore_errors=True)
    shutil.copytree(clean, target)

    outsider = "https://hub.example/agents/voter-outsider"
    outsider_hash = fx.cast_vote(outsider, "candidate-x")
    fx.write_outbox(target, outsider)

    decision_path = _decision_outbox_path(target)
    decision_outbox = json.loads(decision_path.read_text())
    decision = decision_outbox["orderedItems"][-1]
    unsigned = {k: v for k, v in decision.items() if k != "proof"}
    unsigned["afp:countedVotes"] = [*unsigned["afp:countedVotes"], outsider_hash]
    decision_outbox["orderedItems"][-1] = sign(unsigned, fx.keys[PROPOSER], fx.methods[PROPOSER])
    decision_path.write_text(json.dumps(decision_outbox, indent=2))
    variants["outside-snapshot"] = target

    return variants


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: mutate_decision_fixture.py <base-dir>")
    variants = build_and_mutate(Path(sys.argv[1]))
    for name, path in variants.items():
        print(f"{name}: {path}")
