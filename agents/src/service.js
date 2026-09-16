// HTTP-контракт сервиса агентов (ADR 2026-09-09-0854, п. 3). Один ключ,
// `AGENT_KEY`, на все `/v1/*`; `/healthz` открыт — его проверяет compose.

import { timingSafeEqual } from 'node:crypto'
import { LAYERED_AGENT_ID } from './layered.js'
import { effectiveContext } from './llm.js'
import {
  inputBudgetFor,
  isProfileId,
  isSessionId,
  LAYERED_MODELS,
  parseProfileName,
  parseSettings,
  STRATEGIES,
  TOPIC_FACT_CAP,
  WINDOW_LIMITS,
} from './params.js'
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

/**
 * Сводка для страницы: без накопленной цены — она уже в `totalTokens`.
 * `throughId` ставит блок сводки на место после перезагрузки.
 */
function summaryView(row) {
  if (!row) return null
  return {
    text: row.text,
    tokens: row.tokens,
    sourceTokens: row.sourceTokens,
    updatedAt: new Date(row.updatedAt).toISOString(),
    throughId: row.throughId,
    model: row.model,
    truncated: row.truncated,
  }
}

/**
 * Факты для страницы: текст показывается простым текстом, в ссылки не
 * превращается. `truncatedStreak` объясняет, почему факты перестали
 * обновляться (ADR 2026-09-14-0447, п. 7.3).
 */
function factsView(row) {
  if (!row) return null
  return {
    text: row.text,
    tokens: row.tokens,
    updatedAt: new Date(row.updatedAt).toISOString(),
    throughId: row.throughId,
    truncatedStreak: row.truncatedStreak,
  }
}

