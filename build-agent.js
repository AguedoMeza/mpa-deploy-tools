'use strict'

/**
 * build-agent.js
 * Lee deploy.config.yml del repo, detecta qué cambió en el último push
 * y decide si deployar frontend, backend, o ambos.
 *
 * FASE 1  — DRY RUN: solo loguea qué haría.
 * FASE 2a — build real + zip + SHA-256.
 * FASE 2b — upload a SharePoint + manifest. (ACTUAL)
 */

const path           = require('path')
const fs             = require('fs')
const os             = require('os')
const crypto         = require('crypto')
const { spawn }      = require('child_process')
const archiver       = require('archiver')
const sp             = require('./storage/sharepoint')

// Cargar .env.local del repo antes de todo
require('dotenv').config({ path: path.join(process.cwd(), '.env.local') })

const yaml             = require('js-yaml')
const { simpleGit }    = require('simple-git')

// ─── Configuración ────────────────────────────────────────────────────────────

const REPO_ROOT     = process.cwd()
const DRY_RUN       = process.env.BUILD_AGENT_ENABLED !== 'true'

// Directorios en home — fuera del repo
const MPA_DIR       = path.join(os.homedir(), '.mpa-deploy')
const LOG_DIR       = path.join(MPA_DIR, 'logs')
const ARTIFACTS_DIR = path.join(MPA_DIR, 'artifacts')
const LOG_FILE      = path.join(LOG_DIR, `deploy-${today()}.log`)

// ─── Helpers ──────────────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().slice(0, 10)
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
  try {
    fs.appendFileSync(LOG_FILE, line + '\n')
  } catch (_) { /* si no se puede escribir el log, continuar igual */ }
}

function ensureLogDir() {
  fs.mkdirSync(LOG_DIR,       { recursive: true })
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true })
}

// Versión: YYYYMMDD_HHMMSS_shortSHA  →  e.g. "20260312_181200_a3f9b2c"
function makeVersion(shortSha) {
  const now = new Date()
  const iso = now.toISOString().replace(/[-:.TZ]/g, '')
  const d   = `${iso.slice(0, 8)}_${iso.slice(8, 14)}`
  return `${d}_${shortSha}`
}

// Corre un comando en un directorio, streameando stdout/stderr al log
function runCommand(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    log(`[CMD] ${cmd} ${args.join(' ')}  (cwd: ${cwd})`)
    const child = spawn(cmd, args, { cwd, shell: true, env: process.env })

    child.stdout.on('data', d => d.toString().trim().split('\n')
      .forEach(line => log(`[OUT] ${line}`)))
    child.stderr.on('data', d => d.toString().trim().split('\n')
      .forEach(line => log(`[ERR] ${line}`)))

    child.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`"${cmd} ${args.join(' ')}" salió con código ${code}`))
    })
    child.on('error', reject)
  })
}

// Empaqueta un directorio en un ZIP, devuelve la ruta del archivo creado
function zipDirectory(sourceDir, destZip) {
  return new Promise((resolve, reject) => {
    const output  = fs.createWriteStream(destZip)
    const archive = archiver('zip', { zlib: { level: 9 } })

    output.on('close', () => {
      log(`[ZIP] ${archive.pointer()} bytes → ${path.basename(destZip)}`)
      resolve(destZip)
    })
    archive.on('error', reject)
    archive.on('warning', err => {
      if (err.code !== 'ENOENT') reject(err)
    })

    archive.pipe(output)
    archive.directory(sourceDir, false) // false = contenido en la raíz del zip
    archive.finalize()
  })
}

// SHA-256 de un archivo — para que el servidor pueda verificar integridad
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash   = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('data', d => hash.update(d))
    stream.on('end',  () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  ensureLogDir()

  // 1. Leer deploy.config.yml
  const configPath = path.join(REPO_ROOT, 'deploy.config.yml')
  if (!fs.existsSync(configPath)) {
    // Repo sin config de deploy → no es un proyecto gestionado
    process.exit(0)
  }

  let config
  try {
    config = yaml.load(fs.readFileSync(configPath, 'utf8'))
  } catch (err) {
    log(`ERROR leyendo deploy.config.yml: ${err.message}`)
    process.exit(1)
  }

  const projectName = config.project?.name ?? path.basename(REPO_ROOT)
  const mode = DRY_RUN ? 'DRY RUN — sin credenciales, solo loguea' : 'ACTIVO'

  log(`${'='.repeat(60)}`)
  log(`Proyecto: ${projectName}  |  Modo: ${mode}`)
  log(`Repo: ${REPO_ROOT}`)

  // 2. Detectar qué cambió en el último push (HEAD~1..HEAD)
  const git = simpleGit(REPO_ROOT)
  let summary

  try {
    summary = await git.diffSummary(['HEAD~1', 'HEAD'])
  } catch (err) {
    // Puede fallar en el primer commit (sin HEAD~1)
    log(`Sin commit anterior para comparar (primer push?) — skipping`)
    log(`Detalle: ${err.message}`)
    process.exit(0)
  }

  const changedFiles = summary.files.map(f => f.file)

  if (changedFiles.length === 0) {
    log('Sin archivos cambiados — skipping')
    process.exit(0)
  }

  log(`Archivos cambiados: ${changedFiles.length}`)
  changedFiles.slice(0, 8).forEach(f => log(`  · ${f}`))
  if (changedFiles.length > 8) log(`  · ... y ${changedFiles.length - 8} más`)

  // 3. Determinar qué capas cambiaron según paths en deploy.config.yml
  const frontendPath = config.paths?.frontend  // e.g. "frontend/"
  const backendPath  = config.paths?.backend   // e.g. "backend/"

  const frontendEnabled = config.deploy?.server?.frontend?.enabled !== false
  const backendEnabled  = config.deploy?.server?.backend?.enabled  !== false

  const frontendChanged = frontendEnabled && frontendPath &&
    changedFiles.some(f => f.startsWith(frontendPath))

  const backendChanged = backendEnabled && backendPath &&
    changedFiles.some(f => f.startsWith(backendPath))

  if (!frontendChanged && !backendChanged) {
    log('Cambios no afectan frontend ni backend configurados — skipping')
    log(`  (paths configurados: frontend="${frontendPath}", backend="${backendPath}")`)
    process.exit(0)
  }

  // 4. Ejecutar deploys en paralelo
  const tasks = []

  if (frontendChanged) {
    log(`Frontend cambió en "${frontendPath}"`)
    tasks.push(deployFrontend(config))
  }

  if (backendChanged) {
    log(`Backend cambió en "${backendPath}"`)
    tasks.push(deployBackend(config))
  }

  await Promise.all(tasks)
  log(`${'='.repeat(60)}`)
}

