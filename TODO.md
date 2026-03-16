# TODO

## Pendiente

- [ ] **rollback.js** — CLI para revertir a una versión anterior sin necesidad de git revert.
  Lista los últimos builds del manifest en SharePoint y permite elegir cuál desplegar
  actualizando `latest`. El watcher lo detecta y deploya automáticamente.

- [ ] **Build asíncrono** — El build actual bloquea el `git push` (~15s o más en builds lentos).
  El push debería completarse inmediatamente y el build correr en background.
  Bloqueante actual: los procesos detached no sobreviven de forma confiable en WSL.
  Alternativa a evaluar: GitHub Actions self-hosted runner o un daemon local persistente.

- [ ] **Notificaciones de fallo de deploy** — Cuando el watcher falla (health check, git pull,
  error de extracción), el desarrollador no recibe ningún aviso. Solo se entera revisando
  logs en el servidor manualmente. Agregar notificación por Teams/email/webhook cuando
  un deploy falla o el rollback automático se activa.

- [ ] **Backend deploy completo** — El deploy de backend solo hace `git pull + nssm restart`.
  No maneja cambios en dependencias (`pip install -r requirements.txt`), virtual environments,
  ni migraciones de base de datos. Un cambio en `requirements.txt` desplegará código nuevo
  sin las dependencias actualizadas, causando errores en producción.
