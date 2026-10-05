// Механика хода дня 25 — чистые функции без сети (ADR 2026-10-05-0544, п. 3;
// решение владельца «судейство 24–25 сегодня пропускаем»).
//
// ЧЕГО ЗДЕСЬ НЕТ — ВЕРДИКТОВ И ТЕКСТОВ ОТВЕТОВ, и ни то, ни другое не забыто.
// Судьи у дня 25 нет по решению владельца, поэтому поля `verdict` в файле нет
// вовсе: пустое поле читалось бы как «забыли оценить», а его отсутствие —
// как «не оценивали». Текстов ответов нет по той же причине: их единственный
// потребитель — судья, а мера дня 25 — МЕХАНИКА хода, то есть то, что считает
// код: исход, число источников, пометки дословности цитат, круги, состояние
// задачи, время и токены.
//
// Что каждый признак значит ровно:
//   outcome        — исход хода словом службы: `answered`, `unsupported`,
//                    `unknown_model` (так сказала модель), `unknown_filter`
//                    (отбор не оставил фрагментов). Четыре исхода, и они не
//                    сливаются в «ответил / не ответил»: различать честное
//                    «не знаю» и ответ без подтверждения — предмет дня;
//   sources/kept   — сколько фрагментов ушло модели;
//   cited          — на сколько источников модель сослалась сама;
//   citedMismatch  — у скольких из них НАЗВАННЫЙ моделью путь разошёлся с
//                    путём из отбора. Это не то же, что `checks.cited_exact`:
//                    тот приходит от службы признаком да/нет, а здесь — число.
//                    Два признака рядом ловят разные вещи: признак говорит
//                    «сошлось ли всё», число — «сколько именно разошлось»;
//   quotesVerified — сколько цитат код нашёл во фрагменте дословно. Пометка
//                    кода, а не старательность модели (контракт хода);
//   rewritten      — переписала ли модель реплику в поисковый запрос;
//   rounds         — сколько кругов проверки состоялось (формула хода
//                    `4 + 2×кругов` вызовов);
//   task           — состояние задачи ПОСЛЕ хода: есть ли цель, сколько
//                    ограничений, терминов, уточнений и открытых вопросов,
//                    номер хода и легла ли правка (`stored`);
//   paidNothing    — слово службы о деньгах. Приходит ТОЛЬКО в кадре `end` и
//                    только у отказа; у удачного хода его нет, и здесь оно
//                    `null`, а не `false`: домысел о расходе — то же, что
//                    домысел о его отсутствии.

/** Четыре исхода хода в порядке строк сводки — те же, что на странице дня. */
export const OUTCOMES = ['answered', 'unsupported', 'unknown_model', 'unknown_filter']

/** Четыре проверки хода: три от службы и четвёртая — точность пути. */
export const CHECK_IDS = ['sources_present', 'quotes_present', 'quotes_verbatim', 'cited_exact']

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const arr = (v) => (Array.isArray(v) ? v : [])
const int = (v) => (Number.isFinite(v) ? Math.round(v) : null)

/** Признак да/нет/«не пришло». Непришедшее остаётся `null` (I-8). */
const flag = (v) => (typeof v === 'boolean' ? v : null)

/**
 * Состояние задачи в числах. Сам текст состояния здесь не хранится: панель
 * дня показывает его живым, а мера дня — то, РАСТЁТ ли состояние по ходу
 * разговора и ложится ли правка.
 */
function taskOf(task) {
  if (!isObject(task)) return null
  return {
    goal: typeof task.goal === 'string' && task.goal.trim() !== '',
    constraints: arr(task.constraints).length,
    terms: arr(task.terms).length,
    clarifications: arr(task.clarifications).length,
    open: arr(task.open).length,
    round: int(task.round),
    stored: flag(task.stored),
  }
}

/**
 * Один ход → запись механики. `result` — объект `result` кадра `end`
 * (`agents/src/staged.js`, `runs.finish`), `latencyMs` — время, замеренное
 * прогоном от POST до кадра `end`: оно больше `durationMs` службы, и обе
 * величины стоят рядом намеренно (одна — работа, другая — ожидание
 * посетителя).
 */
