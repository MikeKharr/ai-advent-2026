// Прогон против ЗАГЛУШКИ публичного API дня на локальном порту (ADR
// 2026-10-05-0544, п. 1.5). Настоящий API дня 23 здесь не участвует, модель,
// реранкер и служба поиска — тем более: предмет проверки это прогон, и только он.
//
// Стенд НЕ пересказывает представление автора о дне: он записывает всё, что
// получил, в журнал `seen` и отдаёт то, что ему велено. Поэтому «запрос дошёл»
// доказывается записью журнала, а не кодом ответа.
//
// ЧЕМ СТЕНД ОТЛИЧАЕТСЯ ОТ ПРОДА — названо здесь, а не подразумевается:
//   — ответов модели нет вовсе: `candidates` и `sources` стенд выдумывает
//     строками теста, денег они не стоят и от Haiku не зависят;
//   — лимитера нет вовсе: 429 стенд отдаёт по приказу теста, а не по окну, и
//     `retryAfterSec` в его ответе — тоже приказ теста;
//   — поиска и индекса нет: `index` стенд выдумывает.
// Что отсюда НЕ следует: что прогон по проду даст такие же ранги. Следует
// только одно — что прогон верно читает то, что получил, и верно отличает
// суточный потолок от окна на адрес.

import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { parseEnv } from '../env.js'
import { MODES, PICK_COUNT } from '../eval/score.mjs'
import { indexOf, isDailyLimit, main, measuredPairs, parseEnd, runAll, runOne, SPACING_MS } from '../eval/run.mjs'

const INV = 'agent_docs/invariants.md'

/** @type {{method:string,url:string,headers:object,body:string}[]} журнал стенда */
let seen = []
/** Что стенд делает с очередным запросом. Приказ теста, не поведение дня. */
let plan = {}
/** Сколько запусков идёт одновременно: больше одного — прогон не последователен. */
let inFlight = 0
let maxInFlight = 0

const endFrame = (payload) => `event: end\ndata: ${JSON.stringify(payload)}\n\n`

const frag = (n, source) => ({ n, source, section: '', score: 0.5 })

const succeeded = (over = {}) =>
  endFrame({
    status: 'succeeded',
    result: {
      outcome: 'answered',
      candidates: [frag(1, 'прочее.md'), frag(2, INV)],
      sources: [frag(2, INV)],
      index: { commit: 'стенд-коммит', strategy: 'structural', chunks: 7 },
      ...over,
    },
  })

const day = http.createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  seen.push({
    method: req.method,
    url: req.url,
    headers: { ...req.headers },
    body: Buffer.concat(chunks).toString(),
  })

  if (req.url === '/api/runs') {
    // Приказ теста может быть разным на каждый по счёту запуск: суточный
    // потолок на проде наступает посередине набора, а не с первого запроса.
    const posted = seen.filter((r) => r.url === '/api/runs').length
    const order = plan.createByCall?.[posted]
    const create = order ?? plan.create
    if (create && create.status !== 202) {
      res.writeHead(create.status, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(create.body ?? {}))
    }
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    res.writeHead(202, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ runId: `run-${posted}` }))
  }

  if (req.url.endsWith('/events')) {
    inFlight -= 1
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    // Кадры отдаются ровно теми куска́ми, какие назвал тест: границы кусков —
    // предмет проверки разбора, и склеивать их здесь нельзя. `piecesByCall`
    // задаёт поток по счёту открытия: прогон по проду чередует отказы и
    // удачи, и воспроизвести это чередование надо так же.
    const opened = seen.filter((r) => r.url.endsWith('/events')).length
    for (const piece of plan.piecesByCall?.[opened] ?? plan.pieces ?? [succeeded()]) res.write(piece)
    return res.end()
  }

  res.writeHead(404)
  res.end()
})

