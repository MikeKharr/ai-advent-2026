// Сводка диалога дня 9 (ADR 2026-09-11-1608): порог N, вызов сводки через
// роутер, порядок блоков во входе, отказ без падения, хранение и удаление.
// Требует Node 24 или флага --experimental-sqlite.

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { createNewsAnalyst } from '../src/agent.js'
import { buildInput, summaryTarget } from '../src/llm.js'
import { createRuns } from '../src/runs.js'
import { createService } from '../src/service.js'
import { createSessions } from '../src/sessions.js'
import { ENV, fakeArchive, NEWS, ROUTER_ANSWER, ROUTER_MODELS } from './fixtures.js'

const SID = '55555555-5555-4555-8555-555555555555'

const SUMMARY_ANSWER = {
  ok: true,
  text: 'Сводка: пользователь спрашивал про финтех в Индии.',
  provider: { id: 'anthropic-haiku', model: 'claude-haiku-4-5', tier: 'cloud-frontier' },
  truncated: false,
  durationMs: 700,
  usage: { inputTokens: 1300, outputTokens: 500 },
}

/**
 * Роутер, отвечающий по классу задачи: сводке — своим ответом, ответу
 * агента — своим. Записывает все тела вызовов.
 */
function routerByClass({
  summary = SUMMARY_ANSWER,
  summaryStatus = 200,
  models,
  onSummary = () => {},
} = {}) {
  const calls = []
  const impl = async (url, options = {}) => {
    const u = String(url)
    if (u.includes('/v1/models')) {
      return { ok: true, status: 200, json: async () => models ?? ROUTER_MODELS }
    }
    const body = JSON.parse(options.body)
    calls.push(body)
    if (body.taskClass === 'summarize') {
      // Пока «модель думает» — место для гонки с «очистить».
      onSummary()
      if (summary instanceof Error) throw summary
      return {
        ok: summaryStatus < 300,
        status: summaryStatus,
        json: async () => summary,
      }
    }
    return { ok: true, status: 200, json: async () => ROUTER_ANSWER }
  }
  impl.calls = calls
  impl.summaries = () => calls.filter((c) => c.taskClass === 'summarize')
  impl.answers = () => calls.filter((c) => c.taskClass === 'news_answer')
  return impl
}

function setup({ router } = {}) {
  const sessions = createSessions({ file: ':memory:', ttlMs: 30 * 3600_000, log: () => {} })
  const runs = createRuns()
  const fetchImpl = router ?? routerByClass()
  const tool = fakeArchive()
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
  /** Прежняя переписка: пары «вопрос — ответ» по `tokens` токенов каждая. */
  const seed = (pairs, tokens) => {
    for (let i = 1; i <= pairs; i++) {
      sessions.append({ sessionId: SID, role: 'user', text: `старый вопрос ${i} про Индию`, tokens })
      sessions.append({ sessionId: SID, role: 'agent', text: `старый ответ ${i}`, tokens })
    }
  }
  return { agent, runs, sessions, fetchImpl, tool, ask, seed }
}

test('порог достигнут: одна сводка до ответа, Haiku, класс summarize, потолок 0,3·N', async () => {
  const { ask, seed, fetchImpl, sessions } = setup()
  seed(2, 500) // 2000 токенов после сводки — ровно N

  const { snapshot } = await ask({ prompt: 'что нового', summarizeAt: 2000 })

  assert.equal(snapshot.status, 'succeeded')
  const calls = fetchImpl.summaries()
  assert.equal(calls.length, 1, 'одна суммаризация за запуск')
  assert.equal(calls[0].provider, 'anthropic-haiku')
  assert.equal(calls[0].answerTokens, 600, '⌈0,3 × 2000⌉')
  assert.match(calls[0].system, /от 400 до 600 токенов/, 'целевой объём — в промпте')
  assert.match(calls[0].input, /старый вопрос 1 про Индию/)
  assert.match(calls[0].input, /старый ответ 2/)
  assert.equal(calls[0].input.includes('что нового'), false, 'текущий запрос в сводку не идёт')
  // Сводка — до ответа: вызов сводки первым в журнале роутера.
  assert.equal(fetchImpl.calls[0].taskClass, 'summarize')
  assert.equal(fetchImpl.calls[1].taskClass, 'news_answer')

  const stored = sessions.summary(SID)
  assert.equal(stored.text, SUMMARY_ANSWER.text)
  assert.equal(stored.tokens, 500)
  assert.equal(stored.sourceTokens, 2000)
  assert.equal(stored.throughId, 4, 'последняя реплика, вошедшая в сводку')
  assert.equal(
    snapshot.events.some((e) => e.title === 'Старые реплики не вошли в сводку'),
    false,
    'в обычном потоке потолок исходника не срабатывает',
  )
})

