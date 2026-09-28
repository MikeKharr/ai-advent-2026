// День 19: цепочка MCP шагами. Сервер дня ничего не решает о цепочке — её
// порядок задаёт агент `pipeline-agent` внутри сервиса агентов
// (ADR 2026-09-28-0736, п. 8). Здесь только три вещи: статика, создание
// запуска и сквозной поток его событий.
//
// Ключ AGENT_KEY держит этот процесс. Страница его не знает, не получает и не
// показывает (I-1).
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import { dirname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from './env.js'
import { createLimiter } from './limits.js'

const here = dirname(fileURLToPath(import.meta.url))
const PUBLIC = join(here, 'public')
const MAX_BODY = 16 * 1024
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('тело больше 16 КБ'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
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

/** Потолок текста задания. Длиннее — отказ страницы, а не обрезка молчком. */
const MAX_TASK = 600

async function handleRun(req, res) {
  let ask
  try {
    ask = JSON.parse(await readBody(req))
  } catch (error) {
    return send(res, 400, { error: error.message === 'тело больше 16 КБ' ? error.message : 'тело не JSON' })
  }
  const task = ask && typeof ask.task === 'string' ? ask.task.trim() : ''
  if (!task) return send(res, 400, { error: 'Задание пустое.' })
  if (task.length > MAX_TASK) return send(res, 400, { error: `Задание длиннее ${MAX_TASK} знаков.` })

  // Слот берётся ДО обращения к сервису агентов (I-4): проверка и учёт — один
  // синхронный шаг, иначе залп параллельных запросов проходит мимо окна.
  const slot = limiter.reserve(clientIp(req))
  if (!slot.ok)
    return send(
      res,
      429,
      { error: slot.message, retryAfterSec: slot.retryAfterSec ?? null },
      slot.retryAfterSec ? { 'retry-after': String(slot.retryAfterSec) } : {},
    )

  let response
  let json
  try {
    response = await fetch(`${env.AGENT_URL}/v1/runs`, {
      method: 'POST',
      headers: { ...agentHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ agent: env.AGENT_ID, input: { task } }),
      signal: AbortSignal.timeout(env.AGENT_TIMEOUT_MS),
    })
    json = await response.json().catch(() => null)
  } catch (error) {
    console.error(`агент: ${error.name}`)
    return send(res, 502, { error: AGENT_DOWN })
  }
  if (response.status === 202 && json?.runId) return send(res, 202, { runId: json.runId })
  if (response.status === 400) return send(res, 400, { error: json?.message ?? 'Запрос отклонён.' })
  console.error(`агент: ${response.status} ${json?.code ?? ''}`)
  return send(res, 502, { error: AGENT_DOWN })
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

  if (url.pathname === '/api/runs' && req.method === 'POST') return handleRun(req, res)

  const events = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/)
  if (events && req.method === 'GET') {
    if (!RUN_ID.test(events[1])) return send(res, 404, { error: 'Запуск не найден' })
    return proxyEvents(req, res, events[1])
  }

  return serveStatic(url, res)
})

if (process.env.NODE_ENV !== 'test') {
  server.listen(env.PORT, () => console.log(`день 19 слушает :${env.PORT}`))
}

export { env, server }
