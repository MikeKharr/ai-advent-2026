// Точка входа единицы `mcpstore` (ADR 2026-09-28-0736, п. 3). Секретов нет:
// наружу единица не ходит и публичного адреса не имеет. Файл базы — на
// именованном томе `mcpstore_data`, выкатка его не трогает (ADR, п. 10).

import http from 'node:http'
import { createRpc } from './src/rpc.js'
import { createService, STORE_MAX_BODY } from './src/service.js'
import { createStore } from './src/store.js'
import { buildTools } from './src/tools.js'

const PORT = Number(process.env.PORT) || 8085
const DB_PATH = process.env.STORE_DB_PATH || '/data/store.db'

const log = (entry) => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }))

const store = createStore({ path: DB_PATH })
const tools = buildTools({ store })

// Уборка по сроку идёт перед каждой операцией; таймер нужен на случай, когда
// операций нет вовсе — иначе просроченные файлы лежали бы до первого запроса.
// `.unref()` — образец `agents/server.js`: таймер не держит процесс.
setInterval(() => {
  const removed = store.purge()
  if (removed > 0) log({ event: 'purge', removed })
}, 10 * 60 * 1000).unref()

const handler = createService({
  handleOne: createRpc({ serverInfo: { name: 'ai-advent-2026-store', version: '1.0.0' }, tools }),
  tools: tools.map((t) => t.name),
  health: () => store.stats(),
  maxBody: STORE_MAX_BODY,
  log,
})

http.createServer(handler).listen(PORT, () => {
  log({ event: 'start', port: PORT, db: DB_PATH, tools: tools.map((t) => t.name) })
})
