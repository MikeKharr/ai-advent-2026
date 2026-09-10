import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  FOLD_FROM,
  addressOf,
  addressTable,
  count,
  cycleView,
  excerptRuns,
  foldExcerpt,
  indexGraph,
  maxTwoStep,
  neighborhood,
  parseMarkup,
  plural,
  relation,
  searchNodes,
  segments,
  shortName,
  statusChip,
  tableCells,
  traceCounter,
} from '../web/app.js'
import { ROOT } from './helpers.js'

// Витрина проверяется на собранном графе, а не на выдуманных данных: числа
// экрана обязаны совпадать с `graph.json`, иначе смысл проверки теряется.
const graph = JSON.parse(readFileSync(new URL('../dist/graph.json', import.meta.url), 'utf8'))
const fired = graph.edges.filter((e) => e.kind === 'fired')
const trace = (record, line) => fired.find((e) => e.to === `history/${record}` && e.line === line)

test('форма слова согласуется с числом', () => {
  assert.equal(count(1, 'след', 'следа', 'следов'), '1 след')
  assert.equal(count(2, 'след', 'следа', 'следов'), '2 следа')
  assert.equal(count(11, 'след', 'следа', 'следов'), '11 следов')
  assert.equal(count(21, 'след', 'следа', 'следов'), '21 след')
  assert.equal(count(0, 'след', 'следа', 'следов'), '0 следов')
  assert.equal(plural(1, 'записи', 'записях', 'записях'), 'записи')
  assert.equal(plural(8, 'записи', 'записях', 'записях'), 'записях')
  assert.equal(count(333, 'знак', 'знака', 'знаков'), '333 знака')
})

test('счётчик следов compliance читается из графа, а не из текста', () => {
  const mine = fired.filter((e) => e.from === 'role/compliance')
  assert.equal(traceCounter(mine), '11 следов по имени роли в 8 записях')
  assert.equal(traceCounter(fired.filter((e) => e.from === 'role/reviewer')), '2 следа по имени роли в 2 записях')
  assert.equal(traceCounter(fired.filter((e) => e.from === 'role/design')), '1 след по имени роли в 1 записи')
  assert.equal(traceCounter([]), '0 следов по имени роли')
})

test('счётчик не называет вывод: ни «вето», ни «находок», ни «сработал»', () => {
  const said = traceCounter(fired.filter((e) => e.from === 'role/compliance'))
  for (const banned of ['вето', 'находк', 'сработ', 'вынес']) assert.equal(said.includes(banned), false)
})

test('сегменты чтения: граница только при закрытых скобках и кавычках', () => {
  assert.deepEqual(segments('раз; два.').map((s) => s.end), [4, 9])
  // Точка внутри скобки границей не становится: карточка не может кончиться
  // незакрытой скобкой — это тот дефект, ради которого снят предел длины.
  assert.deepEqual(segments('начало (внутри. ещё) конец.').map((s) => s.end), [27])
  assert.deepEqual(segments('он сказал «стоп; иди» и ушёл; потом.').map((s) => s.end), [29, 36])
})

test('строка таблицы сегментом не делится и не сворачивается', () => {
  const row = trace('2026-09-13-1500', 43)
  assert.deepEqual(foldExcerpt(row.excerpt, row.marks), { end: row.excerpt.length, hidden: 0 })
})

test('свёртка срабатывает ровно один раз из четырнадцати', () => {
  const folded = fired.filter((e) => foldExcerpt(e.excerpt, e.marks).hidden > 0)
  assert.equal(fired.length, 14)
  assert.deepEqual(
    folded.map((e) => `${e.to.split('/')[1]}:${e.line}`),
    ['2026-09-07-2340:26', '2026-09-07-2340:26'],
  )
  // Одна запись, две роли: `compliance` и `reviewer` названы в одной фразе.
  assert.equal(new Set(folded.map((e) => e.to)).size, 1)
})

test('свёрнутая карточка кончается на `;`, скобки в ней закрыты, подсветка внутри', () => {
  const e = trace('2026-09-07-2340', 26)
  const { end, hidden } = foldExcerpt(e.excerpt, e.marks)
  const shown = e.excerpt.slice(0, end)
  assert.equal(shown.length, 240)
  assert.equal(hidden, 333)
  assert.equal(shown.endsWith(';'), true)
  assert.equal([...shown].filter((c) => c === '(').length, [...shown].filter((c) => c === ')').length)
  assert.ok(e.marks.unit[1] <= end, 'совпавший фрагмент целиком внутри показанного')
})

test('хвосты остальных следов короче порога — прятать нечего', () => {
  const tails = fired
    .filter((e) => !isFolded(e))
    .map((e) => tailOf(e))
    .filter((n) => n > 0)
  assert.deepEqual([...new Set(tails)].sort((a, b) => a - b), [25, 74])
  assert.ok(Math.max(...tails) < FOLD_FROM)
})

const isFolded = (e) => foldExcerpt(e.excerpt, e.marks).hidden > 0
function tailOf(e) {
  const segs = segments(e.excerpt)
  let last = -1
  for (let i = 0; i < segs.length; i += 1) if (segs[i].start < e.marks.unit[1] && segs[i].end > e.marks.unit[0]) last = i
  return e.excerpt.length - segs[last].end
}

