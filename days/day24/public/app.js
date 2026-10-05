// Проводка страницы дня 24 в экран. Правила показа тела JSON-RPC — в rpc.js
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
  GENERAL_NOTE,
  JUDGE_ROWS,
  limitsText,
  mechanics,
  NOT_RUN,
  OUTCOME_ROWS,
  outcomeWord,
  parseEval,
  partialNote,
  tally,
  verdict,
  verdictWord,
} from './evalview.js'
import { clipBody, partialNotes, reindent } from './rpc.js'
import {
  answerBlock,
  ANSWER_CUT,
  ANSWER_TORN,
  answerMeta,
  CHECK_ROWS,
  CHECKS_NONE,
  checkWord,
  CITED_RULE,
  citedNote,
  claimedNote,
  CLARIFY_LABEL,
  dayLimitNote,
  fragmentsFromPlanning,
  statusFor,
  failedSections,
  failure,
  formatScore,
  fragmentSummary,
  fragmentTextNote,
  FRAGMENT_EMPTY,
  indexMeta,
  MAX_QUESTION,
  CANDIDATES_NONE,
  keptWord,
  parseResult,
  QUOTE_EMPTY,
  quotesNote,
  quotesTally,
  quoteWord,
  relevanceWord,
  REWRITE_NOTE,
  REWRITTEN_NONE,
  fromWord,
  isUnknownFilter,
  PICK_RULE,
  selectionNote,
  selectNone,
  snippetSummary,
  repoUrl,
  RPC_ABSENT,
  RPC_BROKEN,
  RPC_EMPTY,
  sourceUrl,
  STATUS,
  steps,
  tornSrcsNote,
  UNVERIFIED_NOTE,
  VERBATIM_NOTE,
} from './run.js'

const byId = (id) => document.getElementById(id)
const form = byId('ask')
const input = byId('q')
const send = byId('send')
const status = byId('status')
const answerEmpty = byId('answer-empty')
const answerBox = byId('answer')
const indexMetaBox = byId('index-meta')
const srcsNote = byId('srcs-note')
const srcsList = byId('srcs')
const stepsNote = byId('steps-note')
const stepsList = byId('steps')
const checksNote = byId('checks-note')
const checksList = byId('checks')
const verbatimBox = byId('verbatim-note')
const citedRuleBox = byId('cited-rule')
const citedNoteBox = byId('cited-note')
const citedList = byId('cited')
const quotesNoteBox = byId('quotes-note')
const quotesList = byId('quotes')
const unverifiedBox = byId('unverified-note')
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

// ПЕРЕКЛЮЧАТЕЛЯ РЕЖИМА ЗДЕСЬ НЕТ. Режим один, называет его сервер дня
// (ADR 2026-10-05-0544, п. 2.4), и страница узнаёт его из события `received`
// того же запуска — не из разметки и не из своего умолчания. Поэтому и подписи
// «что будет, если выбрать» тут нет: выбирать нечего.

// ——— пустые состояния пульта (п. 10) ———

const SRCS_NEVER = 'Вопроса ещё не было: искать было нечего.'
const SRCS_SEARCHING = 'Ищу фрагменты…'
/** Пустое состояние секции «Отбор» до запуска. */
const PICK_NEVER = 'Вопроса ещё не было: отбирать было нечего.'
const PICK_RUNNING = 'Кандидаты появятся здесь, когда поиск вернёт выдачу.'
/** Поток оборвался раньше, чем пришёл результат: кандидатов не будет. */
const PICK_TORN = 'Кандидаты не дошли: поток событий оборвался раньше результата.'

/** Пустые состояния трёх секций дня 24 — до запуска, во время и при отказе. */
const CHECKS_NEVER = 'Вопроса ещё не было: проверять было нечего.'
const CHECKS_RUNNING = 'Проверки появятся, когда придёт ответ: их считает код по его полям.'
const CHECKS_FAILED = 'Проверок не было — ответа, который они проверяют, не случилось.'
const CHECKS_TORN = 'Проверки не дошли: поток событий оборвался раньше результата.'
const CITED_NEVER = 'Вопроса ещё не было: ссылаться было не на что.'
const CITED_RUNNING = 'Источники, на которые сошлётся модель, появятся вместе с ответом.'
const CITED_FAILED = 'Ссылок не было — ответа не случилось.'
const CITED_TORN = 'Ссылки не дошли: поток событий оборвался раньше результата.'
const QUOTES_NEVER = 'Вопроса ещё не было: цитировать было нечего.'
const QUOTES_RUNNING = 'Цитаты появятся вместе с ответом — уже сверенными с текстами фрагментов.'
const QUOTES_FAILED = 'Цитат не было — ответа не случилось.'
const QUOTES_TORN = 'Цитаты не дошли: поток событий оборвался раньше результата.'
/**
 * Секция источников при ПУСТОЙ выдаче удачного запуска. Это не отказ: запуск
 * дошёл до конца, и что именно случилось, сказано исходом выше.
 */
