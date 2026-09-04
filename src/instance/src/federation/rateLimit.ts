/**
 * ADR-0025 Decision 5: real rate limiting in front of every inbox POST and
 * every non-`public` read — two token buckets, per source address
 * (unauthenticated, cheap) and per authenticated actor (after signature
 * verification). In-memory: a served instance is one process, and a bucket
 * surviving a restart is not a security property worth a table for.
 *
 * ADR-0008's row F3 claimed this was built; it was not. This closes it.
 */

interface Bucket {
  tokens: number;
  windowStart: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly windowMs: number;

  constructor(capacity: number, windowMs: number) {
    this.capacity = capacity;
    this.windowMs = windowMs;
  }

  /**
   * `true` if `key` may proceed (and one token is consumed); `false` if the
   * bucket is exhausted for the current window. Fixed-window, not
   * sliding — simple, and conservative defaults absorb the edge burst.
   */
  allow(key: string, now: number): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart >= this.windowMs) {
      bucket = { tokens: this.capacity, windowStart: now };
      this.buckets.set(key, bucket);
    }
    if (bucket.tokens <= 0) return false;
    bucket.tokens--;
    return true;
  }

  /** Seconds until `key`'s window resets — for a `Retry-After` header. */
  retryAfterSeconds(key: string, now: number): number {
    const bucket = this.buckets.get(key);
    if (!bucket) return 0;
    return Math.max(0, Math.ceil((bucket.windowStart + this.windowMs - now) / 1000));
  }

  /** Bound memory on a long-lived process: drop windows that have long since closed. */
  sweep(now: number, staleAfterMs: number = this.windowMs * 4): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart > staleAfterMs) this.buckets.delete(key);
    }
  }
}
