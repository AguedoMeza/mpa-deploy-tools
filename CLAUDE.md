# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a **hybrid Node.js + Python deployment automation system** for multi-tiered applications running on Windows IIS/NSSM infrastructure. It uses **SharePoint (Microsoft Graph API) as the coordination layer** between a build stage (Node.js) and a watch-deploy stage (Python).

## Components

| Component | Language | Runs On | Role |
|-----------|----------|---------|------|
| `build-agent.js` | Node.js | Dev machine / CI | Detects changes, builds, versions, uploads artifacts to SharePoint |
| `trigger-build.js` | Node.js | Dev machine (git hook) | Spawns `build-agent.js` asynchronously — legacy, unreliable in WSL; prefer calling `build-agent.js` directly from `pre-push` |
| `storage/sharepoint.js` | Node.js | Build step | Graph API client for upload/manifest operations |
| `deploy-watcher/watcher.py` | Python | Windows Server (NSSM service) | Polling loop, orchestrates deployments per project |
| `deploy-watcher/deploy_frontend.py` | Python | Windows Server | Downloads ZIP, validates SHA-256, swaps directory junction, health checks |
| `deploy-watcher/deploy_backend.py` | Python | Windows Server | `git pull`, restarts NSSM service, health checks, auto-rollback |
| `deploy-watcher/storage/sharepoint.py` | Python | Windows Server | Graph API client for manifest reads and artifact downloads |

## How to Run

### Build Agent (Node.js)
```bash
npm install
node build-agent.js   # DRY RUN by default
```
Set `BUILD_AGENT_ENABLED=true` in `.env.local` to enable actual uploads. Triggered automatically via `.husky/post-push` on `git push`.

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

## Required Environment Variables

Both Node.js and Python clients use the same credentials (via `.env` / `.env.local`):
```
GRAPH_CLIENT_ID=
GRAPH_TENANT_ID=
GRAPH_CLIENT_SECRET=
SHAREPOINT_SITE_URL=
SHAREPOINT_SITE_PATH=
BUILD_AGENT_ENABLED=true   # Node.js only — omit for dry run
```

## Architecture

### Deployment Flow

```
git push → pre-push hook → build-agent.js (foreground, ~15s)
  → reads deploy.config.yml (from the target repo, not this repo)
  → detects changed paths (frontend vs backend)
  → builds artifact, zips, calculates SHA-256
  → uploads ZIP + updates manifest.json in SharePoint

deploy-watcher service (polls every 30s):
  → reads manifest.json from SharePoint
  → if new frontend version: download → validate → extract → swap junction → health check
  → if new backend commit: git pull → restart NSSM service → health check
  → auto-rollback if health check fails (junction revert or git reset --hard)
```

### Key Design Decisions

- **Manifest-driven**: `manifest.json` in SharePoint is the single source of truth. Build stage writes it; watcher reads it. No direct integration between the two.
- **Atomic frontend swaps**: Uses Windows directory junctions for zero-downtime frontend deployments—no service restart needed.
- **Auto-rollback**: Both frontend (junction revert) and backend (`git reset --hard`) roll back automatically on health check failure.
- **Git hook**: usar `pre-push` (no `post-push` — no es un hook válido de git). En WSL, el hook debe usar la ruta absoluta de node (NVM no está en el PATH del hook): `/home/user/.nvm/versions/node/vX.Y.Z/bin/node node_modules/mpa-deploy-tools/build-agent.js`
- **IIS management**: Uses `appcmd.exe` (not PowerShell) to recycle App Pools—more reliable on Windows.
- **UTF-8 handling**: YAML files read with `utf-8-sig` to tolerate BOM from PowerShell-generated files; logging uses explicit UTF-8 to avoid Windows cp1252 errors.

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
build:
  frontend:
    working_dir: ./frontend
    command: npm run build
    output_dir: dist
deploy:
  storage:
    folder: MyApp/deployments
  server:
    frontend:
      inetpub_path: C:\inetpub\my-app
      app_pool: MyAppPool          # optional
      keep_releases: 5
      health_check:
        url: https://my-app.local  # optional — omit for static-only sites
    backend:
      repo_path: C:\inetpub\repos\my-app
      nssm_service: my-app-api
      health_check:
        url: https://my-app.local/api/health
```

## Logs

- **Build agent**: `~/.mpa-deploy/logs/deploy-YYYYMMDD.log`
- **Watcher**: directory configured in `deploy-watcher.yml` → `watcher.log` (rotates daily, keeps 30 days)

## Version Format

Artifacts are versioned as `YYYYMMDD_HHMMSS_shortSHA` (e.g., `20260313_181200_a3f9b2c`). Manifests retain the last 10 builds.
