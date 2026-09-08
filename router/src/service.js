// Сервисный слой: ключи приложений, лимиты, журнал (ADR, п. 10).
// Обработчик отделён от прослушивания порта, чтобы тесты поднимали его
// на случайном порту без сети наружу.

import { timingSafeEqual } from 'node:crypto'
import { costUsd, resetAt } from './ledger.js'

const MAX_BODY = 512 * 1024
const NOT_REACHED = new Set(['unreachable', 'busy', 'rejected'])
const STATUS = { all_failed: 503, aborted: 504 }

export function createService({
  config,
  router,
  ledger,
  env = process.env,
  now = Date.now,
  log = () => {},
}) {
  // Провайдеры — из реестра роутера (тот же шов), а не из статической
  // конфигурации: провайдер, которого учёт не знает, — ошибка, а не цена ноль.
  const providerOf = (id) => router.providers().find((p) => `${p.id}#${p.revision}` === id)
  const apps = config.apps.apps
  const adminKey = env[config.apps.admin.secretEnv]

  const authApp = (req) => {
    const token = bearer(req)
    if (!token) return null
    for (const app of apps) if (safeEqual(token, env[app.secretEnv])) return app
    return null
  }
  const isAdmin = (req) => safeEqual(bearer(req) ?? '', adminKey)

  function budgetLeft(app, at) {
    const s = ledger.spent(app.id, at)
    const l = app.limits
    return {
      tokens: l.dailyTokens ? Math.max(0, l.dailyTokens - s.tokens) : null,
      costUsd: l.dailyCostUsd ? Math.max(0, round(l.dailyCostUsd - s.costUsd)) : null,
      resetAt: resetAt(at),
    }
  }

  /**
   * Лимит сверяется с остатком заранее, по оценке запроса от роутера: вход
   * плюс потолок выхода на каждый возможный вызов, и то же в деньгах по
   * самой дорогой ставке среди способных провайдеров. Один большой запрос
   * не перекрывает суточный потолок кратно. Резервирования нет —
   * параллельные запросы одного приложения могут превысить лимит на размер
   * одного запроса.
   */
  function exhausted(app, at, need) {
    const s = ledger.spent(app.id, at)
    const l = app.limits
    if (l.dailyTokens && s.tokens + need.tokens > l.dailyTokens)
      return s.tokens >= l.dailyTokens
        ? `суточный лимит токенов ${l.dailyTokens} исчерпан`
        : `запрос (~${need.tokens} токенов) не помещается в остаток суточного лимита ${l.dailyTokens - s.tokens}`
    if (l.dailyCostUsd && s.costUsd + need.costUsd > l.dailyCostUsd)
      return s.costUsd >= l.dailyCostUsd
        ? `суточный лимит расхода $${l.dailyCostUsd} исчерпан`
        : `запрос не помещается в остаток суточного лимита расхода $${round(l.dailyCostUsd - s.costUsd)}`
    return null
  }

  async function handleRoute(req, res) {
    const app = authApp(req)
    // Неизвестный ключ — 401 до любого обращения к провайдеру.
    if (!app)
      return send(res, 401, {
        ok: false,
        code: 'unauthorized',
        message: 'неизвестный ключ приложения',
      })

    let body
    try {
      body = parseBody(await readBody(req))
    } catch (error) {
      return send(res, 400, {
        ok: false,
        code: 'bad_request',
        message: error.message,
      })
    }

    const taskClass = router.resolveClass(body.taskClass)
    if (!app.classes.includes(taskClass))
      return send(res, 403, {
        ok: false,
        code: 'class_not_allowed',
        message: `класс ${taskClass} не разрешён приложению ${app.id}`,
      })

    const at = now()
    const why = exhausted(app, at, router.estimateRequest(body))
    if (why) {
      log({ event: 'budget_exceeded', app: app.id, taskClass, reason: why })
      return send(res, 429, {
        ok: false,
        code: 'budget_exceeded',
        message: why,
        resetAt: resetAt(at),
        app: app.id,
      })
    }

    const result = await router.route(body)
    // Учитывается каждый вызов провайдера, включая неудачный. Без usage —
    // по оценке входа, с пометкой; кроме исходов, где вход до модели не дошёл
    // (транспорт, 429, 4xx): они в журнале с нулём.
    for (const attempt of result.attempts ?? []) {
      const p = providerOf(attempt.provider)
      if (!p) {
        log({ event: 'error', message: `учёт: провайдер ${attempt.provider} неизвестен реестру` })
        continue
      }
      const usage = attempt.usage ?? {
        inputTokens: NOT_REACHED.has(attempt.outcome) ? 0 : attempt.estimatedInputTokens,
        outputTokens: 0,
        webSearches: 0,
      }
      ledger.record({
        app: app.id,
        taskClass,
        provider: attempt.provider,
        model: p.model,
        thinking: result.thinking ?? null,
        webSearches: usage.webSearches ?? 0,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd: costUsd(p.price, usage),
        outcome: attempt.outcome,
        fallback: result.fallback?.from != null && attempt.provider !== result.fallback.from,
        estimated: attempt.usage == null,
      })
    }
    const status = result.ok ? 200 : (STATUS[result.code] ?? 422)
    return send(res, status, {
      ...result,
      app: app.id,
      budgetLeft: budgetLeft(app, now()),
    })
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://router')
    try {
      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true })
      if (req.method === 'POST' && url.pathname === '/v1/route') return await handleRoute(req, res)
      if (req.method === 'GET' && url.pathname === '/v1/spend') {
        if (!isAdmin(req)) return send(res, 401, { ok: false, code: 'unauthorized' })
        const report = ledger.report(now())
        for (const app of apps)
          report.apps[app.id] = {
            ...(report.apps[app.id] ?? { tokens: 0, costUsd: 0, calls: 0 }),
            limits: app.limits,
            left: budgetLeft(app, now()),
          }
        return send(res, 200, report)
      }
      if (req.method === 'GET' && url.pathname === '/v1/metrics') {
        if (!isAdmin(req)) return send(res, 401, { ok: false, code: 'unauthorized' })
        return send(res, 200, { providers: router.metrics() })
      }
      return send(res, 404, { ok: false, code: 'not_found' })
    } catch (error) {
      log({ event: 'error', path: url.pathname, message: error.message })
      return send(res, 500, { ok: false, code: 'internal' })
    }
  }
}

