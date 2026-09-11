import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { LIMITS, run, sizeFindings } from '../build.js'
import { HIDDEN, buildTexts, plainText, redact } from '../lib/texts.js'
import { makeFixture } from './helpers.js'

// Контракт `texts.json` — ADR 2026-09-14-2330, раздел 3: объект «узел →
// текст» в порядке узлов графа, разметка снята, образцы секретов скрыты,
// потолок размера падает закрыто.

// Образцы собираются из кусков, как в secrets.test.js: файл теста не должен
// выглядеть утечкой для docs-guard, который ищет `sk-ant-…` в репозитории.
const ANT = ['sk', 'ant', ''].join('-')
const GSK = `gs${'k'}_`
const SSH = ['BEGIN', 'OPENSSH'].join(' ')
const TAILNET = ['100', '101', '42', '7'].join('.')

// Те же четыре образца, что проверяет страж витрины.
const GUARD = [new RegExp(ANT), /gsk_/, /BEGIN OPENSSH/, /\b100\.\d+\.\d+\.\d+\b/]

test('фронтматтер снят, заголовок остаётся словами', () => {
  const md = '---\nname: qa\ndescription: Тесты.\n---\n# Роль QA\n\nТекст роли.\n'
  assert.equal(plainText(md), 'Роль QA Текст роли.')
})

test('решётки заголовков, жирный и обратные кавычки сняты', () => {
  assert.equal(plainText('## Раздел\n\n**Жирное** и `код` рядом.'), 'Раздел Жирное и код рядом.')
})

test('ссылка остаётся текстом без адреса', () => {
  assert.equal(plainText('См. [раскладку](https://example.com/a.md) и ![схема](x.png).'), 'См. раскладку и схема.')
})

test('таблица: разделители колонок и строка-разделитель сняты', () => {
  const md = '| Что | Значение |\n|---|---:|\n| Место | `dist/site` |\n| Знак | a \\| b |\n'
  assert.equal(plainText(md), 'Что Значение Место dist/site Знак a b')
})

test('пробельные символы схлопнуты в один пробел', () => {
  assert.equal(plainText('\n\nодин\n\n\tдва   три\n'), 'один два три')
})

test('каждый образец стража заменён на «[скрыто]» и посчитан', () => {
  const text = `ключ ${ANT}api03-abcdefghijklmno, ключ ${GSK}abcdef, ${SSH} PRIVATE KEY, адрес ${TAILNET}.`
  const { text: out, hidden } = redact(text)

  assert.equal(hidden, 4)
  assert.equal(out, `ключ ${HIDDEN}, ключ ${HIDDEN}, ${HIDDEN} PRIVATE KEY, адрес ${HIDDEN}.`)
  for (const re of GUARD) assert.equal(re.test(out), false, `образец ${re} остался`)
})

test('числа, не похожие на адрес tailnet, не скрываются', () => {
  const text = 'цена 100.5, версия 100.2.3, строка 1100.1.1.1'
  assert.deepEqual(redact(text), { text, hidden: 0 })
})

test('разметка между кусками образца не спасает его от скрытия', () => {
  // Скрытие идёт после обработки: снятые кавычки склеивают адрес.
  const { texts } = buildTexts(
    { nodes: [{ id: 'guide/net', type: 'guide', file: 'agent_docs/guides/net.md' }] },
    { guides: [{ path: 'agent_docs/guides/net.md', text: 'адрес `100`.`64`.1.1' }] },
  )
  assert.equal(texts['guide/net'], `адрес ${HIDDEN}`)
})

test('набор: документы, роли и свои скиллы; без вендорных скиллов, compose.yml и инвариантов', () => {
  const graph = {
    nodes: [
      { id: 'guide/dod', type: 'guide', file: 'agent_docs/guides/dod.md' },
      { id: 'adr/2026-01-01-0000', type: 'adr', file: 'agent_docs/adr/2026-01-01-0000-a.md' },
      { id: 'volume/data', type: 'volume', file: 'deploy/compose.yml' },
      { id: 'service/router', type: 'service', file: 'deploy/compose.yml' },
      { id: 'service/site', type: 'service', file: 'site/index.html' },
      { id: 'invariant/I-1', type: 'invariant', file: 'agent_docs/invariants.md' },
      { id: 'skill/vendor', type: 'skill', file: '.agents/skills/vendor/SKILL.md', vendored: true },
      { id: 'skill/own', type: 'skill', file: '.agents/skills/own/SKILL.md', vendored: false },
      { id: 'role/qa', type: 'role', file: '.claude/agents/qa.md' },
      { id: 'history/2026-01-02-0000', type: 'history', file: 'agent_docs/development-history/2026-01-02-0000-h.md' },
      { id: 'design/layout', type: 'design', file: 'agent_docs/design/layout.md' },
      { id: 'phase/01', type: 'phase' },
    ],
  }
  const sources = {
    adr: [{ path: 'agent_docs/adr/2026-01-01-0000-a.md', text: '# ADR' }],
    history: [{ path: 'agent_docs/development-history/2026-01-02-0000-h.md', text: '# Запись' }],
    design: [{ path: 'agent_docs/design/layout.md', text: '# Раскладка' }],
    guides: [{ path: 'agent_docs/guides/dod.md', text: '# DoD' }],
    roles: [{ path: '.claude/agents/qa.md', text: '# QA' }],
    skills: [
      { path: '.agents/skills/vendor/SKILL.md', text: '# Чужой' },
      { path: '.agents/skills/own/SKILL.md', text: '# Свой' },
    ],
  }

  const { texts } = buildTexts(graph, sources)

  assert.deepEqual(Object.keys(texts), [
    'guide/dod',
    'adr/2026-01-01-0000',
    'skill/own',
    'role/qa',
    'history/2026-01-02-0000',
    'design/layout',
  ])
  assert.equal(texts['skill/own'], 'Свой')
})