const SRCS_FAILED = 'Фрагментов на экране нет — что именно случилось, сказано выше в ответе.'
const STEPS_NEVER =
  'Запуска ещё не было. Шаги появятся здесь по мере того, как конвейер их проходит.'
/** Запуск принят, первого события ещё нет. Те же слова, что в пустоте (п. 10). */
const STEPS_RUNNING =
  'Шаги появятся здесь по мере того, как конвейер их проходит.'

/** Состояние пульта между запусками. Нигде не сохраняется. */
let events = []
let stream = null
/**
 * Что КОНВЕЙЕР УСПЕЛ СКАЗАТЬ про числа: сколько нашёл поиск и сколько оставил
 * отбор. Два поля, а не одно: «поиск вернул 10» и «в модель ушло 2» — разные
 * утверждения, и строка обрыва спрашивает именно про первое.
 */
let counts = { found: null, kept: null }
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
 * под собственным заголовком — та же заглушка, что прочерк (I-8), и в дне 24
 * это главная новая секция экрана.
 */
/**
 * Три секции дня 24 словами. Каждая обязана сказать что-то ВСЕГДА: пустая
 * область под собственным заголовком — та же заглушка, что прочерк (I-8).
 */
function showChecksPlaceholder(text) {
  checksList.replaceChildren()
  verbatimBox.textContent = ''
  checksNote.replaceChildren(node('p', 'empty', text))
}

function showCitedPlaceholder(text) {
  citedList.replaceChildren()
  citedNoteBox.replaceChildren(node('p', 'empty', text))
}

function showQuotesPlaceholder(text) {
  quotesList.replaceChildren()
  unverifiedBox.textContent = ''
  quotesNoteBox.replaceChildren(node('p', 'empty', text))
}

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
function resetRun({ starting = false } = {}) {
  events = []
  counts = { found: null, kept: null }
  runMode = null
  errorData = null
  answerEmpty.hidden = starting
  answerBox.replaceChildren()
  // Поиск и отбор идут в ОБОИХ режимах дня 24, поэтому «Ищу фрагменты…» и
  // «Кандидаты появятся…» верны при любом из них, и режим для этих слов не
  // нужен: он приходит событием `received` и записывается в `runMode` там.
  showSrcsPlaceholder(starting ? SRCS_SEARCHING : SRCS_NEVER)
  showPickPlaceholder(starting ? PICK_RUNNING : PICK_NEVER)
  showChecksPlaceholder(starting ? CHECKS_RUNNING : CHECKS_NEVER)
  showCitedPlaceholder(starting ? CITED_RUNNING : CITED_NEVER)
  showQuotesPlaceholder(starting ? QUOTES_RUNNING : QUOTES_NEVER)
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

  // ЧТО ИМЕННО СТОИТ В БЛОКЕ — решает `answerBlock`, и решает она одна: у
  // правила «не говорить про состоявшийся вызов там, где модель не звали»
  // должен быть держатель, который исполняется. Условие, стоявшее здесь, в
  // коде страницы, снималось мутацией молча — все тесты оставались зелёными
  // (своя проверка мутацией при сборке PR; тот же урок, что у `dayLimitNote`
  // в дне 22).
  const block = answerBlock(result)
  parts.push(node('p', block.kind === 'blank' ? 'empty' : 'answer', block.text))
  // ИСХОД — ТЕМ ЖЕ цветом и размером, что примечания ленты: «не знаю» это
  // результат, а не авария, и красить его как сбой значило бы назвать честный
  // исход поломкой (находка `design-review` к дню 22, закрытая здесь формой).
  parts.push(node('p', 'entry-note', block.note))
  // Уточняющий вопрос — часть исхода «не знаю», и он стоит В БЛОКЕ ОТВЕТА, а
  // не отдельной секцией: посетитель читает его там, где прочёл «не знаю».
  // Нет вопроса — нет и ярлыка: пустая подпись была бы заглушкой (I-8).
  if (result.clarification !== null) {
    parts.push(node('p', 'lbl', CLARIFY_LABEL))
    parts.push(node('p', 'clarify', result.clarification))
  }
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
  // Раздел — ВТОРОЙ СТРОКОЙ В КОЛОНКЕ ПУТИ, а не шестой ячейкой: колонок пять,
  // и шестая ячейка уезжала на вторую строку сетки, под чужой заголовок.
  // Полоса заголовков называет эту колонку «путь и раздел» — теперь честно.
  const where = node('div', 'cand-where')
  where.append(path)
  if (cand.section !== '') where.append(node('p', 'cand-sec', cand.section))
  grid.append(where)

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
  // Ветви «режим без отбора» здесь НЕТ: в дне 24 отбор идёт при любом режиме
  // (контракт, «Вход»), и условие было бы мёртвым.
  const rewritten =
    result.mode === 'rewrite' ? (result.rewritten ?? REWRITTEN_NONE) : null
  if (result.candidates.length === 0) return showPickPlaceholder(CANDIDATES_NONE, { rewritten })

  rewrittenBox.replaceChildren(
    ...(rewritten === null
      ? []
      : [node('p', 'lbl', 'ПЕРЕПИСАННЫЙ ЗАПРОС'), node('p', 'rewritten', rewritten)]),
  )
  const notes = [selectionNote(result)].filter((t) => t !== null)
  // Пустой отбор — ИСХОД, и слова о нём стоят здесь, над таблицей, а не
  // только в секции источников: решение приняла эта секция, ей и отвечать.
  if (isUnknownFilter(result)) notes.push(selectNone(result.candidates.length))
  pickNote.replaceChildren(...notes.map((t) => node('p', 'empty', t)))
  const commit = result.index?.commit ?? null
  candsList.replaceChildren(...result.candidates.map((c) => renderCandidate(c, commit)))
  thresholdBox.textContent = PICK_RULE
}

