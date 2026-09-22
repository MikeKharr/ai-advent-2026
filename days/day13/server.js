// День 13: машина состояний запуска на устройстве дня 11
// (ADR 2026-09-21-1747). День 11 при этом не меняется: у дня 13 свой каталог,
// свои cookie и свой агент `staged-agent`.
//
// Устройство дня 11 сохраняется целиком: день отвечает за публичный адрес,
// лимитер и cookie; память — правила, темы с фактами и переписка — живёт у
// агента; профиль открыт (ADR 2026-09-15-2024, п. 2 и «Последствия»).
//
// Новое против дня 11 — три вещи, и все три про деньги:
// 1. Сообщение резервирует `reviewRounds` слотов лимитера, а не один: круг
//    проверки сверх первого — ещё один платный ответ (ADR, п. 5). Лишние
//    возвращаются по завершении запуска.
// 2. Ручка паузы: обрыв работы и обмена с моделью на месте. Возобновление
//    после прерванного вызова берёт слот заново — вызов повторяется и
//    оплачивается как новый (ADR, п. 3).
// 3. Журнал этапов CSV отдаётся как есть: строки своего запуска, без текстов.

import { createHash, randomUUID } from 'node:crypto'
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SESSION_COOKIE = 'day13_sid'
const PROFILE_COOKIE = 'day13_pid'
/** Сколько помним, чей запуск: чтобы вернуть слот лимитера, если агент денег не потратил. */
const PENDING_TTL_MS = 10 * 60_000
/**
 * Предел кругов проверки — тот же, что у агента (ADR, п. 2): 1–3, умолчание 2.
 * День приводит число к этим границам сам, потому что резервирует по нему слоты
 * и по нему же велит агенту работать: оба числа обязаны быть одним числом.
 */
const REVIEW_ROUNDS = { min: 1, max: 3, default: 2 }

const reviewRoundsOf = (value) => {
  const n = Number(value)
  if (!Number.isInteger(n)) return REVIEW_ROUNDS.default
  return Math.min(REVIEW_ROUNDS.max, Math.max(REVIEW_ROUNDS.min, n))
}

/**
 * Предел кругов живёт ТОЛЬКО в настройках профиля — решение владельца.
 * Посетитель выставляет его один раз в окне настроек, и он действует на все
 * сообщения; поле в теле сообщения источником не является (см. handleAnswer).
 *
 * Чтение настроек — обращение к агенту, но не платное: модель оно не зовёт.
 * Поэтому оно и стоит до резерва слотов — резерв всё равно предшествует
 * единственному платному обращению, созданию запуска (I-4).
 */
async function readReviewRounds(profileId) {
  const { response, json } = await callAgent(`/v1/profiles/${profileId}`)
  if (response.status === 404) return { code: 'unknown_profile' }
  if (!response.ok) throw new Error(`агент ${response.status}`)
  // Настроек может не быть вовсе — тогда умолчание, как и у агента.
  return { rounds: reviewRoundsOf(json?.profile?.stagedSettings?.reviewRounds) }
}

const { env, errors: envErrors } = parseEnv()
for (const message of envErrors) console.error(`конфигурация: ${message}`)

const limiter = createLimiter(env)
/** @type {Map<string, { ip: string, at: number, reserved: number }>} runId → кто и сколько занял */
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

