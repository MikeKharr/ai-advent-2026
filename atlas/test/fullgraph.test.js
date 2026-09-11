import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { afterEach, beforeEach, mock, test } from 'node:test'
import {
  LOAD_LIMIT_MS,
  buildSearch,
  emptyNote,
  fetchTexts,
  flatHint,
  fold,
  highlight,
  labelRank,
  listScrollTop,
  moreNote,
  searchAtlas,
  textsNote,
  textsOutcome,
  viewLine,
} from '../web/app.js'

// Объём по умолчанию, полный граф, полнотекстовый поиск —
// agent_docs/design/2026-09-14-2300-atlas-3d-fullgraph-search.md, раздел
// «Тесты `qa` на чистую часть». Все данные — синтетические: живой граф
// растёт с каждым документом, и тест с его числами красил бы чужой PR.

// ── Строка вида ────────────────────────────────────────────────────────

const node = (id, type, key, title = key) => ({ id, type, key, title })
const N = [
  node('role/compliance', 'role', 'compliance'),
  node('role/qa', 'role', 'qa'),
  node('class/A', 'class', 'A'),
  node('adr/x', 'adr', 'x'),
  node('guide/lonely', 'guide', 'lonely'),
]
const byId = new Map(N.map((n) => [n.id, n]))
const near = new Map([
  ['role/compliance', new Set(['role/qa', 'class/A', 'adr/x'])],
  ['role/qa', new Set(['role/compliance'])],
  ['class/A', new Set(['role/compliance'])],
  ['adr/x', new Set(['role/compliance'])],
  ['guide/lonely', new Set()],
])
const all = new Set(N.map((n) => n.id))
const line = (over) => viewLine({ ids: all, links: [{}, {}, {}], hidden: 0, selected: null, byId, near, found: 0, volume: true, ...over })

test('строка вида: все типы скрыты', () => {
  assert.equal(line({ ids: new Set(), links: [] }), 'Ни одного узла: скрыты все типы')
})

test('строка вида: выделения нет, типы не скрыты — числа вида', () => {
  assert.equal(line({}), 'Весь граф: 5 узлов, 3 связи · объём')
  assert.equal(line({ volume: false }), 'Весь граф: 5 узлов, 3 связи')
})

test('строка вида: часть типов скрыта — числа по виду после фильтров', () => {
  const ids = new Set(['role/compliance', 'role/qa'])
  assert.equal(line({ ids, links: [{}], hidden: 1 }), 'Скрыто 1 тип: 2 узла, 1 связь · объём')
  assert.equal(line({ ids, links: [{}], hidden: 3 }), 'Скрыто 3 типа: 2 узла, 1 связь · объём')
  assert.equal(line({ ids, links: [{}], hidden: 5 }), 'Скрыто 5 типов: 2 узла, 1 связь · объём')
})

test('строка вида: выбран узел с видимыми соседями', () => {
  assert.equal(line({ selected: 'role/compliance' }), 'Выделены compliance и 3 соседа · объём')
  assert.equal(line({ selected: 'role/qa' }), 'Выделены qa и 1 сосед · объём')
  // Соседи считаются по видимым: скрытый фильтром сосед в число не входит.
  const ids = new Set(['role/compliance', 'role/qa', 'class/A', 'guide/lonely'])
  assert.equal(line({ ids, selected: 'role/compliance', hidden: 1 }), 'Выделены compliance и 2 соседа · объём')
})

test('строка вида: форма слова «сосед» по числу', () => {
  const many = new Map([['hub', new Set(Array.from({ length: 21 }, (_, i) => `n${i}`))]])
  const ids = new Set(['hub', ...many.get('hub')])
  const hubs = new Map([['hub', node('hub', 'role', 'hub')]])
  const said = (k) =>
    viewLine({ ids: new Set(['hub', ...[...many.get('hub')].slice(0, k)]), links: [], hidden: 0, selected: 'hub', byId: hubs, near: many, found: 0, volume: false })
  assert.equal(said(21), 'Выделены hub и 21 сосед')
  assert.equal(said(5), 'Выделены hub и 5 соседей')
  assert.equal(said(11), 'Выделены hub и 11 соседей')
  assert.ok(ids.size > 0)
})

test('строка вида: выбран узел без связей', () => {
  assert.equal(line({ selected: 'guide/lonely' }), 'Выделен lonely: у него нет связей · объём')
})

