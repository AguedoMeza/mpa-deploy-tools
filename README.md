# mpa-deploy-tools

Pipeline de deploy automático para monorepos MPA en Windows IIS/NSSM.

Cada `git push` detecta qué cambió, buildea el artefacto, lo sube a SharePoint y lo despliega en el servidor — sin intervención manual.

```
git push → build → SharePoint → watcher → IIS
```

---

## Requisitos

- Node.js ≥ 18 (vía NVM)
- Acceso a SharePoint vía Microsoft Graph API (service principal)
- Servidor Windows con IIS y NSSM (para el watcher)

---

## Onboarding de un repo nuevo

```bash
# Si el repo no tiene package.json en la raíz, créalo primero
npm init -y

npm install --save-dev husky github:AguedoMeza/mpa-deploy-tools#main
node node_modules/mpa-deploy-tools/init.js
```

El comando `init`:
- Crea `~/.config/husky/init.sh` para que NVM funcione en hooks (sin rutas absolutas)
- Agrega los scripts `prepush` y `deploy:dry-run` a `package.json`
- Crea `.husky/pre-push` portable
- Valida `deploy.config.yml` y variables de entorno

Para solo diagnosticar sin modificar archivos:

```bash
node node_modules/mpa-deploy-tools/init.js --check
```

---

## Configuración

### `.env.local` (en la raíz del repo, no se commitea)

```env
BUILD_AGENT_ENABLED=true
STORAGE_PROVIDER=sharepoint
GRAPH_CLIENT_ID=
GRAPH_CLIENT_SECRET=
GRAPH_TENANT_ID=
SHAREPOINT_SITE_URL=https://tuempresa.sharepoint.com
SHAREPOINT_SITE_PATH=/sites/tu-sitio
```

### `deploy.config.yml` (en la raíz del repo, sí se commitea)

```yaml
version: "1"

project:
  name: mi-app

paths:
  frontend: frontend/
  backend: backend/

build:
  frontend:
    command: npm run build
    output_dir: frontend/build
    working_dir: frontend/

  backend:
    type: python

deploy:
  storage:
    provider: sharepoint
    folder: mi-app

  server:
    frontend:
      enabled: true
      inetpub_path: 'C:\inetpub\wwwroot\mi-app\frontend\build'
      deploy_mode: replace   # replace | junction (default)
      app_pool: mi-app-pool  # opcional
      health_check:
        url: https://mi-app.local  # opcional
        timeout_seconds: 10

    backend:
      enabled: true
      repo_path: 'C:\inetpub\wwwroot\mi-app'
      nssm_service: mi-app-backend
      health_check:
        url: http://localhost:8000/health
        timeout_seconds: 10
```

#### `deploy_mode`

| Modo | Comportamiento | Cuándo usarlo |
|---|---|---|
| `replace` | Reemplaza el contenido de `inetpub_path` directamente | IIS apunta al build folder |
| `junction` | Swap atómico via Directory Junction (`current → releases/version`) | Zero-downtime, IIS apunta a `current\` |

---

## Deploy Watcher (servidor Windows)

El watcher corre como servicio Windows y monitorea el manifest de SharePoint cada 30 segundos.

### Instalación

```powershell
cd C:\inetpub\wwwroot\mpa-deploy-tools\deploy-watcher
pip install -r requirements.txt

nssm install mpa-deploy-watcher python watcher.py
nssm set mpa-deploy-watcher AppDirectory C:\inetpub\wwwroot\mpa-deploy-tools\deploy-watcher
nssm set mpa-deploy-watcher AppEnvironmentExtra PYTHONUNBUFFERED=1
nssm start mpa-deploy-watcher
```

### `deploy-watcher.yml`

```yaml
poll_interval_seconds: 30
log_dir: "C:/inetpub/wwwroot/mpa-deploy-tools/deploy-watcher/logs"
credentials_env: "C:/inetpub/wwwroot/mpa-deploy-tools/deploy-watcher/.env"

projects:
  - config: "C:/inetpub/wwwroot/app-legal-filling/deploy.config.yml"
  - config: "C:/inetpub/wwwroot/mi-app/deploy.config.yml"
```

Para agregar una app nueva al watcher: añade una línea en `projects` y ejecuta `nssm restart mpa-deploy-watcher`.

### Actualizar el watcher tras cambios en este repo

```powershell
cd C:\inetpub\wwwroot\mpa-deploy-tools
git pull origin main
nssm restart mpa-deploy-watcher
```

---

## Rollback

**Opción 1 — Git revert** (recomendada):
```bash
git revert HEAD --no-edit
git push
```

**Opción 2 — Rollback automático**: si el health check falla tras un deploy, el watcher revierte automáticamente (`replace`: restaura backup, `junction`: restaura junction anterior).

---

## Logs

| Componente | Ubicación |
|---|---|
| Build agent | `~/.mpa-deploy/logs/deploy-YYYYMMDD.log` |
| Deploy watcher | Configurado en `deploy-watcher.yml → log_dir` |

---

## Versiones de artefactos

Formato: `YYYYMMDD_HHMMSS_shortSHA` — ejemplo: `20260314_162824_0a86138`

El manifest en SharePoint conserva los últimos 10 builds por proyecto.
