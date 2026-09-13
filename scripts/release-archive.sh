#!/usr/bin/env bash
# ADR-0034 Decision 4 — the checksummed source archive for the auditor who
# will not install anything: `tar xzf`, then `python3 afp_verify.py` with no
# build step, no package, no network. Built from `git archive` (tracked files
# only, so `test/`, `__pycache__/`, and `ruvector.db` are excluded without a
# separate exclude list) over `src/verifier`, at the version `version.py`
# names.
#
#   scripts/release-archive.sh
#
# Produces dist/afp-verify-<version>.tar.gz and dist/SHA256SUMS, and prints
# the digest.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
verifier_dir="$repo_root/src/verifier"

version="$(python3 -c "import sys; sys.path.insert(0, '$verifier_dir'); from version import VERSION; print(VERSION)")"
name="afp-verify-$version"

dist_dir="$repo_root/dist"
mkdir -p "$dist_dir"

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

# `git archive` walks the index. `test/` and `ruvector.db` are tracked (an
# auditor's copy-the-directory path never needed them excluded before), so
# they are named out explicitly here — the one place the archive's contents
# differ from a checkout.
git -C "$repo_root" archive --format=tar HEAD \
  -- src/verifier \
  ':!src/verifier/test' \
  ':!src/verifier/ruvector.db' \
  | tar -x -C "$work_dir"
mv "$work_dir/src/verifier" "$work_dir/$name"

archive_path="$dist_dir/$name.tar.gz"
tar -czf "$archive_path" -C "$work_dir" "$name"

(
  cd "$dist_dir"
  sha256sum "$(basename "$archive_path")" > SHA256SUMS
)

echo "built $archive_path"
echo
cat "$dist_dir/SHA256SUMS"