test('строка вида: связи есть, соседи скрыты фильтром', () => {
  const ids = new Set(['role/qa', 'guide/lonely'])
  assert.equal(line({ ids, links: [], hidden: 1, selected: 'role/qa' }), 'Выделен qa, соседи скрыты · объём')
})

test('строка вида: тип выбранного скрыт фильтром', () => {
  const ids = new Set(['role/qa', 'role/compliance'])
  assert.equal(line({ ids, links: [{}], hidden: 1, selected: 'adr/x' }), 'ADR x скрыт фильтром · объём')
})

test('строка вида: найденные — отдельным сегментом или без выбора', () => {
  assert.equal(line({ found: 7 }), 'Найдено по запросу: 7 · объём')
  assert.equal(line({ selected: 'role/compliance', found: 2 }), 'Выделены compliance и 3 соседа; найдено 2 · объём')
  assert.equal(line({ selected: 'guide/lonely', found: 1, volume: false }), 'Выделен lonely: у него нет связей; найдено 1')
})

test('строка вида: один узел на канве — «· объём: вращать нечего»', () => {
  assert.equal(line({ ids: new Set(['guide/lonely']), links: [], hidden: 4 }), 'Скрыто 4 типа: 1 узел, 0 связей · объём: вращать нечего')
})

// ── Подсветка ──────────────────────────────────────────────────────────

test('подсветка: ни выбора, ни находок — выделения нет', () => {
  const hl = highlight({ sel: null, near: null, found: new Set() })
  assert.equal(hl.on, false)
  assert.equal(hl.lit.size, 0)
  assert.equal(hl.rings.size, 0)
})

test('подсветка: выбран узел — он и соседи в полном цвете, колец --fg нет', () => {
  const hl = highlight({ sel: 'a', near: new Set(['b', 'c']), found: new Set() })
  assert.equal(hl.on, true)
  assert.deepEqual([...hl.lit].sort(), ['a', 'b', 'c'])
  assert.equal(hl.rings.size, 0)
})

test('подсветка: только находки — они в полном цвете и с кольцом', () => {
  const hl = highlight({ sel: null, near: null, found: new Set(['x', 'y']) })
  assert.equal(hl.on, true)
  assert.deepEqual([...hl.lit].sort(), ['x', 'y'])
  assert.deepEqual([...hl.rings].sort(), ['x', 'y'])
})

test('подсветка: выбор и находки складываются; выбранный найденный — без кольца --fg', () => {
  const hl = highlight({ sel: 'a', near: new Set(['b']), found: new Set(['a', 'z']) })
  assert.deepEqual([...hl.lit].sort(), ['a', 'b', 'z'])
  assert.deepEqual([...hl.rings], ['z'])
})

test('ранг подписи: выбранный 0, наведённый 2 только без «всех подписей», соседи и найденные 3, прочие 4', () => {
  const args = { sel: 's', near: new Set(['n']), found: new Set(['f']), hover: 'h', always: false }
  assert.equal(labelRank({ ...args, id: 's' }), 0)
  assert.equal(labelRank({ ...args, id: 'h' }), 2)
  assert.equal(labelRank({ ...args, id: 'h', always: true }), 4)
  assert.equal(labelRank({ ...args, id: 'n' }), 3)
  assert.equal(labelRank({ ...args, id: 'f' }), 3)
  assert.equal(labelRank({ ...args, id: 'o' }), 4)
})

// ── Прокрутка списка ───────────────────────────────────────────────────

test('строка выбранного встаёт на треть высоты области', () => {
  assert.equal(listScrollTop({ top: 1000, height: 540, scrollHeight: 6000 }), 1000 - 180)
  // round(H/3): 469/3 = 156.33 → 156.
  assert.equal(listScrollTop({ top: 1000, height: 469, scrollHeight: 6000 }), 1000 - 156)
})

test('прокрутка ограничена пределами: первые строки выше трети, последние ниже', () => {
  assert.equal(listScrollTop({ top: 40, height: 540, scrollHeight: 6000 }), 0)
  assert.equal(listScrollTop({ top: 5900, height: 540, scrollHeight: 6000 }), 6000 - 540)
  assert.equal(listScrollTop({ top: 100, height: 540, scrollHeight: 300 }), 0, 'список короче области')
})

// ── Подсказки ──────────────────────────────────────────────────────────

