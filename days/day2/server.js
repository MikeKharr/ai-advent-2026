// День 2: управление параметрами обработки запроса к модели и подсчёт
// токенов. Пайплайн новостей — от дня 1 (ADR 2026-09-07-2016), ответ —
// свободный текст с параметрами пользователя. Ноль runtime-зависимостей
// (ADR 2026-09-07-1525).

import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { buildAnswer } from './answer.js'
import { createCache } from './cache.js'
import { parseEnv, parseParams, parseSphere } from './env.js'
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

/**
 * Адрес клиента. Caddy ДОПИСЫВАЕТ реальный адрес в конец X-Forwarded-For,
 * поэтому берём последний элемент, а не первый: первый подделывается
 * заголовком в запросе, и тогда rate limit обходится сменой значения.
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

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/** Тело запроса с жёстким потолком: без него POST — способ съесть память. */
async function readBody(req, limit = 8192) {
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
 * Сфера и параметры: из query для SSE, из тела для POST. Ошибка — отказ.
 * Тело — только объект: JSON.parse('null') и массивы не должны доходить до
 * чтения полей. Падение процесса на границе обнуляло бы счётчики лимитов (I-5).
 */
function parseRequest(source) {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    return { ok: false, message: 'Тело запроса должно быть JSON-объектом' }
  }
  const sphere = parseSphere(source.sphere ?? '')
  if (!sphere.ok) return { ok: false, message: sphere.message }
  // Оба написания ключей: camelCase из README и snake_case как в query SSE —
  // молчаливо игнорировать «не то» написание нельзя (иначе тихий дефолт).
  const params = parseParams(
    {
      format: source.format,
      stop: source.stop,
      maxTokens: source.maxTokens ?? source.max_tokens,
      perSource: source.perSource ?? source.per_source,
    },
    env,
  )
  if (!params.ok) return { ok: false, message: params.message }
  return { ok: true, sphere: sphere.sphere, params: params.params }
}

/**
 * SSE: шаги приходят по мере выполнения, потому что полный ответ занимает
 * секунды и тишина неотличима от зависания.
 */
async function handleAnswer(req, res, url) {
  const q = url.searchParams
  const parsed = parseRequest({
    sphere: q.get('sphere') ?? '',
    format: q.get('format') ?? '',
    stop: q.get('stop') ?? '',
    maxTokens: q.get('max_tokens') ?? '',
    perSource: q.get('per_source') ?? '',
  })
  if (!parsed.ok) return sendJson(res, 400, { error: parsed.message })

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
    const answer = await buildAnswer(parsed.sphere, parsed.params, {
      cache,
      limiter,
      env,
      ip: clientIp(req),
      onProgress: (step) => send('progress', step),
    })
    send('result', answer)
  } catch (error) {
    const limited = error.code === 'daily' || error.code === 'minute' || error.code === 'hour'
    // Наружу уходит причина, а не устройство сбоя: ключ и внутренности не показываем (I-1).
    if (!limited) console.error('answer:', error.message)
    send('error', {
      message: limited ? error.message : 'Не удалось получить ответ. Попробуйте позже.',
      code: error.code ?? 'internal',
    })
  } finally {
    clearInterval(heartbeat)
    res.end()
  }
}

/**
 * Недосмотр на границе не должен ронять процесс: счётчики лимитов живут
 * в памяти, и рестарт контейнера обнулял бы их (I-5). Ошибка — 500 и лог.
 */
const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error('server:', error.message)
    if (res.headersSent) res.end()
    else sendJson(res, 500, { error: 'Внутренняя ошибка. Попробуйте позже.' })
  })
})

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost')

  if (url.pathname === '/healthz') {
    // Без ключа приложение поднимается, но работать не может: Caddy считал бы
    // его живым, а пользователь получал бы 401 после загрузки восьми лент.
    const healthy = errors.length === 0
    return sendJson(res, healthy ? 200 : 503, {
      ok: healthy,
      day: 2,
      node: process.version,
      feeds: FEEDS.length,
      config: healthy ? 'ok' : 'неполная',
    })
  }

  if (url.pathname === '/api/answer' && req.method === 'GET') {
    return handleAnswer(req, res, url)
  }

  if (url.pathname === '/api/answer' && req.method === 'POST') {
    // POST оставлен для не-SSE клиентов и тестов: тот же путь, один ответ.
    let body
    try {
      body = JSON.parse((await readBody(req)) || '{}')
    } catch (error) {
      // Ошибка клиента отличается от нашей: 413 на длинное тело, 400 на битый JSON.
      const tooLarge = error.message.includes('слишком большое')
      return sendJson(res, tooLarge ? 413 : 400, {
        error: tooLarge ? 'Тело запроса слишком большое' : 'Тело запроса не разобрано как JSON',
      })
    }

    try {
      // Разбор внутри try, как в дне 1: граница не должна полагаться на то,
      // что дальше по коду ничего не бросает.
      const parsed = parseRequest(body)
      if (!parsed.ok) return sendJson(res, 400, { error: parsed.message })

      const answer = await buildAnswer(parsed.sphere, parsed.params, {
        cache,
        limiter,
        env,
        ip: clientIp(req),
      })
      return sendJson(res, 200, answer)
    } catch (error) {
      const limited = error.code === 'daily' || error.code === 'minute' || error.code === 'hour'
      if (limited) return sendJson(res, 429, { error: error.message })
      console.error('answer:', error.message)
      return sendJson(res, 500, { error: 'Не удалось получить ответ. Попробуйте позже.' })
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
}

server.listen(PORT, () => console.log(`day2 слушает :${PORT}, лент: ${FEEDS.length}`))

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => process.exit(0)))
}
