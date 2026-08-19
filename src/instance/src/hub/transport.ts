import type { Transport } from "../store/queue.ts";
import type { Hub } from "./hub.ts";

/**
 * The delivery port hub and agents share: `deliver(target, activity)` routes
 * by URL alone, so nothing in the bytes leaking through it can tell whether
 * the recipient is in-process or a remote service (gate check 11, carried
 * from P1 into ADR-0002 Decision 1).
 */
export function hubTransport(
  hub: Hub,
  agentTransport: Transport,
  nameOf: (actorUrl: string) => boolean,
): Transport {
  return {
    name: "local",
    deliver: async (target, activity) => {
      if (target === hub.actorId) {
        await hub.receive(activity);
        return;
      }
      if (!nameOf(target)) throw new Error(`no local actor at ${target}`);
      await agentTransport.deliver(target, activity);
    },
  };
}
