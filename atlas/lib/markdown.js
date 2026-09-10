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

const ADR_CITE = /ADR\s+`([^`\n]+)`/g
const DOC_PATH = /`((?:agent_docs\/)?(?:adr|development-history|design|guides)\/[A-Za-z0-9._-]+)`/g
const INVARIANT = /\bI-(\d+)\b/g
const BACKTICK_WORD = /`([a-z][a-z-]*)`/g

/** Идентификатор атомарного документа: `YYYY-MM-DD-HHMM` в начале имени. */
export function atomicId(value) {
  const m = value.match(/(\d{4}-\d{2}-\d{2}-\d{4})/)
  return m ? m[1] : null
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

  for (const m of text.matchAll(ADR_CITE)) {
    if (PLACEHOLDER.test(m[1])) continue
    const id = atomicId(m[1])
    if (id) found.push({ kind: 'adr', value: id, line: at(m.index), index: m.index })
  }
  for (const m of text.matchAll(DOC_PATH)) {
    if (PLACEHOLDER.test(m[1])) continue
    found.push({ kind: 'path', value: m[1].replace(/^agent_docs\//, ''), line: at(m.index), index: m.index })
  }
  for (const m of text.matchAll(INVARIANT)) {
    found.push({ kind: 'invariant', value: `I-${Number(m[1])}`, line: at(m.index), index: m.index })
  }
  for (const m of text.matchAll(BACKTICK_WORD)) {
    found.push({ kind: 'word', value: m[1], line: at(m.index), index: m.index })
  }

  found.sort((a, b) => a.index - b.index)
  return found.map(({ index, ...rest }) => rest)
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
