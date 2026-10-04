// День 22: один вопрос о проекте двумя путями — по найденным фрагментам
// репозитория и по памяти модели (ADR 2026-10-04-0735). Сервер дня — ПУЛЬТ:
// статика, создание запуска и сквозной поток его событий, и всё.
//
// Поиск сервер дня НЕ ВЫПОЛНЯЕТ и о `rag` ничего не знает: `project.search`
// зовёт агент `rag-agent` внутри сервиса агентов по MCP под ключом RAG_KEY
// (ADR, п. 1). У этого процесса такого ключа нет вовсе — потерять его здесь
// нечем, и это сильнее любой проверки.
//
// Ключ AGENT_KEY держит этот процесс. Страница его не знает, не получает и не
// показывает (I-1). Запуск стоит денег, поэтому слот берётся ДО обращения к
// сервису агентов (I-4) и суточный потолок проверяется первым.
//
// Окно объявляет ТАБЛИЦА МАРШРУТОВ, а не обработчик (ADR 2026-09-29-1600):
// слот занимает `dispatch` до вызова обработчика, ручка без поля `limit` не
// даёт процессу запуститься, а исключения лежат в той же таблице и обязаны
// назвать `why`.
//
// Сессий, cookie и переписки у дня нет намеренно (ADR, п. 1): задание про один
// вопрос, не про диалог. Поэтому ручек `/api/chat` здесь нет, и ручки записи
// нет вовсе.
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import { dirname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from './env.js'
import { createLimiter } from './limits.js'

const here = dirname(fileURLToPath(import.meta.url))
const PUBLIC = join(here, 'public')
const MAX_BODY = 16 * 1024
const AGENT_DOWN = 'Сервис агентов недоступен. Попробуйте позже.'
/** Идентификатор запуска приходит с нашей же страницы, но проверяется как чужой ввод. */
const RUN_ID = /^[a-zA-Z0-9-]{1,64}$/

/**
 * Потолок вопроса. То же число, что у `MAX_QUESTION_CHARS` агента
 * (`agents/src/rag-agent.js`) и у `maxlength` поля страницы: разметка —
 * удобство, этот предел — отказ, а последнее слово всё равно за агентом.
 */
const MAX_QUESTION = 600

/**
 * Режимы запуска. Копия `MODES` агента, и список здесь нужен не ради второй
 * проверки, а чтобы чужое значение не уезжало в сервис: умолчания у режима нет
 * ни тут, ни там — запуск без названного режима означал бы сравнение
 * неизвестно с чем.
 */
const MODES = ['rag', 'norag']

const { env, errors: envErrors } = parseEnv()
for (const message of envErrors) console.error(`конфигурация: ${message}`)

const limiter = createLimiter(env)
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
        reject(new Error('тело больше 16 КБ'))
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
 * поэтому берётся последний элемент, а не первый: первый подделывается
 * заголовком запроса, и тогда окно на адрес обходится сменой значения.
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

/** Запрос к сервису агентов. Ключ подставляется здесь и никуда больше не уходит (I-1). */
async function callAgent(path, options = {}) {
  const response = await fetch(`${env.AGENT_URL}${path}`, {
    ...options,
    headers: { ...agentHeaders, ...(options.headers ?? {}) },
    signal: AbortSignal.timeout(env.AGENT_TIMEOUT_MS),
  })
  const json = await response.json().catch(() => null)
  return { response, json }
}

/**
 * Запуск: один вопрос и один режим. Слот окна `run` к этому месту УЖЕ занят
 * диспетчером (ADR 2026-09-29-1600, п. 2): обработчик лимитера не трогает, и
 * порядок «сначала слот, потом сервис» (I-4) держит таблица, а не
 * внимательность автора ручки.
 *
 * Цена этого порядка названа прямо: слот тратится до разбора тела, поэтому
 * пустой вопрос стоит слота. Учёт слота (возврат на 4xx) ADR оставил
 * нерешённым и сюда не трогается.
 */
async function handleRun(req, res) {
  let ask
  try {
    ask = JSON.parse(await readBody(req))
  } catch (error) {
    return send(res, 400, {
      error: error.message === 'тело больше 16 КБ' ? error.message : 'тело не JSON',
    })
  }
  const question = ask && typeof ask.question === 'string' ? ask.question.trim() : ''
  if (!question) return send(res, 400, { error: 'Вопрос пустой.' })
  if (question.length > MAX_QUESTION)
    return send(res, 400, { error: `Вопрос длиннее ${MAX_QUESTION} знаков.` })
  const mode = ask.mode
  if (!MODES.includes(mode)) return send(res, 400, { error: 'Режим не назван.' })

  let response
  let json
  try {
    ;({ response, json } = await callAgent('/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: env.AGENT_ID, input: { question, mode } }),
    }))
  } catch (error) {
    console.error(`агент: ${error.name}`)
    return send(res, 502, { error: AGENT_DOWN })
  }
  if (response.status === 202 && json?.runId) return send(res, 202, { runId: json.runId })
  if (response.status === 400) return send(res, 400, { error: json?.message ?? 'Запрос отклонён.' })
  console.error(`агент: ${response.status} ${json?.code ?? ''}`)
  return send(res, 502, { error: AGENT_DOWN })
}

