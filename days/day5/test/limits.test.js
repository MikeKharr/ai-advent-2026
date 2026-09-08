// Интеграционный тест лимитера: он поднимает настоящий сервер дня.
//
// Отдельных тестов лимитера в первой версии дня 5 не было, и из-за этого
// прошла проводка `createLimiter({ maxDaily, perMinute, perHour })` при
// сигнатуре `createLimiter(env)`: все пределы становились undefined,
// и отказа не случалось никогда. Проверять надо именно связку.

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'day5-limits-'))
const storeFile = join(dir, 'store.json')

// Архив засеян, отметка свежая — ленты в тесте не трогаются.
writeFileSync(
  storeFile,
  JSON.stringify({
    version: 1,
    lastRefresh: Date.now(),
    items: [
      {
        url: 'https://techcrunch.com/a',
        title: 'Fintech raises 20M',
        source: 'TechCrunch',
        region: 'США',
        date: new Date().toISOString(),
        text: 'текст',
      },
    ],
  }),
)

process.env.NODE_ENV = 'test'
process.env.ROUTER_APP_KEY = 'app-day5'
process.env.ROUTER_URL = 'http://router.test:8081'
process.env.STORE_FILE = storeFile
process.env.MAX_DAILY_CALLS = '3'
process.env.RATE_LIMIT_PER_MIN = '2'
process.env.RATE_LIMIT_PER_HOUR = '3'
process.env.REFRESH_MIN_MINUTES = '10000'

// Настоящий fetch сохраняется до подмены: им ходит сам тест. Иначе клиент
// теста попадает в собственную заглушку и до сервера не доходит вовсе.
const realFetch = globalThis.fetch.bind(globalThis)
const calls = { count: 0 }
globalThis.fetch = async () => {
  calls.count += 1
  return {
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      text: 'ответ',
      provider: { id: 'anthropic-haiku', model: 'claude-haiku-4-5', tier: 'cloud-frontier' },
      truncated: false,
      durationMs: 100,
      usage: { inputTokens: 100, outputTokens: 10 },
    }),
  }
}

const { server } = await import('../server.js')
let base = ''

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => new Promise((resolve) => server.close(resolve)))

const ask = (ip) =>
  realFetch(`${base}/api/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ sphere: 'финтех', articles: 1 }),
  })

test('окно на минуту действительно отказывает', async () => {
  assert.equal((await ask('10.0.0.1')).status, 200)
  assert.equal((await ask('10.0.0.1')).status, 200)
  const third = await ask('10.0.0.1')
  assert.equal(third.status, 429)
  assert.match((await third.json()).error, /Слишком часто/)
})

test('адрес берётся с конца X-Forwarded-For: подделка первым элементом не помогает', async () => {
  // Caddy дописывает настоящий адрес последним. Клиент, подставляющий
  // свой первый элемент, обязан оставаться тем же клиентом для лимитера.
  const forged = await realFetch(`${base}/api/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4, 10.0.0.1' },
    body: JSON.stringify({ sphere: 'финтех', articles: 1 }),
  })
  assert.equal(forged.status, 429, 'узнан по последнему элементу, а не по подделанному первому')
})

test('суточный предел исчерпывается и не обходится сменой адреса', async () => {
  // Прошли два вызова: третий отказан окном на минуту и слот не занял.
  // Суточный предел — три, поэтому с другого адреса пройдёт ровно один.
  assert.equal((await ask('10.0.0.9')).status, 200)

  const beyond = await ask('10.0.0.10')
  assert.equal(beyond.status, 429)
  assert.match((await beyond.json()).error, /Суточный лимит/)
})

test('до модели дошло ровно столько запросов, сколько разрешил лимитер', () => {
  assert.equal(calls.count, 3, 'отказы лимитера до роутера не доходят')
})
