// Страж «защищённые пути названы в описании PR»: разбор списка из
// agent_docs/guides/agent-roles.md, семантика совпадения и — главное —
// доказательство, что при расхождении CLI краснеет. Скрипт запускается как
// есть, тем же способом, что в шаге docs-guard: пути на stdin через NUL,
// описание в PR_BODY.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { ROLES, matchesPattern, parseProtected, problems } from '../.github/scripts/protected-paths.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(ROOT, '.github/scripts/protected-paths.mjs')

/** Прогон CLI: пути через NUL на stdin, описание — в окружении. */
function run(paths, body, cwd = ROOT) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd,
    input: paths.map((p) => `${p}\0`).join(''),
    env: { ...process.env, PR_BODY: body },
    encoding: 'utf8',
  })
}

test('список защищённых путей читается из agent-roles.md', () => {
  const patterns = parseProtected(readFileSync(join(ROOT, ROLES), 'utf8'))
  assert.deepEqual(patterns, [
    'agent_docs/invariants.md',
    '.claude/**',
    'AGENTS.md',
    '.agents/skills/day-cycle/',
    'agent_docs/guides/agent-roles.md',
    '.github/**',
    'deploy/**',
    'router/config/**',
  ])
})

test('совпадение: каталог по префиксу, файл точно', () => {
  assert.ok(matchesPattern('deploy/**', 'deploy/Caddyfile'))
  assert.ok(matchesPattern('deploy/**', 'deploy/units/day1.env.example'))
  assert.ok(!matchesPattern('deploy/**', 'deployment/x'))
  assert.ok(!matchesPattern('deploy/**', 'days/day1/deploy/x'))
  assert.ok(matchesPattern('.agents/skills/day-cycle/', '.agents/skills/day-cycle/SKILL.md'))
  assert.ok(!matchesPattern('.agents/skills/day-cycle/', '.agents/skills/design-review/SKILL.md'))
  assert.ok(matchesPattern('AGENTS.md', 'AGENTS.md'))
  assert.ok(!matchesPattern('AGENTS.md', 'agent_docs/AGENTS.md'))
})

test('назван либо путь, либо образец списка', () => {
  const patterns = ['deploy/**']
  assert.deepEqual(problems(patterns, ['deploy/Caddyfile'], 'правим `deploy/Caddyfile`'), [])
  assert.deepEqual(problems(patterns, ['deploy/Caddyfile'], 'защищённые пути: `deploy/**`'), [])
  assert.deepEqual(problems(patterns, ['deploy/Caddyfile'], 'правим Caddyfile'), [
    { path: 'deploy/Caddyfile', pattern: 'deploy/**' },
  ])
})

// Случай PR #201: названы два защищённых пути из трёх, третий — deploy/Caddyfile.
test('страж краснеет: затронутый защищённый путь не назван', () => {
  const body = 'Класс A. Защищённые пути: `.github/workflows/deploy.yml`, `.agents/skills/day-cycle/SKILL.md`.'
  const r = run(['.github/workflows/deploy.yml', '.agents/skills/day-cycle/SKILL.md', 'deploy/Caddyfile'], body)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /::error::защищённый путь deploy\/Caddyfile \(образец deploy\/\*\*\)/)
})

test('страж краснеет: описание пустое', () => {
  const r = run(['deploy/compose.yml'], '')
  assert.equal(r.status, 1)
  assert.match(r.stdout, /deploy\/compose\.yml/)
})

test('страж зелёный: все затронутые защищённые пути названы', () => {
  const body = 'Защищённые пути: `.github/scripts/protected-paths.mjs`, `deploy/**`.'
  const r = run(['.github/scripts/protected-paths.mjs', 'deploy/Caddyfile', 'days/day1/server.js'], body)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /^ok: /m)
})

test('страж зелёный: защищённых путей в диффе нет', () => {
  const r = run(['days/day1/server.js', 'agent_docs/snapshot.md'], '')
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('страж краснеет: маркеры списка убрали из agent-roles.md', () => {
  const dir = mkdtempSync(join(tmpdir(), 'protected-paths-'))
  try {
    const file = join(dir, ROLES)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '6. Защищённые пути: `deploy/**`, `.github/**`.\n')
    const r = run(['deploy/Caddyfile'], 'описание без путей', dir)
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /нет маркеров/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
