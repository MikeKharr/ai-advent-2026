// Интеграционный тест дня 13 против поддельного сервиса агентов. Проверяется
// то, что день 13 добавил к дню 11, — по критериям приёмки ADR 2026-09-21-1747,
// п. 11: резерв слотов под круги проверки (16), пауза и возобновление (3, 5),
// состояние запуска в переписке (7), журнал этапов (9), этапы в `/api/state`,
// и отдельное хранение настроек дня 13 (`stagedSettings` + `?agent=`).
// Устройство дня 11 (две cookie, окна лимитера, прокси потока) проверено его
// собственным тестом и здесь сверяется только на границах, которые день 13
// сдвинул.

import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, test } from 'node:test'

const agentLog = []

const PID = '11111111-1111-4111-8111-111111111111'
const SID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
/** Диалог чужого профиля: агент отвечает на него как на несуществующий. */
const ALIEN_SID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
/** Диалог без живого запуска: паузить нечего. */
const IDLE_SID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
/** Диалог, чей запуск уже завершён на стороне агента: ручка паузы отдаёт 409. */
const DONE_SID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

const RUN = '00000000-0000-4000-8000-000000000001'
const ALIEN_RUN = '00000000-0000-4000-8000-0000000000aa'

/** Сколько кругов назовёт `end` потока: тест этим двигает возврат слотов. */
let endRounds = 1
/** Чем кончится поток: `ok` — результатом, `failed` — ошибкой, `free` — ошибкой без трат, `cut` — ничем. */
let streamMode = 'ok'
/** До какого круга дойдут события `state` — то, что день видит своими глазами. */
let streamRounds = 1
/** Прерван ли вызов у запуска: от этого зависит, берёт ли возобновление слот. */
let interruptedCall = false
const pauseCalls = []
const settingsCalls = []

/** Настройки дня 11 на том же профиле: страница дня 13 их видеть не должна. */
const DAY11_SETTINGS = { strategy: 'window', contextTokens: 3000, model: 'groq-llama' }
/** Настройки дня 13: свой потолок в 32 000 и свои поля проверки. */
const STAGED_SETTINGS = { strategy: 'summary', contextTokens: 32000, reviewModel: 'kimi-k2.6', reviewRounds: 3 }
/**
 * Предел кругов профиля — ЕДИНСТВЕННЫЙ источник числа (решение владельца).
 * Тесты двигают его отсюда, а не телом сообщения.
 */
let profileRounds = 2
/** Настройки профиля отсутствуют вовсе: берётся умолчание. */
let profileHasSettings = true

