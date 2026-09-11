#!/usr/bin/env sh
# Runs the Milestone D demonstration in an isolated, non-interactive Claude Code session
# that can see ONLY the observation tool. Usage: demo/run-demo.sh <config.json> <out.txt>
set -e
cd "$(dirname "$0")/.."
CONFIG="${1:-demo/mcp-hotseat-player1.json}"
OUT="${2:-runs/demo-$(date +%Y%m%d-%H%M%S).txt}"
mkdir -p runs
claude -p "$(cat demo/prompt.txt)" \
  --mcp-config "$CONFIG" --strict-mcp-config \
  --allowedTools "mcp__civ7-observer__get_observation" \
  --disallowedTools "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Agent,mcp__civ7-observer__get_status" \
  --output-format text | tee "$OUT"
echo "saved: $OUT" >&2
