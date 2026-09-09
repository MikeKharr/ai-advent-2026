// Диалог с памятью: что уходит модели, что пишется в базу, что происходит
// при параллельных сообщениях. Требует Node 24 или флага --experimental-sqlite.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { createNewsAnalyst } from '../src/agent.js'
import { CONTEXT_SHARE, effectiveContext } from '../src/llm.js'
import { createRuns } from '../src/runs.js'
import { createService } from '../src/service.js'
import { createSessions } from '../src/sessions.js'
import { ENV, fakeArchive, fakeRouter, NEWS, ROUTER_ANSWER } from './fixtures.js'

const SID = '11111111-1111-4111-8111-111111111111'

/** Агент с настоящим хранилищем диалогов и поддельным роутером. */
function setup({ router, archive } = {}) {
  const sessions = createSessions({ file: ':memory:', ttlMs: 30 * 3600_000, log: () => {} })
  const runs = createRuns()
  const fetchImpl = router ?? fakeRouter()
  const tool = archive ?? fakeArchive()
  const agent = createNewsAnalyst({
    agent: NEWS,
    archive: tool,
    runs,
    sessions,
    env: ENV,
    fetchImpl,
    log: () => {},
  })
  const ask = async (body) => {
    const parsed = agent.parseInput({ sessionId: SID, ...body })
    if (!parsed.ok) return { refused: parsed.message }
    const run = runs.create({ agent, input: parsed.input })
    agent.hold(parsed.input.sessionId)
    await agent.execute(run)
    return { run, snapshot: runs.snapshot(run.id) }
  }
  return { agent, runs, sessions, fetchImpl, tool, ask }
}

test('второе сообщение уходит модели вместе с первым разговором', async () => {
  const { ask, fetchImpl, sessions } = setup()
  await ask({ sphere: 'финтех', prompt: 'что нового' })
  await ask({ sphere: 'финтех', prompt: 'а подробнее про первое' })

  const first = fetchImpl.calls[0].body.input
  const second = fetchImpl.calls[1].body.input
  assert.equal(first.includes('<dialog>'), false, 'первому сообщению вспоминать нечего')
  assert.match(second, /<dialog>/)
  assert.match(second, /Пользователь: что нового/)
  assert.match(second, /Агент: Ответ модели/)
  assert.match(second, /а подробнее про первое/, 'текущий вопрос — отдельно от истории')

  // В базе диалог целиком: два вопроса и два ответа.
  assert.deepEqual(
    sessions.history(SID).map((m) => m.role),
    ['user', 'agent', 'user', 'agent'],
  )
})

test('переписка переживает перезапуск агента', async () => {
  const first = setup()
  await first.ask({ sphere: 'финтех', prompt: 'запомни: меня зовут Михаил' })

  // Новый агент и новые запуски поверх той же базы — как после рестарта.
  const runs = createRuns()
  const fetchImpl = fakeRouter()
  const agent = createNewsAnalyst({
    agent: NEWS,
    archive: fakeArchive(),
    runs,
    sessions: first.sessions,
    env: ENV,
    fetchImpl,
    log: () => {},
  })
  const parsed = agent.parseInput({ sessionId: SID, sphere: 'финтех', prompt: 'как меня зовут?' })
  const run = runs.create({ agent, input: parsed.input })
  await agent.execute(run)

  assert.match(
    fetchImpl.calls[0].body.input,
    /меня зовут Михаил/,
    'агент помнит сказанное до перезапуска',
  )
})

test('результат несёт одно число токенов и состояние контекста', async () => {
  const { ask } = setup()
  await ask({ sphere: 'финтех', prompt: 'первый вопрос' })
  const { snapshot } = await ask({ sphere: 'финтех', prompt: 'второй вопрос' })

  const r = snapshot.result
  assert.equal(r.totalTokens, 540, 'вход плюс выход одним числом')
  assert.equal(r.summary.totalTokens, 540)
  assert.equal(r.context.effective, 3000, 'у Haiku 40 % предела больше заданного')
  assert.equal(r.context.requested, 3000)
  assert.ok(r.context.used > 0 && r.context.used < 3000)
  assert.equal(r.context.messages, 2, 'вопрос и ответ первой итерации')
})

test('контекст урезается пределом модели, а не только параметром', async () => {
  // На Qwen 3000 токенов памяти не помещаются: там весь вход 4300.
  const { ask, runs } = setup({
    router: fakeRouter({
      models: {
        providers: [
          { id: 'groq-qwen3.6-27b', maxRequestTokens: 5000, quota: null, available: true },
        ],
      },
    }),
  })
  await ask({ sphere: 'финтех', prompt: 'первый вопрос', model: 'groq-qwen3.6-27b' })
  const { snapshot } = await ask({
    sphere: 'финтех',
    prompt: 'второй вопрос',
    model: 'groq-qwen3.6-27b',
  })

  assert.equal(snapshot.result.context.requested, 3000)
  assert.equal(snapshot.result.context.effective, 1720, '40 % от 4300')
  assert.ok(snapshot.result.context.used <= 1720)
  assert.equal(effectiveContext(3000, 4300), Math.floor(4300 * CONTEXT_SHARE))
  assert.equal(effectiveContext(500, 40_000), 500, 'заданное меньше доли — берём заданное')
  assert.equal(effectiveContext(0, 40_000), 0, 'ноль — законное значение')
  void runs
})

