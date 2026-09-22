// Страж «защищённые пути названы в описании PR»: разбор списка из
// agent_docs/guides/agent-roles.md, семантика совпадения и — главное —
// доказательство, что при расхождении CLI краснеет. Скрипт запускается как
// есть, тем же способом, что в шаге docs-guard: пути на stdin через NUL,
// описание в PR_BODY, базовая версия списка — в ROLES_BASE_FILE.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { ROLES, matchesPattern, parseProtected, problems, unionProtected } from '../.github/scripts/protected-paths.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(ROOT, '.github/scripts/protected-paths.mjs')
const ROLES_TEXT = readFileSync(join(ROOT, ROLES), 'utf8')

/** Прогон CLI: пути через NUL на stdin, описание и базовый список — в окружении. */
function run(paths, body, { cwd = ROOT, baseText = ROLES_TEXT } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'protected-paths-base-'))
  const baseFile = join(dir, 'agent-roles-base.md')
  writeFileSync(baseFile, baseText)
  try {
    return spawnSync(process.execPath, [SCRIPT], {
      cwd,
      input: paths.map((p) => `${p}\0`).join(''),
      env: { ...process.env, PR_BODY: body, ROLES_BASE_FILE: baseFile },
      encoding: 'utf8',
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Рабочее дерево с подменённым agent-roles.md — как его видел бы PR. */
function treeWithRoles(text) {
  const dir = mkdtempSync(join(tmpdir(), 'protected-paths-head-'))
  const file = join(dir, ROLES)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  return dir
}

test('список защищённых путей читается из agent-roles.md', () => {
  assert.deepEqual(parseProtected(ROLES_TEXT), [
    'agent_docs/invariants.md',
    '.claude/**',
    'AGENTS.md',
    'CLAUDE.md',
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

test('судят по объединению базовой и головной версий списка', () => {
  const base = '<!-- protected-paths:begin -->\n- `deploy/**`\n- `router/config/**`\n<!-- protected-paths:end -->\n'
  const head = '<!-- protected-paths:begin -->\n- `deploy/**`\n- `site/**`\n<!-- protected-paths:end -->\n'
  assert.deepEqual(unionProtected(base, head), ['deploy/**', 'router/config/**', 'site/**'])
})

test('базовая версия без маркеров — список берётся из головной (первый прогон)', () => {
  const head = '<!-- protected-paths:begin -->\n- `deploy/**`\n<!-- protected-paths:end -->\n'
  assert.deepEqual(unionProtected('6. Защищённые пути: `deploy/**`.\n', head), ['deploy/**'])
})

// Случай PR #201: названы два защищённых пути из трёх, третий — deploy/Caddyfile.
test('страж краснеет: затронутый защищённый путь не назван', () => {
  const body = 'Класс A. Защищённые пути: `.github/workflows/deploy.yml`, `.agents/skills/day-cycle/SKILL.md`.'
  const r = run(['.github/workflows/deploy.yml', '.agents/skills/day-cycle/SKILL.md', 'deploy/Caddyfile'], body)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /::error::защищённый путь deploy\/Caddyfile \(образец deploy\/\*\*\)/)
})

// Находка ревьюера к PR #206: PR, вычеркнувший строки из списка, не должен
// судиться по укороченному — иначе одной правкой снимается защита с путей,
// переписывается сам страж и ничего не краснеет.
test('страж краснеет: PR сузил список защищённых путей в собственном диффе', () => {
  const narrowed = ROLES_TEXT
    .replace('   - `.github/**`\n', '')
    .replace('   - `agent_docs/guides/agent-roles.md`\n', '')
  assert.ok(!parseProtected(narrowed).includes('.github/**'))
  const cwd = treeWithRoles(narrowed)
  try {
    const r = run(
      ['agent_docs/guides/agent-roles.md', '.github/scripts/protected-paths.mjs', '.github/workflows/docs-guard.yml'],
      'мелкая правка формулировок',
      { cwd },
    )
    assert.equal(r.status, 1)
    assert.match(r.stdout, /agent_docs\/guides\/agent-roles\.md/)
    assert.match(r.stdout, /\.github\/scripts\/protected-paths\.mjs/)
    assert.match(r.stdout, /\.github\/workflows\/docs-guard\.yml/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
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

test('страж краснеет: маркеры списка убрали из обеих версий', () => {
  const plain = '6. Защищённые пути: `deploy/**`, `.github/**`.\n'
  const cwd = treeWithRoles(plain)
  try {
    const r = run(['deploy/Caddyfile'], 'описание без путей', { cwd, baseText: plain })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /нет маркеров/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('страж краснеет: маркеры убрали только в головной версии', () => {
  const cwd = treeWithRoles('6. Защищённые пути: `deploy/**`.\n')
  try {
    const r = run(['deploy/Caddyfile'], 'описание без путей', { cwd })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /нет маркеров/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('страж краснеет: базовая версия списка не задана', () => {
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    input: 'deploy/Caddyfile\0',
    env: { ...process.env, PR_BODY: '', ROLES_BASE_FILE: '' },
    encoding: 'utf8',
  })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /ROLES_BASE_FILE/)
})
