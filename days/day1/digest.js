// Сборка дайджеста: ленты → фильтр по неделе → выбор моделью → карточки.
// Карточка собирается из данных ленты, а из ответа модели берётся только
// порядок и пояснение (ADR 2026-09-07-2016).

import { selectNews } from './anthropic.js'
import { sphereKey } from './cache.js'
import { collectItems } from './feeds.js'

const FEED_TTL_MS = 30 * 60_000
const DIGEST_TTL_MS = 6 * 60 * 60_000
const CANDIDATE_LIMIT = 120

/** Записи за неделю: общие для всех сфер, поэтому кэшируются отдельно. */
export async function loadCandidates(cache, deps = {}) {
  const cached = cache.get('feeds')
  if (cached) return { ...cached, cached: true }

  const collected = await collectItems(deps)
  cache.set('feeds', collected, FEED_TTL_MS)
  return { ...collected, cached: false }
}

/**
 * Отбор кандидатов по кругу источников. Простая обрезка «первых N по дате»
 * отдаёт весь список изданиям, которые публикуют чаще: в первом прогоне
 * все три карточки оказались индийскими. Круг сохраняет свежесть внутри
 * источника и при этом даёт каждому региону попасть в выборку.
 */
export function pickCandidates(items, limit) {
  const bySource = new Map()
  for (const item of items) {
    if (!bySource.has(item.source)) bySource.set(item.source, [])
    bySource.get(item.source).push(item)
  }

  const queues = [...bySource.values()]
  const out = []
  let index = 0
  while (out.length < limit && queues.some((q) => q.length > 0)) {
    const queue = queues[index % queues.length]
    if (queue.length > 0) out.push(queue.shift())
    index += 1
  }
  return out
}

function describeFailures(failed, okCount) {
  if (failed.length === 0) return ''
  const names = failed.map((f) => `${f.source} (${f.reason})`).join(', ')
  return `Недоступны ленты: ${names}. Показано по оставшимся ${okCount}.`
}

/**
 * Полный путь запроса. `onProgress` получает шаги для SSE.
 * Возвращает готовый к отдаче объект: карточки, note, метаданные.
 */
export async function buildDigest(
  sphere,
  { cache, limiter, env, ip, onProgress = () => {}, deps = {} },
) {
  const key = sphereKey(sphere)
  const hit = cache.get(key)
  if (hit) {
    onProgress({ step: 'cache', text: 'Нашёл готовый ответ за сегодня' })
    return { ...hit, cached: true }
  }

  onProgress({ step: 'feeds', text: 'Читаю ленты изданий' })
  const { items, failed, okCount, cached: feedsCached } = await loadCandidates(cache, deps)

  onProgress({
    step: 'filtered',
    text: `Свежих материалов за неделю: ${items.length}${feedsCached ? ' (из кэша)' : ''}`,
  })

  const failureNote = describeFailures(failed, okCount)

  if (items.length === 0) {
    return {
      sphere,
      news: [],
      note: ['Ни одна лента не дала свежих материалов за неделю.', failureNote]
        .filter(Boolean)
        .join(' '),
      sources: okCount,
      cached: false,
    }
  }

  // Лимит проверяется до вызова API, а не после (I-4).
  const allowed = limiter.check(ip)
  if (!allowed.ok) {
    const error = new Error(allowed.message)
    error.code = allowed.reason
    throw error
  }

  const candidates = pickCandidates(items, CANDIDATE_LIMIT)
  onProgress({ step: 'model', text: `Выбираю релевантное из ${candidates.length} материалов` })

  limiter.commit(ip)
  const selection = await selectNews(sphere, candidates, env, deps)

  const news = selection.picks.map((pick) => {
    const item = candidates[pick.n - 1]
    return {
      title: item.title,
      url: item.url,
      source: item.source,
      region: item.region,
      date: item.date.slice(0, 10),
      why: pick.why,
    }
  })

  const notes = []
  if (news.length === 0) notes.push('За неделю в этих изданиях не нашлось новостей по вашей сфере.')
  else if (news.length < 3) notes.push('Релевантных материалов за неделю нашлось меньше трёх.')
  if (selection.note) notes.push(selection.note)
  if (failureNote) notes.push(failureNote)

  const result = {
    sphere,
    news,
    note: notes.join(' '),
    sources: okCount,
    candidates: candidates.length,
    usage: selection.usage,
    cached: false,
  }

  cache.set(key, result, DIGEST_TTL_MS)
  return result
}
