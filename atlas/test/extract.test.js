import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseCompose } from '../lib/compose.js'
import { atomicId } from '../lib/markdown.js'
import { buildGraph } from '../lib/extract.js'
import { layout } from '../lib/layout.js'
import { readSources } from '../lib/sources.js'
import { ROOT, density } from './helpers.js'

const graph = buildGraph(readSources(ROOT))
const of = (type) => graph.nodes.filter((n) => n.type === type)
const edges = (kind) => graph.edges.filter((e) => e.kind === kind)
const ids = new Set(graph.nodes.map((n) => n.id))

/** Размеры проекта считаются по файлам, а не задаются константами: тесты —
 *  шаг обязательной проверки, и равенство здесь красит чужой PR, где день,
 *  инвариант или маршрут просто добавили. Константами остаётся лишь то, что
 *  не растёт по плану: классы гейтов и фазы цикла. */
const countMd = (dir) => readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.md') && f !== 'README.md').length
const src = readSources(ROOT)
const dayDirs = readdirSync(join(ROOT, 'days')).filter((d) => /^day\d+$/.test(d))
const invariantsInFile = src.invariants.split('\n').filter((l) => /^- \*\*I-\d+\.\*\*/.test(l)).length
// Строки-комментарии Caddyfile упоминают handle_path в пояснении — маршрут
// считается только по действующим строкам.
/** Строки текста, подошедшие под условие, вместе с их номерами. */
const linesMatching = (text, ok) =>
  text
    .split('\n')
    .map((line, i) => ({ line: i + 1, text: line }))
    .filter((l) => ok(l.text))

const routesInCaddy = src.caddyText
  .split('\n')
  .filter((l) => !/^\s*#/.test(l) && /reverse_proxy \S+:\d+/.test(l)).length

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
  assert.equal(of('invariant').length, invariantsInFile, 'каждый пункт invariants.md — узел')
  assert.equal(of('class').length, 3, 'классы гейтов A/B/C')
  assert.equal(of('phase').length, 10, 'десять фаз /day-cycle')
  assert.equal(of('day').length, dayDirs.length)
  assert.equal(of('volume').length, parseCompose(src.composeText).volumes.length)
  const services = parseCompose(src.composeText).services.filter((s) => !/^day\d+$/.test(s.name))
  assert.equal(of('service').length, services.length + 1, 'сервисы compose, кроме дней, и лендинг site')
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
  assert.equal(edges('routes').length, routesInCaddy)
  const toDays = edges('routes').filter((e) => e.to.startsWith('day/'))
  assert.equal(toDays.length, dayDirs.length, 'у каждого дня — маршрут в Caddyfile')
  for (const e of toDays) assert.equal(e.from, 'service/caddy')
  assert.ok(edges('serves').some((e) => e.from === 'service/caddy' && e.to === 'service/site'))
  assert.ok(edges('depends').some((e) => e.from === 'day/day5' && e.to === 'service/router'))
  assert.ok(edges('mounts').some((e) => e.from === 'service/agents' && e.to === 'volume/agents_data'))
})

test('маршрут не-дневного сервиса: handle_path /atlas/* даёт ребро caddy → service/atlas', () => {
  assert.ok(edges('routes').some((e) => e.from === 'service/caddy' && e.to === 'service/atlas'))
})

test('провайдеры попадают в граф без baseUrl: адрес tailnet не публикуется', () => {
  const json = JSON.stringify(graph)
  assert.equal(json.includes('baseUrl'), false)
  for (const p of src.providers) {
    assert.equal(json.includes(p.baseUrl), false, `в графе адрес провайдера ${p.id}`)
    assert.ok(ids.has(`external/${p.id}`))
  }
  assert.ok(edges('calls').some((e) => e.from === 'service/router' && e.to === 'external/anthropic-haiku'))
})

