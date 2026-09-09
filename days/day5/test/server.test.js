import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { budgetFor, inputBudgetFor, parseEnv, parseParams } from '../env.js'
import {
  articleTokens,
  askRouter,
  buildInput,
  fetchLimits,
  overheadTokens,
  requestTokens,
  estimateTokens,
  fitToBudget,
  renderCandidates,
  stripUnknownLinks,
} from '../router.js'

const ENV = parseEnv({ ROUTER_APP_KEY: 'app-day5', ROUTER_URL: 'http://router.test:8081' }).env

const ITEMS = [
  {
    url: 'https://techcrunch.com/a',
    title: 'Fintech raises 20M',
    source: 'TechCrunch',
    date: '2026-09-09T10:00:00.000Z',
    text: 'полный текст статьи',
  },
  {
    url: 'https://inc42.com/b',
    title: 'India payments',
    source: 'Inc42',
    date: '2026-09-08T10:00:00.000Z',
    textOmitted: true,
    summary: 'анонс',
  },
]

/** fetch, отвечающий как сервис роутера, с записью отправленного тела. */
function fakeRouter({ status = 200, body, onCall = () => {} } = {}) {
  return async (url, options) => {
    onCall({ url, headers: options.headers, body: JSON.parse(options.body) })
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () =>
        body ?? {
          ok: true,
          text: 'ответ модели',
          provider: { id: 'groq-qwen3.6-27b', model: 'qwen/qwen3.6-27b', tier: 'cloud-cheap' },
          thinking: 'none',
          truncated: false,
          durationMs: 900,
          usage: { inputTokens: 5000, outputTokens: 300 },
          budgetLeft: { tokens: 1_000_000, costUsd: 1.5 },
        },
    }
  }
}

test('в роутер уходит выбранная модель, класс дня и ключ приложения', async () => {
  let sent = null
  const { params } = parseParams(
    { model: 'groq-qwen3.6-27b', prompt: 'какие раунды', maxTokens: 900, stopSequences: ['КОНЕЦ'] },
    ENV,
  )
  const result = await askRouter('финтех', params, ITEMS, ENV, {
    fetchImpl: fakeRouter({ onCall: (c) => (sent = c) }),
  })

  assert.equal(sent.url, 'http://router.test:8081/v1/route')
  assert.equal(sent.headers.authorization, 'Bearer app-day5')
  assert.equal(sent.body.taskClass, 'news_answer')
  assert.equal(sent.body.provider, 'groq-qwen3.6-27b', 'модель выбирает пользователь')
  assert.equal(sent.body.answerTokens, 900)
  assert.deepEqual(sent.body.stop, ['КОНЕЦ'])
  assert.match(sent.body.input, /Тематика: финтех/)
  assert.match(sent.body.input, /какие раунды/)
  assert.equal(result.provider.model, 'qwen/qwen3.6-27b')
  assert.equal(result.usage.inputTokens, 5000)
})

test('ключ приложения не попадает в тело запроса', async () => {
  let sent = null
  const { params } = parseParams({}, ENV)
  await askRouter('тема', params, ITEMS, ENV, {
    fetchImpl: fakeRouter({ onCall: (c) => (sent = c) }),
  })
  assert.equal(JSON.stringify(sent.body).includes('app-day5'), false)
})

test('отказ роутера доходит до вызывающего с кодом и причиной', async () => {
  const { params } = parseParams({ model: 'groq-gpt-oss-20b' }, ENV)
  const fetchImpl = fakeRouter({
    status: 429,
    body: {
      ok: false,
      code: 'budget_exceeded',
      message: 'суточный лимит токенов 2000000 исчерпан',
      resetAt: '2026-09-10T00:00:00.000Z',
    },
  })
  await assert.rejects(
    () => askRouter('тема', params, ITEMS, ENV, { fetchImpl }),
    (error) => {
      assert.equal(error.code, 'budget_exceeded')
      assert.equal(error.status, 429)
      return true
    },
  )
})

test('ссылки не из подборки вырезаются из ответа модели', () => {
  const text =
    'Смотри https://techcrunch.com/a и https://evil.example/phish, а также (https://inc42.com/b).'
  const out = stripUnknownLinks(text, ITEMS)
  assert.ok(out.includes('https://techcrunch.com/a'))
  assert.ok(out.includes('https://inc42.com/b'))
  assert.ok(!out.includes('evil.example'))
  assert.ok(out.includes('[ссылка не из списка источников]'))
})

