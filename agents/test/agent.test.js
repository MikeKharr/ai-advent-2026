import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createNewsAnalyst } from '../src/agent.js'
import { createRuns } from '../src/runs.js'
import { ENV, fakeArchive, fakeRouter, ITEMS, NEWS, ROUTER_ANSWER } from './fixtures.js'

/** Поднимает агента с заглушками и выполняет один запуск до конца. */
async function runOnce({ input = { sphere: 'финтех' }, archive, router, env = ENV } = {}) {
  const runs = createRuns()
  const tool = archive ?? fakeArchive()
  const fetchImpl = router ?? fakeRouter()
  const agent = createNewsAnalyst({
    agent: NEWS,
    archive: tool,
    runs,
    env,
    fetchImpl,
    log: () => {},
  })
  const parsed = agent.parseInput(input)
  assert.ok(parsed.ok, parsed.message)
  const run = runs.create({ agent, input: parsed.input })
  const messages = []
  runs.subscribe(run.id, (m) => messages.push(m))
  await agent.execute(run)
  const events = messages.filter((m) => m.type === 'event').map((m) => m.event)
  const end = messages.find((m) => m.type === 'end')
  return { run, runs, events, end, agent, tool, fetchImpl }
}

test('счастливый путь: стадии по порядку, результат в end, статус succeeded', async () => {
  const { run, events, end, fetchImpl, tool } = await runOnce({
    input: { sphere: 'финтех', prompt: 'какие раунды', articles: 7, perSource: 2 },
  })
  assert.deepEqual(
    events.map((e) => e.stage),
    ['received', 'tool_call', 'tool_result', 'planning', 'llm_call', 'llm_result', 'guard', 'done'],
  )
  assert.equal(run.status, 'succeeded')
  assert.equal(end.status, 'succeeded')
  assert.equal(events.at(-1).status, 'succeeded')
  assert.ok(
    events.every((e, i) => e.seq === i + 1),
    'номера сплошные',
  )

  // Инструмент получил пределы отбора, роутер — класс агента и явную модель.
  assert.equal(tool.calls[0].limit, 7)
  assert.equal(tool.calls[0].perSource, 2)
  assert.equal(fetchImpl.calls[0].body.taskClass, 'news_answer')
  assert.equal(fetchImpl.calls[0].body.provider, 'anthropic-haiku')
  assert.equal(fetchImpl.calls[0].body.system, NEWS.systemPrompt, 'промпт — из реестра')
  assert.equal(fetchImpl.calls[0].headers.authorization, 'Bearer app-agents')

  // Результат — в форме ответа дня 5: странице ничего не переучивать.
  const r = end.result
  assert.ok(r.answer.includes('https://techcrunch.com/a'))
  assert.ok(!r.answer.includes('evil.example'), 'чужая ссылка вырезана')
  assert.equal(r.model.model, 'claude-haiku-4-5')
  assert.equal(r.usage.inputTokens, 500)
  assert.equal(r.selection.used, 2)
  assert.equal(r.selection.matched, 2)
  assert.equal(r.selection.withText, 1)
  assert.deepEqual(
    r.sources.map((s) => s.url),
    ITEMS.map((i) => i.url),
  )
})

test('в событиях нет текстов: ни промпта, ни статей, ни ответа', async () => {
  const { events } = await runOnce({
    input: { sphere: 'финтех', prompt: 'СЕКРЕТНЫЙ ЗАПРОС пользователя' },
  })
  const dump = JSON.stringify(events)
  assert.equal(dump.includes('СЕКРЕТНЫЙ'), false, 'промпт')
  assert.equal(dump.includes('полный текст статьи'), false, 'статья')
  assert.equal(dump.includes('Ответ модели'), false, 'ответ')
  assert.equal(dump.includes('app-agents'), false, 'ключ')
  assert.equal(dump.includes('финтех'), false, 'тема')
})

test('заголовки коротки и по-русски, детали одной строкой, кроме списков', async () => {
  const { events } = await runOnce()
  for (const e of events) {
    assert.ok(e.title.length <= 60, `«${e.title}» длиннее 60`)
    assert.match(e.title, /^[А-ЯЁ]/, `«${e.title}» не по-русски`)
    const first = e.detail.split('\n')[0]
    assert.ok(first.length <= 80, `детали «${first}» длиннее 80`)
  }
})

test('вызов инструмента и его результат связаны toolCallId и несут длительность', async () => {
  const { events } = await runOnce()
  const call = events.find((e) => e.stage === 'tool_call')
  const result = events.find((e) => e.stage === 'tool_result')
  assert.ok(call.toolCallId)
  assert.equal(result.toolCallId, call.toolCallId)
  assert.equal(call.data.tool, 'archive')
  assert.equal(typeof result.durationMs, 'number')
  assert.equal(result.data.selected, 2)
  const llm = events.find((e) => e.stage === 'llm_result')
  assert.equal(typeof llm.durationMs, 'number')
  assert.equal(events.at(-1).durationMs >= llm.durationMs, true, 'done несёт общую длительность')
})

test('пустой архив: запуск закрывается отказом с кодом и без траты денег', async () => {
  const { run, events, end, fetchImpl } = await runOnce({
    archive: fakeArchive({ items: [], total: 0 }),
  })
  assert.equal(run.status, 'failed')
  assert.equal(end.error.code, 'archive_empty')
  assert.equal(end.error.paidNothing, true)
  assert.equal(events.at(-1).stage, 'error')
  assert.equal(events.at(-1).level, 'error')
  assert.equal(fetchImpl.calls.length, 0, 'модель не вызывалась')
})

