// Правила консоли MCP: разбор команды, тексты пояснений, форматы чисел.
// Здесь нет ни одного обращения к DOM — не ради красоты, а чтобы тест мог
// **исполнить те самые правила**, которые исполняет страница, а не их копию
// в тесте и не их отпечаток в исходном тексте. Поиск строки по исходнику
// слеп к строке, разорванной склейкой; импорт — нет
// (agent_docs/guides/verification.md, «Механизм обязан быть тем, что описан»).
//
// Проводку этих правил в экран делает app.js.

/** Ревизия, которую страница называет в строке соединения и шлёт в заголовке. */
export const PROTOCOL_VERSION = '2025-11-25'

/** Три формы команды плюс проба GET — дословно так они перечисляются в отказе. */
export const FORMS = 'initialize, tools/list, tools/call <имя> <json>, GET'

/** Потолок показа тела: дальше обрезает страница и говорит об этом (раскладка, п. 8.3). */
export const BODY_LIMIT = 64 * 1024

/** Сколько записей живёт в ленте (раскладка, п. 5.2). */
export const FEED_LIMIT = 20

const encoder = new TextEncoder()
export const bytesOf = (text) => encoder.encode(text).length

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Разбор команды. Ничего не угадывает и ничего не исправляет: нераспознанная
 * команда и неразбираемые аргументы НЕ отправляются (раскладка, п. 6.1).
 * Отправить заведомо битое тело ради -32700 значит показать посетителю
 * сломанный сервер там, где сломана строка.
 *
 * @returns {{ok:true,text:string,noKey:boolean,http:'POST'|'GET',rpc:object|null}
 *          |{ok:false,message:string}}
 */
