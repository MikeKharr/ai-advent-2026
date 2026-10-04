// Сервер дня 22 — исполнением, через живой http и стенд сервиса агентов.
//
// Стенд ≠ прод: подменён ТОЛЬКО сервис агентов (`AGENT_URL` указывает на
// локальный http-сервер этого файла). Что запрос дошёл именно до стенда,
// доказывает ЕГО ЖУРНАЛ `seen` — путь, метод, заголовок и тело, — а не код
// ответа: код 202 день отдал бы и сходив в настоящий сервис. Службы `rag`
// здесь нет вовсе, и это верно: день до неё не ходит ни в тесте, ни в проде —
// поиск зовёт сервис агентов.

import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, test } from 'node:test'

const KEY = 'agent-key-secret-day22-do-not-leak'

/** @type {{method:string,url:string,auth:string|undefined,body:string}[]} журнал стенда */
const seen = []
/** Что стенд ответит на следующий `POST /v1/runs`. */
let next = { status: 202, body: { runId: 'run-22' } }

const agents = http.createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  seen.push({
    method: req.method,
    url: req.url,
    auth: req.headers.authorization,
    body: Buffer.concat(chunks).toString('utf8'),
  })
  if (req.url.endsWith('/events')) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    res.write('event: event\ndata: {"stage":"received","title":"Получил вопрос"}\n\n')
    return res.end('event: end\ndata: {"status":"succeeded","result":{"mode":"rag"}}\n\n')
  }
  if (next.status === 0) {
    // Сервис не ответил вовсе: соединение рвётся.
    return req.destroy()
  }
  res.writeHead(next.status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(next.body))
})

await new Promise((resolve) => agents.listen(0, '127.0.0.1', resolve))

process.env.NODE_ENV = 'test'
process.env.AGENT_KEY = KEY
process.env.AGENT_URL = `http://127.0.0.1:${agents.address().port}`
process.env.RATE_LIMIT_PER_MIN = '1000'
process.env.RATE_LIMIT_PER_HOUR = '1000'
process.env.RATE_LIMIT_READS_PER_HOUR = '1000'
// Потолок заведомо недостижим: свой тест на него стоит отдельно и ставит своё
// значение через лимитер напрямую (limits.test.js).
process.env.MAX_DAILY_CALLS = '1000'

const { env, MAX_QUESTION, server } = await import('../server.js')
let base = ''
let ip = 0
/** Свой адрес каждому запросу: окна на адрес не должны мешать проверке ручек. */
const head = () => ({ 'x-forwarded-for': `10.22.0.${(ip += 1)}` })

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => {
  server.close()
  agents.close()
})

const ask = (body, extra = {}) =>
  fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...head(), ...extra },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

test('страница отдаётся и ключа в ней нет (I-1)', async () => {
  const res = await fetch(`${base}/`, { headers: head() })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/html/)
  const html = await res.text()
  assert.ok(html.includes('<h1>Ответ по проекту: с поиском и без</h1>'))
  assert.ok(!html.includes(KEY), 'ключ в разметке')
})

test('модули страницы отдаются как javascript — иначе браузер их не исполняет', async () => {
  for (const name of ['app.js', 'run.js', 'evalview.js', 'rpc.js']) {
    const res = await fetch(`${base}/${name}`, { headers: head() })
    assert.equal(res.status, 200, name)
    assert.match(res.headers.get('content-type'), /text\/javascript/, name)
  }
})

test('за пределы public не выйти', async () => {
  const res = await fetch(`${base}/../server.js`, { headers: head(), redirect: 'manual' })
  assert.ok([403, 404].includes(res.status), `получено ${res.status}`)
})

test('/healthz отвечает и не раскрывает ключ (I-1)', async () => {
  const res = await fetch(`${base}/healthz`, { headers: head() })
  assert.equal(res.status, 200)
  const json = await res.json()
  assert.equal(json.ok, true)
  assert.equal(json.limiter.dailyLimit, env.MAX_DAILY_CALLS)
  assert.ok(!JSON.stringify(json).includes(KEY), 'ключ в ответе пробы')
})

test('пустой вопрос — отказ страницы, и до сервиса он не доходит', async () => {
  seen.length = 0
  const res = await ask({ question: '   ', mode: 'rag' })
  assert.equal(res.status, 400)
  assert.equal((await res.json()).error, 'Вопрос пустой.')
  assert.deepEqual(seen, [], 'пустой вопрос всё-таки ушёл в сервис')
})

test('вопрос длиннее предела — отказ с числом, а не обрезка молчком', async () => {
  seen.length = 0
  const res = await ask({ question: 'я'.repeat(MAX_QUESTION + 1), mode: 'rag' })
  assert.equal(res.status, 400)
  assert.equal((await res.json()).error, `Вопрос длиннее ${MAX_QUESTION} знаков.`)
  assert.deepEqual(seen, [])
})

test('режим обязателен и умолчания у него нет: без него запуска не будет', async () => {
  seen.length = 0
  for (const body of [{ question: 'вопрос' }, { question: 'вопрос', mode: 'оба' }, { question: 'вопрос', mode: '' }]) {
    const res = await ask(body)
    assert.equal(res.status, 400, JSON.stringify(body))
    assert.equal((await res.json()).error, 'Режим не назван.')
  }
  assert.deepEqual(seen, [], 'запуск без режима ушёл в сервис')
})

