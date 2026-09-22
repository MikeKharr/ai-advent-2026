import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadConfig } from '../src/config.js'
import { createLedger } from '../src/ledger.js'
import { createStaticRegistry } from '../src/registry.js'
import { createRouter, estimateTokens } from '../src/router.js'
import { createService, NOT_REACHED, OUTPUT_ESTIMATED } from '../src/service.js'
import {
  anthropicMessage,
  ENV,
  groqCompletion,
  httpJson,
  httpText,
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
    base,
    post,
    get,
    calls,
    // Соединения рвём явно: иначе оборванный клиентом сокет держит close.
    close: () =>
      new Promise((r) => {
        server.closeAllConnections()
        server.close(r)
      }),
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
      [CLOUD]: timesOut,
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
    // Недоступный ноутбук вход не принял — ноль; у таймаута облака по оценке
    // идут оба конца: вход 100 и потолок выхода класса summarize (500).
    assert.equal(spend.apps.smoke.tokens, 100 + 500, 'оценка только за дошедший вызов')
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

test('сервис принимает выбор модели и потолок ответа, отвергает мусор', async () => {
  const apps = {
    ...APPS,
    apps: [{ ...APPS.apps[0], classes: ['news_answer', 'summarize', 'other'] }],
  }
  const s = await start({ apps, hosts: { [LAPTOP]: laptopOk, [CLOUD]: cloudOk } })
  try {
    const picked = await (
      await s.post({ taskClass: 'news_answer', input: 'текст', provider: 'anthropic-haiku' })
    ).json()
    assert.equal(picked.ok, true)
    assert.equal(picked.provider.id, 'anthropic-haiku')

    assert.equal((await s.post({ taskClass: 'news_answer', input: 'x', provider: 7 })).status, 400)
    assert.equal(
      (await s.post({ taskClass: 'news_answer', input: 'x', answerTokens: 0 })).status,
      400,
    )
    assert.equal(
      (await s.post({ taskClass: 'news_answer', input: 'x', stop: ['a', 'b', 'c', 'd', 'e'] }))
        .status,
      400,
    )
  } finally {
    await s.close()
  }
})

test('/v1/models: только по ключу приложения и только свои классы', async () => {
  const apps = {
    ...APPS,
    apps: [{ ...APPS.apps[0], classes: ['news_answer', 'summarize'] }],
  }
  const s = await start({ apps, hosts: { [LAPTOP]: laptopOk, [CLOUD]: cloudOk } })
  try {
    const anon = await fetch(`${s.base}/v1/models`)
    assert.equal(anon.status, 401, 'без ключа приложения ничего не отдаём')

    const wrong = await s.get('/v1/models?taskClass=guard_prompt', ENV.APP_KEY_SMOKE)
    assert.equal(wrong.status, 403, 'чужой класс — отказ')

    const ok = await (await s.get('/v1/models?taskClass=news_answer', ENV.APP_KEY_SMOKE)).json()
    assert.equal(ok.taskClass, 'news_answer')
    const ids = ok.providers.map((p) => p.id)
    assert.ok(ids.includes('anthropic-haiku'))
    assert.equal(ids.includes('groq-prompt-guard'), false, 'классификатор не предлагаем')
    for (const p of ok.providers) {
      assert.equal(typeof p.maxRequestTokens, 'number')
      assert.equal('baseUrl' in p, false, 'адресов провайдеров наружу не отдаём')
      assert.equal('secretEnv' in p, false, 'и тем более имён секретов')
    }
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

test('удачный вызов в отчёте не помечен оценкой', async () => {
  const s = await start({ hosts: { [LAPTOP]: laptopOk, [CLOUD]: cloudOk } })
  try {
    assert.equal((await s.post({ taskClass: 'summarize', input: 'текст' })).status, 200)
    const spend = await (await s.get('/v1/spend')).json()
    assert.equal(spend.apps.smoke.calls, 1)
    assert.deepEqual(spend.apps.smoke.estimated, { tokens: 0, costUsd: 0, calls: 0 })
  } finally {
    await s.close()
  }
})

test('обрыв клиента прерывает вызов провайдера, попытка остаётся в книге расхода', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'))
  const file = join(dir, 'ledger.jsonl')
  // Оба провайдера висят: клиент уходит, пока вызов в полёте. Ответ висит
  // на ручке, а не навсегда, — иначе снятый проброс вешал бы прогон вместо
  // того, чтобы его провалить.
  let release
  const hanging = () => new Promise((r) => (release = r))
  const s = await start({ hosts: { [LAPTOP]: hanging, [CLOUD]: hanging }, file })
  try {
    const client = new AbortController()
    const request = fetch(`${s.base}/v1/route`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ENV.APP_KEY_SMOKE}`,
      },
      body: JSON.stringify({ taskClass: 'summarize', input: 'длинный текст запроса' }),
      signal: client.signal,
    }).catch((e) => e)
    await waitFor(() => s.calls.length === 1)
    client.abort()
    assert.ok((await request) instanceof Error, 'клиент ушёл без ответа')

    // Вызов оборван, а не доигран до конца, и второго провайдера не было.
    await waitFor(() => existsSync(file) && readFileSync(file, 'utf8').trim() !== '')
    const lines = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    assert.equal(lines.length, 1, 'одна попытка: фолбэка после обрыва нет')
    assert.equal(s.calls.length, 1)
    assert.equal(lines[0].outcome, 'aborted')
    assert.equal(lines[0].estimated, true, 'usage провайдер не вернул — вход по оценке, с пометкой')
    assert.ok(lines[0].inputTokens > 0, 'вход не ноль: он принят и оплачен')
    // Выход тоже не ноль: провайдер тарифицирует прерванный запрос целиком,
    // и в учёт идёт верхняя граница — max_tokens ровно этого вызова.
    // Ноутбук — Ollama: потолок вызова уехал в options.num_predict.
    assert.equal(lines[0].outputTokens, s.calls[0].body.options.num_predict)
    assert.ok(lines[0].outputTokens > 0, 'выход по оценке, а не ноль')

    // И книга расхода это видит: следующий запрос стартует с меньшим остатком.
    const spend = await (await s.get('/v1/spend')).json()
    assert.equal(spend.apps.smoke.calls, 1)
    assert.equal(spend.apps.smoke.tokens, lines[0].inputTokens + lines[0].outputTokens)
    // Пометка «оценка» доезжает до отчёта: завышение видно, а не растворено.
    assert.deepEqual(spend.apps.smoke.estimated, {
      tokens: lines[0].inputTokens + lines[0].outputTokens,
      costUsd: lines[0].costUsd,
      calls: 1,
    })
    assert.deepEqual(spend.monthly.smoke.estimated, spend.apps.smoke.estimated)
  } finally {
    release?.(httpJson(200, anthropicMessage()))
    await s.close()
  }
})

test('оценка выхода прерванной попытки попадает и в деньги', async () => {
  // Класс `other` обслуживает облако: у него, в отличие от ноутбука, есть цена.
  const file = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'ledger.jsonl')
  let release
  const s = await start({
    hosts: { [CLOUD]: () => new Promise((r) => (release = r)), [LAPTOP]: laptopOk },
    file,
  })
  try {
    const client = new AbortController()
    const request = fetch(`${s.base}/v1/route`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ENV.APP_KEY_SMOKE}`,
      },
      body: JSON.stringify({ taskClass: 'other', input: 'длинный текст запроса' }),
      signal: client.signal,
    }).catch((e) => e)
    await waitFor(() => s.calls.length === 1)
    client.abort()
    await request
    await waitFor(() => existsSync(file) && readFileSync(file, 'utf8').trim() !== '')

    const spend = await (await s.get('/v1/spend')).json()
    assert.equal(spend.apps.smoke.calls, 1)
    assert.equal(
      spend.apps.smoke.tokens,
      estimateTokens('длинный текст запроса') + s.calls[0].body.max_tokens,
    )
    assert.ok(spend.apps.smoke.costUsd > 0, 'выход по оценке дошёл до денег')
    assert.equal(spend.apps.smoke.estimated.costUsd, spend.apps.smoke.costUsd)
  } finally {
    release?.(httpJson(200, anthropicMessage()))
    await s.close()
  }
})