/**
 * Поток событий запуска — насквозь, байт в байт (образец:
 * days/day20/server.js, proxyEvents). День ничего не разбирает и ничего не
 * переписывает: предмет показа — найденные фрагменты и сырые тела JSON-RPC
 * внутри событий стадии `rpc` (решение владельца 2026-10-04, развилка
 * раскладки В3), и любая переупаковка сделала бы предметом показа нашу
 * обёртку.
 *
 * Ключ AGENT_KEY подставляется здесь и никуда больше не уходит (I-1).
 * Адрес посетителя в потоке не участвует и нигде не запоминается (I-10).
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
    console.error(`агент: ${error.name}`)
    return send(res, 502, { error: AGENT_DOWN })
  }
  if (!upstream.ok || !upstream.body)
    return send(res, upstream.status === 404 ? 404 : 502, {
      error: upstream.status === 404 ? 'Запуск не найден' : AGENT_DOWN,
    })

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  })
  res.flushHeaders?.()

  const reader = upstream.body.getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (!res.write(Buffer.from(value))) await new Promise((r) => res.once('drain', r))
    }
  } catch (error) {
    if (!controller.signal.aborted) console.error(`поток событий: ${error.name}`)
  } finally {
    res.end()
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  // Без этой строки страница не работает вовсе: модуль, отданный как
  // application/octet-stream, браузер не исполняет.
  '.js': 'text/javascript; charset=utf-8',
  // Итоги прогона десяти вопросов (ADR, п. 6) лежат рядом файлом и читаются
  // страницей как обычная статика. Файл появляется прогоном (PR 3); пока его
  // нет, страница говорит об этом словами, а не пустотой.
  '.json': 'application/json; charset=utf-8',
}

/**
 * Путь запроса → путь файла внутри `public`, либо `null`, если он выводит за
 * пределы каталога.
 *
 * ВЫНЕСЕНО РАДИ ДЕРЖАТЕЛЯ, и причина названа замером. Через HTTP эта проверка
 * недостижима: `new URL` нормализует `..` ДО неё — `/../server.js` приходит в
 * `dispatch` как `/server.js`, `/public/../../x.js` как `/x.js` (проверено
 * исполнением, `node -e` с `new URL`). Поэтому мутация «убрать проверку»
 * оставляла прогон зелёным даже с сырым сокетом, и тест через HTTP держателем
 * не был (находка `reviewer` к PR #303, уточнена этим замером). Отдельная
 * функция даёт проверке держателя: тест зовёт её с путём, который
 * нормализатор URL уже не тронет.
 *
 * Чем проверка остаётся полезной при недостижимости снаружи: она держит
 * границу для всякого будущего вызова с путём не из `new URL` — например, если
 * однажды появится percent-декодирование (сегодня его нет, и `/..%2fserver.js`
 * остаётся литералом имени файла).
 */
export function resolveStatic(pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1)
  const file = normalize(join(PUBLIC, rel))
  if (file !== PUBLIC && !file.startsWith(PUBLIC + sep)) return null
  return file
}

async function serveStatic(url, res) {
  const file = resolveStatic(url.pathname)
  if (file === null) {
    res.writeHead(403)
    return res.end()
  }
  try {
    const data = await readFile(file)
    const ext = file.slice(file.lastIndexOf('.'))
    res.writeHead(200, { 'content-type': TYPES[ext] ?? 'application/octet-stream' })
    res.end(data)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('не найдено')
  }
}

/** Проба живости: состояние конфигурации и счётчики окон, без ключа (I-1). */
function handleHealth(req, res) {
  const ok = envErrors.length === 0
  return send(res, ok ? 200 : 503, { ok, errors: envErrors, limiter: limiter.stats() })
}

/** Поток событий запуска. Идентификатор из URL проверяется как чужой ввод. */
function handleEvents(req, res, ctx) {
  if (!RUN_ID.test(ctx.params[0])) return send(res, 404, { error: 'Запуск не найден' })
  return proxyEvents(req, res, ctx.params[0])
}

