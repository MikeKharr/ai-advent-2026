// Тексты документов для полнотекстового поиска витрины — `texts.json`
// (ADR 2026-09-11-0745, раздел 3). Нового чтения нет: тексты берутся из уже
// прочитанных входов `sources.js`, поэтому граница публикуемого прежняя.

import { parseFrontmatter } from './markdown.js'

/** Чем заменяется образец секрета. */
export const HIDDEN = '[скрыто]'

// Образцы стража витрины `atlas/test/secrets.test.js` — те же четыре, по
// образцу, а не по списку файлов: образцы называет каждый документ о страже.
// У префиксов ключей скрывается и хвост ключа, а не только префикс. Префиксы
// собраны из кусков, как в тесте: иначе этот файл сам выглядел бы утечкой.
const SAMPLES = new RegExp(
  [`${['sk', 'ant', ''].join('-')}[A-Za-z0-9_-]*`, `gs${'k'}_[A-Za-z0-9_]*`, 'BEGIN OPENSSH', '\\b100\\.\\d+\\.\\d+\\.\\d+\\b'].join('|'),
  'g',
)

/** Типы узлов, чей файл — текст проекта. Вендорные скиллы — чужой текст. */
const TEXT_TYPES = new Set(['adr', 'history', 'design', 'guide', 'role', 'skill'])

/**
 * Markdown → строка для поиска: фронтматтер, решётки заголовков, `**`,
 * обратные кавычки, разделители таблиц и синтаксис ссылок сняты, пробельные
 * символы схлопнуты. Адрес ссылки уходит вместе с синтаксисом, текст остаётся.
 */
export function plainText(markdown) {
  return parseFrontmatter(markdown)
    .body.replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, ' ')
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/\*\*|`/g, '')
    .replace(/\\?\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Образцы секретов → «[скрыто]»; `hidden` — сколько мест заменено. */
export function redact(text) {
  let hidden = 0
  const out = text.replace(SAMPLES, () => {
    hidden += 1
    return HIDDEN
  })
  return { text: out, hidden }
}

/**
 * Объект «узел → текст» в порядке узлов графа и число скрытых мест по узлам.
 * Скрытие — последним шагом: снятая разметка могла склеить образец.
 */
export function buildTexts(graph, sources) {
  const byPath = new Map()
  for (const group of ['adr', 'history', 'design', 'guides', 'roles', 'skills']) {
    for (const entry of sources[group] ?? []) byPath.set(entry.path, entry.text)
  }

  const texts = {}
  const hidden = {}
  for (const node of graph.nodes) {
    if (!TEXT_TYPES.has(node.type) || node.vendored || !byPath.has(node.file)) continue
    const { text, hidden: count } = redact(plainText(byPath.get(node.file)))
    texts[node.id] = text
    if (count > 0) hidden[node.id] = count
  }
  return { texts, hidden }
}