test('тело не JSON — отказ, а не падение', async () => {
  const res = await ask('{не json')
  assert.equal(res.status, 400)
  assert.equal((await res.json()).error, 'тело не JSON')
})

// Потолок тела — 16 КБ. НАБЛЮДАЕМОЕ поведение названо как есть: чтение
// обрывается на превышении и соединение рвётся (`req.destroy()` в `readBody`),
// поэтому клиент видит разрыв, а неJSON с текстом отказа. Утверждать «отвечает
// 400» было бы ложью о механизме; предмет защиты здесь другой — что тело
// такого размера НЕ ДОХОДИТ до сервиса агентов.
test('тело больше 16 КБ до сервиса не доходит: чтение обрывается', async () => {
  seen.length = 0
  await assert.rejects(() => ask(JSON.stringify({ question: 'я'.repeat(20_000), mode: 'rag' })))
  assert.deepEqual(seen, [], 'тело больше потолка всё-таки ушло в сервис')
})

test('запуск уходит в сервис с именем агента, вопросом, режимом и ключом', async () => {
  seen.length = 0
  next = { status: 202, body: { runId: 'run-22' } }
  const res = await ask({ question: '  где держится I-4  ', mode: 'norag' })
  assert.equal(res.status, 202)
  assert.deepEqual(await res.json(), { runId: 'run-22' })
  // Журнал стенда — улика того, что запрос дошёл именно до него и каким.
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, '/v1/runs')
  assert.equal(seen[0].auth, `Bearer ${KEY}`, 'ключ не предъявлен сервису')
  const sent = JSON.parse(seen[0].body)
  assert.equal(sent.agent, 'rag-agent')
  // Вопрос подрезан по краям, но не изменён внутри.
  assert.deepEqual(sent.input, { question: 'где держится I-4', mode: 'norag' })
  // Сессии у дня нет: её идентификатор не выдумывается и в сервис не уходит.
  assert.equal('sessionId' in sent.input, false)
  assert.equal(res.headers.get('set-cookie'), null, 'день 22 ставит cookie, которых у него нет')
})

test('отказ сервиса словами сервиса, а отказ без слов — общей фразой', async () => {
  next = { status: 400, body: { message: 'Поле mode должно быть одним из: rag, norag' } }
  const spoken = await ask({ question: 'вопрос', mode: 'rag' })
  assert.equal(spoken.status, 400)
  assert.equal((await spoken.json()).error, 'Поле mode должно быть одним из: rag, norag')

  next = { status: 503, body: { code: 'no_agent' } }
  const mute = await ask({ question: 'вопрос', mode: 'rag' })
  assert.equal(mute.status, 502)
  const json = await mute.json()
  assert.equal(json.error, 'Сервис агентов недоступен. Попробуйте позже.')
  // Код и подробности чужой единицы наружу не уходят.
  assert.equal(JSON.stringify(json).includes('no_agent'), false)
})

test('сервис не ответил вовсе — 502 и ключа в ответе нет', async () => {
  next = { status: 0, body: null }
  const res = await ask({ question: 'вопрос', mode: 'rag' })
  assert.equal(res.status, 502)
  assert.ok(!(await res.text()).includes(KEY))
  next = { status: 202, body: { runId: 'run-22' } }
})

test('поток событий идёт насквозь и под ключом, а чужая форма идентификатора — 404', async () => {
  seen.length = 0
  const res = await fetch(`${base}/api/runs/run-22/events`, { headers: head() })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/event-stream/)
  const text = await res.text()
  // Байт в байт: день ничего не разбирает и не переписывает.
  assert.ok(text.includes('event: event\ndata: {"stage":"received","title":"Получил вопрос"}'))
  assert.ok(text.includes('event: end\ndata: {"status":"succeeded","result":{"mode":"rag"}}'))
  assert.equal(seen.at(-1).auth, `Bearer ${KEY}`)
  assert.equal(seen.at(-1).url, '/v1/runs/run-22/events')

  seen.length = 0
  const bad = await fetch(`${base}/api/runs/run%2F..%2Fsecret/events`, { headers: head() })
  assert.equal(bad.status, 404)
  assert.deepEqual(seen, [], 'чужой идентификатор всё-таки ушёл в сервис')
})

test('ключ не появляется ни в одном ответе сервера дня (I-1)', async () => {
  const bodies = []
  for (const [path, init] of [
    ['/', {}],
    ['/app.js', {}],
    ['/healthz', {}],
    ['/eval.json', {}],
    ['/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }],
    ['/api/runs/run-22/events', {}],
  ]) {
    const res = await fetch(`${base}${path}`, { ...init, headers: { ...head(), ...(init.headers ?? {}) } })
    bodies.push(await res.text())
  }
  for (const body of bodies) assert.ok(!body.includes(KEY), 'ключ в ответе сервера дня')
})

// Файла итогов на момент этого PR нет: его пишет прогон (PR 3 дня 22).
// Проверяется не его содержимое, а то, что отсутствие — честное 404, на
// котором страница говорит словами, а не падает.
test('итогов прогона ещё нет: отсутствие файла — 404, а не 500', async () => {
  const res = await fetch(`${base}/eval.json`, { headers: head() })
  assert.ok([200, 404].includes(res.status), `получено ${res.status}`)
})
