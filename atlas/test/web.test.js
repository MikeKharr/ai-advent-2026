import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildGraph } from '../lib/extract.js'
import { readSources } from '../lib/sources.js'
import {
  FOLD_FROM,
  SLOTS,
  TYPE_NAME,
  dedupe,
  factsOf,
  statsOf,
  viewLine,
  addressOf,
  addressTable,
  count,
  cycleView,
  excerptRuns,
  fit,
  foldExcerpt,
  indexGraph,
  maxTwoStep,
  neighborhood,
  parseMarkup,
  placeLabels,
  plainTitle,
  plural,
  relation,
  searchNodes,
  segments,
  shortName,
  statusChip,
  tableCells,
  traceCounter,
  transform,
} from '../web/app.js'
import { ROOT } from './helpers.js'

// Граф строится здесь же, а не читается из `dist/`: каталог в .gitignore, на
// чистом чекауте его нет, а тесты — шаг обязательной проверки `guard`.
const graph = buildGraph(readSources(ROOT))
const index = indexGraph(graph)
const fired = graph.edges.filter((e) => e.kind === 'fired')
const byId = new Map(graph.nodes.map((n) => [n.id, n]))
const of = (type) => graph.nodes.filter((n) => n.type === type)
const trace = (record, line) => fired.find((e) => e.to === `history/${record}` && e.line === line)

// Ожидания выводятся из графа. Равенство с числом репозитория покрасило бы
// чужой PR, где просто добавили запись истории или ADR: гейт ссылок такой PR
// пропускает, и тест обязан пропустить тоже. Точные значения проверяются на
// рукотворных выдержках ниже — они принадлежат тесту и никем не меняются.

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

test('счётчик следов собирается из рёбер, а не из текста', () => {
  const made = (n, m) =>
    traceCounter(Array.from({ length: n }, (_, i) => ({ to: `history/rec-${i % m}` })))
  assert.equal(made(11, 8), '11 следов по имени роли в 8 записях')
  assert.equal(made(2, 2), '2 следа по имени роли в 2 записях')
  assert.equal(made(1, 1), '1 след по имени роли в 1 записи')
  assert.equal(traceCounter([]), '0 следов по имени роли')
})

test('счётчик каждой роли совпадает с числом её рёбер `fired` в графе', () => {
  for (const role of of('role')) {
    const mine = fired.filter((e) => e.from === role.id)
    const records = new Set(mine.map((e) => e.to)).size
    const said = traceCounter(mine)
    assert.ok(said.startsWith(`${mine.length} `), `${role.id}: ${said}`)
    if (mine.length > 0) assert.ok(said.includes(` в ${records} `), `${role.id}: ${said}`)
  }
})

test('счётчик не называет вывод: ни «вето», ни «находок», ни «сработал»', () => {
  for (const role of of('role')) {
    const said = traceCounter(fired.filter((e) => e.from === role.id))
    for (const banned of ['вето', 'находк', 'сработ', 'вынес']) assert.equal(said.includes(banned), false)
  }
})

test('сегменты чтения: граница только при закрытых скобках и кавычках', () => {
  assert.deepEqual(segments('раз; два.').map((s) => s.end), [4, 9])
  // Точка внутри скобки границей не становится: карточка не может кончиться
  // незакрытой скобкой — это тот дефект, ради которого снят предел длины.
  assert.deepEqual(segments('начало (внутри. ещё) конец.').map((s) => s.end), [27])
  assert.deepEqual(segments('он сказал «стоп; иди» и ушёл; потом.').map((s) => s.end), [29, 36])
  assert.deepEqual(segments('без границ').map((s) => s.end), [10])
})

const PROSE = {
  excerpt:
    'Правки по двойному ревью (reviewer и compliance, вето снято кодом): разбор тела не роняет процесс (граница под try);' +
    ' лимитер резервирует слот атомарно вместо двух шагов, потому что параллельный залп проходил мимо суточного предела;' +
    ' белый список ссылок сравнивает нормализованные адреса без учёта регистра и не режет скобочные ссылки.',
  marks: { unit: [0, 46], role: [36, 46], sign: [0, 6] },
}