/**
 * ЧЕТЫРЕ ПРОВЕРКИ. Признаки приходят полем `checks`; страница их не считает
 * заново — иначе на экране жило бы второе правило достоверности, и расходилось
 * бы с тем, по которому считает прогон.
 *
 * Значение несёт СЛОВО, а не цвет: «нет» у третьей проверки — наблюдение, а не
 * авария, и красить его как сбой значило бы вынести вердикт вместо факта.
 */
function showChecks(result) {
  if (result.checks === null) return showChecksPlaceholder(CHECKS_NONE)
  checksNote.replaceChildren()
  checksList.replaceChildren(
    ...CHECK_ROWS.map(([key, label]) => {
      const li = node('li', 'check')
      li.append(node('span', 'check-val', checkWord(result.checks[key])))
      li.append(node('span', 'check-name', label))
      return li
    }),
  )
  verbatimBox.textContent = VERBATIM_NOTE
}

/**
 * НА ЧТО СОСЛАЛАСЬ МОДЕЛЬ. Те же строки, что у источников, и тот же
 * `renderSource`: форма одна, потому что предмет один — фрагмент. Текста у
 * процитированного фрагмента нет (его в `cited` не присылают), и свёртка не
 * появляется — строка остаётся целой.
 */
function showCited(result) {
  const note = citedNote(result)
  if (note !== null) return showCitedPlaceholder(note)
  citedNoteBox.replaceChildren()
  const commit = result.index?.commit ?? null
  citedList.replaceChildren(
    ...result.cited.map((src, i) => {
      const li = renderSource({ ...src, score: null, text: null, truncated: false }, commit, `c${i + 1}`)
      // ЧТО НАЗВАЛА САМА МОДЕЛЬ — рядом с настоящим путём, и только когда это
      // расходится. Без этой строки расхождение видно одной клеткой «нет» в
      // проверках, без имени: экран показывал бы чужой путь как названный ею.
      // Решает `claimedNote`, а не условие здесь: правило должно исполняться.
      const claimed = claimedNote(src)
      if (claimed !== null) li.append(node('p', 'claimed', claimed))
      return li
    }),
  )
}

/**
 * ЦИТАТЫ СО СВЕРКОЙ. Пометка приходит полем `verified` — сверку делает агент
 * по тексту фрагмента, как его отдала служба, и страница её не повторяет.
 *
 * Неподтверждённая цитата НЕ выбрасывается и ничем не прячется: иначе экран
 * показывал бы только удачные сверки, то есть мерил бы старательность вместо
 * достоверности.
 *
 * Путь фрагмента берётся по номеру из того, что ушло модели (`sources`), —
 * чтобы цитата стояла рядом с тем фрагментом, из которого её проверяли. Номера
 * нет в выдаче — пути нет: выдумывать его страница не станет (I-8).
 */
