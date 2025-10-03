#!/usr/bin/env bash
set -euo pipefail

# Run the Python worker from the repo root, always loading worker/.env

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found on PATH" >&2
  exit 1
fi

# Create venv if missing
if [ ! -d "$ROOT_DIR/worker/.venv" ]; then
  python3 -m venv "$ROOT_DIR/worker/.venv"
fi

source "$ROOT_DIR/worker/.venv/bin/activate"
pip install -q -r "$ROOT_DIR/worker/requirements.txt"

# Ensure env file exists
if [ ! -f "$ROOT_DIR/worker/.env" ]; then
  echo "warning: worker/.env not found — create it from worker/.env.example" >&2
fi

exec python "$ROOT_DIR/worker/main.py"

