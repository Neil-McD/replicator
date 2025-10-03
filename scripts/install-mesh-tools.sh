#!/usr/bin/env bash
set -euo pipefail

# Installs ADMesh and MeshFix on Ubuntu/WSL.
# - ADMesh from apt
# - MeshFix from source (Marco Attene's MeshFix)

if ! command -v sudo >/dev/null 2>&1; then
  echo "This script expects sudo privileges (Ubuntu/WSL)." >&2
  exit 1
fi

echo "[install] Updating apt indexes…"
sudo apt-get update -y

echo "[install] Installing build tools and ADMesh…"
sudo apt-get install -y --no-install-recommends \
  build-essential git cmake pkg-config \
  admesh

# Install MeshFix from source into /usr/local/bin/meshfix
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT
cd "$TMP_DIR"

echo "[install] Cloning MeshFix…"
# Try canonical repo first; fall back to older tag if needed
if git clone --depth=1 https://github.com/MarcoAttene/MeshFix-V2.1.git meshfix-src 2>/dev/null; then
  :
else
  git clone --depth=1 https://github.com/MarcoAttene/meshfix.git meshfix-src
fi
cd meshfix-src

echo "[install] Building MeshFix…"
if [ -f Makefile ]; then
  make -j"$(nproc)"
elif [ -f CMakeLists.txt ]; then
  mkdir -p build && cd build
  cmake ..
  make -j"$(nproc)"
  cd ..
else
  echo "MeshFix build files not found. Please check the repo layout." >&2
  exit 1
fi

# Find produced binary (handles Make and CMake layouts)
BIN=""
# Common locations/names
for p in \
  meshfix \
  MeshFix \
  build/meshfix \
  build/MeshFix \
  bin64/MeshFix \
  bin/meshfix \
  bin/MeshFix; do
  if [ -f "$p" ]; then BIN="$p"; break; fi
done
if [ -z "$BIN" ]; then
  # Fallback: search up to 3 levels deep for an executable named *meshfix*
  BIN=$(find . -maxdepth 3 -type f -perm /111 -iname "*meshfix*" | head -n1 || true)
fi
if [ -z "$BIN" ]; then
  echo "MeshFix binary not found after build." >&2
  exit 1
fi

echo "[install] Installing MeshFix → /usr/local/bin/meshfix from $BIN…"
sudo install -m 0755 "$BIN" /usr/local/bin/meshfix

echo "[install] Verifying tools…"
if command -v admesh >/dev/null; then admesh --version | head -n1; else echo "ADMesh not on PATH"; fi
if command -v meshfix >/dev/null; then echo "meshfix present at $(command -v meshfix)"; else echo "MeshFix not on PATH"; fi

echo "[install] Done. Restart your worker shell so PATH updates apply."
