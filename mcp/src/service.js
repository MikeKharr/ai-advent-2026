// HTTP-контракт службы MCP (ADR 2026-09-23-1227, пп. 3–4). Код отказа —
// по ADR `2026-09-23-1844`: он заменяет п. 4 прежней записи в части «401 до
// чтения тела», остальные пункты п. 4 (ключ, лимитер, `MCP_KEY`) в силе.
//
// Порядок в `handler` читается сверху вниз и таков намеренно:
//   1) /healthz — открыт, его проверяет выкатка; подробности за ключом;
//   2) ключ — всегда и до чтения тела: тело неавторизованного запроса не
//      читается, а отказ считается уже после сверки и только для журнала;
//   3) GET и DELETE — 405: без сессий поднимать поток нечему;
//   4) тело с потолком;
//   5) лимитер — ДО передачи `tools/call` транспорту, а не после (I-4 по духу:
//      проверка предшествует исполнению);
//   6) и только теперь транспорт SDK — свой на этот запрос (`src/mcp.js`).

import { timingSafeEqual } from 'node:crypto'

/** Тело JSON-RPC больше этого не читаем: у наших инструментов два коротких аргумента. */
const MAX_BODY = 64 * 1024

export const MCP_PATH = '/mcp'

function send(res, status, payload, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(JSON.stringify(payload))
}

/**
 * «Здесь ничего нет»: код 404, пустое тело, ни `content-type`, ни строчки
 * содержания. ADR `2026-09-23-1844`, п. 1–2: решение владельца 2026-09-23
 * после того, как он открыл адрес в браузере и получил форму протокола с
 * кодом ошибки — то есть подсказку, что здесь что-то есть и что именно.
 *
 * Одна функция на обе причины — «нет такого пути» и «нет годного ключа» —
 * именно для того, чтобы ответы совпадали побайтно: два разных ответа
 * снова отличали бы эндпоинт от пустого места. Тест сверяет их целиком.
 *
 * Довод против владельцу назван: адрес опубликован в репозитории и на
 * лендинге, скрытность даёт немного, а отладка чужого клиента слепнет.
 * Решение принято с этим знанием.
 */
function nothingHere(res) {
  res.writeHead(404, { 'content-length': '0', 'cache-control': 'no-store' })
  res.end()
}

/** Ошибка протокола: наружу уходит JSON-RPC, а не наша самодеятельность. */
function rpcError(res, status, id, code, message, headers = {}) {
  send(res, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } }, headers)
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

/**
 * Адрес клиента. Сам по себе заголовок ничего не гарантирует: сюда он
 * приходит как есть, и подставить в него что угодно может кто угодно, кто до
 * службы дотянулся. Держит границу вход: `header_up X-Forwarded-For
 * {client_ip}` в блоке /mcp файла deploy/Caddyfile ЗАМЕНЯЕТ заголовок
 * адресом соединения, а мимо входа до службы не достучаться — портов наружу
 * нет и сеть mcp отдельная. Последний элемент берём на случай, если перед
 * нами окажется ещё один прокси, дописывающий адрес в хвост.
 *
 * Отсюда и разница путей: на публичном /mcp окна поадресные, а из консоли
 * дня 16 заголовка нет вовсе (день его не передаёт) — там одно общее окно на
 * адрес контейнера дня, и поадресную защиту даёт лимитер самого дня.
 */
export function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    const parts = forwarded.split(',')
    const last = parts[parts.length - 1].trim()
    if (last) return last
  }
  return req.socket?.remoteAddress ?? 'unknown'
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

/** Сколько вызовов инструментов в этом теле. Пачка считается поштучно. */
function toolCalls(body) {
  const items = Array.isArray(body) ? body : [body]
  return items.filter((item) => item && item.method === 'tools/call').length
}

function firstId(body) {
  const items = Array.isArray(body) ? body : [body]
  for (const item of items) if (item && item.id !== undefined) return item.id
  return null
}

