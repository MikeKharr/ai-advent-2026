// День 6: страница — пульт к агенту (ADR 2026-09-09-0854, п. 5). День знает
// про агента и не знает про роутер, промпты и архив. Здесь остаются только
// лимитер публичного адреса, создание запуска, прокси потока событий и
// сборка состояния для страницы.

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
/** Сколько помним, чей запуск: чтобы вернуть слот лимитера, если агент денег не потратил. */
const PENDING_TTL_MS = 10 * 60_000

const { env, errors: envErrors } = parseEnv()
for (const message of envErrors) console.error(`конфигурация: ${message}`)

const limiter = createLimiter(env)
/** @type {Map<string, { ip: string, at: number }>} runId → кто занял слот */
const pending = new Map()

const agentHeaders = { authorization: `Bearer ${env.AGENT_KEY}` }

function send(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
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

function remember(runId, ip) {
  const now = Date.now()
  for (const [id, slot] of pending) if (now - slot.at > PENDING_TTL_MS) pending.delete(id)
  pending.set(runId, { ip, at: now })
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

  // Слот резервируется до обращения к агенту (I-4): агент тратит деньги,
  // и отказ лимитера должен случаться раньше, а не позже.
  const ip = clientIp(req)
  const slot = limiter.reserve(ip)
  if (!slot.ok) return send(res, 429, { error: slot.message })

  let response
  let json
  try {
    response = await fetch(`${env.AGENT_URL}/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...agentHeaders },
      body: JSON.stringify({ agent: env.AGENT_ID, input: body }),
      signal: AbortSignal.timeout(env.AGENT_TIMEOUT_MS),
    })
    json = await response.json().catch(() => null)
  } catch (error) {
    limiter.release(ip)
    console.error(`агент: ${error.name}: ${error.message}`)
    return send(res, 502, { error: 'Агент недоступен. Попробуйте позже.' })
  }

  if (response.status === 202 && json?.runId) {
    remember(json.runId, ip)
    return send(res, 202, { runId: json.runId })
  }
  // До запуска дело не дошло — слот возвращается. Причину отказа во входе
  // пользователь должен видеть словами агента: он их и проверял.
  limiter.release(ip)
  if (response.status === 400) return send(res, 400, { error: json?.message ?? 'Запрос отклонён' })
  console.error(`агент: ${response.status} ${json?.code ?? ''}`)
  return send(res, 502, { error: 'Агент недоступен. Попробуйте позже.' })
}

/**
 * Прокси потока событий: байты уходят в браузер как есть, а по дороге
 * читается сообщение `end` — если агент отказал, не потратив денег, слот
 * лимитера возвращается. Разбор строк ради одного признака, но без него
 * поток отказов по квоте выел бы суточный предел дня зря.
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

/** Состояние для страницы: описание агента, модели, пресеты, архив — всё от агента. */
async function handleState(res) {
  try {
    const [agentsRes, archiveRes] = await Promise.all([
      fetch(`${env.AGENT_URL}/v1/agents`, {
        headers: agentHeaders,
        signal: AbortSignal.timeout(env.AGENT_TIMEOUT_MS),
      }),
      fetch(`${env.AGENT_URL}/v1/agents/${env.AGENT_ID}/tools/archive`, {
        headers: agentHeaders,
        signal: AbortSignal.timeout(env.AGENT_TIMEOUT_MS),
      }),
    ])
    const agents = agentsRes.ok ? await agentsRes.json() : null
    const archive = archiveRes.ok ? await archiveRes.json() : null
    const agent = agents?.agents?.find((a) => a.id === env.AGENT_ID)
    if (!agent || !archive) throw new Error(`агент ${agentsRes.status}, архив ${archiveRes.status}`)

    const { sources, ok: _ok, ...archiveState } = archive
    return send(res, 200, {
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
    })
  } catch (error) {
    console.error(`состояние: ${error.message}`)
    return send(res, 503, { error: 'Агент недоступен. Попробуйте позже.' })
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)

  if (url.pathname === '/healthz') {
    const ok = envErrors.length === 0
    return send(res, ok ? 200 : 503, { ok, errors: envErrors, limiter: limiter.stats() })
  }

  if (url.pathname === '/api/answer' && req.method === 'POST') return handleAnswer(req, res)

  const events = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/)
  if (events && req.method === 'GET') {
    if (!RUN_ID.test(events[1])) return send(res, 404, { error: 'Запуск не найден' })
    return proxyEvents(req, res, events[1])
  }

  if (url.pathname === '/api/state') return handleState(res)

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
  server.listen(env.PORT, () => console.log(`день 6 слушает :${env.PORT}`))
}

export { env, server }
