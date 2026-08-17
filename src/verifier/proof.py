"""`eddsa-jcs-2022` proof verification, and the base58 it needs.

Kept apart from the replay logic so the cryptographic core stays short enough to
read in one sitting — an auditor should be able to check *this* file against the
spec without wading through bundle plumbing.
"""

from __future__ import annotations

import hashlib
import sys

from jcs import canonical_bytes

try:
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
except ImportError:  # pragma: no cover - environment guard
    sys.exit("afp-verify needs `cryptography` (pip install cryptography)")

CRYPTOSUITE = "eddsa-jcs-2022"
B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58decode(text: str) -> bytes:
    number = 0
    for char in text:
        index = B58_ALPHABET.find(char)
        if index < 0:
            raise ValueError(f"invalid base58 character {char!r}")
        number = number * 58 + index

    body = number.to_bytes((number.bit_length() + 7) // 8, "big") if number else b""
    leading = len(text) - len(text.lstrip(B58_ALPHABET[0]))
    return b"\x00" * leading + body


def decode_multikey(multibase: str) -> bytes:
    """Recover the raw 32-byte Ed25519 key from a `publicKeyMultibase` value."""
    if not multibase.startswith("z"):
        raise ValueError("only base58btc ('z') multibase is used by AFP")
    decoded = b58decode(multibase[1:])
    if decoded[:2] != b"\xed\x01":
        raise ValueError("multikey is not an Ed25519 public key (expected 0xed01 prefix)")
    if len(decoded) != 34:
        raise ValueError(f"expected 34 bytes after multibase decode, got {len(decoded)}")
    return decoded[2:]


def verify_proof(document: dict, public_keys: dict[str, bytes]) -> str | None:
    """Return None when the proof is good, else a human-readable reason."""
    proof = document.get("proof")
    if not isinstance(proof, dict):
        return "no proof present"
    if proof.get("type") != "DataIntegrityProof":
        return f"unexpected proof type {proof.get('type')!r}"
    if proof.get("cryptosuite") != CRYPTOSUITE:
        return f"unexpected cryptosuite {proof.get('cryptosuite')!r}"
    if proof.get("proofPurpose") != "assertionMethod":
        return f"unexpected proofPurpose {proof.get('proofPurpose')!r}"

    method = proof.get("verificationMethod")
    raw_key = public_keys.get(method)
    if raw_key is None:
        return f"no published key for verificationMethod {method!r}"

    # The proof configuration is the proof minus its value, plus the document's
    # @context. It is present while hashing and absent on the wire.
    proof_config = {
        "type": proof["type"],
        "cryptosuite": proof["cryptosuite"],
        "created": proof.get("created"),
        "verificationMethod": method,
        "proofPurpose": proof["proofPurpose"],
    }
    if "@context" in document:
        proof_config["@context"] = document["@context"]

    unsecured = {k: v for k, v in document.items() if k != "proof"}
    signing_input = (
        hashlib.sha256(canonical_bytes(proof_config)).digest()
        + hashlib.sha256(canonical_bytes(unsecured)).digest()
    )

    try:
        signature = b58decode(proof["proofValue"][1:])
    except (ValueError, KeyError, TypeError) as exc:
        return f"undecodable proofValue: {exc}"

    try:
        Ed25519PublicKey.from_public_bytes(raw_key).verify(signature, signing_input)
    except InvalidSignature:
        return "signature does not verify"
    return None


def digest_of(value: object) -> str:
    return "sha256:" + hashlib.sha256(canonical_bytes(value)).hexdigest()


