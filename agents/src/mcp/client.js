// Клиент MCP хоста агентов: голый JSON-RPC через `fetch`, БЕЗ SDK
// (ADR 2026-09-28-0736, п. 1). Граница runtime-зависимостей держит SDK в
// единице `mcp/` (ADR 2026-09-23-1227), поэтому здесь протокол написан
// руками — теми же заголовками, какими ходит день 16
// (`days/day16/server.js:95-101`), ревизия 2025-11-25.
//
// Что умеет: `initialize`, `tools/list`, `tools/call` с разбором `isError`.
// Чего не умеет намеренно: сессий (`Mcp-Session-Id`), потока SSE, ресурсов
// и промптов — ничего из этого хосту не нужно, а день 16 обходится без них.
//
// Каждый вызов отдаёт запись трейса `{server, method, request, response, ms}`
// с сырыми телами JSON-RPC: они и есть предмет показа (ADR, п. 5).

export const PROTOCOL_VERSION = '2025-11-25'

/** Потолок на тело в записи трейса — тот же, что `BODY_LIMIT` консоли дня 16. */
export const TRACE_BODY_LIMIT = 64 * 1024

/**
 * Потолок на тело ответа сервера. Читается потоком и обрывается на превышении:
 * `await response.text()` на бесконечном ответе съел бы память процесса
 * `agents`, в котором живут и диалоги, и планировщик. Вчетверо больше потолка
 * трейса — чтобы обрезка в трейсе и отказ по размеру не совпадали и были
 * различимы.
 */
export const RESPONSE_LIMIT = 256 * 1024

const DEFAULT_TIMEOUT_MS = 20_000

/** Ошибка вызова MCP: страница и трейс различают причины по `reason`. */
export class McpError extends Error {
  constructor(message, { reason, server, method, status = null }) {
    super(message)
    this.name = 'McpError'
    this.reason = reason
    this.server = server
    this.method = method
    this.status = status
  }
}

/** Тело для трейса: строка как есть, но не длиннее потолка. */
function clip(text) {
  if (typeof text !== 'string') return { body: '', clipped: false }
  if (Buffer.byteLength(text) <= TRACE_BODY_LIMIT) return { body: text, clipped: false }
  return { body: Buffer.from(text).subarray(0, TRACE_BODY_LIMIT).toString('utf8'), clipped: true }
}

/** Читает тело потоком и обрывается, как только оно перевалило за потолок. */
async function readCapped(response, { server, method }) {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > RESPONSE_LIMIT) {
      await reader.cancel()
      throw new McpError(`Сервер MCP «${server}» прислал ответ больше ${RESPONSE_LIMIT} байт.`, {
        reason: 'too_large',
        server,
        method,
        status: response.status,
      })
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Клиент одного сервера. `name` — имя из реестра: оно едет в каждую запись
 * трейса, потому что на экране видно имя сервера каждого вызова (требование
 * владельца, ADR п. 5).
 */
export function createMcpClient({
  name,
  url,
  key = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  now = Date.now,
}) {
  if (typeof name !== 'string' || name.trim() === '') throw new Error('клиент MCP: имя сервера обязательно')
  if (typeof url !== 'string' || url.trim() === '') throw new Error(`клиент MCP (${name}): адрес обязателен`)

  let nextId = 0

  function headers() {
    const out = {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': PROTOCOL_VERSION,
    }
    // Ключ подставляется здесь и только здесь. В трейс он не попадает:
    // трейс несёт тела, а не заголовки.
    if (key) out.authorization = `Bearer ${key}`
    return out
  }

  /**
   * Один вызов JSON-RPC. Возвращает `{result, trace}`; любая беда —
   * `McpError` с записью трейса в `error.trace`, чтобы неудачный вызов был
   * виден на экране так же, как удачный.
   */
  async function call(method, params) {
    nextId += 1
    const request = { jsonrpc: '2.0', id: nextId, method, ...(params === undefined ? {} : { params }) }
    const requestText = JSON.stringify(request)
    const started = now()

    const trace = (responseText, status) => ({
      server: name,
      method,
      request: clip(requestText).body,
      response: clip(responseText).body,
      status,
      ms: Math.max(0, now() - started),
      clipped: clip(requestText).clipped || clip(responseText).clipped,
    })

    let response
    let text
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: headers(),
        body: requestText,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      })
      text = await readCapped(response, { server: name, method })
    } catch (error) {
      if (error instanceof McpError) {
        error.trace = trace('', response?.status ?? null)
        throw error
      }
      // Имя ошибки, а не её текст: текст `fetch` несёт адрес сервера.
      const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError'
      const failure = new McpError(
        timedOut
          ? `Сервер MCP «${name}» не ответил за ${timeoutMs} мс.`
          : `Сервер MCP «${name}» недоступен.`,
        { reason: timedOut ? 'timeout' : 'network', server: name, method },
      )
      failure.trace = trace('', null)
      throw failure
    }

    const record = trace(text, response.status)

    if (!response.ok) {
      const failure = new McpError(`Сервер MCP «${name}» ответил ${response.status}.`, {
        reason: 'http',
        server: name,
        method,
        status: response.status,
      })
      failure.trace = record
      throw failure
    }

    let envelope
    try {
      envelope = JSON.parse(text)
    } catch {
      const failure = new McpError(`Сервер MCP «${name}» прислал не JSON.`, {
        reason: 'malformed',
        server: name,
        method,
        status: response.status,
      })
      failure.trace = record
      throw failure
    }

    if (!envelope || typeof envelope !== 'object' || envelope.jsonrpc !== '2.0') {
      const failure = new McpError(`Сервер MCP «${name}»: ответ не конверт JSON-RPC 2.0.`, {
        reason: 'malformed',
        server: name,
        method,
        status: response.status,
      })
      failure.trace = record
      throw failure
    }

    if (envelope.error) {
      const failure = new McpError(
        `Сервер MCP «${name}», ${method}: ${envelope.error.message ?? 'ошибка'} (${envelope.error.code ?? '?'}).`,
        { reason: 'rpc_error', server: name, method, status: response.status },
      )
      failure.trace = record
      throw failure
    }

    return { result: envelope.result, trace: record }
  }

  return {
    name,
    url,

    /** Рукопожатие. Объявленное сервером имя возвращается отдельно: оно может не совпасть с реестровым, и расхождение — предмет показа. */
    async initialize() {
      const { result, trace } = await call('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'advent-agents', version: '1.0.0' },
      })
      return { declaredName: result?.serverInfo?.name ?? null, result, trace }
    },

    /** Список инструментов. Имя сервера кладётся рядом с каждым инструментом. */
    async listTools() {
      const { result, trace } = await call('tools/list')
      const raw = Array.isArray(result?.tools) ? result.tools : []
      return {
        tools: raw.map((tool) => ({ ...tool, server: name })),
        trace,
      }
    },

    /**
     * Вызов инструмента. `isError: true` — отказ инструмента, а не протокола:
     * возвращается признаком, а не исключением, потому что цикл агента обязан
     * отдать этот текст модели, а не упасть.
     */
    async callTool(toolName, args = {}) {
      const { result, trace } = await call('tools/call', { name: toolName, arguments: args })
      const content = Array.isArray(result?.content) ? result.content : []
      const text = content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
      return { isError: result?.isError === true, text, content, structured: result?.structuredContent ?? null, trace }
    },

    /** Голый вызов — для методов, которых здесь нет (`ping` и прочее). */
    call,
  }
}
