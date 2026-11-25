#!/bin/sh
# Context Flow. The client (Codex, Claude Code) calls this each time something is said to a session.
# Nearly always no piece is waiting for any session, and then this ends here, before node is started.
home="${CONTEXT_FLOW_HOME:-$HOME/.context-flow}"
[ -d "$home/pending" ] || exit 0
[ -n "$(ls "$home/pending" 2>/dev/null)" ] || exit 0
here="$(cd "$(dirname "$0")" && pwd)"
# The node the screen's server runs on is written down when a piece is set to wait: a client started from the
# desktop may not have node on its PATH.
kept="$(cat "$home/node" 2>/dev/null)"
for node in "$CONTEXT_FLOW_NODE" "$kept" "$CODEX_MCP_NODE_PATH" node /opt/homebrew/bin/node /usr/local/bin/node; do
  [ -n "$node" ] && command -v "$node" >/dev/null 2>&1 && exec "$node" "$here/along.mjs"
done
# No node to run on: say so where it can be found, and let the prompt go as it was typed.
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) no node to run the hook on (PATH=$PATH)" >> "$home/hook.log" 2>/dev/null
exit 0
