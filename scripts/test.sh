#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

for tool in node git; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "✗ $tool not found on PATH" >&2
    exit 1
  fi
done

tests=()
if [ "$#" -gt 0 ]; then
  tests=("$@")
else
  while IFS= read -r f; do tests+=("$f"); done < <(find tests -type f -name '*.test.mjs' | sort)
fi

if [ "${#tests[@]}" -eq 0 ]; then
  echo "✗ no test files found — refusing to report success having run nothing" >&2
  exit 1
fi

echo "▶ node: ${#tests[@]} file(s)"
TZ=UTC node --test "${tests[@]}"
echo "✓ all tests passed"
