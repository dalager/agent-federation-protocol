#!/usr/bin/env bash
# ADR-0034 Decision 2 — replays every fixture in `fixtures/` per its
# `VERIFY.json`, exactly as `src/instance/test/fixtures.test.ts` does. This is
# the one script CI and a human both run; it needs only python3 and
# `cryptography` installed, no Node.
#
#   scripts/verify-fixtures.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
verifier="$repo_root/src/verifier/afp_verify.py"
fixtures_dir="$repo_root/fixtures"

status=0
for verify_json in "$fixtures_dir"/*/VERIFY.json; do
  fixture_dir="$(dirname "$verify_json")"
  name="$(basename "$fixture_dir")"

  mapfile -t bundles < <(python3 -c "
import json
doc = json.load(open('$verify_json'))
for b in doc['bundles']:
    print(b)
")
  thread="$(python3 -c "
import json
doc = json.load(open('$verify_json'))
print(doc['thread'] or '')
")"

  args=()
  for b in "${bundles[@]}"; do
    args+=("$fixture_dir/$b")
  done
  if [ -n "$thread" ]; then
    args+=(--thread "$thread")
  fi

  echo "== $name =="
  if ! python3 "$verifier" "${args[@]}"; then
    status=1
  fi
  echo
done

exit "$status"