test('свёртка режет по границе сегмента: скобки закрыты, подсветка внутри', () => {
  const { end, hidden } = foldExcerpt(PROSE.excerpt, PROSE.marks)
  const shown = PROSE.excerpt.slice(0, end)
  assert.equal(shown.endsWith(';'), true)
  assert.equal([...shown].filter((c) => c === '(').length, [...shown].filter((c) => c === ')').length)
  assert.ok(PROSE.marks.unit[1] <= end, 'совпавший фрагмент целиком внутри показанного')
  assert.equal(hidden, PROSE.excerpt.length - end)
  assert.ok(hidden >= FOLD_FROM)
  // Многоточия в месте свёртки нет: `…` — знак снятого предела длины.
  assert.equal(shown.includes('…'), false)
})

test('хвост короче порога показывается вместе со всем остальным', () => {
  const short = 'Compliance наложил вето и снял его после правки; reviewer нашёл точку отказа.'
  assert.deepEqual(foldExcerpt(short, { unit: [0, 44], role: [0, 10], sign: [21, 25] }), {
    end: short.length,
    hidden: 0,
  })
})

test('метка в последнем сегменте не прячет ничего', () => {
  const line = 'Compliance — вето нет; reviewer — блокирующих нет; design — «правки», три штуки.'
  assert.deepEqual(foldExcerpt(line, { unit: [51, 80], role: [51, 57], sign: [61, 67] }), {
    end: line.length,
    hidden: 0,
  })
})

test('строка таблицы сегментом не делится и не сворачивается', () => {
  const row = `| compliance | **Вето:** ${'очень длинная причина, '.repeat(20)}| Раздел переписан |`
  const marks = { unit: [0, row.length], role: [2, 12], sign: [15, 19] }
  assert.deepEqual(foldExcerpt(row, marks), { end: row.length, hidden: 0 })
})

test('без `marks` выдержка показывается целиком: пропадает подсветка, а не выдержка', () => {
  assert.deepEqual(foldExcerpt(PROSE.excerpt, null), { end: PROSE.excerpt.length, hidden: 0 })
  const runs = excerptRuns(PROSE.excerpt, 0, PROSE.excerpt.length, null)
  assert.equal(runs.some((r) => r.mut || r.mark), false)
})

test('свёртка на живых данных редка: она включается там, где болит', () => {
  const folded = fired.filter((e) => foldExcerpt(e.excerpt, e.marks).hidden > 0)
  // Правило свёртки — исключение, а не режим показа: если оно начнёт
  // срабатывать у большинства следов, витрина прячет доказательства.
  assert.ok(folded.length * 3 <= fired.length, `свёрнуто ${folded.length} из ${fired.length}`)
  for (const e of folded) {
    const shown = e.excerpt.slice(0, foldExcerpt(e.excerpt, e.marks).end)
    assert.match(shown, /[;.!?]$/, `${e.to}:${e.line} кончается не на границе`)
    assert.equal([...shown].filter((c) => c === '(').length, [...shown].filter((c) => c === ')').length)
    assert.ok(e.marks.unit[1] <= shown.length, `${e.to}:${e.line}: подсветка за границей свёртки`)
  }
})

test('ни одна выдержка следа не обрывается многоточием', () => {
  for (const e of fired) assert.equal(e.excerpt.includes('…'), false, `${e.to}:${e.line}`)
})

test('подсветка: совпавший фрагмент отделён от чужих отрицаний в той же строке', () => {
  const line = 'Compliance — вето нет; reviewer — блокирующих нет; design — «правки», три штуки.'
  const runs = excerptRuns(line, 0, line.length, { unit: [51, 80], role: [51, 57], sign: [61, 67] })
  const text = (f) => runs.filter(f).map((r) => r.text).join('')
  assert.equal(text((r) => r.mut), 'Compliance — вето нет; reviewer — блокирующих нет; ')
  assert.equal(text((r) => !r.mut), 'design — «правки», три штуки.')
  assert.equal(text((r) => r.mark === 'role'), 'design')
  assert.equal(text((r) => r.mark === 'sign'), 'правки')
  // Подчёркнутое лежит внутри неприглушённого — иначе посетитель унёс бы с
  // витрины утверждение, обратное правде.
  assert.equal(runs.filter((r) => r.mark).every((r) => !r.mut), true)
})

