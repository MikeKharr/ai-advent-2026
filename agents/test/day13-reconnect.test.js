// День 13: возобновление запуска после обрыва потока событий.
//
// Почему этот файл существует и почему он здесь, а не в `days/day13/test`.
// Дефект владельца («нажал паузу, закрыл окно, в другом окне нажал
// „Продолжить“ — ничего не изменилось, потом появилось „запрос уже
// отработал“») поддельный сервис дня воспроизвести не может: он отвечает
// ровно то, что автор дня о контракте думает. Поэтому здесь поднимаются
// НАСТОЯЩИЙ сервис агентов с настоящей машиной состояний (`agents/src`) и
// поверх него — настоящий сервер дня 13 (`days/day13/server.js`). Поддельный
// здесь только роутер моделей: платных вызовов в тестах не бывает.
//
// Файл лежит в `agents/test`, потому что настоящему сервису нужен `node:sqlite`
// (Node 24 или флаг), а тесты дня 13 в CI идут на Node 22.
//
// Требует Node 24 или флага --experimental-sqlite.

import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, test } from 'node:test'
import { createRuns } from '../src/runs.js'
import { createService } from '../src/service.js'
import { createSessions } from '../src/sessions.js'
import { createStagedAgent } from '../src/staged.js'
import { ENV, REGISTRY } from './fixtures.js'

const STAGED = REGISTRY.get('staged-agent')

const reply = (text, provider) => ({
  ok: true,
  text,
  provider: { id: provider, model: provider, tier: 'cloud' },
  truncated: false,
  durationMs: 10,
  usage: { inputTokens: 100, outputTokens: 20 },
})

/**
 * Поддельный роутер. `hangAnswer` держит вызов рабочей модели, пока его не
 * оборвут сигналом: так воспроизводится пауза ПОСРЕДИ платного вызова — тот
 * случай, ради которого возобновление берёт слот заново.
 */
const state = { hangAnswer: true, answerCalls: 0 }
const fetchImpl = async (url, options = {}) => {
  if (String(url).includes('/v1/models'))
    return { ok: true, status: 200, json: async () => ({ providers: [] }) }
  const body = JSON.parse(options.body)
  if (body.taskClass === 'summarize')
    return { ok: true, status: 200, json: async () => reply('тема: продолжить', 'anthropic-haiku') }
  if (body.provider === 'kimi-k2.6')
    return {
      ok: true,
      status: 200,
      json: async () => reply('вердикт: принято\nзамечания:', 'kimi-k2.6'),
    }
  state.answerCalls += 1
  if (state.hangAnswer) {
    return new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('прервано')
        error.name = 'AbortError'
        reject(error)
      })
    })
  }
  return { ok: true, status: 200, json: async () => reply('ОТВЕТ МОДЕЛИ', 'anthropic-haiku') }
}

const sessions = createSessions({
  file: ':memory:',
  ttlMs: ENV.SESSION_TTL_HOURS * 3600_000,
  profileTtlMs: ENV.PROFILE_TTL_DAYS * 24 * 3600_000,
  log: () => {},
})
const runs = createRuns()
const agents = new Map([
  [
    STAGED.id,
    createStagedAgent({
      agent: STAGED,
      runs,
      sessions,
      stageLog: null,
      env: ENV,
      fetchImpl,
      log: () => {},
    }),
  ],
])
const service = http.createServer(
  createService({ agents, archive: null, runs, sessions, stageLog: null, env: ENV, log: () => {} }),
)
await new Promise((resolve) => service.listen(0, '127.0.0.1', resolve))

process.env.NODE_ENV = 'test'
process.env.AGENT_KEY = 'agent-key'
process.env.AGENT_URL = `http://127.0.0.1:${service.address().port}`
process.env.AGENT_ID = STAGED.id
process.env.COOKIE_PATH = '/'
process.env.COOKIE_SECURE = 'false'
process.env.MAX_DAILY_CALLS = '200'
process.env.RATE_LIMIT_PER_MIN = '60'
process.env.RATE_LIMIT_PER_HOUR = '200'
process.env.RATE_LIMIT_WRITES_PER_HOUR = '200'

const { server: day } = await import('../../days/day13/server.js')
let base = ''

