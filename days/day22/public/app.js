// Проводка страницы дня 22 в экран. Правила показа тела JSON-RPC — в rpc.js
// (копия правил консоли дня 16), правила запуска — в run.js, правила итогов
// десяти вопросов — в evalview.js; здесь только DOM и поток событий.
//
// Чего здесь нет намеренно:
//   localStorage/sessionStorage/cookie — сессий и переписки у дня нет, и
//   состояние раскрытия свёрток страница тоже не запоминает (I-10, п. 2.3);
//   scrollIntoView/scrollTop — позиция чтения принадлежит посетителю (п. 13.6):
//   ответ появляется ниже кнопки, и посетитель узнаёт об этом из живой строки
//   состояния, а не потому, что страница его туда увезла;
//   innerHTML — предмет показа кладётся textContent, и только им: ответ модели,
//   текст фрагментов и тела протокола — недоверенные данные (п. 5.2, 6.3, 7.2);
//   подсветки синтаксиса и разбора тел в карточки нет (п. 16.2);
//   повторного подключения к оборванному потоку нет: EventSource переподписался
//   бы и прислал те же события второй раз, а лента показывала бы шаги, которых
//   не было.
//
// Два источника данных на экране живут ПОРОЗНЬ, и это главное правило файла:
// пульт собирается из событий ОДНОГО запуска, итоги десяти вопросов читаются из
// файла `eval.json` независимо и отказом пульт не ломают (п. 17.3).

import {
  GENERAL_NOTE,
  mechanics,
  NOT_RUN,
  parseEval,
  partialNote,
  tally,
  limitsText,
  verdict,
  verdictWord,
} from './evalview.js'
import { clipBody, partialNotes, reindent } from './rpc.js'
import {
  ANSWER_CUT,
  answerMeta,
  DAY_LIMIT_NOTE,
  failure,
  formatScore,
  fragmentSummary,
  fragmentTextNote,
  FRAGMENT_EMPTY,
  indexMeta,
  MAX_QUESTION,
  MODE_WORD,
  NORAG_NOTE,
  parseResult,
  REFUSED_NOTE,
  RPC_ABSENT,
  RPC_BROKEN,
  RPC_EMPTY,
  shortSearchNote,
  sourceUrl,
  STATUS,
  steps,
} from './run.js'

const byId = (id) => document.getElementById(id)
const form = byId('ask')
const input = byId('q')
const send = byId('send')
const status = byId('status')
const modeHint = byId('mode-hint')
const answerEmpty = byId('answer-empty')
const answerBox = byId('answer')
const indexMetaBox = byId('index-meta')
const srcsNote = byId('srcs-note')
const srcsList = byId('srcs')
const stepsNote = byId('steps-note')
const stepsList = byId('steps')
const evalState = byId('eval-state')
const evalBox = byId('eval')

const node = (tag, className, text) => {
  const el = document.createElement(tag)
  if (className) el.className = className
  if (text !== undefined) el.textContent = text
  return el
}

/** Строка состояния: цвет и слово несут один смысл (п. 8.1, корпус). */
function setStatus(text, bad = false) {
  status.textContent = text === '' ? ' ' : text
  status.classList.toggle('is-bad', bad)
}

// ——— переключатель режима (п. 4.2) ———

/** Подпись объясняет ПОСЛЕДСТВИЕ выбора, а не повторяет название режима. */
const MODE_HINT = {
  rag:
    'с RAG: сначала поиск по проекту, потом один вызов модели. Отвечать модель будет ' +
    'только по найденным фрагментам; нет в них ответа — так и скажет.',
  norag:
    'без RAG: поиска нет, фрагментов нет. Модель отвечает по памяти, и проверить ответ ' +
    'по источникам будет нечем.',
}
const radios = [...form.querySelectorAll('input[name="mode"]')]
const chosenMode = () => radios.find((r) => r.checked)?.value ?? 'rag'
function showModeHint() {
  modeHint.textContent = MODE_HINT[chosenMode()]
}
for (const radio of radios) radio.addEventListener('change', showModeHint)
showModeHint()

// ——— пустые состояния пульта (п. 10) ———

const SRCS_NEVER = 'Вопроса ещё не было: искать было нечего.'
const SRCS_NORAG = 'Поиск не выполнялся: это режим без RAG. Проверить ответ по файлам проекта нечем.'
const SRCS_SEARCHING = 'Ищу фрагменты…'
const SRCS_FAILED = 'Поиск отказал — что именно, сказано выше в ответе.'
const STEPS_NEVER =
  'Запуска ещё не было. Шаги появятся здесь по мере того, как конвейер их проходит.'

