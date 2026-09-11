// Тексты документов для полнотекстового поиска витрины — `texts.json`
// (ADR 2026-09-11-0745, раздел 3). Нового чтения нет: тексты берутся из уже
// прочитанных входов `sources.js`, поэтому граница публикуемого прежняя.

import { parseFrontmatter } from './markdown.js'

/** Чем заменяется образец секрета. */
export const HIDDEN = '[скрыто]'

// Образцы с обязательным хвостом: заголовок PEM-ключа и токены GitHub. Этот
// же текст ищет по репозиторию шаг секретов `docs-guard.yml` — совпадение
// проверяет `atlas/test/secrets.test.js`. Упоминание префикса без хвоста с
// ними не совпадает.
export const KEY_SAMPLES = ['BEGIN [A-Z ]*PRIVATE KEY', 'gh[pousr]_[A-Za-z0-9]{20,}', 'github_pat_[A-Za-z0-9_]{20,}']

// Один список на санитайз и страж витрины `atlas/test/secrets.test.js`: по
// образцу, а не по списку файлов — образцы называет каждый документ о страже.
// У префиксов ключей Anthropic и Groq скрывается и хвост ключа, а голый
// префикс тоже совпадает. Префиксы собраны из кусков, как в тесте: иначе этот
// файл сам выглядел бы утечкой. Новые образцы — после `BEGIN OPENSSH`: там,
// где совпадают оба, остаётся прежняя замена.
export const SAMPLES = [
  `${['sk', 'ant', ''].join('-')}[A-Za-z0-9_-]*`,
  `gs${'k'}_[A-Za-z0-9_]*`,
  'BEGIN OPENSSH',
  '\\b100\\.\\d+\\.\\d+\\.\\d+\\b',
  ...KEY_SAMPLES,
]
const SAMPLES_RE = new RegExp(SAMPLES.join('|'), 'g')

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
  const out = text.replace(SAMPLES_RE, () => {
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