test('подсветка совпадает с данными у каждого следа графа', () => {
  for (const e of fired) {
    const runs = excerptRuns(e.excerpt, 0, e.excerpt.length, e.marks)
    const got = (mark) => runs.filter((r) => r.mark === mark).map((r) => r.text).join('')
    assert.equal(got('role').toLowerCase(), e.from.split('/')[1], `${e.to}:${e.line}`)
    assert.equal(got('sign'), e.excerpt.slice(...e.marks.sign), `${e.to}:${e.line}`)
    assert.ok(got('role').length > 0 && got('sign').length > 0, `${e.to}:${e.line}: подсветка пуста`)
  }
})

test('разметка разбирается последней: снятие `**` не сдвигает подсветку', () => {
  const row = '| compliance | **Вето:** расчёт цены сравнивал с пределом | Раздел переписан |'
  const marks = { unit: [0, row.length], role: [2, 12], sign: [17, 21] }
  const runs = excerptRuns(row, 0, row.length, marks)
  assert.equal(runs.filter((r) => r.strong).map((r) => r.text).join(''), 'Вето:')
  assert.equal(runs.filter((r) => r.mark === 'sign').map((r) => r.text).join(''), 'Вето')
  assert.equal(runs.map((r) => r.text).join('').includes('*'), false)
})

test('разбирается ровно два вида парной разметки, непарный маркер — символ', () => {
  assert.equal(parseMarkup('**жирно** и `код`').filter((c) => c.strong).length, 5)
  assert.equal(parseMarkup('**жирно** и `код`').filter((c) => c.code).length, 3)
  const unpaired = parseMarkup('**Вето без пары')
  assert.equal(unpaired.length, '**Вето без пары'.length)
  assert.equal(unpaired.some((c) => c.strong), false)
  assert.equal(parseMarkup('_курсив_ [ссылка](x)').some((c) => c.strong || c.code), false)
})

test('ячейки строки таблицы без символов `|`', () => {
  const row = '| compliance | **Вето:** причина | Раздел переписан |'
  const cells = tableCells(row).map((c) => row.slice(c.start, c.end).trim())
  assert.deepEqual(cells, ['compliance', '**Вето:** причина', 'Раздел переписан'])
  assert.deepEqual(tableCells('без палок'), [{ start: 0, end: 9 }])
})

test('адрес узла — идентификатор с `-` вместо `/`, обратно по таблице', () => {
  assert.equal(addressOf('adr/2026-09-13-1800'), 'adr-2026-09-13-1800')
  assert.equal(addressOf('invariant/I-4'), 'invariant-I-4')
  const table = addressTable(graph.nodes)
  // Адрес не разбирается: в ключах есть дефисы, и таблица обязана быть
  // взаимно однозначной на любом наборе документов.
  assert.equal(table.size, graph.nodes.length)
  for (const n of graph.nodes) assert.equal(table.get(addressOf(n.id)), n.id)
  assert.equal(table.get('adr-2026-01-01-0000'), undefined)
})

test('короткое имя узла — не заголовок', () => {
  const named = (id, want) => {
    const n = byId.get(id)
    if (n) assert.equal(shortName(n), want, id)
  }
  named('invariant/I-4', 'I-4')
  named('role/compliance', 'compliance')
  named('class/A', 'Класс A')
  named('phase/06', '6. Ревью по классу')
  named('design/corpus', 'corpus')
  assert.equal(shortName({ type: 'adr', key: '2026-09-13-1800' }), 'ADR 13.09 18:00')
  assert.equal(shortName({ type: 'history', key: '2026-09-13-1500' }), 'Запись 13.09 15:00')
  assert.equal(shortName({ type: 'design', key: '2026-09-12-0900-day7-chat-layout' }), 'Дизайн 12.09 09:00')
  assert.equal(shortName({ type: 'skill', key: 'browser-testing-with-devtools' }), 'browser-testing-with-dev…')
  // Обрезка по 24 знакам действует на любом наборе документов.
  for (const n of graph.nodes) assert.ok(shortName(n).length <= 25, `${n.id}: ${shortName(n)}`)
})

