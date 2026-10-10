#!/usr/bin/env bash
# Stops the ChatGPT bridge server started by start.bash.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$ROOT/server/bridge.pid"
PORT="$(grep -E '^PORT=' "$ROOT/server/.env" 2>/dev/null | cut -d= -f2)"
PORT="${PORT:-8765}"

stopped=false
if [ -f "$PID_FILE" ]; then
  pid="$(cat "$PID_FILE")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    for _ in $(seq 1 10); do kill -0 "$pid" 2>/dev/null || break; sleep 0.3; done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid"
    stopped=true
  fi
  rm -f "$PID_FILE"
fi

# Also stop a server started some other way (e.g. `npm start`) on our port.
other="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$other" ] && ps -p "$other" -o command= | grep -q "node server.js"; then
  kill $other
  stopped=true
fi

if $stopped; then echo "ChatGPT bridge stopped."; else echo "ChatGPT bridge was not running."; fi