test('скрытые места посчитаны по узлам', () => {
  const graph = {
    nodes: [
      { id: 'guide/a', type: 'guide', file: 'agent_docs/guides/a.md' },
      { id: 'guide/b', type: 'guide', file: 'agent_docs/guides/b.md' },
    ],
  }
  const sources = {
    guides: [
      { path: 'agent_docs/guides/a.md', text: `${TAILNET} и ${TAILNET}` },
      { path: 'agent_docs/guides/b.md', text: 'чисто' },
    ],
  }
  assert.deepEqual(buildTexts(graph, sources).hidden, { 'guide/a': 2 })
})

// --- потолки: синтетические размеры, живой граф не нужен ----------------------

test('потолки в байтах: КБ — 1024 байта', () => {
  assert.equal(LIMITS.texts, 3072 * 1024)
  assert.equal(LIMITS.graph, 1024 * 1024)
  assert.equal(LIMITS.page, 256 * 1024)
})

test('ровно на потолке — не находка', () => {
  assert.deepEqual(sizeFindings({ texts: LIMITS.texts, graph: LIMITS.graph, page: LIMITS.page }), [])
})

test('texts.json на байт больше потолка — находка с размером и потолком', () => {
  const found = sizeFindings({ texts: LIMITS.texts + 1, graph: 0, page: 0 })
  assert.equal(found.length, 1)
  assert.match(found[0].message, /texts\.json/)
  assert.match(found[0].message, /потол/)
  assert.match(found[0].message, /3072 КБ/)
})

test('graph.json на байт больше потолка — находка', () => {
  const found = sizeFindings({ texts: 0, graph: LIMITS.graph + 1, page: 0 })
  assert.equal(found.length, 1)
  assert.match(found[0].message, /graph\.json/)
})

test('код страницы на байт больше потолка — находка с именами файлов', () => {
  const found = sizeFindings({ texts: 0, graph: 0, page: LIMITS.page + 1 })
  assert.equal(found.length, 1)
  assert.match(found[0].message, /app\.js/)
  assert.match(found[0].message, /256 КБ/)
})

// --- сборка на копии репозитория -----------------------------------------------

const fixture = makeFixture()
after(() => fixture.cleanup())
const out = join(fixture.root, 'atlas/dist/graph.json')

test('сборка пишет texts.json рядом с graph.json: ключи — узлы графа в их порядке', () => {
  const result = run({ root: fixture.root, out })
  assert.deepEqual(result.findings, [])

  const texts = JSON.parse(readFileSync(join(result.siteDir, 'texts.json'), 'utf8'))
  const ids = Object.keys(texts)
  const order = result.nodes.map((n) => n.id).filter((id) => id in texts)
  assert.deepEqual(ids, order)

  const types = new Set(ids.map((id) => id.slice(0, id.indexOf('/'))))
  assert.deepEqual([...types].sort(), ['adr', 'design', 'guide', 'history', 'role', 'skill'])

  const vendored = result.nodes.filter((n) => n.vendored).map((n) => n.id)
  assert.ok(vendored.length > 0)
  for (const id of vendored) assert.equal(id in texts, false, `вендорный скилл ${id} в texts.json`)
  for (const id of ['guide/agents', 'guide/glossary', 'guide/index', 'guide/architecture', 'skill/day-cycle', 'role/compliance']) {
    assert.equal(typeof texts[id], 'string', `нет текста ${id}`)
  }
})

test('адрес tailnet в записи истории скрыт в texts.json', () => {
  const result = run({ root: fixture.root, out })
  const texts = JSON.parse(readFileSync(join(result.siteDir, 'texts.json'), 'utf8'))
  assert.ok(texts['history/2026-09-09-2400'].includes(HIDDEN))
})

test('две сборки одного дерева дают texts.json байт-в-байт', () => {
  const first = readFileSync(join(run({ root: fixture.root, out }).siteDir, 'texts.json'))
  const second = readFileSync(join(run({ root: fixture.root, out }).siteDir, 'texts.json'))
  assert.equal(Buffer.compare(first, second), 0)
})

test('texts.json выше потолка — находка, и витрина не записана (не усечена)', () => {
  const big = makeFixture()
  try {
    // Больше потолка одним документом: абзацы, чтобы выдержка графа не росла.
    const para = 'Слово за словом без ссылок и цитат. '.repeat(30)
    const huge = `# Большой гайд\n\n${`${para}\n\n`.repeat(Math.ceil(LIMITS.texts / para.length) + 10)}`
    writeFileSync(join(big.root, 'agent_docs/guides/huge.md'), huge)

    const result = run({ root: big.root, out: join(big.root, 'atlas/dist/graph.json') })

    assert.equal(result.findings.length, 1)
    assert.match(result.findings[0].message, /texts\.json/)
    assert.equal(existsSync(join(result.siteDir, 'texts.json')), false)
    assert.equal(existsSync(join(result.siteDir, 'graph.json')), false)
  } finally {
    big.cleanup()
  }
})

test('--check ловит превышение потолка так же, как сборка', () => {
  const big = makeFixture()
  try {
    const para = 'Слово за словом без ссылок и цитат. '.repeat(30)
    const huge = `# Большой гайд\n\n${`${para}\n\n`.repeat(Math.ceil(LIMITS.texts / para.length) + 10)}`
    writeFileSync(join(big.root, 'agent_docs/guides/huge.md'), huge)

    const result = run({ root: big.root, check: true, out: join(big.root, 'atlas/dist/graph.json') })

    assert.equal(result.findings.length, 1)
    assert.match(result.findings[0].message, /texts\.json/)
  } finally {
    big.cleanup()
  }
})
