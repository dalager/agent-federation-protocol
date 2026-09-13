"""ADR-0034 Decision 4 — the packaging shim.

The fourteen modules in this directory (`keys.py`, `policy.py`, `action.py`,
`decision.py`, …) import each other with absolute, flat names —
`from allocation import …` — on purpose: ADR-0001's whole point is a
directory an auditor can copy next to an export and run with
`python3 afp_verify.py`, no shared code with the writer, no package
structure to reason about.

Installing that unmodified as top-level `keys`, `policy`, `action`, … would
pollute site-packages and collide with anything else on the system named
`policy` or `action`. So the package installs these modules under one
namespace, `afp_verify.<module>` (`[tool.setuptools] package-dir = { afp_verify
= "." }` in `pyproject.toml`), and this file's only job is to put this
directory on `sys.path` at import time — before any of its sibling modules'
`from allocation import …` runs — so those absolute flat imports still
resolve exactly as they do in the copy-the-directory path.

**The trade-off, stated once:** this keeps the property ADR-0001 actually
cares about — a directory an auditor can copy and run standalone, sharing no
code with the writer — at the cost of this path shim for the installed,
`pip`-managed form. `afp_verify.py` itself is unmodified; a checkout still
runs it directly with no package involved at all.
"""

import sys
from pathlib import Path

_here = str(Path(__file__).resolve().parent)
if _here not in sys.path:
    sys.path.insert(0, _here)