function showQuotes(result) {
  const note = quotesNote(result)
  if (note !== null) return showQuotesPlaceholder(note)
  quotesNoteBox.replaceChildren(node('p', 'empty', quotesTally(result.quotes)))
  const commit = result.index?.commit ?? null
  quotesList.replaceChildren(
    ...result.quotes.map((q) => {
      const li = node('li', 'quote')
      const head = node('div', 'quote-head')
      head.append(node('span', 'quote-n', q.n === null ? '' : `[${q.n}]`))
      const from = result.sources.find((src) => src.n !== null && src.n === q.n) ?? null
      if (from !== null) {
        const src = node('span', 'quote-src')
        const url = sourceUrl(from.source, commit)
        if (url !== null) {
          const a = node('a', undefined, from.source)
          a.href = url
          a.rel = 'noreferrer'
          src.append(a)
        } else {
          src.textContent = from.source
        }
        head.append(src)
        if (from.section !== '') head.append(node('span', 'quote-src', from.section))
      }
      head.append(node('span', 'quote-mark', quoteWord(q.verified)))
      li.append(head)
      // Цитата без текста — состояние, а не пустое место: сверять нечего, и
      // сказано это словами.
      const empty = q.text === null || q.text === ''
      li.append(node('p', `quote-text${empty ? ' is-none' : ''}`, empty ? QUOTE_EMPTY : q.text))
      return li
    }),
  )
  if (result.quotes.some((q) => !q.verified)) unverifiedBox.textContent = UNVERIFIED_NOTE
  else unverifiedBox.textContent = ''
}

function showSources(result) {
  // Отбор ничего не оставил — это исход, а не отказ поиска, и секция говорит
  // ровно это. Прежняя (дня 22) ветвь ставила сюда «Поиск отказал», и честное
  // «не знаю» читалось бы как сбой — тот самый долг, который закрывает день 24
  // (развилка Р8 ADR 2026-10-05-0544).
  if (result.sources.length === 0)
    return showSrcsPlaceholder(
      isUnknownFilter(result) ? selectNone(result.candidates.length) : SRCS_FAILED,
    )
  indexMetaBox.textContent = indexMeta(result)
  const notes = [fragmentTextNote(result.sources)].filter((t) => t !== null)
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
  // ЧТО СКАЗАТЬ ПРО ШАГИ — решает правило по тому, что конвейер успел
  // доложить, а не одна строка на любой отказ: `rerank_invalid`,
  // `answer_invalid` и отказы роутера наступают ПОСЛЕ удавшегося поиска и
  // отбора, и «Поиск отказал» объявляло бы непройденным шаг, который виден в
  // ленте выше (находка `design-review`).
  const said = failedSections(counts)
  showSrcsPlaceholder(said.srcs)
  showPickPlaceholder(said.pick)
  showChecksPlaceholder(CHECKS_FAILED)
  showCitedPlaceholder(CITED_FAILED)
  showQuotesPlaceholder(QUOTES_FAILED)
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
    // Режим ЭТОГО запуска страница узнаёт здесь и больше нигде: сервер назвал
    // его при создании запуска, и своего умолчания у страницы нет.
    const mode = event.data?.mode
    if (typeof mode === 'string' && mode !== '') runMode = mode
    setStatus(STATUS.searching)
    showSrcsPlaceholder(SRCS_SEARCHING)
  }
  if (event.stage === 'planning') {
    // Сколько фрагментов известно — решает ПРАВИЛО, а не строка здесь: стадия
    // `planning` приходит до трёх раз, и прежняя строка стирала уже известное
    // число каждым следующим событием (см. `fragmentsFromPlanning`).
    counts = fragmentsFromPlanning(event.data, counts)
    // Какую из двух фраз ставить — решает правило, а не строка здесь: выбор
    // между «поиск вернул» и «отбор оставил» это выбор смысла.
    setStatus(statusFor(counts))
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
    showChecks(result)
    showCited(result)
    showQuotes(result)
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
    // закрыт в двух других местах: при отказе запуска — правилом
    // `failedSections` в `showFailure`, при пустом отборе — исходом в
    // `showSources`; ветвь обрыва осталась без него.
    //
    // Незнакомый режим не трогаем: выдумывать слова про поиск для режима,
    // которого страница не знает, нельзя — решает это `tornSrcsNote`.
    // Спрашивается ИМЕННО `found`: секция источников говорит про то, успел ли
    // ДОЛОЖИТЬСЯ ПОИСК, а не про то, что оставил отбор.
    const tornNote = tornSrcsNote(runMode, counts.found)
    if (tornNote !== null) showSrcsPlaceholder(tornNote)
    // Секции «Отбор», «Три проверки», «Источники, на которые сослалась
    // модель» и «Цитаты» обязаны сказать про обрыв вместе с лентой: в дне 22
    // ровно такое молчание стало блокирующей находкой (пустая область под
    // заголовком рядом с красной строкой об обрыве). Отбор идёт в обоих
    // режимах дня, поэтому оговорки про режим здесь нет.
    showPickPlaceholder(PICK_TORN)
    showChecksPlaceholder(CHECKS_TORN)
    showCitedPlaceholder(CITED_TORN)
    showQuotesPlaceholder(QUOTES_TORN)
    answerBox.replaceChildren(node('p', 'empty', ANSWER_TORN))
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (send.disabled) return
  const question = input.value.trim()
  if (!question) return setStatus(STATUS.empty, true)
  if (question.length > MAX_QUESTION) return setStatus(STATUS.long, true)

  lock(true)
  setStatus(STATUS.sent)

  let answer
  let json
  try {
    answer = await fetch('api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Режима в теле НЕТ: его называет сервер дня (см. выше). Послать его
      // отсюда значило бы дать браузеру выбрать, за сколько вызовов платить.
      body: JSON.stringify({ question }),
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
  resetRun({ starting: true })
  setStatus(STATUS.searching)
  subscribe(json.runId)
})

// Ctrl + Enter отправляет: поле многострочное, и Enter в нём переносит строку.
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) form.requestSubmit()
})

