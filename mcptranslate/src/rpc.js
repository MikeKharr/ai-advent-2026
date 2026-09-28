// Рукописный JSON-RPC 2.0 и подмножество MCP ревизии 2025-11-25.
// Своя копия в каждой единице: SDK и `zod` разрешены только единице `mcp/`
// (ADR 2026-09-23-1227, п. 2), и границу держит шаг «Граница
// runtime-зависимостей» в `ci.yml`. Дублирование здесь — цена этой границы.
//
// Файл — дословная копия `mcpnews/src/rpc.js`, кроме этой шапки. Расходиться
// им нельзя: обе единицы отвечают одному и тому же клиенту
// (`agents/src/mcp/pipeline.js`), и разная форма ответа сломала бы разбор.

export const PROTOCOL_VERSION = '2025-11-25'

/** Коды JSON-RPC. -32002 занят отказом лимитера в дне 16 — здесь не нужен. */
export const CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
}

export function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}

/** Публичное описание инструмента: то, что видит `tools/list`. */
function listed(tool) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }
}

/**
 * Отказ ИНСТРУМЕНТА, а не протокола: спецификация требует `isError` в
 * результате, чтобы вызывающая модель увидела текст и могла поправиться.
 * Отказом протокола (`error`) отвечают только на негодный запрос.
 */
function toolFailure(message) {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: message }) }] }
}

/**
 * Обработчик одного объекта JSON-RPC. Возвращает объект ответа либо `null` —
 * для уведомления (запроса без `id`), на которое ответа не бывает.
 */
export function createRpc({ serverInfo, tools }) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]))

  return async function handleOne(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return rpcError(null, CODES.INVALID_REQUEST, 'invalid request')
    }
    const { id, method, params } = message
    const isNotification = id === undefined || id === null
    if (typeof method !== 'string') {
      return isNotification ? null : rpcError(id, CODES.INVALID_REQUEST, 'invalid request')
    }

    // Уведомление: ответа нет ни при каком методе, включая неизвестный.
    if (method === 'notifications/initialized') return null

    switch (method) {
      case 'initialize':
        return rpcResult(id, {
          // Ревизию не согласовываем: у службы она одна (ADR, п. 11).
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo,
        })
      case 'ping':
        return rpcResult(id, {})
      case 'tools/list':
        // Порядок фиксирован определением: иначе тест на список ничего не значит.
        return rpcResult(id, { tools: tools.map(listed) })
      case 'tools/call': {
        const name = params?.name
        const tool = typeof name === 'string' ? byName.get(name) : undefined
        // Нет такого инструмента — ошибка ЗАПРОСА: имя пришло от клиента, а
        // не от инструмента, и правит его клиент, а не модель.
        if (!tool) return rpcError(id, CODES.INVALID_PARAMS, `unknown tool: ${String(name).slice(0, 64)}`)

        const parsed = tool.parse(params?.arguments ?? {})
        // Негодный аргумент — отказ ИНСТРУМЕНТА: так модель видит причину
        // текстом и зовёт снова, а не получает разрыв протокола.
        if (!parsed.ok) return rpcResult(id, toolFailure(parsed.error))

        try {
          const result = await tool.run(parsed.value)
          return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result) }] })
        } catch (error) {
          return rpcResult(id, toolFailure(String(error?.message ?? 'сбой инструмента')))
        }
      }
      default:
        return isNotification ? null : rpcError(id, CODES.METHOD_NOT_FOUND, `unknown method: ${method.slice(0, 64)}`)
    }
  }
}