export function createService({ agents, archive, runs, sessions = null, env, log = console.error }) {
  /**
   * Счётчики сессий для /healthz: их отказ не должен валить проверку, но и
   * выглядеть как «памяти нет по настройке» тоже не должен — оператор идёт
   * сюда именно смотреть, живо ли хранилище.
   */
  const sessionStats = () => {
    if (!sessions) return null
    try {
      return sessions.stats()
    } catch (error) {
      log(`счётчики сессий: ${error.message}`)
      return 'недоступны: хранилище не отвечает'
    }
  }

  /** Целое из строки запроса или `fallback`: чужие значения счётчик не ломают. */
  const intParam = (params, name, fallback) => {
    const n = Number(params.get(name))
    return Number.isInteger(n) && n >= 0 ? n : fallback
  }

  /**
   * Счётчик для страницы. Стратегию, её параметры и модель передаёт страница:
   * без модели действующее окно на Groq и ноутбуке показывало бы больше,
   * чем помещается (ADR 2026-09-14-0447, п. 3).
   */
  const contextFor = (sessionId, params) => {
    const raw = params.get('strategy')
    const strategy = STRATEGIES.includes(raw) ? raw : null
    if (strategy === null) return sessions.context(sessionId)
    const contextTokens = intParam(params, 'contextTokens', 3000)
    const context = sessions.context(sessionId, {
      strategy,
      windowSize: intParam(params, 'window', WINDOW_LIMITS.default),
      effective: effectiveContext(contextTokens, inputBudgetFor(params.get('model'))),
    })
    if (strategy !== 'summary') return context
    // Сжатия при следующем сообщении страница обещать не может сама: порог
    // знает запуск, а размер будущей сводки — никто.
    const summarizeAt = intParam(params, 'summarizeAt', 0)
    return {
      ...context,
      willCompress: summarizeAt > 0 && context.freshTokens >= summarizeAt,
    }
  }

  /**
   * Принадлежит ли сессия профилю из строки запроса. Ручки дня 11 идут с
   * `?profile=`, и сессия чужого профиля отвечает как несуществующая — 404
   * (ADR 2026-09-15-2024, п. 3): номера и идентификаторы в общей базе
   * сквозные, и «не ваша» не должно отличаться от «нет такой». Без
   * параметра проверки нет — это путь дней 6–10, и их ответ прежний.
   */
  const foreignSession = (sessionId, params) => {
    const profileId = params.get('profile')
    if (profileId === null) return false
    if (!isProfileId(profileId)) return true
    return sessions.sessionProfile(sessionId) !== profileId
  }

  /** Идёт ли в этой сессии запуск: замок принадлежит исполнителю агента. */
  const busy = (sessionId) => [...agents.values()].some((a) => a.isBusy?.(sessionId))

  /**
   * Умолчания реестра того агента, чьи настройки правятся. Настройки — за
   * профилем, а профиль есть только у агента дня 11, поэтому спрашивается
   * его запись: иначе порог сводки сверялся бы с одним размером контекста,
   * а запуск шёл бы с другим (находка ревьюера, PR #151).
   */
  const settingsDefaults = () => agents.get(LAYERED_AGENT_ID)?.defaults ?? {}

  /** Тело запроса как JSON или отказ 400: один разбор на все ручки профиля. */
  const jsonBody = async (req, res) => {
    try {
      return { ok: true, body: JSON.parse(await readBody(req)) }
    } catch (error) {
      send(res, 400, {
        ok: false,
        code: 'bad_json',
        message: error.message === 'тело больше 64 КБ' ? error.message : 'тело не JSON',
      })
      return { ok: false }
    }
  }

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
    // Весь обработчик в try: он async, и любой необработанный отказ — от
    // битого Host до ошибки ввода-вывода в SQLite — валит процесс целиком,
    // а с ним день 6, который к сессиям отношения не имеет.
    try {
      return await route(req, res)
    } catch (error) {
      log(`обработчик: ${error.message}`)
      if (!res.headersSent) send(res, 500, { ok: false, code: 'internal' })
      else res.end()
    }
  }

  async function route(req, res) {
    let url
    try {
      url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
    } catch {
      return send(res, 400, { ok: false, code: 'bad_request' })
    }
    const path = url.pathname

    if (path === '/healthz') {
      const state = archive.state()
      return send(res, 200, {
        ok: true,
        agents: [...agents.keys()],
        runs: runs.size(),
        archive: state.total,
        lastRefresh: state.lastRefresh,
        sessions: sessionStats(),
        // Срок хранения отдаёт тот, кто его исполняет: у дня своя переменная
        // окружения, и обещать страницей чужое число нельзя.
        sessionTtlHours: sessions ? env.SESSION_TTL_HOURS : null,
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
    // идентификатор из cookie (ADR 2026-09-09-1906).
    const sessionMatch = path.match(/^\/v1\/sessions\/([^/]+)$/)
    if (sessionMatch) {
      const sessionId = sessionMatch[1]
      if (!sessions) return send(res, 503, { ok: false, code: 'no_sessions' })
      if (!isSessionId(sessionId)) return send(res, 404, { ok: false, code: 'unknown_session' })
      if (foreignSession(sessionId, url.searchParams)) {
        return send(res, 404, { ok: false, code: 'unknown_session' })
      }
      if (req.method === 'GET') {
        // Слои дня 11: чей диалог, какая тема активна и ждёт ли ответа
        // предложение новой (ADR 2026-09-15-2024, п. 8.3). У сессий дней
        // 6–10 все три поля — null, и их ответ прежний по существу.
        const state = sessions.sessionState(sessionId)
        return send(res, 200, {
          ok: true,
          profileId: state?.profileId ?? null,
          topic: state?.topicId ? { id: state.topicId, title: state.topicTitle } : null,
          pendingTopic: state?.pending
            ? { title: state.pending.title, facts: state.pending.facts.length }
            : null,
          // Для сессии дня 10 это все узлы дерева, у каждого `parentId`;
          // путь, навигатор и обзор страница строит сама (ADR, п. 8.3).
          messages: sessions.history(sessionId),
          // Сумму считает тот, у кого данные: страница видит только
          // загруженное и не знает, что удалено по сроку.
          totalTokens: sessions.totalTokens(sessionId),
          // Сводка разговора дня 9 или null (ADR 2026-09-11-1608).
          summary: summaryView(sessions.summary(sessionId)),
          // Факты разговора дня 10 или null (ADR 2026-09-14-0447, п. 7.3).
          facts: factsView(sessions.facts(sessionId)),
          // Голова текущей ветки; null у линейных сессий дней 6–9.
          head: sessions.head(sessionId),
          // Что накоплено к следующему сообщению. Без параметров — ответ
          // дней 7–9; со стратегией счётчик считается по ней и по
          // действующему окну этой модели (ADR 2026-09-14-0447, п. 3).
          context: contextFor(sessionId, url.searchParams),
        })
      }
      if (req.method === 'DELETE') {
        return send(res, 200, { ok: true, removed: sessions.clear(sessionId) })
      }
      return send(res, 404, { ok: false, code: 'not_found' })
    }

    // Переключение ветки: голова встаёт на самый поздний лист поддерева
    // указанного сообщения (ADR 2026-09-14-0447, п. 8.3).
    const headMatch = path.match(/^\/v1\/sessions\/([^/]+)\/head$/)
    if (headMatch && req.method === 'PUT') {
      const sessionId = headMatch[1]
      if (!sessions) return send(res, 503, { ok: false, code: 'no_sessions' })
      if (!isSessionId(sessionId)) return send(res, 404, { ok: false, code: 'unknown_session' })
      if (foreignSession(sessionId, url.searchParams)) {
        return send(res, 404, { ok: false, code: 'unknown_session' })
      }
      // Пока в сессии идёт запуск, голову двигать нельзя: ответ сел бы под
      // прежнего родителя. Замок тот же, что у второго сообщения.
      if ([...agents.values()].some((a) => a.isBusy?.(sessionId))) {
        return send(res, 409, {
          ok: false,
          code: 'busy',
          message: 'Дождитесь ответа на предыдущее сообщение',
        })
      }
      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return send(res, 400, { ok: false, code: 'bad_json', message: 'тело не JSON' })
      }
      const messageId = Number(body?.messageId)
      if (!Number.isInteger(messageId) || messageId <= 0) {
        return send(res, 400, { ok: false, code: 'bad_input', message: 'Нужен messageId' })
      }
      // Сообщение обязано принадлежать этой сессии: номера сквозные по общей
      // базе дней 6–10, и без проверки перебор соседних номеров открыл бы
      // чтение чужой переписки — и отправил бы её модели.
      if (!sessions.hasMessage(sessionId, messageId)) {
        return send(res, 404, {
          ok: false,
          code: 'unknown_message',
          message: 'Сообщение не найдено',
        })
      }
      const head = sessions.latestLeaf(sessionId, messageId)
      sessions.setHead(sessionId, head)
      return send(res, 200, { ok: true, head })
    }

    // Ответ на предложение новой темы и ручная смена темы — одна ручка
    // (ADR 2026-09-15-2024, п. 6.2.3). Вызовов модели здесь нет: ответ
    // кнопкой действует сразу и не стоит ничего.
    const topicMatch = path.match(/^\/v1\/sessions\/([^/]+)\/topic$/)
    if (topicMatch && req.method === 'POST') {
      const sessionId = topicMatch[1]
      if (!sessions) return send(res, 503, { ok: false, code: 'no_sessions' })
      if (!isSessionId(sessionId)) return send(res, 404, { ok: false, code: 'unknown_session' })
      const profileId = url.searchParams.get('profile')
      // Чужая сессия отвечает как несуществующая — та же граница, что у
      // чтения и удаления диалога профиля.
      if (!isProfileId(profileId) || sessions.sessionProfile(sessionId) !== profileId) {
        return send(res, 404, { ok: false, code: 'unknown_session' })
      }
      // Пока идёт запуск, тему двигать нельзя: пополнение того же запуска
      // решает её судьбу, и два решения разошлись бы.
      if (busy(sessionId)) {
        return send(res, 409, {
          ok: false,
          code: 'busy',
          message: 'Дождитесь ответа на предыдущее сообщение',
        })
      }
      const parsed = await jsonBody(req, res)
      if (!parsed.ok) return
      const body = parsed.body ?? {}
      let result
      if (body.decision !== undefined && body.decision !== null) {
        result = sessions.resolveTopic({ sessionId, profileId, decision: body.decision })
      } else if ('topicId' in body) {
        const raw = body.topicId
        const topicId = raw === null || raw === '' ? null : Number(raw)
        if (topicId !== null && (!Number.isInteger(topicId) || topicId <= 0)) {
          return send(res, 400, { ok: false, code: 'bad_input', message: 'Поле topicId — число' })
        }
        result = sessions.resolveTopic({ sessionId, profileId, topicId })
      } else {
        return send(res, 400, {
          ok: false,
          code: 'bad_input',
          message: 'Нужен decision (open или continue) или topicId',
        })
      }
      if (result.ok) {
        return send(res, 200, {
          ok: true,
          topic: result.topicId ? { id: result.topicId, title: result.topicTitle } : null,
          factsWritten: result.factsWritten,
          warnings: result.warnings,
        })
      }
      if (result.code === 'unknown_profile') {
        return send(res, 404, { ok: false, code: 'unknown_profile' })
      }
      if (result.code === 'unknown_session') {
        return send(res, 404, { ok: false, code: 'unknown_session' })
      }
      if (result.code === 'no_pending') {
        return send(res, 409, {
          ok: false,
          code: 'no_pending',
          message: 'Отвечать не на что: предложение темы не ждёт ответа',
        })
      }
      return send(res, 400, {
        ok: false,
        code: 'bad_input',
        message: result.code === 'unknown_topic' ? 'Тема не найдена' : 'Нужен open или continue',
      })
    }

    // --- Профили дня 11 (ADR 2026-09-15-2024, п. 8.3) ---------------------
    // Профиль открыт: любой посетитель видит все профили, читает и пополняет
    // любой и удаляет любой. Ключ здесь один на весь сервис — это граница
    // «день ↔ сервис», а не разграничение посетителей; его нет по решению
    // владельца 11 («с credentials пока работать не будем»).
    if (path.startsWith('/v1/profiles')) {
      if (!sessions) return send(res, 503, { ok: false, code: 'no_sessions' })

      if (path === '/v1/profiles' && req.method === 'GET') {
        return send(res, 200, { ok: true, profiles: sessions.profiles(), cap: env.PROFILE_CAP })
      }

      if (path === '/v1/profiles' && req.method === 'POST') {
        const parsed = await jsonBody(req, res)
        if (!parsed.ok) return
        const name = parseProfileName(parsed.body?.name)
        if (!name.ok) return send(res, 400, { ok: false, code: 'bad_input', message: name.message })
        const created = sessions.createProfile({ name: name.name })
        if (!created.ok) {
          return send(res, 409, {
            ok: false,
            code: 'profiles_full',
            message: `Мест нет: профилей не больше ${env.PROFILE_CAP}`,
          })
        }
        return send(res, 200, { ok: true, profile: created.profile })
      }

      const match = path.match(/^\/v1\/profiles\/([^/]+)(\/settings|\/sessions|\/topics\/\d+)?$/)
      if (!match) return send(res, 404, { ok: false, code: 'not_found' })
      const [, profileId, tail] = match
      if (!isProfileId(profileId)) return send(res, 404, { ok: false, code: 'unknown_profile' })

      if (!tail && req.method === 'GET') {
        // Чтение профиля срок его памяти не продлевает (ADR, п. 2): выбор
        // профиля посторонним не должен держать чужое досье ещё месяц.
        const profile = sessions.profile(profileId)
        if (!profile) return send(res, 404, { ok: false, code: 'unknown_profile' })
        return send(res, 200, { ok: true, profile, sessionCap: env.PROFILE_SESSION_CAP })
      }

      if (!tail && req.method === 'DELETE') {
        // Пока в диалоге профиля идёт запуск, удалять нельзя: запись ответа
        // воскресила бы строку удалённой сессии, и «удаление без следа»
        // держалось бы ровно до конца этого запуска (compliance, фаза 3).
        if (sessions.sessionsOf(profileId).some((s) => busy(s.id))) {
          return send(res, 409, {
            ok: false,
            code: 'busy',
            message: 'В профиле идёт запуск — дождитесь ответа',
          })
        }
        const removed = sessions.deleteProfile(profileId)
        if (!removed) return send(res, 404, { ok: false, code: 'unknown_profile' })
        log(JSON.stringify({ event: 'profile_deleted', removed }))
        return send(res, 200, { ok: true, removed })
      }

      if (tail === '/settings' && req.method === 'PUT') {
        const parsed = await jsonBody(req, res)
        if (!parsed.ok) return
        // Те же разборщики, что у входа запуска: значение, годное в
        // настройках, обязано быть годным и в запуске.
        // Список — тот же, что у входа запуска дня 11: настройки этой ручки
        // принадлежат агенту дня 11, и модель, годная в запуске, обязана быть
        // годной в настройках (ADR 2026-09-16-1038).
        const settings = parseSettings(parsed.body, settingsDefaults(), LAYERED_MODELS)
        if (!settings.ok) {
          return send(res, 400, { ok: false, code: 'bad_input', message: settings.message })
        }
        if (!sessions.saveSettings({ profileId, settings: settings.settings })) {
          return send(res, 404, { ok: false, code: 'unknown_profile' })
        }
        return send(res, 200, { ok: true, settings: settings.settings })
      }

      // Факты темы — для монитора состояния памяти (ADR, п. 8.3). Тема
      // чужого профиля отвечает как несуществующая.
      if (tail?.startsWith('/topics/') && req.method === 'GET') {
        if (!sessions.profile(profileId)) {
          return send(res, 404, { ok: false, code: 'unknown_profile' })
        }
        const topicId = Number(tail.slice('/topics/'.length))
        const topic = sessions.topicOf(profileId, topicId)
        if (!topic) return send(res, 404, { ok: false, code: 'unknown_topic' })
        return send(res, 200, {
          ok: true,
          topic: {
            ...topic,
            // Монитору отдаётся весь потолок темы (ADR, п. 6.1).
            facts: sessions.topicFactsOf(topicId, TOPIC_FACT_CAP).map((fact) => ({
              text: fact.text,
              at: new Date(fact.at).toISOString(),
              sourceSessionId: fact.sourceSessionId,
            })),
          },
        })
      }

      if (tail === '/sessions' && req.method === 'GET') {
        if (!sessions.profile(profileId)) {
          return send(res, 404, { ok: false, code: 'unknown_profile' })
        }
        return send(res, 200, {
          ok: true,
          sessions: sessions.sessionsOf(profileId),
          cap: env.PROFILE_SESSION_CAP,
        })
      }

      if (tail === '/sessions' && req.method === 'POST') {
        const parsed = await jsonBody(req, res)
        if (!parsed.ok) return
        const raw = parsed.body?.topicId
        const topicId = raw === undefined || raw === null || raw === '' ? null : Number(raw)
        if (topicId !== null && (!Number.isInteger(topicId) || topicId <= 0)) {
          return send(res, 400, { ok: false, code: 'bad_input', message: 'Поле topicId — число' })
        }
        const created = sessions.createSession({ profileId, topicId })
        if (created.ok) return send(res, 200, { ok: true, sessionId: created.id, topicId })
        if (created.code === 'no_profile') {
          return send(res, 404, { ok: false, code: 'unknown_profile' })
        }
        if (created.code === 'unknown_topic') {
          return send(res, 400, { ok: false, code: 'bad_input', message: 'Тема не найдена' })
        }
        return send(res, 409, {
          ok: false,
          code: 'sessions_full',
          message: `Диалогов не больше ${env.PROFILE_SESSION_CAP}: закройте лишние`,
        })
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
      // Агент без архива о нём и не отвечает: у дня 11 инструментов нет.
      if (!agent || !(agent.tools ?? []).includes('archive')) {
        return send(res, 404, { ok: false, code: 'unknown_agent' })
      }
      return send(res, 200, { ok: true, ...archive.state() })
    }

    return send(res, 404, { ok: false, code: 'not_found' })
  }
}
