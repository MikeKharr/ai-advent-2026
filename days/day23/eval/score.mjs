// Механика меры дня 23 — чистые функции без сети (ADR 2026-10-05-0544, п. 1.5).
//
// СУДЬИ ЗДЕСЬ НЕТ ВОВСЕ, и это не упущение по сравнению с днём 22: ранги
// считаются по эталону `rag/eval/queries.json` механически, вердикт 0/1/2 этой
// мере не нужен (ADR, п. 0.3). Поэтому в файле результата нет ни поля
// `verdict`, ни поля `judge`, и дописать их здесь нечем.
//
// ЧЕГО ЗДЕСЬ НЕТ НАМЕРЕННО — долги дня 22, закрываемые днём 23 (развилка Р8):
//
//   признака `cited` нет. В дне 22 он искал путь эталона ПОДСТРОКОЙ в тексте
//   ответа и ошибался в обе стороны (q72 получил `cited: true` при промахе
//   поиска, q57 — `cited: false` при верном ответе). Здесь сравниваются пути
//   с путями, и про ссылки в тексте ответа этот модуль не знает ничего:
//   мера дня 23 говорит про РАНГИ;
//
//   пустого отбора нет в одном ведре с промахом. Вопрос, на котором реранкер
//   не оставил ни одного фрагмента, помечается полем `empty` и считается
//   отдельным числом `emptyPicks`.
//
// ЧТО ПРИ ЭТОМ ЧЕСТНО СКАЗАТЬ ПРО `empty`: в средние «после» он входит нулями.
// Исход «не знаю» — честный ответ посетителю, но для РАНГОВ это потеря: отбор
// выбросил фрагмент, который до него стоял в выдаче. Два числа рядом (`ran` и
// `emptyPicks`) дают прочитать среднее правильно, а исключение таких вопросов
// из среднего завысило бы «после» ровно на тех вопросах, где отбор сработал
// хуже всего.

/**
 * Срезы метрик — те же, что у `rag/metrics.py` (`RECALL_K`, `MRR_K`). Числа
 * стоят здесь копией поневоле: единица `rag/` на Python, импортировать нечего.
 * Разъезд копий краснит `test/score.test.js` — он читает `rag/metrics.py`.
 */
export const RECALL_K = 5
export const MRR_K = 10

/**
 * Режимы прогона и их порядок. `rag` сюда НЕ входит: он и есть «до» внутри
 * каждого запуска, и платить за него третий раз не за что (ADR, п. 1.5).
 * Список обязан совпадать с `EVAL_MODES` страницы — держит `score.test.js`.
 */
export const MODES = ['rerank', 'rewrite']

/** Каждый третий вопрос эталона. Шаг отбора — ADR, п. 1.5, решение Р3(в). */
export const PICK_STEP = 3
/** Сколько вопросов берётся. Объём назван владельцем, не выведен из набора. */
export const PICK_COUNT = 30

/**
 * Отбор вопросов из эталона: КАЖДЫЙ ТРЕТИЙ ПО ПОРЯДКУ, первые 30 — `q01`, `q04`,
 * … `q88`.
 *
 * Почему правило, а не файл со списком: в дне 22 набор вопросов лежал второй
 * копией, и копии разъехались внутри одной ветки (находка `reviewer` к
 * PR #304). Здесь второй копии нет вовсе — есть правило и эталон.
 *
 * Почему «первые 30», а не «каждый третий из ста»: каждый третий из ста даёт 34
 * вопроса, а объём владельцем назван равным 30 (ADR, п. 1.5). Из двух
 * детерминированных способов сойтись на 30 — обрезать хвост или сменить шаг —
 * взят первый: он оставляет шаг равным названному в решении. Подбора в этом нет:
 * правило не смотрит ни на ранги дня 21, ни на содержание вопроса.
 */