test('подсветка: у следа design совпавший фрагмент в конце строки, чужие отрицания приглушены', () => {
  const e = trace('2026-09-11-1200', 51)
  assert.equal(e.from, 'role/design')
  const runs = excerptRuns(e.excerpt, 0, e.excerpt.length, e.marks)
  const text = (f) => runs.filter(f).map((r) => r.text).join('')
  assert.equal(text((r) => r.mut), 'Compliance — вето нет; reviewer — блокирующих нет; ')
  assert.equal(text((r) => !r.mut), 'design — «правки», три штуки.')
  assert.equal(text((r) => r.mark === 'role'), 'design')
  assert.equal(text((r) => r.mark === 'sign'), 'правки')
  // Подчёркнутое лежит внутри неприглушённого — иначе посетитель унёс бы с
  // витрины утверждение, обратное правде.
  assert.equal(runs.filter((r) => r.mark).every((r) => !r.mut), true)
})

test('подсветка совпадает с данными у всех четырнадцати следов', () => {
  for (const e of fired) {
    const runs = excerptRuns(e.excerpt, 0, e.excerpt.length, e.marks)
    const got = (mark) => runs.filter((r) => r.mark === mark).map((r) => r.text).join('')
    assert.equal(got('role').toLowerCase(), e.from.split('/')[1], `${e.to}:${e.line}`)
    assert.equal(got('sign'), e.excerpt.slice(...e.marks.sign), `${e.to}:${e.line}`)
  }
})

test('разметка разбирается последней: снятие `**` не сдвигает подсветку', () => {
  const e = trace('2026-09-13-1500', 43)
  const runs = excerptRuns(e.excerpt, 0, e.excerpt.length, e.marks)
  const strong = runs.filter((r) => r.strong).map((r) => r.text).join('')
  assert.equal(strong, 'Вето:')
  // Слово-признак лежит внутри `**Вето:**` — и остаётся признаком.
  assert.equal(runs.filter((r) => r.mark === 'sign').map((r) => r.text).join(''), 'Вето')
  assert.equal(runs.map((r) => r.text).join('').includes('*'), false)
})

test('разбирается ровно два вида парной разметки, непарный маркер — символ', () => {
  assert.equal(parseMarkup('**жирно** и `код`').map((c) => c.strong).filter(Boolean).length, 5)
  assert.equal(parseMarkup('**жирно** и `код`').map((c) => c.code).filter(Boolean).length, 3)
  const unpaired = parseMarkup('**Вето без пары')
  assert.equal(unpaired.map((c) => c.i).length, '**Вето без пары'.length)
  assert.equal(unpaired.some((c) => c.strong), false)
  assert.equal(parseMarkup('_курсив_ [ссылка](x)').some((c) => c.strong || c.code), false)
})

test('ячейки строки таблицы без символов `|`', () => {
  const e = trace('2026-09-13-1500', 43)
  const cells = tableCells(e.excerpt).map((c) => e.excerpt.slice(c.start, c.end).trim())
  assert.equal(cells.length, 3)
  assert.equal(cells[0], 'compliance')
  assert.equal(cells.join('').includes('|'), false)
})

test('адрес узла — идентификатор с `-` вместо `/`, обратно по таблице', () => {
  assert.equal(addressOf('adr/2026-09-13-1800'), 'adr-2026-09-13-1800')
  assert.equal(addressOf('invariant/I-4'), 'invariant-I-4')
  const table = addressTable(graph.nodes)
  assert.equal(table.size, graph.nodes.length)
  assert.equal(table.get('role-compliance'), 'role/compliance')
  assert.equal(table.get('design-2026-09-10-day6-monitor-layout'), 'design/2026-09-10-day6-monitor-layout')
  assert.equal(table.get('adr-2026-01-01-0000'), undefined)
})

test('короткое имя узла — не заголовок', () => {
  const of = (id) => shortName(graph.nodes.find((n) => n.id === id))
  assert.equal(of('adr/2026-09-13-1800'), 'ADR 13.09 18:00')
  assert.equal(of('history/2026-09-13-1500'), 'Запись 13.09 15:00')
  assert.equal(of('design/2026-09-12-0900-day7-chat-layout'), 'Дизайн 12.09 09:00')
  assert.equal(of('design/corpus'), 'corpus')
  assert.equal(of('invariant/I-4'), 'I-4')
  assert.equal(of('role/compliance'), 'compliance')
  assert.equal(of('class/A'), 'Класс A')
  assert.equal(of('tier/fable-high'), 'fable / high')
  assert.equal(of('phase/06'), '6. Ревью по классу')
  assert.equal(of('skill/browser-testing-with-devtools'), 'browser-testing-with-dev…')
  for (const n of graph.nodes) assert.ok(shortName(n).length <= 25, `${n.id}: ${shortName(n)}`)
})

