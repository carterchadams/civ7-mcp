#!/usr/bin/env bash
# Runs the Milestone D demonstration in an isolated, non-interactive Claude Code session
# whose built-in tool set is disabled (--tools "") and which can call ONLY the observation
# tool of the one MCP server in the given config (--strict-mcp-config, get_status denied).
# Usage: demo/run-demo.sh <config.json> <out.txt>
# Writes <out>.transcript.jsonl (stream-json) next to the report and exits with the
# provider's status; a failed or empty model run never exits 0.
set -u
cd "$(dirname "$0")/.."
CONFIG="${1:-demo/mcp-hotseat-player1.json}"
OUT="${2:-runs/demo-$(date +%Y%m%d-%H%M%S).txt}"
TRANSCRIPT="${OUT%.txt}.transcript.jsonl"
mkdir -p "$(dirname "$OUT")"

claude -p "$(cat demo/prompt.txt)" \
  --tools "" \
  --mcp-config "$CONFIG" --strict-mcp-config \
  --allowedTools "mcp__civ7-observer__get_observation" \
  --disallowedTools "mcp__civ7-observer__get_status" \
  --output-format stream-json --verbose > "$TRANSCRIPT"
STATUS=$?
if [ "$STATUS" -ne 0 ]; then
  echo "demo FAILED: claude exited $STATUS (transcript: $TRANSCRIPT)" >&2
  exit "$STATUS"
fi
if ! jq -e 'select(.type == "result")' "$TRANSCRIPT" >/dev/null 2>&1; then
  echo "demo FAILED: no result message in $TRANSCRIPT" >&2
  exit 1
fi
jq -r 'select(.type == "result") | .result // empty' "$TRANSCRIPT" > "$OUT"
if [ ! -s "$OUT" ]; then
  echo "demo FAILED: empty report (transcript: $TRANSCRIPT)" >&2
  exit 1
fi
echo "--- effective tools reported by the client at init:" >&2
jq -c 'select(.type == "system" and .subtype == "init") | {tools, mcp_servers}' "$TRANSCRIPT" >&2
echo "--- tool calls made during the run:" >&2
jq -r 'select(.type == "assistant") | .message.content[]? | select(.type == "tool_use") | .name' "$TRANSCRIPT" | sort | uniq -c >&2
cat "$OUT"
echo "saved: $OUT and $TRANSCRIPT" >&2
