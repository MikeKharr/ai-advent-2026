// HTTP-контракт сервиса агентов (ADR 2026-09-10-1000, п. 3). Один ключ,
// `AGENT_KEY`, на все `/v1/*`; `/healthz` открыт — его проверяет compose.

import { timingSafeEqual } from 'node:crypto'
import { isSessionId } from './params.js'
import { TERMINAL } from './runs.js'

const MAX_BODY = 64 * 1024
/** Комментарий в поток раз в столько: прокси не должен счесть соединение мёртвым за минуты ожидания модели. */
const SSE_PING_MS = 15_000
const RUN_ID = /^[0-9a-f-]{36}$/

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

/** Одно сообщение SSE: `event` и `data` одной строкой JSON. */
function sse(res, name, payload, id) {
  const lines = []
  if (id !== undefined) lines.push(`id: ${id}`)
  lines.push(`event: ${name}`, `data: ${JSON.stringify(payload)}`)
  res.write(`${lines.join('\n')}\n\n`)
}

export function createService({ agents, archive, runs, sessions = null, env, log = console.error }) {
  const startRun = (agent, run) => {
    // Запуск асинхронный: ответ 202 уходит до первого события. Исполнение
    // само не бросает, но страховка от ошибки в самой страховке — лог.
    agent.execute(run).catch((error) => log(`запуск ${run.id}: ${error.message}`))
  }

  async function createRun(req, res) {
    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch (error) {
      return send(res, 400, {
        ok: false,
        code: 'bad_json',
        message: error.message === 'тело больше 64 КБ' ? error.message : 'тело не JSON',
      })
    }
    const agent = typeof body?.agent === 'string' ? agents.get(body.agent) : null
    if (!agent)
      return send(res, 404, { ok: false, code: 'unknown_agent', message: 'Агент не найден' })
    const parsed = agent.parseInput(body.input)
    if (!parsed.ok) return send(res, 400, { ok: false, code: 'bad_input', message: parsed.message })

    const run = runs.create({ agent, input: parsed.input })
    // Сессия занимается синхронно, до ответа: иначе второе сообщение успеет
    // создать свой запуск, пока первый ещё не начал исполняться.
    agent.hold(parsed.input.sessionId ?? null)
    log(
      JSON.stringify({
        event: 'run',
        runId: run.id,
        agent: agent.id,
        model: parsed.input.params.model,
        session: Boolean(parsed.input.sessionId),
      }),
    )
    send(res, 202, { ok: true, runId: run.id })
    startRun(agent, run)
  }

  function streamEvents(req, res, runId) {
    if (!runs.get(runId)) return send(res, 404, { ok: false, code: 'unknown_run' })
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    res.flushHeaders?.()

    const ping = setInterval(() => res.write(': ping\n\n'), SSE_PING_MS)
    let unsubscribe = () => {}
    const close = () => {
      clearInterval(ping)
      unsubscribe()
      res.end()
    }
    req.on('close', () => {
      clearInterval(ping)
      unsubscribe()
    })

    unsubscribe = runs.subscribe(runId, (message) => {
      if (message.type === 'event') return sse(res, 'event', message.event, message.event.seq)
      sse(res, 'end', { status: message.status, result: message.result, error: message.error })
      close()
    })
  }

  return async function handler(req, res) {
    // Разбор адреса до всего остального и в try: битый Host бросает, а
    // необработанный отказ в async-обработчике валит процесс целиком.
    let path
    try {
      path = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`).pathname
    } catch {
      return send(res, 400, { ok: false, code: 'bad_request' })
    }

    if (path === '/healthz') {
      const state = archive.state()
      return send(res, 200, {
        ok: true,
        agents: [...agents.keys()],
        runs: runs.size(),
        archive: state.total,
        lastRefresh: state.lastRefresh,
        sessions: sessions ? sessions.stats() : null,
      })
    }

    if (!path.startsWith('/v1/')) return send(res, 404, { ok: false, code: 'not_found' })
    if (!safeEqual(bearer(req), env.AGENT_KEY)) {
      log(JSON.stringify({ event: 'refuse', path, code: 'unauthorized' }))
      return send(res, 401, { ok: false, code: 'unauthorized' })
    }

    if (path === '/v1/runs' && req.method === 'POST') return createRun(req, res)

    const runMatch = path.match(/^\/v1\/runs\/([^/]+)(\/events)?$/)
    if (runMatch && req.method === 'GET') {
      const [, runId, events] = runMatch
      if (!RUN_ID.test(runId)) return send(res, 404, { ok: false, code: 'unknown_run' })
      if (events) return streamEvents(req, res, runId)
      const snapshot = runs.snapshot(runId)
      if (!snapshot) return send(res, 404, { ok: false, code: 'unknown_run' })
      return send(res, 200, { ok: true, run: snapshot, finished: TERMINAL.has(snapshot.status) })
    }

    // Переписка сессии: читает и удаляет её только тот, кто знает
    // идентификатор из cookie (ADR 2026-09-12-0930).
    const sessionMatch = path.match(/^\/v1\/sessions\/([^/]+)$/)
    if (sessionMatch) {
      const sessionId = sessionMatch[1]
      if (!sessions) return send(res, 503, { ok: false, code: 'no_sessions' })
      if (!isSessionId(sessionId)) return send(res, 404, { ok: false, code: 'unknown_session' })
      if (req.method === 'GET') {
        return send(res, 200, { ok: true, messages: sessions.history(sessionId) })
      }
      if (req.method === 'DELETE') {
        return send(res, 200, { ok: true, removed: sessions.clear(sessionId) })
      }
      return send(res, 404, { ok: false, code: 'not_found' })
    }

    if (path === '/v1/agents' && req.method === 'GET') {
      const list = await Promise.all([...agents.values()].map((a) => a.describe()))
      return send(res, 200, { ok: true, agents: list })
    }

    const toolMatch = path.match(/^\/v1\/agents\/([^/]+)\/tools\/archive$/)
    if (toolMatch && req.method === 'GET') {
      const agent = agents.get(toolMatch[1])
      if (!agent) return send(res, 404, { ok: false, code: 'unknown_agent' })
      return send(res, 200, { ok: true, ...archive.state() })
    }

    return send(res, 404, { ok: false, code: 'not_found' })
  }
}
