#!/usr/bin/env node
/**
 * ADR-0034 Decision 2 — "the link-and-anchor check the documentation sync
 * introduced" (which did not exist before this file: this is it).
 *
 * Walks every `*.md` under `docs/` plus the root/instance/verifier READMEs.
 * For each relative markdown link `[text](path#anchor)`:
 *   - `http(s):` links and images (`![...]`) are skipped;
 *   - a `path` component is resolved against the linking file's own
 *     directory and must exist on disk;
 *   - an `#anchor` (with or without a `path`) must match the GitHub slug of
 *     some heading in the target file (the linking file itself, when there
 *     is no `path`) — the same slug rule `test/adr0030.test.ts` already
 *     computes: lowercase, strip everything but letters/digits/spaces/
 *     hyphens, spaces to hyphens, and a repeated slug gets `-1`, `-2`, ...
 *     the way GitHub disambiguates duplicate headings.
 *
 * Prints every broken link as `file:line: [text](target) → reason` and
 * exits 1 if any were found; exits 0 (silently) otherwise.
 *
 *   node scripts/check-links.mjs
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWLIST_PATH = join(REPO_ROOT, "scripts", "check-links.allow");

/** Every markdown link, `[text](target)`, with its 1-based line number. */
const LINK_RE = /(!)?\[([^\]]*)\]\(([^)]+)\)/g;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

function walkMarkdown(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkMarkdown(full, out);
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

function targetFiles() {
  const files = walkMarkdown(join(REPO_ROOT, "docs"));
  for (const readme of [
    join(REPO_ROOT, "README.md"),
    join(REPO_ROOT, "src", "instance", "README.md"),
    join(REPO_ROOT, "src", "verifier", "README.md"),
  ]) {
    if (existsSync(readme)) files.push(readme);
  }
  return files;
}

/** GitHub's heading-to-anchor rule (see `test/adr0030.test.ts`'s `slugOf`),
 * extended with GitHub's own de-duplication suffix for repeated headings. */
function slugsOf(markdown) {
  const seen = new Map();
  const slugs = new Set();
  for (const line of markdown.split("\n")) {
    const match = HEADING_RE.exec(line);
    if (!match) continue;
    // GitHub's actual rule collapses no whitespace: "Foo & Bar" strips "&"
    // (leaving two adjacent spaces) and then turns *each* space into its own
    // hyphen, giving "foo--bar" — not "foo-bar". `test/adr0030.test.ts`'s
    // `slugOf` collapses runs of whitespace first; that reading never
    // surfaces there because none of ADR-0030's own headings contain
    // ampersands, but it disagrees with GitHub (and every existing doc
    // link) here, so this checker uses the ungrouped, GitHub-accurate form.
    const base = match[2]
      .toLowerCase()
      .replace(/[^a-z0-9 \-]/g, "")
      .trim()
      .replace(/ /g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    slugs.add(count === 0 ? base : `${base}-${count}`);
  }
  return slugs;
}

function loadAllowlist() {
  if (!existsSync(ALLOWLIST_PATH)) return new Set();
  return new Set(
    readFileSync(ALLOWLIST_PATH, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#")),
  );
}

function main() {
  const allowlist = loadAllowlist();
  const slugCache = new Map(); // absolute file path -> Set<slug>
  const slugsFor = (file) => {
    if (!slugCache.has(file)) {
      slugCache.set(file, existsSync(file) ? slugsOf(readFileSync(file, "utf8")) : new Set());
    }
    return slugCache.get(file);
  };

  const problems = [];

  for (const file of targetFiles()) {
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");

    lines.forEach((line, index) => {
      LINK_RE.lastIndex = 0;
      let match;
      while ((match = LINK_RE.exec(line)) !== null) {
        const [, isImage, linkText, target] = match;
        if (isImage) continue;
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http(s):, mailto:, etc.

        const [rawPath, anchor] = target.split("#");
        const rel = relative(REPO_ROOT, file);
        const key = `${rel}:${index + 1}: [${linkText}](${target})`;
        if (allowlist.has(key)) return;

        let targetFile = file;
        if (rawPath) {
          const resolved = resolve(dirname(file), rawPath);
          if (!existsSync(resolved)) {
            problems.push(`${key} → no such file: ${relative(REPO_ROOT, resolved)}`);
            return;
          }
          if (statSync(resolved).isDirectory()) {
            // A bare directory link (e.g. `[adr/](adr/)`) needs no README —
            // GitHub renders the listing. An anchor on one, though, needs
            // something to check headings against.
            const indexReadme = join(resolved, "README.md");
            if (anchor && !existsSync(indexReadme)) {
              problems.push(`${key} → directory has no README.md to anchor "#${anchor}" into: ${relative(REPO_ROOT, resolved)}`);
              return;
            }
            targetFile = indexReadme;
          } else {
            targetFile = resolved;
          }
        }

        if (anchor && targetFile.endsWith(".md")) {
          const slugs = slugsFor(targetFile);
          if (!slugs.has(anchor)) {
            problems.push(`${key} → no heading slug "#${anchor}" in ${relative(REPO_ROOT, targetFile)}`);
          }
        }
      }
    });
  }

  if (problems.length) {
    for (const p of problems) console.error(p);
    console.error(`\n${problems.length} broken link(s)`);
    process.exitCode = 1;
    return;
  }

  console.log(`ok — every relative link and anchor resolved (${targetFiles().length} files checked)`);
}

main();
