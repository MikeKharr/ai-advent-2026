// Тексты документов для полнотекстового поиска витрины — `texts.json`
// (ADR 2026-09-11-0745, раздел 3). Нового чтения нет: тексты берутся из уже
// прочитанных входов `sources.js`, поэтому граница публикуемого прежняя.

import { parseFrontmatter } from './markdown.js'

/** Чем заменяется образец секрета. */
export const HIDDEN = '[скрыто]'

// Образцы с обязательным хвостом ключа: ключи Anthropic и Groq, заголовок
// PEM-ключа, токены GitHub. Они не маскируются, а роняют сборку и `--check` находкой:
// законного упоминания с хвостом не бывает, а маскировка спрятала бы
// инцидент. Этот же текст ищет по репозиторию шаг секретов `docs-guard.yml` —
// совпадение проверяет `atlas/test/secrets.test.js`. Перед префиксом GitHub —
// не буква и не цифра: так ловится токен в адресе (`:ghs_…@`), но не хвост
// чужого слова. Упоминание префикса без хвоста не совпадает.
export const KEY_SAMPLES = [
  `${['sk', 'ant', ''].join('-')}[A-Za-z0-9_-]{10,}`,
  'BEGIN [A-Z0-9 ]*PRIVATE KEY',
  `gs${'k'}_[A-Za-z0-9]{20,}`,
  '(^|[^A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}',
  '(^|[^A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}',
]

// Маскируемые образцы: их законно называют документы о страже, поэтому
// в texts.json они заменяются, а не роняют сборку. По образцу, а не по списку
// файлов. У префиксов ключей Anthropic и Groq скрываются голый префикс и
// короткий хвост; хвост длины ключа — находка по KEY_SAMPLES, она раньше.
// Префиксы собраны из кусков, как в тесте:
// иначе этот файл сам выглядел бы утечкой.
const MASKED = [
  `${['sk', 'ant', ''].join('-')}[A-Za-z0-9_-]*`,
  `gs${'k'}_[A-Za-z0-9_]*`,
  'BEGIN OPENSSH',
  '\\b100\\.\\d+\\.\\d+\\.\\d+\\b',
]
const MASKED_RE = new RegExp(MASKED.join('|'), 'g')
const KEY_RES = KEY_SAMPLES.map((sample) => [sample, new RegExp(sample)])

/** Все образцы — список стража витрины `atlas/test/secrets.test.js`. */
export const SAMPLES = [...MASKED, ...KEY_SAMPLES]

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

/**
 * Образцы с хвостом ключа в документе — находки сборки. Ищутся и в тексте
 * файла, и после снятия разметки: снятые кавычки могли склеить токен. В
 * сообщении — образец и строка, но не найденное: ключ не уходит в лог CI.
 */
export function findKeys(path, raw) {
  const plain = plainText(raw)
  const found = []
  for (const [sample, re] of KEY_RES) {
    const hit = re.exec(raw)
    if (hit === null && !re.test(plain)) continue
    found.push({
      file: path,
      line: hit === null ? 1 : raw.slice(0, hit.index + hit[0].length).split('\n').length,
      message: `в тексте документа образец ключа \`${sample}\`. Маскировки нет: убрать ключ из документа и отозвать его`,
    })
  }
  return found
}

/** Маскируемые образцы секретов → «[скрыто]»; `hidden` — сколько мест заменено. */
export function redact(text) {
  let hidden = 0
  const out = text.replace(MASKED_RE, () => {
    hidden += 1
    return HIDDEN
  })
  return { text: out, hidden }
}

/**
 * Объект «узел → текст» в порядке узлов графа, число скрытых мест по узлам и
 * находки образцов с хвостом ключа. Скрытие — последним шагом: снятая
 * разметка могла склеить образец. Ключи ищутся во всех прочитанных
 * документах, включая вендорные скиллы: их выдержки идут в graph.json.
 */
export function buildTexts(graph, sources) {
  const byPath = new Map()
  for (const group of ['adr', 'history', 'design', 'guides', 'roles', 'skills']) {
    for (const entry of sources[group] ?? []) byPath.set(entry.path, entry.text)
  }
  const findings = [...byPath].flatMap(([path, text]) => findKeys(path, text))

  const texts = {}
  const hidden = {}
  for (const node of graph.nodes) {
    if (!TEXT_TYPES.has(node.type) || node.vendored || !byPath.has(node.file)) continue
    const { text, hidden: count } = redact(plainText(byPath.get(node.file)))
    texts[node.id] = text
    if (count > 0) hidden[node.id] = count
  }
  return { texts, hidden, findings }
}
