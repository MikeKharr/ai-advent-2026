// «Одна копия»: у правила один адрес, и повтор краснеет механически.
// ADR 2026-09-24-1230, A5+A6. Из какого отказа: идентификаторы моделей жили
// в пяти файлах разом, а `logging.md` в zpq-ai описывал устройство, которого
// в коде уже не было, — расхождение нашёл гейт, не автор.
//
// Список маркеров — agent_docs/guides/single-source.tsv: `маркер<TAB>владелец`.
// Маркер, встреченный в *.md вне файла-владельца, — провал шага.
//
// Журналы (agent_docs/adr/, agent_docs/development-history/) исключены: они
// история решения, а не вторая копия правила.
//
// Запуск из корня репозитория: node .github/scripts/single-source.mjs
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export const LIST = 'agent_docs/guides/single-source.tsv'

export const JOURNALS = ['agent_docs/adr/', 'agent_docs/development-history/']

/**
 * Разбор списка маркеров. Закрыто падает: пустой список, строка без
 * табуляции, пустой маркер или владелец — исключение, а не молчаливое «ноль
 * маркеров» (иначе шаг зеленел бы от порчи собственного списка).
 */
export function parseList(text) {
  const rules = []
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.replace(/\r$/, '')
    if (line.trim() === '' || line.startsWith('#')) continue
    const parts = line.split('\t')
    if (parts.length !== 2) {
      throw new Error(`${LIST}:${i + 1}: ожидались «маркер<TAB>владелец», получено ${parts.length} поля`)
    }
    const [marker, owner] = parts.map((p) => p.trim())
    if (marker === '' || owner === '') throw new Error(`${LIST}:${i + 1}: пустой маркер или владелец`)
    rules.push({ marker, owner })
  }
  if (rules.length === 0) throw new Error(`${LIST}: список маркеров пуст`)
  return rules
}

/** Владелец — файл (точное совпадение) или каталог (косая черта на конце). */
export function owns(owner, file) {
  return owner.endsWith('/') ? file.startsWith(owner) : file === owner
}

/** Все *.md репозитория, кроме журналов и служебных каталогов. Симлинки не раскрываются. */
export function markdownFiles(root, dir = root) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name)
    const rel = relative(root, abs).split(sep).join('/')
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) {
      // Те же каталоги, что в .gitignore: в чистом checkout CI их нет, а в
      // рабочем дереве временный клон и зависимости — не документы проекта.
      if (['.git', 'node_modules', 'dist', 'build', 'coverage', 'temp'].includes(e.name)) continue
      if (JOURNALS.some((j) => `${rel}/` === j)) continue
      out.push(...markdownFiles(root, abs))
    } else if (e.isFile() && e.name.endsWith('.md')) {
      out.push(rel)
    }
  }
  return out
}

/** Находки: маркер встретился в файле, который им не владеет. */
export function problems(rules, files, read) {
  const found = []
  for (const file of files) {
    const text = read(file)
    for (const { marker, owner } of rules) {
      if (owns(owner, file)) continue
      const line = text.split('\n').findIndex((l) => l.includes(marker))
      if (line !== -1) found.push({ file, line: line + 1, marker, owner })
    }
  }
  return found
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = process.cwd()
  const rules = parseList(readFileSync(join(root, LIST), 'utf8'))
  const files = markdownFiles(root).filter((f) => !JOURNALS.some((j) => f.startsWith(j)))
  const found = problems(rules, files, (f) => readFileSync(join(root, f), 'utf8'))
  for (const p of found) {
    console.log(`::error file=${p.file},line=${p.line}::«${p.marker}» — копия; владелец маркера ${p.owner} (${LIST}). Сослаться, а не повторить`)
  }
  if (found.length > 0) process.exit(1)
  console.log(`ok: ${rules.length} маркеров, ${files.length} файлов — копий нет`)
}
