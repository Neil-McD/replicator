#!/usr/bin/env bash
set -euo pipefail

echo "== Supabase connectivity check =="

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing: $1"; exit 1; }; }
need curl

: "${SUPABASE_URL:?SUPABASE_URL not set (expect https://<ref>.supabase.co)}"
: "${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY not set}"

if [[ "$SUPABASE_URL" =~ ^postgres ]] ; then
  echo "ERROR: SUPABASE_URL looks like a Postgres DSN. Use https://<ref>.supabase.co"
  exit 1
fi

rest="$SUPABASE_URL/rest/v1/orders?status=eq.new&select=id"
echo "- REST check: $rest"
set +e
resp=$(curl -sS -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" "$rest")
code=$?
set -e
if [[ $code -ne 0 ]]; then
  echo "ERROR: REST call failed (curl exit $code)."
  exit $code
fi
echo "  OK: received response: ${resp:0:120}..."

bucket="${SUPABASE_STORAGE_BUCKET:-artifacts}"
echo "- Storage write URL would be: $SUPABASE_URL/storage/v1/object/$bucket/<path>"
echo "  (Skipping write test; run worker to exercise uploads)"

echo "All checks passed."

