#!/bin/sh
# Prevent the claude-mem shared-worker leak on a timer. Two steps:
#   1. `ccprofiles plugins prune` — leave one claude-mem cache version per profile, so the plugin's
#      mtime-based hook resolver (ls -dt) can't launch a stale worker. See
#      packages/core/src/plugins.ts pruneStaleVersionDirs for the full why.
#   2. Reap any claude-mem worker/mcp still running from a version dir that step 1 just deleted, and
#      any chroma-mcp orphaned when no worker survives (chroma data is on disk — safe to kill).
# Invoked hourly by ~/Library/LaunchAgents/com.ccprofiles.claude-mem-prune.plist, which supplies a
# PATH that includes the node bin dir (machine-specific config belongs in the plist, not here).

ccprofiles plugins prune

# Kill workers/mcp whose plugin dir no longer exists on disk (was pruned away).
ps -eo pid=,command= | while IFS= read -r line; do
  pid=${line%% *}
  dir=$(printf '%s\n' "$line" | grep -oE '/[^ ]*/plugins/cache/thedotmack/claude-mem/[0-9][^/ ]*')
  [ -n "$dir" ] && [ ! -d "$dir" ] && kill "$pid" 2>/dev/null
done

# If no claude-mem worker survives, reap orphaned chroma-mcp children.
pgrep -f 'claude-mem/[0-9].*worker-service' >/dev/null 2>&1 || pkill -f 'chroma-mcp' 2>/dev/null

exit 0
