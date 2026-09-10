import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildGraph } from '../lib/extract.js'
import { readSources } from '../lib/sources.js'
import { ROOT } from './helpers.js'

const graph = buildGraph(readSources(ROOT))
const of = (type) => graph.nodes.filter((n) => n.type === type)
const edges = (kind) => graph.edges.filter((e) => e.kind === kind)
const ids = new Set(graph.nodes.map((n) => n.id))

/** Число документов считается по каталогу, а не задаётся константой:
 *  ADR, записей истории и спецификаций становится больше каждую неделю. */
const countMd = (dir) => readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.md') && f !== 'README.md').length

test('на базовом состоянии репозитория находок нет', () => {
  assert.deepEqual(graph.findings, [])
})

test('число документов в графе равно числу файлов на диске', () => {
  assert.equal(of('adr').length, countMd('agent_docs/adr'))
  assert.equal(of('history').length, countMd('agent_docs/development-history'))
  assert.equal(of('design').length, countMd('agent_docs/design'))
  // Гайды: agent_docs/guides/*.md плюс architecture, index, glossary, AGENTS.
  assert.equal(of('guide').length, countMd('agent_docs/guides') + 4)
  const skills = readdirSync(join(ROOT, '.agents/skills')).filter((d) =>
    existsSync(join(ROOT, '.agents/skills', d, 'SKILL.md')),
  )
  assert.equal(of('skill').length, skills.length)
})

test('структурные числа: они заданы устройством проекта, а не ростом документов', () => {
  assert.equal(of('role').length, 12, '12 ролей — ADR 2026-09-07-1515')
  assert.equal(of('invariant').length, 12, 'I-1…I-12')
  assert.equal(of('class').length, 3, 'классы гейтов A/B/C')
  assert.equal(of('phase').length, 10, 'десять фаз /day-cycle')
  assert.equal(of('day').length, 8)
  assert.equal(of('volume').length, 5)
  assert.equal(of('service').length, 4, 'router, agents, caddy и лендинг site')
  const src = readSources(ROOT)
  assert.equal(of('external').length, src.providers.length + src.overlay.externals.length)
  assert.equal(
    of('external').some((n) => n.key === 'google-drive'),
    false,
    'Drive — не то, с чем обменивается работающая система; он есть в графе как ADR и гайд',
  )
  assert.equal(of('tier').length, 4, 'fable/high и opus в трёх усилиях')
})

test('каждое ребро упирается в существующий узел', () => {
  const dangling = graph.edges.filter((e) => !ids.has(e.from) || !ids.has(e.to))
  assert.deepEqual(dangling, [])
})

test('у дня есть название с лендинга, маршрут и каталог', () => {
  for (const day of of('day')) {
    assert.ok(day.title !== day.key, `у ${day.key} нет названия с лендинга`)
    assert.equal(day.route, `/${day.key}/`)
    assert.ok(existsSync(join(ROOT, day.dir)), `нет каталога ${day.dir}`)
  }
})

test('у каждой роли ровно один ярус, и ярус собран из model и effort', () => {
  assert.equal(edges('tier').length, of('role').length)
  const architect = graph.nodes.find((n) => n.id === 'role/architect')
  assert.equal(architect.model, 'fable')
  assert.equal(architect.effort, 'high')
  assert.ok(edges('tier').some((e) => e.from === 'role/architect' && e.to === 'tier/fable-high'))
})

test('предзагруженные скиллы роли ведут на существующие скиллы', () => {
  for (const e of edges('preloads')) assert.ok(ids.has(e.to), e.to)
  assert.ok(edges('preloads').some((e) => e.from === 'role/backend' && e.to === 'skill/test-driven-development'))
})

test('топология деплоя: маршруты, зависимости и тома', () => {
  assert.equal(edges('routes').length, 8)
  assert.ok(edges('serves').some((e) => e.from === 'service/caddy' && e.to === 'service/site'))
  assert.ok(edges('depends').some((e) => e.from === 'day/day5' && e.to === 'service/router'))
  assert.ok(edges('mounts').some((e) => e.from === 'service/agents' && e.to === 'volume/agents_data'))
})

test('провайдеры попадают в граф без baseUrl: адрес tailnet не публикуется', () => {
  const json = JSON.stringify(graph)
  assert.equal(json.includes('baseUrl'), false)
  for (const p of readSources(ROOT).providers) {
    assert.equal(json.includes(p.baseUrl), false, `в графе адрес провайдера ${p.id}`)
    assert.ok(ids.has(`external/${p.id}`))
  }
  assert.ok(edges('calls').some((e) => e.from === 'service/router' && e.to === 'external/anthropic-haiku'))
})