test('обычный поток: порог и самая длинная пара умещаются в исходник целиком', async () => {
  const { ask, seed, sessions, fetchImpl } = setup()
  seed(2, 500) // 2000 — порог
  // Самая длинная пара одного запуска: вопрос 1000 токенов и ответ до MAX_OUTPUT_TOKENS.
  sessions.append({ sessionId: SID, role: 'user', text: 'длинный вопрос', tokens: 1000 })
  sessions.append({ sessionId: SID, role: 'agent', text: 'длинный ответ', tokens: ENV.MAX_OUTPUT_TOKENS })

  const { snapshot } = await ask({ prompt: 'вопрос', summarizeAt: 2000 })

  const call = snapshot.events.find((e) => e.title === 'Сжимаю историю')
  assert.equal(call.data.sourceTokens, 2000 + 1000 + ENV.MAX_OUTPUT_TOKENS)
  assert.equal(call.data.droppedFromSource, 0)
  assert.match(fetchImpl.summaries()[0].input, /старый вопрос 1 про Индию/)
})

test('накопленная история: вход сводки не больше потолка исходника', async () => {
  const { ask, seed, fetchImpl, sessions } = setup()
  seed(30, 500) // 30 000 токенов после сводки, 60 реплик

  const { snapshot } = await ask({ prompt: 'вопрос', summarizeAt: 2000 })

  const cap = 2000 + ENV.MAX_OUTPUT_TOKENS + 1000
  const call = snapshot.events.find((e) => e.title === 'Сжимаю историю')
  assert.ok(call.data.sourceTokens <= cap, `${call.data.sourceTokens} > ${cap}`)
  const fit = Math.floor(cap / 500) // целых реплик по 500 под потолком
  assert.equal(call.data.sourceTokens, fit * 500, 'свежие реплики до потолка')
  assert.equal(call.data.droppedFromSource, 60 - fit)
  const input = fetchImpl.summaries()[0].input
  assert.match(input, /старый ответ 30/, 'свежие реплики вошли')
  assert.equal(input.includes('старый вопрос 1 про'), false, 'старшие отброшены')
  const warning = snapshot.events.find((e) => e.title === 'Старые реплики не вошли в сводку')
  assert.equal(warning.level, 'warn')
  assert.equal(sessions.summary(SID).throughId, 60, 'отброшенные в следующую сводку не вернутся')
})

test('после оплаченных отказов сводки вход всё равно ограничен', async () => {
  const { ask, seed, runs } = setup({
    router: routerByClass({
      summaryStatus: 502,
      summary: { ok: false, code: 'provider_error', message: 'провайдер не ответил', attempts: [{}] },
    }),
  })
  const cap = 2000 + ENV.MAX_OUTPUT_TOKENS + 1000
  seed(3, 1000)
  await ask({ prompt: 'первый', summarizeAt: 2000 }) // сводка не удалась, реплики копятся
  seed(3, 1000)

  const { run } = await ask({ prompt: 'второй', summarizeAt: 2000 })

  const call = runs.snapshot(run.id).events.find((e) => e.title === 'Сжимаю историю')
  assert.ok(call.data.sourceTokens <= cap, `${call.data.sourceTokens} > ${cap}`)
  assert.ok(call.data.droppedFromSource > 0)
})

