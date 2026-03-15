#!/usr/bin/env node
'use strict'

/**
 * init.js
 * Configura un repo para usar mpa-deploy-tools de forma portable.
 *
 * Uso:
 *   npx mpa-deploy-tools init          # configura todo
 *   npx mpa-deploy-tools init --check  # solo diagnostica, no modifica
 */

const fs   = require('fs')
const path = require('path')
const os   = require('os')
const { execSync } = require('child_process')

const CHECK_ONLY = process.argv.includes('--check')
const REPO_ROOT  = process.cwd()

let errors   = 0
let warnings = 0

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(msg)   { console.log(`  ✔  ${msg}`) }
function warn(msg) { console.log(`  ⚠  ${msg}`); warnings++ }
function fail(msg) { console.log(`  ✘  ${msg}`); errors++ }
function info(msg) { console.log(`     ${msg}`) }
function section(title) { console.log(`\n── ${title}`) }

function write(filePath, content) {
  if (CHECK_ONLY) {
    fail(`Falta: ${filePath}`)
    info(`→ Ejecuta sin --check para crearlo automáticamente`)
    return
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf-8')
  ok(`Creado: ${filePath}`)
}

function patchJson(filePath, patcher) {
  if (!fs.existsSync(filePath)) {
    fail(`No encontrado: ${filePath}`)
    return
  }
  const obj = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  const changed = patcher(obj)
  if (changed) {
    if (CHECK_ONLY) {
      fail(`Desactualizado: ${filePath}`)
    } else {
      fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf-8')
      ok(`Actualizado: ${filePath}`)
    }
  } else {
    ok(filePath)
  }
}


// ── 1. Husky init.sh global (resuelve NVM sin rutas absolutas) ────────────────

function checkHuskyInitSh() {
  section('Husky init.sh — NVM portable')

  const huskyInitDir = path.join(os.homedir(), '.config', 'husky')
  const huskyInitSh  = path.join(huskyInitDir, 'init.sh')

  const content = [
    '# Cargado por husky antes de cada git hook',
    '# Inicializa NVM para que "node" esté disponible sin rutas absolutas',
    'export NVM_DIR="$HOME/.nvm"',
    '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"',
    '',
  ].join('\n')

  if (fs.existsSync(huskyInitSh)) {
    const current = fs.readFileSync(huskyInitSh, 'utf-8')
    if (current.includes('NVM_DIR')) {
      ok(`~/.config/husky/init.sh — NVM ya configurado`)
      return
    }
    warn(`~/.config/husky/init.sh existe pero no carga NVM`)
    if (!CHECK_ONLY) {
      fs.appendFileSync(huskyInitSh, '\n' + content)
      ok('Añadido bloque NVM a init.sh')
    }
  } else {
    write(huskyInitSh, content)
  }
}


// ── 2. Limpiar token del repository.url en package.json ──────────────────────

function checkRepoUrl() {
  section('package.json repository.url')

  const pkgPath = path.join(REPO_ROOT, 'package.json')
  if (!fs.existsSync(pkgPath)) return

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
  const url = pkg?.repository?.url || ''

  // Detectar token embebido (ghp_, ghs_, github_pat_, etc.)
  if (!/https?:\/\/[^@]*@/.test(url)) {
    ok('repository.url — sin token')
    return
  }

  info(`→ URL actual: ${url}`)

  if (!CHECK_ONLY) {
    pkg.repository.url = url.replace(/https?:\/\/[^@]*@/, 'https://')
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8')
    ok(`repository.url limpiado: ${pkg.repository.url}`)
  } else {
    fail('repository.url contiene credenciales embebidas')
    info('→ Ejecuta sin --check para limpiarlo automáticamente')
  }
}


// ── 3. Scripts en package.json ────────────────────────────────────────────────

function checkPackageScripts() {
  section('Scripts en package.json')

  const pkgPath = path.join(REPO_ROOT, 'package.json')
  const required = {
    prepush:          'node node_modules/mpa-deploy-tools/build-agent.js',
    'deploy:dry-run': 'node node_modules/mpa-deploy-tools/build-agent.js',
  }

  patchJson(pkgPath, (pkg) => {
    pkg.scripts = pkg.scripts || {}
    let changed = false
    for (const [name, cmd] of Object.entries(required)) {
      if (!pkg.scripts[name]) {
        pkg.scripts[name] = cmd
        changed = true
      } else {
        ok(`script "${name}" ya existe`)
      }
    }
    return changed
  })
}


// ── 3. Hook pre-commit (limpia el default de husky init) ─────────────────────

function checkPreCommitHook() {
  section('Hook .husky/pre-commit')

  const hookPath = path.join(REPO_ROOT, '.husky', 'pre-commit')
  if (!fs.existsSync(hookPath)) {
    ok('pre-commit no existe — ok')
    return
  }

  const current = fs.readFileSync(hookPath, 'utf-8')
  if (current.includes('npm test')) {
    fail('.husky/pre-commit corre "npm test" — bloquea commits si no hay tests')
    info('→ Eliminando hook pre-commit generado por husky init')
    if (!CHECK_ONLY) {
      fs.unlinkSync(hookPath)
      ok('pre-commit eliminado')
    }
  } else {
    ok('.husky/pre-commit — ok')
  }
}


// ── 4. Hook pre-push portable ─────────────────────────────────────────────────

function checkPrePushHook() {
  section('Hook .husky/pre-push')

  const hookPath = path.join(REPO_ROOT, '.husky', 'pre-push')
  const expected = 'npm run prepush\n'

  if (fs.existsSync(hookPath)) {
    const current = fs.readFileSync(hookPath, 'utf-8')

    // Detectar ruta absoluta (anti-patrón)
    if (/\/home\/|\/Users\/|C:\\/.test(current)) {
      fail('.husky/pre-push contiene ruta absoluta — no es portable')
      info(`→ Contenido actual: ${current.trim()}`)
      if (!CHECK_ONLY) {
        fs.writeFileSync(hookPath, expected, 'utf-8')
        fs.chmodSync(hookPath, 0o755)
        ok('Hook reemplazado con versión portable')
      } else {
        info('→ Ejecuta sin --check para corregirlo automáticamente')
      }
    } else if (current.includes('npm run prepush')) {
      ok('.husky/pre-push — portable ✔')
    } else {
      warn(`.husky/pre-push existe pero no llama npm run prepush`)
      info(`→ Contenido actual: ${current.trim()}`)
    }
  } else {
    write(hookPath, expected)
    if (!CHECK_ONLY) fs.chmodSync(hookPath, 0o755)
  }
}


// ── 4. Husky instalado ────────────────────────────────────────────────────────

function checkHusky() {
  section('Husky')

  const huskyBin = path.join(REPO_ROOT, 'node_modules', '.bin', 'husky')
  if (!fs.existsSync(huskyBin)) {
    fail('husky no está instalado')
    info('→ npm install --save-dev husky')
    return
  }
  ok('husky instalado')

  const huskyDir = path.join(REPO_ROOT, '.husky')
  if (!fs.existsSync(huskyDir)) {
    if (!CHECK_ONLY) {
      execSync('npx husky init', { cwd: REPO_ROOT, stdio: 'pipe' })
      ok('.husky/ inicializado')
    } else {
      fail('.husky/ no existe — ejecuta: npx husky init')
    }
  } else {
    ok('.husky/ existe')
  }
}


// ── 5. deploy.config.yml ──────────────────────────────────────────────────────

function checkDeployConfig() {
  section('deploy.config.yml')

  const configPath = path.join(REPO_ROOT, 'deploy.config.yml')
  if (!fs.existsSync(configPath)) {
    fail('deploy.config.yml no encontrado')
    info('→ Crea deploy.config.yml con la configuración de tu proyecto')
    info('   Ver ejemplo en: node_modules/mpa-deploy-tools/deploy-watcher/deploy-watcher.example.yml')
    return
  }

  const content = fs.readFileSync(configPath, 'utf-8')
  const required = ['project:', 'build:', 'deploy:']
  for (const key of required) {
    if (!content.includes(key)) {
      fail(`deploy.config.yml: falta sección "${key}"`)
    } else {
      ok(`deploy.config.yml: sección "${key}" presente`)
    }
  }
}


// ── 6. Variables de entorno ───────────────────────────────────────────────────

function checkEnvVars() {
  section('Variables de entorno (.env.local)')

  const envPath = path.join(REPO_ROOT, '.env.local')
  if (!fs.existsSync(envPath)) {
    fail('.env.local no encontrado')
    info('→ Copia .env.local de otro repo o pide las credenciales al owner del pipeline')
    return
  }

  require('dotenv').config({ path: envPath })

  const required = [
    'GRAPH_CLIENT_ID',
    'GRAPH_TENANT_ID',
    'GRAPH_CLIENT_SECRET',
    'SHAREPOINT_SITE_URL',
    'SHAREPOINT_SITE_PATH',
    'BUILD_AGENT_ENABLED',
  ]

  for (const key of required) {
    if (process.env[key]) {
      ok(`${key} ✔`)
    } else {
      fail(`${key} — falta en .env.local`)
    }
  }
}


// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`\nmpa-deploy-tools init ${CHECK_ONLY ? '(--check)' : ''}`)
console.log(`Repo: ${REPO_ROOT}\n`)

checkHusky()
checkHuskyInitSh()
checkRepoUrl()
checkPackageScripts()
checkPreCommitHook()
checkPrePushHook()
checkDeployConfig()
checkEnvVars()

console.log('\n' + '─'.repeat(50))
if (errors === 0 && warnings === 0) {
  console.log('✔  Todo listo. El repo está configurado correctamente.')
  process.exit(0)
} else {
  console.log(`${errors} error(es), ${warnings} advertencia(s)`)
  if (errors > 0) {
    console.log(CHECK_ONLY
      ? '→ Ejecuta: npx mpa-deploy-tools init   (para corregir automáticamente)'
      : '→ Corrige los errores manualmente y vuelve a ejecutar init')
  }
  process.exit(errors > 0 ? 1 : 0)
}
