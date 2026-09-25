#!/usr/bin/env bash
# Launches Claude Code Studio.
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON="$DIR/node_modules/.bin/electron"

if [ ! -x "$ELECTRON" ]; then
  echo "Dependencies are not installed. Run:  cd \"$DIR\" && npm install" >&2
  exit 1
fi

# VS Code (and other Electron apps) export this to their terminals; with it set,
# Electron starts as plain Node and the app crashes on `app.commandLine`.
unset ELECTRON_RUN_AS_NODE

exec "$ELECTRON" --no-sandbox "$DIR" "$@"
