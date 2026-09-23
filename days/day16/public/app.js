// Проводка консоли MCP в экран. Правила — в console.js; здесь только DOM.
//
// Чего здесь нет намеренно (раскладка 2026-09-23-1242, п. 13):
//   localStorage/sessionStorage — история живёт до перезагрузки и нигде больше;
//   scrollIntoView/scrollTop — позиция чтения принадлежит посетителю;
//   перевод фокуса на новую запись — фокус остаётся в поле ввода;
//   отправка по нажатию на готовую команду — только вставка в поле;
//   подсветка синтаксиса — в .rpc кладётся textContent, и только он.

import {
  EMPTY_BODY,
  FEED_LIMIT,
  clipBody,
  describe,
  formatTime,
  metaLine,
  parseCommand,
  partialNotes,
  reindent,
  statusLine,
} from './console.js'

const byId = (id) => document.getElementById(id)
const form = byId('cmd-form')
const input = byId('cmd')
const send = byId('send')
const status = byId('cmd-status')
const feed = byId('feed')
const empty = byId('empty')
const trimmed = byId('trimmed')
const indent = byId('indent')

/** Записи, новая первой. Нигде не сохраняются: перезагрузка их стирает. */
const records = []
let nextId = 1

const node = (tag, className, text) => {
  const el = document.createElement(tag)
  if (className) el.className = className
  if (text !== undefined) el.textContent = text
  return el
}

function setStatus(text, bad = false) {
  status.textContent = text === '' ? ' ' : text
  status.classList.toggle('is-bad', bad)
}

function lock(on) {
  input.disabled = on
  send.disabled = on
}

/** Тело показывается как пришло; флажок меняет только переносы и пробелы. */
function shown(raw) {
  return indent.checked ? reindent(raw).text : raw
}

function pre(id, label, raw, extraClass) {
  const caption = node('p', 'entry-label', label)
  caption.id = id
  // `is-empty` — не тело, а сообщение о его отсутствии: флажок отступов на
  // него не действует, иначе он «обрабатывал» бы нашу собственную строку.
  const текст = extraClass === 'is-empty' ? raw : shown(raw)
  const box = node('pre', extraClass ? `rpc ${extraClass}` : 'rpc', текст)
  box.tabIndex = 0
  box.setAttribute('role', 'region')
  box.setAttribute('aria-labelledby', id)
  return [caption, box]
}

/** Перерисовка одной записи: команда → пояснение → запрос → ответ, всегда в этом порядке. */
function fill(rec) {
  const li = rec.el
  li.dataset.kind = rec.kind
  if (rec.kind === 'wait') li.setAttribute('aria-busy', 'true')
  else li.removeAttribute('aria-busy')

  const head = node('p', 'entry-head')
  head.append(node('span', 'entry-cmd', rec.text), node('span', 'entry-meta', rec.metaText))
  if (rec.kind !== 'wait') {
    const again = node('button', 'entry-again', 'Повторить')
    again.type = 'button'
    again.addEventListener('click', () => submit(rec.text))
    head.append(again)
  }

  const parts = [head, node('p', 'entry-note', rec.note)]
  for (const text of rec.partial) parts.push(node('p', 'entry-note is-part', text))
  parts.push(...pre(`req-${rec.id}`, 'Запрос', rec.reqRaw, 'is-req'))
  if (rec.kind === 'wait') {
    const caption = node('p', 'entry-label', 'Ответ')
    caption.id = `res-${rec.id}`
    const box = node('pre', 'rpc is-waiting', 'Ответ ещё не пришёл')
    box.setAttribute('role', 'region')
    box.setAttribute('aria-labelledby', caption.id)
    parts.push(caption, box)
  } else if (rec.resRaw === '') {
    // Ответ ЕСТЬ, а байтов в нём нет. Это третий случай рядом с «ответ
    // получен» и «ответа нет вовсе», и он не сбой: так отвечает эндпоинт,
    // который прячется. Рамка стоит на месте тела и говорит, что тела нет, —
    // пустая рамка читалась бы как поломка страницы.
    parts.push(...pre(`res-${rec.id}`, 'Ответ', EMPTY_BODY, 'is-empty'))
  } else if (rec.resRaw !== null) {
    parts.push(...pre(`res-${rec.id}`, 'Ответ', rec.resRaw))
  }
  li.replaceChildren(...parts)
}

