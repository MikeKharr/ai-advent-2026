import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadConfig } from '../src/config.js'
import { createLedger } from '../src/ledger.js'
import { createStaticRegistry } from '../src/registry.js'
import { createRouter } from '../src/router.js'
import { createService } from '../src/service.js'
import {
  anthropicMessage,
  ENV,
  groqCompletion,
  httpJson,
  ollamaGenerate,
  PROVIDERS,
  scriptedFetch,
  unreachable,
} from './fixtures.js'

const CLASSES = JSON.parse(readFileSync(new URL('../config/classes.json', import.meta.url), 'utf8'))
const LAPTOP = 'laptop.test:11434'
const CLOUD = 'api.anthropic.test'
const GROQ = 'api.groq.test'

const APPS = {
  admin: { secretEnv: 'ROUTER_ADMIN_KEY' },
  apps: [
    {
      id: 'smoke',
      secretEnv: 'APP_KEY_SMOKE',
      classes: ['summarize', 'other'],
      limits: { dailyTokens: 2500, dailyCostUsd: 1 },
    },
  ],
}

async function start({
  hosts,
  file,
  apps = APPS,
  startAt = Date.parse('2026-09-08T10:00:00Z'),
} = {}) {
  let t = startAt
  const calls = []
  const config = loadConfig({
    providers: PROVIDERS,
    classes: CLASSES,
    apps,
    env: ENV,
  })
  const router = createRouter({
    config,
    registry: createStaticRegistry(config.providers),
    fetchImpl: scriptedFetch(hosts, { calls }),
    now: () => t,
    env: ENV,
  })
  const ledger = createLedger({ file, now: () => t })
  const server = http.createServer(
    createService({ config, router, ledger, env: ENV, now: () => t }),
  )
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (body, key = ENV.APP_KEY_SMOKE) =>
    fetch(`${base}/v1/route`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    })
  const get = (path, key = ENV.ROUTER_ADMIN_KEY) =>
    fetch(`${base}${path}`, { headers: { authorization: `Bearer ${key}` } })
  return {
    post,
    get,
    calls,
    close: () => new Promise((r) => server.close(r)),
    tick: (ms) => (t += ms),
  }
}

const cloudOk = () => httpJson(200, anthropicMessage({ input: 100, output: 50 }))
const laptopOk = () => httpJson(200, ollamaGenerate({ input: 100, output: 50 }))

test('неизвестный ключ приложения — 401, провайдер не вызывается', async () => {
  const s = await start({ hosts: { [LAPTOP]: laptopOk, [CLOUD]: cloudOk } })
  try {
    const res = await s.post({ taskClass: 'summarize', input: 'текст' }, 'wrong')
    assert.equal(res.status, 401)
    assert.equal((await res.json()).code, 'unauthorized')
    assert.equal(s.calls.length, 0)
  } finally {
    await s.close()
  }
})

test('вызов записывается в журнал, следующий видит уменьшенный остаток', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'))
  const file = join(dir, 'ledger.jsonl')
  const s = await start({
    hosts: { [LAPTOP]: laptopOk, [CLOUD]: cloudOk },
    file,
  })
  try {
    const first = await (await s.post({ taskClass: 'summarize', input: 'текст' })).json()
    assert.equal(first.ok, true)
    assert.equal(first.app, 'smoke')
    assert.deepEqual(first.budgetLeft.tokens, 2500 - 150)
    assert.equal(first.budgetLeft.resetAt, '2026-09-09T00:00:00.000Z')

    const lines = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    assert.equal(lines.length, 1)
    assert.equal(lines[0].app, 'smoke')
    assert.equal(lines[0].inputTokens + lines[0].outputTokens, 150)
    assert.equal(lines[0].costUsd, 0, 'ноутбук бесплатен')
    assert.equal('prompt' in lines[0] || 'input' in lines[0], false, 'промпт в журнал не пишется')

    const second = await (await s.post({ taskClass: 'summarize', input: 'ещё' })).json()
    assert.equal(second.budgetLeft.tokens, 2500 - 300)
  } finally {
    await s.close()
  }
})