before(async () => {
  await new Promise((resolve) => day.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${day.address().port}`
})
after(async () => {
  await new Promise((resolve) => day.close(resolve))
  await new Promise((resolve) => service.close(resolve))
  sessions.close?.()
})

let cookie = ''
const call = (method, path, body, { ip = '10.13.0.1' } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': ip,
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

/** Cookie ответа складываются в одну строку: тестовый «браузер» на один профиль. */
const keepCookies = (response) => {
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';')
    const [name] = pair.split('=')
    const rest = cookie
      .split('; ')
      .filter((c) => c && !c.startsWith(`${name}=`))
      .join('; ')
    cookie = rest ? `${rest}; ${pair}` : pair
  }
}

const until = async (predicate, what, limitMs = 5000) => {
  const deadline = Date.now() + limitMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`не дождались: ${what}`)
}

/**
 * Подписка на поток дня, как её открывает вкладка. `events` копится, `close()`
 * рвёт соединение — это и есть закрытое окно.
 */
function subscribe(runId) {
  const controller = new AbortController()
  const events = []
  const ends = []
  const done = (async () => {
    const response = await fetch(`${base}/api/runs/${runId}/events`, {
      headers: { cookie },
      signal: controller.signal,
    })
    assert.equal(response.status, 200)
    let buffer = ''
    let kind = null
    for await (const chunk of response.body) {
      buffer += Buffer.from(chunk).toString('utf8')
      let nl = buffer.indexOf('\n')
      while (nl !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '')
        buffer = buffer.slice(nl + 1)
        if (line.startsWith('event: ')) kind = line.slice(7).trim()
        else if (line.startsWith('data: ')) {
          const payload = JSON.parse(line.slice(6))
          if (kind === 'end') ends.push(payload)
          else events.push(payload)
          kind = null
        }
        nl = buffer.indexOf('\n')
      }
    }
  })().catch((error) => {
    if (error.name !== 'AbortError') throw error
  })
  return { events, ends, close: () => controller.abort(), done }
}

/** Профиль и первое сообщение: дальше сценарий владельца слово в слово. */
async function startRun() {
  const created = await call('POST', '/api/profile', { name: 'Мика' })
  assert.equal(created.status, 200)
  const profileId = (await created.json()).profile.id
  // Профиль выбирается отдельным действием — им и ставится cookie.
  const selected = await call('POST', '/api/profile/select', { id: profileId })
  assert.equal(selected.status, 200)
  keepCookies(selected)
  const answer = await call('POST', '/api/answer', { prompt: 'что нового в финтехе' })
  assert.equal(answer.status, 202)
  keepCookies(answer)
  return (await answer.json()).runId
}

// --- Сценарий владельца ---------------------------------------------------

test('пауза, закрытое окно, новая подписка: «Продолжить» доводит запуск до ответа', async () => {
  state.hangAnswer = true
  const runId = await startRun()
  const first = subscribe(runId)

  // Ждём, пока запуск дойдёт до платного вызова: пауза на нём — самый дорогой
  // и самый сложный случай (вызов оборван, этап входится заново).
  await until(() => state.answerCalls > 0, 'запуск дошёл до вызова модели')
  const paused = await call('POST', '/api/run/pause', { paused: true })
  assert.equal(paused.status, 200)
  await until(
    () => first.events.some((e) => e.stage === 'paused'),
    'событие паузы дошло до вкладки',
  )

  // Окно закрыто: поток оборван со стороны браузера.
  first.close()
  await first.done

  // Другое окно, тот же профиль: страница читает переписку и видит запуск.
  const chat = await (await call('GET', '/api/chat')).json()
  assert.equal(chat.run?.id, runId, 'запуск на паузе виден новой вкладке')
  assert.equal(chat.run.paused, true)
  assert.equal(chat.run.interruptedCall, true, 'пауза застала платный вызов')

  // Дальше вызов модели отвечает: повтор этапа обязан дойти до ответа.
  state.hangAnswer = false
  const resumed = await call('POST', '/api/run/pause', { paused: false })
  assert.equal(resumed.status, 200, 'осмысленное действие посетителя не отклоняется')

  // Новая вкладка подписывается на тот же запуск: сервис переигрывает
  // накопленное и доводит до конца.
  const second = subscribe(runId)
  await until(() => second.ends.length > 0, 'новая подписка дождалась конца запуска', 15000)
  second.close()

  assert.equal(second.ends[0].status, 'succeeded')
  assert.equal(second.ends[0].result.answer, 'ОТВЕТ МОДЕЛИ')
  assert.ok(
    second.events.some((e) => e.stage === 'resumed'),
    'новая подписка получила переигранные события, включая «Продолжаю»',
  )
  assert.ok(state.answerCalls >= 2, 'прерванный вызов повторён, а не пропущен')
})

// --- Требование владельца: отказа на «Продолжить» быть не должно ----------

test('«Продолжить» по запуску, который успел завершиться, отвечает объяснением, а не отказом', async () => {
  state.hangAnswer = false
  const runId = await startRun()
  const stream = subscribe(runId)
  await until(() => stream.ends.length > 0, 'запуск завершился', 15000)
  stream.close()
  await stream.done

  const resumed = await call('POST', '/api/run/pause', { paused: false })
  assert.equal(
    resumed.status,
    200,
    'отказ на действие посетителя недопустим: запуск отработал — это состояние, а не ошибка',
  )
  const body = await resumed.json()
  assert.equal(body.finished, true, 'страница обязана узнать, ЧТО случилось, а не только «не вышло»')
  assert.ok(typeof body.message === 'string' && body.message.length > 0, 'объяснение словами')
})

// --- Слоты лимитера: обрыв вкладки не должен их терять -------------------

test('слот неслучившегося круга возвращается, когда конец запуска дочитала другая вкладка', async () => {
  const spent = async () => (await (await fetch(`${base}/healthz`)).json()).limiter.callsToday

  state.hangAnswer = true
  const before = await spent()
  const runId = await startRun()
  const first = subscribe(runId)
  await until(() => state.answerCalls > 0, 'запуск дошёл до вызова модели')
  assert.equal((await call('POST', '/api/run/pause', { paused: true })).status, 200)
  await until(() => first.events.some((e) => e.stage === 'paused'), 'пауза дошла до вкладки')
  first.close()
  await first.done

  state.hangAnswer = false
  assert.equal((await call('POST', '/api/run/pause', { paused: false })).status, 200)
  const second = subscribe(runId)
  await until(() => second.ends.length > 0, 'запуск завершился', 15000)
  second.close()
  await second.done

  // Занято: два слота под два круга проверки + один под повтор прерванного
  // вызова. Состоялся один круг, значит второй обязан вернуться.
  assert.equal(
    (await spent()) - before,
    2,
    'слот неслучившегося круга не должен пропадать оттого, что вкладку закрыли',
  )
})
