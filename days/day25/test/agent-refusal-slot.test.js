// Решение владельца 2026-10-05 по развилке Р8(б) — три правила учёта слота
// суточного потолка, и проверяются они на ручке ХОДА (`/api/answer`), потому
// что она одна занимает слоты ПО КРУГАМ:
//
//   1. свой отказ до вызова службы (негодное тело) — слот возвращается;
//   2. отказ службы 400, то есть «запуск не начат, модель не звана», —
//      возвращается;
//   3. 5xx, обрыв связи и всё после создания запуска — СГОРАЕТ.
//
// Почему правила выражены кодом ответа, а не намерением обработчика, и где у
// них два названных исключения — в шапке `runLedger` (`days/day25/server.js`).
//
// УЛИКА РАЗЛИЧАЕТ ГИПОТЕЗЫ. Один код 429 пришёл бы и от минутного окна,
// поэтому минута и час здесь заведомо недостижимы, а текст отказа сверяется
// дословно — «Суточный лимит…». Арифметика взята так, что ЛЮБОЙ сдвиг на один
// слот меняет ответ: предел — 6, ход занимает 2 слота (предел кругов профиля
// равен 2), и после одного сгоревшего хода остаётся ровно два.
//
// Мутации, на которых тест краснеет, — в описании PR; ближайшая: вернуть
// `if (!refusal && !refunded) return 0` к безусловному возврату в
// `runLedger.settle`.

import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, test } from 'node:test'

const PID = '11111111-1111-4111-8111-111111111111'
const SID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RUN = '00000000-0000-4000-8000-000000000001'

/** Чем стенд ответит на создание запуска. Меняется тестами. */
let runReply = { status: 202, body: { ok: true, runId: RUN } }
/** @type {string[]} журнал стенда: только то, что до него дошло. */
const seen = []

const agents = http.createServer(async (req, res) => {
  for await (const chunk of req) void chunk
  const [path] = req.url.split('?')
  seen.push(`${req.method} ${path}`)

  if (path === `/v1/profiles/${PID}`) {
    res.writeHead(200, { 'content-type': 'application/json' })
    // Предел кругов профиля — 2: ход занимает два слота суточного потолка.
    return res.end(
      JSON.stringify({ ok: true, profile: { id: PID, name: 'стенд', stagedSettings: { reviewRounds: 2 } } }),
    )
  }
  if (path === '/v1/runs') {
    // `drop` рвёт соединение: так выглядит недоступная служба — `fetch`
    // бросает, ответа и тела нет вовсе, и о вызове не сказано ничего.
    if (runReply.drop) return res.destroy()
    res.writeHead(runReply.status, { 'content-type': 'application/json' })
    return res.end(JSON.stringify(runReply.body))
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true }))
})

await new Promise((resolve) => agents.listen(0, '127.0.0.1', resolve))

process.env.NODE_ENV = 'test'
process.env.AGENT_KEY = 'agent-key-secret-refusal-do-not-leak'
process.env.AGENT_URL = `http://127.0.0.1:${agents.address().port}`
// Минута и час заведомо недостижимы: отказ, если он придёт, обязан быть
// суточным, иначе тест мерил бы не то окно.
process.env.RATE_LIMIT_PER_MIN = '1000'
process.env.RATE_LIMIT_PER_HOUR = '1000'
process.env.RATE_LIMIT_WRITES_PER_HOUR = '1000'
process.env.MAX_DAILY_CALLS = '6'

const { server } = await import('../server.js')
let base = ''

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => {
  server.close()
  agents.close()
})

const ask = (body) =>
  fetch(`${base}/api/answer`, {
    method: 'POST',
    headers: {
      'x-forwarded-for': '10.7.0.1',
      cookie: `day25_pid=${PID}; day25_sid=${SID}`,
      'content-type': 'application/json',
    },
    body,
  })

const message = () => JSON.stringify({ prompt: 'где держится порядок лимитера?', model: 'anthropic-haiku' })

test('правило 1: свой отказ до вызова службы слот возвращает', async () => {
  seen.length = 0
  for (let i = 0; i < 5; i += 1) {
    const res = await ask('это не JSON')
    assert.equal(res.status, 400, `попытка ${i + 1}`)
    assert.equal((await res.json()).error, 'тело должно быть объектом')
  }
  // До службы не дошло ничего: пять отказов формы при потолке 6 не могли
  // стоить десяти слотов — иначе следующий ход был бы невозможен.
  assert.deepEqual(seen, [], `негодное тело ушло в службу: ${JSON.stringify(seen)}`)
})

test('правило 2: отказ службы 400 слот возвращает — запуск не начат', async () => {
  runReply = { status: 400, body: { ok: false, code: 'bad_input', message: 'Реплика пустая' } }
  for (let i = 0; i < 4; i += 1) {
    const res = await ask(message())
    assert.equal(res.status, 400, `попытка ${i + 1}`)
    assert.equal((await res.json()).error, 'Реплика пустая')
  }
  // Четыре отказа по два слота — восемь при потолке шесть. Потолок не кончился,
  // значит слоты вернулись; что запрос ДОХОДИЛ до службы, видно по журналу.
  assert.ok(
    seen.filter((call) => call === 'POST /v1/runs').length === 4,
    `служба не получила четыре запроса: ${JSON.stringify(seen)}`,
  )
})

test('правило 3: 502 от службы слот СЖИГАЕТ — о вызове не сказано ничего', async () => {
  // Потолок 6, ход занимает 2. Один сгоревший ход оставляет 4, второй — 2,
  // третий уперся бы в потолок. Проверяется первая половина: после двух
  // сгоревших ходов остаётся ровно два слота.
  runReply = { status: 503, body: { ok: false, code: 'router_error' } }
  for (let i = 0; i < 2; i += 1) {
    const res = await ask(message())
    assert.equal(res.status, 502, `попытка ${i + 1}`)
  }
  // Слотов осталось два — ровно на один ход, и он проходит.
  runReply = { status: 202, body: { ok: true, runId: RUN } }
  const ok = await ask(message())
  assert.equal(ok.status, 202, 'два сгоревших хода съели больше, чем заняли')
  assert.equal((await ok.json()).reserved, 2, 'слоты занимаются по кругам, а не по сообщению')
})

test('правило 3: созданный запуск слот не возвращает — суточный потолок кончился', async () => {
  // Шесть слотов израсходованы: 2 + 2 (502) + 2 (удачный ход). Следующий ход
  // обязан упереться в СУТОЧНЫЙ потолок, и сказать это его словами.
  seen.length = 0
  const over = await ask(message())
  assert.equal(over.status, 429)
  assert.equal(
    (await over.json()).error,
    'Суточный лимит запросов к модели исчерпан. Попробуйте завтра.',
  )
  // Отказ суточного потолка приходит ДО создания запуска: в журнале стенда
  // только бесплатное чтение настроек профиля, и ни одного `POST /v1/runs`.
  assert.deepEqual(seen, [`GET /v1/profiles/${PID}`], JSON.stringify(seen))
})

// Обрыва связи здесь НЕТ намеренно, и это не пропуск: суточный счётчик у
// лимитера один на всё приложение, не на адрес, — после теста выше он
// исчерпан, и любой следующий ход упирается в него с любого адреса. То есть
// наблюдать судьбу слота на обрыве в этом файле уже нечем. Он проверен там,
// где счётчик ещё свободен: `test/invariants.test.js`, «оборванная связь со
// службой слот СЖИГАЕТ».