export function readTurn({ turn, result, latencyMs }) {
  const cited = arr(result?.cited)
  const quotes = arr(result?.quotes)
  const checks = isObject(result?.checks) ? result.checks : {}
  const summary = isObject(result?.summary) ? result.summary : {}
  return {
    n: turn.n,
    purpose: turn.purpose,
    prompt: turn.prompt,
    outcome: OUTCOMES.includes(result?.outcome) ? result.outcome : null,
    status: typeof result?.status === 'string' ? result.status : null,
    answerChars: typeof result?.answer === 'string' ? result.answer.length : null,
    clarification: typeof result?.clarification === 'string' && result.clarification !== '',
    sources: arr(result?.sources).length,
    candidates: arr(result?.candidates).length,
    cited: cited.length,
    // Путь из отбора против пути, названного моделью. Сравнение точное: это
    // та же сверка, что делает страница, и послабления сделали бы её слабее.
    citedMismatch: cited.filter((c) => c.claimedSource !== c.source).length,
    quotes: quotes.length,
    quotesVerified: quotes.filter((q) => q.verified === true).length,
    checks: Object.fromEntries(CHECK_IDS.map((id) => [id, flag(checks[id])])),
    rewritten: typeof result?.rewritten === 'string' && result.rewritten !== '',
    rounds: int(result?.rounds),
    reviewRounds: int(result?.reviewRounds),
    indexCommit: typeof result?.index?.commit === 'string' ? result.index.commit : null,
    task: taskOf(result?.task),
    tokens: int(result?.totalTokens ?? summary.totalTokens),
    durationMs: int(summary.durationMs ?? result?.durationMs),
    latencyMs: int(latencyMs),
    // У удачного хода слова о деньгах нет вовсе — см. шапку.
    paidNothing: null,
    failure: null,
  }
}

/** Отказ хода — РЕЗУЛЬТАТ прогона, а не его авария: запись той же формы. */
export function readFailure({ turn, failure, latencyMs }) {
  return {
    n: turn.n,
    purpose: turn.purpose,
    prompt: turn.prompt,
    outcome: null,
    status: null,
    answerChars: null,
    clarification: false,
    sources: null,
    candidates: null,
    cited: null,
    citedMismatch: null,
    quotes: null,
    quotesVerified: null,
    checks: Object.fromEntries(CHECK_IDS.map((id) => [id, null])),
    rewritten: false,
    rounds: null,
    reviewRounds: null,
    indexCommit: null,
    task: null,
    tokens: null,
    durationMs: null,
    latencyMs: int(latencyMs),
    paidNothing: flag(failure.paidNothing),
    failure: { code: String(failure.code), message: String(failure.message) },
  }
}

/**
 * Коммит индекса по всем ходам прогона.
 *
 * ЗАЧЕМ ОТДЕЛЬНАЯ ФУНКЦИЯ, А НЕ «взять из первого хода»: прогон идёт минутами,
 * и переиндексация корпуса посреди него сделала бы два сценария мерой двух
 * разных корпусов — молча. Поэтому коммит здесь не выбирается, а СВЕРЯЕТСЯ:
 * расхождение становится претензией формы, а не усреднением.
 */
export function indexGuard(turns) {
  const seen = [...new Set(turns.map((t) => t.indexCommit).filter((c) => typeof c === 'string'))]
  return { commit: seen[0] ?? null, seen }
}

/**
 * Какие ходы прошли на каком коммите индекса. Карта СЧИТАЕТСЯ ПО ХОДАМ, а не
 * пишется рукой: объявление смешения, которое расходится с самими ходами, —
 * это объявление неправды, и `checkReport` сверяет карту с ходами ещё раз
 * (правка файла руками уже случалась в дне 22).
 *
 * Ключ — коммит, значение — имена ходов вида `s1/3`. Ход без коммита (отказ)
 * в карту не попадает: у него замера не было.
 */
export function indexTurns(scenarios) {
  const map = {}
  for (const s of scenarios)
    for (const t of s.turns ?? []) {
      if (typeof t.indexCommit !== 'string' || t.indexCommit === '') continue
      ;(map[t.indexCommit] ??= []).push(`${s.id}/${t.n}`)
    }
  return map
}