export function parseCommand(text, id = 1) {
  const raw = String(text ?? '').trim()
  if (!raw) return { ok: false, message: `Не отправлено: команда пустая. Есть: ${FORMS}.` }

  // Хвост --no-key снимается ДО разбора и становится признаком запроса,
  // а не частью команды.
  let noKey = false
  let body = raw
  const flagged = body.match(/^(.*?)\s*--no-key$/)
  if (flagged) {
    noKey = true
    body = flagged[1].trim()
  }
  if (!body) return { ok: false, message: `Не отправлено: --no-key — признак, а не команда. Есть: ${FORMS}.` }

  const space = body.search(/\s/)
  const head = space === -1 ? body : body.slice(0, space)
  const rest = space === -1 ? '' : body.slice(space + 1).trim()
  const done = (http, rpc) => ({ ok: true, text: raw, noKey, http, rpc })

  if (head === 'GET') return done('GET', null)

  if (head === 'initialize')
    return done('POST', {
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'advent-day16-console', version: '1' },
      },
    })

  if (head === 'tools/list') return done('POST', { jsonrpc: '2.0', id, method: 'tools/list', params: {} })

  if (head === 'tools/call') {
    const gap = rest.search(/\s/)
    const name = gap === -1 ? rest : rest.slice(0, gap)
    const argsText = gap === -1 ? '' : rest.slice(gap + 1).trim()
    if (!name)
      return { ok: false, message: 'Не отправлено: у tools/call нет имени инструмента. Форма: tools/call <имя> <json>.' }
    let args = {}
    if (argsText) {
      try {
        args = JSON.parse(argsText)
      } catch (error) {
        return { ok: false, message: `Не отправлено: аргументы не разбираются как JSON — ${error.message}` }
      }
      if (!isPlainObject(args))
        return { ok: false, message: `Не отправлено: аргументы должны быть объектом JSON — получено ${argsText}` }
    }
    return done('POST', { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
  }

  return { ok: false, message: `Не отправлено: нет команды «${head}». Есть: ${FORMS}.` }
}

/** Причины, по которым ответа не было вовсе. Имя приходит от сервера дня. */
const NO_ANSWER = {
  timeout: 'истекли 20 с',
  network: 'соединение оборвано',
}

/**
 * Исход запроса: цвет записи и пояснение одной строкой (раскладка, п. 8.2).
 * Пояснение объясняет КОД, а не пересказывает тело: тело рядом и говорит за себя.
 *
 * `kind`: ok — сервер ответил и это «ок»; proto — сервер ответил что-то иное
 * (нейтрально, это результат); fail — ответа не было вовсе (единственный красный).
 */
export function describe({ outcome, status, reason, bodyText = '', retryAfterSec }) {
  if (outcome === 'unreachable')
    return { kind: 'fail', note: `Ответ не получен: ${NO_ANSWER[reason] ?? 'служба MCP не ответила'}.` }
  if (outcome === 'limited')
    return {
      kind: 'proto',
      note: `429 — сработал предел запросов страницы. Повторите через ${retryAfterSec} с.`,
    }
  if (outcome !== 'upstream')
    return { kind: 'fail', note: 'Ответ не получен: сервер дня 16 не принял запрос страницы.' }

  let json = null
  try {
    json = JSON.parse(bodyText)
  } catch {
    json = null
  }

  if (status >= 200 && status < 300) {
    if (isPlainObject(json) && isPlainObject(json.error))
      return {
        kind: 'proto',
        note: `Протокол ответил ошибкой ${json.error.code} — запрос дошёл, выполнить его сервер отказался.`,
      }
    if (isPlainObject(json) && isPlainObject(json.result) && json.result.isError === true)
      return {
        kind: 'proto',
        note: 'Инструмент отработал и вернул ошибку: по протоколу это удачный ответ с признаком isError, а не отказ сервера.',
      }
    return { kind: 'ok', note: 'Ответ получен.' }
  }

  const notes = {
    // 401 в этой таблице НЕТ намеренно. Эндпоинт больше не отвечает «нет
    // доступа»: без годного ключа он отвечает так, будто его не существует
    // (решение владельца 2026-09-23, ADR 2026-09-23-1844 — он заменяет п. 4
    // ADR 2026-09-23-1227 в части кода отказа). Строка про 401 описывала бы механизм,
    // которого нет, — ровно то расхождение слова и механизма, которое
    // agent_docs/guides/verification.md запрещает. Если 401 всё же придёт
    // откуда-то ещё, его разберёт общая ветка внизу — она говорит только то,
    // что видно: код и «причина в теле ответа».
    // Пояснение называет случай без годного ключа и НЕ объявляет его
    // единственным: эндпоинт причины не сообщает, а 404 у него ещё и на
    // чужой путь (mcp/src/service.js, `url.pathname !== MCP_PATH`) — при
    // неверном MCP_URL страница получала бы его при совершенно годном ключе.
    //
    // Про «слишком много запросов» здесь больше НЕ говорится. Такая причина
    // была ровно один день: потолок отказов стоял до сверки ключа и гасил
    // консоль всем. Он снят (mcp aa8b6b0), и замер это подтверждает —
    // 60 проб «без ключа», затем рабочая команда: было 404, стало 200.
    // Оставить фразу значило бы описывать механизм, которого уже нет.
    404: '404 — эндпоинт отвечает так, будто его здесь нет: ни ошибки, ни подсказки, что по этому адресу что-то есть, и причины он не называет. Так он отвечает на запрос без годного ключа. Это защита, а не поломка.',
    405: '405 — эндпоинт принимает только POST. GET и DELETE отклоняются транспортом.',
    406: '406 — транспорт не принял заголовки запроса: Accept обязан называть оба типа, Content-Type — только application/json.',
    415: '415 — транспорт не принял заголовки запроса: Accept обязан называть оба типа, Content-Type — только application/json.',
    400: '400 — транспорт не принял запрос; причина в теле ответа.',
    // Своего предела у страницы здесь нет: этот 429 пришёл от самой службы.
    429: '429 — сработал предел запросов службы MCP. Причина в теле ответа.',
  }
  return { kind: 'proto', note: notes[status] ?? `${status} — сервер ответил отказом. Причина в теле ответа.` }
}

/**
 * Обрезка тела по потолку показа. Режется по БАЙТАМ, а не по знакам: в UTF-8
 * кириллица — два байта, и «64 000 знаков» были бы вдвое больше обещанного.
 */
export function clipBody(text) {
  const total = bytesOf(text)
  if (total <= BODY_LIMIT) return { text, total, truncated: false }
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (bytesOf(text.slice(0, mid)) <= BODY_LIMIT) lo = mid
    else hi = mid - 1
  }
  return { text: text.slice(0, lo), total, truncated: true }
}

