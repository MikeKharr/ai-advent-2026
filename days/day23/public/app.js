// Проводка страницы дня 23 в экран. Правила показа тела JSON-RPC — в rpc.js
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
// пульт собирается из событий ОДНОГО запуска, итоги прогона читаются из файла
// `eval.json` независимо и отказом пульт не ломают (п. 17.3).

import {
  delta,
  EMPTY_PICK,
  EVAL_MODES,
  formatMetric,
  hasRun,
  limitsText,
  METRICS,
  NOT_RUN,
  parseEval,
  verdict,
} from './evalview.js'
import { clipBody, partialNotes, reindent } from './rpc.js'
import {
  answerBlock,
  ANSWER_CUT,
  costNote,
  ANSWER_TORN,
  answerMeta,
  dayLimitNote,
  failure,
  formatScore,
  fragmentSummary,
  fragmentTextNote,
  FRAGMENT_EMPTY,
  indexMeta,
  MAX_QUESTION,
  CANDIDATES_NONE,
  CANDIDATES_RAG,
  keptWord,
  parseResult,
  RAG_NOTE,
  relevanceWord,
  REWRITE_NOTE,
  REWRITTEN_NONE,
  fromWord,
  isUnknownFilter,
  PICK_RULE,
  planningReport,
  progress,
  rewriteGainNote,
  rewriteSearchNote,
  SELECT_NONE,
  selectionNote,
  selectNone,
  snippetSummary,
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
const rewrittenBox = byId('rewritten')
const pickNote = byId('pick-note')
const candsList = byId('cands')
const thresholdBox = byId('threshold-note')
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
    'без отбора: поиск отдаёт пять фрагментов, и они уходят в модель как есть. Один ' +
    'платный вызов, одна выдача — сравнивать будет не с чем.',
  rerank:
    'с отбором: поиск отдаёт десять кандидатов, вторая модель оценивает каждый, дальше ' +
    'идут только оценённые не ниже «относится» и не больше пяти. Два платных вызова. ' +
    'Может не остаться ничего — тогда так и будет написано.',
  rewrite:
    'с переписыванием: вопрос сначала переписывается в поисковый запрос, ищутся оба — ' +
    'исходный и переписанный, — выдачи объединяются, и дальше тот же отбор. Три платных ' +
    'вызова и два эмбеддинга.',
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
const SRCS_SEARCHING = 'Ищу фрагменты…'
/** Пустое состояние секции «Отбор» до запуска. */
const PICK_NEVER = 'Вопроса ещё не было: отбирать было нечего.'
const PICK_RUNNING = 'Кандидаты появятся здесь, когда поиск вернёт выдачу.'
/** Поток оборвался раньше, чем пришёл результат: кандидатов не будет. */
const PICK_TORN = 'Кандидаты не дошли: поток событий оборвался раньше результата.'
const PICK_FAILED = 'Отбора не было — что именно случилось, сказано выше в ответе.'
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
 * Секция «Отбор» словами. Она обязана сказать что-то ВСЕГДА: пустая область
 * под собственным заголовком — та же заглушка, что прочерк (I-8), и в дне 23
 * это главная новая секция экрана.
 */
function showPickPlaceholder(text, { rewritten = null } = {}) {
  candsList.replaceChildren()
  thresholdBox.textContent = ''
  rewrittenBox.replaceChildren(
    ...(rewritten === null ? [] : [node('p', 'lbl', 'ПЕРЕПИСАННЫЙ ЗАПРОС'), node('p', 'rewritten', rewritten)]),
  )
  pickNote.replaceChildren(node('p', 'empty', text))
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
  // Поиск идёт во всех трёх режимах дня 23, поэтому «Ищу фрагменты…» верно
  // для любого из них. Режим всё равно передаётся: секция «Отбор» в режиме
  // `rag` обязана сказать, что второй ступени в нём НЕ БУДЕТ, — иначе она
  // весь запуск обещает кандидатов, которых не бывает (тот же дефект, что
  // нашёл `reviewer` в дне 22 для строки поиска в режиме без RAG).
  showSrcsPlaceholder(starting ? SRCS_SEARCHING : SRCS_NEVER)
  showPickPlaceholder(
    !starting ? PICK_NEVER : mode === 'rag' ? CANDIDATES_RAG : PICK_RUNNING,
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
    ...(mode === 'rag' ? [node('p', 'entry-note', RAG_NOTE)] : []),
    ...(mode === 'rerank' ? [node('p', 'entry-note', REWRITE_NOTE)] : []),
  )
  stepsList.replaceChildren(...list.map((step, i) => renderStep(step, i + 1)))
}

// ——— ответ и источники (пп. 5, 6) ———

function showAnswer(result) {
  answerEmpty.hidden = true
  const parts = []
  const meta = answerMeta(result)
  if (meta) parts.push(node('p', 'entry-meta', meta))
  // Полного расхода запуска по числам экрана не видно, и сказано это словами,
  // а не умолчанием. КАКИМИ именно словами — решает `costNote`: при исходе без
  // вызова ответа число в мере значит другое, и примечание тоже другое.
  const cost = costNote(result)
  if (cost !== null) parts.push(node('p', 'entry-note', cost))

  // ЧТО ИМЕННО СТОИТ В БЛОКЕ — решает `answerBlock`, и решает она одна: у
  // правила «не говорить про состоявшийся вызов там, где модель не звали»
  // должен быть держатель, который исполняется. Условие, стоявшее здесь, в
  // коде страницы, снималось мутацией молча — все тесты оставались зелёными
  // (своя проверка мутацией при сборке PR; тот же урок, что у `dayLimitNote`
  // в дне 22).
  const block = answerBlock(result)
  parts.push(node('p', block.kind === 'blank' ? 'empty' : 'answer', block.text))
  // Отказ промпта показывается ТЕМ ЖЕ цветом и размером: модель ответила,
  // вызов состоялся, деньги потрачены, граница поиска показана (п. 5.3).
  // Распознавать фразу страница не обязана — признак пришёл полем.
  if (block.refusedNote) parts.push(node('p', 'entry-note', REFUSED_NOTE))
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
  // Номер — тот, что присвоил агент при объединении выдач, и он НЕ
  // перенумеровывается: под ним фрагмент стоит в тексте ответа. У оставшихся
  // после отбора номера идут с пропусками, и это верно. Поля нет — скобок
  // нет: порядковое место в списке номером фрагмента не является (I-8).
  grid.append(node('span', 'src-n', src.n === null ? '' : `[${src.n}]`))

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

/**
 * Одна строка кандидата — выдача ДО отбора. Отброшенный кандидат остаётся на
 * экране со своей оценкой: он и есть предмет показа дня, и спрятать его
 * значило бы показать только то, с чем модель согласилась.
 */
function renderCandidate(cand, commit) {
  const li = node('li', `cand${cand.kept ? '' : ' is-out'}`)
  const grid = node('div', 'cand-grid')
  grid.append(node('span', 'cand-n', cand.n === null ? '' : `[${cand.n}]`))

  const path = node('span', 'cand-path')
  const url = sourceUrl(cand.source, commit)
  if (url !== null) {
    const a = node('a', undefined, cand.source)
    a.href = url
    a.rel = 'noreferrer'
    path.append(a)
  } else {
    path.textContent = cand.source
  }
  grid.append(path)
  grid.append(node('span', 'cand-sec', cand.section))

  // Ярлык колонки внутри строки: на узком экране колонок нет, и число без
  // подписи не читается. Имя ячейки не выдумывается — оно то же, что в полосе
  // заголовков выше.
  const cell = (cls, label, text) => {
    const span = node('span', cls)
    span.append(node('span', 'lbl', label))
    span.append(node('span', undefined, text))
    return span
  }
  // Близость не измерена — ячейка пуста, а не «0,000» (I-8).
  grid.append(cell('cand-score', 'БЛИЗОСТЬ', cand.score === null ? '' : formatScore(cand.score)))
  // Реранкер не оценивал — ячейка пуста: «не оценивал» это не «оценил нулём».
  grid.append(
    cell(
      'cand-rel',
      'РЕЛЕВАНТНОСТЬ',
      cand.relevance === null ? '' : `${cand.relevance} · ${relevanceWord(cand.relevance)}`,
    ),
  )
  grid.append(cell('cand-kept', 'ИТОГ', keptWord(cand.kept)))
  li.append(grid)

  // Откуда кандидат пришёл — в режиме `rewrite` это и есть ответ на вопрос
  // «что дало переписывание». В режиме `rerank` поля нет, и строки нет.
  const from = fromWord(cand.from)
  if (from !== '') li.append(node('p', 'cand-from', `нашёл: ${from}`))

  // Выдержка — РОВНО ТО, что видел реранкер (400 знаков). Полного текста у
  // кандидата нет, и страница его не достраивает: показывать длиннее значило
  // бы показать не то, по чему он решал.
  const summaryText = snippetSummary(cand.snippet)
  if (summaryText !== null) {
    const fold = node('details', 'fold')
    const summary = node('summary')
    summary.append(node('span', undefined, summaryText))
    const mark = node('span', 'mark')
    mark.setAttribute('aria-hidden', 'true')
    summary.append(mark)
    fold.append(
      summary,
      node('p', `frag${cand.snippet === '' ? ' is-none' : ''}`, cand.snippet === '' ? FRAGMENT_EMPTY : cand.snippet),
    )
    li.append(fold)
  }
  return li
}

/**
 * Секция «Отбор». Режим `rag` отбора не делает — так и сказано; отбор был, а
 * кандидатов не пришло — сказано и это; кандидаты пришли, а не осталось
 * никого — честный исход «не знаю», и он назван своим именем.
 */
function showPick(result) {
  if (result.mode === 'rag') return showPickPlaceholder(CANDIDATES_RAG)

  const rewritten =
    result.mode === 'rewrite' ? (result.rewritten ?? REWRITTEN_NONE) : null
  if (result.candidates.length === 0) return showPickPlaceholder(CANDIDATES_NONE, { rewritten })

  rewrittenBox.replaceChildren(
    ...(rewritten === null
      ? []
      : [node('p', 'lbl', 'ПЕРЕПИСАННЫЙ ЗАПРОС'), node('p', 'rewritten', rewritten)]),
  )
  // Что стало со вторым поиском — ПЕРВОЙ строкой секции: от этого зависит,
  // полна ли выдача, которую посетитель ниже увидит.
  const notes = [rewriteSearchNote(result), selectionNote(result), rewriteGainNote(result)].filter(
    (t) => t !== null,
  )
  // Пустой отбор — ИСХОД, и слова о нём стоят здесь, над таблицей, а не
  // только в секции источников: решение приняла эта секция, ей и отвечать.
  if (isUnknownFilter(result)) notes.push(selectNone(result.candidates.length))
  pickNote.replaceChildren(...notes.map((t) => node('p', 'empty', t)))
  const commit = result.index?.commit ?? null
  candsList.replaceChildren(...result.candidates.map((c) => renderCandidate(c, commit)))
  thresholdBox.textContent = PICK_RULE
}

function showSources(result) {
  // Отбор ничего не оставил — это исход, а не отказ поиска, и секция говорит
  // ровно это. Прежняя (дня 22) ветвь ставила сюда «Поиск отказал», и честное
  // «не знаю» читалось бы как сбой — тот самый долг, который закрывает день 23
  // (развилка Р8 ADR 2026-10-05-0544).
  if (result.sources.length === 0) {
    showSrcsPlaceholder(isUnknownFilter(result) ? selectNone(result.candidates.length) : SRCS_FAILED)
    // Коммит индекса и имя стратегии с экрана НЕ исчезают, когда поиск был:
    // ссылки кандидатов ведут ровно на этот коммит, и шапка обязана его
    // назвать (п. 6.2 раскладки дня 22; находка `design-review` к PR #313).
    if (isUnknownFilter(result)) indexMetaBox.textContent = indexMeta(result)
    return
  }
  indexMetaBox.textContent = indexMeta(result)
  const notes = [shortSearchNote(result), fragmentTextNote(result.sources)].filter(
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
  showPickPlaceholder(PICK_FAILED)
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
  // Поиск идёт во ВСЕХ трёх режимах дня 23, поэтому «Ищу фрагменты по
  // проекту…» верно для любого из них. Ветви «режим без поиска» здесь больше
  // нет: она была бы мёртвой, а мёртвая ветвь на платном экране однажды
  // оживает не тем боком.
  if (event.stage === 'received') {
    setStatus(STATUS.searching)
    showSrcsPlaceholder(SRCS_SEARCHING)
  }
  if (event.stage === 'planning') {
    // Стадий `planning` в дне 23 до трёх, и говорят они о РАЗНОМ. Что при этом
    // показывать — решает `progress`, и решает она одна: три текста, стоявшие
    // здесь, держателя не имели и врали дважды (блокирующая `reviewer`,
    // второй круг). `null` значит «это событие числа выдачи не меняет», и
    // прежнее состояние остаётся прежним — на этом стоит правило обрыва.
    const report = planningReport(event)
    if (report !== null) {
      // Для правила обрыва важно ТОЛЬКО то, доложился ли поиск: число отбора
      // этого не говорит и сюда не попадает.
      if (report.kind === 'found') fragmentsFound = report.found
      const shown = progress(event, runMode)
      setStatus(shown.status)
      showSrcsPlaceholder(shown.srcs)
      if (shown.pick !== null) showPickPlaceholder(shown.pick)
    }
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
    showPick(result)
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
    // Незнакомый режим не трогаем: выдумывать слова про поиск для режима,
    // которого страница не знает, нельзя — решает это `tornSrcsNote`.
    const tornNote = tornSrcsNote(runMode, fragmentsFound)
    if (tornNote !== null) showSrcsPlaceholder(tornNote)
    // Секция «Отбор» — третья, которая обязана сказать про обрыв. В режиме
    // `rag` её слова не трогаем: отбора там и не ожидалось.
    if (runMode !== null && runMode !== 'rag') showPickPlaceholder(PICK_TORN)
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

// ——— итоги прогона: до отбора и после (ADR 2026-10-05-0544, п. 1.5) ———

const EVAL_NEVER =
  'Прогон ещё не сделан. Числа появятся после первого прогона на проде.'
/** Файла нет или он не разбирается. Цветом --fg, не --danger: это отсутствие, а не авария. */
const EVAL_UNREAD = 'Не удалось прочитать результаты прогона (eval.json).'

/** Клетка сводки. Числа — только из файла; ни одно не стоит в разметке. */
function sumCell(value) {
  return node('td', undefined, formatMetric(value))
}

/**
 * Сводка: на каждый режим — две метрики, и у каждой три числа: до отбора,
 * после отбора и разность. Таблица настоящая, потому что у каждой клетки есть
 * и заголовок строки, и заголовок столбца.
 */
function renderSummary(parsed) {
  const sum = byId('sum')
  const headRow = node('tr')
  headRow.append(node('td', undefined, ''))
  for (const label of ['до отбора', 'после отбора', 'разница']) {
    const th = node('th', undefined, label)
    th.scope = 'col'
    headRow.append(th)
  }
  const thead = node('thead')
  thead.append(headRow)
  const tbody = node('tbody')
  for (const [key, word] of EVAL_MODES) {
    const mode = parsed.modes[key]
    for (const [metric, name] of METRICS) {
      const tr = node('tr')
      const th = node('th', undefined, `${name}, ${word}`)
      th.scope = 'row'
      if (mode === null) {
        tr.append(th)
        const td = node('td', undefined, NOT_RUN)
        td.colSpan = 3
        tr.append(td)
      } else {
        tr.append(
          th,
          sumCell(mode.before[metric]),
          sumCell(mode.after[metric]),
          node('td', undefined, delta(mode.before[metric], mode.after[metric])),
        )
      }
      tbody.append(tr)
    }
    // Честный исход — СВОЯ СТРОКА сводки, а не ноль в ведре с промахами.
    // Это долг дня 22, закрываемый здесь (развилка Р8): там отказ и выдумка
    // попадали в один вердикт 0.
    if (mode !== null && mode.emptyPicks !== null) {
      const tr = node('tr')
      const th = node('th', undefined, `отбор ничего не оставил, ${word}`)
      th.scope = 'row'
      const td = node('td', undefined, String(mode.emptyPicks))
      td.colSpan = 3
      tr.append(th, td)
      tbody.append(tr)
    }
  }
  sum.replaceChildren(thead, tbody)
}

/** Одна строка вопроса. Раскрывается в числа обоих режимов. */
function renderQuestion(q) {
  const details = node('details', 'q')
  const summary = node('summary')
  summary.append(node('span', 'q-id', q.id))
  summary.append(node('span', 'q-text', q.question))
  for (const [key, word] of EVAL_MODES) {
    const cell = node('span', 'q-v')
    cell.append(node('span', 'lbl', word.toUpperCase()))
    const mode = q[key]
    // Вердиктов у этого дня нет — есть число. Пустой отбор назван словом, а
    // не нулём: ноль здесь читался бы как «ничего не нашёл».
    // Прочерка на месте отсутствующих данных нет (п. 16.7 раскладки дня 22):
    // «не прогнан» — слово, и то же самое слово развёрнуто стоит в теле строки.
    const text =
      mode === null ? 'не прогнан' : mode.empty ? 'не знаю' : formatMetric(mode.after.mrr10)
    cell.append(node('span', undefined, text))
    summary.append(cell)
  }
  const mark = node('span', 'mark')
  mark.setAttribute('aria-hidden', 'true')
  summary.append(mark)
  details.append(summary)

  const body = node('div', 'q-body')
  if (q.expect.length > 0) {
    const srcBlock = node('div')
    srcBlock.append(node('p', 'lbl', 'ВЕРНЫЙ ИСТОЧНИК'))
    for (const path of q.expect) {
      const p = node('p', 'q-src')
      // Адрес строит `repoUrl`: путь из файла — такие же недоверенные данные,
      // как путь из выдачи поиска, и кодируется так же.
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
  }

  const sides = node('div', 'q-sides')
  for (const [key, word] of EVAL_MODES) {
    const mode = q[key]
    const side = node('div')
    side.append(node('p', 'lbl', word.toUpperCase()))
    if (mode === null) {
      side.append(node('p', 'q-line', NOT_RUN))
    } else {
      if (mode.empty) side.append(node('p', 'q-line is-main', EMPTY_PICK))
      for (const [metric, name] of METRICS) {
        const before = formatMetric(mode.before[metric])
        const after = formatMetric(mode.after[metric])
        // Нет числа — нет строки. Прочерка на его месте не ставится (I-8).
        if (before === '' && after === '') continue
        side.append(
          node('p', 'q-line', `${name}: до ${before || 'нет числа'} → после ${after || 'нет числа'}`),
        )
      }
      if (mode.candidates !== null)
        side.append(
          node('p', 'q-line', `кандидатов ${mode.candidates}, оставлено ${mode.kept ?? 'нет числа'}`),
        )
    }
    sides.append(side)
  }
  body.append(sides)
  details.append(body)
  return details
}

function showEval(parsed) {
  if (!hasRun(parsed)) {
    evalState.replaceChildren(node('p', 'empty', EVAL_NEVER))
    return
  }
  evalState.replaceChildren()
  evalBox.hidden = false

  renderSummary(parsed)

  const partial = byId('sum-partial')
  // Прогон неполон — сказано числом из файла, а не умолчанием.
  const ran = EVAL_MODES.map(([key]) => parsed.modes[key]?.ran ?? null).filter((v) => v !== null)
  const short = parsed.total !== null && ran.some((v) => v < parsed.total)
  partial.hidden = !short
  partial.textContent = short
    ? `Прогон неполон: вопросов в наборе ${parsed.total}, прогнано ${ran.join(' и ')}.`
    : ''

  // Фраза вывода при НЕПОЛНОМ прогоне не выводится вовсе — как в дне 22
  // (п. 10): она говорит про набор, которого ещё не было, и рядом со строкой
  // «прогон неполон» читалась бы как итог (находка `design-review` к PR #313).
  const v = short ? null : verdict(parsed)
  const verdictBox = byId('sum-verdict')
  verdictBox.replaceChildren()
  if (v !== null) {
    verdictBox.append(node('b', undefined, v.lead), document.createTextNode(v.text))
  }

  byId('eval-limits').textContent = limitsText(parsed)

  const method = byId('eval-method')
  const parts = [
    node(
      'p',
      undefined,
      'Обе метрики считаются дважды из ОДНОГО запуска: по выдаче до отбора в порядке ' +
        'близости и по выдаче после него. Второго индекса и второго прогона для этого ' +
        'не нужно.',
    ),
    node(
      'p',
      undefined,
      'Судьи в этом дне нет: верный документ вопроса известен заранее, и ранг считается ' +
        'сравнением путей, а не поиском пути подстрокой в тексте ответа.',
    ),
  ]
  // Слова прогона о самом себе показываются, а не пересказываются.
  if (parsed.note) parts.push(node('p', undefined, parsed.note))
  method.replaceChildren(...parts)

  byId('qs').replaceChildren(...parsed.questions.map(renderQuestion))
}

/** Итоги читаются — сказано словами, а не пустой областью. */
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
    // ФАЙЛА НЕТ и ФАЙЛ НЕ ЧИТАЕТСЯ — разные случаи, и сливать их нельзя:
    // пока прогона не было, 404 — это «ещё не делали», а не «сбой чтения».
    // README дня обещает именно первое, а экран говорил второе (находка
    // `reviewer` к PR #313).
    if (answer.status === 404) {
      evalState.replaceChildren(node('p', 'empty', EVAL_NEVER))
      return
    }
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
