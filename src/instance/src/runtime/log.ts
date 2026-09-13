/**
 * ADR-0031 Decision 3: structured logs.
 *
 * `console.log` becomes one JSON line per event, to stderr, carrying a level
 * and a component. This stream is the operational shadow of a served
 * instance — what an operator tails at night. It is not the record: the
 * boundary log in SQLite (`federation/federation.ts` `fed_boundary_log`)
 * stays that, hash-chained and exportable, exactly as it was before this
 * file existed. Nothing here is ever read back by the verifier.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** `AFP_LOG_LEVEL`, default `info`; `silent` mutes the stream entirely (tests). */
function configuredLevel(): LogLevel | "silent" {
  const raw = (process.env.AFP_LOG_LEVEL ?? "info").toLowerCase();
  if (raw === "silent") return "silent";
  return raw in LEVELS ? (raw as LogLevel) : "info";
}

export interface LogFields {
  readonly [key: string]: unknown;
}

/**
 * Emit one JSON-lines record. Read fresh from the environment on every call
 * rather than cached at import time, so a test that sets `AFP_LOG_LEVEL`
 * after this module has already loaded still gets what it asked for.
 */
export function log(level: LogLevel, component: string, message: string, fields?: LogFields): void {
  const configured = configuredLevel();
  if (configured === "silent" || LEVELS[level] < LEVELS[configured]) return;
  const line = { t: new Date().toISOString(), level, component, msg: message, ...fields };
  process.stderr.write(`${JSON.stringify(line)}\n`);
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/** A logger bound to one component name, so call sites do not repeat it. */
export function logger(component: string): Logger {
  return {
    debug: (message, fields) => log("debug", component, message, fields),
    info: (message, fields) => log("info", component, message, fields),
    warn: (message, fields) => log("warn", component, message, fields),
    error: (message, fields) => log("error", component, message, fields),
  };
}