test('в список для модели идут тексты, а урезанное честно помечено', () => {
  const rendered = renderCandidates(ITEMS)
  assert.match(rendered, /Текст статьи: полный текст статьи/)
  assert.match(rendered, /не поместился в бюджет этого запроса/)
  assert.ok(rendered.includes('https://techcrunch.com/a'))
})

test('ссылка без схемы проходит ту же проверку белого списка', () => {
  const text = 'Смотри www.techcrunch.com/a и www.evil.example/phish'
  const out = stripUnknownLinks(text, ITEMS)
  assert.ok(out.includes('www.techcrunch.com/a'), 'известная ссылка без схемы уцелела')
  assert.ok(!out.includes('evil.example'), 'неизвестная вырезана, хоть и без схемы')
})

test('подборка урезается по всему запросу, а не по одним текстам статей', () => {
  // Предел провайдера меряется по собранному запросу: заголовки, ссылки
  // и служебные врезки весят не меньше самих текстов. Раньше урезался
  // только текст, и запрос всё равно не проходил.
  const many = Array.from({ length: 30 }, (_, n) => ({
    url: `https://example.com/${n}`,
    title: `Article number ${n} about fintech funding rounds in emerging markets`,
    source: 'TechCrunch',
    date: '2026-09-09T10:00:00.000Z',
    text: 'x'.repeat(600),
  }))
  const { params } = parseParams({ model: 'groq-qwen3.6-27b' }, ENV)
  const budget = inputBudgetFor('groq-qwen3.6-27b')

  assert.ok(estimateTokens(buildInput('финтех', params, many)) > budget, 'полная не влезает')

  const fitted = fitToBudget('финтех', params, many, budget)
  assert.ok(fitted.length < many.length, 'часть статей отброшена')
  assert.ok(estimateTokens(buildInput('финтех', params, fitted)) <= budget)
  assert.deepEqual(
    fitted,
    many.slice(0, fitted.length),
    'отброшены последние, наименее релевантные',
  )
})

test('для модели с большим пределом подборка не режется', () => {
  const few = [
    {
      url: 'https://example.com/1',
      title: 'Fintech',
      source: 'TechCrunch',
      date: '2026-09-09T10:00:00.000Z',
      text: 'короткий текст',
    },
  ]
  const { params } = parseParams({ model: 'anthropic-haiku' }, ENV)
  assert.equal(fitToBudget('тема', params, few, inputBudgetFor('anthropic-haiku')).length, 1)
})

test('когда остатка не хватает даже на статью, подборка всё равно не пустая', () => {
  // fitToBudget оставляет хотя бы одну статью: пустой список — не ответ.
  // Решение «не звать модель» принимает сервер, сравнив нужное с остатком.
  const items = [
    {
      url: 'https://example.com/1',
      title: 'Very long headline about fintech funding rounds',
      source: 'TechCrunch',
      date: '2026-09-09T10:00:00.000Z',
      text: 'x'.repeat(4000),
    },
  ]
  const { params } = parseParams({ model: 'groq-qwen3.6-27b' }, ENV)
  const fitted = fitToBudget('тема', params, items, 50)
  assert.equal(fitted.length, 1)
  assert.ok(estimateTokens(buildInput('тема', params, fitted)) > 50, 'нужное больше остатка')
})

test('пределы моделей запрашиваются у роутера', async () => {
  let asked = null
  const fetchImpl = async (url, options) => {
    asked = { url, headers: options.headers }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        taskClass: 'news_answer',
        providers: [
          {
            id: 'groq-gpt-oss-20b',
            maxRequestTokens: 6000,
            quota: { limitTokens: 8000, remainingTokens: 1500, resetAt: null, stale: false },
            available: true,
          },
        ],
      }),
    }
  }
  const limits = await fetchLimits(ENV, { fetchImpl })
  assert.match(asked.url, /\/v1\/models\?taskClass=news_answer/)
  assert.equal(asked.headers.authorization, 'Bearer app-day5')
  assert.equal(limits.providers[0].quota.remainingTokens, 1500)
})

test('ответ роутера проверяется по форме, а не принимается на веру', async () => {
  // undefined в пределе превращает арифметику бюджета в NaN, и проверка
  // молча выключается. Такие записи отбрасываются целиком.
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      providers: [
        { id: 'без-предела' },
        { id: 'предел-строкой', maxRequestTokens: '6000' },
        null,
        {
          id: 'годный',
          maxRequestTokens: 6000,
          quota: { limitTokens: 8000, remainingTokens: 1500, resetAt: null, stale: false },
        },
      ],
    }),
  })
  const limits = await fetchLimits(ENV, { fetchImpl })
  assert.deepEqual(
    limits.providers.map((p) => p.id),
    ['годный'],
  )
  assert.equal(limits.providers[0].quota.remainingTokens, 1500)
})

