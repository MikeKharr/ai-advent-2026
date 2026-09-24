// «Имена шагов CI в документах существуют»: документ, который ссылается на
// шаг CI как на держателя правила, обязан называть шаг, который есть.
// ADR 2026-09-24-1230, A6. Из какого отказа: переименование шага делает
// ссылку ложной молча — предвидено записью 2026-09-23-0415.
//
// Ищем `шаг «X»` (любая падежная форма, с необязательным «CI») в
// AGENTS.md, agent_docs/**/*.md вне журналов и файлах deploy/.
// X обязано встретиться среди значений `name:` в .github/workflows/*.yml.
//
// Журналы (adr/, development-history/) исключены: они описывают шаги того
// дня, включая переименованные и чужие репозитории, и переписыванию истории
// под сегодняшний workflow места нет.
//
// Запуск из корня репозитория: node .github/scripts/ci-step-names.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export const WORKFLOWS = '.github/workflows'

const JOURNALS = ['agent_docs/adr/', 'agent_docs/development-history/']

// «шаг», «шага», «шагом», «шаги» + необязательное «CI» + имя в кавычках-ёлочках.
const MENTION = /шаг[а-яё]*\s+(?:CI\s+)?«([^»]+)»/gu

/** Значения `name:` всех workflow. Пустой набор — провал: читать нечего. */
export function workflowNames(dir, read = (f) => readFileSync(f, 'utf8')) {
  const names = new Set()
  const files = readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  if (files.length === 0) throw new Error(`${WORKFLOWS}: workflow не найдены — проверять имена не с чем`)
  for (const f of files) {
    for (const line of read(join(dir, f)).split('\n')) {
      const m = /^\s*-?\s*name:\s*(\S.*?)\s*$/.exec(line)
      if (m) names.add(m[1].replace(/^['"]|['"]$/g, ''))
    }
  }
  return names
}

/** Упоминания шагов в тексте: [{ name, line }]. */
export function mentions(text) {
  const out = []
  for (const [i, line] of text.split('\n').entries()) {
    for (const m of line.matchAll(MENTION)) out.push({ name: m[1].trim(), line: i + 1 })
  }
  return out
}

/** Файлы, где ссылка на шаг обязана быть живой. */
export function scanned(root) {
  const out = ['AGENTS.md']
  const walk = (dir) => {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) {
        if (!JOURNALS.includes(`${rel}/`)) walk(rel)
      } else if (e.isFile() && (dir.startsWith('deploy') || e.name.endsWith('.md'))) {
        out.push(rel)
      }
    }
  }
  walk('agent_docs')
  walk('deploy')
  return out.map((f) => f.split(sep).join('/'))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = process.cwd()
  const names = workflowNames(join(root, WORKFLOWS))
  let bad = 0
  let seen = 0
  for (const file of scanned(root)) {
    if (!statSync(join(root, file)).isFile()) continue
    for (const { name, line } of mentions(readFileSync(join(root, file), 'utf8'))) {
      seen += 1
      if (names.has(name)) continue
      bad += 1
      console.log(`::error file=${file},line=${line}::шага «${name}» нет среди name: в ${WORKFLOWS}/*.yml — переименован или живёт в другом репозитории`)
    }
  }
  if (bad > 0) process.exit(1)
  console.log(`ok: ${seen} ссылок на шаги CI, все имена существуют`)
}
