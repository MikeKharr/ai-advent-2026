// Интеграционный тест дня: настоящий сервер дня против поддельного сервиса
// агентов. Проверяется связка — cookie сессии, лимитер, создание запуска,
// прокси потока, переписка и её очистка.

import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, test } from 'node:test'

/** Поддельный агент: помнит запросы и переписку по сессиям. */
const agentLog = []
let agentMode = 'ok'
const stored = new Map()
/** Сессия, у которой агент уже держит сводку. */
const SUMMARIZED = '77777777-7777-4777-8777-777777777777'
/** Сессия с деревом сообщений: голова, родители, развилка (день 10). */
const TREE = '88888888-8888-4888-8888-888888888888'
const TREE_NODES = [
  { id: 1, role: 'user', parentId: null, text: 'корень', meta: {} },
  { id: 2, role: 'agent', parentId: 1, text: 'ответ', meta: {} },
  { id: 3, role: 'user', parentId: 2, text: 'ветка А', meta: {} },
  { id: 4, role: 'agent', parentId: 3, text: 'ответ А', meta: {} },
  { id: 5, role: 'user', parentId: 2, text: 'ветка Б', meta: {} },
  { id: 6, role: 'agent', parentId: 5, text: 'ответ Б', meta: {} },
]
/** Голова по сессиям: её двигает PUT …/head. */
const heads = new Map()

const agent = http.createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = Buffer.concat(chunks).toString()
  agentLog.push({ method: req.method, url: req.url, auth: req.headers.authorization, body })
  const json = (status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  }
  if (agentMode === 'down') {
    res.destroy()
    return
  }
  if (req.url === '/v1/runs') {
    const input = JSON.parse(body).input
    if (!input.prompt)
      return json(400, { ok: false, code: 'bad_input', message: 'Напишите сообщение' })
    const list = stored.get(input.sessionId) ?? []
    list.push({ role: 'user', text: input.prompt, meta: {} })
    stored.set(input.sessionId, list)
    const suffix = input.prompt === 'без денег' ? '7' : '1'
    return json(202, { ok: true, runId: `00000000-0000-4000-8000-00000000000${suffix}` })
  }
  const events = req.url.match(/^\/v1\/runs\/([^/]+)\/events$/)
  if (events) {
    if (events[1].endsWith('9')) return json(404, { ok: false, code: 'unknown_run' })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`id: 1\nevent: event\ndata: ${JSON.stringify({ seq: 1, stage: 'received' })}\n\n`)
    const end = events[1].endsWith('7')
      ? {
          status: 'failed',
          error: { code: 'budget_too_small', message: 'мало', paidNothing: true },
        }
      : { status: 'succeeded', result: { answer: 'ответ', summary: { totalTokens: 100 } } }
    res.write(`event: end\ndata: ${JSON.stringify(end)}\n\n`)
    return res.end()
  }
  // Параметры стратегии приходят в чтении сессии (ADR 2026-09-14-0447, п. 3),
  // поэтому путь отделяется от строки запроса.
  const [path, query = ''] = req.url.split('?')
  const branch = path.match(/^\/v1\/sessions\/([^/]+)\/head$/)
  if (branch && req.method === 'PUT') {
    const { messageId } = JSON.parse(body)
    // Сообщение не этой сессии — 404, голова не двигается; идёт запуск — 409.
    if (messageId === 999)
      return json(404, { ok: false, code: 'unknown_message', message: 'Сообщение не найдено' })
    if (messageId === 888) return json(409, { ok: false, code: 'busy', message: 'Идёт запуск' })
    // Голова встаёт на поздний лист поддерева: у 3 это 4, у 5 это 6.
    const leaf = messageId === 3 ? 4 : messageId === 5 ? 6 : messageId
    heads.set(branch[1], leaf)
    return json(200, { ok: true, head: leaf })
  }
  const session = path.match(/^\/v1\/sessions\/([^/]+)$/)
  if (session) {
    if (req.method === 'DELETE') {
      const had = stored.get(session[1])?.length ?? 0
      stored.delete(session[1])
      return json(200, { ok: true, removed: had })
    }
    // Сводка и контекст сессии — поля агента дня 9 (ADR 2026-09-11-1608).
    const withSummary = session[1] === SUMMARIZED
    return json(200, {
      ok: true,
      messages: session[1] === TREE ? TREE_NODES : (stored.get(session[1]) ?? []),
      totalTokens: 4200,
      summary: withSummary
        ? {
            text: 'пересказ',
            tokens: 560,
            sourceTokens: 2540,
            updatedAt: '2026-09-11T14:05:10.000Z',
            throughId: 7,
            model: 'claude-haiku-4-5',
            truncated: false,
          }
        : null,
      facts: withSummary
        ? {
            text: 'цель: следить за раундами в финтехе',
            tokens: 420,
            updatedAt: '2026-09-14T14:05:10.000Z',
            throughId: 7,
            truncatedStreak: 2,
            limitTokens: 600,
            model: 'claude-haiku-4-5',
          }
        : null,
      // Контекст агент считает под ту стратегию, которую назвала страница.
      context:
        new URLSearchParams(query).get('strategy') === 'window'
          ? { total: 3180 }
          : withSummary
            ? { total: 2560, summaryTokens: 560, freshTokens: 2000 }
            : { total: 0, summaryTokens: 0, freshTokens: 0 },
      ...(session[1] === TREE ? { head: heads.get(TREE) ?? 4 } : {}),
    })
  }
  if (req.url === '/v1/agents') {
    return json(200, {
      ok: true,
      agents: [
        {
          id: 'news-analyst',
          name: 'Аналитик',
          version: '1.0.0',
          purpose: 'назначение',
          systemPrompt: 'промпт',
          tools: [{ name: 'archive' }],
          models: [{ id: 'anthropic-haiku' }],
          presets: [{ id: 'p' }],
          defaults: { model: 'anthropic-haiku', contextTokens: 3000 },
          limits: { maxTokens: 2048 },
        },
      ],
    })
  }
  if (req.url === '/v1/agents/news-analyst/tools/archive') {
    return json(200, { ok: true, total: 5, capacity: 1000, sources: [{ source: 'TechCrunch' }] })
  }
  // Срок хранения у агента намеренно не 30: страница обещает то число,
  // по которому переписка действительно удаляется.
  if (req.url === '/healthz') return json(200, { ok: true, sessionTtlHours: 42 })
  json(404, { ok: false })
})

