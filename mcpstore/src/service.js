// HTTP-контракт единицы (ADR 2026-09-28-0736, п. 3). Порядок в `route`
// читается сверху вниз и таков намеренно:
//   1) /healthz — открыт, его проверяет выкатка и HEALTHCHECK образа;
//   2) путь: всё, кроме /mcp, — 404;
//   3) только POST: без сессий поднимать поток нечему;
//   4) тело с потолком — читается ДО разбора и режется на лету;
//   5) и только теперь JSON-RPC.
//
// Ключа здесь нет и не должно быть: единица живёт в закрытой сети compose
// `tools`, портов наружу не публикует и маршрута в `Caddyfile` не имеет
// (ADR, п. 3). Ключ дня 16 закрывает ПУБЛИЧНЫЙ адрес; у этих серверов
// публичного адреса нет, и ключ без него защищал бы от того, чего нет.

import { CODES, rpcError } from './rpc.js'

/**
 * Потолок тела по умолчанию — тот же, что у дня 16 (`mcp/src/service.js`).
 * Единица вправе поднять его: у `mcpstore` аргумент `content` сам по себе
 * равен 64 КБ, и при общем потолке в 64 КБ файл предельного размера не
 * прошёл бы НИКОГДА — конверт JSON-RPC и экранирование не бесплатны
 * (расхождение в ADR 2026-09-28-0736, п. 3: «тело до 64 КБ» и «64 КБ на
 * файл» несовместимы; вынесено владельцу — пункт «Владельцу» в
 * `agent_docs/backlog/process.md`, разбор в
 * `agent_docs/development-history/2026-09-28-0832-mcpstore-body-limit-deviation.md`).
 */
export const DEFAULT_MAX_BODY = 64 * 1024

/**
 * Потолок тела этой единицы. 64 КБ содержимого файла в конверте JSON-RPC
 * занимают больше 64 КБ ВСЕГДА: даже файл из одной латиницы даёт тело в
 * 65 659 байт при потолке в 65 536, то есть при общем потолке в 64 КБ файл
 * предельного размера не прошёл бы ни при каком содержимом.
 *
 * Четырёхкратный запас рассчитан на РЕАЛЬНЫЙ текст, а не на всякое законное
 * содержимое. Экранирование кавычек и переводов строки удваивает знак —
 * худший такой случай даёт 128,1 КБ и укладывается вдвое. Управляющие знаки
 * идут по шесть байт (`\u0001`), и файл в 64 КБ из них одних даёт 384,1 КБ:
 * в 256 КБ он НЕ влезет и получит честный отказ до разбора. Это принято —
 * такой файл не является сводкой новостей, ради которой единица существует
 * (разбор и замеры: `development-history/2026-09-28-0832-mcpstore-body-limit-deviation.md`).
 *
 * Сам файл при этом режется по 64 КБ в `store.js` — потолок файла остаётся
 * тем, что назван в ADR.
 */
export const STORE_MAX_BODY = 256 * 1024

export const MCP_PATH = '/mcp'

function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
  })
  res.end(body)
}

function readBody(req, maxBody) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBody) {
        reject(new Error(`тело больше ${maxBody} байт`))
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
 * @param handleOne обработчик одного объекта JSON-RPC (`createRpc`)
 * @param health    () => объект тела /healthz; своих секретов у него нет
 */
export function createService({ handleOne, tools = [], health = () => ({}), log = () => {}, maxBody = DEFAULT_MAX_BODY }) {
  async function route(req, res) {
    let url
    try {
      url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
    } catch {
      return send(res, 400, { ok: false, code: 'bad_request' })
    }

    if (url.pathname === '/healthz') {
      if (req.method !== 'GET') return send(res, 405, { ok: false, code: 'method_not_allowed' })
      // Выкатка и HEALTHCHECK смотрят на код ответа. Имена инструментов здесь
      // не тайна: секретов у единицы нет вовсе, наружу она не опубликована.
      return send(res, 200, { ok: true, tools, ...health() })
    }

    if (url.pathname !== MCP_PATH) return send(res, 404, { ok: false, code: 'not_found' })

    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      return send(res, 405, rpcError(null, CODES.INVALID_REQUEST, 'method not allowed'))
    }

    let body
    try {
      body = JSON.parse(await readBody(req, maxBody))
    } catch {
      return send(res, 400, rpcError(null, CODES.PARSE_ERROR, 'parse error'))
    }

    // Пачка: каждый объект обрабатывается по очереди, уведомления ответа не
    // дают. Пачка из одних уведомлений — 202 без тела, как велит спецификация.
    if (Array.isArray(body)) {
      if (body.length === 0) return send(res, 400, rpcError(null, CODES.INVALID_REQUEST, 'empty batch'))
      const answers = []
      for (const item of body) {
        const answer = await handleOne(item)
        if (answer) answers.push(answer)
      }
      if (answers.length === 0) {
        res.writeHead(202, { 'content-length': '0', 'cache-control': 'no-store' })
        return res.end()
      }
      return send(res, 200, answers)
    }

    const answer = await handleOne(body)
    if (!answer) {
      // Уведомление (`notifications/initialized`) — 202 без тела.
      res.writeHead(202, { 'content-length': '0', 'cache-control': 'no-store' })
      return res.end()
    }
    return send(res, 200, answer)
  }

  // Необработанный отказ в обработчике `http` валит процесс: служба обязана
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