/** Тело запроса как объект или null: один разбор на все ручки записи. */
async function jsonBody(req) {
  try {
    const parsed = JSON.parse(await readBody(req))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
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

// Читаемое имя диалога. Наружу уходит и идентификатор — без него диалог не
// выбрать (ADR, п. 3), — но в разговоре о переписке участвует имя: оно
// выведено из идентификатора необратимо (ADR 2026-09-09-2134).
const ADJECTIVES = [
  'синий',
  'красный',
  'зелёный',
  'жёлтый',
  'белый',
  'чёрный',
  'быстрый',
  'тихий',
  'смелый',
  'дальний',
  'ранний',
  'поздний',
  'тёплый',
  'ясный',
  'острый',
  'мягкий',
  'лёгкий',
  'важный',
  'дикий',
  'вольный',
  'верный',
  'первый',
  'южный',
  'северный',
]
const NOUNS = [
  'кит',
  'сокол',
  'барс',
  'ёж',
  'лис',
  'бобр',
  'филин',
  'олень',
  'краб',
  'стриж',
  'заяц',
  'шмель',
  'окунь',
  'ворон',
  'тюлень',
  'сурок',
  'рысь',
  'аист',
  'марал',
  'нерпа',
  'кабан',
  'дрозд',
  'налим',
  'выдра',
]

function sessionName(sessionId) {
  const hash = createHash('sha256').update(sessionId).digest()
  const adjective = ADJECTIVES[hash[0] % ADJECTIVES.length]
  const noun = NOUNS[hash[1] % NOUNS.length]
  const number = hash[2] % 100
  return `${adjective}-${noun}-${number}`
}

/** Значение cookie по имени; чужая форма не принимается. */
function cookie(req, name) {
  const raw = req.headers.cookie
  if (typeof raw !== 'string') return null
  for (const part of raw.split(';')) {
    const at = part.indexOf('=')
    if (at === -1) continue
    if (part.slice(0, at).trim() !== name) continue
    const value = part.slice(at + 1).trim()
    return UUID.test(value) ? value : null
  }
  return null
}

const sessionFromCookie = (req) => cookie(req, SESSION_COOKIE)
const profileFromCookie = (req) => cookie(req, PROFILE_COOKIE)

/**
 * Cookie: `HttpOnly` — страница её не читает; `SameSite=Lax` — чужой сайт не
 * пошлёт её от вашего имени; `Path` — браузер шлёт её только на адреса этого
 * дня. Это не изоляция от соседних дней: они на том же origin. `maxAge` в
 * секундах; ноль стирает cookie.
 */
function setCookie(name, value, maxAge) {
  const parts = [
    `${name}=${value}`,
    'HttpOnly',
    'SameSite=Lax',
    `Path=${env.COOKIE_PATH}`,
    `Max-Age=${Math.round(maxAge)}`,
  ]
  if (env.COOKIE_SECURE) parts.push('Secure')
  return parts.join('; ')
}

const profileCookie = (id) =>
  setCookie(PROFILE_COOKIE, id, env.PROFILE_TTL_DAYS * 24 * 3600)
const sessionCookie = (id) => setCookie(SESSION_COOKIE, id, env.SESSION_TTL_HOURS * 3600)
// Стирание: пустое значение и нулевой срок. Диалог удалён или профиль сменён —
// прежний указатель больше ничего не адресует.
const dropSession = () => setCookie(SESSION_COOKIE, '', 0)
const dropProfile = () => setCookie(PROFILE_COOKIE, '', 0)

/** Несколько cookie одним ответом: заголовок повторяется, а не склеивается. */
const cookies = (...values) => (values.length > 0 ? { 'set-cookie': values } : {})

function sweepPending(now = Date.now()) {
  for (const [id, slot] of pending) if (now - slot.at > PENDING_TTL_MS) pending.delete(id)
}

function remember(runId, ip, reserved = 1) {
  const now = Date.now()
  sweepPending(now)
  pending.set(runId, { ip, at: now, reserved })
}

// Уборка по часам, а не только при новом запуске: иначе адрес последнего
// запуска лежал бы в памяти до перезапуска, если трафик прекратился, — а
// связка «запрос → адрес» живёт не дольше нужного (I-10). `unref` не даёт
// таймеру держать процесс живым.
if (process.env.NODE_ENV !== 'test') {
  setInterval(() => sweepPending(), 60_000).unref()
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

const postJson = (path, body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
  path,
})

/**
 * Записи профиля идут под своим окном лимитера (ADR, п. 8.3): модель они не
 * зовут, но меняют память, общую для всех посетителей. Слот занимается до
 * обращения к агенту, как и у запусков.
 */
function reserveWrite(req, res) {
  const slot = limiter.reserveWrite(clientIp(req))
  if (slot.ok) return true
  send(res, 429, { error: slot.message })
  return false
}

/** Профиль из cookie или отказ: все ручки профиля работают только с ним. */
function requireProfile(req, res) {
  const profileId = profileFromCookie(req)
  if (profileId) return profileId
  send(res, 409, { error: 'Профиль не выбран', code: 'no_profile' })
  return null
}

const AGENT_DOWN = 'Агент недоступен. Попробуйте позже.'

/** Диалоги профиля с читаемыми именами: идентификатор нужен, чтобы выбрать. */
const sessionsView = (list) =>
  (list ?? []).map((s) => ({
    id: s.id,
    name: sessionName(s.id),
    lastSeenAt: s.lastSeenAt,
    messages: s.messages,
    topic: s.topicId ? { id: s.topicId, title: s.topicTitle } : null,
  }))

/** Профиль со всей его памятью — то, что показывают шапка, настройки и монитор. */
const profileView = (profile, sessionCap) => ({
  id: profile.id,
  name: profile.name,
  // Настройки дня 13 хранятся отдельно от настроек дня 11 на том же профиле:
  // потолок этапа в 32 000 токенов, записанный в общие настройки, ломал день 11
  // — он отказывал первым же сообщением. Страница дня 13 видит только свои.
  settings: profile.stagedSettings ?? {},
  // У правила, как и у факта, стоит имя диалога-источника, а не его
  // идентификатор: монитор говорит, откуда правило взялось, и не раздаёт
  // указатель на чужую переписку (раскладка, п. 10.1).
  rules: (profile.rules ?? []).map((r) => ({
    key: r.key,
    value: r.value,
    updatedAt: r.updatedAt,
    source: r.sourceSessionId ? sessionName(r.sourceSessionId) : null,
  })),
  topics: profile.topics ?? [],
  sessions: sessionsView(profile.sessions),
  sessionCap,
})

/* ---------- профили ---------- */

/** Список профилей для экрана входа. Чтение вне лимитера, как в днях 7–10. */
async function handleProfiles(req, res) {
  try {
    const { response, json } = await callAgent('/v1/profiles')
    if (!response.ok) throw new Error(`агент ${response.status}`)
    return send(res, 200, {
      profiles: json.profiles ?? [],
      cap: json.cap ?? null,
      // Профиль из cookie: экран входа помечает его «в прошлый раз».
      currentId: profileFromCookie(req),
    })
  } catch (error) {
    console.error(`профили: ${error.message}`)
    return send(res, 502, { error: 'Список профилей не загрузился: агент не ответил.' })
  }
}

/**
 * Профиль из cookie со всей его памятью. Чтение, а не выбор: монитор памяти и
 * окно настроек перечитывают правила, темы и настройки после каждого ответа, и
 * ходить за этим через `/api/profile/select` значило бы тратить окно записей на
 * показ. Срок памяти чтение не продлевает — это граница агента (ADR, п. 2).
 */
async function handleProfileState(req, res) {
  const profileId = requireProfile(req, res)
  if (!profileId) return
  try {
    const { response, json } = await callAgent(`/v1/profiles/${profileId}`)
    if (response.status === 404) {
      return send(
        res,
        404,
        { error: 'Профиль не найден: выберите другой', code: 'unknown_profile' },
        cookies(dropProfile(), dropSession()),
      )
    }
    if (!response.ok) throw new Error(`агент ${response.status}`)
    return send(res, 200, { profile: profileView(json.profile, json.sessionCap ?? null) })
  } catch (error) {
    console.error(`профиль: ${error.message}`)
    return send(res, 502, { error: 'Память профиля не загрузилась: агент не ответил.' })
  }
}

async function handleCreateProfile(req, res) {
  if (!reserveWrite(req, res)) return
  const body = await jsonBody(req)
  if (!body) return send(res, 400, { error: 'тело не JSON' })
  try {
    const { response, json } = await callAgent('/v1/profiles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: body.name }),
    })
    // Отказы агента доходят его словами и его кодом: 409 — мест нет, 400 —
    // имя не годится. Страница показывает их по-разному.
    if (response.status === 409 || response.status === 400) {
      return send(res, response.status, {
        error: json?.message ?? 'Профиль не создан',
        code: json?.code,
      })
    }
    if (!response.ok) throw new Error(`агент ${response.status}`)
    // Cookie здесь не ставится: профиль выбирается отдельным действием
    // (ADR, п. 2) — так же, как выбирают существующий.
    return send(res, 200, { profile: { id: json.profile.id, name: json.profile.name } })
  } catch (error) {
    console.error(`создание профиля: ${error.message}`)
    return send(res, 502, { error: AGENT_DOWN })
  }
}

/**
 * Выбор профиля. Cookie диалога ставится, только если у профиля есть живой
 * диалог: выбор профиля сессию не создаёт (ADR, п. 2), иначе случайный клик
 * постороннего продлевал бы срок чужой памяти ровно в том случае, ради
 * которого это правило написано.
 */
async function handleSelectProfile(req, res) {
  if (!reserveWrite(req, res)) return
  const body = await jsonBody(req)
  if (!UUID.test(body?.id ?? '')) return send(res, 400, { error: 'Нужен идентификатор профиля' })
  try {
    const { response, json } = await callAgent(`/v1/profiles/${body.id}`)
    if (response.status === 404) {
      // Профиль мог уйти по сроку или быть удалённым любым посетителем:
      // указатель в браузере стирается вместе с отказом.
      return send(
        res,
        404,
        { error: 'Профиль не найден: выберите другой', code: 'unknown_profile' },
        cookies(dropProfile(), dropSession()),
      )
    }
    if (!response.ok) throw new Error(`агент ${response.status}`)
    const profile = json.profile
    const live = profile.lastSession ?? null
    return send(
      res,
      200,
      { profile: profileView(profile, json.sessionCap ?? null), sessionId: live },
      cookies(profileCookie(profile.id), live ? sessionCookie(live) : dropSession()),
    )
  } catch (error) {
    console.error(`выбор профиля: ${error.message}`)
    return send(res, 502, { error: AGENT_DOWN })
  }
}

/**
 * Удаление профиля со всей его памятью. Удалить можно любой, не только свой:
 * это названное последствие открытости (ADR, «Последствия»). Идентификатор
 * приходит телом, потому что удаляют со списка на экране входа.
 */
async function handleDeleteProfile(req, res) {
  if (!reserveWrite(req, res)) return
  const body = await jsonBody(req)
  if (!UUID.test(body?.id ?? '')) return send(res, 400, { error: 'Нужен идентификатор профиля' })
  try {
    const { response, json } = await callAgent(`/v1/profiles/${body.id}`, { method: 'DELETE' })
    if (response.status === 404 || response.status === 409) {
      return send(res, response.status, {
        error: json?.message ?? 'Профиль не найден',
        code: json?.code,
      })
    }
    if (!response.ok) throw new Error(`агент ${response.status}`)
    // Удалили тот, что в cookie, — указателей больше нет.
    const mine = profileFromCookie(req) === body.id
    return send(
      res,
      200,
      { removed: json.removed ?? null },
      mine ? cookies(dropProfile(), dropSession()) : {},
    )
  } catch (error) {
    console.error(`удаление профиля: ${error.message}`)
    return send(res, 502, { error: AGENT_DOWN })
  }
}

/** Настройки агента за профилем: проверяет их агент теми же разборщиками, что вход запуска. */
async function handleSettings(req, res) {
  if (!reserveWrite(req, res)) return
  const profileId = requireProfile(req, res)
  if (!profileId) return
  const body = await jsonBody(req)
  if (!body) return send(res, 400, { error: 'тело не JSON' })
  try {
    const { response, json } = await callAgent(
      `/v1/profiles/${profileId}/settings?agent=${encodeURIComponent(env.AGENT_ID)}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    )
    // Причину отказа пользователь должен видеть словами агента: он их проверял.
    if (response.status === 400 || response.status === 404) {
      return send(res, response.status, {
        error: json?.message ?? 'Настройки не сохранены',
        code: json?.code,
      })
    }
    if (!response.ok) throw new Error(`агент ${response.status}`)
    return send(res, 200, { settings: json.settings ?? {} })
  } catch (error) {
    console.error(`настройки: ${error.message}`)
    return send(res, 502, { error: AGENT_DOWN })
  }
}

/* ---------- диалоги профиля ---------- */

async function handleSessions(req, res) {
  const profileId = requireProfile(req, res)
  if (!profileId) return
  try {
    const { response, json } = await callAgent(`/v1/profiles/${profileId}/sessions`)
    if (response.status === 404) return send(res, 404, { error: 'Профиль не найден' })
    if (!response.ok) throw new Error(`агент ${response.status}`)
    return send(res, 200, {
      sessions: sessionsView(json.sessions),
      cap: json.cap ?? null,
      currentId: sessionFromCookie(req),
    })
  } catch (error) {
    console.error(`диалоги: ${error.message}`)
    return send(res, 502, { error: 'Список диалогов не загрузился: агент не ответил.' })
  }
}

/** Новый диалог с выбранной темой (ADR, п. 6.3). Потолок в 20 держит агент. */
async function handleCreateSession(req, res) {
  if (!reserveWrite(req, res)) return
  const profileId = requireProfile(req, res)
  if (!profileId) return
  const body = (await jsonBody(req)) ?? {}
  try {
    const { response, json } = await callAgent(`/v1/profiles/${profileId}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topicId: body.topicId ?? null }),
    })
    if (response.status === 409 || response.status === 400 || response.status === 404) {
      return send(res, response.status, {
        error: json?.message ?? 'Диалог не создан',
        code: json?.code,
      })
    }
    if (!response.ok) throw new Error(`агент ${response.status}`)
    return send(
      res,
      200,
      { sessionId: json.sessionId, name: sessionName(json.sessionId) },
      cookies(sessionCookie(json.sessionId)),
    )
  } catch (error) {
    console.error(`создание диалога: ${error.message}`)
    return send(res, 502, { error: AGENT_DOWN })
  }
}

