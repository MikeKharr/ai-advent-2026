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
  SUM_ROWS,
  tally,
  limitsText,
  verdict,
  verdictWord,
} from './evalview.js'
import { clipBody, partialNotes, reindent } from './rpc.js'
import {
  ANSWER_BLANK,
  ANSWER_CUT,
  ANSWER_TORN,
  answerMeta,
  dayLimitNote,
  failure,
  formatScore,
  fragmentSummary,
  fragmentTextNote,
  FRAGMENT_EMPTY,
  indexMeta,
  isBlank,
  MAX_QUESTION,
  MODE_WORD,
  NORAG_NOTE,
  parseResult,
  REFUSED_NOTE,
  repoUrl,
  RPC_ABSENT,
  RPC_BROKEN,
  RPC_EMPTY,
  shortSearchNote,
  sourceUrl,
  STATUS,
  steps,
  tornSrcsNote,
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

/** Статус запуска словом. Чего в карте нет — показывается как пришло. */
const STATUS_WORD = { failed: 'не удался', cancelled: 'отменён' }

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
/** Запуск принят, первого события ещё нет. Те же слова, что в пустоте (п. 10). */
const STEPS_RUNNING =
  'Шаги появятся здесь по мере того, как конвейер их проходит.'

/** Состояние пульта между запусками. Нигде не сохраняется. */
let events = []
let stream = null
let fragmentsFound = null
/**
 * Режим ЭТОГО запуска, а не текущее положение радиокнопки: к обрыву потока
 * кнопки уже отперты, и читать их значило бы спросить про другой запуск.
 */
let runMode = null
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

/**
 * Пульт к началу запуска.
 *
 * `starting` — запуск УЖЕ принят сервисом, и состояние блока «Ответ» здесь
 * «загрузка», а не «пусто»: три абзаца «Вопроса ещё не было…» рядом со строкой
 * «Спрашиваю модель…» противоречили бы друг другу (п. 10; находка
 * `design-review` к PR #303 — замер через 400 мс после отправки показывал
 * `#answer-empty.hidden === false`). Пустое состояние возвращается только
 * туда, где запуска не было: на загрузку страницы.
 */
function resetRun({ starting = false, mode = null } = {}) {
  events = []
  fragmentsFound = null
  runMode = starting ? mode : null
  errorData = null
  answerEmpty.hidden = starting
  answerBox.replaceChildren()
  // РЕЖИМ ОБЯЗАТЕЛЕН, когда запуск начинается. Поиска в режиме без RAG нет
  // вовсе, и строка «Ищу фрагменты…» висела бы весь запуск, объявляя
  // пройденным шаг, которого в этом режиме не бывает, — в той самой секции,
  // которая и есть предмет сравнения дня (находка `reviewer` к PR #303).
  // Прежняя редакция ставила её без учёта режима, и до конца запуска строку
  // не переписывал никто.
  showSrcsPlaceholder(
    !starting ? SRCS_NEVER : mode === 'norag' ? SRCS_NORAG : SRCS_SEARCHING,
  )
  showStepsPlaceholder(starting ? STEPS_RUNNING : STEPS_NEVER)
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

  // ВЫЗОВ ОБОРВАЛСЯ: ответа не пришло вовсе. Это единственное место ленты с
  // `--danger`, и цвет даёт правило самой копии дня 16
  // (`.entry[data-kind="fail"] .entry-note`) — а значит, строка обязана быть
  // `.entry-note`, а не `pre.rpc.is-empty`: тот окрашен `--fg-mut`, то есть
  // обрыв вызова читался бы как «служба ответила пустым». Замер в живом
  // Chrome: до правки цвет строки был rgb(155,155,163) вместо rgb(242,184,181)
  // в тёмной теме. Рамки тела здесь нет намеренно — заменять нечего, байтов не
  // было (раскладка, п. 10).
  if (missing && broken) {
    parts.push(node('p', 'entry-note', RPC_BROKEN))
    return parts
  }

  let shown = raw
  if (!missing) {
    const cut = clipBody(raw)
    if (cut.truncated) parts.push(node('p', 'trimmed', partialNotes.clipped(cut.total)))
    else if (!reindent(raw).ok) parts.push(node('p', 'entry-note', partialNotes.notJson))
    shown = cut.text
  }
  const box = node('pre', `rpc${missing ? ' is-empty' : ''}${request ? ' is-req' : ''}`, missing ? RPC_EMPTY : shown)
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
  // Пустой ответ при удачном запуске — не пустое место, а сказанная словами
  // пустота: строка меры остаётся, потому что токены потратились.
  if (isBlank(result.answer)) parts.push(node('p', 'empty', ANSWER_BLANK))
  else parts.push(node('p', 'answer', result.answer))
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
  // Слово статуса — по-русски: «failed» на русском экране читается как
  // техническая утечка (находка `design-review` к PR #303). Неизвестный
  // статус показывается как пришёл: выдумывать ему перевод нельзя.
  setStatus(`Запуск ${STATUS_WORD[end?.status] ?? `завершился со статусом «${end?.status ?? 'неизвестно'}»`}.`, true)
}

/**
 * Фокус был на том, что страница сейчас запрёт. Считается ПРИ ЗАПИРАНИИ:
 * позже этого уже не узнать — браузер снимает фокус с запертого элемента, и
 * `activeElement` становится `body`.
 *
 * Приём и его условия — дня 20 (`days/day20/public/app.js`), и здесь он нужен
 * по той же причине: без возврата фокуса каждый следующий вопрос с клавиатуры
 * начинается с поиска поля через весь порядок `Tab` (находка `design-review`
 * к PR #303: после отправки `activeElement` оставался `body`, и следующий
 * `Tab` попадал на радиокнопку, мимо поля — критерий 21 и п. 13.6).
 *
 * УГОНОМ ФОКУСА это не становится, и держат это два условия, оба обязательны:
 * возвращаем только тому, у кого забрали (`refocus`), и только если фокус до
 * сих пор лежит там, куда его уронило запирание (`activeElement === body`).
 * Ушёл посетитель за время запуска в тело протокола или на ссылку — флаг
 * гасится событием `focusin`, в момент ухода, пока узел ещё жив.
 */
let refocus = false

document.addEventListener('focusin', (event) => {
  // Ветви про кнопку здесь нет: на время запуска она заперта и фокус получить
  // не может, то есть условие было бы мёртвым (находка `reviewer` к PR #303).
  if (input.disabled && event.target !== input) refocus = false
})

function lock(on) {
  if (on) refocus = document.activeElement === input || document.activeElement === send
  input.disabled = on
  send.disabled = on
  for (const radio of radios) radio.disabled = on
  if (!on && refocus) {
    refocus = false
    if (document.activeElement === document.body) input.focus()
  }
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
    // ВСЕ ТРИ секции обязаны сказать про обрыв, а не только лента.
    //
    // Прежняя редакция переписывала лишь строку состояния и примечание ленты:
    // «Источники» оставались на `SRCS_SEARCHING` навсегда, объявляя идущим
    // поиск, которого уже нет, а блок «Ответ» был пустой областью высотой
    // 0 px — три утверждения на одном экране, два против третьего
    // (блокирующая `design-review` к PR #303). Тот же дефект в этом файле
    // закрыт дважды: для режима без RAG — в `resetRun`, для отказа запуска —
    // вызовом `showSrcsPlaceholder(SRCS_FAILED)` в `showFailure`; ветвь
    // обрыва осталась без него.
    //
    // Режим без RAG не трогаем: `resetRun` поставил там `SRCS_NORAG`, и обрыв
    // этого не меняет — поиска в этом режиме не было, и обрываться ему нечем.
    const tornNote = tornSrcsNote(runMode, fragmentsFound)
    if (tornNote !== null) showSrcsPlaceholder(tornNote)
    answerBox.replaceChildren(node('p', 'empty', ANSWER_TORN))
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
    // Какую строку ставить под отказом 429 — решает `dayLimitNote`, и решает
    // она одна: у правила «не называть суточный предел исчерпанным, когда он
    // не исчерпан» должен быть держатель, который исполняется. Условие,
    // стоявшее здесь в коде страницы, снималось мутацией молча — все 315
    // тестов оставались зелёными (находка `compliance` к PR #303).
    const limitNote = dayLimitNote(answer.status, json?.retryAfterSec)
    if (limitNote !== null) {
      answerEmpty.hidden = true
      const box = node('div', 'notice')
      box.append(node('p', undefined, limitNote))
      answerBox.replaceChildren(box)
    }
    return
  }
  // Запуск принят — только теперь пульт очищается. При отказе на экране
  // остаётся ровно то, что было: запуска не начиналось.
  resetRun({ starting: true, mode })
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
  // Маркер раскрытия: без него десять раскрываемых строк ничем не показывают,
  // что раскрываются (находка design-review к PR #304; п. 9.4). Состояние
  // сообщает сам `details`, поэтому знак скрыт от доступности.
  const mark = node('span', 'mark')
  mark.setAttribute('aria-hidden', 'true')
  summary.append(mark)
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
      // Адрес строит `repoUrl`, а не шаблонная строка: путь из файла — такие
      // же недоверенные данные, как путь из выдачи поиска, и кодируется так же
      // (находка `reviewer` к PR #303).
      const href = repoUrl(path)
      if (href === null) {
        p.textContent = path
      } else {
        const a = node('a', undefined, path)
        a.href = href
        a.rel = 'noreferrer'
        p.append(a)
      }
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
  // Каждая клетка подписана дважды — заголовком строки и заголовком столбца,
  // поэтому `th` со `scope`, а не «сетка из span»: иначе колонку «без RAG»
  // с клавиатуры и на слух не опознать.
  const sum = byId('sum')
  const headRow = node('tr')
  headRow.append(node('td', undefined, ''))
  for (const label of ['с RAG', 'без RAG']) {
    const th = node('th', undefined, label)
    th.scope = 'col'
    headRow.append(th)
  }
  const thead = node('thead')
  thead.append(headRow)
  const tbody = node('tbody')
  // Ярлыки строк приходят из `evalview.js`, а не стоят здесь: критерий 30
  // запрещает называть вердикт 0 выдумыванием, и запрет держится исполнением
  // по тому файлу, где стоит и фраза вывода.
  for (const [label, key] of SUM_ROWS) {
    const tr = node('tr')
    const th = node('th', undefined, label)
    th.scope = 'row'
    tr.append(th, node('td', undefined, String(t.counts.rag[key])), node('td', undefined, String(t.counts.norag[key])))
    tbody.append(tr)
  }
  sum.replaceChildren(thead, tbody)

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

/** Итоги читаются — сказано словами, а не пустой областью (п. 10). */
const EVAL_LOADING = 'Читаю результаты прогона…'

async function loadEval() {
  let raw
  // Строка ставится ДО запроса: иначе на месте секции стоит пустая область,
  // пока файл читается (находка `design-review` к PR #303, замер при
  // придушенной сети). Живым регионом она не делается — живой регион на
  // экране один, и это строка состояния пульта (п. 13.3).
  evalState.replaceChildren(node('p', 'empty', EVAL_LOADING))
  try {
    const answer = await fetch('eval.json')
    if (!answer.ok) throw new Error(String(answer.status))
    raw = await answer.json()
  } catch {
    // Цвет `--fg`, а не вторичный: п. 10 просит именно его — это отсутствие
    // файла, а не авария, поэтому и не `--danger`, но и не полушёпот.
    evalState.replaceChildren(node('p', 'unread', EVAL_UNREAD))
    return
  }
  showEval(parseEval(raw))
}

resetRun()
setStatus('')
await loadEval()
