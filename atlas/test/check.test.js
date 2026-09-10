import assert from 'node:assert/strict'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { buildGraph } from '../lib/extract.js'
import { readSources } from '../lib/sources.js'
import { makeFixture } from './helpers.js'

// Проверка ссылок должна падать закрыто: сломанная ссылка — красная проверка
// в CI, а не тихо пропавшее ребро (ADR 2026-09-13-2000, п. 7).

const fixture = makeFixture()
after(() => fixture.cleanup())

const findings = () => buildGraph(readSources(fixture.root)).findings
const patch = (rel, fn) => {
  const file = join(fixture.root, rel)
  writeFileSync(file, fn(readFileSync(file, 'utf8')))
}
const restore = (() => {
  const saved = new Map()
  return {
    keep(rel) {
      const file = join(fixture.root, rel)
      if (!saved.has(rel)) saved.set(rel, readFileSync(file, 'utf8'))
    },
    all() {
      for (const [rel, text] of saved) writeFileSync(join(fixture.root, rel), text)
      saved.clear()
    },
  }
})()

const GUIDE = 'agent_docs/guides/dod.md'

test('копия репозитория без правок чиста', () => {
  assert.deepEqual(findings(), [])
})

test('цитата ADR без файла — находка с именем файла и строкой', () => {
  restore.keep(GUIDE)
  appendFileSync(join(fixture.root, GUIDE), '\nСм. ADR `2026-01-01-0000`.\n')
  const found = findings()
  restore.all()

  assert.equal(found.length, 1)
  assert.equal(found[0].file, GUIDE)
  assert.ok(found[0].line > 1)
  assert.match(found[0].message, /2026-01-01-0000/)
})

test('путь к записи истории без файла — находка', () => {
  restore.keep(GUIDE)
  appendFileSync(join(fixture.root, GUIDE), '\nСм. `development-history/2026-01-01-0000-nothing.md`.\n')
  const found = findings()
  restore.all()

  assert.equal(found.length, 1)
  assert.match(found[0].message, /не разрешается/)
})

test('путь к гайду без файла — находка', () => {
  restore.keep(GUIDE)
  appendFileSync(join(fixture.root, GUIDE), '\nСм. `agent_docs/guides/nothing.md`.\n')
  const found = findings()
  restore.all()

  assert.equal(found.length, 1)
  assert.match(found[0].message, /guides\/nothing\.md/)
})

test('инвариант вне I-1…I-12 — находка', () => {
  restore.keep(GUIDE)
  appendFileSync(join(fixture.root, GUIDE), '\nПо инварианту I-13 это запрещено.\n')
  const found = findings()
  restore.all()

  assert.equal(found.length, 1)
  assert.match(found[0].message, /I-13/)
})

test('роль overlay вне .claude/agents — находка с строкой overlay', () => {
  restore.keep('atlas/overlay.json')
  patch('atlas/overlay.json', (t) => t.replace('"reviewer", "compliance"', '"reviewer", "complianсe"'))
  const found = findings()
  restore.all()

  assert.ok(found.length > 0)
  assert.equal(found[0].file, 'atlas/overlay.json')
  assert.ok(found[0].line > 1)
  assert.match(found[0].message, /которой нет в \.claude\/agents\//)
})

test('сервис overlay вне compose.yml — находка', () => {
  restore.keep('atlas/overlay.json')
  patch('atlas/overlay.json', (t) => t.replace('"from": "day1"', '"from": "day99"'))
  const found = findings()
  restore.all()

  assert.equal(found.length, 1)
  assert.equal(found[0].file, 'atlas/overlay.json')
  assert.match(found[0].message, /day99.*compose\.yml/)
})

test('внешний сервис overlay без описания — находка', () => {
  restore.keep('atlas/overlay.json')
  patch('atlas/overlay.json', (t) => t.replace('"to": "tailscale"', '"to": "tailnet"'))
  const found = findings()
  restore.all()

  assert.equal(found.length, 1)
  assert.match(found[0].message, /externals/)
})

test('день в исключениях overlay, которого нет в days/ — находка', () => {
  restore.keep('atlas/overlay.json')
  patch('atlas/overlay.json', (t) => t.replace('"days": ["day4"]', '"days": ["day42"]'))
  const found = findings()
  restore.all()

  assert.equal(found.length, 1)
  assert.match(found[0].message, /day42/)
})

test('после отката правок копия снова чиста', () => {
  assert.deepEqual(findings(), [])
})
