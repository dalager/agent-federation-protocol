/**
 * ADR-0036 Decision 6 — secrets-as-files becomes secrets-as-bindings.
 *
 * ADR-0032 Decision 3 made every secret a *path*, never a value: the schema
 * entry names a file, and the value is read at the point of use so it never
 * sits on `Config` and never reaches a log line. That discipline is the part
 * worth keeping. What cannot cross profiles is the *file* — an actor has no
 * filesystem to read, and its platform injects secrets as bindings on an
 * environment object instead.
 *
 * So the schema is unchanged, `validate()` is unchanged, and the entries
 * still say `kind: "file"` — what varies is only how a named secret is
 * fetched. The node loader reads the file the entry points at; a hosted
 * loader would read the binding of that name. Neither is allowed to hand
 * back an empty string: an empty secret file has always meant "absent"
 * rather than "the empty passphrase", and a binding set to `""` must mean
 * the same thing, or the two profiles would disagree about whether a
 * deployment is configured.
 */

import { existsSync, readFileSync } from "node:fs";

/**
 * Fetch one secret by the reference its schema entry carries — a path under
 * the self-hosted profile, a binding name under the hosted one. `undefined`
 * means "not configured", and an empty value is `undefined`.
 */
export type SecretLoader = (reference: string) => string | undefined;

/** The self-hosted loader: the file at `path`, trimmed (ADR-0032 Decision 3). */
export const fileSecrets: SecretLoader = (path) => {
  if (!path || !existsSync(path)) return undefined;
  const value = readFileSync(path, "utf8").trim();
  return value.length > 0 ? value : undefined;
};

let loader: SecretLoader = fileSecrets;

/**
 * Install the profile's loader. The hosted adapter calls this once, before
 * anything reads a secret; the self-hosted profile never calls it at all,
 * which is why the default is the file loader rather than a throw.
 *
 * Process-wide rather than threaded through `Config` for the reason the
 * secret is not on `Config` in the first place: every extra place a secret's
 * *accessor* is passed through is another place it can be captured, logged
 * or serialised by accident.
 */
export function useSecretLoader(next: SecretLoader): void {
  loader = next;
}

/** Read a secret through whichever loader this profile installed. */
export function readSecret(reference: string): string | undefined {
  return loader(reference);
}
