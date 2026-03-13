"""
watcher.py
Servicio principal del DeployWatcher.
Lee deploy-watcher.yml, polling SharePoint cada N segundos,
y dispara deploys de frontend y/o backend según cambios en manifest.json.

Instalación como servicio Windows:
    nssm install mpa-deploy-watcher python watcher.py
    nssm set mpa-deploy-watcher AppDirectory C:/deploy-watcher
    nssm set mpa-deploy-watcher AppEnvironmentExtra PYTHONUNBUFFERED=1
    nssm start mpa-deploy-watcher
"""

import os
import sys
import json
import time
import logging
import yaml
from dotenv import load_dotenv
from pathlib import Path

from storage.sharepoint import sharepoint
from deploy_frontend import deploy_frontend
from deploy_backend  import deploy_backend

# ── Config ────────────────────────────────────────────────────────────────────

WATCHER_DIR  = Path(__file__).parent          # C:\deploy-watcher
CONFIG_FILE  = WATCHER_DIR / "deploy-watcher.yml"
STATE_DIR    = WATCHER_DIR / "state"
TMP_DIR      = WATCHER_DIR / "tmp"


# ── Logging ───────────────────────────────────────────────────────────────────

def setup_logging(log_dir: str) -> None:
    os.makedirs(log_dir, exist_ok=True)
    from logging.handlers import TimedRotatingFileHandler
    log_file = os.path.join(log_dir, "watcher.log")
    handler  = TimedRotatingFileHandler(log_file, when="midnight", backupCount=30)
    handler.setFormatter(logging.Formatter(
        "%(asctime)s [%(levelname)s] %(message)s"
    ))
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(handler)
    root.addHandler(logging.StreamHandler(sys.stdout))


# ── State ─────────────────────────────────────────────────────────────────────

def load_state(project_name: str) -> dict:
    path = STATE_DIR / f"{project_name}.json"
    if path.exists():
        return json.loads(path.read_text())
    return {}


def save_state(project_name: str, state: dict) -> None:
    STATE_DIR.mkdir(exist_ok=True)
    path = STATE_DIR / f"{project_name}.json"
    path.write_text(json.dumps(state, indent=2))


# ── Check & deploy por proyecto ───────────────────────────────────────────────

def check_project(project_cfg: dict) -> None:
    project_name = project_cfg["project"]["name"]
    sp_folder    = project_cfg["deploy"]["storage"]["folder"]
    logger       = logging.getLogger(project_name)

    try:
        manifest = sharepoint.get_manifest(sp_folder)
        if not manifest:
            logger.debug("Sin manifest.json aún — esperando primer deploy")
            return

        state = load_state(project_name)

        # ── Frontend ──────────────────────────────────────────────────────────
        fe_cfg     = project_cfg["deploy"]["server"].get("frontend", {})
        fe_enabled = fe_cfg.get("enabled", True)
        fe_manifest = manifest.get("frontend", {})
        latest     = fe_manifest.get("latest")

        if fe_enabled and latest and latest != state.get("frontend_version"):
            logger.info(f"Nueva versión frontend detectada: {latest}")

            build_entry = next(
                (b for b in fe_manifest.get("builds", []) if b["version"] == latest),
                None
            )
            if not build_entry:
                logger.error(f"Build entry no encontrado para versión {latest}")
            else:
                ok = deploy_frontend(project_cfg, latest, build_entry, str(TMP_DIR))
                if ok:
                    state["frontend_version"] = latest
                    save_state(project_name, state)
                    logger.info(f"Estado guardado: frontend={latest}")

        # ── Backend ───────────────────────────────────────────────────────────
        be_cfg      = project_cfg["deploy"]["server"].get("backend", {})
        be_enabled  = be_cfg.get("enabled", True)
        be_manifest = manifest.get("backend", {})
        commit      = be_manifest.get("commit")

        if be_enabled and commit and commit != state.get("backend_commit"):
            logger.info(f"Nuevo commit backend detectado: {commit}")

            ok = deploy_backend(project_cfg, commit)
            if ok:
                state["backend_commit"] = commit
                save_state(project_name, state)
                logger.info(f"Estado guardado: backend={commit}")

    except Exception as e:
        logging.getLogger(project_name).error(f"Error en check_project: {e}", exc_info=True)


# ── Main loop ─────────────────────────────────────────────────────────────────

def main() -> None:
    if not CONFIG_FILE.exists():
        print(f"ERROR: {CONFIG_FILE} no encontrado")
        sys.exit(1)

    watcher_cfg = yaml.safe_load(CONFIG_FILE.read_text())

    # Cargar credenciales desde .env del servidor
    credentials_env = watcher_cfg.get("credentials_env")
    if credentials_env and os.path.exists(credentials_env):
        load_dotenv(credentials_env)

    setup_logging(watcher_cfg.get("log_dir", str(WATCHER_DIR / "logs")))
    STATE_DIR.mkdir(exist_ok=True)
    TMP_DIR.mkdir(exist_ok=True)

    interval = watcher_cfg.get("poll_interval_seconds", 30)
    projects = watcher_cfg.get("projects", [])

    logging.info(f"DeployWatcher iniciado — {len(projects)} proyectos, polling cada {interval}s")

    while True:
        for entry in projects:
            config_path = entry["config"]
            if not os.path.exists(config_path):
                logging.warning(f"deploy.config.yml no encontrado: {config_path}")
                continue
            project_cfg = yaml.safe_load(Path(config_path).read_text())
            check_project(project_cfg)

        time.sleep(interval)


if __name__ == "__main__":
    main()
