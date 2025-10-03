#!/usr/bin/env bash
set -euo pipefail

# Dev helper: start web (Next.js) and the Python worker from repo root.
# Web runs in background; worker runs in foreground so Ctrl+C stops both.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# Start web in the background
(
  cd "$ROOT_DIR/web"
  if [ ! -d node_modules ]; then
    npm install
  fi
  npm run dev
) &
WEB_PID=$!

cleanup() {
  echo "\nStopping web (pid $WEB_PID)..."
  kill "$WEB_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# Start worker in foreground
"$ROOT_DIR/scripts/run-worker.sh"