test('ответ не по форме и отказ роутера дают пустой список, а не поломку', async () => {
  const garbage = async () => ({ ok: true, status: 200, json: async () => ({ providers: 'нет' }) })
  assert.deepEqual((await fetchLimits(ENV, { fetchImpl: garbage })).providers, [])
  const refused = async () => ({ ok: false, status: 401, json: async () => ({ ok: false }) })
  assert.deepEqual((await fetchLimits(ENV, { fetchImpl: refused })).providers, [])
})

test('оценка входа включает системный промпт — как и у роутера', () => {
  // Иначе остаётся полоса, где день говорит «влезает», а роутер отказывает.
  const { params } = parseParams({}, ENV)
  const items = [
    {
      url: 'https://example.com/1',
      title: 'Fintech',
      source: 'TechCrunch',
      date: '2026-09-09T10:00:00.000Z',
      text: 'текст',
    },
  ]
  const withSystem = requestTokens('тема', params, items)
  const withoutSystem = estimateTokens(buildInput('тема', params, items))
  assert.ok(withSystem > withoutSystem + 200, 'системный промпт весит сотни токенов')
})

test('быстрая оценка числа статей сходится с настоящей подгонкой', () => {
  // Линейная прикидка не должна обещать больше, чем реально влезает.
  const items = Array.from({ length: 40 }, (_, n) => ({
    url: `https://example.com/${n}`,
    title: `Fintech funding round number ${n} in emerging markets`,
    source: 'TechCrunch',
    date: '2026-09-09T10:00:00.000Z',
    text: 'x'.repeat(1200),
  }))
  const { params } = parseParams({}, ENV)
  const budget = 4300

  let used = overheadTokens('тема', params)
  let fits = 0
  for (const item of items) {
    used += articleTokens(item)
    if (used > budget) break
    fits += 1
  }
  const fitted = fitToBudget('тема', params, items, budget)
  assert.ok(fits > 0, 'что-то влезает')
  assert.ok(Math.abs(fits - fitted.length) <= 1, `прикидка ${fits}, подгонка ${fitted.length}`)
  assert.ok(requestTokens('тема', params, items.slice(0, fits)) <= budget, 'прикидка не завышает')
})

test('бюджет подборки зависит от выбранной модели', () => {
  // У моделей Groq предел на запрос жёстче окна: подборка «как для Haiku»
  // получила бы 413, поэтому бюджет символов у них свой.
  assert.equal(budgetFor('anthropic-haiku'), 120_000)
  assert.ok(budgetFor('groq-gpt-oss-20b') < 20_000)
  assert.ok(budgetFor('groq-qwen3.6-27b') < budgetFor('groq-gpt-oss-20b'))
  assert.equal(
    budgetFor('неизвестная'),
    budgetFor('anthropic-haiku'),
    'запасной вариант — умолчание',
  )
  // Предел в токенах у моделей Groq заведомо ниже пределов роутера
  // (6000 и 5000): запас нужен, потому что предел считается за минуту.
  assert.ok(inputBudgetFor('groq-gpt-oss-20b') < 6000)
  assert.ok(inputBudgetFor('groq-qwen3.6-27b') < 5000)
})

test('окружение без ключа приложения — ошибка конфигурации, а не тихий старт', () => {
  const { errors } = parseEnv({})
  assert.ok(errors.some((e) => e.includes('ROUTER_APP_KEY')))
})

test('параметры: неизвестная модель и выход за границы отвергаются', () => {
  assert.equal(parseParams({ model: 'claude-opus-5' }, ENV).message, 'Неизвестная модель')
  assert.match(parseParams({ maxTokens: 9999 }, ENV).message, /Лимит токенов/)
  assert.match(parseParams({ articles: 100 }, ENV).message, /Статей в подборке/)
  assert.match(parseParams({ perSource: 0 }, ENV).message, /Статей с источника/)
  const ok = parseParams({}, ENV)
  assert.equal(ok.params.model, 'anthropic-haiku', 'по умолчанию — Haiku')
})

test('директория хранилища берётся из окружения, ключей моделей в дне нет', () => {
  const dir = mkdtempSync(join(tmpdir(), 'day5-env-'))
  const { env } = parseEnv({ ROUTER_APP_KEY: 'k', STORE_FILE: join(dir, 's.json') })
  assert.ok(env.STORE_FILE.endsWith('s.json'))
  assert.equal('ANTHROPIC_API_KEY' in env, false)
  assert.equal('GROQ_API_KEY' in env, false)
})
