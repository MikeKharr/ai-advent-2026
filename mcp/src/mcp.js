// Сервер MCP и транспорт на один запрос.
//
// Почему не один общий на процесс: в режиме без сессий SDK это прямо
// запрещает — `node_modules/@modelcontextprotocol/sdk/dist/esm/server/
// webStandardStreamableHttp.js:174-176`, ветка `!this.sessionIdGenerator &&
// this._hasHandledRequest` бросает «Stateless transport cannot be reused
// across requests». Второй запрос к переиспользованному транспорту отвечает
// 500 с пустым телом. Проверено прогоном: тест «tools/list детерминирован»
// шлёт два запроса подряд и на общем транспорте краснеет на втором.
//
// Цена — регистрация трёх инструментов на запрос; состояния, которое стоило
// бы хранить между запросами, у службы нет.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { registerTools } from './tools.js'

export const SERVER_INFO = { name: 'ai-advent-2026', version: '1.0.0' }

export async function createSession(deps = {}) {
  const server = new McpServer(SERVER_INFO)
  registerTools(server, deps)
  // Без сессий и одним JSON: состояния на сервере нет, поток нам не нужен.
  // DNS-rebinding-защиту SDK (`allowedHosts`) не включаем — за двумя прокси
  // `Host` то `challenge.zpq.ai`, то `mcp:8083`, а ключ закрывает то же
  // самое (ADR 2026-09-23-1227, п. 4).
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  await server.connect(transport)
  return { server, transport }
}