function parseBody(raw) {
  let body
  try {
    body = JSON.parse(raw)
  } catch {
    throw new Error('тело не JSON')
  }
  if (!body || typeof body !== 'object') throw new Error('тело должно быть объектом')
  if (typeof body.taskClass !== 'string') throw new Error('taskClass — строка')
  if (typeof body.input !== 'string' || body.input.length === 0)
    throw new Error('input — непустая строка')
  if (body.system !== undefined && typeof body.system !== 'string')
    throw new Error('system — строка')
  if (
    body.schema !== undefined &&
    (typeof body.schema !== 'object' || body.schema === null || Array.isArray(body.schema))
  )
    throw new Error('schema — объект')
  if (body.requires !== undefined && !Array.isArray(body.requires))
    throw new Error('requires — массив')
  if (body.dataClass !== undefined && typeof body.dataClass !== 'string')
    throw new Error('dataClass — строка')
  if (body.thinking !== undefined && typeof body.thinking !== 'string')
    throw new Error('thinking — строка')
  // Явный выбор модели вызывающим: id провайдера, с ревизией или без.
  if (body.provider !== undefined && (typeof body.provider !== 'string' || !body.provider))
    throw new Error('provider — непустая строка')
  if (
    body.answerTokens !== undefined &&
    !(Number.isInteger(body.answerTokens) && body.answerTokens > 0)
  )
    throw new Error('answerTokens — целое > 0')
  if (body.stop !== undefined) {
    if (!Array.isArray(body.stop) || body.stop.length > 4)
      throw new Error('stop — массив не длиннее 4')
    for (const x of body.stop)
      if (typeof x !== 'string' || x.length === 0 || x.length > 40)
        throw new Error('stop: строки от 1 до 40 символов')
  }
  if (body.budgetMs !== undefined && !(Number.isInteger(body.budgetMs) && body.budgetMs >= 1000))
    throw new Error('budgetMs — целое ≥ 1000')
  if (
    body.temperature !== undefined &&
    !(typeof body.temperature === 'number' && body.temperature >= 0 && body.temperature <= 2)
  )
    throw new Error('temperature — число 0…2')
  if (body.promptVersion !== undefined && typeof body.promptVersion !== 'string')
    throw new Error('promptVersion — строка')
  return body
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('тело больше 512 КБ'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function bearer(req) {
  const h = req.headers.authorization ?? ''
  return h.startsWith('Bearer ') ? h.slice(7) : null
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

function round(x) {
  return Math.round(x * 1e6) / 1e6
}