await new Promise((resolve) => agent.listen(0, '127.0.0.1', resolve))

process.env.NODE_ENV = 'test'
process.env.AGENT_KEY = 'agent-key'
process.env.AGENT_URL = `http://127.0.0.1:${agent.address().port}`
process.env.COOKIE_PATH = '/'
process.env.COOKIE_SECURE = 'false'
// Окна лимитера широкие: у каждого теста свой адрес, а отдельная проверка
// лимитера ниже упирается в предел на минуту намеренно.
process.env.MAX_DAILY_CALLS = '50'
process.env.RATE_LIMIT_PER_MIN = '4'
process.env.RATE_LIMIT_PER_HOUR = '50'

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

/** Значение cookie сессии из ответа. */
const sidOf = (response) => {
  const raw = response.headers.get('set-cookie')
  const found = raw?.match(/day10_sid=([0-9a-f-]{36})/)
  return found ? found[1] : null
}

/** Каждый тест ходит со своего адреса: иначе они делят окно лимитера. */
const ask = (body, { ip = '10.0.0.1', ...headers } = {}) =>
  fetch(`${base}/api/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

test('/healthz отвечает и не раскрывает ключ', async () => {
  const r = await fetch(`${base}/healthz`)
  assert.equal(r.status, 200)
  assert.equal((await r.text()).includes('agent-key'), false)
})

test('сессия заводится сервером и приходит в cookie, недоступной скриптам', async () => {
  const r = await fetch(`${base}/api/state`)
  const cookie = r.headers.get('set-cookie')
  assert.match(cookie, /^day10_sid=[0-9a-f-]{36}/)
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Lax/)
  assert.match(cookie, /Max-Age=108000/, 'срок cookie совпадает с 30 часами хранения')
  // Идентификатора сессии в теле ответа нет: страница его не знает.
  assert.equal((await r.text()).includes(sidOf(r)), false)
})

test('идентификатор сессии добавляет сервер, а не страница', async () => {
  const first = await ask({ prompt: 'привет' }, { ip: '10.0.0.3' })
  assert.equal(first.status, 202)
  const sid = sidOf(first)
  assert.match(sid, /^[0-9a-f-]{36}$/)

  const sent = JSON.parse(agentLog.at(-1).body)
  assert.equal(sent.input.sessionId, sid)
  assert.equal(sent.agent, 'news-analyst')
  assert.equal(agentLog.at(-1).auth, 'Bearer agent-key')

  // Со второй попытки та же cookie — та же сессия.
  const second = await ask({ prompt: 'ещё' }, { ip: '10.0.0.3', cookie: `day10_sid=${sid}` })
  assert.equal(JSON.parse(agentLog.at(-1).body).input.sessionId, sid)
  assert.equal(second.status, 202)
})

test('подделанная cookie не принимается: заводится новая сессия', async () => {
  const r = await ask({ prompt: 'x' }, { ip: '10.0.0.4', cookie: 'day10_sid=../../etc/passwd' })
  assert.equal(r.status, 202)
  const sid = JSON.parse(agentLog.at(-1).body).input.sessionId
  assert.match(sid, /^[0-9a-f-]{36}$/)
  assert.equal(sid.includes('etc'), false)
})

test('переписка читается по своей cookie и удаляется вместе с сессией', async () => {
  const started = await ask({ prompt: 'первый вопрос' }, { ip: '10.0.0.5' })
  const sid = sidOf(started)

  const read = await fetch(`${base}/api/chat`, { headers: { cookie: `day10_sid=${sid}` } })
  const body = await read.json()
  assert.equal(body.messages.at(-1).text, 'первый вопрос')

  // Чужая сессия своей переписки не отдаёт.
  const alien = await fetch(`${base}/api/chat`, {
    headers: { cookie: 'day10_sid=99999999-9999-4999-8999-999999999999' },
  })
  assert.deepEqual((await alien.json()).messages, [])

  const cleared = await fetch(`${base}/api/chat`, {
    method: 'DELETE',
    headers: { cookie: `day10_sid=${sid}` },
  })
  assert.equal((await cleared.json()).cleared, true)
  const fresh = sidOf(cleared)
  assert.notEqual(fresh, sid, 'после очистки начинается новая сессия')

  const after = await fetch(`${base}/api/chat`, { headers: { cookie: `day10_sid=${sid}` } })
  assert.deepEqual((await after.json()).messages, [], 'старая переписка удалена у агента')
})

test('поток событий проксируется как есть', async () => {
  const { runId } = await (await ask({ prompt: 'вопрос' }, { ip: '10.0.0.6' })).json()
  const r = await fetch(`${base}/api/runs/${runId}/events`)
  assert.equal(r.status, 200)
  const text = await r.text()
  assert.match(text, /event: end\ndata: \{"status":"succeeded"/)
})

test('состояние несёт срок хранения переписки — тот, что у агента', async () => {
  const s = await (await fetch(`${base}/api/state`)).json()
  assert.equal(
    s.session.ttlHours,
    42,
    'число берётся у того, кто удаляет, а не из своего окружения',
  )
  assert.equal(s.defaults.contextTokens, 3000)
  assert.equal(JSON.stringify(s).includes('agent-key'), false)
})

test('отказ агента во входе доходит словами агента, слот возвращается', async () => {
  const before = (await (await fetch(`${base}/healthz`)).json()).limiter.callsToday
  const r = await ask({ prompt: '' }, { ip: '10.0.0.7' })
  assert.equal(r.status, 400)
  assert.equal((await r.json()).error, 'Напишите сообщение')
  assert.equal((await (await fetch(`${base}/healthz`)).json()).limiter.callsToday, before)
})

test('агент недоступен: 502 на запрос, 503 на состояние, 502 на переписку', async () => {
  agentMode = 'down'
  const before = (await (await fetch(`${base}/healthz`)).json()).limiter.callsToday
  assert.equal((await ask({ prompt: 'вопрос' }, { ip: '10.0.0.8' })).status, 502)
  assert.equal((await (await fetch(`${base}/healthz`)).json()).limiter.callsToday, before)
  assert.equal((await fetch(`${base}/api/state`)).status, 503)
  assert.equal((await fetch(`${base}/api/chat`)).status, 502)
  agentMode = 'ok'
})

test('лимитер стоит до агента: отказ не доходит до сервиса', async () => {
  const calls = agentLog.length
  for (let i = 0; i < 4; i++)
    assert.equal((await ask({ prompt: 'раз' }, { ip: '10.0.0.9' })).status, 202)
  const refused = await ask({ prompt: 'пятый' }, { ip: '10.0.0.9' })
  assert.equal(refused.status, 429)
  assert.match((await refused.json()).error, /Слишком часто/)
  assert.equal(agentLog.length, calls + 4, 'пятый запрос до агента не дошёл')
})

test('читаемое имя сессии выводится из идентификатора и не раскрывает его', async () => {
  const state = await fetch(`${base}/api/state`)
  const sid = sidOf(state)
  const body = await state.json()
  const name = body.session.name
  assert.match(name, /^[а-яё]+-[а-яё]+-\d{1,2}$/, 'вид «синий-кит-42»')
  assert.equal(JSON.stringify(body).includes(sid), false, 'идентификатора в ответе нет')

  // Имя устойчиво для одной сессии и другое у другой.
  const again = await fetch(`${base}/api/state`, { headers: { cookie: `day10_sid=${sid}` } })
  assert.equal((await again.json()).session.name, name)
  const other = await fetch(`${base}/api/state`, {
    headers: { cookie: 'day10_sid=55555555-5555-4555-8555-555555555555' },
  })
  assert.notEqual((await other.json()).session.name, name)
})

test('сумма токенов переписки приходит с сервера, а после очистки — ноль', async () => {
  const started = await ask({ prompt: 'вопрос' }, { ip: '10.0.0.11' })
  const sid = sidOf(started)
  const chat = await (
    await fetch(`${base}/api/chat`, { headers: { cookie: `day10_sid=${sid}` } })
  ).json()
  assert.equal(chat.totalTokens, 4200, 'сумму считает агент')
  assert.match(chat.session.name, /^[а-яё]+-[а-яё]+-\d{1,2}$/)

  const cleared = await (
    await fetch(`${base}/api/chat`, { method: 'DELETE', headers: { cookie: `day10_sid=${sid}` } })
  ).json()
  assert.equal(cleared.totalTokens, 0)
  assert.notEqual(cleared.session.name, chat.session.name, 'новая сессия — новое имя')
})

test('порог сжатия уходит агенту как есть: проверяет его агент', async () => {
  const r = await ask({ prompt: 'вопрос', contextTokens: 3000, summarizeAt: 2000 }, { ip: '10.0.0.12' })
  assert.equal(r.status, 202)
  const sent = JSON.parse(agentLog.at(-1).body).input
  assert.equal(sent.summarizeAt, 2000)
  assert.equal(sent.contextTokens, 3000)
})

test('переписка несёт сводку и контекст агента без изменений', async () => {
  const chat = await (
    await fetch(`${base}/api/chat`, { headers: { cookie: `day10_sid=${SUMMARIZED}` } })
  ).json()
  assert.equal(chat.summary.throughId, 7, 'блок сводки ставится по номеру сообщения')
  assert.equal(chat.summary.model, 'claude-haiku-4-5')
  assert.equal(chat.summary.truncated, false)
  assert.equal(chat.summary.text, 'пересказ')
  assert.deepEqual(chat.context, { total: 2560, summaryTokens: 560, freshTokens: 2000 })
})

test('сессия без сводки: summary null, контекст с сервера', async () => {
  const chat = await (
    await fetch(`${base}/api/chat`, {
      headers: { cookie: 'day10_sid=66666666-6666-4666-8666-666666666666' },
    })
  ).json()
  assert.equal(chat.summary, null)
  assert.deepEqual(chat.context, { total: 0, summaryTokens: 0, freshTokens: 0 })
})

test('стратегия и её поля уходят агенту как есть: проверяет их агент', async () => {
  const r = await ask(
    { prompt: 'вопрос', strategy: 'window', window: 10 },
    { ip: '10.0.0.13' },
  )
  assert.equal(r.status, 202)
  const sent = JSON.parse(agentLog.at(-1).body).input
  assert.equal(sent.strategy, 'window')
  assert.equal(sent.window, 10)
  // Неприменимое поле страница не отправляет, и день его не подставляет.
  assert.equal('contextTokens' in sent, false)
})

test('лимит фактов уходит агенту: и в запуске, и при чтении сессии', async () => {
  const r = await ask(
    { prompt: 'вопрос', strategy: 'facts', window: 10, factsTokens: 600 },
    { ip: '10.0.0.15' },
  )
  assert.equal(r.status, 202)
  const sent = JSON.parse(agentLog.at(-1).body).input
  assert.equal(sent.strategy, 'facts')
  assert.equal(sent.factsTokens, 600)
  // Счётчик обязан описывать режим фактов, поэтому лимит идёт и в чтение.
  await fetch(`${base}/api/chat?strategy=facts&window=10&factsTokens=600`, {
    headers: { cookie: `day10_sid=${SUMMARIZED}` },
  })
  assert.match(agentLog.at(-1).url, /factsTokens=600/)
})

test('факты доходят до страницы: без них блок памяти нечем показать', async () => {
  const chat = await (
    await fetch(`${base}/api/chat?strategy=facts&factsTokens=600`, {
      headers: { cookie: `day10_sid=${SUMMARIZED}` },
    })
  ).json()
  assert.equal(chat.facts.tokens, 420)
  assert.equal(chat.facts.throughId, 7)
  assert.equal(chat.facts.truncatedStreak, 2)
  // После очистки фактов нет: выжимка уходит вместе с перепиской.
  const cleared = await (
    await fetch(`${base}/api/chat`, {
      method: 'DELETE',
      headers: { cookie: 'day10_sid=99999999-9999-4999-8999-999999999999' },
    })
  ).json()
  assert.equal(cleared.facts, null)
})

test('родитель ветки уходит агенту: правка рождает сестру', async () => {
  const r = await ask(
    { prompt: 'иначе', strategy: 'branches', parentId: 2 },
    { ip: '10.0.0.14' },
  )
  assert.equal(r.status, 202)
  assert.equal(JSON.parse(agentLog.at(-1).body).input.parentId, 2)
})

test('параметры стратегии уходят агенту при чтении сессии', async () => {
  const chat = await (
    await fetch(`${base}/api/chat?strategy=window&model=anthropic-haiku&window=10&lol=1`, {
      headers: { cookie: `day10_sid=${SUMMARIZED}` },
    })
  ).json()
  const asked = agentLog.at(-1).url
  assert.match(asked, /strategy=window/)
  assert.match(asked, /window=10/)
  // Список параметров закрытый: чужое до агента не доходит.
  assert.equal(asked.includes('lol'), false)
  assert.deepEqual(chat.context, { total: 3180 }, 'контекст посчитан под названный режим')
})

test('голова ветки и родители сообщений доходят до страницы', async () => {
  const chat = await (
    await fetch(`${base}/api/chat`, { headers: { cookie: `day10_sid=${TREE}` } })
  ).json()
  assert.equal(chat.head, 4, 'голова приходит с сервера, а не считается страницей')
  assert.equal(chat.messages.find((m) => m.id === 5).parentId, 2, 'сестра под тем же родителем')
})

test('переключение ветки ставит голову на поздний лист поддерева', async () => {
  const r = await fetch(`${base}/api/chat/head`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: `day10_sid=${TREE}` },
    body: JSON.stringify({ messageId: 5 }),
  })
  assert.equal(r.status, 200)
  assert.equal((await r.json()).head, 6)

  const chat = await (
    await fetch(`${base}/api/chat`, { headers: { cookie: `day10_sid=${TREE}` } })
  ).json()
  assert.equal(chat.head, 6, 'голова переживает перезагрузку страницы')
  heads.delete(TREE)
})

test('чужое сообщение — 404, идущий запуск — 409, голова не двигается', async () => {
  const put = (messageId) =>
    fetch(`${base}/api/chat/head`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: `day10_sid=${TREE}` },
      body: JSON.stringify({ messageId }),
    })
  assert.equal((await put(999)).status, 404)
  assert.equal((await put(888)).status, 409)
  const chat = await (
    await fetch(`${base}/api/chat`, { headers: { cookie: `day10_sid=${TREE}` } })
  ).json()
  assert.equal(chat.head, 4, 'после отказов голова прежняя')
})

test('нецелый messageId отклоняется днём и до агента не доходит', async () => {
  const calls = agentLog.length
  const r = await fetch(`${base}/api/chat/head`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: `day10_sid=${TREE}` },
    body: JSON.stringify({ messageId: '5; drop' }),
  })
  assert.equal(r.status, 400)
  assert.equal(agentLog.length, calls, 'до агента запрос не дошёл')
})

test('после очистки сводки нет, контекст пуст', async () => {
  const cleared = await (
    await fetch(`${base}/api/chat`, {
      method: 'DELETE',
      headers: { cookie: `day10_sid=${SUMMARIZED}` },
    })
  ).json()
  assert.equal(cleared.summary, null)
  assert.deepEqual(cleared.context, { total: 0, summaryTokens: 0, freshTokens: 0 })
})
