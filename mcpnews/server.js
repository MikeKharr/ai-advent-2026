// Точка входа единицы `mcpnews` (ADR 2026-09-28-0736, п. 3). Секретов у неё
// нет: Hacker News Algolia ключа не требует, публичного адреса у сервера нет.

import http from 'node:http'
import { createRpc } from './src/rpc.js'
import { createService } from './src/service.js'
import { buildTools } from './src/tools.js'

const PORT = Number(process.env.PORT) || 8084

const log = (entry) => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }))

const tools = buildTools()
const handler = createService({
  handleOne: createRpc({ serverInfo: { name: 'ai-advent-2026-news', version: '1.0.0' }, tools }),
  tools: tools.map((t) => t.name),
  log,
})

http.createServer(handler).listen(PORT, () => {
  log({ event: 'start', port: PORT, tools: tools.map((t) => t.name) })
})