test('нулевой контекст: память не поднимается, событие о ней не возникает', async () => {
  const { ask, fetchImpl } = setup()
  await ask({ sphere: 'финтех', prompt: 'первый вопрос', contextTokens: 0 })
  const { snapshot } = await ask({ sphere: 'финтех', prompt: 'второй вопрос', contextTokens: 0 })

  assert.equal(fetchImpl.calls[1].body.input.includes('<dialog>'), false)
  assert.equal(snapshot.result.context.used, 0)
  assert.equal(
    snapshot.events.some((e) => e.title === 'Вспомнил разговор'),
    false,
  )
})

test('второе сообщение в занятой сессии отклоняется до создания запуска', () => {
  const { agent } = setup()
  const first = agent.parseInput({ sessionId: SID, sphere: 'финтех', prompt: 'раз' })
  assert.equal(first.ok, true)
  agent.hold(SID)

  const second = agent.parseInput({ sessionId: SID, sphere: 'финтех', prompt: 'два' })
  assert.equal(second.ok, false)
  assert.match(second.message, /Дождитесь ответа/)

  // Чужая сессия не заперта.
  const other = agent.parseInput({
    sessionId: '22222222-2222-4222-8222-222222222222',
    sphere: 'финтех',
    prompt: 'три',
  })
  assert.equal(other.ok, true)
})

test('после ответа сессия снова свободна', async () => {
  const { agent, ask } = setup()
  await ask({ sphere: 'финтех', prompt: 'раз' })
  assert.equal(agent.isBusy(SID), false)
  assert.equal(agent.parseInput({ sessionId: SID, sphere: 'финтех', prompt: 'два' }).ok, true)
})

test('неудача оставляет вопрос в переписке и ошибку рядом, но не в контексте', async () => {
  const { ask, sessions } = setup({
    router: fakeRouter({
      status: 429,
      route: { ok: false, code: 'budget_exceeded', message: 'суточный лимит исчерпан' },
    }),
  })
  const { snapshot } = await ask({ sphere: 'финтех', prompt: 'вопрос без ответа' })
  assert.equal(snapshot.status, 'failed')

  const history = sessions.history(SID)
  assert.deepEqual(
    history.map((m) => m.role),
    ['user', 'agent'],
  )
  assert.equal(history[1].meta.error, true)
  assert.match(history[1].text, /Суточный лимит/)
  assert.deepEqual(
    sessions.tail(SID, 10_000).messages.map((m) => m.text),
    ['вопрос без ответа'],
    'в контекст ушёл вопрос, но не наш текст об отказе',
  )
})

test('сессия не заперта после неудачи', async () => {
  const { agent, ask } = setup({ router: fakeRouter({ route: new TypeError('fetch failed') }) })
  await ask({ sphere: 'финтех', prompt: 'вопрос' })
  assert.equal(agent.isBusy(SID), false)
})

test('без сессии агент работает как в дне 6', async () => {
  const { agent, runs, fetchImpl, sessions } = setup()
  const parsed = agent.parseInput({ sphere: 'финтех', prompt: 'одиночный вопрос' })
  assert.equal(parsed.input.sessionId, null)
  const run = runs.create({ agent, input: parsed.input })
  await agent.execute(run)

  assert.equal(fetchImpl.calls[0].body.input.includes('<dialog>'), false)
  assert.equal(sessions.stats().messages, 0, 'без сессии в базу ничего не пишется')
  assert.equal(runs.snapshot(run.id).result.context.used, 0)
})

test('кривой идентификатор сессии отвергается на границе', () => {
  const { agent } = setup()
  assert.match(
    agent.parseInput({ sessionId: '../../etc', sphere: 'x' }).message,
    /идентификатором сессии/,
  )
  assert.match(agent.parseInput({ sessionId: 42, sphere: 'x' }).message, /идентификатором сессии/)
})

test('в событиях монитора нет текстов диалога', async () => {
  const { ask, runs } = setup()
  await ask({ sphere: 'финтех', prompt: 'СЕКРЕТ первой реплики' })
  const { run } = await ask({ sphere: 'финтех', prompt: 'вторая реплика' })
  const events = runs.snapshot(run.id).events
  assert.equal(JSON.stringify(events).includes('СЕКРЕТ'), false)
  const recalled = events.find((e) => e.title === 'Вспомнил разговор')
  assert.equal(recalled.data.messages, 2)
  assert.ok(recalled.data.used > 0)
  void ROUTER_ANSWER
})

