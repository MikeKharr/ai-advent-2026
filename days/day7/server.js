// День 7: страница — чат с агентом (ADR 2026-09-12-0930). День отвечает за
// публичный адрес, лимитер и сессию; память диалога живёт у агента.
//
// Идентификатор сессии выдаёт сервер в cookie `HttpOnly`: скрипты страницы
// его не видят и в хранилище браузера он не лежит.

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import { dirname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from './env.js'
import { createLimiter } from './limits.js'

const here = dirname(fileURLToPath(import.meta.url))
const PUBLIC = join(here, 'public')
const MAX_BODY = 64 * 1024
const RUN_ID = /^[0-9a-f-]{36}$/
const SESSION_ID = /^[0-9a-f-]{36}$/
const COOKIE_NAME = 'day7_sid'
/** Сколько помним, чей запуск: чтобы вернуть слот лимитера, если агент денег не потратил. */
const PENDING_TTL_MS = 10 * 60_000

const { env, errors: envErrors } = parseEnv()
for (const message of envErrors) console.error(`конфигурация: ${message}`)

const limiter = createLimiter(env)
/** @type {Map<string, { ip: string, at: number }>} runId → кто занял слот */
const pending = new Map()

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
        reject(new Error('тело больше 64 КБ'))
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
 * поэтому берём последний элемент, а не первый: первый подделывается
 * заголовком в запросе, и тогда окна на адрес обходятся сменой значения.
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

/** Идентификатор сессии из cookie; чужая форма не принимается. */
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
 * Cookie сессии: `HttpOnly` — страница её не читает; `SameSite=Lax` — чужой
 * сайт не пошлёт от вашего имени; `Path` — только этот день, чтобы соседние
 * дни того же домена её не видели. Срок обновляется на каждом обращении.
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

/** Возвращает сессию запроса, при необходимости заводя новую. */
function ensureSession(req) {
  const existing = sessionFromCookie(req)
  if (existing) return { sessionId: existing, headers: { 'set-cookie': sessionCookie(existing) } }
  const created = randomUUID()
  return { sessionId: created, headers: { 'set-cookie': sessionCookie(created) } }
}

function remember(runId, ip) {
  const now = Date.now()
  for (const [id, slot] of pending) if (now - slot.at > PENDING_TTL_MS) pending.delete(id)
  pending.set(runId, { ip, at: now })
}

/** Запрос к агенту. Ошибки транспорта отдаются вызывающему как null. */
async function callAgent(path, options = {}) {
  const response = await fetch(`${env.AGENT_URL}${path}`, {
    ...options,
    headers: { ...agentHeaders, ...(options.headers ?? {}) },
    signal: AbortSignal.timeout(env.AGENT_TIMEOUT_MS),
  })
  const json = await response.json().catch(() => null)
  return { response, json }
}

async function handleAnswer(req, res) {
  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch (error) {
    return send(res, 400, {
      error: error.message === 'тело больше 64 КБ' ? error.message : 'тело не JSON',
    })
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return send(res, 400, { error: 'тело должно быть объектом' })

  const session = ensureSession(req)

  // Слот резервируется до обращения к агенту (I-4): агент тратит деньги,
  // и отказ лимитера должен случаться раньше, а не позже.
  const ip = clientIp(req)
  const slot = limiter.reserve(ip)
  if (!slot.ok) return send(res, 429, { error: slot.message }, session.headers)

  let result
  try {
    result = await callAgent('/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: env.AGENT_ID,
        // Идентификатор сессии добавляет сервер: страница его не знает.
        input: { ...body, sessionId: session.sessionId },
      }),
    })
  } catch (error) {
    limiter.release(ip)
    console.error(`агент: ${error.name}: ${error.message}`)
    return send(res, 502, { error: 'Агент недоступен. Попробуйте позже.' }, session.headers)
  }

  const { response, json } = result
  if (response.status === 202 && json?.runId) {
    remember(json.runId, ip)
    return send(res, 202, { runId: json.runId }, session.headers)
  }
  // До запуска дело не дошло — слот возвращается. Причину отказа во входе
  // пользователь должен видеть словами агента: он их и проверял.
  limiter.release(ip)
  if (response.status === 400)
    return send(res, 400, { error: json?.message ?? 'Запрос отклонён' }, session.headers)
  console.error(`агент: ${response.status} ${json?.code ?? ''}`)
  return send(res, 502, { error: 'Агент недоступен. Попробуйте позже.' }, session.headers)
}