export function createService({ env, limiter, createSession, tools = [], log = () => {} }) {
  async function route(req, res) {
    let url
    try {
      url = new URL(req.url, `http://${req.headers.host ?? 'mcp'}`)
    } catch {
      return send(res, 400, { ok: false, code: 'bad_request' })
    }

    if (url.pathname === '/healthz') {
      if (req.method !== 'GET') return send(res, 405, { ok: false, code: 'method_not_allowed' })
      // Публично — только признак живости. Выкатке и healthcheck контейнера
      // больше ничего не нужно: оба смотрят на код ответа и ни на что в теле
      // (`.github/workflows/deploy.yml`, шаги «ожидание healthy» и «Проверка
      // живого сайта»; `mcp/Dockerfile`, HEALTHCHECK). Имена инструментов,
      // пороги лимитера и число отслеживаемых адресов — за ключом: последнее
      // ещё и говорит прохожему, пользуется ли службой кто-то прямо сейчас.
      if (!safeEqual(bearer(req), env.MCP_KEY)) return send(res, 200, { ok: true })
      return send(res, 200, { ok: true, tools, limits: limiter.stats() })
    }

    if (url.pathname !== MCP_PATH) return nothingHere(res)

    const ip = clientIp(req)

    // Ключ сверяется ВСЕГДА — счётчик отказов на это не влияет. Так было не
    // сразу: 2026-09-23 здесь стоял потолок, который при исчерпанном окне
    // отвечал 404 не глядя. Он бил только по своим (у перебирающего годного
    // ключа нет по определению) и позволял одному посетителю консоли дня 16
    // кнопкой «проба без ключа» выключить консоль для всех на час. Снят.
    // Счётчик остался — ради одной строки в журнале, см. ниже.
    if (!safeEqual(bearer(req), env.MCP_KEY)) {
      const { count, signal } = limiter.noteRefusal(ip)
      log({ event: 'refuse', path: url.pathname, code: 'unauthorized' })
      // Одна строка за окно на адрес: перебирают. Адреса в записи нет и не
      // должно быть: журнал контейнера переживает часовое окно, и адрес в
      // нём хранился бы дольше окна, против I-10. Сигнал отвечает «перебор
      // идёт», а не «кто именно» — связка «кто» живёт только в памяти
      // лимитера и не дольше часа.
      if (signal) log({ event: 'refusal_burst', path: url.pathname, count })
      return nothingHere(res)
    }

    // Только POST. GET открывал бы поток от сервера, DELETE закрывал бы
    // сессию — в режиме без сессий ни того, ни другого нет (ADR, п. 3).
    if (req.method !== 'POST') {
      return rpcError(res, 405, null, -32000, 'method not allowed', { allow: 'POST' })
    }

    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      return rpcError(res, 400, null, -32700, 'parse error')
    }

    // Лимитер ДО исполнения: транспорт вызывается ниже этой строки.
    const calls = toolCalls(body)
    if (calls > 0) {
      const gate = limiter.reserve(ip, calls)
      if (!gate.ok) {
        log({ event: 'refuse', path: url.pathname, code: 'rate_limited', reason: gate.reason })
        return rpcError(res, 429, firstId(body), -32002, gate.message)
      }
    }

    // Сервер и транспорт — на этот запрос: см. `src/mcp.js`.
    const { server, transport } = await createSession()
    try {
      await transport.handleRequest(req, res, body)
    } finally {
      await transport.close()
      await server.close()
    }
  }

  // Необработанный отказ в обработчике `http` валит процесс: служба должна
  // отвечать 500, а не падать. Подробности наружу не уходят.
  return async function handler(req, res) {
    try {
      await route(req, res)
    } catch (error) {
      log({ event: 'error', message: String(error?.message ?? error) })
      if (!res.headersSent) send(res, 500, { ok: false, code: 'internal_error' })
      else res.end()
    }
  }
}
