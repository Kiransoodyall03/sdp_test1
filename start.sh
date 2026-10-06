#!/usr/bin/env bash
#
# Install dependencies (if needed) and start the Repo Analysis Tool.
# Works from a clean clone: `./start.sh`
#
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[RAT] Node.js is required but was not found on PATH." >&2
  echo "[RAT] Install Node 18+ (see .nvmrc) and re-run." >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "[RAT] git is required (used for cloning and metric extraction)." >&2
  echo "[RAT] Install git 2.23+ and re-run." >&2
  exit 1
fi

echo "[RAT] Node $(node --version), npm $(npm --version), $(git --version)"

if [ ! -d node_modules ]; then
  echo "[RAT] Installing dependencies..."
  # Prefer Ubuntu's system Python for native addons when available. This avoids
  # unrelated Conda/pyenv Python environments that do not provide node-gyp.
  if [ -x /usr/bin/python3 ]; then
    PYTHON=/usr/bin/python3 npm ci
  else
    npm ci
  fi
fi

echo "[RAT] Starting server..."
exec npm start
