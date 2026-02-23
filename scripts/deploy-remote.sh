#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

REMOTE_HOST="${REMOTE_HOST:-lionel@100.126.188.99}"
REMOTE_DIR="${REMOTE_DIR:-/home/lionel/apps/youtube_to_sonos}"
RESTART_MODE="auto" # auto | systemctl | nohup
INSTALL_DEPS=0
NO_RESTART=0
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage:
  scripts/deploy-remote.sh [options]

Options:
  --remote-host <user@host>   Remote SSH target (default: lionel@100.126.188.99)
  --remote-dir <path>         Remote project path (default: /home/lionel/apps/youtube_to_sonos)
  --restart-mode <mode>       auto | systemctl | nohup (default: auto)
  --install                   Run npm install in remote server/client before restart
  --no-restart                Sync only, do not restart remote services/processes
  --dry-run                   Show rsync changes without applying
  -h, --help                  Show this help

Env overrides:
  REMOTE_HOST, REMOTE_DIR
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote-host)
      REMOTE_HOST="${2:-}"
      shift 2
      ;;
    --remote-dir)
      REMOTE_DIR="${2:-}"
      shift 2
      ;;
    --restart-mode)
      RESTART_MODE="${2:-}"
      shift 2
      ;;
    --install)
      INSTALL_DEPS=1
      shift
      ;;
    --no-restart)
      NO_RESTART=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ ! "$RESTART_MODE" =~ ^(auto|systemctl|nohup)$ ]]; then
  echo "Invalid --restart-mode: $RESTART_MODE (expected auto|systemctl|nohup)" >&2
  exit 1
fi

if ! command -v rsync >/dev/null 2>&1; then
  echo "rsync is required but not found in PATH." >&2
  exit 1
fi

echo "==> Sync local -> remote"
echo "    Local : $ROOT_DIR"
echo "    Remote: $REMOTE_HOST:$REMOTE_DIR"

RSYNC_OPTS=(
  -az
  --human-readable
  --exclude '.git/'
  --exclude '.DS_Store'
  --exclude 'client/node_modules/'
  --exclude 'server/node_modules/'
  --exclude 'client/dist/'
  --exclude 'server/server.log'
  --exclude '*.log'
)

if [[ $DRY_RUN -eq 1 ]]; then
  RSYNC_OPTS+=(--dry-run --itemize-changes)
fi

rsync "${RSYNC_OPTS[@]}" "$ROOT_DIR/" "$REMOTE_HOST:$REMOTE_DIR/"

if [[ $DRY_RUN -eq 1 ]]; then
  echo "==> Dry-run complete (no files changed)."
  exit 0
fi

if [[ $INSTALL_DEPS -eq 1 ]]; then
  echo "==> Installing remote dependencies"
  ssh "$REMOTE_HOST" "set -euo pipefail; cd '$REMOTE_DIR/server' && npm install --no-audit --no-fund; cd '$REMOTE_DIR/client' && npm install --no-audit --no-fund"
fi

if [[ $NO_RESTART -eq 1 ]]; then
  echo "==> Sync complete (restart skipped)."
  exit 0
fi

echo "==> Restarting remote server/client (mode: $RESTART_MODE)"
ssh "$REMOTE_HOST" "REMOTE_DIR='$REMOTE_DIR' RESTART_MODE='$RESTART_MODE' bash -s" <<'REMOTE_EOF'
set -euo pipefail
cd "${REMOTE_DIR:-/home/lionel/apps/youtube_to_sonos}"

restart_with_systemctl() {
  sudo systemctl restart sonons.service
  sudo systemctl restart sonons-client.service
  echo 'systemctl: restarted sonons + sonons-client'
}

restart_with_nohup() {
  cd server
  pkill -f 'node index.js' || true
  nohup npm start > server.log 2>&1 &
  sleep 1

  cd ../client
  pkill -f 'vite --host 0.0.0.0 --port 5173' || true
  nohup npm run dev -- --host 0.0.0.0 --port 5173 > client.dev.log 2>&1 &
  sleep 1

  ps -ef | grep -E 'node index.js|vite --host 0.0.0.0 --port 5173' | grep -v grep || true
}

has_services=0
if command -v systemctl >/dev/null 2>&1; then
  if systemctl list-unit-files 2>/dev/null | grep -q '^sonons\.service'; then
    if systemctl list-unit-files 2>/dev/null | grep -q '^sonons-client\.service'; then
      has_services=1
    fi
  fi
fi

if [[ "$RESTART_MODE" == 'systemctl' ]]; then
  if [[ $has_services -ne 1 ]]; then
    echo 'systemctl mode requested, but sonons services not found.' >&2
    exit 1
  fi
  restart_with_systemctl
elif [[ "$RESTART_MODE" == 'nohup' ]]; then
  restart_with_nohup
else
  if [[ $has_services -eq 1 ]]; then
    restart_with_systemctl
  else
    restart_with_nohup
  fi
fi
REMOTE_EOF

echo "==> Deploy complete."
