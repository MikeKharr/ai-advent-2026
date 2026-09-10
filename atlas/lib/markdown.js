// Разбор markdown проекта: фронтматтер ролей, заголовок, разделы и цитаты.
// Соглашения цитирования проекта (обратные кавычки) уже машинно-читаемы —
// источник под атлас не переписывается (ADR 2026-09-13-2000).

/** Фронтматтер ролей: плоские `ключ: значение` и списки `- значение`. */
export function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) return { data: {}, body: text }

  const data = {}
  let listKey = null
  for (const line of m[1].split('\n')) {
    const item = line.match(/^ *- (.+)$/)
    if (item && listKey) {
      data[listKey].push(item[1].trim())
      continue
    }
    const pair = line.match(/^([a-z][a-z_-]*):\s*(.*)$/)
    if (!pair) continue
    if (pair[2] === '') {
      listKey = pair[1]
      data[listKey] = []
    } else {
      listKey = null
      data[pair[1]] = pair[2].trim()
    }
  }
  return { data, body: text.slice(m[0].length) }
}

/** Заголовок документа — первый H1. */
export function heading(text) {
  const m = text.match(/^# (.+)$/m)
  return m ? m[1].trim() : ''
}

/** Тело раздела `## Имя` до следующего заголовка того же уровня. */
export function section(text, name) {
  const re = new RegExp(`^## ${name}\\s*$`, 'm')
  const m = text.match(re)
  if (!m) return ''
  const rest = text.slice(m.index + m[0].length)
  const next = rest.search(/^## /m)
  return (next === -1 ? rest : rest.slice(0, next)).trim()
}

/** Первый абзац раздела — выдержка для панели узла. */
export function firstParagraph(text) {
  const para = text.split(/\n\s*\n/).find((p) => p.trim() !== '')
  return para ? para.trim().replace(/\s*\n\s*/g, ' ') : ''
}

/** Обрезка выдержки по границе слова. */
export function clip(s, limit = 160) {
  if (s.length <= limit) return s
  const cut = s.slice(0, limit)
  const space = cut.lastIndexOf(' ')
  return `${(space > limit / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

// Заглушки шаблонов и таблиц — не цитаты: `agent_docs/adr/YYYY-MM-DD-HHMM-title.md`,
// `development-history/id`, `guides/name.md`.
const PLACEHOLDER = /YYYY|HHMM|<|\*|\bимя\b|name\.md|\/id$/

// Соглашения цитирования проекта — одним выражением: по нему и ищут цитаты
// (`scanCitations`), и заменяют их на wikilinks в копии для vault
// (`mapCitations`). Одно выражение, а не два похожих: разойдясь, они дали бы
// граф и vault, которые расходятся между собой.
const CITE = new RegExp(
  [
    // Две «защитные» ветки идут первыми: то, что они съели, не разбирается
    // дальше. Блок кода — образец, его переписывать нельзя; готовая
    // `[[ссылка]]` уже разрешена, и второй проход по ней дал бы
    // `[[invariants/[[invariants/I-4]]]]`.
    '(?<fence>^```[\\s\\S]*?^```)',
    // Двойные обратные кавычки в проекте значат ровно одно: показать цитату
    // буквально. Разобрав их, атлас переписал бы объяснение самого себя —
    // «источник → копия» превратилось бы в «X → X».
    '(?<dbl>``(?:[^`]|`(?!`))*``)',
    '(?<link>\\[\\[[^\\]\\n]*\\]\\])',
    'ADR\\s+`(?<adr>[^`\\n]+)`',
    '`(?<path>(?:agent_docs/)?(?:adr|development-history|design|guides)/[A-Za-z0-9._-]+)`',
    // Закрытый список корневых документов, в обеих формах записи. Префикс
    // сохраняется как написан: `agent_docs/AGENTS.md` — не тот же файл, что
    // `AGENTS.md`, и такая ссылка обязана стать находкой, а не пройти.
    '`(?<root>(?:agent_docs/)?(?:architecture|index|glossary|AGENTS)\\.md)`',
    '\\bI-(?<inv>\\d+)\\b',
    '`(?<word>[a-z][a-z-]*)`',
  ].join('|'),
  'gm',
)

/** Идентификатор атомарного документа: `YYYY-MM-DD-HHMM` в начале имени. */
export function atomicId(value) {
  const m = value.match(/(\d{4}-\d{2}-\d{2}-\d{4})/)
  return m ? m[1] : null
}

/** Что за цитата попалась: вид и значение, либо null для заглушки шаблона. */
function classify(groups) {
  if (groups.fence !== undefined || groups.dbl !== undefined || groups.link !== undefined) return null
  if (groups.adr !== undefined) {
    if (PLACEHOLDER.test(groups.adr)) return null
    const id = atomicId(groups.adr)
    return id ? { kind: 'adr', value: id } : null
  }
  if (groups.path !== undefined) {
    if (PLACEHOLDER.test(groups.path)) return null
    return { kind: 'path', value: groups.path.replace(/^agent_docs\/(?=(?:adr|development-history|design|guides)\/)/, '') }
  }
  if (groups.root !== undefined) return { kind: 'path', value: groups.root }
  if (groups.inv !== undefined) return { kind: 'invariant', value: `I-${Number(groups.inv)}` }
  return { kind: 'word', value: groups.word }
}

/** Номер строки по смещению в тексте — быстрым поиском по началам строк. */
function lineIndexer(text) {
  const starts = [0]
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
  return (index) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= index) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
}

/**
 * Цитаты документа с номерами строк — номер нужен, чтобы находка `--check`
 * правилась без раскопок. Поиск идёт по всему тексту, а не построчно:
 * документы проекта переносятся по ~80 символам, и цитата вида
 * «… ADR ⏎ `2026-09-07-1525` …» построчному поиску не видна.
 * @returns {Array<{kind:'adr'|'path'|'invariant'|'word', value:string, line:number}>}
 */
export function scanCitations(text) {
  const at = lineIndexer(text)
  const found = []
  for (const m of text.matchAll(CITE)) {
    const cite = classify(m.groups)
    if (cite) found.push({ ...cite, line: at(m.index) })
  }
  return found
}

/**
 * Замена цитат в тексте одним проходом. `fn(kind, value)` возвращает строку
 * замены или null, чтобы оставить как есть. Один проход обязателен: после
 * замены `I-4` на `[[invariants/I-4]]` второй проход нашёл бы `I-4` внутри
 * уже готовой ссылки.
 */
export function mapCitations(text, fn) {
  return text.replace(CITE, (whole, ...args) => {
    const groups = args.at(-1)
    const cite = classify(groups)
    if (!cite) return whole
    return fn(cite.kind, cite.value) ?? whole
  })
}

/**
 * Строки статуса «Заменяет `…`» и «Заменено на `…`» — только в разделе
 * «Статус», иначе в выборку попадают таблицы и прочая проза.
 * @returns {{replaces: string[], replacedBy: string[]}}
 */
export function replacementRefs(text) {
  const status = section(text, 'Статус')
  const replaces = []
  const replacedBy = []
  for (const line of status.split('\n')) {
    const refs = [...line.matchAll(/`([^`\n]+)`/g)]
      .map((m) => atomicId(m[1]))
      .filter((id) => id !== null)
    if (refs.length === 0) continue
    if (/Заменено\s+на/.test(line)) replacedBy.push(...refs)
    else if (/Заменяет/.test(line)) replaces.push(...refs)
  }
  return { replaces, replacedBy }
}