const agent = http.createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = Buffer.concat(chunks).toString()
  agentLog.push({ method: req.method, url: req.url, body })
  const json = (status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  }
  const [path, query = ''] = req.url.split('?')
  const params = new URLSearchParams(query)

  if (path === '/v1/runs' && req.method === 'POST') {
    return json(202, { ok: true, runId: RUN })
  }

  const pause = path.match(/^\/v1\/runs\/([^/]+)\/pause$/)
  if (pause && req.method === 'POST') {
    pauseCalls.push({ runId: pause[1], body: JSON.parse(body) })
    if (pause[1] === ALIEN_RUN) return json(404, { ok: false, code: 'unknown_run' })
    return json(200, { ok: true, paused: JSON.parse(body).paused })
  }

  const log = path.match(/^\/v1\/runs\/([^/]+)\/log\.csv$/)
  if (log) {
    if (log[1] === ALIEN_RUN) return json(404, { ok: false, code: 'unknown_run' })
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8' })
    return res.end('run_id,state,outcome\n' + `${RUN},intake,done\n`)
  }

  const events = path.match(/^\/v1\/runs\/([^/]+)\/events$/)
  if (events) {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    // Этапы с номером круга: по ним день считает, до какого круга дошёл запуск.
    for (let round = 1; round <= streamRounds; round++) {
      const event = { seq: round, stage: 'state', data: { state: 'answer', index: 3, of: 6, round } }
      res.write(`id: ${round}\nevent: event\ndata: ${JSON.stringify(event)}\n\n`)
    }
    // Поток оборвался, не сказав `end`: запуск, возможно, идёт.
    if (streamMode === 'cut') return res.end()
    const end =
      streamMode === 'failed'
        ? { status: 'failed', error: { code: 'router_error', message: 'модель не ответила', paidNothing: false } }
        : streamMode === 'free'
          ? { status: 'failed', error: { code: 'budget_too_small', message: 'мало', paidNothing: true } }
          : { status: 'succeeded', result: { answer: 'ответ', summary: { totalTokens: 100, rounds: endRounds } } }
    res.write(`event: end\ndata: ${JSON.stringify(end)}\n\n`)
    return res.end()
  }

  const settings = path.match(/^\/v1\/profiles\/([^/]+)\/settings$/)
  if (settings && req.method === 'PUT') {
    settingsCalls.push({ url: req.url, body: JSON.parse(body) })
    // Ручка без имени агента настройки дня 13 не узнаёт: 32 000 токенов для
    // разборщика дня 11 — неизвестное значение.
    if (!params.get('agent'))
      return json(400, { ok: false, code: 'bad_input', message: 'Размер контекста: целое от 0 до 8000' })
    return json(200, { ok: true, settings: JSON.parse(body) })
  }

  const session = path.match(/^\/v1\/sessions\/([^/]+)$/)
  if (session) {
    const id = session[1]
    if (id === ALIEN_SID || params.get('profile') !== PID)
      return json(404, { ok: false, code: 'unknown_session' })
    const run =
      id === IDLE_SID
        ? null
        : id === DONE_SID
          ? { id: ALIEN_RUN, status: 'running', state: 'answer', paused: false, interruptedCall: false }
          : { id: RUN, status: 'running', state: 'answer', paused: false, interruptedCall, since: 1 }
    return json(200, {
      ok: true,
      messages: [],
      totalTokens: 0,
      summary: null,
      facts: null,
      head: null,
      context: null,
      topic: null,
      pendingTopic: null,
      run,
    })
  }

  const profile = path.match(/^\/v1\/profiles\/([^/]+)$/)
  if (profile && req.method === 'GET') {
    return json(200, {
      ok: true,
      sessionCap: 20,
      profile: {
        id: PID,
        name: 'Мика',
        settings: DAY11_SETTINGS,
        stagedSettings: profileHasSettings
          ? { ...STAGED_SETTINGS, reviewRounds: profileRounds }
          : undefined,
        rules: [],
        topics: [],
        sessions: [{ id: SID, lastSeenAt: 1, messages: 2, topicId: null, topicTitle: null }],
        lastSession: SID,
      },
    })
  }

  if (path === '/v1/agents') {
    return json(200, {
      ok: true,
      agents: [
        {
          id: 'staged-agent',
          name: 'Агент с машиной состояний',
          version: '1.0.0',
          purpose: 'назначение',
          systemPrompt: 'промпт',
          tools: [],
          models: [{ id: 'anthropic-haiku', label: 'Claude Haiku 4.5' }],
          defaults: { model: 'anthropic-haiku', reviewModel: 'kimi-k2.6', reviewRounds: 2 },
          limits: {
            maxTokens: 2048,
            reviewRounds: { min: 1, max: 3, default: 2 },
            stageContextTokens: 32000,
          },
          stages: [
            { id: 'intake', title: 'Приём', prompt: null, rule: 'профиль жив' },
            { id: 'answer', title: 'Вызов модели', prompt: 'текст промпта', rule: null },
          ],
        },
      ],
    })
  }
  if (path === '/healthz') return json(200, { ok: true, sessionTtlHours: 30 })
  json(404, { ok: false })
})

await new Promise((resolve) => agent.listen(0, '127.0.0.1', resolve))

process.env.NODE_ENV = 'test'
process.env.AGENT_KEY = 'agent-key'
process.env.AGENT_URL = `http://127.0.0.1:${agent.address().port}`
process.env.COOKIE_PATH = '/'
process.env.COOKIE_SECURE = 'false'
// Окна широкие: у каждого теста свой адрес, а проверки резерва слотов ниже
// упираются в предел намеренно, своим адресом и своим числом.
// Суточный предел широкий намеренно: слот берётся на КРУГ, и весь прогон
// тратит их сотнями. На производственных 50 середина прогона упиралась бы в
// суточный предел, и отказы читались бы как дефекты проверяемых веток.
process.env.MAX_DAILY_CALLS = '400'
process.env.RATE_LIMIT_PER_MIN = '4'
process.env.RATE_LIMIT_PER_HOUR = '12'
process.env.RATE_LIMIT_WRITES_PER_HOUR = '40'