await new Promise((resolve) => day.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${day.address().port}`
after(() => day.close())

const ask = (id, over = {}) => ({ id, question: `вопрос ${id}`, expect: [INV], ...over })

function reset(next = {}) {
  seen = []
  plan = next
  inFlight = 0
  maxInFlight = 0
}

/**
 * Эталон во временном файле: форма та же, что у `rag/eval/queries.json`.
 *
 * Между названными вопросами кладётся по два НЕОТБИРАЕМЫХ — иначе отбор
 * «каждый третий» взял бы из файла один вопрос вместо двух, и проверка мерила
 * бы не то.
 */
function queriesFile(ids) {
  const dir = mkdtempSync(join(tmpdir(), 'day23-'))
  const file = join(dir, 'queries.json')
  const queries = ids.flatMap((id, at) => [
    { id, question: `вопрос ${id}`, expected: [INV] },
    { id: `набивка${at}a`, question: 'набивка', expected: [INV] },
    { id: `набивка${at}b`, question: 'набивка', expected: [INV] },
  ])
  writeFileSync(file, JSON.stringify({ queries }))
  return { dir, file }
}

test('запрос дошёл до стенда: его журнал несёт вопрос, режим и путь', async () => {
  reset()
  const got = await runOne({ base, question: ask('q01'), mode: 'rerank' })
  assert.ok(got.result, `ожидался ответ, получен отказ: ${JSON.stringify(got.failure)}`)
  assert.equal(seen.length, 2, 'создание запуска и поток событий')
  assert.equal(seen[0].method, 'POST')
  assert.equal(seen[0].url, '/api/runs')
  assert.deepEqual(JSON.parse(seen[0].body), { question: 'вопрос q01', mode: 'rerank' })
  assert.match(seen[1].url, /^\/api\/runs\/run-1\/events$/)
})

test('прогон не предъявляет дню никакого ключа — предъявлять нечего (I-3)', async () => {
  reset()
  await runOne({ base, question: ask('q01'), mode: 'rerank' })
  // Проверяется ЖУРНАЛ СТЕНДА, то есть то, что реально ушло в сеть.
  for (const request of seen) {
    assert.equal(request.headers.authorization, undefined, `${request.url}: заголовок ключа`)
    assert.equal(request.headers['x-api-key'], undefined, `${request.url}: заголовок ключа`)
  }
})

test('набор идёт режим за режимом: сначала все rerank, потом все rewrite', async () => {
  reset()
  const waits = []
  const { runs, stopped } = await runAll({
    base,
    questions: [ask('q01'), ask('q04')],
    sleep: async (ms) => waits.push(ms),
    log: () => {},
  })
  assert.equal(stopped, null)
  assert.deepEqual([...runs.keys()], ['q01:rerank', 'q04:rerank', 'q01:rewrite', 'q04:rewrite'])
  // Пауза перед каждым запуском, кроме первого, и своя у каждого режима.
  assert.deepEqual(waits, [SPACING_MS.rerank, SPACING_MS.rewrite, SPACING_MS.rewrite])
  assert.equal(maxInFlight, 1, 'запуски шли не по одному — окна дня и службы дали бы 429')
})

/**
 * Величина паузы, а не её существование.
 *
 * ЧТО ЭТО ДЕРЖИТ. Проверка выше сверяет паузы с САМИМИ константами, поэтому
 * проходит при любом их значении: `SPACING_MS.rerank = 100` оставался бы
 * зелёным, а 30 запусков ушли бы за 3 секунды и получили 429 от окна дня,
 * обнулив часть набора (мутация `reviewer` к PR #304 на дне 22). Поэтому здесь
 * утверждается неравенство к ВЫВЕДЕННОМУ из окна числу, а не равенство
 * константы себе.
 */
test('паузы не уже окон: окно дня 5 в минуту, окно службы поиска 10 в минуту', () => {
  const MINUTE_MS = 60_000
  // Числа берутся ИЗ ОКРУЖЕНИЯ ДНЯ, а не стоят здесь копией: сузится окно —
  // покраснеет эта проверка, а не прогон по проду на тридцатом запуске.
  const { env } = parseEnv({ AGENT_KEY: 'для-разбора-окружения' })
  assert.equal(env.RATE_LIMIT_PER_MIN, 5, 'окно дня сменилось — паузы прогона пересчитываются')
  const dayFloor = MINUTE_MS / env.RATE_LIMIT_PER_MIN
  assert.equal(dayFloor, 12_000)
  for (const mode of MODES)
    assert.ok(
      SPACING_MS[mode] >= dayFloor,
      `пауза ${mode} ${SPACING_MS[mode]} мс уже окна дня (${dayFloor} мс на запуск)`,
    )

  // Окно службы `rag` — 10 поисков в минуту на весь хост, и режим `rewrite`
  // делает ДВА поиска на запуск. Отсюда его пауза и шире: это чужое окно, и
  // поднять его из дня 23 нельзя.
  const RAG_SEARCHES_PER_MIN = 10
  const searchFloor = (MINUTE_MS / RAG_SEARCHES_PER_MIN) * 2
  assert.ok(
    SPACING_MS.rewrite >= searchFloor,
    `пауза rewrite ${SPACING_MS.rewrite} мс уже окна службы поиска (${searchFloor} мс на два поиска)`,
  )
  assert.ok(SPACING_MS.rewrite > SPACING_MS.rerank, 'пауза режима с двумя поисками не шире, чем у режима с одним')
})

test('429 окна на адрес — не конец прогона: его пережидают и вопрос повторяют', async () => {
  // Часовое окно (30 запусков на адрес) срабатывает ровно на границе между
  // режимами, и потерять на нём вопрос значило бы потерять пару сравнения.
  reset({
    createByCall: { 1: { status: 429, body: { error: 'Предел запросов страницы.', retryAfterSec: 42 } } },
  })
  const waits = []
  const { runs, stopped } = await runAll({
    base,
    questions: [ask('q01')],
    sleep: async (ms) => waits.push(ms),
    log: () => {},
  })
  assert.equal(stopped, null, 'окно на адрес принято за конец суточного потолка')
  assert.ok(runs.get('q01:rerank')?.result, 'вопрос потерян на окне, которое надо было переждать')
  assert.ok(waits.includes(43_000), `не ждали названных лимитером секунд: ${waits.join(', ')}`)
})

test('429 БЕЗ секунд до повтора — суточный потолок: приём кончается, сделанное остаётся', async () => {
  // Разделитель — `retryAfterSec`: у суточного потолка его нет вовсе
  // (`days/day23/limits.js`, `reserve`), и это разница по сути, а не по тексту
  // сообщения. Копии строк лимитера прогон не держит.
  reset({ createByCall: { 2: { status: 429, body: { error: 'Суточный предел вопросов дня исчерпан.' } } } })
  const { runs, stopped } = await runAll({
    base,
    questions: [ask('q01'), ask('q04'), ask('q07')],
    sleep: async () => {},
    log: () => {},
  })
  assert.ok(stopped, 'суточный потолок не остановил приём')
  assert.equal(stopped.at, 'q04:rerank')
  assert.ok(runs.get('q01:rerank')?.result, 'сделанное до потолка потеряно')
  // После потолка прогон НЕ ДОЛБИТ день остатком набора: ни одного запроса
  // больше, и доказывается это журналом стенда.
  assert.equal(seen.filter((r) => r.url === '/api/runs').length, 2, 'прогон продолжил стучаться после потолка')
  assert.equal(runs.size, 1)
})

test('суточный потолок отличается от окна по полю, а не по словам сообщения', () => {
  assert.equal(isDailyLimit({ code: 'http_429', retryAfterSec: null }), true)
  assert.equal(isDailyLimit({ code: 'http_429' }), true)
  assert.equal(isDailyLimit({ code: 'http_429', retryAfterSec: 42 }), false)
  assert.equal(isDailyLimit({ code: 'search_empty', message: 'суточный предел' }), false, 'отказ поиска принят за потолок')
})

test('отказ запуска становится результатом прогона, а не его аварией', async () => {
  reset({
    pieces: [endFrame({ status: 'failed', error: { code: 'search_refused', message: 'отказ службы' } })],
  })
  const got = await runOne({ base, question: ask('q01'), mode: 'rerank' })
  assert.deepEqual(got, { failure: { code: 'search_refused', message: 'отказ службы' } })
})

test('кадр end, разорванный по куска́м сети, всё равно разбирается', async () => {
  const frame = succeeded({ outcome: 'unknown_filter', sources: [] })
  reset({ pieces: [': ping\n\n', frame.slice(0, 14), frame.slice(14, 40), frame.slice(40)] })
  const got = await runOne({ base, question: ask('q01'), mode: 'rerank' })
  assert.equal(got.result?.outcome, 'unknown_filter')
})

test('поток кончился без кадра end — это отказ, а не пустой ответ', async () => {
  reset({ pieces: ['event: event\ndata: {"stage":"rpc"}\n\n'] })
  const got = await runOne({ base, question: ask('q01'), mode: 'rerank' })
  assert.equal(got.failure.code, 'no_end')
})

test('разбор потока берёт только кадр end и не путается в служебных строках', () => {
  const state = { buffer: '' }
  assert.equal(parseEnd(': ping\n\nid: 3\nevent: event\ndata: {"a":1}\n\n', state), null)
  assert.deepEqual(parseEnd('id: 4\nevent: end\ndata: {"status":"succeeded"}\n\n', state), { status: 'succeeded' })
})

test('индекс берётся из выдачи поиска, а не выдумывается', async () => {
  reset()
  const { runs } = await runAll({ base, questions: [ask('q01')], sleep: async () => {}, log: () => {} })
  assert.deepEqual(indexOf(runs), { commit: 'стенд-коммит', strategy: 'structural', chunks: 7 })
  // Приём без единого удачного запуска берёт индекс прошлого приёма, а не
  // обнуляет его: второй приём мог упасть на первом же вопросе.
  const none = new Map([['q01:rerank', { failure: { code: 'x', message: 'y' } }]])
  assert.deepEqual(indexOf(none), { commit: null, strategy: null, chunks: null })
  assert.deepEqual(indexOf(none, { commit: 'прошлый', strategy: 's', chunks: 1 }), {
    commit: 'прошлый',
    strategy: 's',
    chunks: 1,
  })
})

test('прогон пишет файл результата с обоими числами каждого вопроса', async () => {
  reset()
  const { dir, file } = queriesFile(['q01', 'q04'])
  const out = join(dir, 'eval.json')
  const code = await main({
    argv: ['--base', base, '--out', out, '--queries', file, '--note', 'прогон стенда'],
    sleep: async () => {},
    log: () => {},
    now: () => new Date('2026-10-05T09:00:00.000Z'),
  })
  assert.equal(code, 0)
  const report = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(report.at, '2026-10-05T09:00:00.000Z')
  assert.equal(report.index.commit, 'стенд-коммит')
  assert.equal(report.note, 'прогон стенда')
  assert.equal(report.questionsTotal, 2)
  // Набивка эталона в прогон не попала: платить за неё было бы не за что.
  assert.deepEqual(
    report.questions.map((q) => q.id),
    ['q01', 'q04'],
  )
  for (const mode of MODES) {
    assert.equal(report.modes[mode].ran, 2, `${mode}: прогнано не два вопроса`)
    assert.deepEqual(report.questions[0][mode].before, { recall5: 1, mrr10: 0.5 })
    assert.deepEqual(report.questions[0][mode].after, { recall5: 1, mrr10: 1 })
  }
})

test('файл пишется ПОСЛЕ КАЖДОГО запуска, поэтому обрыв приёма ничего не теряет', async () => {
  // ЧТО ЭТО ДЕРЖИТ, и цена названа по факту: приём идёт больше часа, и первый
  // приём дня 23 пришлось прервать на пятнадцати измеренных вопросах — они
  // пропали вместе с процессом, то есть пятнадцать оплаченных запусков надо
  // было оплачивать заново. Запись в конце приёма этого не ловит никак.
  reset()
  const { dir, file } = queriesFile(['q01', 'q04'])
  const out = join(dir, 'eval.json')
  const seenAfterEachRun = []
  await main({
    argv: ['--base', base, '--out', out, '--queries', file],
    // Снимок файла берётся В ПАУЗЕ между запусками, то есть ровно там, где
    // настоящий прогон живёт большую часть времени и где его обрывают.
    sleep: async () => seenAfterEachRun.push(JSON.parse(readFileSync(out, 'utf8'))),
    log: () => {},
  })
  assert.equal(seenAfterEachRun.length, 3, 'пауз было не три — проверено не то')
  // Уже на первой паузе файл цел и несёт первый измеренный вопрос.
  assert.ok(seenAfterEachRun[0].questions[0].rerank, 'после первого запуска файла ещё нет')
  assert.equal(seenAfterEachRun[0].modes.rerank.ran, 1)
  // И дальше он только пополняется — ни один снимок не пуст и не обнулён.
  const ranByPause = seenAfterEachRun.map((r) => MODES.reduce((s, m) => s + (r.modes[m]?.ran ?? 0), 0))
  assert.deepEqual(ranByPause, [1, 2, 3], `файл на паузах: ${ranByPause.join(', ')}`)
})

test('готовый файл результата повтором прогона не затирается без флага', async () => {
  reset()
  const { dir, file } = queriesFile(['q01'])
  const out = join(dir, 'eval.json')
  writeFileSync(out, '{"at":"прошлый приём"}')
  const code = await main({
    argv: ['--base', base, '--out', out, '--queries', file],
    sleep: async () => {},
    log: () => {},
  })
  assert.equal(code, 1)
  // ЧТО ЭТО ДЕРЖИТ: повтор стоит ещё до 60 платных запусков. Доказательство не
  // в коде возврата, а в том, что НИ ОДНОГО запроса к дню не ушло.
  assert.equal(seen.length, 0, 'прогон начался вопреки отказу')
  assert.equal(readFileSync(out, 'utf8'), '{"at":"прошлый приём"}')
})

test('--resume дописывает недостающее и за измеренное второй раз не платит', async () => {
  // ПРЯМОЙ ПРЕДМЕТ ВТОРОГО ПРИЁМА: приём может кончиться раньше набора, и
  // остаток дописывает следующий тем же раннером с `--resume`. Набор из 60
  // запусков в суточный потолок дня ВЛЕЗАЕТ — он 150 (ADR 2026-10-05-1004),
  // ждать полуночи UTC не нужно; кончиться приёму раньше набора есть от чего
  // другого — обрыв связи, а потолок день всё равно может исчерпать чужими
  // запусками. Здесь стенд отдаёт на втором создании 429 без `retryAfterSec`,
  // то есть ровно признак конца потолка, и проверяется, что приём на нём
  // останавливается, а не теряет остаток.
  reset({ createByCall: { 2: { status: 429, body: { error: 'Суточный предел исчерпан.' } } } })
  const { dir, file } = queriesFile(['q01', 'q04'])
  const out = join(dir, 'eval.json')
  await main({ argv: ['--base', base, '--out', out, '--queries', file], sleep: async () => {}, log: () => {} })
  const first = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(first.modes.rerank.ran, 1, 'приём 1 измерил не один вопрос — проверено не то')
  assert.equal(first.modes.rewrite, null)
  assert.ok(
    first.failures.some((f) => f.code === 'day_limit'),
    'причина конца приёма не доехала до файла',
  )
  assert.deepEqual([...measuredPairs(first)], ['q01:rerank'])

  reset()
  const code = await main({
    argv: ['--base', base, '--out', out, '--queries', file, '--resume'],
    sleep: async () => {},
    log: () => {},
  })
  assert.equal(code, 0)
  const second = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(second.modes.rerank.ran, 2, 'приём 2 не дописал rerank')
  assert.equal(second.modes.rewrite.ran, 2)
  assert.ok(second.questions[0].rerank, 'приём 2 затёр измеренное приёмом 1')
  assert.ok(
    !second.failures.some((f) => f.code === 'day_limit'),
    'отказ остался в файле, хотя вопрос измерен',
  )
  // За уже измеренную пару второй раз не плачено: её в журнале стенда нет.
  const posted = seen.filter((r) => r.url === '/api/runs').map((r) => JSON.parse(r.body))
  assert.equal(posted.length, 3, `повторно оплачено лишнее: ${JSON.stringify(posted)}`)
  assert.ok(
    !posted.some((p) => p.question === 'вопрос q01' && p.mode === 'rerank'),
    'измеренная приёмом 1 пара прогнана и оплачена второй раз',
  )
})

test('индекс сменился — приём отказывается дописывать и файл НЕ ТРОГАЕТ', async () => {
  // ЧТО ЭТО ДЕРЖИТ, и повод не выдуманный: приём 1 дня 23 шёл во время
  // пересборки корпуса и мерил индекс `1d4a85f8` (3337 чанков structural), а
  // после неё живым стал `37ff5e8e` (3365). Числа с двух индексов несравнимы
  // (ADR, п. 1.5), а `--resume` слил бы их МОЛЧА: уже измеренные пары он
  // пропускает, и в одном отчёте оказались бы половины с разных индексов —
  // под одной строкой `index.commit`.
  // Приём 1 обрывается суточным потолком на одной паре — иначе дописывать
  // было бы нечего и сверка индекса не сработала бы вовсе.
  reset({ createByCall: { 2: { status: 429, body: { error: 'Суточный предел исчерпан.' } } } })
  const { dir, file } = queriesFile(['q01', 'q04'])
  const out = join(dir, 'eval.json')
  await main({ argv: ['--base', base, '--out', out, '--queries', file], sleep: async () => {}, log: () => {} })
  const before = readFileSync(out, 'utf8')
  assert.match(before, /стенд-коммит/, 'приём 1 не записал индекс — проверено не то')
  assert.ok(JSON.parse(before).questions[0].rerank, 'приём 1 не измерил ни одной пары — проверено не то')

  // Стенд начинает отдавать ДРУГОЙ индекс: ровно то, что делает пересборка.
  reset({ pieces: [succeeded({ index: { commit: 'другой-коммит', strategy: 'structural', chunks: 9 } })] })
  const said = []
  const code = await main({
    argv: ['--base', base, '--out', out, '--queries', file, '--resume'],
    sleep: async () => {},
    log: (m) => said.push(String(m)),
  })
  assert.equal(code, 1, 'дописывание по другому индексу прошло успехом')
  assert.equal(readFileSync(out, 'utf8'), before, 'файл тронут, хотя дописывать было нельзя')
  assert.ok(
    said.some((m) => m.includes('индекс сменился')),
    `причина не названа вслух: ${said.join(' | ')}`,
  )
  // Обрыв — на ПЕРВОМ же запуске: потолок не тратится на весь набор впустую.
  assert.equal(seen.filter((r) => r.url === '/api/runs').length, 1, 'приём продолжил платить после смены индекса')
})

test('отказ ПЕРЕД сменой индекса не даёт тронуть файл раньше сверки', async () => {
  // ЧТО ЭТО ДЕРЖИТ: гарантию «файл не тронут» из проверки выше. Там первый же
  // запуск приёма 2 удачен, поэтому обрыв случается до всякой записи, и
  // гарантия держалась сама собой. На проде так не бывает: в этот день отказы
  // чередовались с удачами постоянно, а ОТКАЗ в файл пишется (он попадает в
  // `failures`). Без ожидания сверки приём успел бы записать файл заново — с
  // новой датой и чужими `failures`, — и строка «файл не тронут» стала бы
  // неправдой при зелёном прогоне.
  reset({ createByCall: { 2: { status: 429, body: { error: 'Суточный предел исчерпан.' } } } })
  const { dir, file } = queriesFile(['q01', 'q04'])
  const out = join(dir, 'eval.json')
  await main({ argv: ['--base', base, '--out', out, '--queries', file], sleep: async () => {}, log: () => {} })
  const before = readFileSync(out, 'utf8')

  // Приём 2: СНАЧАЛА отказ, потом удача с другим индексом.
  reset({
    piecesByCall: {
      1: [endFrame({ status: 'failed', error: { code: 'search_failed', message: 'служба молчит' } })],
      2: [succeeded({ index: { commit: 'другой-коммит', strategy: 'structural', chunks: 9 } })],
    },
  })
  const code = await main({
    argv: ['--base', base, '--out', out, '--queries', file, '--resume'],
    sleep: async () => {},
    log: () => {},
  })
  assert.equal(code, 1, 'дописывание по другому индексу прошло успехом')
  assert.equal(seen.filter((r) => r.url === '/api/runs').length, 2, 'отказ и удача — проверено не то')
  assert.equal(readFileSync(out, 'utf8'), before, 'файл тронут отказом до сверки индекса')
})

test('--check сверяет форму лежащего файла и называет недостающее', async () => {
  reset()
  const { dir, file } = queriesFile(['q01'])
  const out = join(dir, 'eval.json')
  writeFileSync(out, JSON.stringify({ at: '', index: {}, questions: [] }))
  const said = []
  const code = await main({ argv: ['--check', '--out', out, '--queries', file], log: (m) => said.push(String(m)) })
  assert.equal(code, 1)
  assert.ok(said.some((m) => m.includes('нет даты прогона')), said.join(' | '))
  assert.ok(said.some((m) => m.includes('нет коммита индекса')), said.join(' | '))
  assert.ok(said.some((m) => m.includes('вопросов 0, а в наборе 1')), said.join(' | '))
  assert.equal(seen.length, 0, 'сверка формы в сеть не ходит')
})

test('по умолчанию прогон берёт эталон службы поиска и отбирает из него 30 вопросов', async () => {
  // Второй копии вопросов у дня 23 нет вовсе (урок дня 22, находка `reviewer`
  // к PR #304): набор задаётся правилом поверх `rag/eval/queries.json`. Здесь
  // проверяется, что раннер по умолчанию читает именно его.
  reset({ create: { status: 429, body: { error: 'Суточный предел исчерпан.' } } })
  const dir = mkdtempSync(join(tmpdir(), 'day23-'))
  const out = join(dir, 'eval.json')
  const said = []
  await main({ argv: ['--base', base, '--out', out], sleep: async () => {}, log: (m) => said.push(String(m)) })
  const report = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(report.questionsTotal, PICK_COUNT)
  assert.equal(report.questions[0].id, 'q01')
  assert.equal(report.questions[1].id, 'q04')
  assert.equal(report.questions.at(-1).id, 'q88')
})