// ——— итоги прогона десяти контрольных вопросов (ADR 2026-10-05-0544, п. 2.5) ———

const EVAL_NEVER =
  'Прогон 10 вопросов ещё не сделан. Числа появятся после первого прогона на проде.'
/** Файла нет или он не разбирается. Цветом --fg, не --danger: это отсутствие, а не авария. */
const EVAL_UNREAD = 'Не удалось прочитать результаты прогона (eval.json).'

/**
 * Сводка: исходы и вердикты судьи числами. Таблица настоящая, потому что у
 * каждой клетки есть и заголовок строки, и заголовок столбца; колонок у неё
 * меньше, чем в дне 23, потому что режим в этом дне ОДИН.
 */
function renderSummary(t) {
  const sum = byId('sum')
  const headRow = node('tr')
  headRow.append(node('td', undefined, ''))
  const th = node('th', undefined, 'вопросов')
  th.scope = 'col'
  headRow.append(th)
  const thead = node('thead')
  thead.append(headRow)
  const tbody = node('tbody')
  // Четыре исхода — четыре строки, и честное «не знаю» НЕ сливается с ответом
  // без подтверждения: именно это слияние было долгом дня 22.
  for (const [key, label] of OUTCOME_ROWS) {
    const tr = node('tr')
    const th = node('th', undefined, label)
    th.scope = 'row'
    tr.append(th, node('td', undefined, String(t.outcomes[key])))
    tbody.append(tr)
  }
  // Вердикты судьи — рядом, но отдельными строками: механика и суждение на
  // одном экране, и видно, где кончается одно и начинается другое.
  for (const [key, label] of JUDGE_ROWS)
    for (const value of [2, 1, 0]) {
      const tr = node('tr')
      const th = node('th', undefined, `${label}: ${verdictWord(value)}`)
      th.scope = 'row'
      tr.append(th, node('td', undefined, String(t.judge[key][value])))
      tbody.append(tr)
    }
  sum.replaceChildren(thead, tbody)
}

