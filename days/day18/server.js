// День 18: лента сводок планировщика. Своих запусков день НЕ создаёт —
// запуски заводит планировщик внутри сервиса агентов (ADR 2026-09-28-0736,
// п. 6). Страница только читает и подписывается, поэтому ручки «запустить»
// здесь нет ни в каком виде: кнопка на экране была бы обходом решения
// владельца о выключателе через PR.
//
// Ключ AGENT_KEY держит этот процесс. Страница его не знает, не получает и не
// показывает (I-1).
//
// ВНИМАНИЕ, НЕУТВЕРЖДЁННЫЙ КОНТРАКТ: путь `JOBS_PATH` и состав полей сводки
// задаёт единица `agents` (ADR п. 7 называет данные, но не ручку). Тело
// ответа уходит на страницу КАК ЕСТЬ, без разбора и без своего конверта:
// когда ручка появится, здесь не меняется ничего, а имена полей читает одна
// функция страницы (public/digest.js, `shapeDigest`).
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import { dirname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from './env.js'
import { createLimiter } from './limits.js'

const here = dirname(fileURLToPath(import.meta.url))
const PUBLIC = join(here, 'public')
const AGENT_DOWN = 'Сервис агентов недоступен. Попробуйте позже.'
/** Идентификатор запуска приходит с нашей же страницы, но проверяется как чужой ввод. */
const RUN_ID = /^[a-zA-Z0-9-]{1,64}$/

const { env, errors: envErrors } = parseEnv()
for (const message of envErrors) console.error(`конфигурация: ${message}`)

const limiter = createLimiter(env)
const agentHeaders = { authorization: `Bearer ${env.AGENT_KEY}` }

function send(res, status, payload, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(JSON.stringify(payload))
}

/**
 * Адрес клиента. Caddy ДОПИСЫВАЕТ реальный адрес в конец X-Forwarded-For,
 * поэтому берётся последний элемент, а не первый: первый подделывается
 * заголовком запроса, и тогда окно на адрес обходится сменой значения.
 */
function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    const parts = forwarded.split(',')
    const last = parts[parts.length - 1].trim()
    if (last) return last
  }
  return req.socket.remoteAddress ?? 'unknown'
}

/** Ручка сводок в сервисе агентов. Контракт не утверждён — см. шапку файла. */
const JOBS_PATH = '/v1/jobs/digest'

async function handleDigest(req, res) {
  // Слот берётся и на чтение: ручка публичная и ходит в соседнюю службу.
  const slot = limiter.reserve(clientIp(req))
  if (!slot.ok)
    return send(
      res,
      429,
      { error: slot.message, retryAfterSec: slot.retryAfterSec ?? null },
      slot.retryAfterSec ? { 'retry-after': String(slot.retryAfterSec) } : {},
    )

  let upstream
  let text
  try {
    upstream = await fetch(`${env.AGENT_URL}${JOBS_PATH}`, {
      headers: agentHeaders,
      signal: AbortSignal.timeout(env.AGENT_TIMEOUT_MS),
    })
    text = await upstream.text()
  } catch (error) {
    console.error(`агент: ${error.name}`)
    return send(res, 502, { error: AGENT_DOWN })
  }
  if (!upstream.ok) {
    console.error(`агент: ${upstream.status}`)
    return send(res, 502, { error: AGENT_DOWN })
  }
  // Байты как есть: свой конверт сверху сделал бы предметом показа обёртку.
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

/**
 * Поток событий запуска — насквозь, байт в байт (образец: days/day15/server.js,
 * proxyEvents). День ничего не разбирает и ничего не переписывает: предмет
 * показа — сырые тела JSON-RPC внутри событий стадии `rpc`
 * (ADR 2026-09-28-0736, п. 5), и любая переупаковка сделала бы предметом
 * показа нашу обёртку.
 *
 * Ключ AGENT_KEY подставляется здесь и никуда больше не уходит (I-1).
 * Адрес посетителя в потоке не участвует и нигде не запоминается (I-10).
 */
async function proxyEvents(req, res, runId) {
  const controller = new AbortController()
  req.on('close', () => controller.abort())

  let upstream
  try {
    upstream = await fetch(`${env.AGENT_URL}/v1/runs/${runId}/events`, {
      headers: agentHeaders,
      signal: controller.signal,
    })
  } catch (error) {
    if (controller.signal.aborted) return
    console.error(`агент: ${error.name}`)
    return send(res, 502, { error: AGENT_DOWN })
  }
  if (!upstream.ok || !upstream.body)
    return send(res, upstream.status === 404 ? 404 : 502, {
      error: upstream.status === 404 ? 'Запуск не найден' : AGENT_DOWN,
    })

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  })
  res.flushHeaders?.()

  const reader = upstream.body.getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (!res.write(Buffer.from(value))) await new Promise((r) => res.once('drain', r))
    }
  } catch (error) {
    if (!controller.signal.aborted) console.error(`поток событий: ${error.name}`)
  } finally {
    res.end()
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  // Без этой строки страница не работает вовсе: модуль, отданный как
  // application/octet-stream, браузер не исполняет.
  '.js': 'text/javascript; charset=utf-8',
}

async function serveStatic(url, res) {
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
  const file = normalize(join(PUBLIC, rel))
  if (file !== PUBLIC && !file.startsWith(PUBLIC + sep)) {
    res.writeHead(403)
    return res.end()
  }
  try {
    const data = await readFile(file)
    const ext = file.slice(file.lastIndexOf('.'))
    res.writeHead(200, { 'content-type': TYPES[ext] ?? 'application/octet-stream' })
    res.end(data)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('не найдено')
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)

  if (url.pathname === '/healthz') {
    const ok = envErrors.length === 0
    return send(res, ok ? 200 : 503, { ok, errors: envErrors, limiter: limiter.stats() })
  }

  if (url.pathname === '/api/digest' && req.method === 'GET') return handleDigest(req, res)

  const events = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/)
  if (events && req.method === 'GET') {
    if (!RUN_ID.test(events[1])) return send(res, 404, { error: 'Запуск не найден' })
    return proxyEvents(req, res, events[1])
  }

  return serveStatic(url, res)
})

if (process.env.NODE_ENV !== 'test') {
  server.listen(env.PORT, () => console.log(`день 18 слушает :${env.PORT}`))
}

export { env, server }
