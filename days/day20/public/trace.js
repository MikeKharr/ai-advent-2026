// Запись одного вызова JSON-RPC в ленте: имя сервера, метод, сырое тело
// запроса и сырое тело ответа. Компонент общий для дней 18–20 и лежит в
// каждой единице своей копией (общего каталога у дней нет).
//
// Что здесь НЕ делается — и это требование, а не вкус:
//   тела не переупаковываются и не подсвечиваются — в .rpc кладётся
//   textContent, и только он (правило консоли дня 16);
//   отсутствующее поле не подставляется значением по умолчанию: его место
//   занимает слово о том, что поля не было.
//
// Правила (без DOM) проверяются исполнением в test/trace.test.js; ниже,
// после них, — единственная функция с DOM.

import { EMPTY_BODY, bytesOf, clipBody, formatBytes, formatMs, partialNotes, reindent } from './rpc.js'

/** Имя сервера отсутствует — выдумывать его нечем, и это говорится словом. */
export const NO_SERVER = 'сервер не назван'
/** Метод отсутствует. */
export const NO_METHOD = 'метод не назван'

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Разбор события стадии `rpc` (ADR 2026-09-28-0736, п. 5):
 * `{server, method, request, response, status, ms, clipped}`.
 *
 * Тела приходят объектами и здесь становятся текстом ОДИН раз — дальше
 * страница только режет и переставляет пробелы. Если тела нет вовсе, текста
 * нет тоже: `null` и пустая строка — разные случаи, и они не сливаются.
 */
export function parseCall(data) {
  const d = isObject(data) ? data : {}
  const body = (v) => (v === undefined || v === null ? null : typeof v === 'string' ? v : JSON.stringify(v))
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    server: typeof d.server === 'string' && d.server !== '' ? d.server : null,
    method: typeof d.method === 'string' && d.method !== '' ? d.method : null,
    request: body(d.request),
    response: body(d.response),
    status: num(d.status),
    ms: num(d.ms),
    // `clipped` пришёл от хоста: он обрезал тело ДО отправки события. Обрезка
    // страницы — отдельная и считается ниже; смешивать их значило бы соврать
    // о том, кто именно резал.
    clipped: d.clipped === true,
  }
}

/**
 * Имя инструмента у `tools/call` — из ТЕЛА ЗАПРОСА, `params.name`. Больше
 * ниоткуда: имя, выведенное из ответа или из порядка шагов, было бы догадкой
 * страницы о том, что именно звал хост.
 *
 * @returns {string|null}
 */
export function toolName(call) {
  if (call.method !== 'tools/call' || typeof call.request !== 'string') return null
  try {
    const json = JSON.parse(call.request)
    const name = isObject(json) && isObject(json.params) ? json.params.name : null
    return typeof name === 'string' && name !== '' ? name : null
  } catch {
    return null
  }
}

/**
 * Заголовок записи: имя сервера, метод и — у `tools/call` — имя инструмента.
 * Имя сервера идёт ПЕРВЫМ и стоит у каждого вызова без исключений: в этом
 * весь смысл дня 20 (инструменты приходят с разных серверов), и в дни 18 и 19
 * то же требование пришло сквозным.
 */
export function callTitle(call) {
  const tool = toolName(call)
  return `${call.server ?? NO_SERVER} · ${call.method ?? NO_METHOD}${tool ? ` ${tool}` : ''}`
}

/**
 * Метка записи: код, длительность, размер ответа. Чего не измерено — того в
 * строке нет; нуля вместо неизмеренного не ставится.
 */
export function callMeta(call) {
  const parts = []
  parts.push(call.status === null ? 'кода нет' : `HTTP ${call.status}`)
  if (call.ms !== null) parts.push(formatMs(call.ms))
  if (call.response !== null) parts.push(formatBytes(bytesOf(call.response)))
  return parts.join(' · ')
}

/** Пояснения о частичном показе: отдельно про хост, отдельно про страницу. */
export const clipNotes = {
  host: 'Тело обрезал хост при записи трейса: показаны первые 64 КБ.',
  page: partialNotes.clipped,
  notJson: partialNotes.notJson,
}

/**
 * sha256 из тела ответа `tools/call`. Берётся ровно из двух мест, и оба
 * названы: `result.sha256` и `result.structuredContent.sha256`. Ничего не
 * ищется рекурсивным обходом: найденная где угодно строка из 64 знаков —
 * не доказательство того, что сервер прислал именно хеш.
 *
 * @returns {string|null}
 */
export function sha256Of(responseText) {
  if (typeof responseText !== 'string' || responseText === '') return null
  let json
  try {
    json = JSON.parse(responseText)
  } catch {
    return null
  }
  const result = isObject(json) ? json.result : null
  if (!isObject(result)) return null
  const direct = result.sha256
  if (typeof direct === 'string' && /^[0-9a-f]{64}$/.test(direct)) return direct
  const structured = isObject(result.structuredContent) ? result.structuredContent.sha256 : null
  if (typeof structured === 'string' && /^[0-9a-f]{64}$/.test(structured)) return structured
  return null
}

/**
 * Вердикт о двух хешах дня 19. Третьего случая «наверное совпали» нет: пока
 * обоих хешей не видно, страница говорит, что сверять нечего, а не что всё в
 * порядке.
 */
export function compareHashes(a, b) {
  if (a === null || b === null) return { kind: 'unknown', note: 'Сверять нечего: сервер прислал не оба хеша.' }
  if (a === b) return { kind: 'ok', note: 'Хеши совпали: прочитано ровно то, что было сохранено.' }
  return { kind: 'bad', note: 'Хеши разошлись: прочитано не то, что было сохранено.' }
}

// ——— единственное место с DOM ———

const node = (tag, className, text) => {
  const el = document.createElement(tag)
  if (className) el.className = className
  if (text !== undefined) el.textContent = text
  return el
}

function pre(id, label, raw, indent, extraClass) {
  const caption = node('p', 'entry-label', label)
  caption.id = id
  const shown = raw === null || raw === '' ? EMPTY_BODY : indent ? reindent(raw).text : raw
  const isEmpty = raw === null || raw === ''
  const box = node('pre', `rpc${isEmpty ? ' is-empty' : ''}${extraClass ? ' ' + extraClass : ''}`, shown)
  box.tabIndex = 0
  box.setAttribute('role', 'region')
  box.setAttribute('aria-labelledby', id)
  return [caption, box]
}

/**
 * Одна запись вызова. `id` уникален в пределах страницы — он идёт в
 * aria-labelledby, и совпадение сломало бы подписи рамок.
 */
export function renderCall(call, { id, indent = false } = {}) {
  const li = node('li', 'entry')
  const head = node('p', 'entry-head')
  head.append(node('span', 'entry-cmd', callTitle(call)), node('span', 'entry-meta', callMeta(call)))
  const parts = [head]
  if (call.clipped) parts.push(node('p', 'entry-note', clipNotes.host))

  for (const [key, label, raw] of [
    ['req', 'Запрос', call.request],
    ['res', 'Ответ', call.response],
  ]) {
    let text = raw
    if (text !== null && text !== '') {
      const cut = clipBody(text)
      if (cut.truncated) parts.push(node('p', 'entry-note', clipNotes.page(cut.total)))
      else if (!reindent(text).ok) parts.push(node('p', 'entry-note', clipNotes.notJson))
      text = cut.text
    }
    parts.push(...pre(`${key}-${id}`, label, text, indent, key === 'req' ? 'is-req' : undefined))
  }
  li.replaceChildren(...parts)
  return li
}
