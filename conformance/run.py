#!/usr/bin/env python3
"""ADR-0034 Decision 3 — the reference conformance runner.

Stdlib-only. For every `bundles/*.json` it invokes a verifier command over the
named fixture and requires the declared verdict; for every `mutations/*.json`
it copies the fixture to a temp directory, applies one language-neutral edit
to an outbox, and requires a failing line matching one of the expected
regexes. A third implementation plugs in with `--verifier`:

    python3 conformance/run.py
    python3 conformance/run.py --verifier "go run ./cmd/afp-verify"

Exit status is 0 only if every bundle and every mutation agrees with what the
kit says it must. See `conformance/README.md` for the file layout and the
runner contract a third implementation's own verifier must satisfy.
"""

from __future__ import annotations

import argparse
import json
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

KIT_ROOT = Path(__file__).resolve().parent
REPO_ROOT = KIT_ROOT.parent
DEFAULT_VERIFIER = f"{sys.executable} {REPO_ROOT / 'src' / 'verifier' / 'afp_verify.py'}"


def run_verifier(verifier_cmd: str, export_dirs: list[Path], thread: str | None) -> tuple[int, str]:
    argv = shlex.split(verifier_cmd) + [str(d) for d in export_dirs]
    if thread:
        argv += ["--thread", thread]
    proc = subprocess.run(argv, capture_output=True, text=True)
    return proc.returncode, proc.stdout + proc.stderr


def get_path(doc: dict, dotted: str):
    node = doc
    for part in dotted.split("."):
        node = node[int(part)] if part.isdigit() else node[part]
    return node


def set_path(doc: dict, dotted: str, value) -> None:
    parts = dotted.split(".")
    node = doc
    for part in parts[:-1]:
        node = node[int(part)] if part.isdigit() else node[part]
    last = parts[-1]
    if last.isdigit():
        node[int(last)] = value
    else:
        node[last] = value


def delete_path(doc: dict, dotted: str) -> None:
    parts = dotted.split(".")
    node = doc
    for part in parts[:-1]:
        node = node[int(part)] if part.isdigit() else node[part]
    last = parts[-1]
    if last.isdigit():
        del node[int(last)]
    else:
        node.pop(last, None)


def matches(item: dict, select: dict) -> bool:
    for key, want in select.items():
        if key == "objectType":
            obj = item.get("object")
            got = obj.get("type") if isinstance(obj, dict) else None
        elif key == "index":
            continue  # handled positionally by the caller
        else:
            got = item.get(key)
        if got != want:
            return False
    return True


def apply_mutation(bundle_dir: Path, mutation: dict) -> None:
    domain_dir = bundle_dir / mutation["domain"]
    outbox_path = domain_dir / "outbox" / f"{mutation['outbox']}.jsonld"
    doc = json.loads(outbox_path.read_text())
    items = doc["orderedItems"]

    select = mutation.get("select", {})
    if "index" in select:
        idx = select["index"]
        selected = [items[idx]] if 0 <= idx < len(items) and matches(items[idx], select) else []
    else:
        selected = [item for item in items if matches(item, select)]

    op = mutation["op"]
    path = mutation.get("path")

    if op == "filter":
        if path:
            for item in selected:
                arr = get_path(item, path)
                match = mutation["match"]
                arr[:] = [entry for entry in arr if not all(entry.get(k) == v for k, v in match.items())]
        else:
            doc["orderedItems"] = [item for item in items if item not in selected]
    elif op == "set":
        for item in selected:
            set_path(item, path, mutation["value"])
    elif op == "delete":
        for item in selected:
            delete_path(item, path)
    elif op == "append":
        value = mutation["value"]
        if path:
            for item in selected:
                get_path(item, path).append(value)
        else:
            doc["orderedItems"].append(value)
    else:
        raise ValueError(f"unknown mutation op {op!r}")

    doc["totalItems"] = len(doc["orderedItems"])
    outbox_path.write_text(json.dumps(doc, indent=2))


def check_bundle(verifier_cmd: str, spec_path: Path) -> tuple[bool, str]:
    spec = json.loads(spec_path.read_text())
    export_dirs = [(KIT_ROOT / spec["fixture"] / b).resolve() for b in spec["bundles"]]
    code, output = run_verifier(verifier_cmd, export_dirs, spec.get("thread"))
    ok = (code == 0) == (spec["verdict"] == "pass")
    return ok, output if not ok else ""


def check_mutation(verifier_cmd: str, spec_path: Path) -> tuple[bool, str]:
    mutation = json.loads(spec_path.read_text())
    bundle_spec = json.loads((KIT_ROOT / "bundles" / f"{mutation['bundle']}.json").read_text())

    with tempfile.TemporaryDirectory(prefix="afp-conformance-") as tmp:
        tmp_root = Path(tmp) / "bundle"
        shutil.copytree((KIT_ROOT / bundle_spec["fixture"]).resolve(), tmp_root)
        apply_mutation(tmp_root, mutation)

        export_dirs = [tmp_root / b for b in bundle_spec["bundles"]]
        code, output = run_verifier(verifier_cmd, export_dirs, bundle_spec.get("thread"))

        expect = mutation["expect"]
        verdict_ok = (code == 0) == (expect["verdict"] == "pass")
        failing_ok = expect["verdict"] != "fail" or any(
            re.search(pattern, output) for pattern in expect["failing"]
        )
        ok = verdict_ok and failing_ok
        return ok, output if not ok else ""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--verifier",
        default=DEFAULT_VERIFIER,
        help=f"verifier command to invoke (default: {DEFAULT_VERIFIER!r})",
    )
    args = parser.parse_args()

    rows: list[tuple[str, bool, str]] = []
    for spec_path in sorted((KIT_ROOT / "bundles").glob("*.json")):
        ok, detail = check_bundle(args.verifier, spec_path)
        rows.append((f"bundle  {spec_path.stem}", ok, detail))
    for spec_path in sorted((KIT_ROOT / "mutations").glob("*.json")):
        ok, detail = check_mutation(args.verifier, spec_path)
        rows.append((f"mutation {spec_path.stem}", ok, detail))

    width = max(len(name) for name, _, _ in rows)
    failures = 0
    for name, ok, detail in rows:
        status = "PASS" if ok else "FAIL"
        print(f"{name.ljust(width)}  {status}")
        if not ok:
            failures += 1
            print(f"  {detail.strip()[:2000]}")

    print()
    if failures:
        print(f"FAILED — {failures} of {len(rows)} conformance case(s) disagree with the kit")
        return 1
    print(f"PASSED — {len(rows)} conformance case(s), no disagreement")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