export function selectQuestions(queries, { step = PICK_STEP, count = PICK_COUNT } = {}) {
  const picked = []
  for (let at = 0; at < queries.length && picked.length < count; at += step) picked.push(queries[at])
  return picked.map((q) => ({ id: q.id, question: q.question, expect: [...q.expected] }))
}

/**
 * Доля ожидаемых документов среди первых k — формула `recall_at_k`
 * (`rag/metrics.py`): делится на число ВЕРНЫХ ДОКУМЕНТОВ ВОПРОСА, а не на k и
 * не на число найденного. Находка гейтов дня 21, повторённая здесь, чтобы
 * числа дня 23 сравнивались с числами дня 21 той же формулой.
 */
export function recallAt(sources, expected, k = RECALL_K) {
  if (expected.length === 0) return 0
  const top = new Set(sources.slice(0, k))
  return expected.filter((path) => top.has(path)).length / expected.length
}

/** Обратный ранг первого верного документа среди первых k — `reciprocal_rank`. */
export function reciprocalRank(sources, expected, k = MRR_K) {
  const want = new Set(expected)
  const top = sources.slice(0, k)
  for (let at = 0; at < top.length; at += 1) if (want.has(top[at])) return 1 / (at + 1)
  return 0
}

/** Четыре знака — как `round(..., 4)` в `rag/metrics.py`. */
export const round4 = (value) => Math.round(value * 1e4) / 1e4

const pathsOf = (list) =>
  (Array.isArray(list) ? list : []).map((item) => (typeof item?.source === 'string' ? item.source : ''))

const sideOf = (sources, expected) => ({
  recall5: round4(recallAt(sources, expected)),
  mrr10: round4(reciprocalRank(sources, expected)),
})

/**
 * Один запуск → запись режима для `eval.json`.
 *
 * ДВЕ ВЫДАЧИ ОДНОГО ЗАПУСКА, и в этом весь предмет дня:
 *   before — `candidates` в порядке близости, то есть выдача поиска до отбора;
 *   after  — `sources`, то есть то, что отбор оставил и что ушло модели.
 * Второго индекса и второго прогона для этого не нужно (ADR, п. 1.5).
 *
 * `empty` берётся ИСХОДОМ ЗАПУСКА (`outcome === 'unknown_filter'`), а не
 * выводится из `kept === 0`: «реранкер никого не оставил» объявляет агент, и
 * второго правила для того же вывода мера не заводит.
 */
export function scoreRun(question, result) {
  const candidates = pathsOf(result?.candidates)
  const sources = pathsOf(result?.sources)
  const expected = Array.isArray(question.expect) ? question.expect : []
  return {
    before: sideOf(candidates, expected),
    after: sideOf(sources, expected),
    candidates: candidates.length,
    kept: sources.length,
    empty: result?.outcome === 'unknown_filter',
    // ЧТО СТАЛО СО ВТОРЫМ ПОИСКОМ режима `rewrite` — без этого поля числа
    // режима нельзя прочитать. «Переписывание не помогло» и «служба отказала
    // на втором поиске» дают одинаковые ранги и совершенно разные выводы: в
    // первом случае мера сказала своё слово, во втором — она мерила `rerank`
    // под именем `rewrite`. Поле берётся у агента (контракт дня, `rewriteSearch`:
    // null | skipped | ok | empty | failed), а не выводится из числа кандидатов.
    rewriteSearch: typeof result?.rewriteSearch === 'string' ? result.rewriteSearch : null,
  }
}

/** Значения `rewriteSearch` контракта дня. `null` — поля не было вовсе. */
export const REWRITE_SEARCH = ['skipped', 'ok', 'empty', 'failed']

/** Сводка режима: средние по прогнанным вопросам плюс два числа объёма. */
export function summarize(rows) {
  const measured = rows.filter((row) => row !== null && row !== undefined)
  if (measured.length === 0) return null
  const mean = (side, metric) => round4(measured.reduce((sum, row) => sum + row[side][metric], 0) / measured.length)
  return {
    before: { recall5: mean('before', 'recall5'), mrr10: mean('before', 'mrr10') },
    after: { recall5: mean('after', 'recall5'), mrr10: mean('after', 'mrr10') },
    ran: measured.length,
    emptyPicks: measured.filter((row) => row.empty).length,
  }
}