test('ниже порога сводка не делается и не пишется', async () => {
  const { ask, seed, fetchImpl, sessions } = setup()
  seed(2, 499) // 1996 < 2000

  await ask({ prompt: 'что нового', summarizeAt: 2000 })

  assert.equal(fetchImpl.summaries().length, 0)
  assert.equal(sessions.summary(SID), null)
  assert.match(fetchImpl.answers()[0].input, /<dialog>[\s\S]*старый вопрос 1/)
})

test('вход после сводки: <summary>, затем <dialog> только с репликами после неё, затем <request>', async () => {
  const { ask, seed, fetchImpl } = setup()
  seed(2, 500)
  const first = await ask({ prompt: 'первый вопрос', summarizeAt: 2000 })
  // Сразу после сжатия реплик после сводки нет: в контексте одна сводка.
  const firstInput = fetchImpl.answers()[0].input
  assert.match(firstInput, /<summary>\nСводка: пользователь спрашивал/)
  assert.equal(firstInput.includes('<dialog>'), false)
  assert.equal(first.snapshot.result.context.summaryTokens, 500)
  assert.equal(first.snapshot.result.context.freshTokens, 0)

  await ask({ prompt: 'второй вопрос', summarizeAt: 2000 })

  assert.equal(fetchImpl.summaries().length, 1, 'ниже порога второй сводки нет')
  const input = fetchImpl.answers()[1].input
  const at = (s) => input.indexOf(s)
  assert.ok(at('<summary>') >= 0 && at('<summary>') < at('<dialog>'), 'сводка раньше реплик')
  assert.ok(at('</dialog>') < at('<request>'), 'реплики раньше текущего запроса')
  assert.ok(at('</request>') < at('<candidates>'))
  const dialog = input.slice(at('<dialog>'), at('</dialog>'))
  assert.match(dialog, /Пользователь: первый вопрос/)
  assert.match(dialog, /Агент: Ответ модели/)
  assert.equal(dialog.includes('старый вопрос'), false, 'сжатые реплики в диалог не идут')
})

test('сводка ответа несёт коэффициент, сумма сессии — цену сводки', async () => {
  const { ask, seed, sessions } = setup()
  seed(2, 500)

  const { snapshot } = await ask({ prompt: 'вопрос', summarizeAt: 2000 })

  const r = snapshot.result
  assert.deepEqual(r.summary.summarized, {
    tokens: 500,
    sourceTokens: 2000,
    ratio: 0.25,
    totalTokens: 1800, // вход 1300 + выход 500 вызова сводки
  })
  assert.deepEqual(r.context.summarized, r.summary.summarized)
  assert.equal(r.summary.summarizeAt, 2000)
  assert.equal(r.summary.totalTokens, 540, 'в сводке ответа — сам ответ')
  assert.equal(r.totalTokens, 540 + 1800, 'запуск — ответ плюс сводка')
  assert.equal(sessions.totalTokens(SID), 540 + 1800, 'сумма сессии включает вызов сводки')

  // Сжатие — до «Вспомнил разговор», в порядке раскладки дня 9.
  const titles = snapshot.events.map((e) => e.title)
  const compressed = titles.indexOf('Сжал историю: 2000 → 500 токенов (25 %)')
  assert.ok(titles.indexOf('Сжимаю историю') < titles.indexOf('Получил сводку'))
  assert.ok(titles.indexOf('Получил сводку') < compressed)
  assert.ok(compressed < titles.indexOf('Вспомнил разговор'))
  assert.equal(snapshot.events[compressed].detail, 'сжал Claude Haiku 4.5; порог 2000')
})

test('провайдер сводки — Haiku, даже когда чат идёт на другой модели', async () => {
  const { ask, seed, fetchImpl } = setup()
  seed(2, 500)

  await ask({ prompt: 'вопрос', summarizeAt: 1000, contextTokens: 1720, model: 'groq-qwen3.6-27b' })

  assert.equal(fetchImpl.summaries()[0].provider, 'anthropic-haiku')
  assert.equal(fetchImpl.summaries()[0].answerTokens, 300)
  assert.equal(fetchImpl.answers()[0].provider, 'groq-qwen3.6-27b')
})