/** Переключение на другой диалог профиля: принадлежность проверяет агент. */
async function handleSelectSession(req, res) {
  if (!reserveWrite(req, res)) return
  const profileId = requireProfile(req, res)
  if (!profileId) return
  const body = await jsonBody(req)
  if (!UUID.test(body?.id ?? '')) return send(res, 400, { error: 'Нужен идентификатор диалога' })
  try {
    const { response } = await callAgent(`/v1/sessions/${body.id}?profile=${profileId}`)
    // Диалог чужого профиля отвечает как несуществующий — и cookie не меняется.
    if (response.status === 404) return send(res, 404, { error: 'Диалог не найден' })
    if (!response.ok) throw new Error(`агент ${response.status}`)
    return send(
      res,
      200,
      { sessionId: body.id, name: sessionName(body.id) },
      cookies(sessionCookie(body.id)),
    )
  } catch (error) {
    console.error(`выбор диалога: ${error.message}`)
    return send(res, 502, { error: AGENT_DOWN })
  }
}

/**
 * Ответ на предложение новой темы и ручная смена темы — одна ручка
 * (ADR, п. 6.2.3). Вызовов модели здесь нет: ответ кнопкой действует сразу.
 */
async function handleTopic(req, res) {
  if (!reserveWrite(req, res)) return
  const profileId = requireProfile(req, res)
  if (!profileId) return
  const sessionId = sessionFromCookie(req)
  if (!sessionId) return send(res, 409, { error: 'Диалога ещё нет', code: 'no_session' })
  const body = await jsonBody(req)
  if (!body) return send(res, 400, { error: 'тело не JSON' })
  try {
    const { response, json } = await callAgent(
      `/v1/sessions/${sessionId}/topic?profile=${profileId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          body.decision !== undefined && body.decision !== null
            ? { decision: body.decision }
            : { topicId: body.topicId ?? null },
        ),
      },
    )
    if (!response.ok) {
      return send(res, response.status === 502 ? 502 : response.status, {
        error: json?.message ?? 'Ответ не принят',
        code: json?.code,
      })
    }
    return send(res, 200, {
      topic: json.topic ?? null,
      factsWritten: json.factsWritten ?? 0,
      warnings: json.warnings ?? [],
    })
  } catch (error) {
    console.error(`тема: ${error.message}`)
    return send(res, 502, { error: AGENT_DOWN })
  }
}

/** Факты темы — для монитора состояния памяти. Чтение вне лимитера. */
async function handleTopicFacts(req, res, topicId) {
  const profileId = requireProfile(req, res)
  if (!profileId) return
  try {
    const { response, json } = await callAgent(`/v1/profiles/${profileId}/topics/${topicId}`)
    if (response.status === 404) return send(res, 404, { error: 'Тема не найдена' })
    if (!response.ok) throw new Error(`агент ${response.status}`)
    // Имя диалога-источника, а не его идентификатор: у факта стоит дата
    // записи и диалог, и это не ссылка на издание (ADR, п. 5.2).
    const facts = (json.topic?.facts ?? []).map((f) => ({
      text: f.text,
      at: f.at,
      source: f.sourceSessionId ? sessionName(f.sourceSessionId) : null,
    }))
    return send(res, 200, { topic: { id: json.topic?.id, title: json.topic?.title, facts } })
  } catch (error) {
    console.error(`тема: ${error.message}`)
    return send(res, 502, { error: 'Факты темы не загрузились: агент не ответил.' })
  }
}

/* ---------- запуск ---------- */

/**
 * Запрос к агенту. Порядок здесь выверен по I-4 и важнее, чем кажется:
 *
 * 1. чтение настроек профиля — обращение к агенту, но не платное: модель оно
 *    не зовёт (см. `readReviewRounds`);
 * 2. **резерв слотов одним синхронным шагом** — по числу кругов из тех же
 *    настроек (ADR 2026-09-21-1747, п. 5): каждый круг сверх первого стоит
 *    ещё одного платного ответа и ещё одной платной проверки;
 * 3. создание диалога первым сообщением — тоже бесплатно;
 * 4. создание запуска — **единственное обращение, которое тратит деньги**.
 *
 * То есть резерв предшествует каждому платному вызову, хотя и не каждому
 * обращению к агенту. Прежняя формулировка «до любого обращения» была верна
 * до того, как предел кругов переехал в настройки профиля, и осталась здесь
 * неправдой — её и поправили.
 *
 * Неиспользованные слоты возвращаются по `end` потока событий: при удаче агент
 * называет число сделанных кругов сам, при падении число считается по
 * пройденным этапам (см. `proxyEvents`).
 */
async function handleAnswer(req, res) {
  const body = await jsonBody(req)
  if (!body) return send(res, 400, { error: 'тело должно быть объектом' })
  const profileId = requireProfile(req, res)
  if (!profileId) return

  // Сколько кругов разрешено — знают настройки профиля, и только они.
  // Читается ДО резерва: резервировать надо ровно столько, сколько будет
  // потрачено, а денег это чтение не стоит.
  let rounds
  try {
    const limit = await readReviewRounds(profileId)
    if (limit.code === 'unknown_profile') {
      return send(
        res,
        404,
        { error: 'Профиль не найден: выберите другой', code: 'unknown_profile' },
        cookies(dropProfile(), dropSession()),
      )
    }
    rounds = limit.rounds
  } catch (error) {
    // Идти дальше нельзя: посетитель выставил предел, и работать по другому
    // числу молча — ровно то расхождение, ради которого предел свели в одно
    // место. Денег при этом не потрачено, слот не занят.
    console.error(`предел кругов: ${error.message}`)
    return send(res, 502, { error: AGENT_DOWN })
  }

  const ip = clientIp(req)
  // С этого места и до создания запуска платных обращений нет: слот занят
  // одним синхронным шагом раньше единственного вызова, который тратит деньги.
  const slot = limiter.reserve(ip, rounds)
  if (!slot.ok) return send(res, 429, { error: slot.message })

  // Тема уходит в создание диалога, а не во вход запуска: у агента такого
  // поля нет, и карточка выбора темы над пустым чатом работает через него.
  //
  // `reviewRounds` из тела ОТБРАСЫВАЕТСЯ и ничего не решает: источник числа —
  // настройки профиля (выше). Агенту уходит ровно то число, под которое заняты
  // слоты, поэтому расхождение резерва и расхода невозможно по построению, а
  // не по внимательности: одно число из одного места проходит через обе точки.
  const { topicId, reviewRounds: fromBody, ...rest } = body
  void fromBody
  const input = { ...rest, reviewRounds: rounds }
  let sessionId = sessionFromCookie(req)
  const headers = {}
  if (!sessionId) {
    // Первое сообщение создаёт диалог профиля (ADR, п. 2). Потолок в 20
    // действует и здесь: 409 — и запуска не было.
    try {
      const { response, json } = await callAgent(`/v1/profiles/${profileId}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topicId: topicId ?? null }),
      })
      if (!response.ok) {
        limiter.release(ip, rounds)
        if (response.status === 409 || response.status === 404 || response.status === 400) {
          return send(res, response.status, {
            error: json?.message ?? 'Диалог не создан',
            code: json?.code,
          })
        }
        throw new Error(`агент ${response.status}`)
      }
      sessionId = json.sessionId
      headers['set-cookie'] = [sessionCookie(sessionId)]
    } catch (error) {
      limiter.release(ip, rounds)
      console.error(`диалог: ${error.message}`)
      return send(res, 502, { error: AGENT_DOWN })
    }
  }

  let result
  try {
    result = await callAgent('/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: env.AGENT_ID,
        // Профиль и диалог добавляет сервер: страница берёт их из cookie,
        // которую не видит.
        input: { ...input, profileId, sessionId },
      }),
    })
  } catch (error) {
    limiter.release(ip, rounds)
    console.error(`агент: ${error.name}: ${error.message}`)
    return send(res, 502, { error: AGENT_DOWN }, headers)
  }

  const { response, json } = result
  if (response.status === 202 && json?.runId) {
    remember(json.runId, ip, rounds)
    return send(res, 202, { runId: json.runId, reserved: rounds }, headers)
  }
  // До запуска дело не дошло — слоты возвращаются.
  limiter.release(ip, rounds)
  if (response.status === 400)
    return send(res, 400, { error: json?.message ?? 'Запрос отклонён' }, headers)
  console.error(`агент: ${response.status} ${json?.code ?? ''}`)
  return send(res, 502, { error: AGENT_DOWN }, headers)
}