/**
 * Файл результата целиком. Форма — ровно та, которую читает страница
 * (`days/day23/public/evalview.js`, `parseEval`): `at`, `index`,
 * `questionsTotal`, `modes`, `questions`, `note`.
 *
 * `runs` — Map по ключу `${id}:${mode}`, значение `{result}` либо `{failure}`.
 * Режим, которого не прогоняли или который отказал, становится `null`:
 * страница скажет «не прогнали», а причина ляжет в `failures` — иначе отказ
 * службы потерялся бы между прогоном и экраном.
 *
 * `questionsTotal` — размер НАБОРА, а не число прогнанного: прогон в два приёма
 * не вправе уменьшать знаменатель, по которому читают сводку.
 */
export function buildReport({ questions, runs, at, index, note = null }) {
  const failures = []
  const rows = questions.map((q) => {
    const row = { id: q.id, question: q.question, expect: [...q.expect] }
    for (const mode of MODES) {
      const got = runs.get(`${q.id}:${mode}`)
      if (!got) {
        row[mode] = null
        continue
      }
      if (got.failure) {
        failures.push({ id: q.id, mode, ...got.failure })
        row[mode] = null
        continue
      }
      row[mode] = scoreRun(q, got.result)
    }
    return row
  })
  return {
    at,
    index,
    questionsTotal: questions.length,
    modes: Object.fromEntries(MODES.map((mode) => [mode, summarize(rows.map((row) => row[mode]))])),
    questions: rows,
    note,
    failures,
  }
}

/**
 * Слияние прошлого приёма с новым. Один приём может не домерить всего набора —
 * окно на адрес (30 запусков в час) или обрыв связи, — поэтому следующий приём
 * дописывает остаток и обязан НЕ ЗАТИРАТЬ сделанного. Прогон дня 23 прошёл
 * тремя приёмами одних суток (`days/day23/README.md`, «Как прошёл прогон»).
 *
 * Правило слияния названо прямо: в новом отчёте выигрывает то, что ИЗМЕРЕНО;
 * `null` нового приёма не затирает числа прошлого. Иначе второй приём, идущий
 * только по режиму `rewrite`, стёр бы весь `rerank` первого.
 *
 * Сводки и `failures` пересчитываются по слитым строкам, а не складываются:
 * среднее от средних на разных объёмах — не среднее.
 */
