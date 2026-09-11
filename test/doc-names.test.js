// Проверка имён атомарных документов (.github/scripts/doc-names.mjs) на синтетике
// и на текущем дереве. Правило — ADR agent_docs/adr/2026-09-11-1046-atomic-document-dates.md.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { DIRS, nameProblem, problems } from '../.github/scripts/doc-names.mjs'

const NOW = Date.parse('2026-09-11T12:00:00Z')
const ROOT = fileURLToPath(new URL('..', import.meta.url))

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'doc-names-'))
  for (const dir of Object.keys(DIRS)) mkdirSync(join(root, dir), { recursive: true })
  for (const f of files) writeFileSync(join(root, f), '# x\n')
  return root
}

test('нормальные имена проходят', () => {
  for (const name of [
    '2026-09-07-1455-adopt-2030ai-template.md',
    '2026-09-11-0000-midnight.md',
    '2026-09-11-1159-last-minute.md',
    '2026-09-10-2359-late.md',
  ]) assert.equal(nameProblem(name, NOW), null, name)
})

test('время в пределах 10 минут вперёд проходит, дальше — нет', () => {
  assert.equal(nameProblem('2026-09-11-1210-skew.md', NOW), null)
  assert.match(nameProblem('2026-09-11-1211-skew.md', NOW), /позже текущего UTC/)
})

test('будущая дата — ошибка', () => {
  assert.match(nameProblem('2026-09-14-2330-atlas-fullgraph-search.md', NOW), /позже текущего UTC/)
  assert.match(nameProblem('2026-09-12-0000-tomorrow.md', NOW), /позже текущего UTC/)
})

test('часы 24 и минуты 60 — ошибка, даже в прошлом', () => {
  assert.match(nameProblem('2026-09-09-2400-tailscale-to-laptop.md', NOW), /время 2400 невалидно/)
  assert.match(nameProblem('2026-09-09-1060-bad-minutes.md', NOW), /время 1060 невалидно/)
})

test('несуществующая дата — ошибка, даже если после переноса она в прошлом', () => {
  for (const name of [
    '2026-08-32-1000-x.md',
    '2026-02-30-1000-x.md',
    '2026-09-00-1000-x.md',
    '2026-00-15-1000-x.md',
    '2025-13-01-1000-x.md',
  ]) assert.match(nameProblem(name, NOW), /дата .* невалидна/, name)
})

test('имя не по формату — ошибка', () => {
  for (const name of [
    '2026-09-10-day6-monitor-layout.md',
    '2026-09-10-1553-Progress_Page.md',
    '2026-09-10-1553.md',
  ]) assert.match(nameProblem(name, NOW), /YYYY-MM-DD-HHMM-slug\.md/, name)
})

test('design/ без времени в имени — ошибка; README и корпус — не атомарные', () => {
  const root = tree([
    'agent_docs/design/README.md',
    'agent_docs/design/corpus.md',
    'agent_docs/design/2026-09-10-day6-monitor-layout.md',
    'agent_docs/adr/README.md',
    'agent_docs/development-history/README.md',
  ])
  try {
    assert.deepEqual(problems(root, NOW).map((p) => p.file), ['agent_docs/design/2026-09-10-day6-monitor-layout.md'])
  } finally {
    rmSync(root, { recursive: true })
  }
})

test('все три каталога проверяются', () => {
  const root = tree([
    'agent_docs/adr/2026-09-14-0900-future.md',
    'agent_docs/development-history/2026-09-09-2400-bad-time.md',
    'agent_docs/design/2026-09-13-0930-future-layout.md',
    'agent_docs/design/2026-09-10-1553-progress-page.md',
  ])
  try {
    assert.deepEqual(problems(root, NOW).map((p) => p.file), [
      'agent_docs/adr/2026-09-14-0900-future.md',
      'agent_docs/development-history/2026-09-09-2400-bad-time.md',
      'agent_docs/design/2026-09-13-0930-future-layout.md',
    ])
  } finally {
    rmSync(root, { recursive: true })
  }
})

test('текущее дерево репозитория проходит на текущем времени', () => {
  assert.deepEqual(problems(ROOT, Date.now()), [])
})
