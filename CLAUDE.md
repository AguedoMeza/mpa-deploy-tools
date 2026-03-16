# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a **hybrid Node.js + Python deployment automation system** for multi-tiered applications running on Windows IIS/NSSM infrastructure. It uses **SharePoint (Microsoft Graph API) as the coordination layer** between a build stage (Node.js) and a watch-deploy stage (Python).

## Components

| Component | Language | Runs On | Role |
|-----------|----------|---------|------|
| `build-agent.js` | Node.js | Dev machine / CI | Detects changes, builds, versions, uploads artifacts to SharePoint, updates manifest |
| `init.js` | Node.js | Dev machine | Onboarding CLI — sets up husky hooks, NVM init, package.json scripts, validates config |
| `trigger-build.js` | Node.js | Dev machine | Legacy: spawned `build-agent.js` async. Unreliable in WSL — do not use |
| `storage/sharepoint.js` | Node.js | Build step | Graph API client for upload/manifest operations |
| `deploy-watcher/watcher.py` | Python | Windows Server (NSSM service) | Polling loop, orchestrates deployments per project |
| `deploy-watcher/deploy_frontend.py` | Python | Windows Server | Downloads ZIP, validates SHA-256, deploys via `replace` or `junction` mode, health checks |
| `deploy-watcher/deploy_backend.py` | Python | Windows Server | `git pull`, restarts NSSM service, optional health checks, auto-rollback |
| `deploy-watcher/storage/sharepoint.py` | Python | Windows Server | Graph API client — all calls use `_request()` with retry/backoff |

## Onboarding a New Repo

```bash
npm init -y   # if repo has no package.json
npm install --save-dev husky github:AguedoMeza/mpa-deploy-tools#main
node node_modules/mpa-deploy-tools/init.js
```

`init.js` does:
1. Creates `~/.config/husky/init.sh` (loads NVM — required for git hooks in WSL)
2. Adds `prepush`, `deploy:dry-run`, `precommit` scripts to `package.json`
3. Creates `.husky/pre-push` with `npm run prepush`
4. Creates `.husky/pre-commit` with `npm run precommit`
5. Strips embedded tokens from `repository.url` in `package.json`
6. Validates `deploy.config.yml` and `.env.local`

Use `--check` flag to diagnose without modifying files.

## How to Run

### Build Agent (Node.js)
```bash
npm install
node build-agent.js   # DRY RUN by default
```
Set `BUILD_AGENT_ENABLED=true` in `.env.local` to enable actual uploads. Triggered automatically via `.husky/pre-push` on `git push`.

**NVM in git hooks**: Husky reads `~/.config/husky/init.sh` before running any hook. That file must load NVM. The hook itself calls `npm run prepush` (portable — no absolute paths).

### Deploy Watcher (Python)
```bash
cd deploy-watcher
pip install -r requirements.txt
python watcher.py     # Development run
```
Production: installed as a Windows service via NSSM:
```powershell
nssm install mpa-deploy-watcher python watcher.py
nssm set mpa-deploy-watcher AppDirectory C:\deploy-watcher
nssm set mpa-deploy-watcher AppEnvironmentExtra PYTHONUNBUFFERED=1
nssm start mpa-deploy-watcher
```

**git safe.directory**: The watcher runs as `SYSTEM` (NSSM). If repos were cloned by another user, git will refuse pulls. `--global` won't work because SYSTEM has its own gitconfig. Run once on the server as Administrator:
```powershell
git config --file "C:\Windows\System32\config\systemprofile\.gitconfig" --add safe.directory *
```

## Required Environment Variables

Both Node.js and Python clients use the same credentials (via `.env` / `.env.local`):
```
GRAPH_CLIENT_ID=
GRAPH_TENANT_ID=
GRAPH_CLIENT_SECRET=
SHAREPOINT_SITE_URL=        # e.g. tuempresa.sharepoint.com
SHAREPOINT_SITE_PATH=       # e.g. /sites/Apps Center
BUILD_AGENT_ENABLED=true    # Node.js only — omit for dry run
```

## Architecture

### Deployment Flow