test('заголовок панели без машинного префикса даты', () => {
  assert.equal(plainTitle({ title: '[2026-09-13 18:00] Фреймворк v2' }), 'Фреймворк v2')
  assert.equal(plainTitle({ title: 'Дизайн-корпус проекта' }), 'Дизайн-корпус проекта')
  for (const n of graph.nodes) assert.equal(plainTitle(n).startsWith('['), false, n.id)
})

test('чип статуса — по первому слову; полная строка статуса им не подменяется', () => {
  assert.equal(statusChip('Принято'), 'Принято')
  assert.equal(statusChip('Принято.'), 'Принято')
  assert.equal(statusChip('Заменяет ADR 2026-09-07-1535'), 'Принято, заменяет')
  assert.equal(statusChip('Предложено'), 'Предложено')
  assert.equal(statusChip('Отклонено'), 'Отклонено')
  assert.equal(statusChip('Заменено решением 2026-09-07-1700'), 'Заменено')
  assert.equal(statusChip('Обсуждается'), 'Статус не разобран')
  assert.equal(statusChip(undefined), 'Статус не разобран')
  // Чип «Статус не разобран» показывается честно: если он появится на живых
  // данных, это видно здесь, а не только на экране.
  const unparsed = of('adr').filter((n) => statusChip(n.status) === 'Статус не разобран')
  assert.deepEqual(unparsed.map((n) => `${n.id}: ${n.status}`), [])
})

test('вид отношения называет отношение, а не вывод', () => {
  assert.equal(relation('cites', true), 'цитирует')
  assert.equal(relation('cites', false), 'процитирован в')
  assert.equal(relation('replaces', false), 'заменён решением')
  // Каждому виду ребра в графе есть слово в обе стороны — иначе панель
  // показала бы посетителю машинное имя ребра.
  for (const kind of new Set(graph.edges.map((e) => e.kind))) {
    if (kind === 'fired') continue
    assert.notEqual(relation(kind, true), kind, `нет слова для ребра ${kind}`)
    assert.notEqual(relation(kind, false), kind, `нет слова для ребра ${kind}`)
  }
})

test('окрестность: один шаг читаем, два — почти весь граф', () => {
  const { near } = index
  const hub = 'role/compliance'
  assert.equal(neighborhood(near, hub, 0).size, 1)
  assert.equal(neighborhood(near, hub, 1).size, near.get(hub).size + 1)
  assert.ok(neighborhood(near, hub, 2).size > neighborhood(near, hub, 1).size)
  // Ради этого числа в раскладке и стоит переключатель глубины с ценой на
  // ярлыке: два шага у самых связанных узлов доходят до половины графа.
  assert.ok(maxTwoStep(near) > graph.nodes.length / 2)
})

test('след — такая же связь: на канве он есть, в панели показан иначе', () => {
  const { near } = index
  for (const e of fired) assert.equal(near.get(e.from).has(e.to), true, `${e.from} → ${e.to}`)
  // Кратные рёбра между одной парой сводятся к одной связи.
  const pairs = fired.map((e) => `${e.from} ${e.to}`)
  const doubled = pairs.find((p, i) => pairs.indexOf(p) !== i)
  if (doubled) {
    const [from, to] = doubled.split(' ')
    assert.equal([...near.get(from)].filter((id) => id === to).length, 1)
  }
})

test('узлы без рёбер видны как узлы без рёбер', () => {
  const { near } = index
  const alone = graph.nodes.filter((n) => near.get(n.id).size === 0)
  for (const n of alone) assert.equal(neighborhood(near, n.id, 1).size, 1)
  assert.equal(alone.length < graph.nodes.length, true)
})

test('поиск идёт по заголовкам и коротким именам, не по тексту документов', () => {
  const { hits } = searchNodes(graph.nodes, 'COMPLI', 12)
  assert.ok(hits.some((n) => n.id === 'role/compliance'))
  assert.deepEqual(searchNodes(graph.nodes, '   ', 12), { hits: [], total: 0 })
  // Слово из тела документа, которого нет ни в одном заголовке.
  assert.equal(searchNodes(graph.nodes, 'непривязывающим', 12).total, 0)
  const many = searchNodes(graph.nodes, '2026', 12)
  assert.equal(many.hits.length, 12)
  assert.ok(many.total > 12, 'выдача обрезается до 12, остаток называется числом')
})

