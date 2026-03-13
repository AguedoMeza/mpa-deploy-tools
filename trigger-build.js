'use strict'

/**
 * trigger-build.js
 * Invocado por .husky/post-push
 * Spawnea build-agent.js en background y termina inmediatamente
 * para que git push no quede bloqueado esperando el deploy.
 */

const { spawn } = require('child_process')
const path = require('path')

// Cargar .env.local del repo para que BUILD_AGENT_ENABLED esté disponible
// antes de pasarlo al proceso hijo
require('dotenv').config({ path: path.join(process.cwd(), '.env.local') })

const child = spawn(
  process.execPath, // mismo ejecutable de node que está corriendo
  [path.join(__dirname, 'build-agent.js')],
  {
    cwd: process.cwd(), // raíz del repo que hizo el push
    detached: true,     // proceso independiente del hook
    stdio: 'ignore',    // no hereda stdin/stdout/stderr del hook
    windowsHide: true,  // en Windows: no abre ventana de terminal
    env: process.env,   // hereda las variables de entorno del shell
  }
)

child.unref() // permite que este proceso termine sin esperar al hijo
process.exit(0)
