// Прогон против ЗАГЛУШКИ публичного API дня на локальном порту (ADR
// 2026-10-04-0735, п. 6). Настоящий API дня 22 здесь не участвует, модель и
// служба поиска — тем более: предмет проверки это прогон, и только он.
//
// Стенд НЕ пересказывает представление автора о дне: он записывает всё, что
// получил, в журнал `seen` и отдаёт то, что ему велено. Поэтому «запрос дошёл»
// доказывается записью журнала, а не кодом ответа.
//
// Чем стенд отличается от прода, названо здесь, а не подразумевается:
//   — ответы модели подменены строками теста, денег не стоят и не зависят
//     от Haiku;
//   — лимитера нет вовсе: 429 стенд отдаёт по приказу теста, а не по окну;
//   — поиска и индекса нет: `sources` и `index` стенд выдумывает.
// Что отсюда НЕ следует: что прогон по проду даст такие же тексты и такие же
// признаки. Следует только одно — что прогон верно читает то, что получил.

import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { parseEnv } from '../env.js'
import { indexOf, main, parseEnd, runAll, runOne, SPACING_MS } from '../eval/run.mjs'

const DOD = 'agent_docs/guides/dod.md'

/** @type {{method:string,url:string,headers:object,body:string}[]} журнал стенда */
let seen = []
/** Что стенд делает с очередным запросом. Приказ теста, не поведение дня. */
let plan = {}
/** Сколько запусков идёт одновременно: больше одного — прогон не последователен. */
let inFlight = 0
let maxInFlight = 0

const endFrame = (payload) => `event: end\ndata: ${JSON.stringify(payload)}\n\n`

const succeeded = (answer, over = {}) =>
  endFrame({
    status: 'succeeded',
    result: {
      answer,
      refused: false,
      sources: [{ n: 1, source: DOD, section: '', score: 0.7, text: 'т' }],
      index: { commit: 'стенд-коммит', strategy: 'structural' },
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
    if (plan.createStatus && plan.createStatus !== 202) {
      res.writeHead(plan.createStatus, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(plan.createBody ?? {}))
    }
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    res.writeHead(202, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ runId: `run-${seen.length}` }))
  }

  if (req.url.endsWith('/events')) {
    inFlight -= 1
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    // Кадры отдаются ровно теми куска́ми, какие назвал тест: границы кусков —
    // предмет проверки разбора, и склеивать их здесь нельзя.
    for (const piece of plan.pieces ?? [succeeded('ответ стенда')]) res.write(piece)
    return res.end()
  }

  res.writeHead(404)
  res.end()
})

