#!/usr/bin/env bash
set -euo pipefail

cd "${1:-$(dirname "${BASH_SOURCE[0]}")/..}"

fail=0
skills=()
while IFS= read -r f; do skills+=("$f"); done < <(find skills -type f -name 'SKILL.md' | sort)
echo "▶ skills: ${#skills[@]} skill(s)"
if [ "${#skills[@]}" -eq 0 ]; then
  echo "✗ no skills found" >&2
  fail=1
fi
for f in "${skills[@]}"; do
  dir="$(basename "$(dirname "$f")")"
  if ! front="$(awk 'NR == 1 && $0 != "---" { exit } NR > 1 && $0 == "---" { closed = 1; exit } NR > 1 { print } END { exit !closed }' "$f")"; then
    echo "✗ $f: frontmatter must open on line 1 with --- and close with ---" >&2
    fail=1
  fi
  if ! grep -qx "name: $dir" <<<"$front"; then
    echo "✗ $f: frontmatter name must be $dir" >&2
    fail=1
  fi
  if ! grep -qE '^description: .+' <<<"$front"; then
    echo "✗ $f: frontmatter needs a description" >&2
    fail=1
  fi
  while IFS= read -r ref; do
    case "$ref" in
      "\${CLAUDE_PLUGIN_ROOT}/bin/"*) [ -f "bin/${ref##*/}" ] || { echo "✗ $f: $ref names no script in bin/" >&2; fail=1; } ;;
      *) echo "✗ $f: $ref must be reached as \${CLAUDE_PLUGIN_ROOT}/bin/<script>.sh" >&2; fail=1 ;;
    esac
  done < <(grep -oE '[^ "`'"'"'(]*bin/[A-Za-z0-9_-]+\.sh' "$f")
done

exit "$fail"