test('стартовый вид — цепь фаз с ролями, а не клубок', () => {
  const view = cycleView(graph, true)
  const runs = graph.edges.filter((e) => e.kind === 'runs')
  const expected = new Set([...of('phase').map((p) => p.id), ...runs.map((e) => e.to)])
  assert.deepEqual([...view.ids].sort(), [...expected].sort())
  assert.ok(view.ids.size * 4 < graph.nodes.length, 'стартовый вид — не весь граф')
  // Связки «фаза → следующая фаза» страница рисует сама: в графе их нет.
  assert.equal(view.edges.filter((e) => e.kind === 'next').length, of('phase').length - 1)
  assert.equal(graph.edges.some((e) => e.kind === 'next'), false)
  assert.equal(view.place.size, view.ids.size)
  assert.deepEqual(view.place.get('phase/01'), { x: 0, y: 0 })
  assert.equal(view.place.get(`phase/${String(of('phase').length).padStart(2, '0')}`).x, of('phase').length - 1)
  // Узел стоит в одном месте, даже если его ведут две фазы.
  assert.equal(view.place.get('role/reviewer').x, view.place.get('phase/06').x)
})

test('на узком экране цепь идёт сверху вниз', () => {
  const down = cycleView(graph, false)
  const last = `phase/${String(of('phase').length).padStart(2, '0')}`
  assert.deepEqual(down.place.get('phase/01'), { x: 0, y: 0 })
  assert.equal(down.place.get(last).y, of('phase').length - 1)
  assert.equal(down.place.get(last).x, 0)
})

test('камера вписывает вид в поле и не искажает расстояний', () => {
  const pts = new Map([
    ['a', { x: 0, y: 0 }],
    ['b', { x: 1, y: 1 }],
  ])
  const field = { width: 400, height: 200 }
  const cam = { ...fit(field, pts), scale: 1, panX: 0, panY: 0 }
  const at = transform(field, cam)
  const a = at(pts.get('a'))
  const b = at(pts.get('b'))
  // Один масштаб по обеим осям: вид вписан по узкой стороне.
  assert.equal(Math.round(b.x - a.x), Math.round(b.y - a.y))
  assert.equal(Math.round((a.x + b.x) / 2), field.width / 2)
  assert.equal(Math.round((a.y + b.y) / 2), field.height / 2)
  assert.ok(a.y >= 0 && b.y <= field.height)
  assert.deepEqual(fit(field, new Map()), { base: 1, cx: 0, cy: 0 })
})

// Ширину знака в Node измерить нечем, поэтому у расстановки — свой измеритель.
// Проверяется правило, а не типографика: правило одно и то же в тесте и на
// канве, потому что это одна функция.
const monoWidth = (text) => text.length * 7

test('подпись занимает первую свободную позицию, а не пропадает при первом соседе', () => {
  const field = { width: 400, height: 200 }
  const items = [
    { id: 'a', x: 200, y: 100, text: 'первый', rank: 0 },
    { id: 'b', x: 205, y: 100, text: 'второй', rank: 1 },
    { id: 'c', x: 210, y: 100, text: 'третий', rank: 2 },
  ]
  const placed = placeLabels(items, field, monoWidth)
  assert.equal(placed.size, 3, 'все три подписи нашли место')
  const boxes = [...placed.values()]
  for (let i = 0; i < boxes.length; i += 1)
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i]
      const b = boxes[j]
      const apart = a.x + a.width + 4 <= b.x || b.x + b.width + 4 <= a.x || a.y + 16 <= b.y || b.y + 16 <= a.y
      assert.equal(apart, true, 'подписи не накладываются')
    }
  // Важному узлу достаётся первая позиция — под узлом, по центру.
  assert.deepEqual(placed.get('a'), { x: 200 - (6 * 7) / 2 - 2, y: 108, width: 42 })
})

