#!/usr/bin/env bash
set -euo pipefail

# Recreate web/.env.local from worker/.env and a pasted anon key.
# Use this if web/.env.local was lost.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKER_ENV="$ROOT_DIR/worker/.env"
WEB_ENV_LOCAL="$ROOT_DIR/web/.env.local"

if [ ! -f "$WORKER_ENV" ]; then
  echo "worker/.env not found. Create worker/.env first (see worker/.env.example)." >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$WORKER_ENV" >/dev/null 2>&1 || true

URL="${SUPABASE_URL:-}"
SRK="${SUPABASE_SERVICE_ROLE_KEY:-}"
BUCKET="${SUPABASE_STORAGE_BUCKET:-artifacts}"

if [ -z "$URL" ] || [ -z "$SRK" ]; then
  echo "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in worker/.env" >&2
  exit 1
fi

echo "Paste your Supabase anon public key (from Dashboard → Settings → API):"
read -r ANON
if [ -z "$ANON" ]; then
  echo "Anon key is required." >&2
  exit 1
fi

mkdir -p "$ROOT_DIR/web"
cat > "$WEB_ENV_LOCAL" <<EOF
NEXT_PUBLIC_SUPABASE_URL=$URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON
SUPABASE_SERVICE_ROLE_KEY=$SRK
SUPABASE_STORAGE_BUCKET=$BUCKET
EOF

echo "Wrote $WEB_ENV_LOCAL"
echo "Restart the web app:  cd web && npm run dev"