/** Переписка сессии: чтение и удаление. Идентификатор берётся из cookie. */
async function handleChat(req, res) {
  const session = ensureSession(req)
  const clearing = req.method === 'DELETE'
  try {
    if (clearing) {
      await callAgent(`/v1/sessions/${session.sessionId}`, { method: 'DELETE' })
      // Новая сессия начинается сразу: старый идентификатор больше ничего
      // не адресует, и оставлять его в браузере незачем.
      const fresh = randomUUID()
      return send(res, 200, { messages: [], cleared: true }, { 'set-cookie': sessionCookie(fresh) })
    }
    const { response, json } = await callAgent(`/v1/sessions/${session.sessionId}`)
    if (!response.ok) throw new Error(`агент ${response.status}`)
    return send(res, 200, { messages: json.messages ?? [] }, session.headers)
  } catch (error) {
    console.error(`переписка: ${error.message}`)
    return send(res, 502, { error: 'Переписка недоступна: агент не ответил.' }, session.headers)
  }
}

/**
 * Прокси потока событий: байты уходят в браузер как есть, а по дороге
 * читается сообщение `end` — если агент отказал, не потратив денег, слот
 * лимитера возвращается.
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
    console.error(`агент: ${error.name}: ${error.message}`)
    return send(res, 502, { error: 'Агент недоступен. Попробуйте позже.' })
  }
  if (!upstream.ok || !upstream.body) {
    return send(res, upstream.status === 404 ? 404 : 502, {
      error: upstream.status === 404 ? 'Запуск не найден' : 'Агент недоступен. Попробуйте позже.',
    })
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  })
  res.flushHeaders?.()

  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let endSeen = false
  const inspect = (line) => {
    if (line === 'event: end') {
      endSeen = true
      return
    }
    if (!endSeen || !line.startsWith('data: ')) return
    endSeen = false
    try {
      const end = JSON.parse(line.slice(6))
      const slot = pending.get(runId)
      pending.delete(runId)
      if (slot && end.error?.paidNothing) limiter.release(slot.ip)
    } catch {}
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(value)
      buffer += decoder.decode(value, { stream: true })
      let nl = buffer.indexOf('\n')
      while (nl !== -1) {
        inspect(buffer.slice(0, nl).replace(/\r$/, ''))
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf('\n')
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) console.error(`поток ${runId}: ${error.message}`)
  } finally {
    res.end()
  }
}

/** Состояние для страницы: описание агента, модели, пресеты, архив. */
async function handleState(req, res) {
  const session = ensureSession(req)
  try {
    const [agentsRes, archiveRes] = await Promise.all([
      callAgent('/v1/agents'),
      callAgent(`/v1/agents/${env.AGENT_ID}/tools/archive`),
    ])
    const agent = agentsRes.json?.agents?.find((a) => a.id === env.AGENT_ID)
    const archive = archiveRes.response.ok ? archiveRes.json : null
    if (!agent || !archive)
      throw new Error(`агент ${agentsRes.response.status}, архив ${archiveRes.response.status}`)

    const { sources, ok: _ok, ...archiveState } = archive
    return send(
      res,
      200,
      {
        agent: {
          id: agent.id,
          name: agent.name,
          version: agent.version,
          purpose: agent.purpose,
          systemPrompt: agent.systemPrompt,
          tools: agent.tools,
        },
        models: agent.models,
        presets: agent.presets,
        defaults: agent.defaults,
        limits: agent.limits,
        archive: archiveState,
        sources,
        session: { ttlHours: env.SESSION_TTL_HOURS },
      },
      session.headers,
    )
  } catch (error) {
    console.error(`состояние: ${error.message}`)
    return send(res, 503, { error: 'Агент недоступен. Попробуйте позже.' }, session.headers)
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)

  if (url.pathname === '/healthz') {
    const ok = envErrors.length === 0
    return send(res, ok ? 200 : 503, { ok, errors: envErrors, limiter: limiter.stats() })
  }

  if (url.pathname === '/api/answer' && req.method === 'POST') return handleAnswer(req, res)

  if (url.pathname === '/api/chat' && (req.method === 'GET' || req.method === 'DELETE'))
    return handleChat(req, res)

  const events = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/)
  if (events && req.method === 'GET') {
    if (!RUN_ID.test(events[1])) return send(res, 404, { error: 'Запуск не найден' })
    return proxyEvents(req, res, events[1])
  }

  if (url.pathname === '/api/state') return handleState(req, res)

  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
  const file = normalize(join(PUBLIC, rel))
  if (file !== PUBLIC && !file.startsWith(PUBLIC + sep)) {
    res.writeHead(403)
    return res.end()
  }
  try {
    const data = await readFile(file)
    const type = file.endsWith('.html')
      ? 'text/html; charset=utf-8'
      : file.endsWith('.css')
        ? 'text/css; charset=utf-8'
        : 'application/octet-stream'
    res.writeHead(200, { 'content-type': type })
    res.end(data)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('не найдено')
  }
})

if (process.env.NODE_ENV !== 'test') {
  server.listen(env.PORT, () => console.log(`день 7 слушает :${env.PORT}`))
}

export { env, server }
