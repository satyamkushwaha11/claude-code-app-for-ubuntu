#!/usr/bin/env bash
# Launches Claude Code Studio.
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON="$DIR/node_modules/.bin/electron"

if [ ! -x "$ELECTRON" ]; then
  echo "Dependencies are not installed. Run:  cd \"$DIR\" && npm install" >&2
  exit 1
fi

exec "$ELECTRON" --no-sandbox "$DIR" "$@"
