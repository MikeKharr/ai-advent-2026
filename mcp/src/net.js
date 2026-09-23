// Единственная дверь наружу (ADR 2026-09-23-1227, п. 5). Адрес строит
// инструмент из зашитого хоста — сюда он приходит уже собранным, и всё, что
// здесь остаётся, это ограничения на сам поход.
//
// `redirect: 'error'` — не перестраховка: на пробе архитектора один из
// кандидатов (`api.frankfurter.app`) ответил 301. Переезд домена не должен
// молча увести наш запрос на хост, которого нет в коде.
//
// Ответ поставщика — недоверенные данные: здесь он только читается с
// потолком, разбор и выбор полей — в инструменте.

/**
 * Wikimedia требует описательный User-Agent с контактом: клиент, версия,
 * контакт в скобках (адрес сайта, почта или учётная запись вики), библиотека.
 * Без него запросы блокируются без предупреждения
 * (foundation.wikimedia.org, Policy:User-Agent policy, проверено 2026-09-23).
 * Контакт — публичный адрес проекта; личной почты здесь быть не должно.
 */
export const USER_AGENT = 'ai-advent-2026-mcp/1.0 (https://challenge.zpq.ai) Node.js/22'

/** Дольше этого поставщика не ждём: вызов инструмента не должен висеть. */
export const TIMEOUT_MS = 10_000
/** Потолок тела ответа поставщика. */
export const MAX_BYTES = 256 * 1024

class ProviderError extends Error {}

/** Тело читается по кускам со счётчиком: потолок обязан резать до разбора. */
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

/**
 * GET по готовому адресу с зашитым хостом. Возвращает разобранный JSON.
 * Любая неудача — своё сообщение; текст поставщика наружу не уходит.
 */
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
