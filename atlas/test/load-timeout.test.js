import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, mock, test } from 'node:test'
import { LOAD_HINT, LOAD_HINT_MS, LOAD_LIMIT_MS, LOAD_TIMEOUT, fetchGraph } from '../web/app.js'

// Срок ожидания схемы — agent_docs/design/2026-09-14-1930-atlas-load-timeout.md.
// Одна попытка загрузки без браузера: часы подменены, сервер — заглушка,
// которая, как настоящий `fetch`, отклоняется по сигналу отмены. Что видно на
// экране и что звучит в `#live` — только в браузере.

const GRAPH = { nodes: [], edges: [] }

beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }))
afterEach(() => mock.timers.reset())

/** Сервер, который ничего не отвечает сам: ответ даёт тест. */
function server() {
  const calls = []
  const get = (url, init) =>
    new Promise((respond, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason))
      calls.push({ url, init, respond, reject })
    })
  return { get, calls }
}

/** Заголовки пришли, тело застряло: `json()` ждёт, пока его не отменят. */
const stuckBody = (signal) => ({
  ok: true,
  status: 200,
  json: () =>
    new Promise((_, reject) => {
      const stop = () => reject(new DOMException('aborted', 'AbortError'))
      if (signal.aborted) stop()
      else signal.addEventListener('abort', stop)
    }),
})

/** Настоящий оборот цикла событий: `setImmediate` часами не подменяется. */
const turn = () => new Promise((resolve) => setImmediate(resolve))

const okBody = (graph) => ({ ok: true, status: 200, json: async () => graph })

// ── Сроки ──────────────────────────────────────────────────────────────

test('ступени — 8 с и 30 с', () => {
  assert.equal(LOAD_HINT_MS, 8000)
  assert.equal(LOAD_LIMIT_MS, 30000)
})

test('молчащий сервер: подсказка один раз на 8-й секунде, до неё — ничего', async () => {
  const { get } = server()
  let hints = 0
  const attempt = fetchGraph(() => hints++, get)
  attempt.catch(() => {})
  mock.timers.tick(LOAD_HINT_MS - 1)
  assert.equal(hints, 0)
  mock.timers.tick(1)
  assert.equal(hints, 1)
  mock.timers.tick(LOAD_LIMIT_MS - LOAD_HINT_MS - 1)
  assert.equal(hints, 1)
})

test('молчащий сервер: на 30-й секунде отказ по сроку и запрос отменён', async () => {
  const { get, calls } = server()
  const attempt = fetchGraph(() => {}, get)
  mock.timers.tick(LOAD_LIMIT_MS - 1)
  assert.equal(calls[0].init.signal.aborted, false)
  mock.timers.tick(1)
  assert.equal(calls[0].init.signal.aborted, true)
  await assert.rejects(attempt, { message: LOAD_TIMEOUT })
})

test('заголовки без тела: причина — срок, а не «это не JSON», хотя отмена пришла как AbortError', async () => {
  const { get, calls } = server()
  const attempt = fetchGraph(() => {}, get)
  calls[0].respond(stuckBody(calls[0].init.signal))
  await turn()
  mock.timers.tick(LOAD_LIMIT_MS)
  await assert.rejects(attempt, { message: LOAD_TIMEOUT })
})

test('ответ на 29-й секунде — успех; на 30-й ничего не происходит', async () => {
  const { get, calls } = server()
  let hints = 0
  const attempt = fetchGraph(() => hints++, get)
  mock.timers.tick(29000)
  calls[0].respond(okBody(GRAPH))
  assert.deepEqual(await attempt, GRAPH)
  mock.timers.tick(2000)
  assert.equal(calls[0].init.signal.aborted, false)
  assert.equal(hints, 1)
})

test('ответ на 31-й секунде не принимается: попытка уже кончилась отказом по сроку', async () => {
  const { get, calls } = server()
  const attempt = fetchGraph(() => {}, get)
  mock.timers.tick(LOAD_LIMIT_MS)
  await assert.rejects(attempt, { message: LOAD_TIMEOUT })
  mock.timers.tick(1000)
  calls[0].respond(okBody(GRAPH))
  assert.equal(calls[0].init.signal.aborted, true)
})

// ── Быстрый исход гасит оба срока ──────────────────────────────────────

test('404 — своя причина сразу, подсказки через 8 с нет', async () => {
  const { get, calls } = server()
  let hints = 0
  const attempt = fetchGraph(() => hints++, get)
  calls[0].respond({ ok: false, status: 404 })
  await assert.rejects(attempt, { message: 'На graph.json пришёл ответ 404.' })
  mock.timers.tick(LOAD_LIMIT_MS + 10000)
  assert.equal(hints, 0)
  assert.equal(calls[0].init.signal.aborted, false)
})

test('обрыв до срока — причина «сети нет», не срок', async () => {
  const { get, calls } = server()
  const attempt = fetchGraph(() => {}, get)
  calls[0].reject(new TypeError('Failed to fetch'))
  await assert.rejects(attempt, { message: 'Файл graph.json не получен: сети нет или адрес не отвечает.' })
})

test('битый JSON до срока — причина «это не JSON»', async () => {
  const { get, calls } = server()
  const attempt = fetchGraph(() => {}, get)
  calls[0].respond({ ok: true, status: 200, json: async () => JSON.parse('{') })
  await assert.rejects(attempt, { message: 'Файл graph.json получен, но это не JSON.' })
})

// ── Попытки ────────────────────────────────────────────────────────────

test('у каждой попытки свой сигнал, и отсчёт начинается заново', async () => {
  const { get, calls } = server()
  const first = fetchGraph(() => {}, get)
  mock.timers.tick(LOAD_LIMIT_MS)
  await assert.rejects(first, { message: LOAD_TIMEOUT })
  let hints = 0
  const second = fetchGraph(() => hints++, get)
  second.catch(() => {})
  assert.notEqual(calls[1].init.signal, calls[0].init.signal)
  assert.equal(calls[1].init.signal.aborted, false)
  mock.timers.tick(LOAD_HINT_MS)
  assert.equal(hints, 1)
  mock.timers.tick(LOAD_LIMIT_MS - LOAD_HINT_MS)
  await assert.rejects(second, { message: LOAD_TIMEOUT })
})

test('запрос — тот же, что до срока: относительный путь, без кэша', () => {
  const { get, calls } = server()
  fetchGraph(() => {}, get).catch(() => {})
  assert.equal(calls[0].url, 'graph.json')
  assert.equal(calls[0].init.cache, 'no-cache')
})

// ── Тексты ─────────────────────────────────────────────────────────────

test('тексты дословно, между числом и «с» — неразрывный пробел', () => {
  assert.equal(LOAD_HINT, 'Читаю схему проекта… Это дольше обычного, жду не дольше 30 с.')
  assert.equal(LOAD_TIMEOUT, 'Файл graph.json не пришёл за 30 с: сервер не отвечает или сеть слишком медленная.')
})

test('число в текстах берётся из срока, а не записано в строке', () => {
  const src = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /30(?: | |\\u00a0)с/)
})
