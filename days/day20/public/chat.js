// Разговор дня 20: реплики посетителя и ответы агента (ADR 2026-09-28-1852,
// заход 2). Файл СВОЙ у дня: `trace.js` и `rpc.js` — общие для дней 18–20 и
// лежат копиями, а диалога у дней 18 и 19 нет.
//
// Что здесь НЕ делается — и это требование, а не вкус:
//   тексты кладутся `textContent`: ответ модели и результаты инструментов
//   недоверенные, разметки в них не исполняется;
//   отсутствующее поле не подставляется значением по умолчанию — его место
//   занимает слово о том, что поля не было;
//   слова модели в реплики НЕ попадают: диалог — что сказано и хранится,
//   лента хода — как прошёл ход (раскладка, п. 10.2).
//
// Правила (без DOM) проверяются исполнением в test/chat.test.js; ниже,
// после них, — единственная функция с DOM.

import { parseWords } from './trace.js'

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Времени у реплики нет — выдумывать его нечем. */
export const NO_TIME = 'время не записано'

/**
 * Разбор одной реплики из ответа `GET /api/chat`. Роль чужого вида — `agent`
 * с пометкой: показать реплику, назвав её чужой, честнее, чем выбросить.
 */
export function parseMessage(row) {
  const d = isObject(row) ? row : {}
  const role = d.role === 'user' ? 'user' : 'agent'
  const failed = isObject(d.meta) && d.meta.error === true
  return {
    role,
    text: typeof d.text === 'string' ? d.text : '',
    at: typeof d.at === 'string' && d.at !== '' ? d.at : null,
    // Сколько вызовов было в этом ходе. `null` — «не записано», и это не ноль.
    calls: isObject(d.meta) && Number.isInteger(d.meta.calls) ? d.meta.calls : null,
    // Слова кругов, сохранённые рядом с ответом агента. Разбираются тем же
    // `parseWords`, что и живое событие: иначе восстановленная лента и живая
    // расходились бы в мелочах молча.
    rounds:
      isObject(d.meta) && Array.isArray(d.meta.rounds) ? d.meta.rounds.map(parseWords) : [],
    failed,
  }
}

export function parseChat(payload) {
  const list = isObject(payload) && Array.isArray(payload.messages) ? payload.messages : []
  return list.map(parseMessage)
}

/** «14:07» местного времени посетителя; чего не записано, того в строке нет. */
export function clockOf(at) {
  if (at === null) return NO_TIME
  const date = new Date(at)
  return Number.isNaN(date.getTime())
    ? NO_TIME
    : `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/**
 * Подпись реплики. У ответа агента — число вызовов этого хода: единственная
 * связь реплики с лентой хода. Не записано — так и говорится, нуля вместо
 * неизвестного не ставится.
 */
export function messageTitle(message) {
  const time = clockOf(message.at)
  if (message.role === 'user') return `вы · ${time}`
  if (message.failed) return `агент · ${time} · ход не дал ответа`
  if (message.calls === null) return `агент · ${time}`
  return `агент · ${time} · вызовов: ${message.calls}`
}

/** «сообщений: N» под заголовком диалога. */
export function countLine(messages) {
  return `сообщений: ${messages.length}`
}

/**
 * Слова кругов последнего ответа агента — то, что переживает перезагрузку.
 * Берётся ровно последний ответ: лента хода показывает ОДИН ход, и склейка
 * кругов разных ходов выдала бы за один ход то, чего не было.
 */
export function lastRounds(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1)
    if (messages[i].role === 'agent') return messages[i].rounds
  return []
}

// ——— единственное место с DOM ———

const node = (tag, className, text) => {
  const el = document.createElement(tag)
  if (className) el.className = className
  if (text !== undefined) el.textContent = text
  return el
}

/** Одна реплика разговора. */
export function renderMessage(message) {
  const li = node('li', `msg is-${message.role}${message.failed ? ' is-error' : ''}`)
  li.append(
    node('p', 'msg-who', messageTitle(message)),
    node('p', 'msg-text', message.text === '' ? 'Текста в этой реплике нет.' : message.text),
  )
  return li
}
