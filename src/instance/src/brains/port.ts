/**
 * The agent port.
 *
 * This file is the whole contract between an agent's brain and the instance.
 * Nothing here mentions ActivityPub, signatures, SQLite or HTTP — that is the
 * point of the ports-and-adapters boundary in 01: the instance is the adapter
 * stack, and a brain is portable across instance implementations because the
 * port is protocol-defined rather than implementation-defined.
 *
 * A brain that grows an import from `../ap/` has broken the boundary.
 */

/** An artifact handed to or produced by a brain, already materialised. */
export interface BrainArtifact {
  mediaType: string;
  bytes: Uint8Array;
}

export interface TaskRequest {
  /** Which capability was asked for. */
  capability: string;
  /** Free-text instruction. */
  content: string;
  /** Inputs, already digest-verified by the adapter before the brain sees them. */
  attachments: BrainArtifact[];
  /** Thread the task belongs to — brains may use it for continuity, nothing more. */
  thread: string;
}

export type TaskOutcome =
  | {
      ok: true;
      content: string;
      attachments?: BrainArtifact[];
      summary?: string;
      /**
       * What produced this — a model id, a rule-engine version, anything the
       * brain wants on the record. The adapter copies it onto the Result as
       * `afp:producedBy`, so an auditor asking "what made this claim" does not
       * have to take the agent's word for it.
       */
      producedBy?: string;
    }
  | { ok: false; reason: string };

export interface Brain {
  /** Local name, e.g. "writer". The adapter maps it to an actor URL. */
  readonly name: string;
  readonly capabilities: readonly string[];
  handle(request: TaskRequest): Promise<TaskOutcome>;
}

/** True when this brain advertises `capability`. */
export function canHandle(brain: Brain, capability: string): boolean {
  return brain.capabilities.includes(capability);
}
