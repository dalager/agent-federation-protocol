#!/usr/bin/env python3
"""Run the shared parity cases through the *Python* implementations.

    python3 run_parity.py cases.json

Prints one JSON object of results on stdout. `src/instance/test/parity.test.ts`
runs the same file through the TypeScript implementations and asserts the two
outputs are identical, case by case.

This exists because the two implementations are only a verifiability guarantee
while they actually agree, and the ways they drift are not the ways a
hand-written unit test looks: a JSON number that is `100.0` rather than `100`,
a timestamp with an offset rather than a `Z`, a field that arrives as a string
where a list was meant. Cases are read as raw JSON so those distinctions
survive to both readers.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # -> src/verifier

from decision import instant_millis
from reputation import REPUTATION_RULES


def main() -> int:
    cases = json.loads(Path(sys.argv[1]).read_text())
    results: dict[str, object] = {}

    derivation = REPUTATION_RULES["divergence-decay"]
    for case in cases["reputation"]:
        key = f"reputation:{case['name']}"
        try:
            results[key] = derivation({}, case["settlements"], case["bidder"])
        except Exception as error:  # a crash on one side is itself a divergence
            results[key] = f"THREW: {type(error).__name__}"

    for value in cases["instants"]:
        try:
            results[f"instant:{value}"] = instant_millis(value)
        except Exception as error:
            results[f"instant:{value}"] = f"THREW: {type(error).__name__}"

    json.dump(results, sys.stdout, sort_keys=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
