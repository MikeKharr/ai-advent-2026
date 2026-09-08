// Сервисный слой: ключи приложений, лимиты, журнал (ADR, п. 10).
// Обработчик отделён от прослушивания порта, чтобы тесты поднимали его
// на случайном порту без сети наружу.

import { timingSafeEqual } from 'node:crypto'
import { costUsd, resetAt } from './ledger.js'

const MAX_BODY = 512 * 1024

export function createService({
  config,
  router,
  ledger,
  env = process.env,
  now = Date.now,
  log = () => {},
}) {
  const providers = new Map(config.providers.map((p) => [`${p.id}#${p.revision ?? 1}`, p]))
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

  function exhausted(app, at) {
    const s = ledger.spent(app.id, at)
    const l = app.limits
    if (l.dailyTokens && s.tokens >= l.dailyTokens)
      return `суточный лимит токенов ${l.dailyTokens} исчерпан`
    if (l.dailyCostUsd && s.costUsd >= l.dailyCostUsd)
      return `суточный лимит расхода $${l.dailyCostUsd} исчерпан`
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
      return send(res, 400, { ok: false, code: 'bad_request', message: error.message })
    }

    const taskClass = router.resolveClass(body.taskClass)
    if (!app.classes.includes(taskClass))
      return send(res, 403, {
        ok: false,
        code: 'class_not_allowed',
        message: `класс ${taskClass} не разрешён приложению ${app.id}`,
      })

    const at = now()
    const why = exhausted(app, at)
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
    // Учитывается каждый вызов провайдера, включая неудачный фолбэк:
    // токены потрачены независимо от исхода.
    for (const attempt of result.attempts ?? []) {
      if (!attempt.usage) continue
      const p = providers.get(attempt.provider)
      ledger.record({
        app: app.id,
        taskClass,
        provider: attempt.provider,
        model: p?.model ?? null,
        inputTokens: attempt.usage.inputTokens,
        outputTokens: attempt.usage.outputTokens,
        costUsd: costUsd(p?.price, attempt.usage),
        outcome: attempt.outcome,
        fallback: result.fallback?.from != null && attempt.provider !== result.fallback.from,
      })
    }
    const status = result.ok ? 200 : result.code === 'all_failed' ? 503 : 422
    return send(res, status, { ...result, app: app.id, budgetLeft: budgetLeft(app, now()) })
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
  if (body.schema !== undefined && (typeof body.schema !== 'object' || body.schema === null))
    throw new Error('schema — объект')
  if (body.requires !== undefined && !Array.isArray(body.requires))
    throw new Error('requires — массив')
  if (body.dataClass !== undefined && typeof body.dataClass !== 'string')
    throw new Error('dataClass — строка')
  if (body.thinking !== undefined && typeof body.thinking !== 'string')
    throw new Error('thinking — строка')
  if (body.budgetMs !== undefined && !(Number.isInteger(body.budgetMs) && body.budgetMs > 0))
    throw new Error('budgetMs — целое > 0')
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
