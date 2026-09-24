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

/** Находка или null: ссылки нет в каталоге ADR либо её ADR снят с действия. */
export function check(id, dir, list = readdirSync, read = (f) => readFileSync(f, 'utf8')) {
  const file = list(dir).find((f) => f.startsWith(`${id}-`) && f.endsWith('.md'))
  if (!file) return `ADR ${id} не найден в ${ADR_DIR}/`
  const s = status(read(join(dir, file)))
  if (s === null) return `${ADR_DIR}/${file}: нет раздела «## Статус» — действие ADR не определено`
  const line = s.split('\n').find((l) => RETIRED.test(l))
  if (line) return `${ADR_DIR}/${file} снят с действия («${line.trim()}») — ${DOC} ссылается на него`
  return null
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = process.cwd()
  const dir = join(root, ADR_DIR)
  let bad = 0
  const seen = refs(readFileSync(join(root, DOC), 'utf8'))
  for (const { id, line } of seen) {
    const problem = check(id, dir)
    if (!problem) continue
    bad += 1
    console.log(`::error file=${DOC},line=${line}::${problem}`)
  }
  if (bad > 0) process.exit(1)
  console.log(`ok: ${seen.length} ссылок на ADR из ${DOC}, все ведут на действующие`)
}