/** Состояние пульта между запусками. Нигде не сохраняется. */
let events = []
let stream = null
let fragmentsFound = null
/** Данные последнего события стадии `error`: в нём статус 429 от службы поиска. */
let errorData = null

function showSrcsPlaceholder(text) {
  indexMetaBox.textContent = ''
  srcsList.replaceChildren()
  srcsNote.replaceChildren(node('p', 'empty', text))
}

function showStepsPlaceholder(text) {
  stepsList.replaceChildren()
  stepsNote.replaceChildren(node('p', 'empty', text))
}

function resetRun() {
  events = []
  fragmentsFound = null
  errorData = null
  answerEmpty.hidden = false
  answerBox.replaceChildren()
  showSrcsPlaceholder(SRCS_NEVER)
  showStepsPlaceholder(STEPS_NEVER)
}

// ——— лента конвейера (п. 7) ———

/**
 * Рамка тела протокола. Правила `.rpc` копии дают моноширинный шрифт, свою
 * прокрутку и потолок высоты; подписана и достижима с клавиатуры — иначе
 * хвост тела не прочесть вовсе (п. 11).
 *
 * Тело кладётся textContent и не переразбирается с отступами: флажка «с
 * отступами» на этом экране нет, а молча менять пробелы в предмете показа
 * нельзя. Переразбор используется ровно для одного — узнать, разбирается ли
 * тело как JSON, чтобы сказать об этом словами.
 */
function rpcBox(id, label, raw, { broken = false, request = false } = {}) {
  const caption = node('p', 'entry-label', label)
  caption.id = id
  const parts = [caption]
  const missing = raw === null || raw === ''
  let shown = raw
  if (!missing) {
    const cut = clipBody(raw)
    if (cut.truncated) parts.push(node('p', 'trimmed', partialNotes.clipped(cut.total)))
    else if (!reindent(raw).ok) parts.push(node('p', 'entry-note', partialNotes.notJson))
    shown = cut.text
  }
  const box = node('pre', `rpc${missing ? ' is-empty' : ''}${request ? ' is-req' : ''}`, missing ? (broken ? RPC_BROKEN : RPC_EMPTY) : shown)
  box.tabIndex = 0
  box.setAttribute('role', 'region')
  box.setAttribute('aria-labelledby', id)
  parts.push(box)
  return parts
}

/** Одна запись ленты. `id` уникален в пределах страницы: он идёт в aria-labelledby. */
function renderStep(step, id) {
  const li = node('li', 'entry')
  const head = node('p', 'entry-head')
  head.append(node('span', 'entry-label', step.label))
  if (step.time !== null) head.append(node('span', 'entry-meta step-time', step.time))
  if (step.meta) head.append(node('span', 'entry-meta', step.meta))
  const parts = [head]

  if (step.kind === 'rpc') {
    const { request, response, status: httpStatus, clipped } = step.rpc
    if (request === null && response === null) {
      parts.push(node('p', 'entry-note', RPC_ABSENT))
    } else {
      // Тела обрезал ХОСТ при записи трейса — это не обрезка страницы, и
      // смешивать их значило бы соврать о том, кто именно резал.
      if (clipped)
        parts.push(node('p', 'entry-note', 'Тело обрезал хост при записи трейса: показаны первые 64 КБ.'))
      const fold = node('details', 'fold')
      const summary = node('summary')
      summary.append(node('span', undefined, 'протокол вызова · запрос и ответ'))
      const mark = node('span', 'mark')
      mark.setAttribute('aria-hidden', 'true')
      summary.append(mark)
      // Ответа не пришло вовсе — единственное место ленты с --danger, и
      // слово рядом несёт тот же смысл, что цвет (пп. 8.1, 10).
      const broken = (response === null || response === '') && httpStatus === null
      if (broken) li.dataset.kind = 'fail'
      fold.append(
        summary,
        ...rpcBox(`req-${id}`, 'ЗАПРОС', request, { request: true }),
        ...rpcBox(`res-${id}`, 'ОТВЕТ', response, { broken }),
      )
      parts.push(fold)
    }
  }
  li.append(...parts)
  return li
}

function redrawSteps() {
  const list = steps(events)
  if (list.length === 0) return
  const mode = events.find((e) => e.stage === 'received')?.data?.mode ?? null
  stepsNote.replaceChildren(
    ...(mode === 'norag' ? [node('p', 'entry-note', NORAG_NOTE)] : []),
  )
  stepsList.replaceChildren(...list.map((step, i) => renderStep(step, i + 1)))
}

// ——— ответ и источники (пп. 5, 6) ———

