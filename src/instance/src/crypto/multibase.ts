/** base58btc + multibase/multikey encoding, as used by `eddsa-jcs-2022` proofs. */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = new Map<string, number>([...ALPHABET].map((c, i) => [c, i]));

/** Multicodec prefix for an Ed25519 public key (0xed 0x01, varint-encoded). */
const ED25519_PUB_PREFIX = Uint8Array.from([0xed, 0x01]);

export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";

  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  // Every leading zero byte encodes as a literal '1'.
  let out = "";
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) out += ALPHABET[0];
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

export function base58Decode(text: string): Uint8Array {
  if (text.length === 0) return new Uint8Array(0);

  const bytes: number[] = [0];
  for (const char of text) {
    const value = INDEX.get(char);
    if (value === undefined) throw new Error(`invalid base58 character: ${char}`);
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  let leadingZeros = 0;
  for (const char of text) {
    if (char !== ALPHABET[0]) break;
    leadingZeros++;
  }
  return Uint8Array.from([...new Array(leadingZeros).fill(0), ...bytes.reverse()]);
}

/** Multibase base58btc: a 'z' prefix over base58. */
export function multibaseEncode(bytes: Uint8Array): string {
  return "z" + base58Encode(bytes);
}

export function multibaseDecode(text: string): Uint8Array {
  if (!text.startsWith("z")) {
    throw new Error(`unsupported multibase prefix: ${text.slice(0, 1)} (only base58btc 'z' is used)`);
  }
  return base58Decode(text.slice(1));
}

/** Encode a raw 32-byte Ed25519 public key as a Multikey `publicKeyMultibase`. */
export function encodeEd25519Multikey(rawPublicKey: Uint8Array): string {
  if (rawPublicKey.length !== 32) {
    throw new Error(`Ed25519 public keys are 32 bytes, got ${rawPublicKey.length}`);
  }
  const prefixed = new Uint8Array(ED25519_PUB_PREFIX.length + rawPublicKey.length);
  prefixed.set(ED25519_PUB_PREFIX, 0);
  prefixed.set(rawPublicKey, ED25519_PUB_PREFIX.length);
  return multibaseEncode(prefixed);
}

/** Recover the raw 32-byte key from a Multikey `publicKeyMultibase`. */
export function decodeEd25519Multikey(multikey: string): Uint8Array {
  const bytes = multibaseDecode(multikey);
  if (bytes[0] !== ED25519_PUB_PREFIX[0] || bytes[1] !== ED25519_PUB_PREFIX[1]) {
    throw new Error("multikey is not an Ed25519 public key (expected 0xed01 prefix)");
  }
  const raw = bytes.slice(2);
  if (raw.length !== 32) throw new Error(`decoded Ed25519 key is ${raw.length} bytes, expected 32`);
  return raw;
}
