#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

echo "Checking environment..."

# Load worker/.env if present to populate CLI/profile vars
if [ -f "$HERE/.env" ]; then
  set -a
  # shellcheck source=/dev/null
  if ! . "$HERE/.env"; then
    echo "ERROR: Failed to parse worker/.env (invalid shell syntax)." >&2
    echo "- Ensure each line is KEY=value and quote values with spaces/parentheses." >&2
    echo "  e.g., BAMBU_STUDIO_CLI=\"/mnt/c/Program Files/Bambu Studio/BambuStudio.exe\"" >&2
    echo "  or   BAMBU_STUDIO_CLI=\"/mnt/c/Program Files (x86)/Bambu Studio/BambuStudio.exe\"" >&2
    exit 1
  fi
  set +a
  echo "- Loaded env from worker/.env"
fi

need() { command -v "$1" >/dev/null 2>&1; }

echo "- Python: $(python3 --version 2>/dev/null || echo 'not found')"
echo "- httpx/tenacity will be installed via requirements.txt"

echo "- meshfix: $(command -v meshfix || echo 'not found')"
echo "- admesh: $(command -v admesh || echo 'not found')"
echo "- blender: $(command -v blender || echo 'not found')"
echo "- AUTO_BASE_TRIM_MM: ${AUTO_BASE_TRIM_MM:-unset}"

# Resolve Bambu Studio CLI path (Linux/macOS)
is_wsl() { grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null || [ -n "${WSL_DISTRO_NAME:-}" ]; }