test('чип статуса — по первому слову; длинная строка статуса не подменяется чипом', () => {
  assert.equal(statusChip('Принято'), 'Принято')
  assert.equal(statusChip('Принято.'), 'Принято')
  assert.equal(statusChip('Заменяет ADR 2026-09-07-1535'), 'Принято, заменяет')
  assert.equal(statusChip('Предложено'), 'Предложено')
  assert.equal(statusChip('Отклонено'), 'Отклонено')
  assert.equal(statusChip('Заменено решением 2026-09-07-1700'), 'Заменено')
  assert.equal(statusChip('Обсуждается'), 'Статус не разобран')
  assert.equal(statusChip(undefined), 'Статус не разобран')
  const chips = graph.nodes.filter((n) => n.type === 'adr').map((n) => statusChip(n.status))
  assert.equal(chips.includes('Статус не разобран'), false)
})

test('вид отношения называет отношение, а не вывод', () => {
  assert.equal(relation('cites', true), 'цитирует')
  assert.equal(relation('cites', false), 'процитирован в')
  assert.equal(relation('replaces', false), 'заменён решением')
  const kinds = new Set(graph.edges.map((e) => e.kind))
  kinds.delete('fired')
  for (const k of kinds) {
    assert.notEqual(relation(k, true), k, `нет слова для ребра ${k}`)
    assert.notEqual(relation(k, false), k, `нет слова для ребра ${k}`)
  }
})

test('окрестность: один шаг читаем, два — почти весь граф', () => {
  const { near } = indexGraph(graph)
  assert.equal(neighborhood(near, 'role/compliance', 0).size, 1)
  assert.equal(neighborhood(near, 'role/compliance', 1).size, 31)
  assert.ok(neighborhood(near, 'role/compliance', 2).size > 60)
  assert.equal(maxTwoStep(near), 111)
})

test('след — такая же связь: на канве он есть, в панели показан иначе', () => {
  const { near } = indexGraph(graph)
  assert.equal(near.get('role/design').has('history/2026-09-11-1200'), true)
  // Кратные рёбра между одной парой сводятся к одной связи.
  const doubled = fired.filter((e) => e.from === 'role/compliance' && e.to === 'history/2026-09-13-1500')
  assert.equal(doubled.length, 2)
  assert.equal([...near.get('role/compliance')].filter((id) => id === 'history/2026-09-13-1500').length, 1)
})

test('узлы без рёбер видны как узлы без рёбер', () => {
  const { near } = indexGraph(graph)
  const alone = graph.nodes.filter((n) => near.get(n.id).size === 0)
  assert.equal(alone.length, 24)
  assert.equal(neighborhood(near, alone[0].id, 1).size, 1)
})

test('поиск идёт по заголовкам и коротким именам, не по тексту документов', () => {
  const { hits, total } = searchNodes(graph.nodes, 'COMPLI', 12)
  assert.ok(hits.some((n) => n.id === 'role/compliance'))
  assert.equal(total >= hits.length, true)
  assert.ok(searchNodes(graph.nodes, 'адр', 12).total >= 0)
  assert.deepEqual(searchNodes(graph.nodes, '   ', 12), { hits: [], total: 0 })
  // Слово из тела документа, которого нет ни в одном заголовке.
  assert.equal(searchNodes(graph.nodes, 'непривязывающим', 12).total, 0)
  const many = searchNodes(graph.nodes, '2026', 12)
  assert.equal(many.hits.length, 12)
  assert.ok(many.total > 12)
})

test('стартовый вид — цепь фаз с ролями, а не клубок', () => {
  const view = cycleView(graph, true)
  assert.equal(view.ids.size, 25)
  const types = {}
  for (const id of view.ids) types[id.split('/')[0]] = (types[id.split('/')[0]] ?? 0) + 1
  assert.deepEqual(types, { phase: 10, role: 12, class: 3 })
  assert.ok(view.ids.size < graph.nodes.length / 4)
  // Девять связок «фаза → следующая фаза» страница рисует сама: в графе их нет.
  assert.equal(view.edges.filter((e) => e.kind === 'next').length, 9)
  assert.equal(graph.edges.some((e) => e.kind === 'next'), false)
  assert.equal(view.place.size, 25)
  assert.deepEqual(view.place.get('phase/01'), { x: 0, y: 0 })
  assert.equal(view.place.get('phase/10').x, 9)
  // Узел стоит в одном месте, даже если его ведут две фазы.
  assert.equal(view.place.get('role/reviewer').x, view.place.get('phase/06').x)
})

test('на узком экране цепь идёт сверху вниз', () => {
  const down = cycleView(graph, false)
  assert.deepEqual(down.place.get('phase/01'), { x: 0, y: 0 })
  assert.equal(down.place.get('phase/10').y, 9)
  assert.equal(down.place.get('phase/10').x, 0)
})

test('в графе есть коммит сборки и файлы для ссылок на GitHub', () => {
  assert.ok(ROOT.endsWith('/'))
  for (const n of graph.nodes.filter((x) => ['adr', 'history', 'design', 'guide'].includes(x.type))) {
    assert.ok(n.file && !n.file.startsWith('/'), `${n.id}: путь для ссылки на GitHub`)
  }
})