test('подпись не вылезает за поле и не отрывается от своего узла', () => {
  const field = { width: 200, height: 100 }
  const placed = placeLabels([{ id: 'a', x: 4, y: 50, text: 'длинная подпись', rank: 0 }], field, monoWidth)
  const box = placed.get('a')
  assert.ok(box === undefined || (box.x >= 2 && box.x + box.width + 4 <= field.width - 2))
})

test('подписи важнее по порядку важности, а не по порядку в данных', () => {
  const field = { width: 120, height: 60 }
  const tight = [
    { id: 'младший', x: 60, y: 30, text: 'подпись', rank: 4, slots: ['below'] },
    { id: 'старший', x: 62, y: 30, text: 'подпись', rank: 0, slots: ['below'] },
  ]
  const placed = placeLabels(tight, field, monoWidth)
  assert.equal(placed.has('старший'), true)
  assert.equal(placed.has('младший'), false)
})

test('первая позиция подписи — под узлом, остальные различны', () => {
  assert.equal(SLOTS[0], 'below')
  assert.equal(new Set(SLOTS).size, SLOTS.length)
  assert.ok(SLOTS.length >= 12, 'позиций хватает, чтобы пропуск был остатком, а не правилом')
  // Ряды идут по возрастанию удалённости: ближняя позиция пробуется раньше.
  const rowOf = (slot) => Number(/(\d)/.exec(slot)?.[1] ?? 1)
  const rows = SLOTS.filter((slot) => slot !== 'right' && slot !== 'left').map(rowOf)
  assert.deepEqual(rows, [...rows].sort((a, b) => a - b))
})

test('подпись не накрывает чужой узел', () => {
  const field = { width: 300, height: 200 }
  // Второй узел стоит ровно там, где легла бы подпись первого.
  const items = [
    { id: 'свой', x: 150, y: 100, text: 'подпись', rank: 0, slots: ['below'] },
    { id: 'чужой', x: 150, y: 112, text: 'x', rank: 1, slots: ['below'] },
  ]
  assert.equal(placeLabels(items, field, monoWidth).has('свой'), false)
})

test('дальняя позиция не подписывает соседа', () => {
  const field = { width: 400, height: 300 }
  // `below3` уводит подпись на полсотни пикселей вниз — прямо к чужому узлу.
  const items = [
    { id: 'свой', x: 200, y: 100, text: 'подпись', rank: 0, slots: ['below3'] },
    { id: 'чужой', x: 200, y: 150, text: 'x', rank: 1, slots: ['below'] },
  ]
  assert.equal(placeLabels(items, field, monoWidth).has('свой'), false)
  // Тот же узел без чужого рядом подпись получает.
  assert.equal(placeLabels([items[0]], field, monoWidth).has('свой'), true)
})

test('позиция, прижатая краем к узлу, подписывает узел у самой границы', () => {
  const field = { width: 200, height: 100 }
  const at = { id: 'край', x: 196, y: 50, text: 'длинная подпись', rank: 0 }
  const placed = placeLabels([at], field, monoWidth)
  const box = placed.get('край')
  assert.ok(box, 'узел у границы подписан')
  assert.ok(box.x >= 2 && box.x + box.width + 4 <= field.width - 2, 'подпись целиком в поле')
  // Подпись примыкает к узлу, а не висит отдельно: от узла до коробки — зазор.
  const gap = Math.hypot(
    Math.max(box.x - at.x, 0, at.x - (box.x + box.width + 4)),
    Math.max(box.y - at.y, 0, at.y - (box.y + 16)),
  )
  assert.ok(gap <= 12, `подпись оторвана от узла на ${gap}`)
})

test('панель собирается для каждого узла графа', () => {
  for (const node of graph.nodes) {
    assert.ok(TYPE_NAME[node.type], `${node.id}: тип без имени словом`)
    assert.equal(typeof shortName(node), 'string')
    const facts = factsOf(node, graph)
    for (const pair of facts) {
      assert.equal(typeof pair.term, 'string', `${node.id}: пара без названия`)
      // Пара с пустым значением — «Образ: undefined» на экране либо
      // исключение при отрисовке; ни того, ни другого быть не должно.
      if (pair.links) {
        assert.ok(pair.links.length > 0, `${node.id}/${pair.term}: пустой список ссылок`)
        for (const id of pair.links) assert.ok(byId.has(id), `${node.id}/${pair.term}: ссылка в никуда ${id}`)
      } else {
        assert.equal(typeof pair.text, 'string', `${node.id}/${pair.term}: значения нет`)
        assert.notEqual(pair.text, '', `${node.id}/${pair.term}: значение пустое`)
      }
    }
  }
})

