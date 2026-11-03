#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -t 0 ]; then
  IFS= read -rsp 'FreshBooks client_secret: ' secret
  echo >&2
  printf '%s' "$secret" | node "$ROOT/lib/freshbooks/cli.mjs" store-secret "$@"
else
  exec node "$ROOT/lib/freshbooks/cli.mjs" store-secret "$@"
fi
