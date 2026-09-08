// Сборка ответа дня 3: ленты → фильтр по неделе → не больше N статей
// с источника → бюджет на объём текста → ответ модели на запрос пользователя.
// В модель уходит полный текст статьи, а не заголовок, поэтому объём
// приходится ограничивать явно (ADR дня 3). Ответы не кэшируются.

import { askModel } from './anthropic.js'
import { collectItems } from './feeds.js'

const FEED_TTL_MS = 30 * 60_000

/**
 * Потолок на суммарный объём текстов в одном запросе. ~120K символов это
 * ~30K токенов: вчетверо меньше окна Haiku 4.5 и примерно $0.03 за вызов.
 * Без потолка пятнадцать статей с восьми источников дали бы ~220K токенов —
 * больше окна модели и вдесятеро дороже.
 */
const MAX_TEXT_CHARS = 120_000

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

/**
 * Раздаёт бюджет текста по списку, который уже отсортирован по дате: пока
 * бюджет есть, статья идёт целиком, дальше — заголовком.
 *
 * Отброшенный по бюджету текст помечается `textOmitted`, а не просто
 * стирается: иначе статья, которую урезали мы, выглядит как статья, которой
 * издание не дало текста, — и это неправда и для модели, и для пользователя.
 */
export function withinTextBudget(items, maxChars = MAX_TEXT_CHARS) {
  let left = maxChars
  return items.map((item) => {
    if (!item.text) return { ...item, text: '', textOmitted: false }
    if (item.text.length > left) return { ...item, text: '', textOmitted: true }
    left -= item.text.length
    return { ...item, textOmitted: false }
  })
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
/**
 * Честно говорит, по скольким материалам модель видела статью целиком,
 * и раздельно — где текста не дало издание, а где его срезал наш бюджет.
 */
function describeTextCoverage(total, withText, omitted) {
  if (total === 0 || withText === total) return ''
  const parts = [`Полный текст статьи модель видела у ${withText} из ${total} материалов.`]
  const noText = total - withText - omitted
  if (noText > 0) parts.push(`У ${noText} издание отдаёт в ленту только заголовок и анонс.`)
  if (omitted > 0)
    parts.push(
      `Ещё у ${omitted} текст есть, но не поместился в бюджет запроса — уменьшите число статей с источника, чтобы освободить место.`,
    )
  return parts.join(' ')
}

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
      withText: 0,
      textOmitted: 0,
    }
  }

  const candidates = withinTextBudget(capPerSource(items, params.perSource))
  const withText = candidates.filter((c) => c.text).length
  const textOmitted = candidates.filter((c) => c.textOmitted).length
  onProgress({
    step: 'model',
    text: `Спрашиваю модель: ${candidates.length} материалов, из них с полным текстом ${withText}`,
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
    note: [failureNote, describeTextCoverage(candidates.length, withText, textOmitted)]
      .filter(Boolean)
      .join(' '),
    sources: okCount,
    candidates: candidates.length,
    withText,
    textOmitted,
  }
}
