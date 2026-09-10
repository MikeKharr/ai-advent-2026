#!/usr/bin/env node
// Сборка атласа проекта. Этап 1: извлечение графа и проверка ссылок.
// `--check` ничего не пишет и падает на любой нерешённой ссылке;
// обычный запуск пишет `atlas/dist/graph.json` (каталог в .gitignore).
// ADR 2026-09-13-2000.

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildGraph } from './lib/extract.js'
import { readSources } from './lib/sources.js'
import { VAULT_DIRS, buildVault } from './lib/vault.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Сколько находок печатать: остальное — эхо первых, список должен читаться. */
const SHOWN = 50

/**
 * Право записи — только внутрь `atlas/dist/`. Проверяется путь после
 * разрешения, а не строка от вызывающего: `dist/../../.ssh` — тоже строка,
 * начинающаяся с `dist`.
 */
function insideDist(path) {
  const full = resolve(path)
  return full.includes(`${sep}atlas${sep}dist${sep}`) || full.endsWith(`${sep}atlas${sep}dist`)
}

function writeInsideDist(path, text) {
  if (!insideDist(path)) throw new Error(`запись мимо atlas/dist: ${path}`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/**
 * Коммит и его время — не «сейчас»: иначе каждый прогон давал бы diff во всех
 * заметках vault. Без git (например, на копии входов в тестах) происхождение
 * честно говорит, что коммит неизвестен.
 */
export function readProvenance(root) {
  try {
    const git = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
    return {
      sha: git(['rev-parse', 'HEAD']),
      time: git(['show', '-s', '--format=%cd', '--date=format:%Y-%m-%d %H:%M %z', 'HEAD']).replace(/([+-]\d{2})00$/, '$1'),
    }
  } catch {
    return { sha: 'вне git', time: 'не определено' }
  }
}

export function run({ root = join(HERE, '..'), check = false, out = join(HERE, 'dist/graph.json') } = {}) {
  const sources = readSources(root)
  const graph = buildGraph(sources)
  const vaultDir = join(dirname(out), 'vault')
  let vault = []

  if (graph.findings.length === 0 && !check) {
    writeInsideDist(out, `${JSON.stringify({ nodes: graph.nodes, edges: graph.edges }, null, 2)}\n`)

    vault = buildVault({ graph, sources, provenance: readProvenance(root) })
    // Чистятся только свои каталоги: `.obsidian/` создаёт сам Obsidian, там
    // состояние окна пользователя, и сборка его не трогает.
    for (const dir of VAULT_DIRS) {
      const path = join(vaultDir, dir)
      if (!insideDist(path)) throw new Error(`очистка мимо atlas/dist: ${path}`)
      rmSync(path, { recursive: true, force: true })
    }
    for (const file of vault) writeInsideDist(join(vaultDir, file.path), file.text)
  }

  return { ...graph, out, vault, vaultDir }
}

/** В Actions находка — аннотация: тогда она видна прямо в diff'е PR. */
function format(f) {
  return process.env.GITHUB_ACTIONS === 'true'
    ? `::error file=${f.file},line=${f.line}::${f.message}`
    : `${f.file}:${f.line}: ${f.message}`
}

/**
 * Узлы без рёбер по типам. Это не находка: вендорный скилл, который ни одна
 * роль не предзагружает, — факт о проекте, а не дефект графа. Но рост числа
 * должен быть виден, поэтому сборка печатает сводку (проект решения
 * 2026-09-13-2000, критерий этапа 1).
 */
function isolated(nodes, edges) {
  const linked = new Set()
  for (const e of edges) {
    linked.add(e.from)
    linked.add(e.to)
  }
  const byType = {}
  for (const n of nodes) if (!linked.has(n.id)) byType[n.type] = (byType[n.type] ?? 0) + 1
  const total = Object.values(byType).reduce((a, b) => a + b, 0)
  if (total === 0) return 'ни одного'
  return `${total} (${Object.entries(byType)
    .sort()
    .map(([t, n]) => `${t} ${n}`)
    .join(', ')})`
}

function main(argv) {
  const check = argv.includes('--check')
  const { nodes, edges, findings, out, vault, vaultDir } = run({ check })

  for (const f of findings.slice(0, SHOWN)) console.error(format(f))
  if (findings.length > SHOWN) console.error(`…и ещё ${findings.length - SHOWN} находок`)

  if (findings.length > 0) {
    console.error(`\nнаходок: ${findings.length}. Граф не записан: ссылки чинятся в источнике, а не в атласе.`)
    return 1
  }

  const byType = {}
  for (const n of nodes) byType[n.type] = (byType[n.type] ?? 0) + 1
  const shape = Object.entries(byType)
    .sort()
    .map(([t, n]) => `${t} ${n}`)
    .join(', ')

  if (check) console.log(`ok: ссылки разрешаются, находок нет (${nodes.length} узлов, ${edges.length} рёбер)`)
  else {
    console.log(`записано ${out}\n${nodes.length} узлов (${shape}), ${edges.length} рёбер`)
    console.log(`без рёбер: ${isolated(nodes, edges)}`)
    console.log(`vault: ${vault.length} заметок в ${vaultDir}`)
  }
  return 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)))
