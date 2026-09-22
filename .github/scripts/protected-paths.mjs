// Защищённые пути, затронутые диффом PR, должны быть названы в его описании.
// Норма — agent_docs/guides/agent-roles.md, «Мерж по консенсусу», п. 6; список
// путей читается оттуда же, между маркерами `protected-paths`, чтобы документ
// и гейт не расходились.
//
// Запуск из корня репозитория, пути дают на stdin через NUL:
//   git diff -z --name-only "$BASE" HEAD | node .github/scripts/protected-paths.mjs
// Описание PR — в PR_BODY. Пустое описание при затронутом пути — провал.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const ROLES = 'agent_docs/guides/agent-roles.md'

const BEGIN = '<!-- protected-paths:begin -->'
const END = '<!-- protected-paths:end -->'
const ITEM = /^\s*-\s+`([^`]+)`\s*$/

/**
 * Список защищённых путей из текста agent-roles.md. Закрыто падает: нет
 * маркеров, порядок перепутан, пустой или непонятный пункт — исключение,
 * а не молчаливый пустой список (иначе гейт зеленел бы от правки документа).
 */
export function parseProtected(text) {
  const from = text.indexOf(BEGIN)
  const to = text.indexOf(END)
  if (from === -1 || to === -1 || to < from) {
    throw new Error(`в ${ROLES} нет маркеров ${BEGIN} … ${END} вокруг списка защищённых путей`)
  }
  const patterns = []
  for (const line of text.slice(from + BEGIN.length, to).split('\n')) {
    if (line.trim() === '') continue
    const m = ITEM.exec(line)
    if (!m) throw new Error(`между маркерами в ${ROLES} строка не вида «- \`путь\`»: ${line.trim()}`)
    patterns.push(m[1])
  }
  if (!patterns.length) throw new Error(`между маркерами в ${ROLES} пустой список защищённых путей`)
  for (const p of patterns) {
    // Формы списка: файл, каталог с `/` и каталог с `/**`. Любая другая маска
    // означала бы, что гейт понимает список иначе, чем его читает человек.
    if (p.includes('*') && !p.endsWith('/**')) throw new Error(`маска «${p}» в ${ROLES} не вида «каталог/**»`)
    if (p.slice(0, -3).includes('*')) throw new Error(`маска «${p}» в ${ROLES} не вида «каталог/**»`)
  }
  return patterns
}

/** Путь под защитой образца: `d/**` и `d/` — каталог, иначе точное совпадение. */
export function matchesPattern(pattern, path) {
  if (pattern.endsWith('/**')) return path.startsWith(`${pattern.slice(0, -2)}`)
  if (pattern.endsWith('/')) return path.startsWith(pattern)
  return path === pattern
}

/**
 * Названо в описании — там есть либо сам путь, либо образец как он записан в
 * списке (`deploy/**`). Второе — не лазейка: это и значит «назвать защищённый
 * путь», а `compliance` видит, какой каталог тронут.
 */
export function isNamed(body, path, pattern) {
  return body.includes(path) || body.includes(pattern)
}

export function problems(patterns, changed, body) {
  const found = []
  for (const path of changed) {
    const pattern = patterns.find((p) => matchesPattern(p, path))
    if (pattern && !isNamed(body, path, pattern)) found.push({ path, pattern })
  }
  return found
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd()
  const patterns = parseProtected(readFileSync(join(root, ROLES), 'utf8'))
  const body = process.env.PR_BODY ?? ''
  const changed = readFileSync(0, 'utf8').split('\0').filter((p) => p !== '')
  const found = problems(patterns, changed, body)
  for (const { path, pattern } of found) {
    console.log(`::error::защищённый путь ${path} (образец ${pattern}) затронут диффом, но не назван в описании PR`)
  }
  if (found.length) {
    console.log(`::error::добавьте эти пути в описание PR (${ROLES}, «Мерж по консенсусу», п. 6) и сохраните описание — проверка перезапустится`)
    process.exit(1)
  }
  console.log(`ok: защищённые пути в диффе названы в описании (проверено путей: ${changed.length})`)
}
