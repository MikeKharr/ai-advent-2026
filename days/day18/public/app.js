// Проводка страницы дня 18 в экран. Имена полей сводки — в digest.js,
// правила записи вызова — в trace.js, правила показа тела — в rpc.js (копия
// правил консоли дня 16). Здесь только DOM и поток событий.
//
// Чего здесь нет намеренно:
//   кнопки «запустить» — «когда» решает планировщик (ADR 2026-09-28-0736, п. 6);
//   localStorage/sessionStorage;
//   scrollIntoView/scrollTop — позиция чтения принадлежит посетителю;
//   подсветка синтаксиса — в .rpc кладётся textContent, и только он;
//   повторной подписки на оборванный поток: EventSource прислал бы те же
//   события второй раз, и лента показывала бы вызовы, которых не было.

import { UNKNOWN, enabledLine, formatUsd, formatWhen, runMeta, shapeDigest, startsLine } from './digest.js'
import { parseCall, renderCall } from './trace.js'

const byId = (id) => document.getElementById(id)
const state = byId('state')
const feed = byId('feed')
const empty = byId('empty')
const indent = byId('indent')
const live = byId('live')
const liveNote = byId('live-note')

let digest = null
/** Вызовы идущего запуска, в порядке прихода. Нигде не сохраняются. */
const liveCalls = []
let stream = null
let liveRunId = null

const node = (tag, className, text) => {
  const el = document.createElement(tag)
  if (className) el.className = className
  if (text !== undefined) el.textContent = text
  return el
}

function setState(text, bad = false) {
  state.textContent = text === '' ? ' ' : text
  state.classList.toggle('is-bad', bad)
}

function drawFacts(d) {
  byId('f-enabled').textContent = enabledLine(d.enabled)
  byId('f-next').textContent = formatWhen(d.nextRunAt)
  byId('f-starts').textContent = startsLine(d)
  byId('f-budget').textContent =
    d.budgetLeftUsd === null ? UNKNOWN : `${formatUsd(d.budgetLeftUsd)} из ${formatUsd(d.dailyCostUsd)}`
}

/** Одна сводка: состав, подпись, текст и раскрываемый трейс. */
function drawRun(run, index) {
  const li = node('li', 'entry')
  const head = node('p', 'entry-head')
  head.append(node('span', 'entry-cmd', run.id ?? UNKNOWN), node('span', 'entry-meta', runMeta(run)))
  const parts = [head]
  // Пустая сводка показывается пустой и говорит об этом словом: подставить
  // сюда «нет данных» как будто это текст сводки значило бы соврать.
  parts.push(node('p', 'entry-note', run.summary ?? 'Текста сводки нет: запуск его не дал.'))

  const details = node('details', 'trace')
  const calls = run.trace.map(parseCall)
  details.append(
    node(
      'summary',
      undefined,
      calls.length === 0 ? 'Трейс пуст: вызовов в этом запуске не записано' : `Трейс: ${calls.length} вызовов`,
    ),
  )
  if (calls.length > 0) {
    const list = node('ol', 'feed')
    list.append(...calls.map((call, i) => renderCall(call, { id: `r${index}-${i}`, indent: indent.checked })))
    details.append(list)
  }
  parts.push(details)
  li.replaceChildren(...parts)
  return li
}

function redraw() {
  if (digest === null) return
  feed.replaceChildren(...digest.runs.map(drawRun))
  empty.hidden = digest.runs.length > 0
  live.replaceChildren(...liveCalls.map((call, i) => renderCall(call, { id: `live-${i}`, indent: indent.checked })))
}

function onEvent(raw) {
  let event
  try {
    event = JSON.parse(raw)
  } catch {
    return
  }
  if (event?.stage !== 'rpc') return
  liveCalls.push(parseCall(event.data))
  liveNote.textContent = `Запуск идёт. Вызовов: ${liveCalls.length}.`
  redraw()
}

function subscribe(runId) {
  liveRunId = runId
  liveNote.textContent = 'Запуск идёт, ждём вызовы…'
  stream = new EventSource(`api/runs/${encodeURIComponent(runId)}/events`)
  stream.addEventListener('event', (e) => onEvent(e.data))
  stream.addEventListener('end', () => {
    stream.close()
    stream = null
    liveNote.textContent = `Запуск закончился. Вызовов было: ${liveCalls.length}. Сводка появится в ленте ниже.`
    load()
  })
  stream.onerror = () => {
    if (!stream) return
    stream.close()
    stream = null
    liveNote.textContent = `Поток событий оборвался. Показаны вызовы, которые успели прийти: ${liveCalls.length}.`
  }
}

async function load() {
  let answer
  let json
  try {
    answer = await fetch('api/digest')
    json = await answer.json().catch(() => null)
  } catch {
    return setState('Сводки не получены: сервер дня не ответил.', true)
  }
  if (!answer.ok) return setState(`Сводки не получены: ${json?.error ?? `сервер ответил ${answer.status}`}`, true)

  digest = shapeDigest(json)
  drawFacts(digest)
  redraw()
  setState(`Сводок в ленте: ${digest.runs.length}.`)

  if (digest.runningRunId !== null && digest.runningRunId !== liveRunId) {
    liveCalls.length = 0
    subscribe(digest.runningRunId)
  }
}

indent.addEventListener('change', redraw)
load()
