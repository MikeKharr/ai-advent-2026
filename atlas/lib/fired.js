// «Следы в записях»: имя роли рядом с признаком гейта в записях истории.
// Правило — раздел «Правило → где сработало» проекта решения
// agent_docs/design/2026-09-13-2000-project-atlas.md (уточнён после ревью
// этапов 1 и 2). Здесь оно и живёт целиком, чтобы читалось как правило, а не
// собиралось по кускам.
//
// След — отношение, а не вывод: правило видит имя роли рядом с признаком, но
// не знает, вынесено вето или снято. Поэтому и выдержка даётся целой фразой —
// по обрывку читатель додумает то, чего в записи нет.

/** Буква слова — с кириллицей: `\b` в JS её не знает и режет «ответов» на «вето». */
const W = 'A-Za-zА-Яа-яЁё0-9_'
const word = (body) => new RegExp(`(?<![${W}])(?:${body})(?![${W}])`, 'i')

/** Признак срабатывания гейта. */
const MARKS = [word('вето'), word('блокирующ[а-яё]*'), word('находк[а-яё]*'), word('правки'), word('переделать')]

/**
 * Отрицание в том же фрагменте: «вето нет», «блокирующих нет», «без вето»,
 * «нет находок», «не ставил / не наложил / не дал».
 */
const NEGATIONS = [
  word('нет'),
  // «без» — только рядом с самим признаком: «снял вето без условий» — след,
  // «пройдено без вето» — нет.
  word('без\\s+(?:вето|находок|блокирующих|правок|переделки)'),
  word('не\\s+(?:ставил|наложил|дал)'),
]

/**
 * Имя роли: без учёта регистра, но не внутри пути (`design/corpus.md`) и не
 * куском составного имени (`design` из `design-review`).
 */
const roleRe = (role) => new RegExp(`(?<![${W}/-])${role}(?![${W}/-])`, 'i')

const isTableRow = (line) => line.trimStart().startsWith('|')

/** Маркер пункта или цитаты в начале строки — но не `**` выделения. */
const LEADING_MARKER = /^\s*(?:[-*+]\s+|>\s*)+/

/** Начало нового блока: пункт списка, цитата, заголовок, строка таблицы. */
const startsBlock = (line) => /^\s*(?:[-*+]\s|\d+\.\s|>|#{1,6}\s|\|)/.test(line)

/**
 * Абзацы записи: подряд идущие непустые строки, из которых только первая
 * может нести маркер списка. Документы проекта переносятся по ~80 символам,
 * поэтому фраза почти всегда лежит на двух-трёх строках — собрать её обратно
 * можно только на уровне абзаца.
 * @returns {Array<Array<{n:number, text:string}>>}
 */
function paragraphs(lines) {
  const blocks = []
  let current = []
  const flush = () => {
    if (current.length > 0) blocks.push(current)
    current = []
  }
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i]
    if (text.trim() === '') {
      flush()
      continue
    }
    if (current.length > 0 && (startsBlock(text) || isTableRow(text))) flush()
    current.push({ n: i + 1, text })
  }
  flush()
  return blocks
}