/** Лента держит последние 20 записей и говорит, когда начала вытеснять. */
function trim() {
  while (records.length > FEED_LIMIT) {
    const gone = records.pop()
    gone.el.remove()
    trimmed.hidden = false
  }
}

async function submit(text) {
  if (send.disabled) return // одновременных запросов на странице не бывает
  const parsed = parseCommand(text, nextId)
  if (!parsed.ok) return setStatus(parsed.message, true)
  nextId += 1

  const time = formatTime(new Date())
  const rec = {
    id: nextId,
    el: node('li', 'entry'),
    text: parsed.text,
    kind: 'wait',
    metaText: `отправлено ${time}`,
    note: 'Ждём ответ…',
    partial: [],
    reqRaw:
      parsed.http === 'GET'
        ? 'GET /mcp\n(у пробы нет тела: эндпоинт принимает только POST)'
        : JSON.stringify(parsed.rpc),
    resRaw: null,
  }
  records.unshift(rec)
  feed.prepend(rec.el)
  empty.hidden = true
  trim()
  fill(rec)
  lock(true)
  setStatus('Отправлено, ждём ответ…')

  const started = performance.now()
  let answer = null
  let raw = ''
  try {
    answer = await fetch('api/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rpc: parsed.rpc, http: parsed.http, noKey: parsed.noKey }),
    })
    raw = await answer.text()
  } catch {
    answer = null
  }

  const outcome = answer ? (answer.headers.get('x-rpc-outcome') ?? 'rejected') : 'unreachable'
  const reason = answer ? (answer.headers.get('x-rpc-reason') ?? 'network') : 'network'
  // Длительность называет сервер дня — он и мерил разговор со службой;
  // если он не ответил вовсе, остаётся то, что намерил браузер.
  const upstreamMs = answer && answer.headers.get('x-rpc-ms')
  const ms = upstreamMs ? Number(upstreamMs) : Math.round(performance.now() - started)
  let retryAfterSec = null
  if (outcome === 'limited') {
    try {
      retryAfterSec = JSON.parse(raw).retryAfterSec
    } catch {
      retryAfterSec = Number(answer.headers.get('retry-after'))
    }
  }

  const verdict = describe({ outcome, status: answer?.status, reason, bodyText: raw, retryAfterSec })
  rec.kind = verdict.kind
  rec.note = verdict.note
  rec.partial = []
  if (verdict.kind === 'fail') {
    rec.resRaw = null
    rec.metaText = metaLine({ time, status: null, ms })
  } else {
    const clipped = clipBody(raw)
    if (clipped.truncated) rec.partial.push(partialNotes.clipped(clipped.total))
    // Пустое тело — не «тело, которое не разобралось»: разбирать нечего, и
    // строка «показано как текст» соврала бы — текста тоже нет. О пустоте
    // говорит рамка ответа, и этого довольно.
    if (raw !== '' && !reindent(raw).ok) rec.partial.push(partialNotes.notJson)
    rec.resRaw = clipped.text
    rec.metaText = metaLine({ time, status: answer.status, ms, bytes: clipped.total })
  }
  fill(rec)
  lock(false)
  setStatus(statusLine({ outcome, status: answer?.status, reason, ms, bytes: clipBody(raw).total, retryAfterSec }))
  // Фокус остаётся в поле: о приходе ответа сообщает строка состояния.
  if (document.activeElement === document.body) input.focus()
}

for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => {
    // Вставляет и НЕ отправляет: посетитель обязан видеть, что он посылает.
    input.value = chip.textContent.trim()
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
  })
}

form.addEventListener('submit', (event) => {
  event.preventDefault()
  submit(input.value)
})

indent.addEventListener('change', () => {
  for (const rec of records) fill(rec)
})
