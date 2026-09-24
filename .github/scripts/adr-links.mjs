// «Ссылки на ADR из AGENTS.md ведут на действующие»: описание проекта —
// следствие принятого решения, а не второй его источник.
// ADR 2026-09-24-1230, A7. Из какого отказа: «Vultr» прожил в описании
// семнадцать суток и просочился в два принятых ADR, потому что описание не
// ссылалось ни на что и разойтись с решением ему было нечем.
//
// Каждая ссылка вида `ГГГГ-ММ-ДД-ЧЧММ` в AGENTS.md обязана указывать на файл
// agent_docs/adr/<id>-*.md, чей раздел «Статус» не содержит «Заменено» или
// «Устарел». «Заменяет …» — состояние действующего ADR и провалом не
// считается.
//
// ЧЕСТНАЯ ГРАНИЦА ШАГА: он держит ссылку живой, но не заставляет факт
// сослаться — это правило прозой в AGENTS.md, «Назначение AGENTS.md и
// границы». Vultr шаг поймал бы только при наличии ссылки.
//
// Запуск из корня репозитория: node .github/scripts/adr-links.mjs
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const DOC = 'AGENTS.md'
export const ADR_DIR = 'agent_docs/adr'

const REF = /`(\d{4}-\d{2}-\d{2}-\d{4})`/g
// Строка статуса НАЧИНАЕТСЯ со снятия — так его и пишут («Заменено на `…`»,
// «**Заменено в части п. 9**»). Совпадение где угодно внутри абзаца ловило бы
// действующие ADR, которые лишь рассказывают, что строку «Заменено на …»
// получает другой файл (2026-09-11-0513). «Заменяет …» — обратное отношение
// и не снятие.
const RETIRED = /^\s*[*_]{0,2}(?:Заменено|Устарел)/u

/** Ссылки на ADR с номерами строк. */
export function refs(text) {
  const out = []
  for (const [i, line] of text.split('\n').entries()) {
    for (const m of line.matchAll(REF)) out.push({ id: m[1], line: i + 1 })
  }
  return out
}

/** Текст раздела «Статус» — от заголовка до следующего `## `. */
export function status(text) {
  const from = text.indexOf('## Статус')
  if (from === -1) return null
  const rest = text.slice(from + '## Статус'.length)
  const to = rest.indexOf('\n## ')
  return (to === -1 ? rest : rest.slice(0, to)).trim()
}

// Замену объявляет либо сам снятый ADR («Заменено на …»), либо его преемник
// («Заменяет …»). На 2026-09-24 первую форму несут 3 ADR из 62, вторую — 12,
// то есть проверка по одному лишь собственному статусу видела бы почти ничего
// (находка `compliance` к PR #227, п. 4). Отсюда обратный индекс: преемник
// называет предшественника, и этого достаточно, чтобы считать того снятым.
// Слово ищется ГДЕ УГОДНО в статусе, не только с начала строки: живой случай
// — «Принято. **Заменяет `2026-09-18-1839`: …**» (находка `reviewer` к PR #227).
// Перед словом требуется начало, пробел или разметка, а кавычка «…» исключена:
// в 2026-09-23-0726 слово обсуждается прозой («Почему „Дополняет“, а не
// „Заменяет“») и снятием не является.
const SUPERSEDES = /(?:^|[\s*_>])Заменяет[^`«\n]*`?(?:agent_docs\/adr\/)?(\d{4}-\d{2}-\d{2}-\d{4})/gu
/** Имя файла ADR: README и прочее в индекс замен не идут. */
const ADR_FILE = /^\d{4}-\d{2}-\d{2}-\d{4}-.+\.md$/u

/** Множество id, снятых чужим статусом «Заменяет …». */
export function supersededIds(dir, list = readdirSync, read = (f) => readFileSync(f, 'utf8')) {
  const out = new Map()
  for (const f of list(dir)) {
    if (!ADR_FILE.test(f)) continue
    const s = status(read(join(dir, f)))
    if (s === null) continue
    const ls = s.split('\n')
    for (let i = 0; i < ls.length; i += 1) {
      SUPERSEDES.lastIndex = 0
      const m = SUPERSEDES.exec(ls[i])
      if (!m) continue
      // Замена бывает ЧАСТИЧНОЙ: «Заменяет `…` в части X» — предшественник
      // остаётся в силе во всём остальном, и краснить ссылку на него нельзя.
      // Оборот переносится на следующую строку, поэтому смотрим предложение,
      // а не строку (проверено на 2026-09-11-1230 и -1743).
      // Резать по первой точке нельзя: в строке стоит имя файла с точками
      // (`…-0426-framework-v2-model-routing.md`), и оборот «в части» остаётся
      // за срезом — так первая редакция этой проверки покрасила живые ссылки.
      // Берём абзац: от совпадения до пустой строки.
      const para = []
      for (let j = i; j < ls.length && ls[j].trim() !== ''; j += 1) para.push(ls[j])
      // Без `\b`: граница слова в JS определена для латиницы, между пробелом
      // и кириллическим «в» её нет, и условие не срабатывало никогда.
      if (/(^|\s)в\s+част/u.test(para.join(' '))) continue
      out.set(m[1], f)
    }
  }
  return out
}

/** Находка или null: ссылки нет в каталоге ADR либо её ADR снят с действия. */
export function check(id, dir, list = readdirSync, read = (f) => readFileSync(f, 'utf8'), superseded) {
  const file = list(dir).find((f) => f.startsWith(`${id}-`) && f.endsWith('.md'))
  if (!file) return `ADR ${id} не найден в ${ADR_DIR}/`
  const s = status(read(join(dir, file)))
  if (s === null) return `${ADR_DIR}/${file}: нет раздела «## Статус» — действие ADR не определено`
  const line = s.split('\n').find((l) => RETIRED.test(l))
  if (line) return `${ADR_DIR}/${file} снят с действия («${line.trim()}») — ${DOC} ссылается на него`
  const by = (superseded ?? supersededIds(dir, list, read)).get(id)
  if (by) return `${ADR_DIR}/${file} заменён документом ${by} (его статус: «Заменяет …») — ${DOC} ссылается на снятый`
  return null
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = process.cwd()
  const dir = join(root, ADR_DIR)
  let bad = 0
  const seen = refs(readFileSync(join(root, DOC), 'utf8'))
  const superseded = supersededIds(dir)
  for (const { id, line } of seen) {
    const problem = check(id, dir, readdirSync, (f) => readFileSync(f, 'utf8'), superseded)
    if (!problem) continue
    bad += 1
    console.log(`::error file=${DOC},line=${line}::${problem}`)
  }
  if (bad > 0) process.exit(1)
  console.log(`ok: ${seen.length} ссылок на ADR из ${DOC}, все ведут на действующие`)
}
