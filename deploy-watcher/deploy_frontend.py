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
    logger.info(f"Junction: {junction} → {target}")


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
    """
    srv       = config["deploy"]["server"]["frontend"]
    inetpub   = srv["inetpub_path"]          # C:\inetpub\wwwroot\app-legal-filling
    app_pool  = srv["app_pool"]
    keep      = srv.get("keep_releases", 5)
    hc_url    = srv["health_check"]["url"]
    hc_timeout = srv["health_check"].get("timeout_seconds", 10)

    releases_dir  = os.path.join(inetpub, "releases")
    junction_path = os.path.join(inetpub, "current")
    release_path  = os.path.join(releases_dir, version)

    os.makedirs(releases_dir, exist_ok=True)
    os.makedirs(tmp_dir, exist_ok=True)

    # 1. Descargar ZIP desde SharePoint
    sp_path  = build_entry["path"]  # e.g. "app-legal-filling/builds/v1.zip"
    zip_path = os.path.join(tmp_dir, f"{version}.zip")

    logger.info(f"[FRONTEND] Descargando {sp_path}")
    sharepoint.download_file(sp_path, zip_path)

    # 2. Verificar SHA-256
    actual   = _sha256(zip_path)
    expected = build_entry["sha256"]
    if actual != expected:
        raise ValueError(f"SHA-256 no coincide: expected={expected} actual={actual}")
    logger.info(f"[FRONTEND] SHA-256 OK: {actual[:16]}...")

    # 3. Extraer a releases/{version}/
    logger.info(f"[FRONTEND] Extrayendo a {release_path}")
    with zipfile.ZipFile(zip_path, "r") as zf:
        zf.extractall(release_path)

    # 4. Guardar versión anterior para rollback
    prev_target = os.readlink(junction_path) if os.path.islink(junction_path) else None
    if os.path.exists(junction_path) and not os.path.islink(junction_path):
        # Junction en Windows: os.readlink puede fallar — obtenemos target vía cmd
        result = subprocess.run(
            ["cmd", "/c", "fsutil", "reparsepoint", "query", junction_path],
            capture_output=True, text=True
        )
        for line in result.stdout.splitlines():
            if "Print Name:" in line:
                prev_target = line.split(":", 1)[1].strip()
                break

    # 5. Swap junction (archivos estáticos no requieren reinicio de App Pool)
    try:
        _swap_junction(junction_path, release_path)
    except Exception as e:
        logger.error(f"[FRONTEND] Error en junction: {e} — revirtiendo")
        if prev_target:
            _swap_junction(junction_path, prev_target)
        return False

    # 6. Reciclar App Pool solo si está configurado explícitamente
    if app_pool:
        logger.info(f"[FRONTEND] Reciclando App Pool '{app_pool}'")
        subprocess.run([APPCMD, "recycle", "apppool", f"/apppool.name:{app_pool}"],
                       capture_output=True)

    # 7. Health check
    logger.info(f"[FRONTEND] Health check: {hc_url}")
    if _health_check(hc_url, hc_timeout):
        logger.info(f"[FRONTEND] ✓ Deploy exitoso: {version}")
        _purge_old_releases(releases_dir, keep)
        return True

    # 8. Rollback automático
    logger.error(f"[FRONTEND] Health check fallido — rollback a {prev_target}")
    if prev_target:
        _swap_junction(junction_path, prev_target)
    return False