/**
 * Файл результата целиком (`days/day25/public/eval.json`). Форма — та, которую
 * читает страница дня.
 *
 * `note` — обязательное поле, и это не украшение: прогон идёт по проду, а в
 * проде на момент прогона может не быть уже слитого кода. Пустая заметка
 * означала бы «прод равен main», и проверить это по файлу было бы нечем.
 */
export function buildReport({ ranAt, note, limits, params, scenarios, mixedReason = '' }) {
  const turns = scenarios.flatMap((s) => s.turns)
  const guard = indexGuard(turns)
  // Смешанный индекс объявляется ТОЛЬКО если причина названа словами, и
  // объявление приходит снаружи (`MIXED_REASON` в `run.mjs`), а не выводится
  // здесь: «почему корпус переиндексировался посреди прогона» код знать не
  // может. Карта ходов при этом считается по ходам — см. `indexTurns`.
  const declared =
    guard.seen.length > 1 && typeof mixedReason === 'string' && mixedReason.trim() !== ''
  return {
    ranAt,
    note,
    limits,
    params,
    index: {
      commit: guard.commit,
      seen: guard.seen,
      ...(declared
        ? { mixedAccepted: { reason: mixedReason, turns: indexTurns(scenarios) } }
        : {}),
    },
    // Сводка КЛАДЁТСЯ В ФАЙЛ, а не считается на странице, и это не удобство:
    // страница дня 25 — один файл без модулей, и арифметика на ней была бы
    // второй копией этой. Копии разъезжаются молча (находка `reviewer` к PR
    // #304 — ровно про две копии набора в дне 22), поэтому числа считает один
    // модуль, а равенство сводки своим же ходам сверяет `checkReport`.
    scenarios: scenarios.map((s) => ({ ...s, summary: summarize(s.turns) })),
  }
}

const TURN_INTS = ['sources', 'candidates', 'cited', 'citedMismatch', 'quotes', 'quotesVerified']

/**
 * Проверка файла результата на форму. Нужна не прогону, а тому, кто читает
 * файл после него: страница всё неизвестное сводит к «не пришло», и
 * потерянное поле стало бы на экране честно выглядящим пробелом.
 *
 * Возвращает список претензий строками. Пустой список — форма цела.
 */
