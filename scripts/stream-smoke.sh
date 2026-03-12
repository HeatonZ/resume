#!/usr/bin/env bash
set -euo pipefail

API_BASE_URL="${API_BASE_URL:-http://localhost:8000}"
PROVIDER="${PROVIDER:-kimi}"
MESSAGE="${MESSAGE:-请用三句话介绍候选人的项目经验}"
HISTORY_JSON="${HISTORY_JSON:-[]}"

payload=$(cat <<JSON
{"message":"${MESSAGE}","history":${HISTORY_JSON},"provider":"${PROVIDER}"}
JSON
)

echo "[stream-smoke] POST ${API_BASE_URL}/api/chat/stream provider=${PROVIDER}"
echo "[stream-smoke] Expectation: first token arrives quickly and token events > 1"

curl --no-buffer -N -sS \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -X POST "${API_BASE_URL}/api/chat/stream" \
  -d "${payload}" | tee /tmp/stream-events.log

token_count=$(grep -c "^event: token$" /tmp/stream-events.log || true)
done_count=$(grep -c "^event: done$" /tmp/stream-events.log || true)

echo "[stream-smoke] token_event_count=${token_count} done_event_count=${done_count}"
if [[ "${token_count}" -le 1 ]]; then
  echo "[stream-smoke] FAIL: token_event_count <= 1, possible non-incremental streaming"
  exit 1
fi
if [[ "${done_count}" -lt 1 ]]; then
  echo "[stream-smoke] FAIL: missing done event"
  exit 1
fi

echo "[stream-smoke] PASS"
