'use strict'

/**
 * storage/sharepoint.js
 * Cliente SharePoint via Microsoft Graph API.
 * Portado de app-leasing/backend/app/services/sharepoint_connector.py
 *
 * Operaciones:
 *   uploadFile(localPath, spFolder, filename)  → sube un archivo binario
 *   getManifest(spFolder)                      → lee manifest.json (null si no existe)
 *   putManifest(spFolder, manifest)            → escribe manifest.json
 */

const fs    = require('fs')
const fetch = require('node-fetch')
const { ConfidentialClientApplication } = require('@azure/msal-node')

const MAX_RETRIES    = 3
const RETRY_DELAY_MS = 2000
const GRAPH_BASE     = 'https://graph.microsoft.com/v1.0'

// ─── Token ────────────────────────────────────────────────────────────────────

let _tokenCache = { token: null, expiresAt: 0 }

async function getToken() {
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt - 60_000) {
    return _tokenCache.token
  }

  const msalClient = new ConfidentialClientApplication({
    auth: {
      clientId:     process.env.GRAPH_CLIENT_ID,
      authority:    `https://login.microsoftonline.com/${process.env.GRAPH_TENANT_ID}`,
      clientSecret: process.env.GRAPH_CLIENT_SECRET,
    },
  })

  const result = await msalClient.acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default'],
  })

  if (!result?.accessToken) {
    throw new Error('MSAL no devolvió token — verifica GRAPH_CLIENT_ID/SECRET/TENANT_ID')
  }

  _tokenCache = {
    token:     result.accessToken,
    expiresAt: result.expiresOn?.getTime() ?? (Date.now() + 3600_000),
  }

  return _tokenCache.token
}

// ─── Site ID (cacheado en memoria) ───────────────────────────────────────────

let _siteId = null

async function getSiteId() {
  if (_siteId) return _siteId

  const token    = await getToken()
  const siteUrl  = process.env.SHAREPOINT_SITE_URL   // mmreit.sharepoint.com
  const sitePath = process.env.SHAREPOINT_SITE_PATH  // /sites/Apps Center

  const url = `${GRAPH_BASE}/sites/${encodeURIComponent(siteUrl)}:${sitePath}`

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`getSiteId HTTP ${res.status}: ${body}`)
  }

  const data = await res.json()
  _siteId = data.id
  return _siteId
}

// ─── Helper: fetch con reintentos ─────────────────────────────────────────────

async function fetchWithRetry(url, options) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, options)

      if (res.ok) return res

      // Reintentar en errores transitorios
      if ([429, 500, 502, 503, 504].includes(res.status) && attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1)
        await sleep(delay)
        // Refrescar token por si expiró
        _tokenCache.token = null
        options.headers.Authorization = `Bearer ${await getToken()}`
        continue
      }

      const body = await res.text()
      throw new Error(`HTTP ${res.status}: ${body}`)

    } catch (err) {
      if (attempt === MAX_RETRIES) throw err
      await sleep(RETRY_DELAY_MS * Math.pow(2, attempt - 1))
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Sube un archivo local a SharePoint.
 * @param {string} localPath  ruta absoluta del archivo a subir
 * @param {string} spFolder   carpeta destino en SharePoint  (e.g. "app-legal-filling/builds")
 * @param {string} filename   nombre del archivo             (e.g. "20260313_1bc37a5.zip")
 * @returns {{ id, webUrl, name, size }}
 */
async function uploadFile(localPath, spFolder, filename) {
  const token   = await getToken()
  const siteId  = await getSiteId()
  const content = fs.readFileSync(localPath)

  const url = `${GRAPH_BASE}/sites/${siteId}/drive/root:/${spFolder}/${filename}:/content`

  const res = await fetchWithRetry(url, {
    method:  'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
    },
    body: content,
  })

  const data = await res.json()
  return { id: data.id, webUrl: data.webUrl, name: data.name, size: data.size }
}

/**
 * Lee manifest.json desde SharePoint. Devuelve null si no existe.
 * @param {string} spFolder  carpeta del proyecto (e.g. "app-legal-filling")
 */
async function getManifest(spFolder) {
  const token  = await getToken()
  const siteId = await getSiteId()

  const url = `${GRAPH_BASE}/sites/${siteId}/drive/root:/${spFolder}/manifest.json:/content`

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (res.status === 404) return null
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`getManifest HTTP ${res.status}: ${body}`)
  }

  return res.json()
}

/**
 * Escribe manifest.json en SharePoint (crea o sobreescribe).
 * @param {string} spFolder   carpeta del proyecto
 * @param {object} manifest   objeto a serializar como JSON
 */
async function putManifest(spFolder, manifest) {
  const token   = await getToken()
  const siteId  = await getSiteId()
  const content = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')

  const url = `${GRAPH_BASE}/sites/${siteId}/drive/root:/${spFolder}/manifest.json:/content`

  await fetchWithRetry(url, {
    method:  'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: content,
  })
}

module.exports = { uploadFile, getManifest, putManifest }
