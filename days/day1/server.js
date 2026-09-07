// День 1: три свежие новости стартапов в заданной сфере.
// Источник — фиксированный набор RSS-лент (ADR 2026-09-07-2016),
// модель только выбирает номера. Ноль runtime-зависимостей (ADR 2026-09-07-1525).

import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { createCache } from './cache.js'
import { buildDigest } from './digest.js'
import { parseEnv, parseSphere } from './env.js'
import { FEEDS } from './feeds.js'
import { createLimiter } from './limits.js'

const { env, errors } = parseEnv()
for (const error of errors) console.warn(`конфигурация: ${error}`)

const PORT = env.PORT
const PUBLIC_DIR = new URL('./public/', import.meta.url).pathname
const cache = createCache()
const limiter = createLimiter(env)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

/** Адрес за Caddy приходит в X-Forwarded-For; первый элемент — клиент. */
function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0].trim()
  return req.socket.remoteAddress ?? 'unknown'
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/** Тело запроса с жёстким потолком: без него POST — способ съесть память. */
async function readBody(req, limit = 4096) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('тело запроса слишком большое')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * SSE: шаги поиска приходят по мере выполнения, потому что полный ответ
 * занимает секунды и тишина неотличима от зависания (architecture.md).
 */
async function handleDigest(req, res, url) {
  const sphere = parseSphere(url.searchParams.get('sphere') ?? '')
  if (!sphere.ok) return sendJson(res, 400, { error: sphere.message })

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000)

  try {
    const digest = await buildDigest(sphere.sphere, {
      cache,
      limiter,
      env,
      ip: clientIp(req),
      onProgress: (step) => send('progress', step),
    })
    send('result', digest)
  } catch (error) {
    const limited = error.code === 'daily' || error.code === 'minute' || error.code === 'hour'
    // Наружу уходит причина, а не устройство сбоя: ключ и внутренности не показываем (I-1).
    if (!limited) console.error('digest:', error.message)
    send('error', {
      message: limited ? error.message : 'Не удалось собрать подборку. Попробуйте позже.',
      code: error.code ?? 'internal',
    })
  } finally {
    clearInterval(heartbeat)
    res.end()
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')

  if (url.pathname === '/healthz') {
    return sendJson(res, 200, { ok: true, day: 1, node: process.version, feeds: FEEDS.length })
  }

  if (url.pathname === '/api/digest' && req.method === 'GET') {
    return handleDigest(req, res, url)
  }

  if (url.pathname === '/api/digest' && req.method === 'POST') {
    // POST оставлен для не-SSE клиентов и тестов: тот же путь, один ответ.
    try {
      const body = JSON.parse((await readBody(req)) || '{}')
      const sphere = parseSphere(body.sphere)
      if (!sphere.ok) return sendJson(res, 400, { error: sphere.message })
      const digest = await buildDigest(sphere.sphere, { cache, limiter, env, ip: clientIp(req) })
      return sendJson(res, 200, digest)
    } catch (error) {
      const limited = error.code === 'daily' || error.code === 'minute' || error.code === 'hour'
      if (limited) return sendJson(res, 429, { error: error.message })
      console.error('digest:', error.message)
      return sendJson(res, 500, { error: 'Не удалось собрать подборку. Попробуйте позже.' })
    }
  }

  if (url.pathname === '/api/sources') {
    return sendJson(res, 200, { feeds: FEEDS.map(({ source, region }) => ({ source, region })) })
  }

  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
  const file = normalize(join(PUBLIC_DIR, rel))
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden')
    return
  }

  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  }
})

server.listen(PORT, () => console.log(`day1 слушает :${PORT}, лент: ${FEEDS.length}`))

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => process.exit(0)))
}