test('отказ сводки: ответ по хвосту с предупреждением, сводка в базе не меняется', async () => {
  const { ask, seed, fetchImpl, sessions } = setup({
    router: routerByClass({
      summaryStatus: 502,
      summary: { ok: false, code: 'provider_error', message: 'провайдер не ответил', attempts: [{}] },
    }),
  })
  sessions.append({ sessionId: SID, role: 'user', text: 'до сводки', tokens: 10 })
  sessions.saveSummary({
    sessionId: SID,
    text: 'прежняя сводка',
    tokens: 100,
    sourceTokens: 400,
    throughId: 1,
  })
  seed(2, 500)

  const { snapshot } = await ask({ prompt: 'вопрос', summarizeAt: 2000 })

  assert.equal(snapshot.status, 'succeeded', 'отказ сводки запуск не валит')
  const warning = snapshot.events.find((e) => e.title === 'Историю не сжал')
  assert.equal(warning.level, 'warn')
  const stored = sessions.summary(SID)
  assert.equal(stored.text, 'прежняя сводка')
  assert.equal(stored.throughId, 1)
  // Прежняя сводка и хвост в пределах окна: 3000 − 100 = 2900, все четыре реплики.
  const input = fetchImpl.answers()[0].input
  assert.match(input, /<summary>\nпрежняя сводка/)
  assert.match(input, /<dialog>[\s\S]*старый вопрос 1[\s\S]*старый ответ 2/)
  assert.equal(input.includes('до сводки'), false, 'сжатое в диалог не идёт')
  assert.equal(snapshot.result.summary.summarized, null)
  assert.equal(snapshot.result.context.dropped, 0)
})

test('обрыв сети на сводке: предупреждение, и запуск считается оплаченным при отказе ответа', async () => {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes('/v1/models'))
      return { ok: true, status: 200, json: async () => ROUTER_MODELS }
    const body = JSON.parse(options.body)
    calls.push(body)
    if (body.taskClass === 'summarize') throw new TypeError('fetch failed')
    return {
      ok: false,
      status: 429,
      json: async () => ({ ok: false, code: 'budget_exceeded', message: 'исчерпан' }),
    }
  }
  const { ask, seed } = setup({ router: fetchImpl })
  seed(2, 500)

  const { snapshot } = await ask({ prompt: 'вопрос', summarizeAt: 2000 })

  assert.equal(snapshot.status, 'failed')
  assert.ok(snapshot.events.some((e) => e.title === 'Историю не сжал'))
  // Отказ ответа сам денег не стоил, но вызов сводки мог дойти до провайдера:
  // слот лимитера дню не возвращается.
  assert.equal(snapshot.error.paidNothing, false)
})

test('сводку и ответ роутер отклонил до провайдера — запуск ничего не стоил', async () => {
  const refused = {
    ok: false,
    code: 'budget_exceeded',
    message: 'суточный лимит исчерпан',
    attempts: [],
  }
  const fetchImpl = async (url) => {
    if (String(url).includes('/v1/models'))
      return { ok: true, status: 200, json: async () => ROUTER_MODELS }
    return { ok: false, status: 429, json: async () => refused }
  }
  const { ask, seed } = setup({ router: fetchImpl })
  seed(2, 500)

  const { snapshot } = await ask({ prompt: 'вопрос', summarizeAt: 2000 })

  assert.equal(snapshot.status, 'failed')
  assert.ok(snapshot.events.some((e) => e.title === 'Историю не сжал'))
  assert.equal(snapshot.error.paidNothing, true, 'слот лимитера дню возвращается')
})

