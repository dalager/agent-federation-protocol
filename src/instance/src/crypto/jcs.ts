/**
 * RFC 8785 — JSON Canonicalization Scheme.
 *
 * The whole of AFP's signing story rests on this being boring and reproducible:
 * sort object keys by UTF-16 code unit, emit no insignificant whitespace, and
 * serialize scalars exactly as ECMAScript does. `JSON.stringify` already
 * implements RFC 8785's string-escaping and number rules, so canonicalizing in
 * JavaScript reduces to sorting keys before handing the value over.
 *
 * Deliberately dependency-free — see ADR-0001 on why an independent verifier in
 * another language has to be able to reproduce this in a couple of hundred lines.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Recursively rebuild a value with object keys in RFC 8785 order. */
function sortValue(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortValue);

  // RFC 8785 orders members by their UTF-16 code units. Array#sort on strings
  // compares exactly that way, so no custom comparator is needed.
  const out: { [key: string]: JsonValue } = {};
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (child === undefined) continue;
    out[key] = sortValue(child);
  }
  return out;
}

/** Canonical JSON text for `value`. */
export function canonicalize(value: JsonValue): string {
  assertSerializable(value);
  return JSON.stringify(sortValue(value));
}

/** Canonical JSON as UTF-8 bytes — what actually gets hashed. */
export function canonicalBytes(value: JsonValue): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}

/**
 * Reject values whose canonical form would be ambiguous or lossy.
 *
 * AFP records are hashed, signed, and re-serialized by independent
 * implementations, so a value that survives one language's JSON writer but not
 * another's is a latent interop bug. Failing loudly here is much cheaper than a
 * signature that verifies on the writer and not on the verifier.
 */
function assertSerializable(value: JsonValue, path = "$"): void {
  if (value === null || typeof value === "boolean" || typeof value === "string") return;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path}: NaN and Infinity have no JSON representation`);
    }
    if (!Number.isInteger(value)) {
      // Floats are representable, but their shortest round-trip form differs
      // between languages often enough that AFP simply does not put them in
      // signed documents. Ranges and scores travel as strings or scaled ints.
      throw new TypeError(`${path}: non-integer numbers are not allowed in signed AFP documents`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`${path}: integer exceeds the safe range and would not round-trip`);
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((child, i) => assertSerializable(child, `${path}[${i}]`));
    return;
  }

  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      assertSerializable(child as JsonValue, `${path}.${key}`);
    }
    return;
  }

  throw new TypeError(`${path}: value of type ${typeof value} cannot be canonicalized`);
}
