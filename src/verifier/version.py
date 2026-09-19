"""ADR-0034 Decision 1 — the verifier's half of the one stated relationship
between an implementation's semantic version and the spec revision it
implements. `afp_verify.py --version` reads this; nothing else does, so a
release only has one place to bump.
"""

VERSION = "0.9.0"
SPEC_REVISION = "3.35"