test('пустая оплаченная сводка: цена в сумме сессии, сводки нет', async () => {
  const { ask, seed, sessions } = setup({
    router: routerByClass({
      summary: { ...SUMMARY_ANSWER, text: '  ', usage: { inputTokens: 1300, outputTokens: 3 } },
    }),
  })
  seed(2, 500)

  const { snapshot } = await ask({ prompt: 'вопрос', summarizeAt: 2000 })

  assert.equal(snapshot.status, 'succeeded')
  assert.equal(sessions.summary(SID), null)
  const warning = snapshot.events.find((e) => e.title === 'Историю не сжал')
  assert.match(warning.detail, /пустую сводку/)
  assert.equal(snapshot.result.summary.summarized, null)
  assert.equal(snapshot.result.totalTokens, 540 + 1303, 'запуск: ответ плюс пустой вызов')
  assert.equal(sessions.totalTokens(SID), 540 + 1303, 'сумма сессии: тоже')
})

test('«очистить» во время сжатия не воскрешает сводку стёртой переписки', async () => {
  let clearNow = () => {}
  const { ask, seed, sessions } = setup({ router: routerByClass({ onSummary: () => clearNow() }) })
  clearNow = () => sessions.clear(SID) // так же чистит и уборка по сроку
  seed(2, 500)

  const { snapshot } = await ask({ prompt: 'вопрос', summarizeAt: 2000 })

  assert.equal(snapshot.status, 'succeeded')
  assert.equal(sessions.summary(SID), null, 'сводка стёртой переписки не записана')
  const warning = snapshot.events.find((e) => e.title === 'Историю не сжал')
  assert.match(warning.detail, /очистили во время сжатия/)
  // После очистки в сессии только пара этого запуска, без цены чужой сводки.
  assert.deepEqual(
    sessions.history(SID).map((m) => m.text.slice(0, 6)),
    ['вопрос', 'Ответ '],
  )
  assert.equal(sessions.totalTokens(SID), 540)
})

test('сводка, не поместившаяся в окно модели, не идёт — с предупреждением', async () => {
  const models = {
    providers: [
      { id: 'groq-qwen3.6-27b', model: 'qwen/qwen3.6-27b', maxRequestTokens: 5000, quota: null },
    ],
  }
  const { ask, sessions, fetchImpl } = setup({ router: routerByClass({ models }) })
  sessions.append({ sessionId: SID, role: 'user', text: 'давно', tokens: 10 })
  sessions.saveSummary({
    sessionId: SID,
    text: 'длинная сводка',
    tokens: 1800,
    sourceTokens: 6000,
    throughId: 1,
  })

  // Окно Qwen: min(3000, ⌊0,4 × 4300⌋) = 1720 < 1800.
  const { snapshot } = await ask({ prompt: 'вопрос', model: 'groq-qwen3.6-27b', summarizeAt: 2000 })

  const warning = snapshot.events.find((e) => e.title === 'Сводка не поместилась в окно модели')
  assert.equal(warning.level, 'warn')
  assert.match(warning.detail, /1800 токенов, окно 1720/)
  assert.equal(fetchImpl.answers()[0].input.includes('<summary>'), false)
  assert.equal(snapshot.result.context.summaryTokens, 0)
})

test('обрезанная потолком сводка сохраняется с предупреждением', async () => {
  const { ask, seed, sessions } = setup({
    router: routerByClass({ summary: { ...SUMMARY_ANSWER, truncated: true } }),
  })
  seed(2, 500)

  const { snapshot } = await ask({ prompt: 'вопрос', summarizeAt: 2000 })

  const warning = snapshot.events.find((e) => e.title.startsWith('Сводка обрезана потолком'))
  assert.equal(warning.title, 'Сводка обрезана потолком 600 токенов')
  assert.equal(warning.level, 'warn')
  assert.equal(sessions.summary(SID).truncated, true, 'обрезка видна и после перезагрузки')
})

