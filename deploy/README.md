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

## Actual working method (Windows remote)

Building on the remote **fails**: Docker Desktop on Windows invokes its
credential helper for every registry pull, and over SSH that errors with
*"A specified logon session does not exist"* — no client-config override
bypasses it. Bind-mounting host folders also hit *Access is denied* in the SSH
session.

So the working deploy (`deploy/deploy-image.sh`) **builds the image locally**
for `linux/amd64`, ships the finished image (`docker save | gzip | ssh … load`),
and runs `docker-compose.run.yml` (image-based, **no bind mount** — the data is
baked into the image via the Dockerfile). Reproducible:

```bash
cd deploy && SSHPASS='Ocellot123!' ./deploy-image.sh
```

**Live:** http://100.116.132.16:3459 (VPN). marks_project stays on :3000.
