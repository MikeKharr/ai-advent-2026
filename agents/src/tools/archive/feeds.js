// Загрузка лент. Список фиксирован (ADR 2026-09-07-2016): что не попало
// в него, для приложения не существует. Проверен 2026-09-07.

import { dedupe, parseFeed } from './rss.js'

export const FEEDS = [
  { source: 'TechCrunch', region: 'США', url: 'https://techcrunch.com/feed/' },
  { source: 'Crunchbase News', region: 'США', url: 'https://news.crunchbase.com/feed/' },
  { source: 'Sifted', region: 'Европа', url: 'https://sifted.eu/feed' },
  { source: 'Tech.eu', region: 'Европа', url: 'https://tech.eu/feed/' },
  { source: 'EU-Startups', region: 'Европа', url: 'https://www.eu-startups.com/feed/' },
  { source: 'Entrackr', region: 'Индия', url: 'https://entrackr.com/rss' },
  { source: 'Inc42', region: 'Индия', url: 'https://inc42.com/feed/' },
  { source: 'Pandaily', region: 'Китай', url: 'https://pandaily.com/feed' },
]

// technode.com отдаёт весь архив (11.5 МБ), поэтому лимит обязателен,
// а не «на всякий случай». Ленты, превысившие его, обрываются.
const MAX_BYTES = 2 * 1024 * 1024
const TIMEOUT_MS = 10_000
const USER_AGENT = 'ai-advent-2026/1.0 (+https://challenge.zpq.ai/day6/)'

/** Читает тело ответа не дальше лимита: ленты бывают на мегабайты. */
async function readCapped(response, maxBytes) {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    // Размер проверяется до накопления: иначе лимит на деле «maxBytes плюс чанк».
    if (size + value.length > maxBytes) break
    size += value.length
    chunks.push(value)
  }
  await reader.cancel().catch(() => {})
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks))
}

/**
 * Тянет одну ленту. Отказ не бросает исключение: работаем на оставшихся
 * лентах, а число неудачных уходит в ответ пользователю (ADR 2026-09-07-2016).
 */
export async function fetchFeed(feed, { fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(feed.url, {
      headers: {
        'user-agent': USER_AGENT,
        accept: 'application/rss+xml, application/xml, text/xml, */*',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok)
      return { ok: false, source: feed.source, reason: `http ${response.status}`, items: [] }

    const xml = await readCapped(response, MAX_BYTES)
    const items = parseFeed(xml, feed.source).map((item) => ({ ...item, region: feed.region }))
    if (items.length === 0)
      return { ok: false, source: feed.source, reason: 'записей не разобрано', items: [] }
    return { ok: true, source: feed.source, items }
  } catch (error) {
    // Наружу уходит понятная причина, а не имя класса ошибки: устройство
    // сбоя пользователю ничего не даёт, а в лог оно попадает целиком.
    console.error(`лента ${feed.source}: ${error.name}: ${error.message}`)
    const reason = error.name === 'TimeoutError' ? 'таймаут' : 'недоступна'
    return { ok: false, source: feed.source, reason, items: [] }
  }
}

/**
 * Собирает все ленты параллельно, оставляет записи свежее `days` суток,
 * дедуплицирует и сортирует по дате. Возвращает и список отказавших лент.
 *
 * В дне 5 окно широкое (90 суток вместо недели): накопленное хранилище
 * живёт дольше одного запроса, и отсекать неделей на входе больше незачем.
 * Совсем без отсечки нельзя — лента, отдающая архив, забила бы окно разом.
 */
export async function collectItems({
  days = 90,
  now = Date.now(),
  fetchImpl = fetch,
  feeds = FEEDS,
} = {}) {
  const results = await Promise.all(feeds.map((feed) => fetchFeed(feed, { fetchImpl })))
  const cutoff = now - days * 24 * 60 * 60 * 1000

  const fresh = results
    .flatMap((result) => result.items)
    .filter((item) => {
      const t = Date.parse(item.date)
      return Number.isFinite(t) && t >= cutoff && t <= now + 24 * 60 * 60 * 1000
    })
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))

  return {
    items: dedupe(fresh),
    failed: results.filter((r) => !r.ok).map((r) => ({ source: r.source, reason: r.reason })),
    okCount: results.filter((r) => r.ok).length,
  }
}
