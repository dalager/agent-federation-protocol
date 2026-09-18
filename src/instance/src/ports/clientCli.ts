/**
 * ADR-0038 Decision 4, factored once: the client-side plumbing every CLI
 * command that talks to a *running* instance shares — `task` (`taskCli.ts`)
 * and `show` (`showCli.ts`).
 *
 * `serve` holds the store lock (ADR-0031 Decision 4: one writer, enforced),
 * so a second process pointed at the same `AFP_DATA_DIR` cannot open it — and
 * must not try. Nothing here constructs an `AfpInstance` or touches the
 * SQLite file: a client resolves the controller by name, loads that
 * controller's key from the key directory, and signs each request exactly
 * the way `test/adr0029.test.ts`'s harness does (`signRequest` +
 * `fileSigner`). What the served instance does with the request is its
 * business, on the record.
 *
 * It never mints: a controller whose key is absent fails by name
 * (`keyExists` before `loadOrCreateKeyPair`). A client tool that quietly
 * minted a fresh identity would put an actor on disk the roster never
 * vouched for.
 *
 * Requests go out with a plain `fetch`, not `policedFetch` — this is the
 * operator's own tool addressing their own instance, on loopback in dev mode
 * or at the origin they configured; ADR-0025's SSRF guard is for what the
 * *instance* fetches on a stranger's say-so, not for what the operator types.
 */

import type { Config } from "../config.ts";
import { keyExists, loadOrCreateKeyPair } from "../crypto/keys.ts";
import { fileSigner, type Signer } from "../crypto/signer.ts";
import { signRequest } from "../federation/httpSig.ts";
import { agentActorId } from "../ap/documents.ts";

/** Local name of a controller URL under this origin, or null for a foreign one. */
function localControllerName(config: Config, url: string): string | null {
  const prefix = `${config.origin}/agents/`;
  if (!url.startsWith(prefix)) return null;
  const name = url.slice(prefix.length);
  return /^[\w-]+$/.test(name) ? name : null;
}

/**
 * `--as` defaults to the first `afp:controllers` entry that names an actor
 * under this origin — the same "held here" test `executeCommand` applies on
 * the other side, resolved without opening the store.
 */
export function defaultController(config: Config): string | null {
  for (const url of config.policy.controllers ?? []) {
    const name = localControllerName(config, url);
    if (name !== null) return name;
  }
  return null;
}

export interface SignedClient {
  readonly controller: string;
  readonly controllerUrl: string;
  /** One signed request. `body` is only ever sent for a POST and is what the signature's content-digest covers. */
  request(method: "GET" | "POST", path: string, options?: { body?: string; accept?: string; base?: string }): Promise<ClientResponse>;
}

export interface ClientResponse {
  status: number;
  /** The raw body — JSON where the route answers JSON, text where `Accept: text/plain` asked for it. */
  text: string;
  url: string;
}

/** Parse a response body as JSON when it is, or hand back the text. */
export function parsedBody(response: ClientResponse): unknown {
  try {
    return JSON.parse(response.text);
  } catch {
    return response.text;
  }
}

/**
 * Resolve the controller (by `as`, else the policy's first local one), refuse
 * to mint, load its key, and hand back a signer-bound client.
 */
export function signedClient(config: Config, as?: string, fetchImpl: typeof fetch = fetch): SignedClient {
  const controller = as ?? defaultController(config);
  if (!controller) {
    throw new Error("no --as given and no afp:controllers entry names an actor under this origin — set AFP_CONTROLLERS or the policy file's controllers");
  }
  if (!keyExists(config.keyDir, controller)) {
    throw new Error(
      `controller key for "${controller}" not found in ${config.keyDir} — this command never mints one; ` +
        `the controller must be on the served instance's roster (AFP_AGENTS_FILE, brain "none") and its key minted by serve`,
    );
  }
  const controllerUrl = agentActorId(config.origin, controller);
  const signer: Signer = fileSigner(loadOrCreateKeyPair(config.keyDir, controller, controllerUrl));

  return {
    controller,
    controllerUrl,
    async request(method, path, options = {}) {
      const target = new URL(path, options.base ?? config.origin);
      const body = method === "POST" ? (options.body ?? "") : "";
      const signed = signRequest(method, target.pathname, target.host, body, signer, new Date());
      const headers: Record<string, string> = { ...signed, accept: options.accept ?? "application/json" };
      if (method === "POST") headers["content-type"] = "application/json";
      const response = await fetchImpl(target, { method, headers, ...(method === "POST" ? { body } : {}) });
      return { status: response.status, text: await response.text(), url: target.toString() };
    },
  };
}
