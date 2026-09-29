// Проводка страницы дня 20 в экран. Правила показа тела — в rpc.js (копия
// правил консоли дня 16), правила записи вызова — в trace.js, правила
// разговора — в chat.js; здесь только DOM и поток событий.
//
// Чего здесь нет намеренно:
//   localStorage/sessionStorage — переписка живёт на сервере, идентификатор
//   сессии лежит в cookie HttpOnly и странице не виден;
//   scrollIntoView/scrollTop — позиция чтения принадлежит посетителю;
//   подсветка синтаксиса — в .rpc кладётся textContent, и только он;
//   повторного подключения к оборванному потоку нет: EventSource переподписался
//   бы и прислал те же события второй раз, а лента показывала бы вызовы,
//   которых не было.
//
// Два потока на экране живут ПОРОЗНЬ и это главное правило файла: разговор
// приходит с сервера и переживает перезагрузку, лента хода собирается из
// событий и показывает ОДИН ход — текущий. Новое сообщение очищает ленту и
// не трогает разговор.

import { countLine, lastRounds, parseChat, renderMessage } from './chat.js'
import { NO_SERVER, parseCall, parseWords, renderCall, renderWords } from './trace.js'

const byId = (id) => document.getElementById(id)
const form = byId('run-form')
const input = byId('cmd')
const send = byId('send')
const clear = byId('clear')
const status = byId('run-status')
const log = byId('log')
const logEmpty = byId('log-empty')
const msgs = byId('msgs')
const restored = byId('restored')
const feed = byId('feed')
const empty = byId('empty')
const indent = byId('indent')
const serversList = byId('servers')
const serversNote = byId('servers-note')

const RESTORED_WITH_WORDS =
  'Переписка восстановлена с сервера, и слова модели последнего хода — вместе с ней: ' +
  'они лежат рядом с ответом. Сырого JSON-RPC среди них нет — тела вызовов живут в памяти ' +
  'сервиса 10 минут и после перезагрузки не возвращаются.'
/** Слов рядом с ответом нет — обещать восстановленный ход нельзя. */
const RESTORED_WITHOUT_WORDS =
  'Переписка восстановлена с сервера. Как шёл последний ход — нет: слов модели рядом с ' +
  'этим ответом не записано, а тела вызовов живут в памяти сервиса 10 минут.'

/** Вызовы этого хода, в порядке прихода. Нигде не сохраняются. */
const calls = []
/**
 * Лента хода: записи вызовов и записи со словами модели В ОДНОМ ПОРЯДКЕ, в
 * каком пришли события. Порядок и есть предмет показа — слова круга стоят
 * перед вызовами, которые модель на этом круге выбрала, потому что событие
 * приходит до исполнения инструментов, а не потому, что страница их
 * переставляет.
 */
const items = []
/** Номер круга, о котором говорит строка состояния. 0 — кругов ещё не было. */
let round = 0
let stream = null

function setStatus(text, bad = false) {
  status.textContent = text === '' ? ' ' : text
  status.classList.toggle('is-bad', bad)
}

function lock(on) {
  input.disabled = on
  send.disabled = on
  clear.disabled = on || log.children.length === 0
}

function redraw() {
  feed.replaceChildren(
    ...items.map((item, i) =>
      item.kind === 'words'
        ? renderWords(item.value, { id: i + 1 })
        : renderCall(item.value, { id: i + 1, indent: indent.checked }),
    ),
  )
  empty.hidden = items.length > 0
}

/** Лента хода целиком — новое сообщение показывает СВОЙ ход, а не прошлый. */
function resetRun() {
  calls.length = 0
  items.length = 0
  round = 0
  restored.hidden = true
  restored.textContent = ''
  redraw()
  showServers()
}

/**
 * Лента после перезагрузки: слова кругов последнего ответа и ничего больше.
 * Строка над лентой говорит СЛОВАМИ, что именно вернулось, а что нет, —
 * иначе пустое место на месте вызовов читалось бы как «их не было».
 */
function showRestored(rounds) {
  for (const words of rounds) items.push({ kind: 'words', value: words })
  restored.hidden = false
  restored.textContent = rounds.length > 0 ? RESTORED_WITH_WORDS : RESTORED_WITHOUT_WORDS
  redraw()
  showServers()
}

/**
 * Серверы, которые в этом ходе действительно отвечали, — в порядке первого
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
    seen.length > 0
      ? `Вызовы ушли на ${seen.length} ${seen.length === 1 ? 'сервер' : 'сервера'}.`
      : items.length > 0
        ? 'Какие серверы отвечали в прошлом ходе, не сохранено: остались только слова модели.'
        : 'Хода ещё не было: называть серверы нечем.'
}

function showChat(messages) {
  log.replaceChildren(...messages.map(renderMessage))
  logEmpty.hidden = messages.length > 0
  msgs.textContent = countLine(messages)
  clear.disabled = messages.length === 0
}

/**
 * Переписка с сервера при загрузке и после каждого хода. Отказ переписку не
 * выдумывает: лог остаётся как есть, а причина уходит в строку состояния.
 */