test('через сервис переписка читается и удаляется по идентификатору', async () => {
  const { agent, runs, sessions } = setup()
  sessions.append({ sessionId: SID, role: 'user', text: 'привет', tokens: 5 })
  sessions.append({ sessionId: SID, role: 'agent', text: 'здравствуйте', tokens: 7, meta: { totalTokens: 12 } })

  const agents = new Map([[agent.id, agent]])
  const server = createServer(
    createService({ agents, archive: fakeArchive(), runs, sessions, env: ENV, log: () => {} }),
  )
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const auth = { authorization: 'Bearer agent-key' }

  const read = await (await fetch(`${base}/v1/sessions/${SID}`, { headers: auth })).json()
  assert.deepEqual(
    read.messages.map((m) => m.text),
    ['привет', 'здравствуйте'],
  )
  assert.equal(read.messages[1].meta.totalTokens, 12, 'сводка переживает перезапуск вместе с текстом')

  const health = await (await fetch(`${base}/healthz`)).json()
  assert.equal(health.sessions.messages, 2)

  const cleared = await (await fetch(`${base}/v1/sessions/${SID}`, { method: 'DELETE', headers: auth })).json()
  assert.equal(cleared.removed, 2)
  assert.deepEqual((await (await fetch(`${base}/v1/sessions/${SID}`, { headers: auth })).json()).messages, [])
  await new Promise((r) => server.close(r))
})

test('сводка ответа переживает перезапуск: в ней всё для раскрытия', async () => {
  const { ask, sessions } = setup()
  await ask({ sphere: 'климатические технологии', prompt: 'вопрос', maxTokens: 500 })
  const [user, agentMsg] = sessions.history(SID)

  assert.equal(user.meta.sphere, 'климатические технологии', 'тема — у реплики пользователя')
  const m = agentMsg.meta
  assert.equal(m.model, 'claude-haiku-4-5')
  assert.equal(m.inputTokens, 500)
  assert.equal(m.outputTokens, 40)
  assert.equal(m.totalTokens, 540)
  assert.equal(m.articlesUsed, 2)
  assert.equal(m.articlesSelected, 2)
  assert.equal(m.links, 2)
  assert.equal(m.strippedLinks, 1)
  assert.equal(m.maxTokens, 500)
  assert.equal(m.contextRequested, 3000)
  assert.equal(m.systemOverridden, false)
  assert.equal(typeof m.durationMs, 'number')
})

test('тема пользователя не попадает в снимок запуска', async () => {
  const { ask, runs } = setup()
  const { run } = await ask({ sphere: 'тайная тема', prompt: 'вопрос' })
  assert.equal(JSON.stringify(runs.snapshot(run.id)).includes('тайная тема'), false)
})

test('не поместившиеся реплики считаются, а не молчат', () => {
  const sessions = createSessions({ file: ':memory:', ttlMs: 3600_000, log: () => {} })
  for (let i = 1; i <= 5; i++)
    sessions.append({ sessionId: SID, role: 'user', text: `реплика ${i}`, tokens: 100 })
  assert.deepEqual(sessions.tail(SID, 250), {
    messages: [
      { role: 'user', text: 'реплика 4', tokens: 100 },
      { role: 'user', text: 'реплика 5', tokens: 100 },
    ],
    tokens: 200,
    dropped: 3,
  })
  assert.equal(sessions.tail(SID, 10_000).dropped, 0, 'всё поместилось — выпавших нет')
  sessions.close()
})

test('сумма токенов переписки: ответы считаются, отказы — нет', async () => {
  const { ask, sessions } = setup()
  await ask({ prompt: 'первый вопрос' })
  await ask({ prompt: 'второй вопрос' })
  assert.equal(sessions.totalTokens(SID), 1080, 'две итерации по 540 токенов')

  sessions.append({ sessionId: SID, role: 'agent', text: 'отказ', tokens: 0, meta: { error: true, totalTokens: 999 } })
  assert.equal(sessions.totalTokens(SID), 1080, 'отказ ничего не стоил')
  assert.equal(sessions.totalTokens('44444444-4444-4444-8444-444444444444'), 0, 'чужая сессия — ноль')
})

test('без темы отбор идёт по словам разговора, а не по полю', async () => {
  const { ask, fetchImpl, tool } = setup()
  await ask({ prompt: 'что нового в финтехе' })
  await ask({ prompt: 'а подробнее про первое' })

  // Второй запрос сам по себе не содержит зацепок: слова должны прийти
  // из прежних реплик пользователя.
  const query = tool.calls[1].prompt
  assert.match(query, /финтех/, 'тема разговора попала в отбор')
  assert.match(query, /подробнее/, 'текущее сообщение тоже')
  assert.equal(fetchImpl.calls[1].body.input.includes('Тематика:'), false, 'темы в промпте нет')
})

test('без числа статей подборку ограничивают потолок издания и предел модели', async () => {
  const { ask, tool } = setup()
  await ask({ prompt: 'вопрос' })
  assert.equal(tool.calls[0].limit, 200, 'явного числа нет — берём столько, сколько влезет')

  const explicit = setup()
  await explicit.ask({ prompt: 'вопрос', articles: 12 })
  assert.equal(explicit.tool.calls[0].limit, 12, 'явное число дни 6 и 7 присылают как прежде')
})