/**
 * Переразбор с отступами — единственная допустимая обработка тела
 * (раскладка, п. 5.6). Меняются только переносы и пробелы: поля, порядок и
 * значения остаются теми, что пришли.
 */
export function reindent(text) {
  try {
    return { ok: true, text: JSON.stringify(JSON.parse(text), null, 2) }
  } catch {
    return { ok: false, text }
  }
}

/** Размер тела: в байтах до 1024, дальше в КБ с одним знаком. */
export function formatBytes(n) {
  return n < 1024 ? `${n} Б` : `${(n / 1024).toFixed(1).replace('.', ',')} КБ`
}

/**
 * Длительность. Секунды с одним знаком — как в примерах раскладки (0,9 с);
 * быстрее 100 мс — миллисекунды, потому что «0,0 с» читается как «не
 * измерено», а clock.now на соседнем контейнере отвечает именно так.
 * Формат длительности раскладка оставила реализации (п. 14.2).
 */
export function formatMs(ms) {
  return ms < 100 ? `${Math.round(ms)} мс` : `${(ms / 1000).toFixed(1).replace('.', ',')} с`
}

/** Время отправки, 14:07:31. */
export function formatTime(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * Строка метки записи: время отправки, код HTTP, длительность, размер тела —
 * в этом порядке и всегда (раскладка, п. 5.4). Ответа не было — кода нет, и
 * на его месте стоит слово, а не выдуманный код.
 */
export function metaLine({ time, status, ms, bytes }) {
  const parts = [time, status === null ? 'ответа нет' : `HTTP ${status}`, formatMs(ms)]
  if (bytes !== null && bytes !== undefined) parts.push(formatBytes(bytes))
  return parts.join(' · ')
}

/** Строка состояния композитора после ответа (раскладка, п. 6.3). */
export function statusLine({ outcome, status, reason, ms, bytes, retryAfterSec }) {
  if (outcome === 'limited') return `Ответ 429 · предел запросов страницы; повторите через ${retryAfterSec} с`
  if (outcome === 'unreachable')
    return `Ответ не получен: ${NO_ANSWER[reason] ?? 'служба MCP не ответила'}`
  if (outcome !== 'upstream') return 'Ответ не получен: сервер дня 16 не принял запрос страницы'
  return `Ответ ${status} · ${formatMs(ms)} · ${formatBytes(bytes)}`
}

/**
 * Что стоит в рамке ответа, когда байтов не пришло ни одного.
 *
 * Пустая рамка читалась бы как поломка страницы, а пояснение ВМЕСТО тела
 * запрещено (раскладка, п. 13.9). Здесь не замена телу: заменять нечего, и
 * строка говорит ровно это. Приём взят у состояния загрузки (п. 7.1), где
 * раскладка так же требует рамку со словами вместо скелетона.
 *
 * Правило завязано на ЧИСЛО БАЙТ, а не на код 404: пустое тело показывается
 * пустым при любом коде, потому что оно пустое, — а не потому, что мы знаем
 * про приём службы.
 */
export const EMPTY_BODY = 'Тела нет: служба не прислала ни одного байта.'

/** Тексты частичного результата (раскладка, п. 8.3). */
export const partialNotes = {
  clipped: (total) => `Показаны первые 64 КБ из ${formatBytes(total)}. Обрезала страница, не сервер.`,
  notJson: 'Тело ответа не разбирается как JSON и показано как текст; флажок «с отступами» на него не действует.',
}
