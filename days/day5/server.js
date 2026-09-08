// День 5: накопленный архив статей вместо загрузки лент на каждый запрос,
// алгоритмический отбор под запрос и выбор модели пользователем.
// Ключей к моделям здесь нет — день ходит в роутер (ADR 2026-09-08-1748).

import { readFile } from 'node:fs/promises'
import http from 'node:http'
import { dirname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODELS, PARAM_DEFAULTS, PARAM_LIMITS, parseEnv, parseParams, parseSphere } from './env.js'
import { collectItems, FEEDS } from './feeds.js'
import { createLimiter } from './limits.js'
import { askRouter } from './router.js'
import { selectForQuery } from './select.js'
import { createStore } from './store.js'

const here = dirname(fileURLToPath(import.meta.url))
const PUBLIC = join(here, 'public')
const MAX_BODY = 64 * 1024
/** Тот же бюджет, что в дне 3: ~120K символов это ~30K токенов. */
const MAX_TEXT_CHARS = 120_000

const { env, errors: envErrors } = parseEnv()
for (const message of envErrors) console.error(`конфигурация: ${message}`)

const store = createStore({
  file: env.STORE_FILE,
  capacity: env.WINDOW_SIZE,
  sources: FEEDS.length,
  maxAgeDays: env.MAX_AGE_DAYS,
  // Источник, убранный из списка лент, перестаёт существовать для приложения
  // целиком: его статьи уходят из архива, а не лежат там навсегда. Иначе
  // обещание в футере «издание может попросить убрать ленту» ничем не
  // подкреплено.
  knownSources: FEEDS.map((f) => f.source),
})
store.load()
store.prune()
console.log(
  JSON.stringify({
    event: 'start',
    store: env.STORE_FILE,
    items: store.size(),
    quota: store.quota,
    skipped: store.skippedOnLoad(),
  }),
)

const limiter = createLimiter(env)

/** Одно обновление лент на процесс: параллельные запросы ждут первое. */
let refreshing = null

/**
 * Пополнение окна: ленты опрашиваются не чаще, чем раз в
 * `REFRESH_MIN_MINUTES`, и только по приходу запроса — фоновой активности
 * на пустом месте нет (решение владельца 2026-09-09).
 */
export async function refreshIfStale({ now = Date.now(), fetchImpl = fetch } = {}) {
  const stale = now - store.lastRefresh() >= env.REFRESH_MIN_MINUTES * 60_000
  if (!stale) return { refreshed: false, added: 0, dropped: 0, failed: [] }
  if (refreshing) return refreshing

  refreshing = (async () => {
    try {
      const collected = await collectItems({ now, fetchImpl })
      // Чистка, пополнение и отметка — одна запись файла, а не три.
      const { added, dropped } = store.batch(() => {
        store.prune(now)
        const result = store.add(collected.items)
        // Отметка ставится и при неудаче части лент: иначе сломанная лента
        // заставляла бы ходить в сеть на каждый запрос.
        store.markRefreshed()
        return result
      })
      console.log(
        JSON.stringify({
          event: 'refresh',
          added,
          dropped,
          total: store.size(),
          failed: collected.failed.map((f) => f.source),
        }),
      )
      return { refreshed: true, added, dropped, failed: collected.failed }
    } catch (error) {
      console.error(`обновление окна: ${error.message}`)
      return { refreshed: false, added: 0, dropped: 0, failed: [] }
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
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

async function handleAnswer(req, res) {
  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch (error) {
    return send(res, 400, {
      error: error.message === 'тело больше 64 КБ' ? error.message : 'тело не JSON',
    })
  }

  const sphere = parseSphere(body?.sphere)
  if (!sphere.ok) return send(res, 400, { error: sphere.message })
  const parsed = parseParams(body ?? {}, env)
  if (!parsed.ok) return send(res, 400, { error: parsed.message })
  const params = parsed.params

  const ip = clientIp(req)
  const slot = limiter.reserve(ip)
  if (!slot.ok) return send(res, 429, { error: slot.message })

  try {
    const refresh = await refreshIfStale()
    const all = store.all()
    if (all.length === 0) {
      limiter.release(ip)
      return send(res, 503, {
        error: 'Архив пуст: ни одна лента пока не отдала статей. Попробуйте позже.',
      })
    }

    const selection = selectForQuery(all, {
      sphere: sphere.sphere,
      prompt: params.prompt,
      perSource: params.perSource,
      limit: params.articles,
      maxChars: MAX_TEXT_CHARS,
    })

    const answer = await askRouter(sphere.sphere, params, selection.items, env)
    return send(res, 200, {
      answer: answer.answer,
      model: answer.provider,
      usage: answer.usage,
      truncated: answer.truncated,
      durationMs: answer.durationMs,
      selection: {
        used: selection.items.length,
        matched: selection.matched,
        terms: selection.terms,
        withText: selection.items.filter((i) => i.text).length,
      },
      archive: { total: store.size(), added: refresh.added, refreshed: refresh.refreshed },
      sources: selection.items.map((i) => ({
        title: i.title,
        url: i.url,
        source: i.source,
        date: i.date,
      })),
    })
  } catch (error) {
    console.error(`ответ: ${error.code ?? ''} ${error.message}`)
    // Отказ роутера, не дошедший до провайдера, денег не стоил, поэтому слот
    // возвращается: иначе поток таких отказов выест суточный предел дня зря.
    const paidNothing =
      error.code === 'budget_exceeded' ||
      error.code === 'refused' ||
      error.code === 'no_provider' ||
      (error.status >= 400 && error.status < 500 && error.status !== 429)
    if (paidNothing) limiter.release(ip)
    if (error.code === 'budget_exceeded') {
      // Роутер отвечает так и когда остаток есть, но запрос в него не влез:
      // «попробуйте завтра» было бы неправдой — хватит меньшей подборки.
      const tooBig = /не помещается/.test(error.message)
      return send(res, 429, {
        error: tooBig
          ? 'Запрос слишком большой для остатка суточного лимита. Уменьшите число статей.'
          : 'Суточный лимит расхода приложения исчерпан, попробуйте завтра.',
      })
    }
    return send(res, error.status === 429 ? 429 : 502, {
      error: `Модель не ответила: ${error.message}`,
    })
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)

  if (url.pathname === '/healthz') {
    const ok = envErrors.length === 0
    return send(res, ok ? 200 : 503, {
      ok,
      archive: store.size(),
      lastRefresh: store.lastRefresh() ? new Date(store.lastRefresh()).toISOString() : null,
      errors: envErrors,
    })
  }

  if (url.pathname === '/api/answer' && req.method === 'POST') return handleAnswer(req, res)

  if (url.pathname === '/api/state') {
    return send(res, 200, {
      models: MODELS,
      defaults: PARAM_DEFAULTS,
      limits: { ...PARAM_LIMITS, maxTokens: env.MAX_OUTPUT_TOKENS },
      archive: {
        total: store.size(),
        capacity: store.capacity,
        quota: store.quota,
        bySource: store.bySource(),
        lastRefresh: store.lastRefresh() ? new Date(store.lastRefresh()).toISOString() : null,
        refreshEveryMinutes: env.REFRESH_MIN_MINUTES,
      },
      sources: FEEDS.map((f) => ({ source: f.source, region: f.region })),
    })
  }

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
  server.listen(env.PORT, () => console.log(`день 5 слушает :${env.PORT}`))
}

export { env, server, store }
