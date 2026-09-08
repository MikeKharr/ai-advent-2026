// Разбор RSS и Atom без зависимостей (ADR 2026-09-07-1525).
// Нужны четыре поля на запись: заголовок, ссылка, дата, краткое описание.
// Полноценный XML-парсер для этого избыточен, но CDATA, сущности и два
// формата лент обойти нельзя — они встречаются в наших восьми лентах.

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#8217': '’',
  '#8216': '‘',
  '#8220': '“',
  '#8221': '”',
  '#8211': '–',
  '#8212': '—',
}

/** Разворачивает HTML-сущности, включая числовые. */
export function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name) => {
    if (Object.hasOwn(ENTITIES, name)) return ENTITIES[name]
    // Код вне диапазона Unicode роняет fromCodePoint, а исключение отсюда
    // отбрасывает ленту целиком — вместе с годными записями.
    const toChar = (code) =>
      Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    if (name.startsWith('#x') || name.startsWith('#X'))
      return toChar(Number.parseInt(name.slice(2), 16))
    if (name.startsWith('#')) return toChar(Number.parseInt(name.slice(1), 10))
    return whole
  })
}

/** Снимает разметку и приводит пробелы: описания в лентах приходят с HTML. */
export function stripHtml(text) {
  // Сущности разворачиваются ДО срезания тегов, иначе «&lt;/candidates&gt;»
  // в заголовке станет литеральным разделителем уже после очистки и пробьёт
  // границу данных в промпте. Угловые скобки убираются и после разворота.
  return decodeEntities(text)
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function unwrapCdata(text) {
  const cdata = text.match(/<!\[CDATA\[([\s\S]*?)\]\]>/)
  return cdata ? cdata[1] : text
}

/** Содержимое первого тега `name` внутри блока, с учётом CDATA. */
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'))
  return m ? unwrapCdata(m[1]).trim() : ''
}

/** Atom кладёт ссылку в атрибут href, RSS — в тело тега. */
function atomLink(block) {
  const alternate = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)
  if (alternate) return alternate[1]
  const any = block.match(/<link[^>]*href=["']([^"']+)["']/i)
  return any ? any[1] : ''
}

/**
 * Разбирает ленту в записи. Возвращает только те, у которых есть
 * заголовок, ссылка и разобранная дата: запись без даты нельзя отфильтровать
 * по неделе, а без ссылки она бесполезна (I-7).
 */
export function parseFeed(xml, source) {
  const items = []
  const blocks = xml.match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) ?? []

  for (const block of blocks) {
    const title = stripHtml(tag(block, 'title'))
    const link = (tag(block, 'link') || atomLink(block)).trim()
    const rawDate =
      tag(block, 'pubDate') ||
      tag(block, 'published') ||
      tag(block, 'updated') ||
      tag(block, 'dc:date')
    const summary = stripHtml(
      tag(block, 'description') || tag(block, 'summary') || tag(block, 'content'),
    )

    const date = new Date(rawDate)
    if (!title || !link || !rawDate || Number.isNaN(date.getTime())) continue

    // Схема проверяется здесь, а не в UI: относительный путь не годится как
    // ссылка на источник (I-7), а javascript: в href — дыра, если лента
    // окажется скомпрометированной.
    let href
    try {
      href = new URL(decodeEntities(link))
    } catch {
      continue
    }
    if (href.protocol !== 'http:' && href.protocol !== 'https:') continue

    items.push({
      title,
      url: href.toString(),
      date: date.toISOString(),
      summary: summary.slice(0, 400),
      source,
    })
  }

  return items
}

/**
 * Ключ дедупликации: один инфоповод перепечатывают несколько изданий,
 * а один и тот же материал приходит с разными utm-метками.
 */
export function dedupeKey(item) {
  let host = ''
  let path = ''
  try {
    const u = new URL(item.url)
    host = u.hostname.replace(/^www\./, '')
    path = u.pathname.replace(/\/+$/, '')
  } catch {
    host = item.url
  }
  const title = item.title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
  return { url: `${host}${path}`, title }
}

/** Оставляет по одной записи на URL и на заголовок, сохраняя порядок. */
export function dedupe(items) {
  const seenUrls = new Set()
  const seenTitles = new Set()
  const out = []
  for (const item of items) {
    const key = dedupeKey(item)
    if (seenUrls.has(key.url) || (key.title && seenTitles.has(key.title))) continue
    seenUrls.add(key.url)
    if (key.title) seenTitles.add(key.title)
    out.push(item)
  }
  return out
}