export function mergeReports(previous, next) {
  const was = new Map((Array.isArray(previous?.questions) ? previous.questions : []).map((row) => [row.id, row]))
  const questions = next.questions.map((row) => {
    const old = was.get(row.id)
    if (!old) return row
    const merged = { ...row }
    for (const mode of MODES) if (merged[mode] === null && old[mode] != null) merged[mode] = old[mode]
    return merged
  })
  const keep = (list, ids) =>
    (Array.isArray(list) ? list : []).filter(
      (f) => !ids.has(`${f.id}:${f.mode}`) && questions.some((row) => row.id === f.id && row[f.mode] === null),
    )
  const fresh = new Set(next.failures.map((f) => `${f.id}:${f.mode}`))
  return {
    ...next,
    questions,
    modes: Object.fromEntries(MODES.map((mode) => [mode, summarize(questions.map((row) => row[mode]))])),
    // Отказ прошлого приёма остаётся в списке, пока вопрос в этом режиме так и
    // не измерен: иначе причина пропуска терялась бы вместе с приёмом.
    failures: [...keep(previous?.failures, fresh), ...next.failures],
  }
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const inUnit = (v) => isNum(v) && v >= 0 && v <= 1

/**
 * Проверка формы файла результата. Нужна не прогону (он его и собрал), а
 * ПОСЛЕ слияния двух приёмов и правок руками: страница всё неизвестное сводит к
 * `null`, то есть опечатка в числе превратилась бы в «не прогнали» молча.
 *
 * Возвращает список претензий строками. Пустой список — форма цела.
 */
export function checkReport(report, questions) {
  const problems = []
  if (typeof report?.at !== 'string' || report.at === '') problems.push('нет даты прогона (at)')
  if (typeof report?.index?.commit !== 'string' || report.index.commit === '')
    problems.push('нет коммита индекса (index.commit)')
  if (typeof report?.index?.strategy !== 'string' || report.index.strategy === '')
    problems.push('нет стратегии индекса (index.strategy)')
  if (report?.questionsTotal !== questions.length)
    problems.push(`questionsTotal ${JSON.stringify(report?.questionsTotal)}, а в наборе ${questions.length}`)

  const rows = Array.isArray(report?.questions) ? report.questions : []
  if (rows.length !== questions.length) problems.push(`вопросов ${rows.length}, а в наборе ${questions.length}`)

  for (let at = 0; at < Math.min(rows.length, questions.length); at += 1) {
    const row = rows[at]
    const want = questions[at]
    // Порядок и состав — тот же, что даёт отбор по эталону. Проверяется
    // равенство ТЕКСТА, а не только `id`: файл на диске — вторая копия
    // вопроса, и ровно её читает посетитель.
    if (row?.id !== want.id) problems.push(`место ${at + 1}: вопрос ${JSON.stringify(row?.id)}, а по отбору ${want.id}`)
    if (row?.question !== want.question) problems.push(`${want.id}: текст вопроса разошёлся с rag/eval/queries.json`)
    if (JSON.stringify(row?.expect) !== JSON.stringify(want.expect))
      problems.push(`${want.id}: верные документы разошлись с rag/eval/queries.json`)
    for (const mode of MODES) {
      const m = row?.[mode]
      if (m === null || m === undefined) continue
      for (const side of ['before', 'after'])
        for (const metric of ['recall5', 'mrr10'])
          if (!inUnit(m?.[side]?.[metric])) problems.push(`${want.id}/${mode}: ${side}.${metric} не доля от 0 до 1`)
      if (!isNum(m.candidates) || !isNum(m.kept)) problems.push(`${want.id}/${mode}: нет чисел кандидатов и оставленных`)
      if (typeof m.empty !== 'boolean') problems.push(`${want.id}/${mode}: empty — не да/нет`)
      // Поле необязательно: строки приёма 1 дня 23 собраны раннером до его
      // появления, и дописывать им значение задним числом было бы выдумкой.
      // Но если оно есть — оно обязано быть из контракта, а не любой строкой.
      if (m.rewriteSearch !== undefined && m.rewriteSearch !== null && !REWRITE_SEARCH.includes(m.rewriteSearch))
        problems.push(`${want.id}/${mode}: rewriteSearch ${JSON.stringify(m.rewriteSearch)} вне контракта дня`)
      if (m.empty === true && m.kept !== 0) problems.push(`${want.id}/${mode}: пустой отбор, а оставленных ${m.kept}`)
    }
  }

  // СВОДКА ПРОТИВ СТРОК. Пересчёт здесь — единственное, что не даёт числам на
  // экране разойтись со строками таблицы под ними: сводку можно поправить
  // руками, а строки — нет.
  for (const mode of MODES) {
    const want = summarize(rows.map((row) => row?.[mode] ?? null))
    const got = report?.modes?.[mode] ?? null
    if (JSON.stringify(got) !== JSON.stringify(want))
      problems.push(`сводка ${mode} разошлась со строками вопросов: ${JSON.stringify(got)} против ${JSON.stringify(want)}`)
  }
  return problems
}

/** Сколько запусков ещё не сделано — число, по которому виден второй приём. */
export function pendingRuns(report) {
  let pending = 0
  for (const row of Array.isArray(report?.questions) ? report.questions : [])
    for (const mode of MODES) if ((row?.[mode] ?? null) === null) pending += 1
  return pending
}