test('конвейер образов: image к GHCR и publishes от Actions', () => {
  const withImage = readSources(ROOT)
    .composeText.split('\n')
    .filter((l) => /^ {4}image: ghcr\.io\//.test(l)).length
  assert.equal(edges('image').length, withImage)
  for (const e of edges('image')) assert.equal(e.to, 'external/ghcr')
  assert.equal(
    edges('image').some((e) => e.from === 'service/caddy'),
    false,
    'caddy идёт из публичного образа, не из GHCR',
  )
  assert.deepEqual(edges('publishes'), [{ from: 'external/github-actions', to: 'external/ghcr', kind: 'publishes' }])
})

test('внешних узлов без единого ребра нет', () => {
  for (const n of of('external')) {
    assert.ok(
      graph.edges.some((e) => e.from === n.id || e.to === n.id),
      `${n.id} висит без рёбер`,
    )
  }
})

test('дни 1–4 ходят в Anthropic напрямую — это записано в overlay', () => {
  for (const n of [1, 2, 3, 4]) {
    assert.ok(edges('calls').some((e) => e.from === `day/day${n}` && e.to === 'external/anthropic-api'))
  }
})

test('цитаты, замены и опоры на инварианты становятся рёбрами', () => {
  assert.ok(edges('cites').some((e) => e.from === 'adr/2026-09-13-2000' && e.to === 'adr/2026-09-13-1800'))
  assert.ok(edges('replaces').some((e) => e.from === 'adr/2026-09-07-1700' && e.to === 'adr/2026-09-07-1535'))
  assert.ok(edges('relies').some((e) => e.to === 'invariant/I-4'))
  assert.ok(edges('mentions').some((e) => e.from === 'guide/agents' && e.to === 'role/compliance'))
})

test('исключение overlay перебивает номер дня из имени файла', () => {
  const about = edges('about').filter((e) => e.from === 'history/2026-09-08-1345')
  assert.deepEqual(
    about.map((e) => e.to),
    ['day/day4'],
    'запись о переименовании дня 3 в день 4 не должна висеть на нынешнем дне 3',
  )
})

test('«правило → где сработало»: след несёт строку и выдержку', () => {
  const fired = edges('fired')
  assert.ok(fired.length > 0)
  for (const e of fired) {
    assert.ok(e.to.startsWith('history/'), e.to)
    assert.ok(Number.isInteger(e.line) && e.line > 0)
    assert.ok(e.excerpt.length > 0 && e.excerpt.length <= 161, e.excerpt)
  }
})

test('следы compliance на репозитории: строка таблицы — единица, отрицание — не след', () => {
  // Числа растут с каждой новой записью истории, поэтому проверяются «не
  // меньше» и поимённо — те случаи, на которых правило ломалось до ревью.
  const mine = edges('fired').filter((e) => e.from === 'role/compliance')
  const records = new Set(mine.map((e) => e.to))
  assert.ok(mine.length >= 11, `следов ${mine.length}, ожидалось не меньше 11`)
  assert.ok(records.size >= 8, `записей ${records.size}, ожидалось не меньше 8`)

  // Две строки таблицы одной записи — два следа: дедупликации по паре
  // «роль → документ» нет.
  const table = mine.filter((e) => e.to === 'history/2026-09-13-1500').map((e) => e.line)
  assert.deepEqual(table, [43, 44])

  // «вето нет» и «блокирующих нет» следа не дают.
  for (const [id, line] of [
    ['history/2026-09-10-1700', 88],
    ['history/2026-09-11-1200', 50],
  ]) {
    assert.equal(
      edges('fired').some((e) => e.to === id && e.line === line),
      false,
      `${id}:${line} — отрицание, следа быть не должно`,
    )
  }

  assert.ok(edges('fired').filter((e) => e.from === 'role/reviewer').length >= 2)
  assert.ok(edges('fired').filter((e) => e.from === 'role/design').length >= 1)
})

test('у ADR есть статус, у документов — выдержка и путь к файлу', () => {
  const adr = graph.nodes.find((n) => n.id === 'adr/2026-09-13-2000')
  assert.match(adr.status, /^Принято/)
  assert.equal(adr.file, 'agent_docs/adr/2026-09-13-2000-project-atlas.md')
  assert.ok(adr.excerpt.length > 0)
  assert.ok(existsSync(join(ROOT, adr.file)))
})