test('конвейер образов: image к GHCR и publishes от Actions', () => {
  const withImage = src.composeText
    .split('\n')
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

test('корневые документы — цели цитат в обеих формах', () => {
  for (const key of ['architecture', 'index', 'glossary', 'agents']) {
    assert.ok(
      edges('cites').some((e) => e.to === `guide/${key}`),
      `у guide/${key} нет входящих цитат — ссылки на него оказались вне гейта`,
    )
  }
})

test('исключение overlay перебивает номер дня из имени файла', () => {
  const about = edges('about').filter((e) => e.from === 'history/2026-09-08-1345')
  assert.deepEqual(
    about.map((e) => e.to),
    ['day/day4'],
    'запись о переименовании дня 3 в день 4 не должна висеть на нынешнем дне 3',
  )
})

test('каждый узел несёт координаты в единичном квадрате', () => {
  for (const node of graph.nodes) {
    for (const v of [node.x, node.y]) {
      assert.equal(typeof v, 'number', node.id)
      assert.ok(v >= 0 && v <= 1, `${node.id}: ${v}`)
      assert.ok((String(v).split('.')[1] ?? '').length <= 6, `${node.id}: ${v}`)
    }
  }
  // Меряется заполненность, а не габаритная рамка: рамка была здоровой ровно
  // тогда, когда 150 узлов сидели в 2.7 % площади, а натягивала её пара из
  // двух узлов в противоположном углу (находка Б6 ревью этапа 3). Что именно
  // считается ячейкой — записано словами в `density` (test/helpers.js): три
  // независимых замера этапа 3 разошлись из-за разной нормировки сетки.
  const { busy, filled, median } = density(graph.nodes)
  assert.ok(filled >= 0.5, `в своей ячейке сетки 20×20 ${busy} узлов из ${graph.nodes.length}`)
  assert.ok(median >= 0.02, `медиана расстояния до ближайшего соседа ${median.toFixed(4)}`)

  assert.equal(new Set(graph.nodes.map((n) => `${n.x},${n.y}`)).size, graph.nodes.length)
})

test('каждый узел несёт z в 0…1, а x и y — ровно те, что даёт плоская раскладка', () => {
  // ADR 2026-09-14-1000, п. 2: z добавляется, x и y не меняются.
  const plane = layout(graph.nodes, graph.edges)
  const linked = new Set(graph.edges.flatMap((e) => (e.from === e.to ? [] : [e.from, e.to])))
  for (const node of graph.nodes) {
    assert.deepEqual({ x: node.x, y: node.y }, plane.get(node.id), node.id)
    assert.equal(typeof node.z, 'number', node.id)
    assert.ok(node.z >= 0 && node.z <= 1, `${node.id}: ${node.z}`)
    assert.ok((String(node.z).split('.')[1] ?? '').length <= 6, `${node.id}: ${node.z}`)
    if (!linked.has(node.id)) assert.equal(node.z, 0.5, `${node.id} без рёбер вне плоскости 0.5`)
  }
  // z стоит перед x, y закрывает узел: строка y не получает запятую, и diff
  // graph.json до и после — только добавленные строки "z".
  for (const node of graph.nodes) assert.deepEqual(Object.keys(node).slice(-3), ['z', 'x', 'y'], node.id)
})

test('у каждого следа есть marks, и срезы по ним — роль и признак', () => {
  const fired = edges('fired')
  assert.ok(fired.length > 0)
  for (const e of fired) {
    const role = e.from.slice(e.from.indexOf('/') + 1)
    assert.ok(e.marks, `${e.to}:${e.line} без marks`)
    const { unit, role: r, sign } = e.marks
    assert.equal(e.excerpt.slice(...r).toLowerCase(), role, `${e.to}:${e.line}`)
    assert.match(e.excerpt.slice(...sign), /^(?:вето|блокирующ|находк|правки|переделать)/i)
    for (const inner of [r, sign]) {
      assert.ok(inner[0] >= unit[0] && inner[1] <= unit[1], `${e.to}:${e.line}: ${JSON.stringify(inner)} вне ${JSON.stringify(unit)}`)
    }
    assert.ok(unit[1] <= e.excerpt.length, `${e.to}:${e.line}: единица вне выдержки`)
  }
})

test('«правило → где сработало»: след несёт строку и выдержку', () => {
  const fired = edges('fired')
  assert.ok(fired.length > 0)
  for (const e of fired) {
    assert.ok(e.to.startsWith('history/'), e.to)
    assert.ok(Number.isInteger(e.line) && e.line > 0)
    assert.ok(e.excerpt.length > 0)
    assert.equal(e.excerpt.endsWith('…'), false, `предел длины у следа снят: ${e.excerpt}`)
  }
})

test('следы compliance на репозитории: строка таблицы — единица, отрицание — не след', () => {
  // Числа растут с каждой новой записью истории, поэтому проверяются «не
  // меньше» и поимённо — те случаи, на которых правило ломалось до ревью.
  // Якорь — текст строки, а не её номер: переформатирование записи не должно
  // красить обязательную проверку.
  const mine = edges('fired').filter((e) => e.from === 'role/compliance')
  const records = new Set(mine.map((e) => e.to))
  assert.ok(mine.length >= 11, `следов ${mine.length}, ожидалось не меньше 11`)
  assert.ok(records.size >= 8, `записей ${records.size}, ожидалось не меньше 8`)

  // Две строки таблицы одной записи — два следа: дедупликации по паре
  // «роль → документ» нет.
  const table = src.history.find((h) => h.key.startsWith('2026-09-13-1500'))
  const rows = linesMatching(table.text, (l) => l.startsWith('| compliance |') && /Вето/.test(l))
  assert.equal(rows.length, 2, 'в записи изменилась таблица вето — проверьте якорь теста')
  assert.deepEqual(
    mine.filter((e) => e.to === `history/${atomicId(table.key)}`).map((e) => e.line),
    rows.map((r) => r.line),
  )

  // «вето нет» и «блокирующих нет» следа не дают.
  for (const prefix of ['2026-09-10-1700', '2026-09-11-1200']) {
    const record = src.history.find((h) => h.key.startsWith(prefix))
    const denials = linesMatching(record.text, (l) => /вето нет/i.test(l))
    assert.ok(denials.length > 0, `в ${prefix} пропала строка с «вето нет» — проверьте якорь теста`)
    for (const d of denials) {
      assert.equal(
        edges('fired').some((e) => e.to === `history/${prefix}` && e.line === d.line),
        false,
        `${prefix}:${d.line} — отрицание, следа быть не должно`,
      )
    }
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
