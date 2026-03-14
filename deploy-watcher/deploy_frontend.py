"""
deploy_frontend.py
Descarga el artefacto ZIP de SharePoint, verifica SHA-256,
hace swap atómico del Directory Junction e IIS App Pool.
Rollback automático si el health check falla.
"""

import os
import time
import hashlib
import zipfile
import shutil
import subprocess
import logging
import requests as req

from storage.sharepoint import sharepoint

logger = logging.getLogger(__name__)


# ── IIS App Pool ──────────────────────────────────────────────────────────────

APPCMD = r"C:\Windows\System32\inetsrv\appcmd.exe"

def _apppool(action: str, name: str) -> None:
    """Inicia o detiene un App Pool de IIS via appcmd.exe (sin módulos PS)."""
    result = subprocess.run(
        [APPCMD, action, "apppool", f"/apppool.name:{name}"],
        capture_output=True, text=True
    )
    # appcmd devuelve exit 1 si el pool ya está en el estado pedido — lo ignoramos
    if result.returncode not in (0, 1):
        raise subprocess.CalledProcessError(result.returncode,
              result.args, result.stdout, result.stderr)
    logger.info(f"App Pool '{name}' → {action} (rc={result.returncode})")


# ── Directory Junction ────────────────────────────────────────────────────────

def _swap_junction(junction: str, target: str) -> None:
    """
    Actualiza el Directory Junction de forma atómica.
    rmdir sin /s elimina solo la junction, no el contenido apuntado.
    """
    if os.path.exists(junction):
        subprocess.run(["cmd", "/c", "rmdir", junction], check=True, capture_output=True)
    subprocess.run(
        ["cmd", "/c", "mklink", "/J", junction, target],
        check=True, capture_output=True
    )
    logger.info(f"Junction: {junction} -> {target}")


# ── SHA-256 ───────────────────────────────────────────────────────────────────

def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


# ── Health check ──────────────────────────────────────────────────────────────

def _health_check(url: str, timeout: int, max_wait: int = 60) -> bool:
    """Reintenta el health check hasta max_wait segundos."""
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


# ── Purgar releases viejos ────────────────────────────────────────────────────

def _purge_old_releases(releases_dir: str, keep: int) -> None:
    entries = sorted([
        e for e in os.listdir(releases_dir)
        if os.path.isdir(os.path.join(releases_dir, e))
    ])
    for old in entries[:-keep]:
        old_path = os.path.join(releases_dir, old)
        shutil.rmtree(old_path, ignore_errors=True)
        logger.info(f"Purgado release antiguo: {old}")


# ── Deploy principal ──────────────────────────────────────────────────────────

def deploy_frontend(config: dict, version: str, build_entry: dict, tmp_dir: str) -> bool:
    """
    Despliega una nueva versión del frontend.
    Retorna True si fue exitoso, False si se hizo rollback.

    deploy_mode:
      junction (default) — swap atómico via Directory Junction, zero-downtime.
      replace            — reemplaza el contenido de inetpub_path directamente.
                           IIS toma los archivos estáticos sin reinicio.
    """
    srv        = config["deploy"]["server"]["frontend"]
    inetpub    = srv["inetpub_path"]
    app_pool   = srv.get("app_pool", "")
    keep       = srv.get("keep_releases", 5)
    hc_url     = srv.get("health_check", {}).get("url", "")
    hc_timeout = srv.get("health_check", {}).get("timeout_seconds", 10)
    mode       = srv.get("deploy_mode", "junction")

    os.makedirs(tmp_dir, exist_ok=True)

    # 1. Descargar ZIP desde SharePoint
    sp_path  = build_entry["path"]
    zip_path = os.path.join(tmp_dir, f"{version}.zip")

    logger.info(f"[FRONTEND] Descargando {sp_path}")
    sharepoint.download_file(sp_path, zip_path)

    # 2. Verificar SHA-256
    actual   = _sha256(zip_path)
    expected = build_entry["sha256"]
    if actual != expected:
        raise ValueError(f"SHA-256 no coincide: expected={expected} actual={actual}")
    logger.info(f"[FRONTEND] SHA-256 OK: {actual[:16]}...")

    if mode == "replace":
        return _deploy_replace(inetpub, zip_path, version, app_pool, hc_url, hc_timeout)
    else:
        return _deploy_junction(inetpub, zip_path, version, app_pool, keep, hc_url, hc_timeout)