test('подсказка под канвой — четыре текста по режиму и вводу', () => {
  assert.equal(flatHint(false, true), 'Перетаскивание вращает, с Shift — сдвигает; имя узла — под указателем')
  assert.equal(flatHint(true, true), 'Перетаскивание сдвигает; имя узла — под указателем')
  assert.equal(flatHint(false, false), 'Палец вращает; к центру вернёт «Сбросить вид»')
  assert.equal(flatHint(true, false), 'Палец сдвигает схему')
})

test('подсказка поиска по состоянию текстов', () => {
  const idle = textsNote('idle')
  assert.equal(idle, 'Ищет в заголовках сразу, в тексте документов — от трёх знаков')
  assert.equal(textsNote('ready'), idle)
  assert.equal(textsNote('loading'), 'Тексты документов ещё грузятся — пока ищу только в заголовках')
  assert.equal(textsNote('error'), 'Тексты документов не загрузились — ищу только в заголовках')
})

test('пустая выдача называет причину', () => {
  assert.equal(emptyNote({ texts: 'ready', short: false }), 'Ничего не нашлось ни в заголовках, ни в тексте документов.')
  assert.equal(emptyNote({ texts: 'ready', short: true }), 'В заголовках ничего нет. По тексту документов ищу от трёх знаков.')
  assert.equal(emptyNote({ texts: 'loading', short: false }), 'В заголовках ничего нет. Тексты документов ещё грузятся — выдача обновится сама.')
  assert.equal(emptyNote({ texts: 'error', short: false }), 'В заголовках ничего нет, а тексты документов не загрузились.')
})

test('подпись под выдачей: все найденные или «ещё m − 5»', () => {
  assert.equal(moreNote(3, 3), 'Все найденные выделены кольцом на схеме и в списке узлов.')
  assert.equal(moreNote(47, 5), 'Ещё 42 — выделены кольцом на схеме и в списке узлов.')
})

test('объявления исхода загрузки текстов', () => {
  assert.equal(textsOutcome({ ok: true, attempt: 1 }), null, 'успех с первой попытки молчит')
  assert.equal(textsOutcome({ ok: false, attempt: 1 }), 'Тексты документов не загрузились — поиск идёт только по заголовкам.')
  assert.equal(textsOutcome({ ok: false, attempt: 3 }), 'Попытка 3: тексты документов не загрузились — поиск идёт только по заголовкам.')
  assert.equal(textsOutcome({ ok: true, attempt: 2 }), 'Тексты документов загружены — поиск идёт и по тексту.')
})

// ── Поиск ──────────────────────────────────────────────────────────────

test('сравнение без регистра и с «ё» = «е», длина строки сохраняется', () => {
  assert.equal(fold('Объём ЁЛКА'), 'объем елка')
  const s = 'İstanbul Ёж'
  assert.equal(fold(s).length, s.length)
})

const DOCS = [
  { id: 'adr/one', type: 'adr', key: '2026-09-01-1000', title: '[2026-09-01 10:00] Объём по умолчанию' },
  { id: 'role/qa', type: 'role', key: 'qa', title: 'qa', description: 'Тесты по критериям приёмки.' },
  { id: 'guide/veto', type: 'guide', key: 'veto', title: 'Правила ревью' },
  { id: 'history/a', type: 'history', key: '2026-09-02-1000', title: '[2026-09-02 10:00] Запись А' },
  { id: 'history/b', type: 'history', key: '2026-09-03-1000', title: '[2026-09-03 10:00] Запись Б' },
  { id: 'invariant/I-1', type: 'invariant', key: 'I-1', title: 'I-1', text: 'Ключ живёт только на сервере.' },
]
const TEXTS = {
  'adr/one': 'Решение: страница открывается в объёме. Вето не нужно.',
  'history/a': 'Compliance наложил вето. Потом вето сняли. И снова вето.',
  'history/b': 'Одно вето в конце текста, и больше ничего здесь нет вообще.',
  'guide/veto': 'Ревью идёт по классу изменения.',
  'adr/чужой': 'Узла нет в графе: вето здесь не должно найтись.',
}

test('заголовки, ключ и короткое имя ищутся с первого знака', () => {
  const idx = buildSearch(DOCS, {})
  const got = searchAtlas(idx, 'qa', 5)
  assert.deepEqual(got.hits.map((h) => h.node.id), ['role/qa'])
  assert.equal(searchAtlas(idx, 'q', 5).total >= 1, true)
})

