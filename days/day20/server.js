// День 20: та же цепочка, но порядок вызовов и перенос данных между ними
// выбирает модель, а инструменты приходят с разных серверов MCP
// (ADR 2026-09-28-0736, п. 1). Сервер дня ничего об этом не знает: статика,
// создание запуска и сквозной поток его событий — и всё.
//
// Ключ AGENT_KEY держит этот процесс. Страница его не знает, не получает и не
// показывает (I-1). Запуск стоит денег, поэтому слот берётся ДО обращения к
// сервису агентов (I-4) и суточный потолок проверяется первым.
import { randomUUID } from 'node:crypto'
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
/** Идентификатор сессии чеканит этот сервер; чужая форма не принимается. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const COOKIE_NAME = 'day20_sid'
const CHAT_DOWN = 'Память диалога сейчас недоступна: переписка не показана.'

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

/**
 * Идентификатор сессии из cookie (образец: days/day7/server.js). Значение
 * чужой формы не принимается: в путь запроса к сервису оно идёт как есть.
 */
function sessionFromCookie(req) {
  const raw = req.headers.cookie
  if (typeof raw !== 'string') return null
  for (const part of raw.split(';')) {
    const at = part.indexOf('=')
    if (at === -1) continue
    if (part.slice(0, at).trim() !== COOKIE_NAME) continue
    const value = part.slice(at + 1).trim()
    return SESSION_ID.test(value) ? value : null
  }
  return null
}

/**
 * Cookie сессии: `HttpOnly` — страница её не читает и в хранилище браузера
 * идентификатор не кладётся (I-10 и правило дня); `SameSite=Lax` — чужой сайт
 * не пошлёт её от вашего имени; `Path` — только адреса этого дня. Изоляцией от
 * соседних дней на том же origin это не является, и день 7 говорит то же.
 */
function sessionCookie(sessionId) {
  const parts = [
    `${COOKIE_NAME}=${sessionId}`,
    'HttpOnly',
    'SameSite=Lax',
    `Path=${env.COOKIE_PATH}`,
    `Max-Age=${Math.round(env.SESSION_TTL_HOURS * 3600)}`,
  ]
  if (env.COOKIE_SECURE) parts.push('Secure')
  return parts.join('; ')
}

/** Сессия запроса; новая чеканится здесь, а не страницей. */
function ensureSession(req) {
  const existing = sessionFromCookie(req)
  const sessionId = existing ?? randomUUID()
  return { sessionId, headers: { 'set-cookie': sessionCookie(sessionId) } }
}

/** Запрос к сервису агентов. Ключ подставляется здесь и никуда больше не уходит (I-1). */
async function callAgent(path, options = {}) {
  const response = await fetch(`${env.AGENT_URL}${path}`, {
    ...options,
    headers: { ...agentHeaders, ...(options.headers ?? {}) },
    signal: AbortSignal.timeout(env.AGENT_TIMEOUT_MS),
  })
  const json = await response.json().catch(() => null)
  return { response, json }
}

/** Потолок текста задания. Длиннее — отказ страницы, а не обрезка молчком. */
const MAX_TASK = 600

async function handleRun(req, res) {
  // Сессия заводится до чтения тела: cookie уходит с ЛЮБЫМ ответом, включая
  // отказы. Иначе первый отказ оставил бы посетителя без идентификатора, и
  // следующее сообщение начало бы новый диалог молча.
  const session = ensureSession(req)
  let ask
  try {
    ask = JSON.parse(await readBody(req))
  } catch (error) {
    return send(res, 400, { error: error.message === 'тело больше 16 КБ' ? error.message : 'тело не JSON' }, session.headers)
  }
  const task = ask && typeof ask.task === 'string' ? ask.task.trim() : ''
  if (!task) return send(res, 400, { error: 'Задание пустое.' }, session.headers)
  if (task.length > MAX_TASK)
    return send(res, 400, { error: `Задание длиннее ${MAX_TASK} знаков.` }, session.headers)

  // Слот берётся ДО обращения к сервису агентов (I-4): проверка и учёт — один
  // синхронный шаг, иначе залп параллельных запросов проходит мимо окна.
  // Слот берётся НА КАЖДОЕ СООБЩЕНИЕ, а не на диалог: платит каждый ход.
  const slot = limiter.reserve(clientIp(req))
  if (!slot.ok)
    return send(
      res,
      429,
      { error: slot.message, retryAfterSec: slot.retryAfterSec ?? null },
      {
        ...session.headers,
        ...(slot.retryAfterSec ? { 'retry-after': String(slot.retryAfterSec) } : {}),
      },
    )

  let response
  let json
  try {
    // Идентификатор сессии берётся ИЗ COOKIE, а не из тела запроса: тело
    // пишет страница, а cookie чеканит этот сервер. Иначе чужую переписку
    // читал бы всякий, кто подставит идентификатор в JSON.
    ;({ response, json } = await callAgent('/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: env.AGENT_ID,
        input: { task, sessionId: session.sessionId },
      }),
    }))
  } catch (error) {
    console.error(`агент: ${error.name}`)
    return send(res, 502, { error: AGENT_DOWN }, session.headers)
  }
  if (response.status === 202 && json?.runId)
    return send(res, 202, { runId: json.runId }, session.headers)
  if (response.status === 400)
    return send(res, 400, { error: json?.message ?? 'Запрос отклонён.' }, session.headers)
  console.error(`агент: ${response.status} ${json?.code ?? ''}`)
  return send(res, 502, { error: AGENT_DOWN }, session.headers)
}

/**
 * Переписка сессии: чтение и очистка (образец: days/day7/server.js).
 * Идентификатор берётся из cookie и в теле запроса не принимается.
 *
 * В ответе — только то, что отдал сервис: реплики и `meta` сообщений агента,
 * где лежат слова кругов. Ключ сервиса сюда не попадает (I-1), адреса
 * посетителя здесь нет и не запоминается (I-10).
 */
async function handleChat(req, res) {
  const session = ensureSession(req)
  try {
    if (req.method === 'DELETE') {
      const { response } = await callAgent(`/v1/sessions/${session.sessionId}`, { method: 'DELETE' })
      // Пока сервис не подтвердил удаление, менять cookie нельзя: без
      // прежнего идентификатора переписку будет не удалить уже никогда.
      if (!response.ok) throw new Error(`агент ${response.status}`)
      return send(res, 200, { messages: [], cleared: true }, { 'set-cookie': sessionCookie(randomUUID()) })
    }
    const { response, json } = await callAgent(`/v1/sessions/${session.sessionId}`)
    // 503 `no_sessions` — это ответ сервиса, а не молчание: так и говорим.
    if (response.status === 503 && json?.code === 'no_sessions')
      return send(res, 503, { error: CHAT_DOWN }, session.headers)
    if (!response.ok) throw new Error(`агент ${response.status}`)
    return send(res, 200, { messages: json?.messages ?? [] }, session.headers)
  } catch (error) {
    console.error(`переписка: ${error.message}`)
    return send(res, 502, { error: AGENT_DOWN }, session.headers)
  }
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

  if (url.pathname === '/api/chat' && (req.method === 'GET' || req.method === 'DELETE'))
    return handleChat(req, res)

  const events = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/)
  if (events && req.method === 'GET') {
    if (!RUN_ID.test(events[1])) return send(res, 404, { error: 'Запуск не найден' })
    return proxyEvents(req, res, events[1])
  }

  return serveStatic(url, res)
})

if (process.env.NODE_ENV !== 'test') {
  server.listen(env.PORT, () => console.log(`день 20 слушает :${env.PORT}`))
}

export { env, server }
