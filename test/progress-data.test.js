// Проверка данных страницы прогресса. Правила — site/progress/validate.js,
// тот же файл, которым страница отбирает строки; формат —
// agent_docs/design/2026-09-14-1300-progress-page.md, раздел «Файл данных».
// Тест лежит вне site/: каталог отдаётся Caddy целиком как корень сайта.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import '../site/progress/validate.js'
import '../site/progress/data.js'

const { dataProblems, prProblems, prFieldProblems, itemProblems, publicProblems } = globalThis.PROGRESS_CHECK
// Публичность проверяется по сырому тексту: Caddy отдаёт файл целиком,
// с комментариями и любыми полями, а не только те, что рисует страница.
const RAW = readFileSync(new URL('../site/progress/data.js', import.meta.url), 'utf8')
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

test('сырой текст data.js не содержит адресов и приватных следов', () => {
  assert.deepEqual(publicProblems(RAW), [])
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

test('строка PR с неизвестным полем не проходит', () => {
  assert.ok(prProblems({ ...good(), src: 'заметка' }, KEYS).length > 0)
})

// Страница отбирает строки по полям, а лишние ловит CI: иначе строка с лишним
// полем пропала бы под текстом «не хватает полей», который про неё неправ.
test('лишнее поле не мешает странице нарисовать строку', () => {
  assert.deepEqual(prFieldProblems({ ...good(), src: 'заметка' }, KEYS), [])
  assert.ok(prFieldProblems({ ...good(), goal: undefined }, KEYS).length > 0)
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

test('пункт «Сейчас в работе» с неизвестным полем не проходит', () => {
  assert.ok(itemProblems({ stage: 'ревью', title: 'Т', text: 'Т', link: 'заметка' }).length > 0)
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

test('ключ потока — слово латиницей, а не путь', () => {
  for (const key of ['/tmp/x', 'a/b', 'Дни', 'days one']) {
    const d = data()
    d.streams[0].key = key
    d.prs.forEach((p) => {
      p.stream = key
    })
    assert.ok(dataProblems(d).length > 0, key)
  }
})

test('неизвестные поля на любом уровне — находка', () => {
  const top = { ...data(), extra: 1 }
  assert.ok(dataProblems(top).length > 0, 'верхний уровень')
  const now = data()
  now.now.src = 'x'
  assert.ok(dataProblems(now).length > 0, 'now')
  const stream = data()
  stream.streams[0].url = 'x'
  assert.ok(dataProblems(stream).length > 0, 'streams[]')
  const pr = data()
  pr.prs[0].src = 'x'
  assert.ok(dataProblems(pr).length > 0, 'prs[]')
  const item = data()
  item.now.items = [{ stage: 'ревью', title: 'Т', text: 'Т', src: 'x' }]
  assert.ok(dataProblems(item).length > 0, 'now.items[]')
})

test('кривой верхний уровень — находка, а не исключение', () => {
  for (const bad of [undefined, null, 5, [], { prs: 'нет' }]) {
    assert.ok(dataProblems(bad).length > 0, JSON.stringify(bad))
  }
})

// Каждая категория «что можно писать» — отдельный набор утечек. Проверяется
// сырой текст, поэтому утечка ловится и в комментарии, и в любом поле.
const LEAKS = {
  'адрес со схемой': ['подробности на https://example.com', 'ftp://files.example'],
  'адрес с www.': ['см. www.example.com'],
  'временный путь': [
    'отчёт в /tmp/claude-502/-Users-mike/scratchpad/report.md',
    'каталог /private/tmp/x',
    '/var/folders/ab/T/x',
  ],
  'домашний путь': ['файл /Users/mike/Projects', '~/Projects/ai-advent-2026', '/home/deploy/app/.env', '/root/.ssh/key'],
  'домен без схемы': ['claude.ai/code/artifacts/5f3a9c', 'витрина на challenge.zpq.ai', 'docs.google.com/document/d/x'],
  'имя хоста': ['ноутбук mac.tail1234.ts.net', 'server.local', 'localhost:8080', 'db.internal'],
  'id Google Drive': ['файл 1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', 'выгружено в Google Drive'],
  email: ['пишите mike@example.com', 'ssh advent@server'],
  'IPv4-адрес': ['сервер 203.0.113.7'],
  'IPv6-адрес': ['tailnet fd7a:115c:a1e0::1', '2001:db8:0:0:0:0:2:1'],
  'обращение к владельцу': ['по вашей просьбе', 'Вам пришло'],
}
for (const [what, texts] of Object.entries(LEAKS)) {
  test(`утечка ловится: ${what}`, () => {
    for (const text of texts) {
      assert.ok(publicProblems(`result: '${text}',`).length > 0, text)
    }
  })
}

test('утечка в комментарии data.js ловится', () => {
  assert.ok(publicProblems(`// черновик: /tmp/x/report.md\nglobalThis.PROGRESS = {}`).length > 0)
})

test('утечка в неизвестном поле ловится: проверяется весь текст', () => {
  assert.ok(publicProblems(`{ n: 1, src: 'drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012' },`).length > 0)
})

test('обычный текст журнала — не утечка', () => {
  const ok = [
    'Выкатка прошла, в PR #62 идут reviewer и design-review.',
    'Сервис router/ без зависимостей в проде',
    'Атлас в проде на /atlas/ отдельной единицей',
    'Приложение ходит в Haiku 4.5 вместо Sonnet 5',
    'Формат — agent_docs/design/2026-09-14-1300-progress-page.md.',
    'Установлены 25 скиллов addyosmani/agent-skills',
    'Файл site/progress/data.js, обновлено 10 сентября, 15:19 UTC',
    "updated: '2026-09-10T15:19Z',",
    'Скилл /design-review и /day-cycle, запрет --no-index',
    'Скрипт bootstrap.sh готовит сервер',
    'deploy.sh и put-secrets.sh',
    'Новости из Вашингтона',
  ]
  for (const text of ok) assert.deepEqual(publicProblems(text), [], text)
})
