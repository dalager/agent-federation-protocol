/**
 * ADR-0031 Decision 5: shutdown drains.
 *
 * `SIGTERM`/`SIGINT` stop accepting new inbox POSTs, let in-flight handlers
 * finish (bounded by a timeout), run one final flush, stop the scheduler,
 * close the instance (which releases the store lock, ADR-0031 Decision 4),
 * and exit 0. A second signal during drain exits 1 immediately — a stuck
 * drain must still yield to an operator who asks twice.
 *
 * ADR-0036 Decision 3: this is the `node` profile's concern alone, and stays
 * a `node:http` `Server` on purpose. A hosted actor has no process to drain,
 * no signals to trap and no listening socket to stop accepting on — its
 * platform ends a request by returning from the fetch method. The request
 * port (`runtime/httpPort.ts`) therefore says nothing about shutdown, and a
 * second adapter is expected to leave this file entirely alone.
 */

import type { Server } from "node:http";
import type { AfpInstance } from "../instance.ts";
import type { Scheduler } from "./scheduler.ts";
import type { Transport } from "../store/queue.ts";
import { logger } from "./log.ts";

const log = logger("shutdown");

export interface ShutdownDeps {
  readonly server: Server;
  readonly scheduler: Scheduler;
  readonly instance: AfpInstance;
  readonly transport: Transport;
  readonly timeoutMs: number;
  /** Injectable for tests: defaults to `process.exit`. */
  readonly exit?: (code: number) => void;
}

/** Registers `SIGTERM`/`SIGINT` handlers and returns a `drain()` callable without a signal, so a test can invoke the drain in-process. */
export function installShutdown(deps: ShutdownDeps): { drain: () => Promise<void> } {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  let draining = false;

  const drain = async (): Promise<void> => {
    if (draining) {
      // A second signal during drain: yield immediately rather than wait on
      // a drain that may itself be stuck.
      exit(1);
      return;
    }
    draining = true;
    log.info("draining");

    // Stop accepting new connections; in-flight handlers finish on their
    // own. Idle keep-alive connections would otherwise hold `close()` open
    // until the client's timeout, so they are dropped now — and everything
    // still open when our own timeout lands is dropped then.
    const closed = new Promise<void>((resolve) => deps.server.close(() => resolve()));
    deps.server.closeIdleConnections?.();
    const timedOut = new Promise<void>((resolve) =>
      setTimeout(() => {
        deps.server.closeAllConnections?.();
        resolve();
      }, deps.timeoutMs).unref?.(),
    );
    await Promise.race([closed, timedOut]);

    try {
      await deps.instance.queue.flush(deps.transport, deps.instance.clock.now());
    } catch (error) {
      log.warn("final flush failed", { error: String(error) });
    }

    deps.scheduler.stop();
    deps.instance.close();
    log.info("drained");
    exit(0);
  };

  const onSignal = () => {
    drain().catch((error) => {
      log.error("drain failed", { error: String(error) });
      exit(1);
    });
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  return { drain };
}
