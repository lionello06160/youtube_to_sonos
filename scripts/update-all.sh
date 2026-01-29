#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"
git pull

cd "$ROOT_DIR/client"
npm run build

sudo systemctl restart sonons-client
sudo systemctl restart sonons

echo "Client + server updated and restarted."
