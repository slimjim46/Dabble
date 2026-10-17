#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck source=/dev/null
    . "$HOME/.nvm/nvm.sh"
    nvm use node >/dev/null
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is required. Install it from https://nodejs.org" >&2
  exit 1
fi

echo "Installing dependencies..."
npm install

echo
echo "Done. Start the dev server with: npm run dev"
