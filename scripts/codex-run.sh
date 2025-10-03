#!/usr/bin/env bash
set -euo pipefail

# Wrapper to start Codex CLI with desired model and policies.
# Usage: scripts/codex-run.sh [additional-codex-args]

exec codex \
  --model gpt-5 \
  --reasoning high \
  --dangerously-bypass-approval \
  "$@"

