// Единственная дверь наружу. Копия правил дня 16 (`mcp/src/net.js`, ADR
// 2026-09-23-1227, п. 5): адрес строит инструмент из ЗАШИТОГО хоста, сюда он
// приходит уже собранным, а здесь остаются только ограничения на поход.
//
// `redirect: 'error'` — не перестраховка: переезд домена не должен молча
// увести наш запрос на хост, которого нет в коде.

export const USER_AGENT = 'ai-advent-2026-mcpnews/1.0 (https://challenge.zpq.ai) Node.js/22'

/** Дольше этого поставщика не ждём: вызов инструмента не должен висеть. */
export const TIMEOUT_MS = 10_000
/** Потолок тела ответа поставщика. */
export const MAX_BYTES = 256 * 1024

class ProviderError extends Error {}

/** Тело читается по кускам со счётчиком: потолок обязан резать ДО разбора. */
async function readCapped(response, maxBytes) {
  const body = response.body
  if (!body) {
    const text = await response.text()
    if (Buffer.byteLength(text) > maxBytes) throw new ProviderError('ответ поставщика больше потолка')
    return text
  }
  const reader = body.getReader()
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new ProviderError('ответ поставщика больше потолка')
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** GET по готовому адресу с зашитым хостом. Возвращает разобранный JSON. */
export async function getJson(url, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES } = {}) {
  const control = new AbortController()
  const timer = setTimeout(() => control.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      signal: control.signal,
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    })
    if (!response.ok) throw new ProviderError(`поставщик ответил ${response.status}`)
    return JSON.parse(await readCapped(response, maxBytes))
  } finally {
    clearTimeout(timer)
  }
}
