#!/usr/bin/env bash
# Working remote deploy: build the image LOCALLY, ship it, load + run on the
# remote. Avoids building on the Windows host, whose Docker Desktop credential
# helper fails over SSH ("A specified logon session does not exist") on any
# registry pull. Isolated from marks_project (own project, port 3459 only).
set -euo pipefail
HOST="claude@100.116.132.16"
REMOTE='C:/Users/claude/kaptori'
export SSHPASS="${SSHPASS:-Ocellot123!}"
SSHO="-o StrictHostKeyChecking=accept-new -o ConnectTimeout=20"
here="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Abort if :3459 already bound on remote"
sshpass -e ssh $SSHO "$HOST" 'docker ps --format "{{.Ports}}"' | grep -q ':3459->' && { echo "3459 in use — aborting"; exit 1; } || true

echo "==> Build image locally for linux/amd64"
docker buildx build --platform linux/amd64 -t kaptori:local --load "$here"

echo "==> Ship files (repo tree + .env) and the image"
sshpass -e ssh $SSHO "$HOST" 'mkdir C:\Users\claude\kaptori 2>NUL & echo ok' >/dev/null
TMP=$(mktemp -d); git -C "$here" archive --format=tar HEAD | tar -x -C "$TMP"
cp "$here/.env" "$TMP/.env" 2>/dev/null || echo "WARN: no .env — set ANTHROPIC_API_KEY on remote"
COPYFILE_DISABLE=1 tar -cf - -C "$TMP" . | sshpass -e ssh $SSHO "$HOST" 'cd /d C:\Users\claude\kaptori && tar -xf -'
rm -rf "$TMP"
docker save kaptori:local | gzip | sshpass -e ssh $SSHO "$HOST" 'cd /d C:\Users\claude\kaptori && (if exist img.tgz del img.tgz) & more > img.tgz'
sshpass -e ssh $SSHO "$HOST" 'cd /d C:\Users\claude\kaptori && docker load -i img.tgz & del img.tgz'

echo "==> Run isolated stack (image-based, data baked into image)"
sshpass -e ssh $SSHO "$HOST" 'cd /d C:\Users\claude\kaptori\deploy && docker compose -p kaptori -f docker-compose.run.yml up -d'

echo "==> Verify"
sshpass -e ssh $SSHO "$HOST" 'curl -s http://localhost:3459/api/health'
echo; echo "Kaptori: http://100.116.132.16:3459  (marks_project untouched on :3000)"