function showAnswer(result) {
  answerEmpty.hidden = true
  const parts = []
  const meta = answerMeta(result)
  if (meta) parts.push(node('p', 'entry-meta', meta))
  parts.push(node('p', 'answer', result.answer))
  // Отказ промпта показывается ТЕМ ЖЕ цветом и размером: модель ответила,
  // вызов состоялся, деньги потрачены, граница поиска показана (п. 5.3).
  // Распознавать фразу страница не обязана — признак пришёл полем.
  if (result.refused) parts.push(node('p', 'entry-note', REFUSED_NOTE))
  if (result.truncated) parts.push(node('p', 'entry-note', ANSWER_CUT))
  answerBox.replaceChildren(...parts)
}

/**
 * Строка источника. Путь — ссылка на файл НА ТОМ КОММИТЕ, который назван в
 * шапке; коммита нет — путь остаётся текстом, а не ведёт в никуда (п. 6.3).
 * Раздела у фрагмента нет — ячейка пуста, заглушки «—» нет (I-8).
 */
function renderSource(src, commit, id) {
  const li = node('li', 'src')
  const grid = node('div', 'src-grid')
  grid.append(node('span', 'src-n', `[${src.n}]`))

  const path = node('span', 'src-path')
  const url = sourceUrl(src.source, commit)
  if (url !== null) {
    const a = node('a', undefined, src.source)
    a.href = url
    a.rel = 'noreferrer'
    path.append(a)
  } else {
    path.textContent = src.source
  }
  grid.append(path)
  grid.append(node('span', 'src-sec', src.section))
  grid.append(node('span', 'src-score', src.score === null ? '' : formatScore(src.score)))
  li.append(grid)

  // Текст фрагмента — свёрнутый details внутри строки (решение владельца В2).
  // Поля текста нет вовсе — свёртки нет, и строка остаётся целой (п. 10).
  const summaryText = fragmentSummary(src.text)
  if (summaryText !== null) {
    const fold = node('details', 'fold')
    const summary = node('summary')
    summary.append(node('span', undefined, summaryText))
    const mark = node('span', 'mark')
    mark.setAttribute('aria-hidden', 'true')
    summary.append(mark)
    const body = node('p', `frag${src.text === '' ? ' is-none' : ''}`, src.text === '' ? FRAGMENT_EMPTY : src.text)
    body.id = `frag-${id}`
    fold.append(summary, body)
    if (src.truncated)
      fold.append(node('p', 'entry-note', 'Фрагмент обрезала служба поиска при выдаче.'))
    li.append(fold)
  }
  return li
}

function showSources(result) {
  if (result.mode === 'norag') return showSrcsPlaceholder(SRCS_NORAG)
  if (result.sources.length === 0) return showSrcsPlaceholder(SRCS_FAILED)
  indexMetaBox.textContent = indexMeta(result)
  const notes = [shortSearchNote(result.sources), fragmentTextNote(result.sources)].filter(
    (t) => t !== null,
  )
  srcsNote.replaceChildren(...notes.map((t) => node('p', 'empty', t)))
  const commit = result.index?.commit ?? null
  srcsList.replaceChildren(...result.sources.map((src, i) => renderSource(src, commit, i + 1)))
}

/**
 * Отказ запуска. Каждый говорит СЛОВАМИ, был ли платный вызов (п. 8.1), и
 * слова чужой службы показываются, а не пересказываются: в них единственное
 * достоверное число. Кладутся они textContent и на короткую строку страница не
 * рассчитывает.
 */
function showFailure(error) {
  answerEmpty.hidden = true
  const f = failure(error, { status: errorData?.status ?? null })
  const box = node('div', 'notice')
  box.append(node('p', undefined, f.lead))
  if (f.words) box.append(node('p', 'words-of', f.words))
  if (f.tail) box.append(node('p', undefined, f.tail))
  answerBox.replaceChildren(box)
  showSrcsPlaceholder(SRCS_FAILED)
}

// ——— поток событий ———

function onEvent(raw) {
  let event
  try {
    event = JSON.parse(raw)
  } catch {
    return
  }
  if (!event || typeof event.stage !== 'string') return
  events.push(event)
  if (event.stage === 'error') errorData = event.data ?? null
  if (event.stage === 'received') {
    if (event.data?.mode === 'rag') {
      setStatus(STATUS.searching)
      showSrcsPlaceholder(SRCS_SEARCHING)
    } else {
      setStatus(STATUS.askingPlain)
    }
  }
  if (event.stage === 'planning') {
    fragmentsFound = Array.isArray(event.data?.sources) ? event.data.sources.length : null
    setStatus(fragmentsFound === null ? STATUS.askingPlain : STATUS.asking(fragmentsFound))
  }
  redrawSteps()
}