test('оценка выхода прерванной попытки включает бюджет размышлений', async () => {
  // Класс `translate` закреплён за уровнем medium: потолок выхода у него —
  // не answerTokens (800), а answerTokens + бюджет размышлений. Классы без
  // размышлений эти два выражения не различают, поэтому проверка здесь.
  const file = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'ledger.jsonl')
  let release
  const s = await start({
    hosts: { [LAPTOP]: () => new Promise((r) => (release = r)), [CLOUD]: cloudOk },
    file,
    apps: {
      admin: { secretEnv: 'ROUTER_ADMIN_KEY' },
      apps: [
        {
          id: 'smoke',
          secretEnv: 'APP_KEY_SMOKE',
          classes: ['translate'],
          limits: { dailyTokens: 50000, dailyCostUsd: 1 },
        },
      ],
    },
  })
  try {
    const client = new AbortController()
    const request = fetch(`${s.base}/v1/route`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ENV.APP_KEY_SMOKE}`,
      },
      body: JSON.stringify({ taskClass: 'translate', input: 'длинный текст запроса' }),
      signal: client.signal,
    }).catch((e) => e)
    await waitFor(() => s.calls.length === 1)
    client.abort()
    await request
    await waitFor(() => existsSync(file) && readFileSync(file, 'utf8').trim() !== '')

    const line = JSON.parse(readFileSync(file, 'utf8').trim())
    assert.equal(line.outcome, 'aborted')
    assert.equal(line.thinking, 'medium')
    // Ноутбук — Ollama: бюджет размышлений входит в num_predict тела запроса.
    assert.equal(line.outputTokens, s.calls[0].body.options.num_predict)
    assert.equal(line.outputTokens, 800 + 2500, 'ответ класса плюс бюджет размышлений')
  } finally {
    release?.(httpJson(200, ollamaGenerate()))
    await s.close()
  }
})

// Класс `translate` закреплён за уровнем размышлений medium, и его обслуживают
// оба провайдера по очереди: ноутбук, потом облако. Потолок выхода у него —
// не answerTokens, поэтому мутация «забыть бюджет размышлений» видна.
const TRANSLATE_APPS = {
  admin: { secretEnv: 'ROUTER_ADMIN_KEY' },
  apps: [
    {
      id: 'smoke',
      secretEnv: 'APP_KEY_SMOKE',
      classes: ['translate'],
      limits: { dailyTokens: 50000, dailyCostUsd: 1 },
    },
  ],
}

// Дедлайн вызова истёк: fetch отклонён так же, как это делает undici.
const timesOut = () => Object.assign(new Error('дедлайн вызова истёк'), { name: 'TimeoutError' })

test('таймаут: выход попытки идёт в книгу по оценке, а не нулём', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'ledger.jsonl')
  const s = await start({
    hosts: { [LAPTOP]: timesOut, [CLOUD]: cloudOk },
    file,
    apps: TRANSLATE_APPS,
  })
  try {
    const res = await s.post({ taskClass: 'translate', input: 'длинный текст запроса' })
    assert.equal(res.status, 200, 'фолбэк на облако ответил')

    const lines = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    assert.equal(lines.length, 2)
    assert.equal(lines[0].outcome, 'timeout')
    assert.equal(lines[0].estimated, true, 'usage провайдер не вернул — запись по оценке')
    assert.ok(lines[0].inputTokens > 0, 'вход не ноль: он принят и оплачен')
    // Запрос ушёл в сеть, провайдер генерировал и тарифицирует сгенерированное:
    // выход идёт по той же оценке, что и у обрыва клиента.
    // Ноутбук — Ollama: потолок вызова уехал в options.num_predict.
    assert.equal(lines[0].outputTokens, s.calls[0].body.options.num_predict)
    assert.equal(lines[0].outputTokens, 800 + 2500, 'ответ класса плюс бюджет размышлений')
    assert.equal(lines[1].outcome, 'ok')
    assert.equal(lines[1].estimated, false, 'у удачной попытки измерение провайдера')
  } finally {
    await s.close()
  }
})

test('таймаут у обоих провайдеров: недоучёт был дважды за один запрос', async () => {
  // На таймауте перебор не прерывается — зовётся второй провайдер, и попыток
  // без измерения за один запрос выходит две.
  const file = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'ledger.jsonl')
  const s = await start({
    hosts: { [LAPTOP]: timesOut, [CLOUD]: timesOut },
    file,
    apps: TRANSLATE_APPS,
  })
  try {
    const res = await s.post({ taskClass: 'translate', input: 'длинный текст запроса' })
    assert.equal(res.status, 503)
    assert.equal(s.calls.length, 2, 'таймаут не прерывает перебор: зовётся и второй')

    const lines = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    assert.equal(lines.length, 2, 'обе попытки в книге')
    assert.deepEqual(
      lines.map((l) => l.outcome),
      ['timeout', 'timeout'],
    )
    assert.equal(lines[0].outputTokens, s.calls[0].body.options.num_predict)
    assert.equal(lines[0].outputTokens, 800 + 2500)
    // У облака с размышлениями адаптер поднимает max_tokens под бюджет
    // провайдера (4096), и это уже не та величина, что зарезервировал лимит.
    // В книгу идёт зарезервированная — иначе оценка разойдётся с потолком.
    assert.equal(s.calls[1].body.max_tokens, 800 + 4096)
    assert.equal(lines[1].outputTokens, 800 + 2500, 'в книге — зарезервированная оценка')
    assert.ok(lines[1].costUsd > 0, 'выход по оценке дошёл до денег')

    const spend = await (await s.get('/v1/spend')).json()
    assert.equal(spend.apps.smoke.calls, 2)
    assert.equal(
      spend.apps.smoke.tokens,
      lines[0].inputTokens + lines[0].outputTokens + lines[1].inputTokens + lines[1].outputTokens,
    )
    assert.equal(spend.apps.smoke.estimated.calls, 2, 'обе суммы помечены оценкой')
  } finally {
    await s.close()
  }
})

test('529 overloaded: провайдер отказал до генерации — в книге ноль', async () => {
  // 529 у Anthropic — обратное давление, тот же ответ «не сейчас», что и 429:
  // ничего не сгенерировано и ничего не тарифицировано. Оценке там взяться
  // неоткуда, иначе перегрузка выест суточный потолок приложения.
  const file = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'ledger.jsonl')
  const s = await start({
    hosts: {
      [LAPTOP]: () => httpJson(529, { error: { type: 'overloaded_error' } }),
      [CLOUD]: cloudOk,
    },
    file,
    apps: TRANSLATE_APPS,
  })
  try {
    assert.equal(
      (await s.post({ taskClass: 'translate', input: 'длинный текст запроса' })).status,
      200,
    )
    const lines = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    assert.equal(lines[0].outcome, 'server_error')
    assert.equal(lines[0].inputTokens, 0, 'вход до модели не дошёл')
    assert.equal(lines[0].outputTokens, 0, 'генерации не было — оценки нет')
    assert.equal(lines[0].costUsd, 0)
  } finally {
    await s.close()
  }
})

test('500 у провайдера: ноль по обоим концам, как и у 529', async () => {
  // Нижний край границы 5xx. 529 закреплён тестом выше, но граница — это
  // константа: сдвиг на единицу увёл бы 500–528, включая 502 и 503, в оценку
  // выхода, то есть ровно в ту протечку, которую правило и закрывает.
  const file = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'ledger.jsonl')
  const s = await start({
    hosts: {
      [LAPTOP]: () => httpJson(500, { error: { message: 'internal server error' } }),
      [CLOUD]: cloudOk,
    },
    file,
    apps: TRANSLATE_APPS,
  })
  try {
    assert.equal(
      (await s.post({ taskClass: 'translate', input: 'длинный текст запроса' })).status,
      200,
    )
    const lines = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    assert.equal(lines[0].outcome, 'server_error')
    assert.equal(lines[0].inputTokens, 0, 'вход до модели не дошёл')
    assert.equal(lines[0].outputTokens, 0, 'генерации не было — оценки нет')
  } finally {
    await s.close()
  }
})

test('ошибка без кода состояния: ответа не было — оценки выхода нет', async () => {
  // Разделительная черта между «ответ пришёл, но не разобрался» и броском до
  // отправки: первое несёт код состояния, второе — нет. Если `bad_response`
  // начнёт глотать бесстатусные броски, запрос, не покинувший процесс,
  // получит полную оценку выхода.
  const file = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'ledger.jsonl')
  const s = await start({
    hosts: { [LAPTOP]: () => new Error('адаптер упал до отправки'), [CLOUD]: cloudOk },
    file,
    apps: TRANSLATE_APPS,
  })
  try {
    assert.equal(
      (await s.post({ taskClass: 'translate', input: 'длинный текст запроса' })).status,
      200,
    )
    const lines = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    assert.equal(lines[0].outcome, 'error')
    assert.equal(lines[0].outputTokens, 0, 'в сеть ничего не ушло — генерации не было')
  } finally {
    await s.close()
  }
})

test('перегрузка у обоих провайдеров: фантомных токенов в книге нет', async () => {
  // Окно перегрузки: перебор на 5xx не прерывается, и до правки каждая такая
  // попытка приносила полную оценку выхода — две за запрос.
  const file = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'ledger.jsonl')
  const overloaded = () => httpJson(529, { error: { type: 'overloaded_error' } })
  const s = await start({
    hosts: { [LAPTOP]: overloaded, [CLOUD]: overloaded },
    file,
    apps: TRANSLATE_APPS,
  })
  try {
    const res = await s.post({ taskClass: 'translate', input: 'длинный текст запроса' })
    assert.equal(res.status, 503)
    assert.equal(s.calls.length, 2, 'перебор на 5xx не прерывается')

    const lines = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    assert.equal(lines.length, 2)
    assert.deepEqual(
      lines.map((l) => l.inputTokens + l.outputTokens),
      [0, 0],
      'за отказ до генерации не списывается ничего',
    )
    const spend = await (await s.get('/v1/spend')).json()
    assert.equal(spend.apps.smoke.tokens, 0)
    assert.equal(spend.apps.smoke.costUsd, 0, 'перегрузка не ест суточный потолок')
  } finally {
    await s.close()
  }
})

test('200 с неразборным телом: генерация была — выход по оценке', async () => {
  // Ответ пришёл, провайдер отработал и тарифицирует сгенерированное; что
  // конверт не разобрался — наша беда, а не основание списать ноль.
  const file = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'ledger.jsonl')
  const s = await start({
    hosts: { [LAPTOP]: () => httpText(200, 'не JSON вовсе'), [CLOUD]: cloudOk },
    file,
    apps: TRANSLATE_APPS,
  })
  try {
    assert.equal(
      (await s.post({ taskClass: 'translate', input: 'длинный текст запроса' })).status,
      200,
    )
    const lines = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    assert.equal(lines[0].outcome, 'bad_response')
    assert.ok(lines[0].inputTokens > 0)
    assert.equal(lines[0].outputTokens, s.calls[0].body.options.num_predict)
    assert.equal(lines[0].outputTokens, 800 + 2500)
  } finally {
    await s.close()
  }
})

test('429 у провайдера: ноль на обоих концах, а не оценка', async () => {
  // Самый частый из отказов. Если он когда-нибудь попадёт в множество
  // оценки, книга начнёт расти на занятости — этот тест этого не пропустит.
  const file = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'ledger.jsonl')
  const s = await start({
    hosts: {
      [LAPTOP]: () => httpJson(429, { error: { message: 'rate limit' } }),
      [CLOUD]: cloudOk,
    },
    file,
    apps: TRANSLATE_APPS,
  })
  try {
    assert.equal(
      (await s.post({ taskClass: 'translate', input: 'длинный текст запроса' })).status,
      200,
    )
    const lines = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    assert.equal(lines[0].outcome, 'busy')
    assert.equal(lines[0].inputTokens, 0)
    assert.equal(lines[0].outputTokens, 0)
  } finally {
    await s.close()
  }
})

test('4xx: отказ до модели по-прежнему идёт в книгу с нулём', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'ledger.jsonl')
  const s = await start({
    hosts: {
      [LAPTOP]: () => httpJson(400, { error: { message: 'bad request' } }),
      [CLOUD]: cloudOk,
    },
    file,
    apps: TRANSLATE_APPS,
  })
  try {
    assert.equal(
      (await s.post({ taskClass: 'translate', input: 'длинный текст запроса' })).status,
      200,
    )
    const lines = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    assert.equal(lines[0].outcome, 'rejected')
    assert.equal(lines[0].inputTokens, 0)
    assert.equal(lines[0].outputTokens, 0)
  } finally {
    await s.close()
  }
})

test('исход не может быть одновременно «до модели не дошло» и «выход по оценке»', () => {
  // Структурный сторож против дрейфа множеств: попытка, у которой вход
  // списан нулём, не может иметь оценки выхода — это разные половины одного
  // вопроса «дошёл ли запрос до генерации».
  const both = [...OUTPUT_ESTIMATED].filter((o) => NOT_REACHED.has(o))
  assert.deepEqual(both, [], 'множества учёта пересеклись')
})

async function waitFor(cond) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('условие не наступило')
}