await new Promise((resolve) => day.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${day.address().port}`
after(() => day.close())

const ask = (id, over = {}) => ({
  id,
  origin: id,
  set: 'first',
  question: `вопрос ${id}`,
  expect: 'верный ответ',
  key: 'snapshot.md',
  sources: [DOD],
  ...over,
})

function reset(next = {}) {
  seen = []
  plan = next
  inFlight = 0
  maxInFlight = 0
}

test('запрос дошёл до стенда: его журнал несёт вопрос, режим и путь', async () => {
  reset()
  const got = await runOne({ base, question: ask('q08'), mode: 'rag' })
  assert.ok(got.result, `ожидался ответ, получен отказ: ${JSON.stringify(got.failure)}`)
  assert.equal(seen.length, 2, 'создание запуска и поток событий')
  assert.equal(seen[0].method, 'POST')
  assert.equal(seen[0].url, '/api/runs')
  assert.deepEqual(JSON.parse(seen[0].body), { question: 'вопрос q08', mode: 'rag' })
  assert.match(seen[1].url, /^\/api\/runs\/run-1\/events$/)
})

test('прогон не предъявляет дню никакого ключа — предъявлять нечего (I-3)', async () => {
  reset()
  await runOne({ base, question: ask('q08'), mode: 'rag' })
  // Проверяется ЖУРНАЛ СТЕНДА, то есть то, что реально ушло в сеть.
  for (const request of seen) {
    assert.equal(request.headers.authorization, undefined, `${request.url}: заголовок ключа`)
    assert.equal(request.headers['x-api-key'], undefined, `${request.url}: заголовок ключа`)
  }
})

test('весь набор: по запуску на режим, строго по одному и с паузой между ними', async () => {
  reset()
  const waits = []
  const runs = await runAll({
    base,
    questions: [ask('q08'), ask('q09')],
    sleep: async (ms) => waits.push(ms),
    log: () => {},
  })
  assert.deepEqual([...runs.keys()], ['q08:rag', 'q08:norag', 'q09:rag', 'q09:norag'])
  // Пауза перед каждым запуском, кроме первого: 4 запуска — 3 паузы.
  assert.deepEqual(waits, [SPACING_MS, SPACING_MS, SPACING_MS])
  assert.equal(maxInFlight, 1, 'запуски шли по одному — иначе окна дня и службы дали бы 429')
})

/**
 * Величина паузы, а не её существование.
 *
 * ЧТО ЭТО ДЕРЖИТ. Проверка выше сверяет паузы с САМОЙ КОНСТАНТОЙ, поэтому
 * проходит при любом её значении: `SPACING_MS = 100` оставался зелёным, а 20
 * запусков ушли бы за 2 секунды и получили 429 от окна дня, обнулив часть
 * набора (мутация `reviewer` к PR #304). Окно дня — 5 запусков в минуту
 * (`days/day22/env.js`), то есть на запуск не меньше 12 с; окно службы `rag` —
 * 10 в минуту, оно шире и не связывает.
 *
 * Поэтому здесь утверждается неравенство к ВЫВЕДЕННОМУ из окна числу, а не
 * равенство константы себе: 13 с сверх 12 — запас на расхождение часов.
 */
test('пауза между запусками не уже окна дня: 5 в минуту — это ≥ 12 с на запуск', () => {
  const DAY_WINDOW_MS = 60_000
  // Число берётся ИЗ ОКРУЖЕНИЯ ДНЯ, а не стоит здесь копией: сузится окно —
  // покраснеет эта проверка, а не прогон по проду на двадцатом запуске.
  const { env } = parseEnv({ AGENT_KEY: 'для-разбора-окружения' })
  const floor = DAY_WINDOW_MS / env.RATE_LIMIT_PER_MIN
  assert.equal(env.RATE_LIMIT_PER_MIN, 5, 'окно дня сменилось — пауза прогона пересчитывается')
  assert.equal(floor, 12_000, 'предел окна посчитан не из окна дня')
  assert.ok(
    SPACING_MS >= floor,
    `пауза ${SPACING_MS} мс уже окна дня (${floor} мс на запуск): залп получит 429 и обнулит часть набора`,
  )
})

test('отказ запуска становится результатом прогона, а не его аварией', async () => {
  reset({
    pieces: [
      endFrame({
        status: 'failed',
        error: { code: 'search_refused', message: 'Суточный предел поиска исчерпан' },
      }),
    ],
  })
  const got = await runOne({ base, question: ask('q72'), mode: 'rag' })
  assert.deepEqual(got, {
    failure: { code: 'search_refused', message: 'Суточный предел поиска исчерпан' },
  })
})

test('отказ лимитера дня виден кодом и его словами', async () => {
  reset({ createStatus: 429, createBody: { error: 'Слишком часто. Подождите.', retryAfterSec: 12 } })
  const got = await runOne({ base, question: ask('q08'), mode: 'rag' })
  assert.deepEqual(got, { failure: { code: 'http_429', message: 'Слишком часто. Подождите.' } })
  // Поток событий прогон после отказа не дёргает — и это видно по журналу.
  assert.equal(seen.length, 1)
})

test('кадр end, разорванный по куска́м сети, всё равно разбирается', async () => {
  const frame = succeeded('склеенный ответ')
  reset({ pieces: [': ping\n\n', frame.slice(0, 14), frame.slice(14, 40), frame.slice(40)] })
  const got = await runOne({ base, question: ask('q08'), mode: 'rag' })
  assert.equal(got.result?.answer, 'склеенный ответ')
})

test('поток кончился без кадра end — это отказ, а не пустой ответ', async () => {
  reset({ pieces: ['event: event\ndata: {"stage":"tool_call"}\n\n'] })
  const got = await runOne({ base, question: ask('q08'), mode: 'rag' })
  assert.equal(got.failure.code, 'no_end')
})

test('разбор потока берёт только кадр end и не путается в служебных строках', () => {
  const state = { buffer: '' }
  assert.equal(parseEnd(': ping\n\nid: 3\nevent: event\ndata: {"a":1}\n\n', state), null)
  assert.deepEqual(parseEnd('id: 4\nevent: end\ndata: {"status":"succeeded"}\n\n', state), {
    status: 'succeeded',
  })
})

test('коммит индекса берётся из выдачи поиска, а не выдумывается', async () => {
  reset()
  const runs = await runAll({ base, questions: [ask('q08')], sleep: async () => {}, log: () => {} })
  assert.deepEqual(indexOf(runs), { commit: 'стенд-коммит', strategy: 'structural' })
  // Нет ни одной удачной выдачи — ни коммита, ни стратегии, и это `null`,
  // а не последнее известное значение.
  assert.deepEqual(indexOf(new Map([['q08:rag', { failure: { code: 'x', message: 'y' } }]])), {
    commit: null,
    strategy: null,
  })
})

test('прогон пишет файл результата и оставляет вердикты судье', async () => {
  reset()
  const dir = mkdtempSync(join(tmpdir(), 'day22-'))
  const out = join(dir, 'eval.json')
  const questions = join(dir, 'questions.json')
  writeFileSync(questions, JSON.stringify({ questions: [ask('q08')] }))
  const code = await main({
    argv: ['--base', base, '--out', out, '--questions', questions],
    sleep: async () => {},
    log: () => {},
    now: () => new Date('2026-10-05T01:02:03.000Z'),
  })
  assert.equal(code, 0)
  const report = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(report.ranAt, '2026-10-05T01:02:03.000Z')
  assert.equal(report.index.commit, 'стенд-коммит')
  assert.ok(report.judge.rubric.includes('верно и по источнику'))
  assert.equal(report.judge.name, null, 'имени судьи прогон не выдумывает')
  for (const mode of ['rag', 'norag'])
    assert.equal(report.questions[0].modes[mode].verdict, null, `${mode}: вердикт ставит судья`)
})

test('готовый файл результата повтором прогона не затирается без --force', async () => {
  reset()
  const dir = mkdtempSync(join(tmpdir(), 'day22-'))
  const out = join(dir, 'eval.json')
  const questions = join(dir, 'questions.json')
  writeFileSync(questions, JSON.stringify({ questions: [ask('q08')] }))
  writeFileSync(out, '{"ranAt":"прошлый прогон"}')
  const code = await main({
    argv: ['--base', base, '--out', out, '--questions', questions],
    sleep: async () => {},
    log: () => {},
  })
  assert.equal(code, 1)
  // Что это держит: повтор стоит ещё $0,14 и ещё 10 эмбеддингов. Доказательство
  // не в коде возврата, а в том, что НИ ОДНОГО запроса к дню не ушло.
  assert.equal(seen.length, 0, 'прогон не начался вовсе')
  assert.equal(readFileSync(out, 'utf8'), '{"ranAt":"прошлый прогон"}')
})

test('--check сверяет форму файла и называет недостающее', async () => {
  reset()
  const dir = mkdtempSync(join(tmpdir(), 'day22-'))
  const out = join(dir, 'eval.json')
  const questions = join(dir, 'questions.json')
  writeFileSync(questions, JSON.stringify({ questions: [ask('q08')] }))
  writeFileSync(out, JSON.stringify({ ranAt: '', index: {}, judge: {}, questions: [] }))
  const said = []
  const code = await main({ argv: ['--check', '--out', out, '--questions', questions], log: (m) => said.push(m) })
  assert.equal(code, 1)
  assert.ok(said.some((m) => m.includes('нет даты прогона')), said.join(' | '))
  assert.ok(said.some((m) => m.includes('нет коммита индекса')), said.join(' | '))
  assert.ok(said.some((m) => m.includes('вопросов 0, а в наборе 1')), said.join(' | '))
  assert.equal(seen.length, 0, 'сверка формы в сеть не ходит')
})