function onEnd(raw) {
  let end = null
  try {
    end = JSON.parse(raw)
  } catch {}
  if (end?.status === 'succeeded') {
    const result = parseResult(end.result)
    showAnswer(result)
    showSources(result)
    setStatus(result.durationMs === null ? 'Готово.' : STATUS.done(result.durationMs))
    return
  }
  showFailure(end?.error)
  setStatus(`Запуск завершился со статусом «${end?.status ?? 'неизвестно'}».`, true)
}

function lock(on) {
  input.disabled = on
  send.disabled = on
  for (const radio of radios) radio.disabled = on
}

function subscribe(runId) {
  stream = new EventSource(`api/runs/${encodeURIComponent(runId)}/events`)
  stream.addEventListener('event', (e) => onEvent(e.data))
  stream.addEventListener('end', (e) => {
    stream.close()
    stream = null
    lock(false)
    onEnd(e.data)
  })
  stream.onerror = () => {
    // Поток оборвался. Второй подписки не делаем — см. шапку файла.
    if (!stream) return
    stream.close()
    stream = null
    lock(false)
    setStatus(STATUS.torn, true)
    // «Показано записей: N» — число ЗАПИСЕЙ ЛЕНТЫ, а не событий: посетитель
    // видит записи, и считать надо то, что он видит (п. 10).
    const shown = stepsList.children.length
    if (shown === 0) showStepsPlaceholder('Поток событий оборвался. Показано записей: 0.')
    else stepsNote.append(node('p', 'entry-note', `Поток событий оборвался. Показано записей: ${shown}.`))
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (send.disabled) return
  const question = input.value.trim()
  if (!question) return setStatus(STATUS.empty, true)
  if (question.length > MAX_QUESTION) return setStatus(STATUS.long, true)
  const mode = chosenMode()

  lock(true)
  setStatus(STATUS.sent)

  let answer
  let json
  try {
    answer = await fetch('api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question, mode }),
    })
    json = await answer.json().catch(() => null)
  } catch {
    lock(false)
    return setStatus(STATUS.silent, true)
  }
  if (answer.status !== 202 || !json?.runId) {
    lock(false)
    const retry =
      answer.status === 429 && Number.isInteger(json?.retryAfterSec)
        ? ` Повторить можно через ${json.retryAfterSec} с.`
        : ''
    // Сообщение сервера не пересказывается: в нём единственное достоверное
    // число суточного предела.
    setStatus(`${json?.error ?? `Сервер ответил ${answer.status}.`}${retry}`, true)
    if (answer.status === 429) {
      answerEmpty.hidden = true
      const box = node('div', 'notice')
      box.append(node('p', undefined, DAY_LIMIT_NOTE))
      answerBox.replaceChildren(box)
    }
    return
  }
  // Запуск принят — только теперь пульт очищается. При отказе на экране
  // остаётся ровно то, что было: запуска не начиналось.
  resetRun()
  setStatus(mode === 'rag' ? STATUS.searching : STATUS.sent)
  subscribe(json.runId)
})

// Ctrl + Enter отправляет: поле многострочное, и Enter в нём переносит строку.
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) form.requestSubmit()
})

// ——— итоги десяти вопросов (п. 9) ———

const EVAL_NEVER =
  'Прогон 10 вопросов ещё не сделан. Числа появятся после первого прогона на проде.'
/** Файла нет или он не разбирается. Цветом --fg, не --danger: это отсутствие, а не авария (п. 10). */
const EVAL_UNREAD = 'Не удалось прочитать результаты прогона (eval.json).'