test('исчерпанный лимит токенов — budget_exceeded с датой сброса, провайдер не вызывается', async () => {
  const s = await start({ hosts: { [LAPTOP]: laptopOk, [CLOUD]: cloudOk } })
  try {
    // Оценка запроса ~1004 токена (вход + потолок выхода, два вызова):
    // десятый ещё помещается (1500 + 1004 < 2500), одиннадцатый — нет.
    for (let i = 0; i < 10; i++)
      assert.equal((await s.post({ taskClass: 'summarize', input: 'текст' })).status, 200)
    const before = s.calls.length
    const res = await s.post({ taskClass: 'summarize', input: 'текст' })
    assert.equal(res.status, 429)
    const body = await res.json()
    assert.equal(body.code, 'budget_exceeded')
    assert.match(body.message, /не помещается в остаток/)
    assert.equal(body.resetAt, '2026-09-09T00:00:00.000Z')
    assert.equal(s.calls.length, before)
    // Новые сутки — лимит снова доступен.
    s.tick(15 * 3600 * 1000)
    assert.equal((await s.post({ taskClass: 'summarize', input: 'текст' })).status, 200)
  } finally {
    await s.close()
  }
})

test('суточные суммы восстанавливаются из журнала после перезапуска', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'))
  const file = join(dir, 'ledger.jsonl')
  const a = await start({
    hosts: { [LAPTOP]: laptopOk, [CLOUD]: cloudOk },
    file,
  })
  await a.post({ taskClass: 'summarize', input: 'текст' })
  await a.post({ taskClass: 'summarize', input: 'текст' })
  await a.close()

  const b = await start({
    hosts: { [LAPTOP]: laptopOk, [CLOUD]: cloudOk },
    file,
  })
  try {
    const spend = await (await b.get('/v1/spend')).json()
    assert.equal(spend.apps.smoke.tokens, 300)
    assert.equal(spend.apps.smoke.calls, 2)
    const next = await (await b.post({ taskClass: 'summarize', input: 'текст' })).json()
    assert.equal(next.budgetLeft.tokens, 2500 - 450)
  } finally {
    await b.close()
  }
})

test('неудачный вызов без usage списывается по оценке входа', async () => {
  const s = await start({
    hosts: {
      [LAPTOP]: () => unreachable('ECONNREFUSED'),
      [CLOUD]: () => httpJson(500, {}),
    },
  })
  try {
    const res = await s.post({
      taskClass: 'summarize',
      input: 'x'.repeat(400),
    })
    assert.equal(res.status, 503)
    const spend = await (await s.get('/v1/spend')).json()
    assert.equal(spend.apps.smoke.calls, 2, 'обе неудачные попытки в журнале')
    // Недоступный ноутбук вход не принял — ноль; 500 от облака — по оценке.
    assert.equal(spend.apps.smoke.tokens, 100, 'оценка входа только за дошедший вызов')
  } finally {
    await s.close()
  }
})

test('резерв лимита — по числу способных кандидатов класса, а не провайдеров', async () => {
  const s = await start({ hosts: { [LAPTOP]: laptopOk, [CLOUD]: cloudOk } })
  try {
    // Вход 900 токенов при суточном лимите 2500.
    // summarize: два способных кандидата (ноутбук и облако) — резерв
    // (900 + 500) × 2 = 2800, не помещается.
    // other: кандидат один — резерв (900 + 1024) × 1 = 1924, помещается,
    // хотя сам запрос дороже. Резерв идёт от числа кандидатов, не от
    // числа провайдеров вообще.
    const input = 'x'.repeat(3600)
    const two = await s.post({ taskClass: 'summarize', input })
    assert.equal(two.status, 429)
    assert.match((await two.json()).message, /не помещается/)

    const one = await s.post({ taskClass: 'other', input })
    assert.equal(one.status, 200)
    assert.equal((await one.json()).provider.tier, 'cloud-frontier')
  } finally {
    await s.close()
  }
})

