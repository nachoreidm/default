#!/bin/bash
set -euo pipefail

# Only auto-build in Claude Code on the web / cloud sessions. Local
# terminal sessions build manually per CLAUDE.md so a dev keeps control
# over when reinstalls happen.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR/mcp-server"

needs_build=0
if [ ! -f dist/index.js ]; then
  needs_build=1
elif [ package.json -nt dist/index.js ]; then
  needs_build=1
elif find src -newer dist/index.js -print -quit | grep -q .; then
  needs_build=1
fi

if [ "$needs_build" -eq 1 ]; then
  npm install
  npm run build
fi