/**
 * ТАБЛИЦА РУЧЕК ДНЯ — единственный вход в серверную логику
 * (ADR 2026-09-29-1600, п. 1). Поле `limit` обязательно у каждой записи:
 *
 *   run   — запуск вопроса, стоит денег: `limiter.reserve`;
 *   read  — читает: `limiter.reserveRead`;
 *   open  — вне окон, и запись ОБЯЗАНА сказать `why`, почему.
 *
 * Значения `write` здесь НЕТ, и это не копия с пропуском: ручки, которая
 * правила бы общую базу сервиса, у дня нет (сессий и переписки нет вовсе).
 * Появится такая ручка — `checkRoutes` не даст модулю загрузиться, пока окно
 * для неё не заведут осознанно.
 *
 * Ручка без `limit`, с неизвестным значением или `open` без `why` не даёт
 * модулю загрузиться (`checkRoutes` ниже) — забыть окно нельзя, можно только
 * назвать его вслух. Весь список исключений добывается одной строкой:
 * `grep "limit: 'open'" days/day22/server.js`.
 */
const routes = [
  {
    method: 'GET',
    path: '/healthz',
    limit: 'open',
    why: 'проба живости контейнера: до сервиса агентов не ходит и денег не стоит, а окно на ней перезапускало бы здоровый контейнер',
    handler: handleHealth,
  },
  { method: 'POST', path: '/api/runs', limit: 'run', handler: handleRun },
  { method: 'GET', path: /^\/api\/runs\/([^/]+)\/events$/, limit: 'read', handler: handleEvents },
]

const LIMITS = new Set(['run', 'read', 'open'])

/**
 * Проверка таблицы при загрузке модуля: умолчание безопасное ОТКАЗОМ СТАРТА,
 * а не пропуском. Красным это становится не в одном тесте, а во всех сразу —
 * сервер просто не поднимается (ADR 2026-09-29-1600, «Держатель», слой 1).
 */
function checkRoutes(list) {
  for (const route of list) {
    const name = `${route.method} ${route.path}`
    if (!LIMITS.has(route.limit))
      throw new Error(`ручка ${name}: поле limit обязано быть run|read|open, получено ${JSON.stringify(route.limit)}`)
    if (route.limit === 'open' && !(typeof route.why === 'string' && route.why.trim() !== ''))
      throw new Error(`ручка ${name}: limit 'open' обязан назвать why — почему ручка вне окон`)
    if (typeof route.handler !== 'function') throw new Error(`ручка ${name}: нет обработчика`)
  }
  return list
}

checkRoutes(routes)

/** Окно → чем занимается слот. `open` сюда не попадает по построению. */
const RESERVE = {
  run: (ip) => limiter.reserve(ip),
  read: (ip) => limiter.reserveRead(ip),
}

function match(list, method, pathname) {
  for (const route of list) {
    if (route.method !== method) continue
    if (typeof route.path === 'string') {
      if (route.path === pathname) return { route, params: [] }
      continue
    }
    const hit = pathname.match(route.path)
    if (hit) return { route, params: hit.slice(1) }
  }
  return null
}

/**
 * Единственный вход. Слот занимается ЗДЕСЬ, до вызова обработчика (I-4):
 * порядок «сначала окно, потом работа» виден чтением сверху вниз и не зависит
 * от того, вспомнил ли о нём автор ручки. Отказ отвечает словами лимитера, и
 * обработчик не вызывается вовсе — до сервиса агентов ничего не доходит.
 */
async function dispatch(req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
  const found = match(routes, req.method, url.pathname)
  // Не ручка — статика: всё, чего нет в таблице, отвечает файлом или 404.
  if (!found) return serveStatic(url, res)

  const ip = clientIp(req)
  let slot = null
  if (found.route.limit !== 'open') {
    slot = RESERVE[found.route.limit](ip)
    if (!slot.ok)
      return send(
        res,
        429,
        { error: slot.message, retryAfterSec: slot.retryAfterSec ?? null },
        slot.retryAfterSec ? { 'retry-after': String(slot.retryAfterSec) } : {},
      )
  }
  return found.route.handler(req, res, { ip, slot, params: found.params })
}

const server = http.createServer(dispatch)

if (process.env.NODE_ENV !== 'test') {
  server.listen(env.PORT, () => console.log(`день 22 слушает :${env.PORT}`))
}

export { checkRoutes, env, MAX_QUESTION, MODES, routes, server }
