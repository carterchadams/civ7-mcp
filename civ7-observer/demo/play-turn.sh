#!/usr/bin/env bash
# Lets a model play one turn of the bound seat through the civ7 MCP tools, with the built-in tool
# set disabled and only the four action tools allowed. Usage: demo/play-turn.sh <config.json> <out>
# Exits with the provider's status; a failed or empty run never exits 0.
set -u
cd "$(dirname "$0")/.."
CONFIG="${1:-demo/mcp-acting-seat0.json}"
OUT="${2:-runs/play-turn-$(date +%Y%m%d-%H%M%S).txt}"
TRANSCRIPT="${OUT%.txt}.transcript.jsonl"
mkdir -p "$(dirname "$OUT")"

claude -p "$(cat demo/play-turn-prompt.txt)" \
  --tools "" \
  --mcp-config "$CONFIG" --strict-mcp-config \
  --allowedTools "mcp__civ7__get_turn_brief" "mcp__civ7__list_actions" "mcp__civ7__perform_action" "mcp__civ7__get_action_result" \
  --disallowedTools "mcp__civ7__get_observation" "mcp__civ7__get_status" \
  --output-format stream-json --verbose > "$TRANSCRIPT"
STATUS=$?
if [ "$STATUS" -ne 0 ]; then
  echo "play-turn FAILED: claude exited $STATUS (transcript: $TRANSCRIPT)" >&2
  exit "$STATUS"
fi
jq -r 'select(.type == "result") | .result // empty' "$TRANSCRIPT" > "$OUT"
if [ ! -s "$OUT" ]; then
  echo "play-turn FAILED: empty report (transcript: $TRANSCRIPT)" >&2
  exit 1
fi
echo "--- effective tools at init:" >&2
jq -c 'select(.type == "system" and .subtype == "init") | {tools, mcp_servers}' "$TRANSCRIPT" >&2
echo "--- tool calls made:" >&2
jq -r 'select(.type == "assistant") | .message.content[]? | select(.type == "tool_use") | .name' "$TRANSCRIPT" | sort | uniq -c >&2
cat "$OUT"
echo "saved: $OUT and $TRANSCRIPT" >&2