const { server } = await import('../server.js')
let base = ''

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(async () => {
  await new Promise((resolve) => server.close(resolve))
  await new Promise((resolve) => agent.close(resolve))
})

const call = (method, path, body, { ip = '10.0.0.1', cookie } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': ip,
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const withSession = (id = SID, pid = PID) => `day13_pid=${pid}; day13_sid=${id}`

/** Дождаться конца прокси потока: возврат слотов случается в нём, не в ответе. */
const drain = async (runId, cookie) => {
  const r = await fetch(`${base}/api/runs/${runId}/events`, { headers: { cookie } })
  await r.text()
}

/* ---------- cookie дня 13 ---------- */

test('cookie дня 13 свои: день 11 не затрагивается', async () => {
  const r = await call('GET', '/api/chat', undefined, { ip: '10.9.0.1', cookie: withSession() })
  assert.equal(r.status, 200)
  // Запрос ушёл с идентификатором из day13_sid, а не из day11_sid.
  assert.ok(agentLog.some((c) => c.url.startsWith(`/v1/sessions/${SID}`)))
})

/* ---------- критерий 7: состояние запуска в переписке ---------- */

test('переписка несёт живой запуск, а без диалога — null', async () => {
  const live = await call('GET', '/api/chat', undefined, { ip: '10.9.0.2', cookie: withSession() })
  const body = await live.json()
  assert.equal(body.run.id, RUN)
  assert.equal(body.run.state, 'answer')
  assert.equal(body.run.paused, false)

  const none = await call('GET', '/api/chat', undefined, { ip: '10.9.0.2', cookie: `day13_pid=${PID}` })
  assert.equal((await none.json()).run, null, 'диалога нет — запуска нет, а не выдуманный')
})

/* ---------- этапы и предел кругов в состоянии ---------- */

test('/api/state отдаёт шесть этапов агента и предел кругов', async () => {
  const r = await call('GET', '/api/state', undefined, { ip: '10.9.0.3' })
  const body = await r.json()
  assert.equal(body.stages[0].id, 'intake')
  assert.equal(body.stages[0].prompt, null, 'у этапа без вызова промпта нет')
  // Текст промпта страница берёт отсюда, а не из событий: в событиях текстов нет.
  assert.equal(body.stages[1].prompt, 'текст промпта')
  assert.deepEqual(body.limits.reviewRounds, { min: 1, max: 3, default: 2 })
  assert.equal((await (await call('GET', '/api/state', undefined, { ip: '10.9.0.3' })).text()).includes('agent-key'), false)
})

/* ---------- критерий 16: резерв слотов под круги ---------- */

test('сообщение резервирует слоты по пределу кругов ПРОФИЛЯ', async () => {
  const ip = '10.2.0.1'
  const cookie = withSession()
  profileRounds = 3
  // Минутное окно — четыре слота. Сообщение при пределе профиля в три круга
  // занимает три: столько платных ответов оно может стоить.
  const first = await call('POST', '/api/answer', { prompt: 'да' }, { ip, cookie })
  assert.equal(first.status, 202)
  assert.equal((await first.json()).reserved, 3, 'зарезервировано по слоту на круг')

  // Второго такого сообщения окно не выдержит: 3 + 3 > 4. Отказ случается ДО
  // создания запуска — единственного платного обращения (I-4).
  const before = agentLog.filter((c) => c.url === '/v1/runs').length
  const denied = await call('POST', '/api/answer', { prompt: 'да' }, { ip, cookie })
  assert.equal(denied.status, 429)
  assert.equal(
    agentLog.filter((c) => c.url === '/v1/runs').length,
    before,
    'при отказе лимитера запуска нет вовсе',
  )

  // А на один круг слот ещё есть: резерв считается слотами, а не сообщениями.
  profileRounds = 1
  const one = await call('POST', '/api/answer', { prompt: 'да' }, { ip, cookie })
  assert.equal(one.status, 202)
  assert.equal((await one.json()).reserved, 1)
  profileRounds = 2
})

/** Вход последнего запуска, ушедший агенту: смотреть надо сюда, а не в ответ дня. */
const lastRunInput = () => {
  const call = agentLog.filter((c) => c.url === '/v1/runs' && c.method === 'POST').pop()
  return JSON.parse(call.body).input
}

test('связка целиком: настройка профиля → резерв → тело запроса к агенту', async () => {
  // Одно число из одного места проходит через обе точки, поэтому расхождение
  // резерва и расхода невозможно по построению, а не по внимательности.
  for (const rounds of [1, 2, 3]) {
    profileRounds = rounds
    const r = await call('POST', '/api/answer', { prompt: 'да' }, {
      ip: `10.2.1.${rounds}`,
      cookie: withSession(),
    })
    assert.equal(r.status, 202)
    assert.equal((await r.json()).reserved, rounds, `резерв при настройке ${rounds}`)
    assert.equal(lastRunInput().reviewRounds, rounds, `агенту при настройке ${rounds}`)
  }
  profileRounds = 2
})

test('поле кругов в теле сообщения не меняет ничего', async () => {
  // Источник числа — настройки профиля. Поле тела отбрасывается, каким бы оно
  // ни было: иначе один запрос в обход окна настроек ломал бы правило слотов.
  profileRounds = 2
  const variants = [99, 0, 1, 3, 'три', 2.5, -7, null, {}]
  for (const [i, sent] of variants.entries()) {
    // Свой адрес на итерацию: минутное окно — четыре слота, а проверок девять.
    const r = await call('POST', '/api/answer', { prompt: 'да', reviewRounds: sent }, {
      ip: `10.2.2.${i + 1}`,
      cookie: withSession(),
    })
    assert.equal(r.status, 202, JSON.stringify(sent))
    assert.equal((await r.json()).reserved, 2, `резерв при поле ${JSON.stringify(sent)}`)
    assert.equal(
      lastRunInput().reviewRounds,
      2,
      `агенту ушло поле тела вместо настройки профиля: ${JSON.stringify(sent)}`,
    )
  }
})

test('без настроек профиля берётся умолчание в два круга', async () => {
  profileHasSettings = false
  const r = await call('POST', '/api/answer', { prompt: 'да', reviewRounds: 3 }, {
    ip: '10.2.3.1',
    cookie: withSession(),
  })
  assert.equal(r.status, 202)
  assert.equal((await r.json()).reserved, 2)
  assert.equal(lastRunInput().reviewRounds, 2)
  profileHasSettings = true
})

test('негодное число в настройках профиля приводится к границам', async () => {
  // Настройки профиля открыты и проверяются агентом, но день не обязан верить
  // тому, что прочитал: слоты он занимает по своему приведённому числу.
  const stored = [[99, 3], [0, 1], [-4, 1], ['три', 2]]
  for (const [i, [value, expected]] of stored.entries()) {
    profileRounds = value
    const r = await call('POST', '/api/answer', { prompt: 'да' }, {
      ip: `10.2.4.${i + 1}`,
      cookie: withSession(),
    })
    assert.equal((await r.json()).reserved, expected, `настройка ${value}`)
    assert.equal(lastRunInput().reviewRounds, expected, `агенту при настройке ${value}`)
  }
  profileRounds = 2
})

test('тема во вход запуска не уходит, прочие поля доходят как есть', async () => {
  profileRounds = 2
  await call('POST', '/api/answer', { prompt: 'да', topicId: 7, model: 'kimi-k2.6', maxTokens: 500 }, {
    ip: '10.2.2.2',
    cookie: withSession(),
  })
  const input = lastRunInput()
  assert.equal(input.topicId, undefined, 'тема уходит в создание диалога, а не в запуск')
  assert.equal(input.model, 'kimi-k2.6')
  assert.equal(input.maxTokens, 500)
  assert.equal(input.prompt, 'да')
})

test('при одном состоявшемся круге лишние слоты возвращаются по end', async () => {
  const ip = '10.3.0.1'
  endRounds = 1
  const cookie = withSession()
  profileRounds = 3
  const r = await call('POST', '/api/answer', { prompt: 'да' }, { ip, cookie })
  assert.equal(r.status, 202)
  profileRounds = 1
  await drain(RUN, cookie)

  // Три слота заняты, два вернулись — остался один. Минутное окно 4, значит
  // ещё три сообщения по одному кругу должны пройти.
  for (let i = 0; i < 3; i++) {
    const next = await call('POST', '/api/answer', { prompt: 'да' }, { ip, cookie })
    assert.equal(next.status, 202, `сообщение ${i + 2} после возврата слотов`)
  }
  const over = await call('POST', '/api/answer', { prompt: 'да' }, { ip, cookie })
  assert.equal(over.status, 429, 'возвращено ровно два слота, не больше')
})

test('состоявшиеся круги слотов не возвращают', async () => {
  const ip = '10.3.0.2'
  endRounds = 3
  const cookie = withSession()
  profileRounds = 3
  await call('POST', '/api/answer', { prompt: 'да' }, { ip, cookie })
  profileRounds = 1
  await drain(RUN, cookie)
  profileRounds = 3
  const next = await call('POST', '/api/answer', { prompt: 'да' }, { ip, cookie })
  assert.equal(next.status, 429, 'три круга съели три слота, четвёртый не найдётся')
  profileRounds = 2
  endRounds = 1
})

test('упавший запуск возвращает слоты кругов, до которых не дошёл', async () => {
  const ip = '10.3.0.3'
  const cookie = withSession()
  // Запуск падает на первом круге: `end` несёт ошибку, числа кругов в нём нет.
  streamMode = 'failed'
  streamRounds = 1
  profileRounds = 3
  await call('POST', '/api/answer', { prompt: 'да' }, { ip, cookie })
  profileRounds = 1
  await drain(RUN, cookie)
  // Занятым остаётся один слот из трёх — минутное окно в 4 пускает ещё троих.
  for (let i = 0; i < 3; i++) {
    const next = await call('POST', '/api/answer', { prompt: 'да' }, { ip, cookie })
    assert.equal(next.status, 202, `сообщение ${i + 2} после падения`)
  }
  const over = await call('POST', '/api/answer', { prompt: 'да' }, { ip, cookie })
  assert.equal(over.status, 429, 'за состоявшийся круг слот удержан')
  streamMode = 'ok'
})

test('падение до первого этапа возвращает все слоты', async () => {
  const ip = '10.3.0.4'
  const cookie = withSession()
  // Ни одного события `state`: запуск не дошёл ни до какого круга.
  streamMode = 'failed'
  streamRounds = 0
  profileRounds = 3
  await call('POST', '/api/answer', { prompt: 'да' }, { ip, cookie })
  profileRounds = 1
  await drain(RUN, cookie)
  for (let i = 0; i < 4; i++) {
    const next = await call('POST', '/api/answer', { prompt: 'да' }, { ip, cookie })
    assert.equal(next.status, 202, `сообщение ${i + 2}: все три слота вернулись`)
  }
  streamMode = 'ok'
  streamRounds = 1
})

test('отказ без трат возвращает все слоты, даже если круги начинались', async () => {
  const ip = '10.3.0.5'
  const cookie = withSession()
  streamMode = 'free'
  streamRounds = 2
  profileRounds = 3
  await call('POST', '/api/answer', { prompt: 'да' }, { ip, cookie })
  profileRounds = 1
  await drain(RUN, cookie)
  for (let i = 0; i < 4; i++) {
    const next = await call('POST', '/api/answer', { prompt: 'да' }, { ip, cookie })
    assert.equal(next.status, 202, `сообщение ${i + 2}: paidNothing вернул всё`)
  }
  streamMode = 'ok'
  streamRounds = 1
})

test('оборванный поток слотов не возвращает: запуск, возможно, идёт', async () => {
  const ip = '10.3.0.6'
  const cookie = withSession()
  // `end` не пришёл вовсе — доказательства завершения нет.
  streamMode = 'cut'
  streamRounds = 1
  profileRounds = 3
  try {
    await call('POST', '/api/answer', { prompt: 'да' }, { ip, cookie })
    await drain(RUN, cookie)
    // Ни один из трёх слотов не вернулся, поэтому следующее такое же
    // сообщение в минутное окно уже не помещается.
    const over = await call('POST', '/api/answer', { prompt: 'да' }, { ip, cookie })
    assert.equal(over.status, 429, 'все три слота остаются занятыми')
  } finally {
    // Режим потока возвращается даже при провале: иначе оборванный поток
    // достался бы следующему тесту и тот упал бы за компанию.
    streamMode = 'ok'
    profileRounds = 2
  }
})

test('слово агента о кругах важнее наблюдения дня', async () => {
  const ip = '10.3.0.7'
  const cookie = withSession()
  // Событий `state` два, но агент говорит, что круг был один.
  streamRounds = 2
  endRounds = 1
  profileRounds = 3
  await call('POST', '/api/answer', { prompt: 'да' }, { ip, cookie })
  profileRounds = 1
  await drain(RUN, cookie)
  for (let i = 0; i < 3; i++) {
    const next = await call('POST', '/api/answer', { prompt: 'да' }, { ip, cookie })
    assert.equal(next.status, 202, `сообщение ${i + 2}: вернулись два слота по слову агента`)
  }
  const over = await call('POST', '/api/answer', { prompt: 'да' }, { ip, cookie })
  assert.equal(over.status, 429)
  streamRounds = 1
})

/* ---------- критерии 3 и 5: пауза ---------- */

test('пауза уходит агенту с профилем и диалогом из cookie', async () => {
  pauseCalls.length = 0
  const r = await call('POST', '/api/run/pause', { paused: true }, {
    ip: '10.4.0.1',
    cookie: withSession(),
  })
  assert.equal(r.status, 200)
  assert.equal((await r.json()).paused, true)
  assert.equal(pauseCalls.length, 1)
  assert.deepEqual(pauseCalls[0], {
    runId: RUN,
    body: { paused: true, profileId: PID, sessionId: SID },
  })
})

test('пауза чужого диалога — 404, и до ручки паузы дело не доходит', async () => {
  pauseCalls.length = 0
  const r = await call('POST', '/api/run/pause', { paused: true }, {
    ip: '10.4.0.2',
    cookie: withSession(ALIEN_SID),
  })
  assert.equal(r.status, 404)
  assert.equal(pauseCalls.length, 0)
})

test('пауза без профиля — 409, без диалога — 409', async () => {
  const noProfile = await call('POST', '/api/run/pause', { paused: true }, { ip: '10.4.0.3' })
  assert.equal(noProfile.status, 409)
  const noSession = await call('POST', '/api/run/pause', { paused: true }, {
    ip: '10.4.0.4',
    cookie: `day13_pid=${PID}`,
  })
  assert.equal(noSession.status, 409)
})

test('пауза завершённого запуска — 409 словами агента', async () => {
  const r = await call('POST', '/api/run/pause', { paused: true }, {
    ip: '10.4.0.5',
    cookie: withSession(IDLE_SID),
  })
  assert.equal(r.status, 409)
  assert.equal((await r.json()).code, 'no_run')
})

test('paused не булево — 400, к агенту запрос не идёт', async () => {
  pauseCalls.length = 0
  const r = await call('POST', '/api/run/pause', { paused: 'да' }, {
    ip: '10.4.0.6',
    cookie: withSession(),
  })
  assert.equal(r.status, 400)
  assert.equal(pauseCalls.length, 0)
})

test('возобновление без прерванного вызова слота не тратит', async () => {
  const ip = '10.5.0.1'
  interruptedCall = false
  const cookie = withSession()
  for (let i = 0; i < 4; i++) {
    const r = await call('POST', '/api/run/pause', { paused: false }, { ip, cookie })
    assert.equal(r.status, 200, `возобновление ${i + 1} не упирается в минутное окно запусков`)
  }
})

test('возобновление с прерванным вызовом берёт слот, а 429 оставляет паузу', async () => {
  const ip = '10.6.0.1'
  interruptedCall = true
  const cookie = withSession()
  pauseCalls.length = 0
  // Минутное окно — 4 слота: четыре возобновления проходят, пятое отвергается.
  for (let i = 0; i < 4; i++) {
    const r = await call('POST', '/api/run/pause', { paused: false }, { ip, cookie })
    assert.equal(r.status, 200)
  }
  assert.equal(pauseCalls.length, 4)
  const denied = await call('POST', '/api/run/pause', { paused: false }, { ip, cookie })
  assert.equal(denied.status, 429)
  assert.match((await denied.json()).error, /Слишком часто/)
  assert.equal(pauseCalls.length, 4, 'без слота запуск остаётся на паузе: агента не трогаем')
  interruptedCall = false
})

test('отказ агента на возобновлении возвращает взятый слот', async () => {
  const ip = '10.7.0.1'
  interruptedCall = true
  const cookie = withSession(DONE_SID)
  // Запуск этого диалога агент считает несуществующим: ручка отдаёт 404.
  for (let i = 0; i < 6; i++) {
    const r = await call('POST', '/api/run/pause', { paused: false }, { ip, cookie })
    assert.equal(r.status, 404, `попытка ${i + 1}`)
  }
  // Шесть попыток при минутном окне в 4 — значит слот каждый раз возвращался.
  interruptedCall = false
})

/* ---------- критерий 9: журнал этапов ---------- */

test('журнал отдаётся как CSV и не исполняется браузером', async () => {
  const r = await fetch(`${base}/api/runs/${RUN}/log.csv`, { headers: { cookie: withSession() } })
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type'), /text\/csv/)
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
  assert.match(r.headers.get('content-disposition'), /attachment/)
  // `filename` в заголовке нет намеренно: он перебивал атрибут `download`
  // страницы, и в папке загрузок оказывались одинаковые `day13-stages.csv`.
  assert.equal(
    /filename/.test(r.headers.get('content-disposition')),
    false,
    'имя файла назначает страница, а не заголовок',
  )
  const text = await r.text()
  assert.match(text, /^run_id,state,outcome/)
  assert.equal(text.includes('agent-key'), false)
})

test('журнал чужого запуска — 404', async () => {
  const r = await fetch(`${base}/api/runs/${ALIEN_RUN}/log.csv`, {
    headers: { cookie: withSession() },
  })
  assert.equal(r.status, 404)
})

test('журнал без диалога и с негодным идентификатором — 404', async () => {
  const noSession = await fetch(`${base}/api/runs/${RUN}/log.csv`, {
    headers: { cookie: `day13_pid=${PID}` },
  })
  assert.equal(noSession.status, 404)
  const bad = await fetch(`${base}/api/runs/..%2F..%2Fetc/log.csv`, {
    headers: { cookie: withSession() },
  })
  assert.equal(bad.status, 404)
})

/* ---------- отдельное хранение настроек дня 13 ---------- */

test('страница дня 13 видит свои настройки, а не настройки дня 11', async () => {
  const r = await call('GET', '/api/profile', undefined, { ip: '10.8.0.1', cookie: withSession() })
  const { profile } = await r.json()
  assert.deepEqual(profile.settings, { ...STAGED_SETTINGS, reviewRounds: profileRounds })
  assert.equal(
    profile.settings.contextTokens,
    32000,
    'потолок этапа дня 13, а не восемь тысяч дня 11',
  )
  assert.notDeepEqual(profile.settings, DAY11_SETTINGS)
})

test('настройки пишутся под именем агента: без него сервис их отвергает', async () => {
  settingsCalls.length = 0
  const r = await call('PUT', '/api/settings', STAGED_SETTINGS, {
    ip: '10.8.0.2',
    cookie: withSession(),
  })
  assert.equal(r.status, 200, 'с именем агента 32 000 токенов принимаются')
  assert.equal(settingsCalls.length, 1)
  assert.match(settingsCalls[0].url, /\?agent=staged-agent$/, 'имя агента в запросе есть')
  assert.equal(settingsCalls[0].body.contextTokens, 32000)
  assert.equal(settingsCalls[0].body.reviewRounds, 3)
})

test('предел кругов и потолок этапа приходят странице числами', async () => {
  const r = await call('GET', '/api/state', undefined, { ip: '10.8.0.3' })
  const body = await r.json()
  assert.equal(body.stageContextTokens, 32000, 'поле контекста не обещает меньше, чем примет сервис')
  assert.deepEqual(body.limits.reviewRounds, { min: 1, max: 3, default: 2 })
})

/* ---------- страница ---------- */

test('страница отдаётся и ключа в ней нет', async () => {
  const r = await fetch(`${base}/`)
  assert.equal(r.status, 200)
  const html = await r.text()
  assert.equal(html.includes('agent-key'), false)
  assert.match(html, /день 13/)
})

test('/healthz отвечает и не раскрывает ключ', async () => {
  const r = await fetch(`${base}/healthz`)
  assert.equal(r.status, 200)
  assert.equal((await r.text()).includes('agent-key'), false)
})
