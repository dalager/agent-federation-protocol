#!/usr/bin/env bash
# ADR-0034 Decision 6 — a release is a tag whose notes name the spec revision,
# the conformance-kit version, and the digests of the fixture bundles it was
# gated against. The tag is signed with a release key; a release is signed or
# it is not a release, so this script refuses without a configured signing
# key rather than falling back to an unsigned tag.
#
#   scripts/release.sh <version>              # bump, tag, sign
#   scripts/release.sh <version> --dry-run     # everything but bump and tag
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

version="${1:-}"
dry_run=false
for arg in "$@"; do
  [ "$arg" = "--dry-run" ] && dry_run=true
done

if [ -z "$version" ]; then
  echo "usage: scripts/release.sh <version> [--dry-run]" >&2
  exit 1
fi

fail() { echo "refusing: $1" >&2; exit 1; }

echo "== checking the tree is clean =="
if [ -n "$(git status --porcelain)" ]; then
  fail "working tree is not clean — a release is cut from a clean commit"
fi

echo "== npm test (src/instance) =="
(cd src/instance && npm test)

echo "== scripts/verify-fixtures.sh =="
scripts/verify-fixtures.sh >/dev/null

echo "== python3 conformance/run.py =="
python3 conformance/run.py >/dev/null

echo "== node scripts/check-links.mjs =="
node scripts/check-links.mjs >/dev/null

echo "all gates green"

signing_key="$(git config user.signingkey || true)"
if [ -z "$signing_key" ] && [ "$dry_run" = false ]; then
  fail "no git config user.signingkey set — a release is signed or it is not a release"
fi
if [ -z "$signing_key" ]; then
  echo "(dry run: no signing key configured — the real run would refuse here; continuing to show what the notes would say)"
fi

echo "== building the release archive =="
scripts/release-archive.sh >/dev/null
archive_sha="$(cd dist && sha256sum afp-verify-*.tar.gz | awk '{print $1}')"
archive_name="$(cd dist && ls afp-verify-*.tar.gz)"

spec_revision="$(python3 -c "import json; print(json.load(open('src/instance/package.json'))['afp']['specRevision'])")"
kit_version="$(cat conformance/VERSION | tr -d '[:space:]')"

manifest_lines=""
while IFS= read -r manifest; do
  sha="$(sha256sum "$manifest" | awk '{print $1}')"
  manifest_lines="$manifest_lines$sha  ${manifest#"$repo_root"/}"$'\n'
done < <(find fixtures -name MANIFEST.json | sort)

notes_file="$(mktemp)"
trap 'rm -f "$notes_file"' EXIT
{
  echo "AFP $version"
  echo
  echo "Spec revision: $spec_revision"
  echo "Conformance kit version: $kit_version"
  echo
  echo "Verifier archive: $archive_name"
  echo "  sha256  $archive_sha"
  echo
  echo "Fixture bundle manifests gated against:"
  printf '%s' "$manifest_lines"
} > "$notes_file"

echo
echo "== tag notes =="
cat "$notes_file"

if [ "$dry_run" = true ]; then
  echo
  echo "(dry run — did not bump versions, did not tag, did not sign)"
  exit 0
fi

echo "== bumping versions to $version =="
node -e "
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('src/instance/package.json', 'utf8'));
p.version = '$version';
fs.writeFileSync('src/instance/package.json', JSON.stringify(p, null, 2) + '\n');
"
sed -i.bak "s/^VERSION = \".*\"/VERSION = \"$version\"/" src/verifier/version.py
rm -f src/verifier/version.py.bak

echo "== tagging v$version (signed) =="
git tag -s "v$version" -F "$notes_file"

echo
echo "done. This script does not push — push the tag yourself:"
echo "  git push origin v$version"
