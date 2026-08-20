/**
 * One way to read `published` into an orderable instant, for every writer-side
 * comparison that a verifier has to reach the same answer on.
 *
 * The temptation is to compare the ISO strings directly — they usually sort
 * chronologically. They do not always: the same instant is legally
 * `2026-01-01T00:00:00Z` or `2026-01-01T00:00:00.000Z` (and '.' < 'Z', so the
 * string order inverts what should be a tie broken by digest), and a negative
 * UTC offset sorts before 'Z' while denoting a *later* moment. Any ordering
 * that feeds recorded state — role LWW, settlement recency — must therefore go
 * through here, and `src/verifier/decision.py`'s `instant_millis` mirrors it
 * exactly, truncation included.
 *
 * Unparseable input is 0, not NaN: a NaN in a sort key is unspecified
 * behavior in one implementation and first-wins in the other.
 */
export function instantMillis(published: unknown): number {
  if (typeof published !== "string") return 0;
  const parsed = Date.parse(published);
  return Number.isNaN(parsed) ? 0 : parsed;
}