```
git push → pre-push hook → npm run prepush → build-agent.js (foreground, ~15s)
  → reads deploy.config.yml (from the target repo, not this repo)
  → detects changed paths via git diff HEAD~1..HEAD
  → frontend changed: build → zip → SHA-256 → upload ZIP → update manifest.frontend
  → backend changed:  get current commit → update manifest.backend.commit

deploy-watcher service (polls every 30s):
  → reads manifest.json from SharePoint
  → if manifest.frontend.latest changed: download → validate SHA-256 → deploy → health check
  → if manifest.backend.commit changed:  git pull → nssm restart → health check
  → auto-rollback if health check fails (frontend: restore backup / backend: git reset --hard)
```

### Frontend Deploy Modes

`deploy_mode` in `deploy.config.yml → deploy.server.frontend`:

| Mode | Behavior | When to use |
|------|----------|-------------|
| `replace` | Backup → rmtree → extractall → optional App Pool recycle | IIS points directly to build folder |
| `junction` | Atomic swap via Windows Directory Junction (`current → releases/version`) | Zero-downtime, IIS points to `current\` |

Both modes support optional `health_check` and optional `app_pool`.

### Key Design Decisions

- **Manifest-driven**: `manifest.json` in SharePoint is the single source of truth. Build stage writes it; watcher reads it. No direct integration between the two.
- **Backend deploy signal**: `build-agent.js` writes `manifest.backend.commit = fullSha`; the watcher detects the change and runs `git pull + nssm restart` on the server.
- **Health checks are optional**: Both `deploy_frontend.py` and `deploy_backend.py` skip health checks when `health_check.url` is not configured.
- **Auto-rollback**: Frontend restores backup directory; backend runs `git reset --hard <prev_commit>` and restarts service.
- **IIS management**: Uses `appcmd.exe` (not PowerShell) to recycle App Pools.
- **UTF-8 handling**: YAML files read with `utf-8-sig` to tolerate BOM; watcher logging uses explicit UTF-8; no Unicode characters in log messages (cp1252 compatibility on Windows).
- **SharePoint resilience**: All API calls in `sharepoint.py` go through `_request()` with retry + exponential backoff for 429/5xx and timeouts.
- **pre-push hook** (not `post-push` — post-push is not a valid git hook).

### Configuration Hierarchy

Each target repo has its own `deploy.config.yml` (not stored here). The watcher's config (`deploy-watcher.yml`) lists paths to those per-repo configs:

```yaml
# deploy-watcher.yml
poll_interval_seconds: 30
log_dir: 'C:\deploy-watcher\logs'
credentials_env: 'C:\deploy-watcher\.env'
projects:
  - config: 'C:\inetpub\repos\my-app\deploy.config.yml'
```

```yaml
# deploy.config.yml (inside each target repo)
project:
  name: my-app
paths:
  frontend: frontend/
  backend: backend/
build:
  frontend:
    working_dir: frontend/
    command: npm run build
    output_dir: frontend/build
  backend:
    type: python
deploy:
  storage:
    folder: my-app           # SharePoint folder name
  server:
    frontend:
      enabled: true
      inetpub_path: 'C:\inetpub\wwwroot\my-app\frontend\build'
      deploy_mode: replace   # replace | junction
      app_pool: my-app-pool  # optional
      health_check:          # optional
        url: https://my-app.local
        timeout_seconds: 10
    backend:
      enabled: true
      repo_path: 'C:\inetpub\wwwroot\my-app'
      nssm_service: my-app-backend
      health_check:          # optional
        url: http://localhost:8000/health
        timeout_seconds: 10
```

## Logs

- **Build agent**: `~/.mpa-deploy/logs/deploy-YYYYMMDD.log`
- **Watcher**: directory configured in `deploy-watcher.yml` → `watcher.log` (rotates daily, keeps 30 days)

## Version Format

Artifacts are versioned as `YYYYMMDD_HHMMSS_shortSHA` (e.g., `20260313_181200_a3f9b2c`). Manifests retain the last 10 builds.

## Pending

- `rollback.js` — CLI command for manual rollback (see `TODO.md`)
