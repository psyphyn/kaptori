#!/usr/bin/env bash
# One-shot deploy of Kaptori to the remote Windows server (MINI_JOSHUA) over SSH.
# ISOLATION: fresh folder, compose project name "kaptori", port 3459 only.
# It never runs a compose command against marks_project.
set -euo pipefail

HOST="claude@100.116.132.16"
REMOTE_DIR='C:/Users/claude/kaptori'          # NEW folder — not marks_project
export SSHPASS="${SSHPASS:-Ocellot123!}"
SSH="sshpass -e ssh -o StrictHostKeyChecking=accept-new"
SCP="sshpass -e scp -o StrictHostKeyChecking=accept-new"

echo "==> Preflight: confirm host reachable and Docker present"
$SSH "$HOST" "docker version --format '{{.Server.Version}}'" || { echo "Host unreachable or Docker not running. Aborting."; exit 1; }

echo "==> Safety check: show what's already running (should include marks_project)"
$SSH "$HOST" "docker ps --format '{{.Names}} -> {{.Ports}}'"

echo "==> Refuse to proceed if anything already binds :3459"
if $SSH "$HOST" "docker ps --format '{{.Ports}}'" | grep -q ':3459->'; then
  echo "Port 3459 already in use on remote. Aborting to avoid a conflict."; exit 1
fi

echo "==> Create fresh project folder and sync repo (excluding node_modules/.git)"
$SSH "$HOST" "mkdir \"$REMOTE_DIR\" 2>NUL & echo ok"
# rsync may be absent on Windows; use tar-over-ssh from a clean checkout
TMP=$(mktemp -d)
git -C "$(dirname "$0")/.." archive --format=tar HEAD | tar -x -C "$TMP"
cp "$(dirname "$0")/.."/.env "$TMP/.env" 2>/dev/null || echo "WARN: no local .env to copy — set ANTHROPIC_API_KEY on the remote"
( cd "$TMP" && tar -cf - . ) | $SSH "$HOST" "cd \"$REMOTE_DIR\" && tar -xf -"
rm -rf "$TMP"

echo "==> Build & start the ISOLATED kaptori stack (project name: kaptori)"
$SSH "$HOST" "cd \"$REMOTE_DIR/deploy\" && docker compose -p kaptori -f docker-compose.deploy.yml up -d --build"

echo "==> Verify Kaptori is up on :3459 and marks_project is untouched"
$SSH "$HOST" "curl -s http://localhost:3459/api/health || echo 'kaptori not responding yet'"
$SSH "$HOST" "docker ps --format '{{.Names}} -> {{.Status}}'"
echo "==> Done. Kaptori: http://100.116.132.16:3459   (marks_project stays on :3000)"
