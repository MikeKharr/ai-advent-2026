// Проводка страницы дня 19 в экран. Правила показа тела — в rpc.js (копия
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

import { compareHashes, parseCall, renderCall, sha256Of, toolName } from './trace.js'

const byId = (id) => document.getElementById(id)
const form = byId('run-form')
const input = byId('cmd')
const send = byId('send')
const status = byId('run-status')
const feed = byId('feed')
const empty = byId('empty')
const indent = byId('indent')
const hashNote = byId('hash-note')

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

function markStep(call) {
  const tool = toolName(call)
  if (!tool) return
  const step = document.querySelector(`.step[data-tool="${CSS.escape(tool)}"]`)
  if (step) step.dataset.state = 'done'
}

/**
 * Хеши берутся из ответов ровно двух шагов, названных по имени инструмента.
 * Не «второй и четвёртый вызов»: порядок — наблюдение, имя инструмента —
 * то, что хост действительно звал.
 */
function showHashes() {
  const of = (tool) => {
    const call = calls.find((c) => toolName(c) === tool)
    return call ? sha256Of(call.response) : null
  }
  const a = of('news.summarize')
  const b = of('file.read')
  for (const [id, value] of [['hash-a', a], ['hash-b', b]]) {
    const box = byId(id)
    box.textContent = value ?? 'хеша ещё нет'
    box.classList.toggle('is-empty', value === null)
  }
  hashNote.textContent = compareHashes(a, b).note
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
  markStep(call)
  redraw()
  showHashes()
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
  for (const step of document.querySelectorAll('.step')) delete step.dataset.state
  showHashes()
  lock(true)
  setStatus('Запускаем цепочку…')

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
