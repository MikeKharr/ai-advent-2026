import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  articleTokens,
  askRouter,
  buildInput,
  effectiveBudget,
  estimateTokens,
  fetchLimits,
  fitToBudget,
  guardLinks,
  overheadTokens,
  renderCandidates,
  requestTokens,
  stripUnknownLinks,
} from '../src/llm.js'
import { inputBudgetFor, PARAM_LIMITS, PROMPT_PRESETS, parseParams } from '../src/params.js'
import { ENV, fakeRouter, ITEMS, NEWS } from './fixtures.js'

const SYSTEM = NEWS.systemPrompt
const params = (source = {}) =>
  parseParams(source, { maxOutputTokens: ENV.MAX_OUTPUT_TOKENS, defaults: NEWS.defaults }).params

test('в роутер уходит выбранная модель, класс и ключ приложения', async () => {
  const fetchImpl = fakeRouter()
  const result = await askRouter(
    {
      system: SYSTEM,
      taskClass: 'news_answer',
      sphere: 'финтех',
      params: params({
        model: 'groq-qwen3.6-27b',
        prompt: 'какие раунды',
        maxTokens: 900,
        stopSequences: ['КОНЕЦ'],
      }),
      items: ITEMS,
    },
    ENV,
    { fetchImpl },
  )
  const sent = fetchImpl.calls[0]
  assert.equal(sent.url, 'http://router.test:8081/v1/route')
  assert.equal(sent.headers.authorization, 'Bearer app-agents')
  assert.equal(sent.body.provider, 'groq-qwen3.6-27b', 'модель выбирает пользователь')
  assert.equal(sent.body.answerTokens, 900)
  assert.deepEqual(sent.body.stop, ['КОНЕЦ'])
  assert.match(sent.body.input, /Тематика: финтех/)
  assert.match(sent.body.input, /какие раунды/)
  assert.equal(JSON.stringify(sent.body).includes('app-agents'), false, 'ключ не в теле')
  assert.equal(result.provider.model, 'claude-haiku-4-5')
})

test('температура: умолчание не отправляется, сдвинутая уходит', async () => {
  const fetchImpl = fakeRouter()
  const base = { system: SYSTEM, taskClass: 'news_answer', sphere: 'тема', items: ITEMS }
  await askRouter({ ...base, params: params() }, ENV, { fetchImpl })
  assert.equal(fetchImpl.calls[0].body.temperature, undefined)
  await askRouter({ ...base, params: params({ temperature: 0.3 }) }, ENV, { fetchImpl })
  assert.equal(fetchImpl.calls[1].body.temperature, 0.3)
})

test('проверка ссылок: чужие вырезаются и перечисляются, свои остаются', () => {
  const text =
    'Смотри https://techcrunch.com/a и https://evil.example/phish, а также (www.inc42.com/b).'
  const g = guardLinks(text, ITEMS)
  assert.ok(g.text.includes('https://techcrunch.com/a'))
  assert.ok(g.text.includes('www.inc42.com/b'), 'www — тот же адрес')
  assert.ok(!g.text.includes('evil.example'))
  assert.equal(g.total, 3)
  assert.deepEqual(g.stripped, ['https://evil.example/phish'])
  assert.equal(stripUnknownLinks(text, ITEMS), g.text)
})

test('подборка урезается по всему запросу, включая системный промпт', () => {
  const many = Array.from({ length: 30 }, (_, n) => ({
    url: `https://example.com/${n}`,
    title: `Article number ${n} about fintech funding rounds in emerging markets`,
    source: 'TechCrunch',
    date: '2026-09-09T10:00:00.000Z',
    text: 'x'.repeat(600),
  }))
  const p = params({ model: 'groq-qwen3.6-27b' })
  const budget = inputBudgetFor('groq-qwen3.6-27b')
  assert.ok(requestTokens(SYSTEM, 'финтех', p, many) > budget)
  const fitted = fitToBudget(SYSTEM, 'финтех', p, many, budget)
  assert.ok(fitted.length < many.length && fitted.length >= 1)
  assert.ok(requestTokens(SYSTEM, 'финтех', p, fitted) <= budget)
  assert.deepEqual(fitted, many.slice(0, fitted.length), 'отброшены последние')
  assert.ok(
    requestTokens(SYSTEM, 'тема', p, ITEMS) > estimateTokens(buildInput('тема', p, ITEMS)) + 200,
    'системный промпт весит сотни токенов',
  )
})

test('быстрая прикидка числа статей сходится с настоящей подгонкой', () => {
  const items = Array.from({ length: 40 }, (_, n) => ({
    url: `https://example.com/${n}`,
    title: `Fintech funding round number ${n} in emerging markets`,
    source: 'TechCrunch',
    date: '2026-09-09T10:00:00.000Z',
    text: 'x'.repeat(1200),
  }))
  const p = params()
  let used = overheadTokens(SYSTEM, 'тема', p)
  let fits = 0
  for (const item of items) {
    used += articleTokens(item)
    if (used > 4300) break
    fits += 1
  }
  const fitted = fitToBudget(SYSTEM, 'тема', p, items, 4300)
  assert.ok(fits > 0 && Math.abs(fits - fitted.length) <= 1)
})

test('предел входа: меньшее из своего, потолка провайдера и остатка квоты', async () => {
  const limits = await fetchLimits(ENV, 'news_answer', { fetchImpl: fakeRouter() })
  assert.equal(limits.providers.length, 2)
  const own = inputBudgetFor('groq-qwen3.6-27b')
  assert.deepEqual(effectiveBudget('groq-qwen3.6-27b', own, limits).tokens, 1500)
  assert.equal(effectiveBudget('anthropic-haiku', 40_000, limits).tokens, 40_000)
  assert.equal(
    effectiveBudget('mac-qwen3', 4500, limits).source,
    'модель',
    'неизвестный — свой предел',
  )
  // Форма ответа проверяется: запись без целого предела отбрасывается.
  const garbage = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ providers: [{ id: 'a' }, { id: 'b', maxRequestTokens: '6000' }, null] }),
  })
  assert.deepEqual((await fetchLimits(ENV, 'news_answer', { fetchImpl: garbage })).providers, [])
})

test('в список для модели идут тексты, а урезанное честно помечено', () => {
  const rendered = renderCandidates(ITEMS)
  assert.match(rendered, /Текст статьи: полный текст статьи/)
  assert.match(rendered, /не поместился в бюджет этого запроса/)
})

test('готовые запросы идут от простого к сложному и помещаются в поле', () => {
  const lengths = PROMPT_PRESETS.map((p) => p.text.length)
  for (let i = 1; i < lengths.length; i++) assert.ok(lengths[i] > lengths[i - 1])
  for (const p of PROMPT_PRESETS) assert.ok(p.text.length <= PARAM_LIMITS.promptChars)
})