function renderQuestion(q) {
  const details = node('details', 'q')
  const summary = node('summary')
  summary.append(node('span', 'q-id', q.id ?? ''))
  summary.append(node('span', 'q-text', q.question))
  for (const [name, label] of [
    ['rag', 'С RAG'],
    ['norag', 'БЕЗ RAG'],
  ]) {
    const cell = node('span', 'q-v')
    cell.append(node('span', 'lbl', label))
    cell.append(node('span', undefined, verdictWord(q[name])))
    summary.append(cell)
  }
  details.append(summary)

  const body = node('div', 'q-body')
  if (q.sources.length === 0) {
    body.append(node('p', 'q-line', GENERAL_NOTE))
  } else {
    if (q.expect) {
      const block = node('div')
      block.append(node('p', 'lbl', 'ВЕРНЫЙ ОТВЕТ'), node('p', 'q-line is-main', q.expect))
      body.append(block)
    }
    const srcBlock = node('div')
    srcBlock.append(node('p', 'lbl', 'ИСТОЧНИК'))
    for (const path of q.sources) {
      const p = node('p', 'q-src')
      const a = node('a', undefined, path)
      a.href = `https://github.com/MikeKharr/ai-advent-2026/blob/main/${path}`
      a.rel = 'noreferrer'
      p.append(a)
      srcBlock.append(p)
    }
    body.append(srcBlock)
    if (q.key) {
      const keyBlock = node('div')
      keyBlock.append(node('p', 'lbl', 'КЛЮЧЕВАЯ ФРАЗА'), node('p', 'q-line', `«${q.key}»`))
      body.append(keyBlock)
    }
  }

  const sides = node('div', 'q-sides')
  for (const [name, label] of [
    ['rag', 'С RAG'],
    ['norag', 'БЕЗ RAG'],
  ]) {
    const mode = q[name]
    const side = node('div')
    // Вердикт — СЛОВО; цифра рубрики стоит рядом с ним, а не вместо него
    // (п. 9.4). Цветом вердикт не кодируется нигде.
    const word = verdictWord(mode)
    const digit = mode && !mode.refused && mode.verdict !== null ? ` (${mode.verdict})` : ''
    side.append(node('p', 'lbl', `${label} · ${word}${digit}`))
    if (mode === null) {
      side.append(node('p', 'q-line', NOT_RUN))
    } else {
      for (const row of mechanics(mode, { rag: name === 'rag' }))
        side.append(node('p', 'q-line', row))
      side.append(node('p', 'q-ans', mode.answer))
    }
    sides.append(side)
  }
  body.append(sides)
  details.append(body)
  return details
}

function showEval(parsed) {
  const t = tally(parsed)
  if (t.total === 0) {
    evalState.replaceChildren(node('p', 'empty', EVAL_NEVER))
    return
  }
  evalState.replaceChildren()
  evalBox.hidden = false

  // Четыре числа на режим. Все — из файла; ни одно не стоит в разметке.
  const sum = byId('sum')
  const head = [node('span', 'sum-head', ''), node('span', 'sum-head is-val', 'с RAG'), node('span', 'sum-head is-val', 'без RAG')]
  const rows = [
    ['верно и по источнику', 'correct'],
    ['частично', 'partial'],
    ['неверно или выдумано', 'wrong'],
    ['отказ «ответа нет»', 'refused'],
  ]
  const cells = []
  for (const [label, key] of rows) {
    cells.push(node('dt', undefined, label))
    cells.push(node('dd', undefined, String(t.counts.rag[key])))
    cells.push(node('dd', undefined, String(t.counts.norag[key])))
  }
  sum.replaceChildren(...head, ...cells)

  const partial = byId('sum-partial')
  const note = partialNote(t)
  partial.hidden = note === null
  partial.textContent = note ?? ''

  // Фраза вывода собирается из чисел, а не выбирается автором (п. 9.1). При
  // неполном прогоне её нет вовсе: десяти вопросов, о которых она говорит,
  // ещё не было.
  const v = verdict(t)
  const verdictBox = byId('sum-verdict')
  verdictBox.replaceChildren()
  if (v !== null) {
    const b = node('b', undefined, v.lead)
    verdictBox.append(b, document.createTextNode(v.text))
  }

  byId('eval-limits').textContent = limitsText(parsed)

  const method = byId('eval-method')
  const parts = [
    node(
      'p',
      undefined,
      'У каждого ответа проверены четыре вещи механикой: верный источник оказался среди ' +
        'найденных; путь источника назван в ответе; ключевая фраза эталона в ответе есть; ' +
        'ответ — отказ «В найденных фрагментах ответа нет».',
    ),
  ]
  // Имя судьи и рубрика выводятся ИЗ ФАЙЛА, не из разметки (п. 9.2). Нет их в
  // файле — нет и строки: выдумывать судью страница не станет.
  if (parsed.judge.name)
    parts.push(node('p', undefined, `Вердикт 0 / 1 / 2 ставил: ${parsed.judge.name}.`))
  if (parsed.judge.rubric) parts.push(node('p', undefined, `Рубрика: ${parsed.judge.rubric}`))
  method.replaceChildren(...parts)

  byId('qs').replaceChildren(...parsed.questions.map(renderQuestion))
}

async function loadEval() {
  let raw
  try {
    const answer = await fetch('eval.json')
    if (!answer.ok) throw new Error(String(answer.status))
    raw = await answer.json()
  } catch {
    evalState.replaceChildren(node('p', 'empty', EVAL_UNREAD))
    return
  }
  showEval(parseEval(raw))
}

resetRun()
setStatus('')
await loadEval()
