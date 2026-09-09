// Точка входа сервиса агентов (ADR 2026-09-10-1000). Битая конфигурация
// или отсутствующий секрет валят процесс здесь — до открытия порта.

import { readFileSync } from 'node:fs'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNewsAnalyst } from './src/agent.js'
import { parseEnv } from './src/env.js'
import { loadRegistry } from './src/registry.js'
import { createRuns } from './src/runs.js'
import { createService } from './src/service.js'
import { createSessions } from './src/sessions.js'
import { createArchiveTool } from './src/tools/archive/index.js'

const here = dirname(fileURLToPath(import.meta.url))

const { env, errors } = parseEnv()
if (errors.length > 0) {
  for (const message of errors) console.error(`конфигурация: ${message}`)
  process.exit(1)
}

const log = (entry) => console.log(typeof entry === 'string' ? entry : JSON.stringify(entry))
const registry = loadRegistry(JSON.parse(readFileSync(join(here, 'config', 'agents.json'), 'utf8')))
const archive = createArchiveTool({ env, log })
const runs = createRuns({ ttlMs: env.RUN_TTL_MINUTES * 60_000 })
// Диалоги переживают перезапуск: они на томе, а не в памяти процесса.
const sessions = createSessions({
  file: env.SESSIONS_FILE,
  ttlMs: env.SESSION_TTL_HOURS * 3600_000,
  log,
})
const sweptOnStart = sessions.sweep()

/** Реестр агентов → исполнители. Сегодня один; следующий добавляется по образцу. */
const agents = new Map()
for (const entry of registry.values()) {
  agents.set(entry.id, createNewsAnalyst({ agent: entry, archive, runs, sessions, env, log }))
}

// Готовые запуски удаляются по TTL; незавершённые живут до терминального события.
setInterval(() => runs.sweep(), 60_000).unref()
// Срок хранения диалогов проверяется реже: он измеряется часами.
setInterval(() => {
  const removed = sessions.sweep()
  if (removed > 0) log({ event: 'sessions_swept', removed })
}, 10 * 60_000).unref()

const handler = createService({ agents, archive, runs, sessions, env, log })
http.createServer(handler).listen(env.PORT, () => {
  log({
    event: 'start',
    port: env.PORT,
    agents: [...agents.values()].map((a) => `${a.id}@${a.version}`),
    store: env.STORE_FILE,
    archive: archive.size(),
    skipped: archive.skippedOnLoad(),
    sessions: { ...sessions.stats(), ttlHours: env.SESSION_TTL_HOURS, sweptOnStart },
  })
})
