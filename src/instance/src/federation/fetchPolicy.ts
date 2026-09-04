/**
 * ADR-0025 Decision 2: one fetch policy, applied to every server-side fetch
 * this instance makes — actor/hub document resolution, inbox delivery,
 * artifact fetch. `federation/inbox.ts`'s `fetchActorDocument` and
 * `federation/transport.ts`'s delivery and inbox-resolution fetches are the
 * two call sites; both are security-relevant by their own comments, and both
 * now go through here instead of a bare `fetch`.
 *
 * Reimplements the fediverse's standard SSRF discipline rather than
 * borrowing it (ADR-0001's amendment: no Fedify, so no borrowed fetch
 * policy) — refuse loopback, link-local, private, ULA, multicast and
 * cloud-metadata targets; refuse redirects; bound time and bytes; check
 * content type where the kind has one.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type FetchKind = "document" | "inbox" | "artifact";

export class FetchRefusal extends Error {
  readonly class: string;
  constructor(cls: string, message: string) {
    super(message);
    this.class = cls;
  }
}

export interface FetchPolicyDeps {
  /** ADR-0025 Decision 1: the address policy and literal-IP refusal relax under dev mode. */
  devMode: boolean;
  /** Decision 2's escape hatch outside dev mode: named private ranges, e.g. a hub on a VPN. */
  trustedNets?: readonly string[];
}

const TIMEOUTS: Record<FetchKind, { connectMs: number; totalMs: number }> = {
  document: { connectMs: 5_000, totalMs: 15_000 },
  inbox: { connectMs: 5_000, totalMs: 15_000 },
  artifact: { connectMs: 5_000, totalMs: 60_000 },
};

const SIZE_CAPS: Record<FetchKind, number> = {
  document: 256 * 1024,
  inbox: 256 * 1024,
  artifact: 10 * 1024 * 1024,
};

/** `document` accepts the two AS2 media types; `inbox`/`artifact` have their own checks downstream. */
const ACCEPTED_CONTENT_TYPES: Record<FetchKind, readonly string[] | null> = {
  document: ["application/activity+json", "application/ld+json"],
  inbox: null,
  artifact: null,
};

// ------------------------------------------------------------- address policy

function ipv4InCidr(ip: number[], base: number[], bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  const ipInt = ((ip[0] << 24) | (ip[1] << 16) | (ip[2] << 8) | ip[3]) >>> 0;
  const baseInt = ((base[0] << 24) | (base[1] << 16) | (base[2] << 8) | base[3]) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

const PRIVATE_V4: [number[], number][] = [
  [[127, 0, 0, 0], 8], // loopback
  [[10, 0, 0, 0], 8], // RFC 1918
  [[172, 16, 0, 0], 12], // RFC 1918
  [[192, 168, 0, 0], 16], // RFC 1918
  [[169, 254, 0, 0], 16], // link-local, includes 169.254.169.254 cloud metadata
  [[224, 0, 0, 0], 4], // multicast
  [[0, 0, 0, 0], 8], // "this network"
];

function isPrivateV4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true; // malformed: refuse, don't guess
  return PRIVATE_V4.some(([base, bits]) => ipv4InCidr(parts, base, bits));
}

function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1") return true; // loopback
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true; // link-local fe80::/10
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
  if (lower.startsWith("ff")) return true; // multicast
  if (lower.startsWith("::ffff:")) return isPrivateV4(lower.slice("::ffff:".length));
  return false;
}

function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateV4(ip);
  if (version === 6) return isPrivateV6(ip);
  return true; // not a literal address at all: caller has a bug, refuse
}

function cidrAllows(ip: string, cidrs: readonly string[]): boolean {
  const version = isIP(ip);
  for (const cidr of cidrs) {
    const [base, bitsRaw] = cidr.split("/");
    if (version === 4 && isIP(base) === 4) {
      const bits = bitsRaw ? Number(bitsRaw) : 32;
      if (ipv4InCidr(ip.split(".").map(Number), base.split(".").map(Number), bits)) return true;
    } else if (version === 6 && ip.toLowerCase().startsWith(base.toLowerCase())) {
      return true; // coarse: prefix match is enough for a named operator escape hatch
    }
  }
  return false;
}