export function checkReport(report, set = {}) {
  const { minTurns = 10, maxTurns = 15 } = set
  /** Набор сценариев, если дан: файл результата — ВТОРАЯ копия его реплик. */
  const source = Array.isArray(set.scenarios) ? set.scenarios : null
  const problems = []
  if (typeof report?.ranAt !== 'string' || report.ranAt === '')
    problems.push('нет даты прогона (ranAt)')
  if (typeof report?.note !== 'string' || report.note.trim() === '')
    problems.push('нет заметки о прогоне (note)')
  if (!Number.isInteger(report?.limits?.dailyCap))
    problems.push('нет суточного потолка дня (limits.dailyCap)')
  if (!Number.isInteger(report?.limits?.reviewRounds))
    problems.push('нет предела кругов прогона (limits.reviewRounds)')
  if (typeof report?.index?.commit !== 'string' || report.index.commit === '')
    problems.push('нет коммита индекса (index.commit)')
  // СМЕШАННЫЙ ИНДЕКС: красный по умолчанию, зелёный только объявленным.
  //
  // Почему не просто «красный всегда»: прогон идёт минутами по проду, и
  // выкатка внутри его окна переиндексирует корпус — тогда два сценария
  // измерены на двух корпусах. Молчать об этом нельзя, но и запрещать совсем
  // значило бы выбрасывать оплаченный замер целиком. Поэтому смешение
  // ПРОХОДИТ, если файл сам его объявляет: причина словами и карта «какой ход
  // на каком коммите». Молчаливое смешение остаётся красным — ровно тот
  // случай, который сверка и завели поймать (решение владельца 2026-10-05 по
  // прогону 16:07Z, смешанному выкаткой PR #327 и #329).
  //
  // Объявление ПРОВЕРЯЕТСЯ, а не принимается на веру: карта сверяется с
  // самими ходами. Иначе «объявить» значило бы «написать что угодно».
  if (arr(report?.index?.seen).length > 1) {
    const mixed = report.index.mixedAccepted
    if (!isObject(mixed) || typeof mixed.reason !== 'string' || mixed.reason.trim() === '')
      problems.push(`индекс менялся по ходу прогона: ${arr(report.index.seen).join(', ')}`)
    else if (JSON.stringify(mixed.turns) !== JSON.stringify(indexTurns(arr(report.scenarios))))
      problems.push('объявление смешанного индекса расходится с ходами файла')
  }

  const scenarios = arr(report?.scenarios)
  if (scenarios.length !== 2) problems.push(`сценариев ${scenarios.length}, а должно быть два`)
  for (const s of scenarios) {
    const name = typeof s?.id === 'string' && s.id !== '' ? s.id : '(без имени)'
    // Реплики и названия в файле против НАБОРА. Файл результата — вторая копия
    // `eval/scenarios.json`, и читает её экран: названия сценариев и
    // назначение каждого хода (`purpose`) посетитель видит ИЗ НЕЁ. Самих
    // реплик на экране нет — они сверяются потому, что по ним шёл прогон, и
    // расхождение означало бы, что в файле записан не тот вопрос, который
    // задавали. В дне 22 такие две копии успели разъехаться внутри одной
    // ветки, и закрыли это руками, а не гейтом (находка `reviewer` к PR
    // #304). Здесь равенство сверяется.
    const from = source?.find((x) => x.id === s?.id) ?? null
    if (source !== null && from === null) problems.push(`${name}: сценария нет в наборе`)
    if (from !== null && from.title !== s.title)
      problems.push(`${name}: название разошлось с scenarios.json`)
    if (typeof s?.title !== 'string' || s.title === '') problems.push(`${name}: нет названия`)
    if (typeof s?.sessionName !== 'string' || s.sessionName === '')
      problems.push(`${name}: не названо, в каком диалоге прогон шёл (sessionName)`)
    const turns = arr(s?.turns)
    if (turns.length < minTurns || turns.length > maxTurns)
      problems.push(`${name}: ходов ${turns.length}, а сценарий — ${minTurns}–${maxTurns}`)
    turns.forEach((t, at) => {
      const where = `${name}/ход ${t?.n ?? at + 1}`
      if (t?.n !== at + 1) problems.push(`${where}: номера ходов идут не по порядку`)
      if (typeof t?.prompt !== 'string' || t.prompt === '')
        problems.push(`${where}: нет текста реплики`)
      if (typeof t?.purpose !== 'string' || t.purpose === '')
        problems.push(`${where}: не названо, что ход проверяет (purpose)`)
      const asked = from?.turns?.[at] ?? null
      if (asked !== null) {
        if (asked.prompt !== t?.prompt) problems.push(`${where}: текст реплики разошёлся с набором`)
        if (asked.purpose !== t?.purpose) problems.push(`${where}: назначение хода разошлось с набором`)
      }
      if (!Number.isInteger(t?.latencyMs)) problems.push(`${where}: нет замера времени хода`)
      if (t?.failure !== null) {
        // Отказ — законная запись, но он обязан назвать код: «что-то не
        // вышло» без кода не отличить от потерянного поля.
        if (typeof t?.failure?.code !== 'string' || t.failure.code === '')
          problems.push(`${where}: отказ без кода`)
        return
      }
      if (!OUTCOMES.includes(t.outcome)) problems.push(`${where}: исход вне четырёх`)
      for (const field of TURN_INTS)
        if (!Number.isInteger(t[field])) problems.push(`${where}: ${field} — не число`)
      if (t.quotesVerified > t.quotes)
        problems.push(`${where}: дословных цитат больше, чем самих цитат`)
      if (t.citedMismatch > t.cited)
        problems.push(`${where}: расхождений путей больше, чем названных источников`)
      for (const id of CHECK_IDS)
        if (!(typeof t.checks?.[id] === 'boolean' || t.checks?.[id] === null))
          problems.push(`${where}: проверка ${id} — не да/нет и не «не пришло»`)
      if (!Number.isInteger(t.rounds) || t.rounds < 1) problems.push(`${where}: кругов не число`)
      if (typeof t.indexCommit !== 'string' || t.indexCommit === '')
        problems.push(`${where}: ход не назвал коммит индекса`)
      // Обещание дня читается ровно так: либо источники есть, либо исход —
      // «не знаю». Третьего нет (контракт хода, «Результат хода»).
      if (t.sources === 0 && t.outcome !== 'unknown_filter')
        problems.push(`${where}: источников нет, а исход не «не знаю от отбора»`)
      if (t.sources > 0 && t.outcome === 'unknown_filter')
        problems.push(`${where}: исход «не знаю от отбора», а источники есть`)
      // ВТОРОЕ механическое обещание ADR, п. 3.5: «`task_state.goal` непуст с
      // хода 2 и далее». Первое — строкой выше про источники.
      //
      // Что это значит для `--check`: сломанный день красит сверку. Так и
      // задумано — это проверка ОБЕЩАНИЯ дня, а не формы файла, и зелёный
      // `--check` при пустой цели означал бы, что замер прошёл, а мерить
      // было нечего.
      //
      // ЧЕГО ЭТА ПРОВЕРКА НЕ ЛОВИТ, и это проверено по файлу, а не выведено:
      // дефекта потолка `TASK_ANSWER_TOKENS` (PR #328) она НЕ ПОКАЗАЛА. На
      // прогоне 2026-10-05T11:38Z шестой вызов обрывался на 13 ходах из 18,
      // но `goal` в результате оставался прежним — состояние несёт предыдущее,
      // а не пустое, — и нарушений этого правила в том файле ноль. Признак
      // неудавшейся правки — `task.stored` и неподвижный `task.round`, и
      // считает их сводка (`taskStored`), а не это правило.
      //
      // Ход 1 исключён: до первого ответа состояния не существует вовсе, и
      // требовать от него цель значило бы требовать её от пустоты.
      if (t.n >= 2 && (t.task === null || t.task.goal !== true))
        problems.push(`${where}: цель задачи пуста с хода 2 и далее (ADR, п. 3.5)`)
    })
    // Сводка в файле против собственных ходов файла. Это и есть держатель
    // того, что страница печатает не свою арифметику: разъехалась сводка —
    // краснеет `--check` и тест файла, а не экран через месяц.
    if (JSON.stringify(s?.summary) !== JSON.stringify(summarize(turns)))
      problems.push(`${name}: сводка в файле разошлась со своими же ходами`)
  }
  return problems
}

