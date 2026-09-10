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

/**
 * Выдержка: снимается маркер пункта или цитаты, но не `**` — ведущие
 * звёздочки это открывающее выделение, и без пары разметка ломается.
 * Предела длины у выдержки следа нет: `clip` резал четыре из четырнадцати
 * посреди фразы — ровно тот дефект, который правило запрещает.
 * `tail` = false оставляет хвост нетронутым — так считается сдвиг начала.
 */
const strip = (text, tail = true) => {
  const cut = text.replace(LEADING_MARKER, '').replace(/^\s+/, '')
  return tail ? cut.trimEnd() : cut
}

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
 * браузере: второй экземпляр правила однажды разошёлся бы с первым.
 *
 * Границы единицы приходят готовыми — искать её текстом в выдержке нельзя:
 * повторяющийся текст дал бы первое вхождение, а ненайденный — молча
 * растянул бы подсветку на всю выдержку.
 *
 * @param {string} excerpt выдержка следа
 * @param {[number,number]} unit границы совпавшей единицы внутри выдержки
 * @param {string} role имя роли
 * @returns {{unit:[number,number], role:[number,number], sign:[number,number]}|null}
 */
function marksIn(excerpt, unit, role) {
  const [start, end] = unit
  if (start < 0 || end > excerpt.length || start >= end) return null

  const inside = excerpt.slice(start, end)
  const roleMatch = roleRe(role).exec(inside)
  const signMatch = markOf(inside)
  // Роль и признак обязаны найтись внутри единицы: они там и совпали. Если
  // нет — смещения разошлись с текстом, и лучше отдать `null`, чем неверную
  // подсветку: тест на все следы делает из этого находку.
  if (!roleMatch || !signMatch) return null

  return {
    unit: [start, end],
    role: [start + roleMatch.index, start + roleMatch.index + roleMatch[0].length],
    sign: [start + signMatch.index, start + signMatch.index + signMatch[0].length],
  }
}

export function firedTraces(text, roleNames) {
  const traces = []
  const seen = new Set()
  const lines = text.split('\n')

  const hit = (role, line, excerpt, unit) => {
    const key = `${role}:${line}`
    if (seen.has(key)) return
    seen.add(key)
    traces.push({ role, line, excerpt, marks: marksIn(excerpt, unit, role) })
  }

  for (const block of paragraphs(lines)) {
    // Строка таблицы — единица целиком: роль в одной ячейке, признак в
    // другой — это один след, и выдержка даётся строкой как есть.
    if (isTableRow(block[0].text)) {
      for (const line of block) {
        if (!hasMark(line.text)) continue
        const excerpt = strip(line.text)
        for (const role of roleNames) if (roleRe(role).test(line.text)) hit(role, line.n, excerpt, [0, excerpt.length])
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

          // Номер — строка, где начинается совпавшая единица, а не всё
          // предложение вокруг неё: предложение может начинаться строкой
          // выше, и след `design` встал бы на строку с «вето нет», то есть
          // читался бы как след отрицания.
          const raw = joined.slice(bound.start, bound.end)
          const excerpt = strip(raw)
          // Сдвиг выдержки относительно абзаца: снятый маркер пункта и
          // пробелы. Смещения единицы считаются от него, без поиска текстом.
          const shift = bound.start + (raw.length - strip(raw, false).length)
          // Из единицы снимается тот же маркер пункта, что и из выдержки:
          // иначе её начало уехало бы левее начала выдержки.
          const unitText = strip(unit.text)
          const drop = unit.text.length - strip(unit.text, false).length
          const unitStart = at + drop - shift
          hit(role, line.n, excerpt, [unitStart, unitStart + unitText.length])
        }
      }
    }
  }

  return traces.sort((a, b) => a.line - b.line)
}
