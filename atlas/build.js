#!/usr/bin/env node
// Сборка атласа проекта. Этап 1: извлечение графа и проверка ссылок.
// `--check` ничего не пишет и падает на любой нерешённой ссылке;
// обычный запуск пишет `atlas/dist/graph.json` (каталог в .gitignore).
// ADR 2026-09-13-2000.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildGraph } from './lib/extract.js'
import { readSources } from './lib/sources.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Сколько находок печатать: остальное — эхо первых, список должен читаться. */
const SHOWN = 50

export function run({ root = join(HERE, '..'), check = false, out = join(HERE, 'dist/graph.json') } = {}) {
  const graph = buildGraph(readSources(root))
  if (graph.findings.length === 0 && !check) {
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, `${JSON.stringify({ nodes: graph.nodes, edges: graph.edges }, null, 2)}\n`)
  }
  return { ...graph, out }
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
  const { nodes, edges, findings, out } = run({ check })

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
  }
  return 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)))
