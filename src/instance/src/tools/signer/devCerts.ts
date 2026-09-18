/**
 * Self-signed CA, server and client certificates for local/dev/test use of
 * `tools/signer/` — generated through the system `openssl` binary (not an
 * npm dependency; the same discipline the verifier's `python3` call already
 * relies on, ADR-0001). Never for production: a real deployment brings its
 * own CA and issues its own client identities.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface DevCertBundle {
  dir: string;
  caCertFile: string;
  serverCertFile: string;
  serverKeyFile: string;
  clientCertFile: string;
  clientKeyFile: string;
  serverCert: string;
  serverKey: string;
  caCert: string;
  clientCert: string;
  clientKey: string;
  /** Colon-hex SHA-256, the same form `TLSSocket#getPeerCertificate().fingerprint256` reports. */
  clientFingerprint256: string;
}

function fingerprint256Of(certPem: string): string {
  const der = Buffer.from(certPem.replace(/-----(BEGIN|END) CERTIFICATE-----|\s/g, ""), "base64");
  return createHash("sha256")
    .update(der)
    .digest("hex")
    .toUpperCase()
    .replace(/(.{2})(?=.)/g, "$1:");
}

export function makeDevCerts(): DevCertBundle {
  const dir = mkdtempSync(join(tmpdir(), "afp-signer-certs-"));
  const run = (args: string[]): void => {
    execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  };

  run(["req", "-x509", "-newkey", "ed25519", "-keyout", "ca.key", "-out", "ca.crt", "-days", "2", "-nodes", "-subj", "/CN=afp-signer-dev-ca"]);
  run(["req", "-newkey", "ed25519", "-keyout", "server.key", "-out", "server.csr", "-nodes", "-subj", "/CN=127.0.0.1"]);
  // Node's TLS client checks the SAN, not the CN, against the address it
  // dialed — without this extension `remoteSignerRequest`'s TLS handshake to
  // 127.0.0.1 fails even against a certificate whose CN says the same thing.
  writeFileSync(join(dir, "server.ext"), "subjectAltName=IP:127.0.0.1\n");
  run(["x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.crt", "-days", "2", "-extfile", "server.ext"]);
  run(["req", "-newkey", "ed25519", "-keyout", "client.key", "-out", "client.csr", "-nodes", "-subj", "/CN=afp-instance-client"]);
  run(["x509", "-req", "-in", "client.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "client.crt", "-days", "2"]);

  const caCertFile = join(dir, "ca.crt");
  const serverCertFile = join(dir, "server.crt");
  const serverKeyFile = join(dir, "server.key");
  const clientCertFile = join(dir, "client.crt");
  const clientKeyFile = join(dir, "client.key");
  const clientCert = readFileSync(clientCertFile, "utf8");

  return {
    dir,
    caCertFile,
    serverCertFile,
    serverKeyFile,
    clientCertFile,
    clientKeyFile,
    caCert: readFileSync(caCertFile, "utf8"),
    serverCert: readFileSync(serverCertFile, "utf8"),
    serverKey: readFileSync(serverKeyFile, "utf8"),
    clientCert,
    clientKey: readFileSync(clientKeyFile, "utf8"),
    clientFingerprint256: fingerprint256Of(clientCert),
  };
}
