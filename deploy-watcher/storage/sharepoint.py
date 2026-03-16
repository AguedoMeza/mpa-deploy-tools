"""
storage/sharepoint.py
Cliente SharePoint sincrónico para el DeployWatcher.
Portado de app-leasing/backend/app/services/sharepoint_connector.py
"""

import os
import time
import json
import msal
import requests
import logging

logger = logging.getLogger(__name__)

GRAPH_BASE   = "https://graph.microsoft.com/v1.0"
MAX_RETRIES  = 3
RETRY_DELAY  = 2  # segundos (exponencial)


class SharePointClient:

    def __init__(self):
        self._token      = None
        self._token_exp  = 0
        self._site_id    = None

    # ── Auth ──────────────────────────────────────────────────────────────────

    def _get_token(self) -> str:
        if self._token and time.time() < self._token_exp - 60:
            return self._token

        app = msal.ConfidentialClientApplication(
            os.environ["GRAPH_CLIENT_ID"],
            authority=f"https://login.microsoftonline.com/{os.environ['GRAPH_TENANT_ID']}",
            client_credential=os.environ["GRAPH_CLIENT_SECRET"],
        )
        result = app.acquire_token_for_client(
            scopes=["https://graph.microsoft.com/.default"]
        )
        if "access_token" not in result:
            raise RuntimeError(f"MSAL error: {result.get('error_description')}")

        self._token     = result["access_token"]
        self._token_exp = time.time() + result.get("expires_in", 3600)
        logger.info("Token Graph obtenido")
        return self._token

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self._get_token()}"}

    # ── Site ID ───────────────────────────────────────────────────────────────

    def _get_site_id(self) -> str:
        if self._site_id:
            return self._site_id

        site_url  = os.environ["SHAREPOINT_SITE_URL"]   # mmreit.sharepoint.com
        site_path = os.environ["SHAREPOINT_SITE_PATH"]  # /sites/Apps Center

        url = f"{GRAPH_BASE}/sites/{site_url}:{site_path}"
        res = self._request("GET", url)
        self._site_id = res.json()["id"]
        logger.info(f"Site ID: {self._site_id}")
        return self._site_id

    # ── HTTP con reintentos ───────────────────────────────────────────────────

    def _request(self, method: str, url: str, **kwargs) -> requests.Response:
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                headers = self._headers()
                if "headers" in kwargs:
                    headers.update(kwargs.pop("headers"))
                res = requests.request(method, url, headers=headers,
                                       timeout=60, **kwargs)
                if res.ok:
                    return res
                if res.status_code in (429, 500, 502, 503, 504) and attempt < MAX_RETRIES:
                    delay = RETRY_DELAY * (2 ** (attempt - 1))
                    logger.warning(f"HTTP {res.status_code} — reintento {attempt} en {delay}s")
                    time.sleep(delay)
                    self._token = None  # forzar refresh de token
                    continue
                res.raise_for_status()
            except requests.exceptions.Timeout:
                if attempt == MAX_RETRIES:
                    raise
                time.sleep(RETRY_DELAY * (2 ** (attempt - 1)))
        raise RuntimeError(f"Falló después de {MAX_RETRIES} intentos")

    # ── API pública ───────────────────────────────────────────────────────────

    def get_manifest(self, sp_folder: str) -> dict | None:
        """Lee manifest.json desde SharePoint. Retorna None si no existe."""
        site_id = self._get_site_id()
        url = f"{GRAPH_BASE}/sites/{site_id}/drive/root:/{sp_folder}/manifest.json:/content"
        res = self._request("GET", url)
        if res.status_code == 404:
            return None
        return res.json()

    def download_file(self, sp_path: str, dest_path: str) -> None:
        """
        Descarga un archivo de SharePoint a disco en modo streaming.
        sp_path: ruta relativa en el drive  (e.g. "app-legal-filling/builds/v1.zip")
        dest_path: ruta local destino       (e.g. "C:/deploy-watcher/tmp/v1.zip")
        """
        site_id = self._get_site_id()
        url = f"{GRAPH_BASE}/sites/{site_id}/drive/root:/{sp_path}:/content"

        os.makedirs(os.path.dirname(dest_path), exist_ok=True)

        for attempt in range(1, MAX_RETRIES + 1):
            try:
                res = requests.get(url, headers=self._headers(),
                                   stream=True, timeout=120)
                res.raise_for_status()
                with open(dest_path, "wb") as f:
                    for chunk in res.iter_content(chunk_size=8192):
                        f.write(chunk)
                logger.info(f"Descargado: {dest_path}")
                return
            except Exception as e:
                if attempt == MAX_RETRIES:
                    raise
                logger.warning(f"Error descargando (intento {attempt}): {e}")
                time.sleep(RETRY_DELAY * (2 ** (attempt - 1)))


# Singleton
sharepoint = SharePointClient()
