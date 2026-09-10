import assert from 'node:assert/strict'
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

/**
 * Ломает вход, считает находки и возвращает файл на место в любом случае:
 * упавший assert не должен ронять каскадом остальные тесты файла.
 */
function broken(rel, change) {
  const file = join(fixture.root, rel)
  const saved = readFileSync(file, 'utf8')
  try {
    writeFileSync(file, change(saved))
    return findings()
  } finally {
    writeFileSync(file, saved)
  }
}

const appended = (rel, tail) => broken(rel, (t) => t + tail)

const GUIDE = 'agent_docs/guides/dod.md'
const OVERLAY = 'atlas/overlay.json'

test('копия репозитория без правок чиста', () => {
  assert.deepEqual(findings(), [])
})

test('цитата ADR без файла — находка с именем файла и строкой', () => {
  const found = appended(GUIDE, '\nСм. ADR `2026-01-01-0000`.\n')
  assert.equal(found.length, 1)
  assert.equal(found[0].file, GUIDE)
  assert.ok(found[0].line > 1)
  assert.match(found[0].message, /2026-01-01-0000/)
})

test('путь к записи истории без файла — находка', () => {
  const found = appended(GUIDE, '\nСм. `development-history/2026-01-01-0000-nothing.md`.\n')
  assert.equal(found.length, 1)
  assert.match(found[0].message, /не разрешается/)
})

test('путь к гайду без файла — находка', () => {
  const found = appended(GUIDE, '\nСм. `agent_docs/guides/nothing.md`.\n')
  assert.equal(found.length, 1)
  assert.match(found[0].message, /guides\/nothing\.md/)
})

test('ссылка на корневой документ проверяется гейтом', () => {
  assert.deepEqual(appended(GUIDE, '\nСловарь — `agent_docs/glossary.md`, правила — `AGENTS.md`.\n'), [])

  // Переименование корневого документа больше не проходит мимо: цитаты на
  // него становятся находками (на main таких ссылок 48).
  const file = join(fixture.root, 'agent_docs/glossary.md')
  const saved = readFileSync(file, 'utf8')
  try {
    rmSync(file)
    const found = findings()
    assert.ok(found.some((f) => /glossary\.md/.test(f.message) && /не разрешается/.test(f.message)))
  } finally {
    writeFileSync(file, saved)
  }
})

test('инвариант, которого нет в invariants.md, — находка', () => {
  const found = appended(GUIDE, '\nПо инварианту I-999 это запрещено.\n')
  assert.equal(found.length, 1)
  assert.match(found[0].message, /I-999/)
  assert.match(found[0].message, /agent_docs\/invariants\.md/, 'находка обязана назвать источник списка')
})

test('добавленный в invariants.md инвариант становится разрешённым, а не находкой', () => {
  // Диапазон I-N берётся из файла: иначе новый инвариант уронил бы
  // обязательную проверку на всех PR, обвиняя невиновный документ.
  // Номер взят заведомо свободный: следующий по порядку однажды займут,
  // и тест, доказывающий эту починку, сломался бы именно об неё.
  const file = join(fixture.root, 'agent_docs/invariants.md')
  const saved = readFileSync(file, 'utf8')
  try {
    writeFileSync(file, `${saved}\n- **I-999.** Проверочный инвариант.\n`)
    appendFileSync(join(fixture.root, GUIDE), '\nПо инварианту I-999 это запрещено.\n')
    const graph = buildGraph(readSources(fixture.root))
    assert.deepEqual(graph.findings, [])
    assert.ok(graph.edges.some((e) => e.kind === 'relies' && e.to === 'invariant/I-999'))
  } finally {
    writeFileSync(file, saved)
    writeFileSync(join(fixture.root, GUIDE), readFileSync(join(fixture.root, GUIDE), 'utf8').replace('\nПо инварианту I-999 это запрещено.\n', ''))
  }
})

test('роль overlay вне .claude/agents — находка со строкой overlay', () => {
  const found = broken(OVERLAY, (t) => t.replace('"reviewer", "compliance"', '"reviewer", "complicane"'))
  assert.ok(found.length > 0)
  assert.equal(found[0].file, OVERLAY)
  assert.ok(found[0].line > 1)
  assert.match(found[0].message, /которой нет в \.claude\/agents\//)
})

test('сервис overlay вне compose.yml — находка', () => {
  const found = broken(OVERLAY, (t) => t.replace('"from": "day1"', '"from": "day99"'))
  assert.equal(found.length, 1)
  assert.equal(found[0].file, OVERLAY)
  assert.match(found[0].message, /day99.*compose\.yml/)
})

test('внешний сервис overlay без описания — находка', () => {
  const found = broken(OVERLAY, (t) => t.replace('"to": "tailscale"', '"to": "tailnet"'))
  assert.ok(found.length > 0)
  assert.match(found[0].message, /externals/)
})

test('внешний узел без единого ребра — находка', () => {
  const found = broken(OVERLAY, (t) =>
    t.replace('"publishes": [\n    { "from": "github-actions", "to": "ghcr" }\n  ],', '"publishes": [],'),
  )
  assert.equal(found.length, 1)
  assert.match(found[0].message, /github-actions/)
  assert.match(found[0].message, /не связан/)
})

test('день в исключениях overlay, которого нет в days/ — находка', () => {
  const found = broken(OVERLAY, (t) => t.replace('"days": ["day4"]', '"days": ["day42"]'))
  assert.equal(found.length, 1)
  assert.match(found[0].message, /day42/)
})

test('compose за подмножеством парсера — находка, а не пустые зависимости', () => {
  const found = broken('deploy/compose.yml', (t) =>
    t.replace('    depends_on:\n      - router\n', '    depends_on:\n      router:\n        condition: service_healthy\n'),
  )
  assert.ok(found.length > 0)
  assert.equal(found[0].file, 'deploy/compose.yml')
  assert.match(found[0].message, /подмножеств/)
})

test('битый JSON входа — находка, а не стек', () => {
  const found = broken('router/config/providers.json', () => '{ это не json')
  assert.ok(found.some((f) => f.file === 'router/config/providers.json' && /JSON/.test(f.message)))
})

test('пропавший вход — находка, а не стек', () => {
  const file = join(fixture.root, 'site/index.html')
  const saved = readFileSync(file, 'utf8')
  try {
    rmSync(file)
    const found = findings()
    assert.ok(found.some((f) => f.file === 'site/index.html' && /не читается/.test(f.message)))
  } finally {
    writeFileSync(file, saved)
  }
})

test('два входа с одним идентификатором узла — находка, а не тихо удвоенный узел', () => {
  // `AGENTS.md` даёт узел `guide/agents`; одноимённый гайд столкнётся с ним.
  const file = join(fixture.root, 'agent_docs/guides/agents.md')
  try {
    writeFileSync(file, '# Двойник\n\nТекст.\n')
    const graph = buildGraph(readSources(fixture.root))
    assert.ok(graph.findings.some((f) => /строится дважды/.test(f.message)))
    assert.equal(graph.nodes.filter((n) => n.id === 'guide/agents').length, 1)
  } finally {
    rmSync(file, { force: true })
  }
})

test('после отката правок копия снова чиста', () => {
  assert.deepEqual(findings(), [])
})
