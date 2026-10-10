#!/usr/bin/env bash
# Starts the ChatGPT bridge server in the background.
#   ./start.bash          start (or report that it's already running)
#   ./start.bash -f       run in the foreground (Ctrl+C to stop)
# Settings live in server/.env (created on first run with a random API key).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SERVER="$ROOT/server"
ENV_FILE="$SERVER/.env"
PID_FILE="$SERVER/bridge.pid"
LOG_FILE="$SERVER/bridge.log"

command -v node >/dev/null || { echo "Node.js is not installed (need v20+)." >&2; exit 1; }

if [ ! -f "$ENV_FILE" ]; then
  umask 077
  cat > "$ENV_FILE" <<ENV
# ChatGPT bridge settings (loaded by start.bash)
API_KEY=sk-local-$(openssl rand -hex 18)
PORT=8765
HOST=127.0.0.1
# JOB_TIMEOUT_MS=600000
# PLAIN_TEXT=1
ENV
  echo "Created $ENV_FILE with a new API key."
fi
set -a; . "$ENV_FILE"; set +a
PORT="${PORT:-8765}"; HOST="${HOST:-127.0.0.1}"

if [ ! -d "$SERVER/node_modules" ]; then
  echo "Installing server dependencies…"
  (cd "$SERVER" && npm install --silent)
fi

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Already running (pid $(cat "$PID_FILE")) at http://$HOST:$PORT/v1"
  exit 0
fi
if lsof -iTCP:"$PORT" -sTCP:LISTEN -n -P >/dev/null 2>&1; then
  echo "Port $PORT is already in use by another process. Run ./stop.bash or change PORT in $ENV_FILE." >&2
  exit 1
fi

if [ "${1:-}" = "-f" ] || [ "${1:-}" = "--foreground" ]; then
  cd "$SERVER" && exec node server.js
fi

cd "$SERVER"
nohup node server.js >> "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"

for _ in $(seq 1 20); do
  if curl -fs "http://$HOST:$PORT/health" >/dev/null 2>&1; then
    echo "ChatGPT bridge started (pid $(cat "$PID_FILE"))"
    echo "  Base URL : http://$HOST:$PORT/v1"
    echo "  API key  : $API_KEY"
    echo "  Logs     : tail -f $LOG_FILE"
    echo "  Health   : curl http://$HOST:$PORT/health"
    exit 0
  fi
  sleep 0.5
done
echo "Server did not come up; last log lines:" >&2
tail -20 "$LOG_FILE" >&2
exit 1
