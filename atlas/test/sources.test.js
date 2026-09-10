import assert from 'node:assert/strict'
import { test } from 'node:test'
import { INPUTS } from '../lib/sources.js'

// Список входов — единственное место, через которое в граф попадают данные.
// Расширить его — единственный способ протащить секрет, поэтому список
// прибит тестом: новый вход требует явной правки здесь и разговора на ревью.

const EXPECTED = [
  'agent_docs/adr',
  'agent_docs/development-history',
  'agent_docs/design',
  'agent_docs/guides',
  'agent_docs/architecture.md',
  'agent_docs/index.md',
  'agent_docs/glossary.md',
  'AGENTS.md',
  'agent_docs/invariants.md',
  '.claude/agents',
  '.agents/skills',
  'skills-lock.json',
  'days',
  'deploy/compose.yml',
  'deploy/Caddyfile',
  'site/index.html',
  'router/config/providers.json',
  'atlas/overlay.json',
]

const paths = Object.values(INPUTS).flat()

test('входы — ровно тот список, что разрешён', () => {
  assert.deepEqual(paths.slice().sort(), EXPECTED.slice().sort())
})

test('среди входов нет ни одного запретного пути', () => {
  // I-1…I-3: секреты, логи, временные и локальные данные не читаются никогда.
  const forbidden = [/(^|\/)\.env/, /^deploy\/.*\.env$/, /^temp\//, /^logs\//, /(^|\/)data(\/|$)/, /\.sqlite/]
  for (const p of paths) {
    for (const re of forbidden) assert.equal(re.test(p), false, `вход ${p} попадает под запрет ${re}`)
  }
})

test('входы заданы относительными путями внутри репозитория', () => {
  for (const p of paths) {
    assert.equal(p.startsWith('/'), false, p)
    assert.equal(p.includes('..'), false, p)
  }
})
