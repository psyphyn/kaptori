# Remote deploy

Deploys Kaptori to the remote Windows server **alongside** the existing
marks_project stack, without disturbing it.

## Isolation guarantees
- **New folder**: `C:\Users\claude\kaptori` (marks_project stays put).
- **Own compose project**: `-p kaptori` — separate containers, network, lifecycle.
- **One port**: `3459` (marks_project uses 3000/5432/6379 — no overlap). The
  script aborts if `:3459` is already bound.
- **Never** runs a compose command against marks_project; only `docker ps` reads.

## Prerequisites
- The remote is **online and on Tailscale** (currently offline — last seen 6d ago).
- Docker Desktop running on the remote.
- A funded `ANTHROPIC_API_KEY` in `.env` (the app builds/runs regardless, but
  chat needs credit).

## Run
```bash
cd deploy
SSHPASS='Ocellot123!' ./deploy-remote.sh
```

Then open http://100.116.132.16:3459 (VPN required).

## Teardown (Kaptori only — leaves marks_project alone)
```bash
ssh claude@100.116.132.16 "cd C:/Users/claude/kaptori/deploy && docker compose -p kaptori -f docker-compose.deploy.yml down"
```