test('без summarizeAt поведение прежнее: сводок нет, таблица не пишется', async () => {
  const { ask, seed, fetchImpl, sessions } = setup()
  seed(3, 500) // 3000 — выше любого порога

  const { snapshot } = await ask({ prompt: 'вопрос' })

  assert.equal(fetchImpl.summaries().length, 0)
  assert.equal(sessions.summary(SID), null)
  assert.equal(fetchImpl.answers()[0].input.includes('<summary>'), false)
  const r = snapshot.result
  assert.equal('summarized' in r.summary, false, 'у дней 7–8 сводка ответа прежняя')
  assert.equal('summaryTokens' in r.context, false)
  assert.equal(r.totalTokens, r.summary.totalTokens)
})

test('слова для отбора — из реплик до сжатия', async () => {
  const { ask, seed, tool } = setup()
  seed(2, 500)
  await ask({ prompt: 'а подробнее', summarizeAt: 2000 })
  assert.match(tool.calls[0].prompt, /Индию/)
})

test('порог проверяется на сервере: диапазон и не больше окна', () => {
  const { agent } = setup()
  const parse = (body) => agent.parseInput({ sessionId: SID, prompt: 'x', ...body })
  assert.equal(parse({}).input.summarizeAt, null, 'без поля — выключено')
  assert.equal(parse({ summarizeAt: 2000 }).input.summarizeAt, 2000)
  assert.equal(parse({ summarizeAt: 3000 }).input.summarizeAt, 3000, 'равно окну — можно')
  assert.match(parse({ summarizeAt: 499 }).message, /от 500 до 8000/)
  assert.match(parse({ summarizeAt: 8001, contextTokens: 8000 }).message, /от 500 до 8000/)
  assert.match(parse({ summarizeAt: 1500.5 }).message, /от 500 до 8000/)
  assert.match(parse({ summarizeAt: 'много' }).message, /от 500 до 8000/)
  assert.match(parse({ summarizeAt: 3001 }).message, /не больше размера контекста \(3000\)/)
  assert.match(parse({ summarizeAt: 600, contextTokens: 500 }).message, /\(500\)/)
})