def _deploy_replace(inetpub: str, zip_path: str, version: str,
                    app_pool: str, hc_url: str, hc_timeout: int) -> bool:
    """Reemplaza el contenido de inetpub_path directamente con el nuevo build."""

    backup_path = inetpub + f"._backup_{version}"

    # 1. Backup del contenido actual para rollback
    if os.path.isdir(inetpub):
        shutil.copytree(inetpub, backup_path, dirs_exist_ok=False)

    try:
        # 2. Limpiar destino y extraer nuevo build
        if os.path.isdir(inetpub):
            shutil.rmtree(inetpub)
        os.makedirs(inetpub)
        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(inetpub)
        logger.info(f"[FRONTEND] Contenido reemplazado en {inetpub}")
    except Exception as e:
        logger.error(f"[FRONTEND] Error al reemplazar: {e} — revirtiendo")
        if os.path.isdir(backup_path):
            shutil.rmtree(inetpub, ignore_errors=True)
            shutil.copytree(backup_path, inetpub)
        return False

    # 3. Reciclar App Pool si está configurado
    if app_pool:
        logger.info(f"[FRONTEND] Reciclando App Pool '{app_pool}'")
        subprocess.run([APPCMD, "recycle", "apppool", f"/apppool.name:{app_pool}"],
                       capture_output=True)

    # 4. Health check
    if not hc_url:
        logger.info(f"[FRONTEND] Deploy exitoso (sin health check): {version}")
        _cleanup_backup(backup_path)
        return True

    logger.info(f"[FRONTEND] Health check: {hc_url}")
    if _health_check(hc_url, hc_timeout):
        logger.info(f"[FRONTEND] Deploy exitoso: {version}")
        _cleanup_backup(backup_path)
        return True

    # 5. Rollback automático
    logger.error(f"[FRONTEND] Health check fallido — rollback")
    shutil.rmtree(inetpub, ignore_errors=True)
    if os.path.isdir(backup_path):
        shutil.copytree(backup_path, inetpub)
    return False


def _cleanup_backup(backup_path: str) -> None:
    if os.path.isdir(backup_path):
        shutil.rmtree(backup_path, ignore_errors=True)


def _deploy_junction(inetpub: str, zip_path: str, version: str, app_pool: str,
                     keep: int, hc_url: str, hc_timeout: int) -> bool:
    """Swap atómico via Directory Junction. Zero-downtime."""

    releases_dir  = os.path.join(inetpub, "releases")
    junction_path = os.path.join(inetpub, "current")
    release_path  = os.path.join(releases_dir, version)

    os.makedirs(releases_dir, exist_ok=True)

    # 1. Extraer a releases/{version}/
    logger.info(f"[FRONTEND] Extrayendo a {release_path}")
    with zipfile.ZipFile(zip_path, "r") as zf:
        zf.extractall(release_path)

    # 2. Guardar target anterior para rollback
    prev_target = None
    if os.path.exists(junction_path):
        result = subprocess.run(
            ["cmd", "/c", "fsutil", "reparsepoint", "query", junction_path],
            capture_output=True, text=True
        )
        for line in result.stdout.splitlines():
            if "Print Name:" in line:
                prev_target = line.split(":", 1)[1].strip()
                break

    # 3. Swap junction
    try:
        _swap_junction(junction_path, release_path)
    except Exception as e:
        logger.error(f"[FRONTEND] Error en junction: {e} — revirtiendo")
        if prev_target:
            _swap_junction(junction_path, prev_target)
        return False

    # 4. Reciclar App Pool si está configurado
    if app_pool:
        logger.info(f"[FRONTEND] Reciclando App Pool '{app_pool}'")
        subprocess.run([APPCMD, "recycle", "apppool", f"/apppool.name:{app_pool}"],
                       capture_output=True)

    # 5. Health check
    if not hc_url:
        logger.info(f"[FRONTEND] Deploy exitoso (sin health check): {version}")
        _purge_old_releases(releases_dir, keep)
        return True

    logger.info(f"[FRONTEND] Health check: {hc_url}")
    if _health_check(hc_url, hc_timeout):
        logger.info(f"[FRONTEND] Deploy exitoso: {version}")
        _purge_old_releases(releases_dir, keep)
        return True

    # 6. Rollback automático
    logger.error(f"[FRONTEND] Health check fallido — rollback a {prev_target}")
    if prev_target:
        _swap_junction(junction_path, prev_target)
    return False