test('узлы overlay без необязательных полей панель не роняют', () => {
  // Пять узлов `external` из overlay.json не несут `tier`, `service/site` не
  // несёт `image`: факта нет — пары нет, а не «undefined» и не исключение.
  const bare = { id: 'external/x', type: 'external', key: 'x', title: 'x', kind: 'registry' }
  assert.deepEqual(factsOf(bare, { nodes: [bare], edges: [] }), [{ term: 'Вид', text: 'registry', mono: undefined }])
  const service = { id: 'service/y', type: 'service', key: 'y', title: 'y' }
  assert.deepEqual(
    factsOf(service, { nodes: [service], edges: [] }).map((p) => p.term),
    ['Файлы окружения'],
  )
  for (const type of Object.keys(TYPE_NAME)) {
    const empty = { id: `${type}/z`, type, key: 'z', title: 'z' }
    assert.doesNotThrow(() => factsOf(empty, { nodes: [empty], edges: [] }), type)
  }
})

test('сводка чисел считается по графу', () => {
  const stats = statsOf(graph, index.near)
  assert.equal(stats.nodes, graph.nodes.length)
  assert.equal(stats.edges, graph.edges.length)
  assert.equal(stats.byType.role, of('role').length)
  assert.equal(stats.fired.length, fired.length)
  assert.equal(stats.rolesWithout, of('role').filter((r) => !fired.some((e) => e.from === r.id)).length)
  assert.equal(stats.alone, Object.values(stats.aloneBy).reduce((a, b) => a + b, 0))
  assert.equal(stats.twoStep, maxTwoStep(index.near))
})

test('кратные рёбра между парой узлов сводятся к одной линии', () => {
  const doubled = [
    { from: 'a', to: 'b', kind: 'cites' },
    { from: 'b', to: 'a', kind: 'relies' },
    { from: 'a', to: 'c', kind: 'cites' },
  ]
  assert.deepEqual(dedupe(doubled).map((e) => e.kind), ['cites', 'cites'])
  const all = dedupe(graph.edges)
  assert.ok(all.length < graph.edges.length)
  const pairs = all.map((e) => (e.from < e.to ? `${e.from} ${e.to}` : `${e.to} ${e.from}`))
  assert.equal(new Set(pairs).size, pairs.length)
})

test('полоса вида называет вид и числа этого вида', () => {
  const stats = statsOf(graph, index.near)
  const base = { stats, byId, depth: 1, links: [] }
  assert.match(
    viewLine({ ...base, full: true, selected: null, ids: new Set() }),
    /^Весь граф: \d+ узл\S+, \d+ связ\S+\. Подписи скрыты/,
  )
  assert.equal(viewLine({ ...base, full: false, selected: null, ids: new Set() }), 'Ни одного узла: скрыты все типы')
  assert.equal(
    viewLine({ ...base, full: false, selected: 'role/compliance', ids: new Set(['role/compliance']) }),
    'У этого узла нет связей — на канве только он',
  )
  assert.equal(
    viewLine({ ...base, full: false, selected: 'role/compliance', ids: new Set(['role/compliance', 'class/A']), links: [{}] }),
    'Соседи узла compliance, 1 шаг: 2 узла, 1 связь',
  )
  const cycle = cycleView(graph, true)
  assert.match(viewLine({ ...base, full: false, selected: null, ids: cycle.ids }), /^Цикл дня: \d+ фаз\S*, \d+ рол\S+, \d+ класс\S* гейтов$/)
})

test('у документов есть путь для ссылки на GitHub', () => {
  assert.ok(ROOT.endsWith('/'))
  for (const n of graph.nodes.filter((x) => ['adr', 'history', 'design', 'guide'].includes(x.type)))
    assert.ok(n.file && !n.file.startsWith('/'), `${n.id}: путь для ссылки на GitHub`)
})
