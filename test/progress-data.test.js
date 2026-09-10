// Проверка данных страницы прогресса. Правила — site/progress/validate.js,
// тот же файл, которым страница отбирает строки; формат —
// agent_docs/design/2026-09-14-1300-progress-page.md, раздел «Файл данных».
// Тест лежит вне site/: каталог отдаётся Caddy целиком как корень сайта.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../site/progress/validate.js'
import '../site/progress/data.js'

const { dataProblems, prProblems, itemProblems, publicProblems } = globalThis.PROGRESS_CHECK
const KEYS = ['days', 'process']
const good = () => ({
  n: 47,
  merged: '2026-09-10',
  type: 'feat',
  stream: 'process',
  cls: 'A',
  result: 'Фреймворк v2: модели по ролям, классы гейтов A/B/C',
  goal: 'Точнее и дешевле работа агентов',
})

test('данные страницы проходят проверку полей без находок', () => {
  assert.deepEqual(dataProblems(globalThis.PROGRESS), [])
})

test('данные страницы не содержат адресов и приватных следов', () => {
  assert.deepEqual(publicProblems(globalThis.PROGRESS), [])
})

test('правильная строка PR проходит', () => {
  assert.deepEqual(prProblems(good(), KEYS), [])
})

test('строка без goal не проходит', () => {
  const pr = good()
  delete pr.goal
  assert.ok(prProblems(pr, KEYS).length > 0)
})

test('строка без класса проходит: классов до PR #47 не было', () => {
  const pr = good()
  delete pr.cls
  assert.deepEqual(prProblems(pr, KEYS), [])
})

test('номер PR — целое не меньше 1', () => {
  for (const n of [0, -1, 1.5, '4', undefined]) {
    assert.ok(prProblems({ ...good(), n }, KEYS).length > 0, `n=${n}`)
  }
})

test('дата мержа — только YYYY-MM-DD', () => {
  for (const merged of ['2026-9-10', '2026-09-10T04:27:00Z', '10.09.2026', '2026-13-01', '']) {
    assert.ok(prProblems({ ...good(), merged }, KEYS).length > 0, merged)
  }
})

test('тип — префикс Conventional Commits из списка', () => {
  assert.ok(prProblems({ ...good(), type: 'feature' }, KEYS).length > 0)
  for (const type of ['feat', 'fix', 'docs', 'chore', 'test', 'refactor']) {
    assert.deepEqual(prProblems({ ...good(), type }, KEYS), [], type)
  }
})

test('поток — один из ключей streams', () => {
  assert.ok(prProblems({ ...good(), stream: 'atlas' }, KEYS).length > 0)
})

test('класс — только A, B или C', () => {
  assert.ok(prProblems({ ...good(), cls: 'D' }, KEYS).length > 0)
  assert.ok(prProblems({ ...good(), cls: '' }, KEYS).length > 0)
})

test('итог не длиннее 100 знаков, цель — 80, обе не пустые', () => {
  assert.deepEqual(prProblems({ ...good(), result: 'я'.repeat(100), goal: 'я'.repeat(80) }, KEYS), [])
  assert.ok(prProblems({ ...good(), result: 'я'.repeat(101) }, KEYS).length > 0)
  assert.ok(prProblems({ ...good(), goal: 'я'.repeat(81) }, KEYS).length > 0)
  assert.ok(prProblems({ ...good(), result: '   ' }, KEYS).length > 0)
})

test('пункт «Сейчас в работе»: этап ≤ 24, заголовок ≤ 100, текст ≤ 300', () => {
  const item = { stage: 'разработка', title: 'Заголовок', text: 'Текст' }
  assert.deepEqual(itemProblems(item), [])
  assert.ok(itemProblems({ ...item, stage: 'я'.repeat(25) }).length > 0)
  assert.ok(itemProblems({ ...item, title: 'я'.repeat(101) }).length > 0)
  assert.ok(itemProblems({ ...item, text: 'я'.repeat(301) }).length > 0)
  assert.ok(itemProblems({ stage: 'раскладка', text: 'Текст' }).length > 0)
})

const data = () => ({
  now: { updated: '2026-09-10T15:00Z', items: [] },
  streams: [
    { key: 'days', label: 'Дни задания' },
    { key: 'process', label: 'Процесс' },
  ],
  prs: [
    { ...good(), n: 1, cls: undefined },
    { ...good(), n: 2 },
  ].map((p) => JSON.parse(JSON.stringify(p))),
})

test('минимальные данные проходят', () => {
  assert.deepEqual(dataProblems(data()), [])
})

test('номера PR уникальны и идут по возрастанию', () => {
  const d = data()
  d.prs[1].n = 1
  assert.ok(dataProblems(d).length > 0)
  const e = data()
  e.prs.reverse()
  assert.ok(dataProblems(e).length > 0)
})

test('now.updated — ISO 8601 в UTC с Z', () => {
  for (const updated of ['2026-09-10 15:00', '2026-09-10T15:00+07:00', '2026-09-10', undefined]) {
    const d = data()
    d.now.updated = updated
    assert.ok(dataProblems(d).length > 0, String(updated))
  }
})

test('в now.items не больше пяти пунктов', () => {
  const d = data()
  d.now.items = Array.from({ length: 6 }, () => ({ stage: 'ревью', title: 'Т', text: 'Т' }))
  assert.ok(dataProblems(d).length > 0)
})

test('ключи потоков уникальны, у каждого есть имя', () => {
  const d = data()
  d.streams.push({ key: 'days', label: 'Ещё раз' })
  assert.ok(dataProblems(d).length > 0)
  const e = data()
  e.streams[0].label = ''
  assert.ok(dataProblems(e).length > 0)
})

test('кривой верхний уровень — находка, а не исключение', () => {
  for (const bad of [undefined, null, 5, [], { prs: 'нет' }]) {
    assert.ok(dataProblems(bad).length > 0, JSON.stringify(bad))
  }
})

test('в тексте нельзя адресов, приватных следов и обращения к владельцу', () => {
  const texts = [
    'подробности на https://example.com',
    'см. www.example.com',
    'сервер 203.0.113.7',
    'ноутбук в mac.tail1234.ts.net',
    'выгружено в Google Drive',
    'файл /Users/mike/Projects',
    'каталог /private/tmp/x',
    'по вашей просьбе',
    'Вам пришло',
  ]
  for (const text of texts) {
    const d = data()
    d.prs[0].result = text
    assert.ok(publicProblems(d).length > 0, text)
  }
  // «Выкатка» начинается с «вы»: обращение ловится по «ваш», «вам», а не по «вы».
  const ok = data()
  ok.now.items = [{ stage: 'ревью', title: 'Ок', text: 'Выкатка прошла, в PR #62 идут reviewer и design-review.' }]
  assert.deepEqual(publicProblems(ok), [])
})
