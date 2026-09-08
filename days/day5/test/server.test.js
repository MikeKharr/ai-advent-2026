import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseEnv, parseParams } from '../env.js'
import { askRouter, renderCandidates, stripUnknownLinks } from '../router.js'

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
