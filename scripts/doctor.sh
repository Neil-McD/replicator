#!/usr/bin/env bash
set -euo pipefail

# Lightweight environment check for the worker stack.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "== Doctor: Environment Check =="

has() { command -v "$1" >/dev/null 2>&1; }

ok()  { printf "[ ok ] %s\n" "$1"; }
bad() { printf "[ !! ] %s\n" "$1"; }

if has blender; then blender --version | head -n1 | sed 's/^/[ ok ] /'; else bad "blender not found"; fi
if has admesh;  then admesh --version | head -n1 | sed 's/^/[ ok ] /'; else bad "admesh not found (sudo apt-get install admesh)"; fi
if has meshfix; then ok "meshfix present: $(command -v meshfix)"; else bad "meshfix not found (run scripts/install-mesh-tools.sh)"; fi
if has python3; then ok "python3 $(python3 --version 2>&1 | awk '{print $2}')"; else bad "python3 not found"; fi

# Verify worker/.env present
if [ -f "$ROOT_DIR/worker/.env" ]; then
  ok "worker/.env present"
else
  bad "worker/.env missing (copy worker/.env.example)"
fi

# Minimal Supabase env presence
source "$ROOT_DIR/worker/.env" 2>/dev/null || true
if [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  ok "SUPABASE_URL + SERVICE_ROLE_KEY set"
else
  bad "SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set in worker/.env"
fi

echo "== Doctor: Done =="
