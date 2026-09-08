// Сборка ответа дня 3: ленты → фильтр по неделе → не больше N статей
// с источника (параметр пользователя) → свободный ответ модели с параметрами
// генерации. Ответы не кэшируются: смысл дня — видеть эффект параметров.

import { askModel } from './anthropic.js'
import { collectItems } from './feeds.js'

const FEED_TTL_MS = 30 * 60_000

/** Записи за неделю: общие для всех запросов, поэтому кэшируются. */
export async function loadCandidates(cache, deps = {}) {
  const cached = cache.get('feeds')
  if (cached) return { ...cached, cached: true }

  return cache.once('feeds', async () => {
    const again = cache.get('feeds')
    if (again) return { ...again, cached: true }

    const collected = await collectItems(deps)
    // Полный отказ не кэшируется на полчаса: короткая сетевая яма иначе
    // превращается в тридцать минут пустого сайта.
    cache.set('feeds', collected, collected.okCount === 0 ? 60_000 : FEED_TTL_MS)
    return { ...collected, cached: false }
  })
}

/**
 * Не больше `limit` записей с каждого источника. Записи приходят
 * отсортированными по дате, поэтому у каждого источника остаются самые
 * свежие, а порядок между источниками сохраняется.
 */
export function capPerSource(items, limit) {
  const counts = new Map()
  const out = []
  for (const item of items) {
    const n = counts.get(item.source) ?? 0
    if (n >= limit) continue
    counts.set(item.source, n + 1)
    out.push(item)
  }
  return out
}

function describeFailures(failed, okCount) {
  if (failed.length === 0) return ''
  const names = failed.map((f) => `${f.source} (${f.reason})`).join(', ')
  return `Недоступны ленты: ${names}. Использованы оставшиеся ${okCount}.`
}

/**
 * Полный путь запроса. `onProgress` получает шаги для SSE.
 * Возвращает запись для ленты: ответ, параметры, токены, причина останова.
 */
export async function buildAnswer(
  sphere,
  params,
  { cache, limiter, env, ip, onProgress = () => {}, deps = {} },
) {
  // Слот резервируется до всякой работы: отказанный запрос не должен даже
  // запускать загрузку лент (I-4). Резерв атомарный — параллельный залп
  // не проходит мимо суточного предела (I-5).
  const allowed = limiter.reserve(ip)
  if (!allowed.ok) {
    const error = new Error(allowed.message)
    error.code = allowed.reason
    throw error
  }

  onProgress({ step: 'feeds', text: 'Читаю ленты изданий' })
  const { items, failed, okCount, cached: feedsCached } = await loadCandidates(cache, deps)

  onProgress({
    step: 'filtered',
    text: `Свежих материалов за неделю: ${items.length}${feedsCached ? ' (из кэша)' : ''}`,
  })

  const failureNote = describeFailures(failed, okCount)
  const at = new Date().toISOString()

  if (items.length === 0) {
    // Вызова API не будет — зарезервированный слот возвращается.
    limiter.release(ip)
    return {
      sphere,
      params,
      at,
      answer: '',
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: null,
      stopSequence: null,
      note: [
        'Ни одна лента не дала свежих материалов за неделю. Модель не вызывалась.',
        failureNote,
      ]
        .filter(Boolean)
        .join(' '),
      sources: okCount,
      candidates: 0,
    }
  }

  const candidates = capPerSource(items, params.perSource)
  onProgress({
    step: 'model',
    text: `Спрашиваю модель: ${candidates.length} материалов, максимум ${params.maxTokens} токенов ответа`,
  })

  const result = await askModel(sphere, params, candidates, env, deps)

  return {
    sphere,
    params,
    at,
    answer: result.answer,
    usage: result.usage,
    stopReason: result.stopReason,
    stopSequence: result.stopSequence,
    note: failureNote,
    sources: okCount,
    candidates: candidates.length,
  }
}
