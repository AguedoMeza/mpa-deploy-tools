"""
deploy_backend.py
Hace git pull en el repo del servidor y reinicia el servicio NSSM.
Rollback automático (git reset --hard) si el health check falla.
"""

import subprocess
import logging
import time
import requests as req

logger = logging.getLogger(__name__)


def _health_check(url: str, timeout: int, max_wait: int = 60) -> bool:
    deadline = time.time() + max_wait
    while time.time() < deadline:
        try:
            r = req.get(url, timeout=timeout)
            if r.status_code == 200:
                return True
        except Exception:
            pass
        time.sleep(3)
    return False


def _git(repo: str, *args) -> str:
    result = subprocess.run(
        ["git", "-C", repo, *args],
        capture_output=True, text=True, check=True
    )
    return result.stdout.strip()


def deploy_backend(config: dict, commit: str) -> bool:
    """
    Despliega el backend haciendo git pull + nssm restart.
    Retorna True si fue exitoso, False si se hizo rollback.
    """
    srv         = config["deploy"]["server"]["backend"]
    repo_path   = srv["repo_path"]
    service     = srv["nssm_service"]
    hc_url      = srv.get("health_check", {}).get("url", "")
    hc_timeout  = srv.get("health_check", {}).get("timeout_seconds", 10)

    # 1. Guardar commit actual para rollback
    try:
        prev_commit = _git(repo_path, "rev-parse", "HEAD")
    except Exception:
        prev_commit = None

    logger.info(f"[BACKEND] Commit actual: {prev_commit}")
    logger.info(f"[BACKEND] Target commit: {commit}")

    # 2. Git pull
    # Usar rama del config si está definida, si no auto-detectar del repo local
    branch = srv.get("branch") or None
    if not branch:
        try:
            branch = _git(repo_path, "rev-parse", "--abbrev-ref", "HEAD")
        except Exception:
            branch = "main"

    logger.info(f"[BACKEND] git pull en {repo_path} (rama: {branch})")
    try:
        out = _git(repo_path, "pull", "origin", branch)
        logger.info(f"[BACKEND] {out}")
    except subprocess.CalledProcessError as e:
        logger.error(f"[BACKEND] git pull falló: {e.stderr}")
        return False

    # 3. Reiniciar servicio NSSM
    logger.info(f"[BACKEND] nssm restart '{service}'")
    subprocess.run(["nssm", "restart", service], check=True)

    # 4. Health check (opcional)
    if not hc_url:
        logger.info(f"[BACKEND] Deploy exitoso (sin health check): commit {commit}")
        return True

    logger.info(f"[BACKEND] Health check: {hc_url}")
    if _health_check(hc_url, hc_timeout):
        logger.info(f"[BACKEND] Deploy exitoso: commit {commit}")
        return True

    # 5. Rollback automático
    logger.error(f"[BACKEND] Health check fallido — rollback a {prev_commit}")
    if prev_commit:
        try:
            _git(repo_path, "reset", "--hard", prev_commit)
            subprocess.run(["nssm", "restart", service], check=True)
            logger.info(f"[BACKEND] Rollback aplicado: {prev_commit}")
        except Exception as e:
            logger.error(f"[BACKEND] Error en rollback: {e}")

    return False
