/**
 * ADR-0034 Decision 1 — the one stated relationship between the instance's
 * semantic version and the spec revision it implements. Read once, from
 * `package.json`, so a release only has one place to bump; `ap/nodeinfo.ts`
 * (the software block counterparties fetch) and anything else that needs
 * either value imports from here rather than hand-syncing a literal.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

interface PackageJson {
  version: string;
  afp?: { specRevision?: string };
}

const packageJsonPath = join(import.meta.dirname, "..", "package.json");
const pkg: PackageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

export const INSTANCE_VERSION: string = pkg.version;
export const SPEC_REVISION: string = pkg.afp?.specRevision ?? "";

if (!SPEC_REVISION) {
  throw new Error(`${packageJsonPath}: missing "afp.specRevision" (ADR-0034 Decision 1)`);
}