test('предела модели не хватает даже на одну статью — модель не зовётся', async () => {
  const { end, events, fetchImpl } = await runOnce({
    input: { sphere: 'финтех', model: 'groq-qwen3.6-27b' },
    router: fakeRouter({
      models: {
        providers: [
          {
            id: 'groq-qwen3.6-27b',
            maxRequestTokens: 5000,
            quota: { limitTokens: 7000, remainingTokens: 40, resetAt: null, stale: false },
          },
        ],
      },
    }),
  })
  assert.equal(end.status, 'failed')
  assert.equal(end.error.code, 'budget_too_small')
  assert.equal(end.error.paidNothing, true)
  assert.match(end.error.message, /осталось 40 токенов/)
  const planning = events.find((e) => e.stage === 'planning')
  assert.equal(planning.data.budgetSource, 'остаток квоты')
  assert.equal(fetchImpl.calls.length, 0)
})

test('отказ роутера до провайдера: статус failed, paidNothing=true, текст дня 5', async () => {
  const { end } = await runOnce({
    router: fakeRouter({
      status: 429,
      route: { ok: false, code: 'budget_exceeded', message: 'суточный лимит исчерпан' },
    }),
  })
  assert.equal(end.status, 'failed')
  assert.equal(end.error.code, 'budget_exceeded')
  assert.equal(end.error.paidNothing, true)
  assert.match(end.error.message, /Суточный лимит расхода/)
})

test('ошибка после вызова провайдера: paidNothing=false', async () => {
  const { end, events } = await runOnce({
    router: fakeRouter({
      status: 503,
      route: {
        ok: false,
        code: 'all_failed',
        message: 'все провайдеры отказали',
        attempts: [{ provider: 'anthropic-haiku', outcome: 'timeout' }],
      },
    }),
  })
  assert.equal(end.error.paidNothing, false)
  assert.match(end.error.message, /Модель не ответила/)
  assert.equal(events.at(-1).data.status, 503)
})

test('сетевая ошибка роутера — тоже терминальное событие, не зависший запуск', async () => {
  const { run, end } = await runOnce({
    router: fakeRouter({ route: new TypeError('fetch failed') }),
  })
  assert.equal(run.status, 'failed')
  assert.equal(end.error.code, 'router_error')
})

test('предупреждения: обрезанный ответ, вырезанные ссылки, ленты без ответа', async () => {
  const { events, end } = await runOnce({
    archive: fakeArchive({
      refresh: {
        attempted: true,
        refreshed: true,
        added: 3,
        dropped: 0,
        failed: [{ source: 'Pandaily', reason: 'таймаут' }],
      },
    }),
    router: fakeRouter({ route: { ...ROUTER_ANSWER, truncated: true } }),
  })
  const warns = events.filter((e) => e.level === 'warn')
  assert.deepEqual(
    warns.map((e) => e.stage),
    ['warning', 'warning', 'guard'],
  )
  assert.match(warns[0].detail, /Pandaily/)
  assert.match(warns[1].title, /обрезан/)
  assert.match(
    warns[2].detail,
    /вырезано 1 из 2\nhttps:\/\/evil\.example\/x/,
    'список — с новой строки',
  )
  assert.equal(end.status, 'succeeded', 'предупреждения не ломают запуск')
  assert.equal(end.result.truncated, true)
})

test('обновление не удалось целиком — одно предупреждение «архив не обновился»', async () => {
  const { events } = await runOnce({
    archive: fakeArchive({
      refresh: { attempted: true, refreshed: false, added: 0, dropped: 0, failed: [] },
    }),
  })
  const warn = events.find((e) => e.stage === 'warning')
  assert.match(warn.title, /не обновился/)
})

test('вход проверяется на границе агента', () => {
  const runs = createRuns()
  const agent = createNewsAnalyst({ agent: NEWS, archive: fakeArchive(), runs, env: ENV })
  assert.match(agent.parseInput({}).message, /sphere/)
  assert.match(agent.parseInput({ sphere: '' }).message, /Укажите тему/)
  assert.equal(agent.parseInput({ sphere: 'x', model: 'gpt-5' }).message, 'Неизвестная модель')
  assert.match(agent.parseInput({ sphere: 'x', maxTokens: 9999 }).message, /Лимит токенов/)
  assert.match(agent.parseInput(null).message, /объектом/)
  const ok = agent.parseInput({ sphere: '  финтех  ', temperature: '0.3' })
  assert.equal(ok.input.sphere, 'финтех')
  assert.equal(ok.input.params.model, 'anthropic-haiku', 'умолчание — из реестра')
  assert.equal(ok.input.params.maxTokens, 600)
  assert.equal(ok.input.params.temperature, 0.3)
})

test('описание: промпт из реестра, модели с живым пределом, без ключей', async () => {
  const runs = createRuns()
  const agent = createNewsAnalyst({
    agent: NEWS,
    archive: fakeArchive(),
    runs,
    env: ENV,
    fetchImpl: fakeRouter(),
  })
  const d = await agent.describe()
  assert.equal(d.id, 'news-analyst')
  assert.equal(d.systemPrompt, NEWS.systemPrompt)
  assert.match(d.systemPrompt, /новостях стартапов/)
  assert.equal(d.tools[0].name, 'archive')
  const qwen = d.models.find((m) => m.id === 'groq-qwen3.6-27b')
  assert.equal(qwen.budgetTokens, 1500, 'меньшее из своего, потолка и остатка')
  assert.equal(qwen.budgetSource, 'остаток квоты')
  assert.equal(typeof d.models[0].articlesFit, 'number')
  assert.equal(d.presets.length, 7)
  assert.equal(d.defaults.model, 'anthropic-haiku')
  assert.equal(JSON.stringify(d).includes('app-agents'), false)
  assert.equal(JSON.stringify(d).includes('agent-key'), false)
})