/** Конец предложения: точка, восклицательный или вопросительный знак. */
const SENTENCE_END = /[.!?…]["»)]?(?=\s|$)/g

/**
 * Абзац, склеенный в одну строку, с картой смещений: где начинается каждая
 * строка и какой строке принадлежит смещение.
 */
function joinParagraph(block) {
  const marks = []
  let joined = ''
  for (const line of block) {
    if (joined !== '') joined += ' '
    marks.push({ at: joined.length, n: line.n })
    joined += line.text.trim()
  }
  return {
    joined,
    startOf: (n) => marks.find((m) => m.n === n).at,
  }
}

/** Границы предложений внутри склеенного абзаца. */
function sentences(joined) {
  const bounds = []
  let start = 0
  for (const m of joined.matchAll(SENTENCE_END)) {
    const end = m.index + m[0].length
    bounds.push({ start, end })
    start = end + 1
  }
  if (start < joined.length) bounds.push({ start, end: joined.length })
  return bounds
}

/**
 * Единицы привязки внутри строки со смещениями: строка делится по `;` и по
 * концу предложения, роль и признак обязаны попасть в одну единицу — иначе
 * «Compliance — вето нет; reviewer —» приписывал бы reviewer чужое вето.
 */
function unitsOf(text) {
  const units = []
  let at = 0
  for (const piece of text.split(/;|(?<=[.!?])\s+/)) {
    const start = text.indexOf(piece, at)
    units.push({ text: piece, at: start === -1 ? at : start })
    at = (start === -1 ? at : start) + piece.length
  }
  return units
}

const markOf = (text) => MARKS.map((re) => re.exec(text)).filter(Boolean).sort((a, b) => a.index - b.index)[0]
const hasMark = (text) => markOf(text) !== undefined && !NEGATIONS.some((re) => re.test(text))

/**
 * Смещения совпавшего фрагмента внутри выдержки: полуинтервалы `[start, end)`
 * в единицах кода UTF-16 по строке `excerpt` **до** любой обработки разметки
 * (контракт `marks` раскладки 2026-09-13-2100). Считаются здесь, а не в
 * браузере: второй экземпляр правила однажды разойдётся с первым.
 *
 * @returns {{unit:[number,number], role:[number,number], sign:[number,number]}|null}
 */
function marksIn(excerpt, unitText, role) {
  // Строка таблицы — одна единица целиком; у прозы единица ищется в выдержке
  // уже без ведущего маркера, потому что его сняли и из выдержки.
  const cleaned = unitText.replace(LEADING_MARKER, '').trim()
  const at = isTableRow(excerpt) ? 0 : excerpt.indexOf(cleaned)
  const start = at === -1 ? 0 : at
  const end = at === -1 ? excerpt.length : start + cleaned.length

  const unit = excerpt.slice(start, end)
  const roleMatch = roleRe(role).exec(unit)
  const signMatch = markOf(unit)
  if (!roleMatch || !signMatch) return null

  return {
    unit: [start, end],
    role: [start + roleMatch.index, start + roleMatch.index + roleMatch[0].length],
    sign: [start + signMatch.index, start + signMatch.index + signMatch[0].length],
  }
}

/**
 * Следы в тексте записи истории.
 * @param {string} text
 * @param {Set<string>} roleNames имена ролей из .claude/agents/
 * @returns {Array<{role:string, line:number, excerpt:string, marks:object|null}>}
 */
export function firedTraces(text, roleNames) {
  const traces = []
  const seen = new Set()
  const lines = text.split('\n')

  const hit = (role, line, raw, unitText) => {
    const key = `${role}:${line}`
    if (seen.has(key)) return
    seen.add(key)
    // Предела длины у выдержки следа нет: `clip` резал четыре из четырнадцати
    // посреди фразы — ровно тот дефект, который правило запрещает.
    // Снимается маркер пункта или цитаты, но не `**`: ведущие звёздочки —
    // открывающее выделение, и без пары разметка ломается.
    const excerpt = raw.replace(LEADING_MARKER, '').trim()
    traces.push({ role, line, excerpt, marks: marksIn(excerpt, unitText, role) })
  }

  for (const block of paragraphs(lines)) {
    // Строка таблицы — единица целиком: роль в одной ячейке, признак в
    // другой — это один след, и выдержка даётся строкой как есть.
    if (isTableRow(block[0].text)) {
      for (const line of block) {
        if (!hasMark(line.text)) continue
        for (const role of roleNames) if (roleRe(role).test(line.text)) hit(role, line.n, line.text, line.text)
      }
      continue
    }

    const { joined, startOf } = joinParagraph(block)
    const bounds = sentences(joined)
    for (const line of block) {
      for (const unit of unitsOf(line.text.trim())) {
        if (!hasMark(unit.text)) continue
        for (const role of roleNames) {
          if (!roleRe(role).test(unit.text)) continue
          // Единица привязки — строка, как и была: расширение до предложения
          // касается только выдержки, иначе правило начало бы находить следы
          // там, где их не находило, и число следов поехало бы.
          const at = startOf(line.n) + unit.at
          const bound = bounds.find((b) => at >= b.start && at < b.end) ?? { start: at, end: joined.length }
          // Номер — строка, где начинается совпавшая фраза; выдержка — всё
          // предложение вокруг неё.
          hit(role, line.n, joined.slice(bound.start, bound.end), unit.text)
        }
      }
    }
  }

  return traces.sort((a, b) => a.line - b.line)
}