/** Одна строка вопроса. Раскрывается в механику, вердикты и текст ответа. */
function renderQuestion(q) {
  const details = node('details', 'q')
  const summary = node('summary')
  summary.append(node('span', 'q-id', q.id ?? ''))
  summary.append(node('span', 'q-text', q.question))
  // В строке — исход и вердикт верности: два поля, две колонки полосы
  // заголовков. Цветом ни одно не кодируется.
  const outcomeCell = node('span', 'q-v')
  outcomeCell.append(node('span', 'lbl', 'ИСХОД'))
  outcomeCell.append(node('span', undefined, outcomeWord(q.run)))
  summary.append(outcomeCell)
  const correctCell = node('span', 'q-v')
  correctCell.append(node('span', 'lbl', 'ВЕРЕН'))
  correctCell.append(node('span', undefined, q.run === null ? NOT_RUN : verdictWord(q.run.correct)))
  summary.append(correctCell)
  const mark = node('span', 'mark')
  mark.setAttribute('aria-hidden', 'true')
  summary.append(mark)
  details.append(summary)

  const body = node('div', 'q-body')
  if (q.set === 'general') {
    body.append(node('p', 'q-line', GENERAL_NOTE))
  } else if (q.expect.length > 0) {
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

  if (q.run === null) {
    body.append(node('p', 'q-line', NOT_RUN))
  } else {
    const mech = node('div')
    mech.append(node('p', 'lbl', 'МЕХАНИКА'))
    for (const row of mechanics(q.run)) mech.append(node('p', 'q-line', row))
    body.append(mech)
    const verdicts = node('div')
    verdicts.append(node('p', 'lbl', 'СУДЬЯ'))
    for (const [key, label] of JUDGE_ROWS) {
      const value = q.run[key]
      // Вердикт — СЛОВО; цифра рубрики стоит рядом с ним, а не вместо него.
      const digit = value === null ? '' : ` (${value})`
      verdicts.append(node('p', 'q-line', `${label}: ${verdictWord(value)}${digit}`))
    }
    body.append(verdicts)
    // Ответ показывается ЦЕЛИКОМ: он предмет суждения, и обрезать его «для
    // компактности» значит забрать возможность не поверить вердикту.
    body.append(node('p', 'q-ans', q.run.answer))
  }
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

  renderSummary(t)

  const partial = byId('sum-partial')
  const note = partialNote(t)
  partial.hidden = note === null
  partial.textContent = note ?? ''

  const v = verdict(t)
  const verdictBox = byId('sum-verdict')
  verdictBox.replaceChildren()
  if (v !== null) verdictBox.append(node('b', undefined, v.lead), document.createTextNode(v.text))

  byId('eval-limits').textContent = limitsText(parsed)

  const method = byId('eval-method')
  const parts = [
    node(
      'p',
      undefined,
      'Механикой проверены четыре вещи: источники названы; цитаты приведены; цитаты ' +
        'нашлись во фрагментах дословно — все, часть или ни одна; путь источника совпал ' +
        'с путём эталона ТОЧНО, а не встретился подстрокой в тексте ответа.',
    ),
  ]
  // Имя судьи, рубрика и режим прогона выводятся ИЗ ФАЙЛА, не из разметки. Нет
  // их в файле — нет и строки: выдумывать судью страница не станет.
  if (parsed.mode) parts.push(node('p', undefined, `Режим прогона: ${parsed.mode}.`))
  if (parsed.judge.name)
    parts.push(node('p', undefined, `Вердикты 0 / 1 / 2 ставил: ${parsed.judge.name}.`))
  if (parsed.judge.rubric) parts.push(node('p', undefined, `Рубрика: ${parsed.judge.rubric}`))
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
    // ФАЙЛА НЕТ И ФАЙЛ НЕ ЧИТАЕТСЯ — РАЗНЫЕ СОСТОЯНИЯ, и они не сливаются.
    // 404 значит «прогона ещё не было»: до первого прогона на проде файла нет
    // по построению, и «не удалось прочитать» читалось бы как поломка там, где
    // ничего не сломано (находка `design-review`).
    if (answer.status === 404) {
      evalState.replaceChildren(node('p', 'empty', EVAL_NEVER))
      return
    }
    if (!answer.ok) throw new Error(String(answer.status))
    raw = await answer.json()
  } catch {
    // Цвет `--fg`, а не вторичный: это отсутствие файла, а не авария, поэтому
    // и не `--danger`, но и не полушёпот.
    evalState.replaceChildren(node('p', 'unread', EVAL_UNREAD))
    return
  }
  showEval(parseEval(raw))
}

// Подпись «откуда взят путь» ставится ОДИН раз, на загрузке: она не зависит от
// запуска и верна ещё до первого вопроса — в разметке её нет, чтобы правило и
// его слова жили в одном месте (`run.js`, `CITED_RULE`).
citedRuleBox.textContent = CITED_RULE

resetRun()
setStatus('')
await loadEval()
