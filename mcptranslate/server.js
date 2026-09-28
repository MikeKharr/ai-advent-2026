// Точка входа единицы `mcptranslate`. Секретов у неё нет: MyMemory работает
// без ключа, публичного адреса у сервера нет.
//
// Порт 8086 — следующий свободный за `mcpstore` (8085) в `deploy/compose.yml`.

import http from 'node:http'
import { createRpc } from './src/rpc.js'
import { createService } from './src/service.js'
import { buildTools } from './src/tools.js'

const PORT = Number(process.env.PORT) || 8086

const log = (entry) => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }))

const tools = buildTools()
const handler = createService({
  handleOne: createRpc({ serverInfo: { name: 'ai-advent-2026-translate', version: '1.0.0' }, tools }),
  tools: tools.map((t) => t.name),
  log,
})

http.createServer(handler).listen(PORT, () => {
  log({ event: 'start', port: PORT, tools: tools.map((t) => t.name) })
})