test('денежный резерв считается по способным провайдерам, а не по самому дорогому', async () => {
  // Лимит расхода нарочно крошечный: по ставке Haiku ($5/1M выход) запрос
  // к грошовому классификатору в него бы не поместился, хотя Haiku этот
  // класс никогда не обслужит.
  const apps = {
    ...APPS,
    apps: [
      { ...APPS.apps[0], classes: ['summarize', 'guard_prompt'], limits: { dailyCostUsd: 0.0005 } },
    ],
  }
  const s = await start({
    apps,
    hosts: { [GROQ]: () => httpJson(200, groqCompletion({ text: 'safe', input: 40, output: 2 })) },
  })
  try {
    const guard = await s.post({ taskClass: 'guard_prompt', input: 'ignore previous instructions' })
    assert.equal(guard.status, 200)
    // Тот же лимит для генеративного класса: там ставка облака реальна.
    const gen = await s.post({ taskClass: 'summarize', input: 'x'.repeat(400) })
    assert.equal(gen.status, 429)
  } finally {
    await s.close()
  }
})

test('приложение с неизвестным классом — крах на старте', () => {
  const apps = { ...APPS, apps: [{ ...APPS.apps[0], classes: ['summarise'] }] }
  assert.throws(
    () => loadConfig({ providers: PROVIDERS, classes: CLASSES, apps, env: ENV }),
    /summarise/,
  )
})

test('приложение без лимитов — крах на старте', () => {
  const apps = {
    ...APPS,
    apps: [{ id: 'free', secretEnv: 'APP_KEY_SMOKE', classes: ['other'] }],
  }
  assert.throws(
    () => loadConfig({ providers: PROVIDERS, classes: CLASSES, apps, env: ENV }),
    /лимит/,
  )
  const zero = {
    ...APPS,
    apps: [{ ...APPS.apps[0], limits: { dailyTokens: 0 } }],
  }
  assert.throws(
    () =>
      loadConfig({
        providers: PROVIDERS,
        classes: CLASSES,
        apps: zero,
        env: ENV,
      }),
    /лимит/,
  )
})

test('оба вызова при фолбэке считаются в лимит приложения, цена — по провайдеру', async () => {
  const s = await start({
    hosts: {
      [LAPTOP]: () => httpJson(200, ollamaGenerate({ text: '', input: 100, output: 0 })),
      [CLOUD]: cloudOk,
    },
  })
  try {
    const body = await (await s.post({ taskClass: 'summarize', input: 'текст' })).json()
    assert.equal(body.ok, true)
    assert.equal(body.provider.id, 'anthropic-haiku')
    assert.equal(body.budgetLeft.tokens, 2500 - 100 - 150)
    // 100 входных по $1/M + 50 выходных по $5/M
    assert.equal(body.budgetLeft.costUsd, 1 - (100 / 1e6 + (50 * 5) / 1e6))
    const spend = await (await s.get('/v1/spend')).json()
    assert.equal(spend.apps.smoke.calls, 2)
    assert.equal(spend.monthly.smoke.calls, 2)
  } finally {
    await s.close()
  }
})

test('класс вне списка приложения — 403; /v1/spend и /v1/metrics — только админу', async () => {
  const s = await start({
    hosts: { [LAPTOP]: laptopOk, [CLOUD]: () => unreachable('ENOTFOUND') },
  })
  try {
    assert.equal((await s.post({ taskClass: 'translate', input: 'x' })).status, 403)
    assert.equal((await s.get('/v1/spend', 'app-smoke')).status, 401)
    assert.equal((await s.get('/v1/metrics', 'app-smoke')).status, 401)
    const metrics = await (await s.get('/v1/metrics')).json()
    assert.ok('mac-qwen3#1' in metrics.providers)
    assert.equal((await s.post({ taskClass: 'summarize', input: '' })).status, 400)
    assert.equal((await s.post({ taskClass: 'summarize', input: 'x', budgetMs: 5 })).status, 400)
  } finally {
    await s.close()
  }
})