async function loadChat({ restore = false } = {}) {
  let answer
  let json
  try {
    answer = await fetch('api/chat')
    json = await answer.json().catch(() => null)
  } catch {
    setStatus('Переписка не прочитана: сервер дня не ответил.', true)
    return []
  }
  if (!answer.ok) {
    setStatus(`Переписка не прочитана: ${json?.error ?? `сервер ответил ${answer.status}`}`, true)
    return []
  }
  const messages = parseChat(json)
  showChat(messages)
  // Слова кругов последнего ответа — то, что решением владельца переживает
  // перезагрузку. Сырых тел вызовов рядом с ними нет и не будет.
  if (restore && messages.length > 0) showRestored(lastRounds(messages))
  return messages
}

function onEvent(raw) {
  let event
  try {
    event = JSON.parse(raw)
  } catch {
    return
  }
  if (event?.stage === 'llm_text') {
    // Событие уходит на каждом круге, в том числе когда модель не сказала
    // ничего. Такую запись страница показывает словом «без слов» и НЕ
    // пропускает: молчание модели — тоже ответ на вопрос «как она выбирает».
    const words = parseWords(event.data)
    items.push({ kind: 'words', value: words })
    if (words.round !== null) round = words.round
    redraw()
    setStatus(`Круг ${round}. Вызовов: ${calls.length}.`)
    return
  }
  if (event?.stage !== 'rpc') return
  const call = parseCall(event.data)
  calls.push(call)
  items.push({ kind: 'call', value: call })
  redraw()
  showServers()
  setStatus(`Круг ${round}. Вызовов: ${calls.length}.`)
}

function subscribe(runId) {
  stream = new EventSource(`api/runs/${encodeURIComponent(runId)}/events`)
  stream.addEventListener('event', (e) => onEvent(e.data))
  stream.addEventListener('end', async (e) => {
    stream.close()
    stream = null
    lock(false)
    let end = null
    try {
      end = JSON.parse(e.data)
    } catch {}
    const ok = end?.status === 'succeeded'
    setStatus(
      ok
        ? `Готово. Кругов: ${round}, вызовов: ${calls.length}.`
        : `Ход завершился со статусом «${end?.status ?? 'неизвестно'}».`,
      !ok,
    )
    // Реплики берутся с сервера, а не собираются страницей: там они и
    // хранятся, и показывать свою версию значило бы разойтись с ней молча.
    await loadChat()
  })
  stream.onerror = () => {
    // Поток оборвался. Второй подписки не делаем — см. шапку файла.
    if (!stream) return
    stream.close()
    stream = null
    lock(false)
    setStatus(`Поток событий оборвался. Показано записей: ${items.length}.`, true)
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (send.disabled) return
  const task = input.value.trim()
  if (!task) return setStatus('Не отправлено: поле пустое.', true)

  lock(true)
  setStatus('Отправляем…')

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
    return setStatus('Не отправлено: сервер дня не ответил.', true)
  }
  if (answer.status !== 202 || !json?.runId) {
    lock(false)
    const retry =
      answer.status === 429 && Number.isInteger(json?.retryAfterSec)
        ? ` Повторить можно через ${json.retryAfterSec} с.`
        : ''
    // Сообщение сервера не пересказывается: в нём единственное достоверное
    // число суточного предела.
    return setStatus(`${json?.error ?? `Сервер ответил ${answer.status}.`}${retry}`, true)
  }
  // Ход принят — только теперь лента очищается и поле пустеет. При отказе на
  // экране остаётся ровно то, что было: ход не начинался.
  input.value = ''
  resetRun()
  setStatus('Ход идёт, ждём вызовы…')
  // Реплика посетителя появляется в логу сразу: вопрос уже задан.
  await loadChat()
  subscribe(json.runId)
})

// Ctrl + Enter отправляет: поле многострочное, и Enter в нём переносит строку.
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) form.requestSubmit()
})

clear.addEventListener('click', async () => {
  if (clear.disabled) return
  clear.disabled = true
  let answer
  try {
    answer = await fetch('api/chat', { method: 'DELETE' })
  } catch {
    clear.disabled = false
    return setStatus('Не очищено: сервер дня не ответил.', true)
  }
  if (!answer.ok) {
    clear.disabled = false
    const json = await answer.json().catch(() => null)
    return setStatus(`Не очищено: ${json?.error ?? `сервер ответил ${answer.status}`}`, true)
  }
  showChat([])
  resetRun()
  setStatus('Переписка удалена.')
})

indent.addEventListener('change', redraw)

await loadChat({ restore: true })