// ─── Deploy Frontend ──────────────────────────────────────────────────────────

async function deployFrontend(config) {
  const cfg         = config.build?.frontend
  const projectName = config.project.name

  if (DRY_RUN) {
    log(`[FRONTEND] WOULD ejecutar: cd ${cfg.working_dir} && ${cfg.command}`)
    log(`[FRONTEND] WOULD empaquetar: ${cfg.output_dir} → ZIP`)
    log(`[FRONTEND] WOULD subir ZIP a SharePoint/${config.deploy.storage.folder}`)
    log(`[FRONTEND] WOULD actualizar manifest.json → latest`)
    return
  }

  // 1. Obtener short SHA del commit actual
  const git      = simpleGit(REPO_ROOT)
  const logEntry = await git.log({ maxCount: 1 })
  const shortSha = logEntry.latest.hash.slice(0, 7)
  const version  = makeVersion(shortSha)

  log(`[FRONTEND] Versión: ${version}`)

  // 2. Correr el build
  const buildCwd = path.join(REPO_ROOT, cfg.working_dir)
  const [cmd, ...args] = cfg.command.split(' ')
  await runCommand(cmd, args, buildCwd)

  // 3. Verificar que el output existe
  const outputDir = path.join(REPO_ROOT, cfg.output_dir)
  if (!fs.existsSync(outputDir)) {
    throw new Error(`Build output no encontrado en: ${outputDir}`)
  }

  // 4. Empaquetar en ZIP
  const artifactDir = path.join(ARTIFACTS_DIR, projectName)
  fs.mkdirSync(artifactDir, { recursive: true })
  const zipPath = path.join(artifactDir, `${version}.zip`)
  await zipDirectory(outputDir, zipPath)

  // 5. Calcular SHA-256
  const checksum = await sha256File(zipPath)
  log(`[FRONTEND] SHA-256: ${checksum}`)

  // 6. Subir ZIP a SharePoint
  const spFolder    = config.deploy.storage.folder          // e.g. "app-legal-filling"
  const spBuildsDir = `${spFolder}/builds`
  const zipFilename = `${version}.zip`

  log(`[FRONTEND] Subiendo a SharePoint: ${spBuildsDir}/${zipFilename}`)
  const uploaded = await sp.uploadFile(zipPath, spBuildsDir, zipFilename)
  log(`[FRONTEND] Subido: ${uploaded.webUrl}`)

  // 7. Actualizar manifest.json en SharePoint
  const manifest = (await sp.getManifest(spFolder)) ?? { frontend: { builds: [] }, backend: {} }

  const buildEntry = {
    version,
    timestamp: new Date().toISOString(),
    path:      `${spBuildsDir}/${zipFilename}`,
    sha256:    checksum,
    pushed_by: process.env.GIT_AUTHOR_EMAIL ?? process.env.USERNAME ?? 'unknown',
    git_ref:   `main@${shortSha}`,
    web_url:   uploaded.webUrl,
  }

  // Añadir al frente, mantener últimas 10 entradas
  manifest.frontend.latest = version
  manifest.frontend.builds = [buildEntry, ...(manifest.frontend.builds ?? [])].slice(0, 10)

  await sp.putManifest(spFolder, manifest)
  log(`[FRONTEND] manifest.json actualizado → latest: ${version}`)

  // 8. Guardar metadata local como referencia
  fs.writeFileSync(
    path.join(artifactDir, `${version}.json`),
    JSON.stringify(buildEntry, null, 2)
  )

  log(`[FRONTEND] ✓ Deploy frontend completo`)
}

// ─── Deploy Backend ───────────────────────────────────────────────────────────

async function deployBackend(config) {
  if (DRY_RUN) {
    const git = simpleGit(REPO_ROOT)
    const log_ = await git.log({ maxCount: 1 })
    const commit = log_.latest?.hash?.slice(0, 7) ?? 'unknown'
    log(`[BACKEND]  WOULD actualizar manifest.json → backend.commit = ${commit}`)
    log(`[BACKEND]  WOULD señal: DeployWatcher hará git pull + nssm restart ${config.deploy.server.backend.nssm_service}`)
    return
  }

  // TODO Fase 2: implementar señal real
  // const git = simpleGit(REPO_ROOT)
  // const log_ = await git.log({ maxCount: 1 })
  // const commit = log_.latest.hash.slice(0, 7)
  // await storage.updateManifest(projectName, { backend: { signal: 'pull', commit } })
  log('[BACKEND] Fase 2 no implementada aún')
}

// ─── Run ──────────────────────────────────────────────────────────────────────

main().catch(err => {
  log(`FATAL: ${err.message}`)
  log(err.stack)
  process.exit(1)
})