/**
 * Resolve `hostname` and refuse it if every private-range test says so and
 * the caller has not named it trusted. In dev mode, or for a trusted net,
 * the address is returned unchecked.
 */
async function checkAddress(hostname: string, deps: FetchPolicyDeps): Promise<void> {
  if (deps.devMode) return;

  const literal = isIP(hostname) !== 0;
  if (literal) {
    throw new FetchRefusal("ssrf", `literal IP host "${hostname}" is refused outside development mode`);
  }

  let resolved: string;
  try {
    const result = await lookup(hostname);
    resolved = result.address;
  } catch (error) {
    throw new FetchRefusal("dns", `could not resolve "${hostname}": ${(error as Error).message}`);
  }

  if (isPrivateAddress(resolved)) {
    if (deps.trustedNets && cidrAllows(resolved, deps.trustedNets)) return;
    throw new FetchRefusal("ssrf", `"${hostname}" resolves to ${resolved}, a private/loopback/link-local address`);
  }
}

// ------------------------------------------------------------- size-capped read

async function readCapped(response: Response, cap: number): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > cap) {
    throw new FetchRefusal("size", `declared content-length ${declared} exceeds the ${cap}-byte cap`);
  }
  // A bodyless answer is legitimate on this path — a peer accepting a
  // delivery with `204` is the common case — so it reads as zero bytes
  // rather than as a refusal.
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw new FetchRefusal("size", `body exceeded the ${cap}-byte cap while streaming`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// ------------------------------------------------------------------- policedFetch

export interface PolicedFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * The single server-side fetch every federation call site goes through.
 * Throws `FetchRefusal` for every policy violation; a caller that wants a
 * failed-hop exception (the queue's retry machinery) gets one for free —
 * `FetchRefusal extends Error`.
 */
export async function policedFetch(
  url: string | URL,
  kind: FetchKind,
  deps: FetchPolicyDeps,
  init: PolicedFetchInit = {},
): Promise<Response> {
  const target = typeof url === "string" ? new URL(url) : url;

  if (target.protocol !== "https:" && !(deps.devMode && target.protocol === "http:")) {
    throw new FetchRefusal("insecure-origin", `refused non-https target "${target}" outside development mode`);
  }

  await checkAddress(target.hostname, deps);

  const timeouts = TIMEOUTS[kind];
  const controller = new AbortController();
  const totalTimer = setTimeout(() => controller.abort(), timeouts.totalMs);
  try {
    let response: Response;
    try {
      response = await fetch(target, {
        method: init.method ?? "GET",
        headers: init.headers,
        body: init.body,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw new FetchRefusal("timeout", `fetch of ${target} exceeded ${timeouts.totalMs}ms`);
      }
      throw error;
    }

    // Decision 2: no redirect is followed. A 3xx is a refusal with the
    // target logged, not a hop the caller retries.
    if (response.status >= 300 && response.status < 400) {
      throw new FetchRefusal("redirect", `${target} answered ${response.status}, redirects are refused`);
    }

    const accepted = ACCEPTED_CONTENT_TYPES[kind];
    if (accepted && response.ok) {
      const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim();
      if (!accepted.includes(contentType)) {
        throw new FetchRefusal(
          "content-type",
          `${target} answered content-type "${contentType}", expected one of ${accepted.join(", ")}`,
        );
      }
    }

    // The body is already drained and capped, so what comes back is an
    // ordinary `Response` over bytes this policy has vouched for — callers
    // get the real `.status`/`.ok`/`.headers`/`.text()` surface, not a
    // hand-rolled stand-in for it.
    const bytes = await readCapped(response, SIZE_CAPS[kind]);
    // `204`/`205`/`304` may not carry a body at all — handing one to the
    // `Response` constructor throws, and a peer that accepted a delivery
    // with `204` must not become a failed hop over a technicality.
    const bodyless = response.status === 204 || response.status === 205 || response.status === 304;
    return new Response(bodyless ? null : bytes, { status: response.status, headers: response.headers });
  } finally {
    clearTimeout(totalTimer);
  }
}