resolve_bambu_cli() {
  local cli_candidate cli
  # If env set and points to a file or command, use it
  if [ -n "${BAMBU_STUDIO_CLI:-}" ]; then
    cli_candidate="${BAMBU_STUDIO_CLI}"
    if [[ "$cli_candidate" == */* ]]; then
      # On WSL, Windows files under /mnt may not have +x; accept existing file
      if [ -x "$cli_candidate" ] || [ -f "$cli_candidate" ]; then echo "$cli_candidate"; return 0; fi
    else
      cli="$(command -v "$cli_candidate" 2>/dev/null || true)"
      if [ -n "$cli" ]; then echo "$cli"; return 0; fi
    fi
  fi
  # Try PATH names (Linux packages)
  for name in BambuStudio bambu-studio; do
    cli="$(command -v "$name" 2>/dev/null || true)"
    if [ -n "$cli" ]; then echo "$cli"; return 0; fi
  done
  # macOS app bundle default
  if [ -f "/Applications/Bambu Studio.app/Contents/MacOS/Bambu Studio" ]; then
    echo "/Applications/Bambu Studio.app/Contents/MacOS/Bambu Studio"; return 0
  fi
  # WSL: probe common Windows install locations if not explicitly set
  if is_wsl; then
    for p in \
      "/mnt/c/Program Files/Bambu Studio/Bambu Studio.exe" \
      "/mnt/c/Program Files/Bambu Studio/BambuStudio.exe" \
      "/mnt/c/Program Files/Bambu Studio/bambu-studio.exe" \
      "/mnt/c/Program Files (x86)/Bambu Studio/Bambu Studio.exe" \
      "/mnt/c/Program Files (x86)/Bambu Studio/BambuStudio.exe" \
      "/mnt/c/Program Files (x86)/Bambu Studio/bambu-studio.exe"; do
      if [ -f "$p" ]; then echo "$p"; return 0; fi
    done
  fi
  return 1
}

BAMBU_CLI_PATH="$(resolve_bambu_cli || true)"
if [ -n "$BAMBU_CLI_PATH" ]; then
  echo "- BambuStudio CLI: $BAMBU_CLI_PATH"
  # Quick stat for visibility (permissions/exists)
  if [ -e "$BAMBU_CLI_PATH" ]; then ls -l "$BAMBU_CLI_PATH" 2>/dev/null || true; fi
else
  echo "- BambuStudio CLI: not found (set BAMBU_STUDIO_CLI or add to PATH)"
fi

# Resolve profile path (default to repo profiles/x1c_pla_024.3mf)
PROFILE_PATH="${BAMBUSTUDIO_PROFILE_PATH:-}"
if [ -z "$PROFILE_PATH" ]; then
  if [ -f "$ROOT/profiles/x1c_pla_024.3mf" ]; then
    PROFILE_PATH="$ROOT/profiles/x1c_pla_024.3mf"
  fi
fi
if [ -n "$PROFILE_PATH" ]; then
  echo "- Profile path: $PROFILE_PATH"
else
  echo "- Profile path: unset (set BAMBUSTUDIO_PROFILE_PATH or place a .3mf in profiles/)"
fi

# Config summary
if [ -n "${BAMBUSTUDIO_UPTODATE_SETTINGS_PATH:-}" ]; then
  echo "- Uptodate settings: '${BAMBUSTUDIO_UPTODATE_SETTINGS_PATH}'"
  # Preflight: verify snapshot(s) appear to include variant/nozzle keys
  UTO_PRE="$(echo "${BAMBUSTUDIO_UPTODATE_SETTINGS_PATH}" | tr ',' ';')"
  IFS=';' read -r -a __arr <<< "$UTO_PRE"
  missing_keys=0
  for f in "${__arr[@]}"; do
    [ -z "$f" ] && continue
    if [ ! -f "$f" ]; then
      echo "  · WARN: settings file not found: $f" >&2
      continue
    fi
    if ! rg -N "printer_extruder_variant|print_extruder_variant|printer_extruder_id|print_extruder_id|nozzle_diameter" -n "$f" >/dev/null 2>&1; then
      echo "  · WARN: variant/nozzle keys not detected in: $f" >&2
      missing_keys=$((missing_keys+1))
    else
      echo "  · OK: variant/nozzle keys present in: $f"
    fi
  done
  if [ $missing_keys -gt 0 ]; then
    echo "  · HINT: chain a tiny overlay JSON that pins variant/nozzle, e.g.:" >&2
    echo "    {\"printer_extruder_variant\":\"0.4\",\"print_extruder_variant\":\"0.4\",\"printer_extruder_id\":0,\"print_extruder_id\":0,\"nozzle_diameter\":0.4}" >&2
    echo "    and set BAMBUSTUDIO_UPTODATE_SETTINGS_PATH=\"<snapshot.json>;<overlay.json>\"" >&2
  fi
fi
if [ -n "${BAMBUSTUDIO_SETTINGS_PATH:-}" ] && [ -n "${BAMBUSTUDIO_FILAMENTS_PATH:-}" ]; then
  echo "- JSON presets: settings='${BAMBUSTUDIO_SETTINGS_PATH}', filament='${BAMBUSTUDIO_FILAMENTS_PATH}'"
else
  echo "- JSON presets: not configured (set BAMBUSTUDIO_SETTINGS_PATH and BAMBUSTUDIO_FILAMENTS_PATH)"
fi

# Supabase env check
test -n "${SUPABASE_URL:-}" || { echo "SUPABASE_URL not set"; exit 1; }
test -n "${SUPABASE_SERVICE_ROLE_KEY:-}" || { echo "SUPABASE_SERVICE_ROLE_KEY not set"; exit 1; }
if [[ "${SUPABASE_URL:-}" =~ ^https:// ]]; then
  echo "- Supabase URL OK: $SUPABASE_URL"
else
  echo "ERROR: SUPABASE_URL must be https://<ref>.supabase.co (not postgresql://)"; exit 1
fi

echo "You can also run ./check_supabase.sh to verify REST access."

# Optional: run a Bambu slice smoke test
USE_UPTODATE=0
USE_JSON_PRESETS=0
if [ -n "${BAMBUSTUDIO_UPTODATE_SETTINGS_PATH:-}" ]; then
  USE_UPTODATE=1
fi
if [ -n "${BAMBUSTUDIO_SETTINGS_PATH:-}" ] && [ -n "${BAMBUSTUDIO_FILAMENTS_PATH:-}" ]; then
  USE_JSON_PRESETS=1
fi

if [ -n "$BAMBU_CLI_PATH" ] && { [ $USE_UPTODATE -eq 1 ] || [ $USE_JSON_PRESETS -eq 1 ] || { [ -n "$PROFILE_PATH" ] && [ -f "$PROFILE_PATH" ]; }; }; then
  echo "\nRunning Bambu CLI slice smoke test…"
  TMPDIR="$(mktemp -d)"
  CUBE="$TMPDIR/cube.stl"
  OUT3MF="$TMPDIR/out.3mf"
  # If running under WSL and CLI is a Windows .exe, prefer putting inputs/outputs on C:
  IS_WSL=0; if is_wsl; then IS_WSL=1; fi
  if [ $IS_WSL -eq 1 ] && [[ "$BAMBU_CLI_PATH" == *.exe || "$BAMBU_CLI_PATH" == /mnt/* ]]; then
    WIN_OUT_DIR="${WIN_OUT_DIR:-/mnt/c/PrintJobs}"
    if ! mkdir -p "$WIN_OUT_DIR" 2>/dev/null; then
      echo "- WARN: cannot write to WIN_OUT_DIR=$WIN_OUT_DIR; falling back to /mnt/c/PrintJobs" >&2
      WIN_OUT_DIR="/mnt/c/PrintJobs"; mkdir -p "$WIN_OUT_DIR" || true
    fi
    CUBE="$WIN_OUT_DIR/cube.stl"
    OUT3MF="$WIN_OUT_DIR/out.3mf"
  fi
  # Minimal ASCII cube (10mm)
  cat > "$CUBE" <<'STL'
solid cube
  facet normal 0 0 0
    outer loop
      vertex 0 0 0
      vertex 0 10 0
      vertex 10 10 0
    endloop
  endfacet
  facet normal 0 0 0
    outer loop
      vertex 0 0 0
      vertex 10 10 0
      vertex 10 0 0
    endloop
  endfacet
  facet normal 0 0 0
    outer loop
      vertex 0 0 10
      vertex 10 10 10
      vertex 0 10 10
    endloop
  endfacet
  facet normal 0 0 0
    outer loop
      vertex 0 0 10
      vertex 10 0 10
      vertex 10 10 10
    endloop
  endfacet
  facet normal 0 0 0
    outer loop
      vertex 0 0 0
      vertex 10 0 10
      vertex 0 0 10
    endloop
  endfacet
  facet normal 0 0 0
    outer loop
      vertex 0 0 0
      vertex 10 0 0
      vertex 10 0 10
    endloop
  endfacet
  facet normal 0 0 0
    outer loop
      vertex 0 10 0
      vertex 0 10 10
      vertex 10 10 10
    endloop
  endfacet
  facet normal 0 0 0
    outer loop
      vertex 0 10 0
      vertex 10 10 10
      vertex 10 10 0
    endloop
  endfacet
  facet normal 0 0 0
    outer loop
      vertex 0 0 0
      vertex 0 10 10
      vertex 0 10 0
    endloop
  endfacet
  facet normal 0 0 0
    outer loop
      vertex 0 0 0
      vertex 0 0 10
      vertex 0 10 10
    endloop
  endfacet
  facet normal 0 0 0
    outer loop
      vertex 10 0 0
      vertex 10 10 0
      vertex 10 10 10
    endloop
  endfacet
  facet normal 0 0 0
    outer loop
      vertex 10 0 0
      vertex 10 10 10
      vertex 10 0 10
    endloop
  endfacet
solid end
STL

  # If WSL with Windows CLI: convert paths to Windows form and ensure the profile/presets are readable from Windows
  if [ $IS_WSL -eq 1 ] && [[ "$BAMBU_CLI_PATH" == *.exe || "$BAMBU_CLI_PATH" == /mnt/* ]]; then
    if ! command -v wslpath >/dev/null 2>&1; then
      echo "wslpath not found; cannot run Windows CLI from WSL"; exit 1
    fi
    WIN_STL="$(wslpath -w "$CUBE")"
    WIN_OUT="$(wslpath -w "$OUT3MF")"
    if [ $USE_UPTODATE -eq 1 ]; then
      if ! command -v wslpath >/dev/null 2>&1; then
        echo "wslpath not found; cannot run Windows CLI from WSL"; exit 1
      fi
      UTO="$BAMBUSTUDIO_UPTODATE_SETTINGS_PATH"; UTO="${UTO//\"/}"
      # Support chaining multiple settings files separated by ';' or ','
      IFS=';' read -r -a UTO_ARR_SEMI <<< "$(echo "$UTO" | tr ',' ';')"
      WIN_UTOS=()
      for i in "${!UTO_ARR_SEMI[@]}"; do
        S="${UTO_ARR_SEMI[$i]}"
        S="${S//\"/}"
        if [[ -z "$S" ]]; then continue; fi
        if [[ "$S" != /mnt/* ]]; then
          # Copy to Windows side to ensure the .exe can read it
          CP_TGT="$WIN_OUT_DIR/settings_uptodate_$((i+1)).json"
          cp "$S" "$CP_TGT"
          S="$CP_TGT"
        fi
        WIN_UTOS+=("$(wslpath -w "$S")")
      done
      JOINED_UTO=$(IFS=';'; echo "${WIN_UTOS[*]}")
      WIN_STL="$(wslpath -w "$CUBE")"
      WIN_OUT="$(wslpath -w "$OUT3MF")"
      CMD="\"$BAMBU_CLI_PATH\" --uptodate --uptodate-settings \"$JOINED_UTO\" --arrange 1 --load-defaultfila --slice 0 --export-3mf \"$WIN_OUT\" \"$WIN_STL\""
      echo "- Executing (WSL uptodate): $CMD"
      set +e
      SLICE_OUT="$(eval "$CMD" 2>&1)"; CODE=$?
      set -e
      if [ $CODE -eq 0 ] && [ -f "$OUT3MF" ]; then
        SIZE=$(du -h "$OUT3MF" | awk '{print $1}')
        echo "- Slice OK: produced $OUT3MF ($SIZE)"; rm -rf "$TMPDIR"; exit 0
      else
        echo "- Slice FAILED (exit $CODE). CLI output:"; echo "$SLICE_OUT" | sed -n '1,200p'; rm -rf "$TMPDIR"; exit 0
      fi
    elif [ $USE_JSON_PRESETS -eq 1 ]; then
      # Prepare JSON presets and convert to Windows paths
      IFS=';' read -r -a SETTINGS_ARR <<< "$(echo "$BAMBUSTUDIO_SETTINGS_PATH" | tr ',' ';')"
      WIN_SETTINGS=()
      for i in "${!SETTINGS_ARR[@]}"; do
        S="${SETTINGS_ARR[$i]}"; S="${S//\"/}"
        if [[ "$S" != /mnt/* ]]; then cp "$S" "$WIN_OUT_DIR/setting_$((i+1)).json"; S="$WIN_OUT_DIR/setting_$((i+1)).json"; fi
        WIN_SETTINGS+=("$(wslpath -w "$S")")
      done
      FIL="$BAMBUSTUDIO_FILAMENTS_PATH"; FIL="${FIL//\"/}"
      if [[ "$FIL" != /mnt/* ]]; then cp "$FIL" "$WIN_OUT_DIR/filaments.json"; FIL="$WIN_OUT_DIR/filaments.json"; fi
      WIN_FIL="$(wslpath -w "$FIL")"
      JOINED=$(IFS=';'; echo "${WIN_SETTINGS[*]}")
      CMD="\"$BAMBU_CLI_PATH\" --load-settings \"$JOINED\" --load-filaments \"$WIN_FIL\" --slice 0 --export-3mf \"$WIN_OUT\" \"$WIN_STL\""
      # Execute the command and report like other branches
      set +e
      SLICE_OUT="$(eval "$CMD" 2>&1)"; CODE=$?
      set -e
      if [ $CODE -eq 0 ] && [ -f "$OUT3MF" ]; then
        SIZE=$(du -h "$OUT3MF" | awk '{print $1}')
        echo "- Slice OK: produced $OUT3MF ($SIZE)"; rm -rf "$TMPDIR"; exit 0
      else
        echo "- Slice FAILED (exit $CODE). CLI output:"; echo "$SLICE_OUT" | sed -n '1,160p'; rm -rf "$TMPDIR"; exit 0
      fi
    else
      # --- DIRECT PROFILE SLICE (no export/load) ---
      if [[ -z "$PROFILE_PATH" || ! -f "$PROFILE_PATH" ]]; then
        echo "Profile 3MF not set or missing; cannot run smoke test."; exit 0
      fi
      if [[ "$PROFILE_PATH" != /mnt/* ]]; then
        cp "$PROFILE_PATH" "$WIN_OUT_DIR/profile.3mf"; PROFILE_PATH="$WIN_OUT_DIR/profile.3mf"
      fi
      if [ ! -s "$PROFILE_PATH" ]; then
        echo "- ERROR: Copied profile is empty or unreadable at $PROFILE_PATH. Choose a different WIN_OUT_DIR (e.g., /mnt/c/PrintJobs) and ensure it is writable."
        exit 0
      fi
      WIN_PROFILE="$(wslpath -w "$PROFILE_PATH")"
      WIN_OUT="$(wslpath -w "$OUT3MF")"
      # If your Golden 3MF includes a model, pass only the 3MF
      CMD="\"$BAMBU_CLI_PATH\" --arrange 1 --load-defaultfila --slice 0 --export-3mf \"$WIN_OUT\" \"$WIN_PROFILE\""
      # If your Golden 3MF is an empty plate and you want to slice the doctor cube.stl instead,
      # append "$WIN_STL" as a second arg to use the project's settings:
      # CMD="\"$BAMBU_CLI_PATH\" --arrange 1 --load-defaultfila --slice 0 --export-3mf \"$WIN_OUT\" \"$WIN_PROFILE\" \"$WIN_STL\""
      echo "- Executing (WSL profile-direct): $CMD"
      set +e
      SLICE_OUT="$(eval "$CMD" 2>&1)"; CODE=$?
      set -e
      if [ $CODE -eq 0 ] && [ -f "$OUT3MF" ]; then
        SIZE=$(du -h "$OUT3MF" | awk '{print $1}')
        echo "- Slice OK: produced $OUT3MF ($SIZE)"; rm -rf "$TMPDIR"; exit 0
      else
        echo "- Slice FAILED (exit $CODE). CLI output:"; echo "$SLICE_OUT" | sed -n '1,160p'; rm -rf "$TMPDIR"; exit 0
      fi
      # --- END DIRECT PROFILE SLICE ---
    fi
  else
    if [ $USE_UPTODATE -eq 1 ]; then
      # Allow multiple settings files separated by ';' or ',' on non-WSL too
      JOINED_UPTO="$(echo "${BAMBUSTUDIO_UPTODATE_SETTINGS_PATH}" | tr ',' ';')"
      CMD="\"$BAMBU_CLI_PATH\" --uptodate --uptodate-settings \"$JOINED_UPTO\" --arrange 1 --load-defaultfila --slice 0 --export-3mf \"$OUT3MF\" \"$CUBE\""
      echo "- Executing (uptodate): $CMD"
      set +e
      SLICE_OUT="$(eval "$CMD" 2>&1)"; CODE=$?
      set -e
      if [ $CODE -eq 0 ] && [ -f "$OUT3MF" ]; then
        SIZE=$(du -h "$OUT3MF" | awk '{print $1}')
        echo "- Slice OK: produced $OUT3MF ($SIZE)"; rm -rf "$TMPDIR"; exit 0
      else
        echo "- Slice FAILED (exit $CODE). CLI output:"; echo "$SLICE_OUT" | sed -n '1,200p'; rm -rf "$TMPDIR"; exit 0
      fi
    elif [ $USE_JSON_PRESETS -eq 1 ]; then
      JOINED_SETTINGS="$(echo "$BAMBUSTUDIO_SETTINGS_PATH" | tr ',' ';')"
      CMD="\"$BAMBU_CLI_PATH\" --load-settings \"$JOINED_SETTINGS\" --load-filaments \"$BAMBUSTUDIO_FILAMENTS_PATH\" --slice 0 --export-3mf \"$OUT3MF\" \"$CUBE\""
    else
      # Linux/mac: export settings from 3MF then slice
      SETTINGS_JSON="$TMPDIR/settings_cli.json"
      CMD1="\"$BAMBU_CLI_PATH\" --export-settings \"$SETTINGS_JSON\" \"$PROFILE_PATH\""
      CMD2="\"$BAMBU_CLI_PATH\" --load-settings \"$SETTINGS_JSON\" --slice 0 --export-3mf \"$OUT3MF\" \"$CUBE\""
      set +e
      OUT1="$(eval "$CMD1" 2>&1)"; CODE1=$?
      if [ $CODE1 -ne 0 ]; then
        echo "- Settings export failed. CLI output:"; echo "$OUT1" | sed -n '1,120p'
        CODE=254; SLICE_OUT="$OUT1"; OUT2=""; set -e
        echo "- Slice FAILED (exit $CODE). CLI output:"; echo "$SLICE_OUT" | sed -n '1,160p'; rm -rf "$TMPDIR"; exit 0
      fi
      OUT2="$(eval "$CMD2" 2>&1)"; CODE=$?; SLICE_OUT="$OUT1
$OUT2"
      set -e
      if [ $CODE -eq 0 ] && [ -f "$OUT3MF" ]; then
        SIZE=$(du -h "$OUT3MF" | awk '{print $1}')
        echo "- Slice OK: produced $OUT3MF ($SIZE)"; rm -rf "$TMPDIR"; exit 0
      else
        echo "- Slice FAILED (exit $CODE). CLI output:"; echo "$SLICE_OUT" | sed -n '1,160p'; rm -rf "$TMPDIR"; exit 0
      fi
    fi
  fi
  # unreachable; exits above
else
  echo "\nSkipping slice smoke test (missing CLI or profile)."
fi

echo "\nDone."
