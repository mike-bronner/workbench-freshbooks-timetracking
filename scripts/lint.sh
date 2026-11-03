#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

for tool in shellcheck jq git node; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "✗ $tool not found on PATH — required by the lint gate" >&2
    exit 1
  fi
done

fail=0

scripts=()
while IFS= read -r f; do scripts+=("$f"); done < <(find bin scripts tests -type f -name '*.sh' | sort)
echo "▶ shellcheck: ${#scripts[@]} script(s)"
if [ "${#scripts[@]}" -eq 0 ] || ! shellcheck "${scripts[@]}"; then
  echo "✗ shellcheck failed or found no scripts" >&2
  fail=1
fi

json_files=()
while IFS= read -r f; do json_files+=("$f"); done < <(git ls-files --cached --others --exclude-standard -- '*.json')
echo "▶ jq empty: ${#json_files[@]} JSON file(s)"
if [ "${#json_files[@]}" -eq 0 ]; then
  echo "✗ no JSON files found — refusing to report success having validated nothing" >&2
  fail=1
fi
for f in "${json_files[@]}"; do
  jq empty "$f" || { echo "✗ invalid JSON: $f" >&2; fail=1; }
done

modules=()
while IFS= read -r f; do modules+=("$f"); done < <(git ls-files --cached --others --exclude-standard -- '*.mjs')
echo "▶ node --check: ${#modules[@]} module(s)"
for f in "${modules[@]}"; do
  node --check "$f" || { echo "✗ syntax error: $f" >&2; fail=1; }
done

if [ "$fail" -ne 0 ]; then
  echo "✗ lint failed" >&2
  exit 1
fi
echo "✓ lint passed"