/**
 * Параметры стратегии для чтения сессии. Контекст считает агент, и считает его
 * под тот режим, в котором страница сейчас стоит (ADR 2026-09-14-0447, п. 3),
 * поэтому они идут в запрос. Список закрытый: что не названо здесь, до агента
 * не доходит.
 */
const CONTEXT_QUERY = ['strategy', 'model', 'window', 'summarizeAt', 'contextTokens', 'factsTokens']

function contextQuery(req, profileId) {
  const from = new URL(req.url, 'http://local').searchParams
  const out = new URLSearchParams()
  for (const name of CONTEXT_QUERY) {
    const value = from.get(name)
    if (value !== null && value !== '') out.set(name, value)
  }
  // Диалог чужого профиля отвечает как несуществующий (ADR, п. 3).
  out.set('profile', profileId)
  return `?${out.toString()}`
}

/** Переписка диалога: чтение и удаление. Идентификаторы берутся из cookie. */
async function handleChat(req, res) {
  const profileId = requireProfile(req, res)
  if (!profileId) return
  const sessionId = sessionFromCookie(req)
  const clearing = req.method === 'DELETE'

  // Живого диалога нет: он рождается первым сообщением или кнопкой «Новый
  // диалог» (ADR, п. 2). Пустая переписка здесь — факт, а не заглушка.
  if (!sessionId) {
    return send(res, 200, {
      messages: [],
      totalTokens: null,
      summary: null,
      facts: null,
      context: null,
      head: null,
      topic: null,
      pendingTopic: null,
      run: null,
      session: null,
    })
  }

  try {
    if (clearing) {
      const { response } = await callAgent(`/v1/sessions/${sessionId}?profile=${profileId}`, {
        method: 'DELETE',
      })
      // Пока агент не подтвердил удаление, обещать его нельзя — и cookie
      // менять нельзя тоже: без прежнего идентификатора переписку будет
      // не удалить уже никогда.
      if (!response.ok) throw new Error(`агент ${response.status}`)
      // Новый диалог не заводится: он родится с первым сообщением или по
      // кнопке. Случайный идентификатор здесь не подошёл бы — диалога с ним
      // у профиля нет, и запуск отверг бы его (ADR, п. 2).
      return send(
        res,
        200,
        {
          messages: [],
          cleared: true,
          totalTokens: 0,
          summary: null,
          facts: null,
          context: null,
          head: null,
          topic: null,
          pendingTopic: null,
          run: null,
          session: null,
        },
        cookies(dropSession()),
      )
    }
    const { response, json } = await callAgent(
      `/v1/sessions/${sessionId}${contextQuery(req, profileId)}`,
    )
    // Диалог ушёл по сроку или профиль сменили: указатель стирается, и
    // страница показывает пустой лог, а не чужую переписку.
    if (response.status === 404) {
      return send(
        res,
        200,
        {
          messages: [],
          totalTokens: null,
          summary: null,
          facts: null,
          context: null,
          head: null,
          topic: null,
          pendingTopic: null,
          run: null,
          session: null,
          expired: true,
        },
        cookies(dropSession()),
      )
    }
    if (response.status === 503 && json?.code === 'no_sessions') {
      return send(res, 503, {
        error: 'Память диалога у агента сейчас недоступна: переписка не показана.',
      })
    }
    if (!response.ok) throw new Error(`агент ${response.status}`)
    return send(res, 200, {
      messages: json.messages ?? [],
      totalTokens: json.totalTokens ?? null,
      summary: json.summary ?? null,
      facts: json.facts ?? null,
      context: json.context ?? null,
      head: json.head ?? null,
      // Слои дня 11: активная тема и ожидающее ответа предложение новой.
      topic: json.topic ?? null,
      pendingTopic: json.pendingTopic ?? null,
      // Живой запуск диалога (ADR 2026-09-21-1747, п. 6): страница после
      // перезагрузки ставит полосу этапов и кнопку паузы в то же положение,
      // в котором стоит сервис. null — запуска нет.
      run: json.run ?? null,
      session: { name: sessionName(sessionId) },
    })
  } catch (error) {
    console.error(`переписка: ${error.message}`)
    return send(res, 502, {
      error: clearing
        ? 'Переписку удалить не удалось: агент не ответил. Она осталась на месте.'
        : 'Переписка недоступна: агент не ответил.',
    })
  }
}