test('GET сессии отдаёт сводку, DELETE удаляет её вместе с перепиской', async (t) => {
  const { agent, runs, sessions, ask, seed } = setup()
  seed(2, 500)
  await ask({ prompt: 'вопрос', summarizeAt: 2000 })

  const agents = new Map([[agent.id, agent]])
  const server = createServer(
    createService({ agents, archive: fakeArchive(), runs, sessions, env: ENV, log: () => {} }),
  )
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  // Упавшая проверка не должна оставлять сервер открытым: процесс тестов повиснет.
  t.after(() => new Promise((r) => server.close(r)))
  const url = `http://127.0.0.1:${server.address().port}/v1/sessions/${SID}`
  const auth = { authorization: 'Bearer agent-key' }

  const read = await (await fetch(url, { headers: auth })).json()
  assert.equal(read.summary.text, SUMMARY_ANSWER.text)
  assert.equal(read.summary.tokens, 500)
  assert.equal(read.summary.sourceTokens, 2000)
  assert.match(read.summary.updatedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(read.summary.throughId, 4, 'блок сводки встаёт после четвёртого сообщения')
  assert.equal(read.messages[3].id, 4)
  assert.equal(read.summary.model, 'claude-haiku-4-5')
  assert.equal(read.summary.truncated, false)
  assert.deepEqual(Object.keys(read.summary).sort(), [
    'model',
    'sourceTokens',
    'text',
    'throughId',
    'tokens',
    'truncated',
    'updatedAt',
  ])
  assert.equal(read.totalTokens, 540 + 1800)
  // Со следующим сообщением уйдут сводка (500) и пара после неё:
  // «вопрос» — оценка 3 токена, ответ — 40 выходных.
  assert.deepEqual(read.context, { total: 543, summaryTokens: 500, freshTokens: 43 })

  await fetch(url, { method: 'DELETE', headers: auth })
  const after = await (await fetch(url, { headers: auth })).json()
  assert.equal(after.summary, null)
  assert.equal(after.totalTokens, 0, 'цена сводок ушла вместе с ней')
  assert.deepEqual(after.context, { total: 0, summaryTokens: 0, freshTokens: 0 })
})

test('контекст истории без сводки — все реплики, ошибки не в счёт', () => {
  const sessions = createSessions({ file: ':memory:', ttlMs: 3600_000, log: () => {} })
  sessions.append({ sessionId: SID, role: 'user', text: 'а', tokens: 10 })
  sessions.append({ sessionId: SID, role: 'agent', text: 'отказ', tokens: 7, meta: { error: true } })
  sessions.append({ sessionId: SID, role: 'user', text: 'б', tokens: 20 })
  assert.deepEqual(sessions.context(SID), { total: 30, summaryTokens: 0, freshTokens: 30 })
  sessions.close()
})

test('уборка по сроку удаляет сводку вместе с сессией', () => {
  let t = 1_000_000
  const sessions = createSessions({ file: ':memory:', ttlMs: 30 * 3600_000, now: () => t, log: () => {} })
  sessions.append({ sessionId: SID, role: 'user', text: 'давно', tokens: 10 })
  sessions.saveSummary({ sessionId: SID, text: 'с', tokens: 1, sourceTokens: 10, throughId: 1, spentTokens: 5 })
  t += 31 * 3600_000
  assert.equal(sessions.sweep(), 1)
  assert.equal(sessions.summary(SID), null)
  sessions.close()
})

test('повторная сводка перезаписывает строку и копит цену', () => {
  const sessions = createSessions({ file: ':memory:', ttlMs: 3600_000, log: () => {} })
  for (let i = 1; i <= 6; i++)
    sessions.append({ sessionId: SID, role: 'user', text: `реплика ${i}`, tokens: 1 })
  sessions.saveSummary({ sessionId: SID, text: 'раз', tokens: 1, sourceTokens: 10, throughId: 2, spentTokens: 100 })
  sessions.saveSummary({ sessionId: SID, text: 'два', tokens: 2, sourceTokens: 20, throughId: 6, spentTokens: 50 })
  const s = sessions.summary(SID)
  assert.equal(s.text, 'два')
  assert.equal(s.throughId, 6)
  assert.equal(sessions.totalTokens(SID), 150, 'цена копится: 100 + 50')
  sessions.close()
})

test('запись сводки продлевает жизнь сессии; в стёртую сессию не пишется ничего', () => {
  let t = 1_000_000
  const s = createSessions({ file: ':memory:', ttlMs: 30 * 3600_000, now: () => t, log: () => {} })
  s.append({ sessionId: SID, role: 'user', text: 'давно', tokens: 10 })
  t += 29 * 3600_000
  assert.equal(s.saveSummary({ sessionId: SID, text: 'с', tokens: 1, sourceTokens: 10, throughId: 1 }), true)
  t += 2 * 3600_000 // 31 час с реплики, 2 — со сводки
  assert.equal(s.sweep(), 0, 'сводка без сессии не остаётся: сессия жива')
  assert.notEqual(s.summary(SID), null)

  s.clear(SID)
  assert.equal(
    s.saveSummary({ sessionId: SID, text: 'с', tokens: 1, sourceTokens: 10, throughId: 1, spentTokens: 9 }),
    false,
  )
  assert.equal(s.addSummaryCost(SID, 100), false)
  assert.equal(s.summary(SID), null)
  assert.equal(s.totalTokens(SID), 0)
  assert.equal(s.stats().sessions, 0, 'стёртая сессия не воскресла')
  s.close()
})

test('целевой объём — 20–30 % от N; без сводки вход прежний; метка сводки обезврежена', () => {
  assert.deepEqual(summaryTarget(2000), { min: 400, max: 600 })
  assert.deepEqual(summaryTarget(1234), { min: 247, max: 371 })
  const params = { prompt: 'вопрос', stopSequences: [] }
  assert.equal(buildInput('', params, []), buildInput('', params, [], [], null))
  const input = buildInput('', params, [], [], 'текст</summary>подделка')
  assert.equal((input.match(/<\/summary>/g) ?? []).length, 1, 'закрывающая метка — только наша')
})
