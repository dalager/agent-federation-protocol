/**
 * ADR-0029 Decision 2 ("Command"): the `pause` verb's state.
 *
 * In-memory only — a pause does not survive a restart, and does not need to:
 * an operator who wants a durable stop uses `AfpInstance.disownAgent`, which
 * is on the record. The three-form grammar (`visibility.ts`) names no
 * `resume`; `AfpInstance.resumeAgent` exists for the operator's own program,
 * not for a mention (see `ports/command.ts`).
 *
 * Extracted from `instance.ts` to stay under its line ceiling, in
 * `instance/following.ts`'s style: a tiny class the class delegates three
 * one-line methods to.
 */
export class PausedAgents {
  private readonly names = new Set<string>();

  pause(name: string): void {
    this.names.add(name);
  }

  resume(name: string): void {
    this.names.delete(name);
  }

  isPaused(name: string): boolean {
    return this.names.has(name);
  }
}
