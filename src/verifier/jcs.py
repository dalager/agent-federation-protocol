"""RFC 8785 — JSON Canonicalization Scheme.

Written directly from the RFC rather than ported from the instance's
implementation: the whole point of a second implementation is that a
canonicalization bug on one side does not silently exist on the other
(ADR-0001). If these two disagree, that disagreement is the finding.

Serialization rules, in short:
  * object members are ordered by the UTF-16 code units of their names
  * no whitespace anywhere
  * strings use the shortest JSON escape
  * integers are emitted without exponent or trailing zeros
"""

from __future__ import annotations


_ESCAPES = {
    '"': '\\"',
    "\\": "\\\\",
    "\b": "\\b",
    "\f": "\\f",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
}


def _sort_key(name: str) -> list[int]:
    """UTF-16 code units of ``name``, which is the order RFC 8785 mandates."""
    return [unit for unit in name.encode("utf-16-be")]


def _serialize_string(value: str) -> str:
    out = ['"']
    for char in value:
        if char in _ESCAPES:
            out.append(_ESCAPES[char])
        elif ord(char) < 0x20:
            out.append(f"\\u{ord(char):04x}")
        else:
            out.append(char)
    out.append('"')
    return "".join(out)


def _serialize_number(value: int | float) -> str:
    if isinstance(value, bool):  # bool is a subclass of int in Python
        raise TypeError("booleans are not numbers")
    if isinstance(value, int):
        return str(value)
    if value != value or value in (float("inf"), float("-inf")):
        raise ValueError("NaN and Infinity have no JSON representation")
    if value.is_integer():
        return str(int(value))
    # AFP forbids non-integer numbers in signed documents precisely because
    # their shortest round-trip form is not portable between languages.
    raise ValueError(f"non-integer number {value!r} is not allowed in a signed AFP document")


def canonicalize(value: object) -> str:
    """Return the RFC 8785 canonical JSON text for ``value``."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return _serialize_string(value)
    if isinstance(value, (int, float)):
        return _serialize_number(value)
    if isinstance(value, list):
        return "[" + ",".join(canonicalize(item) for item in value) + "]"
    if isinstance(value, dict):
        members = sorted(value.items(), key=lambda item: _sort_key(item[0]))
        body = ",".join(
            f"{_serialize_string(name)}:{canonicalize(child)}" for name, child in members
        )
        return "{" + body + "}"
    raise TypeError(f"cannot canonicalize {type(value).__name__}")


def canonical_bytes(value: object) -> bytes:
    """Canonical JSON as UTF-8 — the bytes that actually get hashed."""
    return canonicalize(value).encode("utf-8")