test('текст ищется от трёх знаков: два знака по тексту не ищут', () => {
  const idx = buildSearch(DOCS, TEXTS)
  const two = searchAtlas(idx, 'ве', 5)
  assert.equal(two.short, true)
  assert.equal(two.total, 0, '«ве» нет ни в одном заголовке, а по тексту не ищем')
  assert.equal(searchAtlas(idx, 'вет', 5).short, false)
})

test('«объем» находит «объём» и в заголовке, и в тексте', () => {
  const idx = buildSearch(DOCS, TEXTS)
  const got = searchAtlas(idx, 'ОБЪЕМ', 5)
  assert.deepEqual(got.hits.map((h) => h.node.id), ['adr/one'])
  assert.equal(got.hits[0].where, 'title')
})

test('порядок: сначала совпавшие по заголовку, затем по тексту — по числу вхождений, при равенстве — порядок графа', () => {
  const idx = buildSearch(DOCS, TEXTS)
  const got = searchAtlas(idx, 'вето', 5)
  // guide/veto — по ключу («veto» ≠ «вето») не находится; по тексту — нет слова.
  assert.deepEqual(got.hits.map((h) => h.node.id), ['history/a', 'adr/one', 'history/b'])
  assert.deepEqual(got.hits.map((h) => h.where), ['text', 'text', 'text'])
  const mixed = searchAtlas(idx, 'ревью', 5)
  assert.deepEqual(mixed.hits.map((h) => [h.node.id, h.where]), [['guide/veto', 'title']])
})

test('текстовые поля узла из graph.json ищутся как текст', () => {
  const idx = buildSearch(DOCS, {})
  assert.deepEqual(searchAtlas(idx, 'сервере', 5).hits.map((h) => h.node.id), ['invariant/I-1'])
  assert.deepEqual(searchAtlas(idx, 'приёмки', 5).hits.map((h) => h.node.id), ['role/qa'])
})

test('идентификаторы текстов, которых нет в графе, пропускаются', () => {
  const idx = buildSearch(DOCS, TEXTS)
  const got = searchAtlas(idx, 'должно найтись', 5)
  assert.equal(got.total, 0)
})

test('выдача до limit, найденные — все', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ id: `history/h${i}`, type: 'history', key: `h${i}`, title: `Запись ${i}` }))
  const got = searchAtlas(buildSearch(many, {}), 'запись', 5)
  assert.equal(got.hits.length, 5)
  assert.equal(got.total, 9)
  assert.equal(got.found.size, 9)
})

const joined = (runs) => runs.map((r) => r.text).join('')
const marked = (runs) => runs.filter((r) => r.hit).map((r) => r.text)

test('отрывок совпадения по заголовку — полный заголовок без префикса даты, совпадение отмечено', () => {
  const got = searchAtlas(buildSearch(DOCS, TEXTS), 'умолч', 5)
  assert.equal(joined(got.hits[0].snippet), 'Объём по умолчанию')
  assert.deepEqual(marked(got.hits[0].snippet), ['умолч'])
})

test('отрывок текста: совпадение в исходном регистре и с «ё», многоточие только у обреза', () => {
  const docs = [{ id: 'h/1', type: 'history', key: 'k', title: 'Т' }]
  const text = 'Короткий текст про ОБЪЁМ страницы.'
  const got = searchAtlas(buildSearch(docs, { 'h/1': text }), 'объем', 5)
  const runs = got.hits[0].snippet
  assert.equal(joined(runs), text, 'текст целиком: ничего не обрезано — многоточия нет')
  assert.deepEqual(marked(runs), ['ОБЪЁМ'])
})

test('отрывок текста режется по границе слова: до 40 знаков до и до 80 после', () => {
  const head = 'слово '.repeat(20)
  const tail = ' хвост'.repeat(40)
  const text = `${head}НАХОДКА${tail}`
  const docs = [{ id: 'h/1', type: 'history', key: 'k', title: 'Т' }]
  const runs = searchAtlas(buildSearch(docs, { 'h/1': text }), 'находка', 5).hits[0].snippet
  const s = joined(runs)
  assert.ok(s.startsWith('…слово'), `начало: ${s.slice(0, 12)}`)
  assert.ok(s.endsWith('хвост…'), `конец: ${s.slice(-12)}`)
  const [before, after] = s.slice(1, -1).split('НАХОДКА')
  assert.ok(before.length <= 40, `до: ${before.length}`)
  assert.ok(after.length <= 80, `после: ${after.length}`)
  // Ни одно слово не разрезано.
  for (const w of s.slice(1, -1).split(' ').filter(Boolean)) assert.ok(['слово', 'хвост', 'НАХОДКА'].includes(w), w)
})

