// Учёт слотов по КРУГАМ проверки: сообщение занимает `reviewRounds` слотов до
// запуска (I-4), а неиспользованные возвращаются по `end` потока событий.
// Механика унаследована от дня 15 (ADR 2026-09-21-1747, п. 5); этот файл —
// её держатель у дня 25, и он заведён потому, что ВОЗВРАТ ТЕПЕРЬ ВИДЕН ТОЛЬКО
// СУТОЧНЫМ СЧЁТЧИКОМ.
//
// Почему так: по находке `compliance` к PR #318 `limiter.release` трогает
// только суточный счётчик, а отметки окон минуты и часа оставляет — попытка
// была, и частоту попыток считают именно они. У дня 15 возврат стирал и
// отметки, и его тесты наблюдали слоты через минутное окно; здесь этот канал
// ничего о деньгах не говорит, поэтому наблюдение идёт через суточный потолок,
// а окно минуты заведомо недостижимо.
//
// АРИФМЕТИКА — САМА УЛИКА. Потолок 6, и шаги подобраны так, что ЛЮБОЙ сдвиг
// на один слот меняет, на каком ходе придёт отказ суточного потолка. Текст
// отказа сверяется дословно: «Суточный лимит…», иначе тест не отличил бы его
// от окна минуты.

import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, test } from 'node:test'

const PID = '11111111-1111-4111-8111-111111111111'
const SID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RUN = '00000000-0000-4000-8000-000000000001'

/** Предел кругов профиля: по нему день занимает слоты. */
let profileRounds = 3
/** Сколько кругов назовёт `end`; `null` — не назовёт вовсе (ветвь ошибки). */
let endRounds = 1
/** `ok` | `failed` | `free` | `cut` — чем кончится поток событий. */
let streamMode = 'ok'
/** До какого круга дойдут события `state` — то, что день видит своими глазами. */
let streamRounds = 1

const agents = http.createServer(async (req, res) => {
  for await (const chunk of req) void chunk
  const [path] = req.url.split('?')
  const json = (status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  }

  if (path === `/v1/profiles/${PID}`)
    return json(200, {
      ok: true,
      profile: { id: PID, name: 'стенд', stagedSettings: { reviewRounds: profileRounds } },
    })
  if (path === '/v1/runs') return json(202, { ok: true, runId: RUN })
  if (path === `/v1/runs/${RUN}/events`) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    for (let round = 1; round <= streamRounds; round += 1) {
      const event = { seq: round, stage: 'state', data: { state: 'answer', round } }
      res.write(`id: ${round}\nevent: event\ndata: ${JSON.stringify(event)}\n\n`)
    }
    // Поток оборвался, не сказав `end`: запуск, возможно, идёт.
    if (streamMode === 'cut') return res.end()
    const end =
      streamMode === 'failed'
        ? { status: 'failed', error: { code: 'router_error', message: 'модель не ответила', paidNothing: false } }
        : streamMode === 'free'
          ? { status: 'failed', error: { code: 'search_refused', message: 'поиск отказал', paidNothing: true } }
          : {
              status: 'succeeded',
              result: { answer: 'ответ', summary: { totalTokens: 10, rounds: endRounds } },
            }
    res.write(`event: end\ndata: ${JSON.stringify(end)}\n\n`)
    return res.end()
  }
  return json(200, { ok: true, sessionId: SID })
})

await new Promise((resolve) => agents.listen(0, '127.0.0.1', resolve))

process.env.NODE_ENV = 'test'
process.env.AGENT_KEY = 'agent-key-secret-rounds-do-not-leak'
process.env.AGENT_URL = `http://127.0.0.1:${agents.address().port}`
// Окна частоты заведомо недостижимы: отказ, если он придёт, обязан быть
// суточным — его-то и меряет этот файл.
process.env.RATE_LIMIT_PER_MIN = '1000'
process.env.RATE_LIMIT_PER_HOUR = '1000'
process.env.MAX_DAILY_CALLS = '6'

const { server } = await import('../server.js')
let base = ''

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => {
  server.close()
  agents.close()
})

const ip = '10.6.0.1'
const headers = {
  'x-forwarded-for': ip,
  cookie: `day25_pid=${PID}; day25_sid=${SID}`,
  'content-type': 'application/json',
}

const ask = () =>
  fetch(`${base}/api/answer`, { method: 'POST', headers, body: JSON.stringify({ prompt: 'да' }) })

/** Дочитать поток событий запуска до конца: возврат слотов идёт по `end`. */
const drain = async () => {
  const res = await fetch(`${base}/api/runs/${RUN}/events`, { headers })
  await res.text()
}

/** Один ход: занять слоты, дочитать поток, вернуть, сколько было занято. */
const turn = async (mode, { rounds, seen, told = 1 }) => {
  streamMode = mode
  streamRounds = seen
  endRounds = told
  profileRounds = rounds
  const res = await ask()
  assert.equal(res.status, 202, `ход ${mode}/${rounds} не начался`)
  assert.equal((await res.json()).reserved, rounds, `ход ${mode} занял не ${rounds} слотов`)
  await drain()
}

test('слоты кругов тратятся по состоявшимся кругам, а возврат виден суточным потолком', async () => {
  // Потолок 6. Каждый шаг называет, сколько слотов ОСТАЁТСЯ после него, и это
  // число проверяется последним ходом: он обязан упереться ровно на седьмом
  // оплаченном слоте.
  //
  // 1. три слота, агент назвал один круг → тратится 1, остаётся 5.
  await turn('ok', { rounds: 3, seen: 1, told: 1 })
  // 2. запуск упал, числа кругов в `end` нет — день считает по событиям:
  //    один круг состоялся → тратится 1, остаётся 4.
  await turn('failed', { rounds: 3, seen: 1 })
  // 3. упал, не дойдя ни до какого круга → не тратится ничего, остаётся 4.
  await turn('failed', { rounds: 3, seen: 0 })
  // 4. `paidNothing`: круги начинались, но денег не стоили → остаётся 4.
  await turn('free', { rounds: 3, seen: 2 })
  // 5. поток оборвался без `end` — доказательства завершения нет, и все три
  //    слота остаются занятыми: ошибка в сторону бюджета. Остаётся 1.
  await turn('cut', { rounds: 3, seen: 1 })

  // Один слот ещё есть — ход на один круг проходит.
  streamMode = 'ok'
  streamRounds = 1
  profileRounds = 1
  const last = await ask()
  assert.equal(last.status, 202, 'последний слот не выдан: возвраты посчитаны неверно')
  await drain()

  // Седьмого оплаченного слота нет: отказ СУТОЧНОГО потолка, его словами.
  const over = await ask()
  assert.equal(over.status, 429)
  assert.equal(
    (await over.json()).error,
    'Суточный лимит запросов к модели исчерпан. Попробуйте завтра.',
  )
})