/**
 * Переключение ветки: голова сессии переезжает на поздний лист поддерева
 * указанного сообщения (ADR 2026-09-14-0447, п. 8.3).
 */
async function handleHead(req, res) {
  const profileId = requireProfile(req, res)
  if (!profileId) return
  const sessionId = sessionFromCookie(req)
  if (!sessionId) return send(res, 409, { error: 'Диалога ещё нет', code: 'no_session' })
  const body = await jsonBody(req)
  if (!Number.isInteger(body?.messageId))
    return send(res, 400, { error: 'messageId должен быть целым числом' })

  try {
    const { response, json } = await callAgent(
      `/v1/sessions/${sessionId}/head?profile=${profileId}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId: body.messageId }),
      },
    )
    if (response.status === 404 || response.status === 409)
      return send(res, response.status, {
        error: json?.message ?? 'Ветку переключить не удалось',
        code: json?.code,
      })
    if (!response.ok) throw new Error(`агент ${response.status}`)
    return send(res, 200, { head: json?.head ?? null })
  } catch (error) {
    console.error(`ветка: ${error.message}`)
    return send(res, 502, { error: AGENT_DOWN })
  }
}

/**
 * Прокси потока событий: байты уходят в браузер как есть, а по дороге день
 * считает круги проверки и возвращает лишние слоты (ADR, п. 5).
 *
 * Слоты возвращаются ТОЛЬКО по доказанному завершению — по пришедшему `end`.
 * У него две ветки, и раньше работала одна: при удаче `end` несёт
 * `result.summary.rounds`, при падении — `error`, и числа кругов там нет
 * вовсе. Поэтому день считает круги сам, по событиям `state`, которые и так
 * проходят через него: круг, до которого запуск не дошёл, денег не стоил.
 *
 * Случаи, когда `end` не пришёл (вкладку закрыли, поток оборвался), слотов не
 * возвращают ЗДЕСЬ: запуск на стороне агента, возможно, идёт и продолжает
 * тратить деньги — доказательства завершения нет. Но и запись о занятых
 * слотах при обрыве не выбрасывается: закрытая вкладка возвращается другой
 * (сценарий владельца 2026-09-22), доподписывается к тому же запуску и
 * дочитывает его `end` — и тогда лишние слоты уходят назад. Прежнее удаление
 * записи на обрыве теряло их молча. Связка «запуск → адрес» всё равно живёт
 * не дольше `PENDING_TTL_MS`: её снимает уборка по часам (I-10).
 */
async function proxyEvents(req, res, runId) {
  const controller = new AbortController()
  req.on('close', () => {
    controller.abort()
  })

  let upstream
  try {
    upstream = await fetch(`${env.AGENT_URL}/v1/runs/${runId}/events`, {
      headers: agentHeaders,
      signal: controller.signal,
    })
  } catch (error) {
    if (controller.signal.aborted) return
    console.error(`агент: ${error.name}: ${error.message}`)
    return send(res, 502, { error: AGENT_DOWN })
  }
  if (!upstream.ok || !upstream.body) {
    return send(res, upstream.status === 404 ? 404 : 502, {
      error: upstream.status === 404 ? 'Запуск не найден' : AGENT_DOWN,
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
  /** Имя последнего события: у `data:` своего имени нет. */
  let kind = null
  /** До какого круга запуск дошёл по событиям `state`. 0 — не дошёл ни до какого. */
  let seenRounds = 0

  /** Сколько слотов вернуть по завершившемуся запуску. */
  const spentRounds = (end) => {
    // Агент посчитал круги сам — его число точнее наблюдения.
    const told = Number(end.result?.summary?.rounds ?? end.rounds)
    return Number.isInteger(told) && told >= 0 ? told : seenRounds
  }

  const inspect = (line) => {
    if (line.startsWith('event: ')) {
      kind = line.slice(7).trim()
      return
    }
    if (!line.startsWith('data: ')) return
    const name = kind
    kind = null

    if (name === 'event') {
      // Вход в этап называет круг: по нему видно, сколько кругов состоялось,
      // даже когда запуск упал и результата с числом кругов не будет.
      try {
        const event = JSON.parse(line.slice(6))
        const round = Number(event?.data?.round)
        if (event?.stage === 'state' && Number.isInteger(round) && round > seenRounds)
          seenRounds = round
      } catch {}
      return
    }
    if (name !== 'end') return

    try {
      const end = JSON.parse(line.slice(6))
      const slot = pending.get(runId)
      pending.delete(runId)
      if (!slot) return
      // Денег не потрачено вовсе — назад уходят все занятые слоты.
      if (end.error?.paidNothing) {
        limiter.release(slot.ip, slot.reserved)
        return
      }
      // Иначе занятым считается по слоту на состоявшийся круг — и при удаче,
      // и при падении. Круг, который не начинался, оплачен быть не мог, и
      // держать за него слот значит наказывать посетителя за нашу поломку.
      const extra = slot.reserved - Math.min(Math.max(spentRounds(end), 0), slot.reserved)
      if (extra > 0) limiter.release(slot.ip, extra)
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


/* ---------- пауза и журнал этапов ---------- */

/**
 * Пауза и возобновление одной ручкой (ADR 2026-09-21-1747, п. 3). Тело —
 * только `{ paused }`: какой запуск паузить, день узнаёт сам у агента по
 * диалогу из cookie. Страница идентификатор запуска не назначает.
 *
 * Возобновление после прерванного вызова стоит слота лимитера: этап входится
 * заново, и прерванный вызов повторяется как новое сообщение (ADR, п. 3).
 * Слот берётся ДО обращения к агенту (I-4) и возвращается, если возобновить
 * не удалось.
 *
 * Завершившийся запуск — НЕ отказ (требование владельца 2026-09-22: «не
 * должно быть такого, что при действии пользователя по продолжению запроса
 * система отказывает»). Пока посетитель ходил между окнами, запуск мог
 * доработать сам или отмениться по сроку паузы; нажатие «Продолжить» в этот
 * момент осмысленно, и ответ на него — объяснение состояния (`finished`), а
 * не 409. Чем кончился запуск, страница показывает переписка: ответ или
 * строка отмены уже лежат в ней.
 */
async function handlePause(req, res) {
  if (!reserveWrite(req, res)) return
  const profileId = requireProfile(req, res)
  if (!profileId) return
  const sessionId = sessionFromCookie(req)
  if (!sessionId) return send(res, 409, { error: 'Диалога ещё нет', code: 'no_session' })
  const body = await jsonBody(req)
  if (typeof body?.paused !== 'boolean')
    return send(res, 400, { error: 'paused должно быть true или false' })

  // Чей запуск и в каком он состоянии — знает агент. Диалог чужого профиля
  // отвечает как несуществующий, поэтому проверка принадлежности здесь же.
  let run = null
  try {
    const { response, json } = await callAgent(`/v1/sessions/${sessionId}?profile=${profileId}`)
    if (response.status === 404) return send(res, 404, { error: 'Запуск не найден' })
    if (!response.ok) throw new Error(`агент ${response.status}`)
    run = json.run ?? null
  } catch (error) {
    console.error(`пауза: ${error.message}`)
    return send(res, 502, { error: AGENT_DOWN })
  }
  /** Запуска уже нет или он терминальный: объяснение, а не отказ. */
  const finished = () =>
    send(res, 200, {
      finished: true,
      paused: false,
      runId: null,
      message: body.paused
        ? 'Запуск уже завершился — паузить нечего.'
        : 'Запуск уже завершился. Чем он кончился — смотрите в переписке.',
    })

  if (!run?.id) return finished()

  const ip = clientIp(req)
  // Повтор прерванного вызова — новый платный вызов, и слот под него берётся
  // до возобновления: нет слота — запуск остаётся на паузе.
  const needsSlot = body.paused === false && run.interruptedCall === true
  if (needsSlot) {
    const slot = limiter.reserve(ip, 1)
    if (!slot.ok) return send(res, 429, { error: slot.message })
  }

  try {
    const { response, json } = await callAgent(`/v1/runs/${run.id}/pause`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paused: body.paused, profileId, sessionId }),
    })
    if (!response.ok) {
      // Слот под повтор вызова возвращается при любом неуспехе: повтора не
      // было, платить не за что.
      if (needsSlot) limiter.release(ip, 1)
      // Запуск успел завершиться между чтением диалога и ручкой паузы —
      // гонка на секунды, и для посетителя это то же самое состояние.
      if (response.status === 409) return finished()
      if (response.status === 404)
        return send(res, 404, { error: json?.message ?? 'Запуск не найден', code: json?.code })
      throw new Error(`агент ${response.status}`)
    }
    return send(res, 200, { paused: json?.paused ?? body.paused, runId: run.id })
  } catch (error) {
    if (needsSlot) limiter.release(ip, 1)
    console.error(`пауза: ${error.message}`)
    return send(res, 502, { error: AGENT_DOWN })
  }
}

/**
 * Журнал этапов запуска: CSV агента уходит в браузер как есть (ADR, п. 7).
 * Строки чужого запуска агент не отдаёт — день лишь подставляет профиль и
 * диалог из cookie. Текстов в файле нет: ни промптов, ни реплик, ни правил.
 */
async function handleStageLog(req, res, runId) {
  const profileId = requireProfile(req, res)
  if (!profileId) return
  const sessionId = sessionFromCookie(req)
  if (!sessionId) return send(res, 404, { error: 'Журнал не найден' })
  try {
    const response = await fetch(
      `${env.AGENT_URL}/v1/runs/${runId}/log.csv?profile=${profileId}&session=${sessionId}`,
      { headers: agentHeaders, signal: AbortSignal.timeout(env.AGENT_TIMEOUT_MS) },
    )
    if (response.status === 404) return send(res, 404, { error: 'Журнал не найден' })
    if (!response.ok) throw new Error(`агент ${response.status}`)
    const csv = await response.text()
    // `filename` в заголовке НЕ ставится намеренно: он перебивает атрибут
    // `download` страницы, и в папке загрузок оказывались одинаковые
    // `day13-stages.csv` вместо имён со временем запуска. Имя назначает
    // страница; заголовок остаётся ради `attachment` — журнал не должен
    // открываться как страница.
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'cache-control': 'no-store',
      'content-disposition': 'attachment',
      'x-content-type-options': 'nosniff',
    })
    return res.end(csv)
  } catch (error) {
    console.error(`журнал ${runId}: ${error.message}`)
    return send(res, 502, { error: 'Журнал не загрузился: агент не ответил.' })
  }
}

/** Состояние для страницы: описание агента, модели, сроки хранения. */
async function handleState(req, res) {
  try {
    const [agentsRes, healthRes] = await Promise.all([
      callAgent('/v1/agents'),
      // Срок хранения переписки берётся у того, кто удаляет: переменная дня и
      // переменная агента независимы и расходятся молча.
      callAgent('/healthz'),
    ])
    const agent = agentsRes.json?.agents?.find((a) => a.id === env.AGENT_ID)
    if (!agent) throw new Error(`агент ${agentsRes.response.status}`)

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
      defaults: agent.defaults,
      limits: agent.limits,
      // Шесть этапов с их промптами и правилами (ADR, п. 1): текст промпта
      // страница берёт отсюда, а не из событий — в событиях текстов нет.
      stages: agent.stages ?? [],
      // Потолок этапа (ADR, п. 5) приходит числом, а не зашит в страницу:
      // окно настроек не должно обещать ни больше, ни меньше того, что примет
      // сервис. Он же — верхняя граница полей контекста и порога сжатия.
      stageContextTokens: agent.limits?.stageContextTokens ?? null,
      session: { ttlHours: healthRes.json?.sessionTtlHours ?? env.SESSION_TTL_HOURS },
      // Срок памяти профиля у агента в `/healthz` не объявлен, поэтому число
      // берётся из настройки дня: она обязана совпадать с PROFILE_TTL_DAYS
      // сервиса агентов (ADR 2026-09-15-2024, п. 2). Расхождение — правка
      // обеих переменных, а не страницы.
      profile: { ttlDays: env.PROFILE_TTL_DAYS },
    })
  } catch (error) {
    console.error(`состояние: ${error.message}`)
    return send(res, 503, { error: AGENT_DOWN })
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname

  if (path === '/healthz') {
    const ok = envErrors.length === 0
    return send(res, ok ? 200 : 503, { ok, errors: envErrors, limiter: limiter.stats() })
  }

  if (path === '/api/profiles' && req.method === 'GET') return handleProfiles(req, res)
  if (path === '/api/profile' && req.method === 'GET') return handleProfileState(req, res)
  if (path === '/api/profile' && req.method === 'POST') return handleCreateProfile(req, res)
  if (path === '/api/profile' && req.method === 'DELETE') return handleDeleteProfile(req, res)
  if (path === '/api/profile/select' && req.method === 'POST') return handleSelectProfile(req, res)
  if (path === '/api/settings' && req.method === 'PUT') return handleSettings(req, res)

  if (path === '/api/sessions' && req.method === 'GET') return handleSessions(req, res)
  if (path === '/api/session' && req.method === 'POST') return handleCreateSession(req, res)
  if (path === '/api/session/select' && req.method === 'POST') return handleSelectSession(req, res)
  if (path === '/api/session/topic' && req.method === 'POST') return handleTopic(req, res)

  const topic = path.match(/^\/api\/topic\/(\d{1,9})$/)
  if (topic && req.method === 'GET') return handleTopicFacts(req, res, topic[1])

  if (path === '/api/answer' && req.method === 'POST') return handleAnswer(req, res)
  if (path === '/api/run/pause' && req.method === 'POST') return handlePause(req, res)

  const stageLog = path.match(/^\/api\/runs\/([^/]+)\/log\.csv$/)
  if (stageLog && req.method === 'GET') {
    if (!RUN_ID.test(stageLog[1])) return send(res, 404, { error: 'Журнал не найден' })
    return handleStageLog(req, res, stageLog[1])
  }

  if (path === '/api/chat' && (req.method === 'GET' || req.method === 'DELETE'))
    return handleChat(req, res)

  if (path === '/api/chat/head' && req.method === 'PUT') return handleHead(req, res)

  const events = path.match(/^\/api\/runs\/([^/]+)\/events$/)
  if (events && req.method === 'GET') {
    if (!RUN_ID.test(events[1])) return send(res, 404, { error: 'Запуск не найден' })
    return proxyEvents(req, res, events[1])
  }

  if (path === '/api/state') return handleState(req, res)

  const rel = path === '/' ? 'index.html' : path.slice(1)
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
  server.listen(env.PORT, () => console.log(`день 13 слушает :${env.PORT}`))
}

export { env, server }