test('все вхождения внутри отрывка отмечены', () => {
  const docs = [{ id: 'h/1', type: 'history', key: 'k', title: 'Т' }]
  const runs = searchAtlas(buildSearch(docs, { 'h/1': 'вето и вето' }), 'вето', 5).hits[0].snippet
  assert.deepEqual(marked(runs), ['вето', 'вето'])
})

test('пустой запрос и пробелы — ничего не найдено', () => {
  const idx = buildSearch(DOCS, TEXTS)
  const got = searchAtlas(idx, '   ', 5)
  assert.equal(got.total, 0)
  assert.equal(got.found.size, 0)
})

test('пробелы в запросе схлопываются', () => {
  const idx = buildSearch(DOCS, TEXTS)
  assert.deepEqual(searchAtlas(idx, 'наложил   вето', 5).hits.map((h) => h.node.id), ['history/a'])
})

// ── Загрузка текстов ───────────────────────────────────────────────────

beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }))
afterEach(() => mock.timers.reset())

const turn = () => new Promise((resolve) => setImmediate(resolve))

test('тексты: удачный ответ — объект строк', async () => {
  const get = async (url) => {
    assert.equal(url, 'texts.json')
    return { ok: true, status: 200, json: async () => ({ 'adr/one': 'текст' }) }
  }
  assert.deepEqual(await fetchTexts(get), { 'adr/one': 'текст' })
})

test('тексты: 404 и не объект — отказ', async () => {
  await assert.rejects(fetchTexts(async () => ({ ok: false, status: 404 })))
  await assert.rejects(fetchTexts(async () => ({ ok: true, status: 200, json: async () => [1, 2] })))
  await assert.rejects(fetchTexts(async () => ({ ok: true, status: 200, json: async () => null })))
})

test('тексты: сервер молчит — отказ ровно на сроке схемы, запрос отменён', async () => {
  let signal
  const get = (url, init) =>
    new Promise((_, reject) => {
      signal = init.signal
      init.signal.addEventListener('abort', () => reject(init.signal.reason))
    })
  let settled = false
  const attempt = fetchTexts(get).then(
    () => (settled = 'ok'),
    () => (settled = 'fail'),
  )
  mock.timers.tick(LOAD_LIMIT_MS - 1)
  await turn()
  assert.equal(settled, false)
  mock.timers.tick(1)
  await attempt
  assert.equal(settled, 'fail')
  assert.equal(signal.aborted, true)
})

// ── Разметка и тексты страницы ─────────────────────────────────────────

const WEB = new URL('../web/', import.meta.url)
const HTML = readFileSync(new URL('index.html', WEB), 'utf8')
const tagOf = (id) => HTML.match(new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`))?.[0]

test('в витрине нет глубины, «весь граф», флажка «Объём» и цепи цикла в строке вида', () => {
  for (const file of readdirSync(WEB)) {
    const text = readFileSync(new URL(file, WEB), 'utf8')
    for (const banned of ['name="depth"', 'id="full"', 'id="volume"', 'depth-note', '1 шаг', '2 шага', 'Показать весь граф', 'Цикл дня: '])
      assert.equal(text.includes(banned), false, `${file}: ${banned}`)
  }
})

test('«Плоский вид» — два флажка с видимой меткой, недоступные до загрузки схемы', () => {
  for (const id of ['flat', 'map-flat']) {
    assert.match(tagOf(id) ?? '', /type="checkbox"/, id)
    assert.match(tagOf(id) ?? '', /\sdisabled[\s>]/, id)
  }
  assert.equal((HTML.match(/Плоский вид<\/span>/g) ?? []).length, 2)
  assert.match(tagOf('flat'), /aria-describedby="flat-note"/)
})

test('метка поиска и имя блока фильтров', () => {
  assert.match(HTML, /<label[^>]*for="q"[^>]*>Поиск по заголовкам и тексту<\/label>/)
  assert.match(HTML, /<summary>Фильтры по типу<\/summary>/)
  assert.match(tagOf('texts-retry') ?? '', /\shidden[\s>]/)
})
