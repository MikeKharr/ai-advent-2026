import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { loadConfig } from '../src/config.js'
import { createStaticRegistry } from '../src/registry.js'
import { createRouter } from '../src/router.js'
import {
  anthropicMessage,
  ENV,
  httpJson,
  ollamaGenerate,
  PROVIDERS,
  scriptedFetch,
  unreachable,
} from './fixtures.js'

const CLASSES = JSON.parse(readFileSync(new URL('../config/classes.json', import.meta.url), 'utf8'))
const LAPTOP = 'laptop.test:11434'
const CLOUD = 'api.anthropic.test'

function setup({
  providers = PROVIDERS,
  classes = CLASSES,
  hosts,
  start = Date.parse('2026-09-08T10:00:00Z'),
} = {}) {
  let t = start
  const calls = []
  const logs = []
  const config = loadConfig({ providers, classes, env: ENV })
  const router = createRouter({
    config,
    registry: createStaticRegistry(config.providers),
    fetchImpl: scriptedFetch(hosts, { calls }),
    now: () => t,
    log: (e) => logs.push(e),
    env: ENV,
  })
  return { router, calls, logs, tick: (ms) => (t += ms) }
}

const cloudOk = () => httpJson(200, anthropicMessage())
const laptopOk = () => httpJson(200, ollamaGenerate())

// 1
test('провайдер в отрицательном кэше пропускается без обращения', async () => {
  const { router, calls } = setup({
    hosts: { [LAPTOP]: () => unreachable('ECONNREFUSED'), [CLOUD]: cloudOk },
  })
  const first = await router.route({ taskClass: 'summarize', input: 'текст' })
  assert.equal(first.ok, true)
  assert.equal(first.provider.id, 'anthropic-haiku')
  assert.equal(first.fallback.from, 'mac-qwen3#1')
  assert.equal(calls.filter((c) => c.host === LAPTOP).length, 1)

  const second = await router.route({ taskClass: 'summarize', input: 'текст' })
  assert.equal(second.ok, true)
  assert.equal(second.fallback, null)
  assert.equal(calls.filter((c) => c.host === LAPTOP).length, 1, 'второй раз к ноутбуку не ходили')
})

// 2
test('после истечения отрицательного кэша провайдер пробуется снова', async () => {
  const { router, calls, tick } = setup({
    hosts: { [LAPTOP]: [unreachable('ECONNREFUSED'), laptopOk()], [CLOUD]: cloudOk },
  })
  await router.route({ taskClass: 'summarize', input: 'текст' })
  tick(60_001)
  const result = await router.route({ taskClass: 'summarize', input: 'текст' })
  assert.equal(result.provider.id, 'mac-qwen3')
  assert.equal(calls.filter((c) => c.host === LAPTOP).length, 2)
})

// 3
test('три подряд неудачи размыкают предохранитель', async () => {
  const { router, calls } = setup({
    hosts: { [LAPTOP]: () => httpJson(500, { error: 'boom' }), [CLOUD]: cloudOk },
  })
  for (let i = 0; i < 3; i++) await router.route({ taskClass: 'summarize', input: 'текст' })
  assert.equal(calls.filter((c) => c.host === LAPTOP).length, 3)
  const result = await router.route({ taskClass: 'summarize', input: 'текст' })
  assert.equal(result.ok, true)
  assert.equal(calls.filter((c) => c.host === LAPTOP).length, 3, 'четвёртый раз не звали')
  assert.match(
    result.reasons?.[0]?.reason ?? router.health.unavailableReason(PROVIDERS[0]),
    /предохранитель/,
  )
})

// 4
test('предохранитель замыкается через 60 секунд одной пробой', async () => {
  const { router, calls, tick } = setup({
    hosts: {
      [LAPTOP]: [httpJson(500, {}), httpJson(500, {}), httpJson(500, {}), laptopOk()],
      [CLOUD]: cloudOk,
    },
  })
  for (let i = 0; i < 3; i++) await router.route({ taskClass: 'summarize', input: 'текст' })
  tick(60_001)
  const result = await router.route({ taskClass: 'summarize', input: 'текст' })
  assert.equal(result.provider.id, 'mac-qwen3')
  assert.equal(calls.filter((c) => c.host === LAPTOP).length, 4)
})

