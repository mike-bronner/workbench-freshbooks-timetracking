#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ "${1:-}" = "--dialog" ]; then
  shift
  secret="$(osascript \
    -e 'set answer to display dialog "Paste the client secret of your FreshBooks app. It goes straight to the macOS keychain." default answer "" with hidden answer with title "workbench-freshbooks-timetracking" buttons {"Cancel", "Save"} default button "Save" cancel button "Cancel"' \
    -e 'text returned of answer')"
  printf '%s' "$secret" | node "$ROOT/lib/freshbooks/cli.mjs" store-secret "$@"
elif [ -t 0 ]; then
  IFS= read -rsp 'FreshBooks client_secret: ' secret
  echo >&2
  printf '%s' "$secret" | node "$ROOT/lib/freshbooks/cli.mjs" store-secret "$@"
else
  exec node "$ROOT/lib/freshbooks/cli.mjs" store-secret "$@"
fi
