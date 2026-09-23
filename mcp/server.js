// Точка входа службы MCP (ADR 2026-09-23-1227). Отсутствующий секрет валит
// процесс здесь — до открытия порта.

import http from 'node:http'
import { parseEnv } from './src/env.js'
import { createLimiter } from './src/limits.js'
import { createSession } from './src/mcp.js'
import { createService } from './src/service.js'
import { TOOLS } from './src/tools.js'

const { env, errors } = parseEnv()
if (errors.length > 0) {
  for (const message of errors) console.error(`конфигурация: ${message}`)
  process.exit(1)
}

const log = (entry) => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }))

const limiter = createLimiter(env)
const handler = createService({
  env,
  limiter,
  createSession,
  tools: TOOLS.map((t) => t.name),
  log,
})

http.createServer(handler).listen(env.PORT, () => {
  log({ event: 'start', port: env.PORT, tools: TOOLS.map((t) => t.name) })
})