// 5
test('при inflight ≥ maxConcurrency провайдер пропускается', async () => {
  let release
  const hanging = new Promise((resolve) => (release = resolve))
  const { router, calls } = setup({
    hosts: {
      [LAPTOP]: () => hanging.then(() => httpJson(200, ollamaGenerate())),
      [CLOUD]: cloudOk,
    },
  })
  const first = router.route({ taskClass: 'summarize', input: 'один' })
  const second = await router.route({ taskClass: 'summarize', input: 'два' })
  assert.equal(second.provider.id, 'anthropic-haiku')
  assert.equal(second.fallback, null, 'это пропуск по здоровью, а не фолбэк после вызова')
  assert.equal(calls.filter((c) => c.host === LAPTOP).length, 1)
  release()
  assert.equal((await first).provider.id, 'mac-qwen3')
})

// 6
test('rank_news на self-hosted — отказ, а не понижение', async () => {
  const cloudless = PROVIDERS.filter((p) => p.tier === 'self-hosted')
  const classes = {
    ...CLASSES,
    rank_news: { ...CLASSES.rank_news, tiers: ['self-hosted', 'cloud-frontier'], deny: [] },
  }
  assert.throws(
    () => setup({ providers: cloudless, classes, hosts: {} }),
    /rank_news/,
    'без единого способного — крах на старте',
  )

  const { router, calls } = setup({
    classes,
    hosts: { [LAPTOP]: laptopOk, [CLOUD]: () => unreachable('ECONNREFUSED') },
  })
  const result = await router.route({ taskClass: 'rank_news', input: 'новости' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'all_failed')
  assert.equal(calls.filter((c) => c.host === LAPTOP).length, 0, 'ноутбук без web_search не звали')
  assert.deepEqual(
    result.reasons.find((r) => r.provider === 'mac-qwen3#1'),
    {
      provider: 'mac-qwen3#1',
      stage: 'capability',
      reason: 'нет возможности web_search',
    },
  )
})

// 7
test('extract_json с уровнем размышлений выше none — отказ', async () => {
  const { router, calls } = setup({ hosts: { [LAPTOP]: laptopOk, [CLOUD]: cloudOk } })
  const result = await router.route({
    taskClass: 'extract_json',
    input: '{}',
    thinking: 'medium',
    schema: { type: 'object' },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'refused')
  assert.equal(calls.length, 0)
})

// 8
test('данные, не выходящие за периметр, при одном облаке — отказ', async () => {
  const { router, calls } = setup({
    hosts: { [LAPTOP]: () => unreachable('ECONNREFUSED'), [CLOUD]: cloudOk },
  })
  await router.route({ taskClass: 'summarize', input: 'прогрев' })
  const result = await router.route({
    taskClass: 'summarize',
    input: 'секрет',
    dataClass: 'personal',
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'all_failed')
  assert.equal(
    calls.filter((c) => c.host === CLOUD && c.body.messages[0].content === 'секрет').length,
    0,
  )
  assert.equal(result.reasons.find((r) => r.provider === 'anthropic-haiku#1').stage, 'capability')
  assert.equal(result.reasons.find((r) => r.provider === 'mac-qwen3#1').stage, 'health')
})

// 9
test('запрошенная возможность, которой нет у провайдера, — отказ на выборе', async () => {
  const { router, calls } = setup({ hosts: { [LAPTOP]: laptopOk, [CLOUD]: cloudOk } })
  const result = await router.route({ taskClass: 'summarize', input: 'текст', requires: ['tools'] })
  assert.equal(result.ok, true)
  assert.equal(result.provider.id, 'anthropic-haiku')
  assert.equal(calls.filter((c) => c.host === LAPTOP).length, 0)

  const none = await router.route({
    taskClass: 'summarize',
    input: 'текст',
    requires: ['image_input'],
  })
  assert.equal(none.ok, false)
  assert.equal(none.code, 'refused')
  assert.ok(none.reasons.every((r) => r.stage === 'capability'))
})

// 10
test('неизвестный класс уходит в other без исключения', async () => {
  const { router, calls } = setup({ hosts: { [LAPTOP]: laptopOk, [CLOUD]: cloudOk } })
  const result = await router.route({ taskClass: 'poem_about_cats', input: 'коты' })
  assert.equal(result.ok, true)
  assert.equal(result.provider.tier, 'cloud-frontier')
  assert.equal(calls[0].body.max_tokens, CLASSES.other.answerTokens)
  assert.equal(result.cacheKey.split('|')[0], 'other')
})

// 11
test('пустой 200 — неудача с фолбэком, в кэш не попадает', async () => {
  const { router, calls } = setup({
    hosts: {
      [LAPTOP]: [httpJson(200, ollamaGenerate({ text: '' })), laptopOk()],
      [CLOUD]: cloudOk,
    },
  })
  const first = await router.route({ taskClass: 'summarize', input: 'текст' })
  assert.equal(first.ok, true)
  assert.equal(first.provider.id, 'anthropic-haiku')
  assert.equal(first.attempts[0].outcome, 'empty')
  const second = await router.route({ taskClass: 'summarize', input: 'текст' })
  assert.equal(second.provider.id, 'mac-qwen3', 'пустой ответ не закэширован как недоступность')
  assert.equal(calls.filter((c) => c.host === LAPTOP).length, 2)
})

// 12
test('все провайдеры недоступны — понятная ошибка, без зависания', async () => {
  const { router } = setup({
    hosts: { [LAPTOP]: () => unreachable('ECONNREFUSED'), [CLOUD]: () => unreachable('ENOTFOUND') },
  })
  const result = await router.route({ taskClass: 'summarize', input: 'текст' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'all_failed')
  assert.match(result.message, /summarize/)
  assert.deepEqual(
    result.reasons.map((r) => [r.provider, r.stage]),
    [
      ['mac-qwen3#1', 'call'],
      ['anthropic-haiku#1', 'call'],
    ],
  )
  assert.match(result.reasons[0].reason, /ECONNREFUSED/)
})

// 13
test('битая конфигурация провайдера — крах на старте', () => {
  const broken = (patch) => [{ ...PROVIDERS[1], ...patch }]
  assert.throws(
    () => loadConfig({ providers: broken({ baseUrl: 'not a url' }), classes: CLASSES, env: ENV }),
    /baseUrl/,
  )
  assert.throws(
    () => loadConfig({ providers: broken({ tier: 'mainframe' }), classes: CLASSES, env: ENV }),
    /tier/,
  )
  assert.throws(
    () => loadConfig({ providers: broken({ maxConcurrency: 0 }), classes: CLASSES, env: ENV }),
    /maxConcurrency/,
  )
  assert.throws(
    () => loadConfig({ providers: broken({ thinking: { low: 1 } }), classes: CLASSES, env: ENV }),
    /none/,
  )
  assert.throws(
    () => loadConfig({ providers: broken({}), classes: CLASSES, env: {} }),
    /ANTHROPIC_API_KEY/,
  )
  assert.throws(
    () => loadConfig({ providers: PROVIDERS, classes: { summarize: CLASSES.summarize }, env: ENV }),
    /other/,
  )
})

// 14
test('детерминизм: одинаковый вход — одинаковый выбор и ключ кэша', async () => {
  const run = async () => {
    const { router } = setup({ hosts: { [LAPTOP]: laptopOk, [CLOUD]: cloudOk } })
    const r = await router.route({ taskClass: 'translate', input: 'hello' })
    return [r.provider.id, r.thinking, r.cacheKey]
  }
  assert.deepEqual(await run(), await run())
})

// 15
test('провайдер и уровень размышлений есть в ответе, логе и ключе кэша', async () => {
  const { router, logs, calls } = setup({ hosts: { [LAPTOP]: laptopOk, [CLOUD]: cloudOk } })
  const result = await router.route({ taskClass: 'translate', input: 'hello', promptVersion: 'v2' })
  assert.deepEqual(result.provider, {
    id: 'mac-qwen3',
    revision: 1,
    kind: 'ollama',
    model: 'qwen3.8:27b',
    tier: 'self-hosted',
  })
  assert.equal(result.thinking, 'medium')
  assert.equal(calls[0].body.think, true, 'значение think из конфигурации провайдера')
  assert.equal(
    calls[0].body.options.num_predict,
    800 + 2500,
    'бюджет размышлений внутри num_predict',
  )
  const parts = result.cacheKey.split('|')
  assert.deepEqual(parts.slice(0, 6), [
    'translate',
    'mac-qwen3#1',
    'qwen3.8:27b',
    'medium',
    'v2',
    '1',
  ])
  assert.match(parts[6], /^[0-9a-f]{16}$/)
  const call = logs.find((e) => e.event === 'call')
  assert.equal(call.provider, 'mac-qwen3#1')
  assert.equal(call.thinking, 'medium')
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 40 })
  assert.equal(result.metrics.tokPerSec, 6.4)
})

test('добавление провайдера — только правка конфигурации', async () => {
  // Второй облачный провайдер того же kind появляется в конфигурации; код не трогаем.
  const extra = {
    ...PROVIDERS[1],
    id: 'anthropic-sonnet',
    model: 'claude-sonnet-5',
    baseUrl: 'https://api2.anthropic.test',
  }
  const { router } = setup({
    providers: [PROVIDERS[1], extra],
    hosts: {
      [CLOUD]: () => httpJson(429, { error: { type: 'rate_limit_error' } }),
      'api2.anthropic.test': cloudOk,
    },
  })
  const result = await router.route({ taskClass: 'other', input: 'текст' })
  assert.equal(result.ok, true)
  assert.equal(result.provider.id, 'anthropic-sonnet')
  assert.equal(result.attempts[0].outcome, 'busy')
})

test('429 — «занят до», в предохранитель не считается', async () => {
  const { router, tick } = setup({
    hosts: { [LAPTOP]: laptopOk, [CLOUD]: [httpJson(429, {}, { 'retry-after': '3' }), cloudOk()] },
  })
  const p = PROVIDERS[1]
  await router.route({ taskClass: 'other', input: 'текст' })
  assert.match(router.health.unavailableReason(p), /занят/)
  assert.equal(router.health.snapshot(p).failures, 0)
  tick(3_001)
  assert.equal(router.health.unavailableReason(p), null)
})

test('обрезание: свободный текст — успех с truncated, схемный класс — неудача без фолбэка', async () => {
  const free = setup({
    hosts: { [LAPTOP]: () => httpJson(200, ollamaGenerate({ done: 'length' })), [CLOUD]: cloudOk },
  })
  const r1 = await free.router.route({ taskClass: 'summarize', input: 'текст' })
  assert.equal(r1.ok, true)
  assert.equal(r1.truncated, true)

  const strict = setup({
    hosts: {
      [LAPTOP]: () => httpJson(200, ollamaGenerate({ text: '{"a":', done: 'length' })),
      [CLOUD]: cloudOk,
    },
  })
  const r2 = await strict.router.route({
    taskClass: 'extract_json',
    input: 'текст',
    schema: { type: 'object' },
  })
  assert.equal(r2.ok, false)
  assert.equal(r2.code, 'all_failed')
  assert.equal(r2.attempts.length, 1, 'после обрезания схемного ответа второго не зовём')
  assert.equal(strict.calls.filter((c) => c.host === CLOUD).length, 0)
})

test('anthropic: размышления уходят бюджетом, max_tokens его превышает, схема — в output_config', async () => {
  const { router, calls } = setup({ providers: [PROVIDERS[1]], hosts: { [CLOUD]: cloudOk } })
  await router.route({ taskClass: 'translate', input: 'hello' })
  assert.deepEqual(calls[0].body.thinking, { type: 'enabled', budget_tokens: 4096 })
  assert.ok(calls[0].body.max_tokens > 4096)
  assert.equal(calls[0].body.temperature, undefined)

  await router.route({
    taskClass: 'extract_json',
    input: '{}',
    schema: { type: 'object' },
    temperature: 0.2,
  })
  assert.equal(calls[1].body.thinking, undefined)
  assert.equal(calls[1].body.temperature, 0.2)
  assert.deepEqual(calls[1].body.output_config, {
    format: { type: 'json_schema', schema: { type: 'object' } },
  })
})