/**
 * Сводка сценария для страницы и для вывода прогона. Числа считаются здесь, а
 * не в разметке: экран и прогон обязаны говорить одно и то же.
 */
export function summarize(turns) {
  const done = turns.filter((t) => t.failure === null)
  const counts = Object.fromEntries(OUTCOMES.map((o) => [o, 0]))
  for (const t of done) if (counts[t.outcome] !== undefined) counts[t.outcome] += 1
  return {
    turns: turns.length,
    failed: turns.length - done.length,
    outcomes: counts,
    withSources: done.filter((t) => t.sources > 0).length,
    quotes: done.reduce((n, t) => n + t.quotes, 0),
    quotesVerified: done.reduce((n, t) => n + t.quotesVerified, 0),
    citedMismatch: done.reduce((n, t) => n + t.citedMismatch, 0),
    rewritten: done.filter((t) => t.rewritten).length,
    rounds: done.reduce((n, t) => n + t.rounds, 0),
    taskStored: done.filter((t) => t.task?.stored === true).length,
    tokens: done.reduce((n, t) => n + (t.tokens ?? 0), 0),
    // Среднее время хода — по удачным ходам: отказ поиска возвращается за
    // секунду и занижал бы его, не будучи ходом.
    latencyMs: done.length === 0 ? null : Math.round(done.reduce((n, t) => n + t.latencyMs, 0) / done.length),
  }
}
