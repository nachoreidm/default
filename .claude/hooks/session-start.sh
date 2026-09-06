#!/bin/bash
set -euo pipefail

# mcp-server/dist and node_modules are committed so the MCP server is
# launchable the instant the repo is cloned - the harness connects to it
# at session bootstrap, before this hook has a chance to run, so a build
# that only happened here would be too late for the current session
# anyway. This is just a safety net for drift: if src/ was edited without
# rebuilding+recommitting dist/, at least warn instead of silently running
# stale code. Cloud sessions only; local terminal sessions build manually
# per CLAUDE.md.
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
  echo "WARNING: mcp-server/dist looks stale relative to src/ or package.json." >&2
  echo "The already-running kraken-paper-trading MCP connection for this session" >&2
  echo "was made against the committed dist/, so rebuilding here won't fix it -" >&2
  echo "rebuild locally and commit mcp-server/dist (and node_modules if deps" >&2
  echo "changed) so the NEXT session starts from current code." >&2
fi
