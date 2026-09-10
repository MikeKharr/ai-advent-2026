import assert from 'node:assert/strict'
import { test } from 'node:test'
import { INPUTS, isDeclaredDir, isDeclaredInput } from '../lib/sources.js'

// Границу публикуемого держит не список сам по себе — держит её то, что
// каждое чтение проходит проверку «путь лежит под объявленным входом».
// Список описывает намерение и прибит тестом: новый вход требует явной
// правки здесь и разговора на ревью.

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

test('чтение мимо списка входов не проходит', () => {
  for (const rel of ['deploy/secrets.env', '.env', 'temp/x.json', 'logs/app.log', 'router/data/ledger.jsonl', 'days/day1/server.js']) {
    assert.equal(isDeclaredInput(rel), false, rel)
  }
  for (const rel of ['agent_docs/adr/2026-01-01-0000-x.md', '.agents/skills/x/SKILL.md', 'AGENTS.md', 'deploy/compose.yml']) {
    assert.equal(isDeclaredInput(rel), true, rel)
  }
  // `days/` только перечисляется: код приложений дня в граф не читается.
  assert.equal(isDeclaredDir('days'), true)
  assert.equal(isDeclaredInput('days/day1'), false)
})

test('входы заданы относительными путями внутри репозитория', () => {
  for (const p of paths) {
    assert.equal(p.startsWith('/'), false, p)
    assert.equal(p.includes('..'), false, p)
  }
})
