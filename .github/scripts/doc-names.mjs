// Имена атомарных документов: формат YYYY-MM-DD-HHMM-slug.md, валидное время
// и момент в имени не позже запуска проверки. Правило и допуск —
// ADR agent_docs/adr/2026-09-11-1046-atomic-document-dates.md, «Проверка в CI».
// Запуск из корня репозитория: node .github/scripts/doc-names.mjs
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Каталог → документы состояния в нём, на которые формат не распространяется.
export const DIRS = {
  'agent_docs/adr': ['README.md'],
  'agent_docs/development-history': ['README.md'],
  'agent_docs/design': ['README.md', 'corpus.md'],
}

// Запас на рассинхрон часов машины автора и раннера.
export const SKEW_MS = 10 * 60 * 1000

const NAME = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})-[a-z0-9-]+\.md$/

export function nameProblem(name, now) {
  const m = NAME.exec(name)
  if (!m) return 'имя должно быть YYYY-MM-DD-HHMM-slug.md, slug латиницей в kebab-case'
  const [y, mo, d, h, mi] = m.slice(1).map(Number)
  if (h > 23 || mi > 59) return `время ${m[4]}${m[5]} невалидно: часы 00–23, минуты 00–59`
  if (Date.UTC(y, mo - 1, d, h, mi) > now + SKEW_MS) {
    return `время в имени позже текущего UTC (${new Date(now).toISOString()}) больше чем на 10 минут; ` +
      'имя берётся из `date -u +%Y-%m-%d-%H%M` в момент создания'
  }
  return null
}

export function problems(root, now) {
  const found = []
  for (const [dir, exempt] of Object.entries(DIRS)) {
    for (const name of readdirSync(join(root, dir)).sort()) {
      if (!name.endsWith('.md') || exempt.includes(name)) continue
      const problem = nameProblem(name, now)
      if (problem) found.push({ file: `${dir}/${name}`, problem })
    }
  }
  return found
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const now = Date.now()
  const found = problems(process.cwd(), now)
  for (const { file, problem } of found) console.log(`::error file=${file}::${problem}`)
  if (found.length) process.exit(1)
  console.log(`ok: имена атомарных документов верны на ${new Date(now).toISOString()}`)
}
