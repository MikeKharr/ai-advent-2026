// Проводка страницы дня 20 в экран. Правила показа тела — в rpc.js (копия
// правил консоли дня 16), правила записи вызова — в trace.js; здесь только DOM
// и поток событий.
//
// Чего здесь нет намеренно:
//   localStorage/sessionStorage — лента живёт до перезагрузки и нигде больше;
//   scrollIntoView/scrollTop — позиция чтения принадлежит посетителю;
//   подсветка синтаксиса — в .rpc кладётся textContent, и только он;
//   повторного подключения к оборванному потоку нет: EventSource переподписался
//   бы и прислал те же события второй раз, а лента показывала бы вызовы,
//   которых не было.

import { NO_SERVER, parseCall, renderCall } from './trace.js'

const byId = (id) => document.getElementById(id)
const form = byId('run-form')
const input = byId('cmd')
const send = byId('send')
const status = byId('run-status')
const feed = byId('feed')
const empty = byId('empty')
const indent = byId('indent')
const serversList = byId('servers')
const serversNote = byId('servers-note')

/** Вызовы этого запуска, в порядке прихода. Нигде не сохраняются. */
const calls = []
let stream = null

function setStatus(text, bad = false) {
  status.textContent = text === '' ? ' ' : text
  status.classList.toggle('is-bad', bad)
}

function lock(on) {
  input.disabled = on
  send.disabled = on
}

function redraw() {
  feed.replaceChildren(...calls.map((call, i) => renderCall(call, { id: i + 1, indent: indent.checked })))
}

/**
 * Серверы, которые в этом запуске действительно отвечали, — в порядке первого
 * появления. Список не задан заранее и не берётся из реестра: он собирается
 * из того, что пришло. Реестр сказал бы, какие серверы у нас ЕСТЬ, а предмет
 * показа — какие из них модель позвала.
 */
function showServers() {
  const seen = []
  for (const call of calls) {
    const name = call.server ?? NO_SERVER
    if (!seen.includes(name)) seen.push(name)
  }
  serversList.replaceChildren(
    ...seen.map((name) => {
      const li = document.createElement('li')
      li.className = 'server'
      li.textContent = name
      return li
    }),
  )
  serversNote.textContent =
    seen.length === 0
      ? 'Запуска ещё не было: называть серверы нечем.'
      : `Вызовы ушли на ${seen.length} ${seen.length === 1 ? 'сервер' : 'сервера'}.`
}

function onEvent(raw) {
  let event
  try {
    event = JSON.parse(raw)
  } catch {
    return
  }
  if (event?.stage !== 'rpc') return
  const call = parseCall(event.data)
  calls.push(call)
  empty.hidden = true
  redraw()
  showServers()
  setStatus(`Вызовов: ${calls.length}. Идёт…`)
}

function subscribe(runId) {
  stream = new EventSource(`api/runs/${encodeURIComponent(runId)}/events`)
  stream.addEventListener('event', (e) => onEvent(e.data))
  stream.addEventListener('end', (e) => {
    stream.close()
    stream = null
    lock(false)
    let end = null
    try {
      end = JSON.parse(e.data)
    } catch {}
    const ok = end?.status === 'succeeded'
    setStatus(ok ? `Готово. Вызовов: ${calls.length}.` : `Запуск завершился со статусом «${end?.status ?? 'неизвестно'}».`, !ok)
  })
  stream.onerror = () => {
    // Поток оборвался. Второй подписки не делаем — см. шапку файла.
    if (!stream) return
    stream.close()
    stream = null
    lock(false)
    setStatus(`Поток событий оборвался. Показаны вызовы, которые успели прийти: ${calls.length}.`, true)
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (send.disabled) return
  const task = input.value.trim()
  if (!task) return setStatus('Не запущено: поле пустое.', true)

  calls.length = 0
  feed.replaceChildren()
  empty.hidden = false
  showServers()
  lock(true)
  setStatus('Запускаем…')

  let answer
  let json
  try {
    answer = await fetch('api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task }),
    })
    json = await answer.json().catch(() => null)
  } catch {
    lock(false)
    return setStatus('Не запущено: сервер дня не ответил.', true)
  }
  if (answer.status !== 202 || !json?.runId) {
    lock(false)
    return setStatus(`Не запущено: ${json?.error ?? `сервер ответил ${answer.status}`}`, true)
  }
  setStatus('Запуск идёт, ждём вызовы…')
  subscribe(json.runId)
})

indent.addEventListener('change', redraw)
