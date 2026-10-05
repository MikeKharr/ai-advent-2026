// Механика меры дня 24 — чистые функции без сети (ADR 2026-10-05-0544, п. 2.5).
//
// ГРАНИЦА МЕЖДУ МЕХАНИКОЙ И СУДЬЁЙ ПРОВЕДЕНА КОДОМ, а не обещанием. Механика
// считает четыре признака и исход и ни одного вердикта: поля `meaning` и
// `correct` этот модуль ставит только в `null`. Подставить их отсюда нечем — ни
// рубрики, ни правильного ответа «по смыслу» ни одна функция здесь не знает.
//
// СУДЕЙСТВА В ЭТОМ ДНЕ НЕ БЫЛО ВОВСЕ (решение владельца 2026-10-05: день 24
// делает только механику). Поэтому `judge.name` и `judge.rubric` — `null`, а
// `note` говорит об этом словами: страница печатает строку про судью только
// когда имя в файле есть, и выдумывать его нельзя (`public/evalview.js`,
// `showEval`).
//
// ДВА РАЗНЫХ `cited_exact`, И ИХ НЕЛЬЗЯ ПУТАТЬ:
//
//   `checks.cited_exact` АГЕНТА (`agents/src/rag/cited.js`) — совпал ли путь,
//       КОТОРЫЙ НАЗВАЛА МОДЕЛЬ, с путём, стоящим у фрагмента отбора. Это про
//       разъезд ссылок модели с номерами, и про верность ответа он не говорит
//       ничего: модель могла аккуратно сослаться на фрагмент из чужого файла;
//
//   `cited_exact` ЭТОЙ МЕРЫ (ниже, `citedExact`) — совпал ли названный путь с
//       путём ЭТАЛОНА вопроса. Это про верность: тот ли документ назван.
//
// Величины разные, и в файле результата живёт вторая — её и показывает
// страница («путь источника совпал с эталоном точно»). Первая остаётся на
// пульте одного запуска.
//
// ЧЕГО ЗДЕСЬ НЕТ: сверки по ключевой фразе и поиска пути ПОДСТРОКОЙ в тексте
// ответа. Подстрочная механика дня 22 ошибалась в обе стороны (q72 получал
// «да» при ненайденном источнике, q57 — «нет» при верном ответе), и ADR
// (п. 2.5) заменил её сравнением пути с путём.

/** Четыре исхода дня 24 — те же слова, что у агента и у страницы. */
export const OUTCOMES = ['answered', 'unknown_filter', 'unknown_model', 'unsupported']

/** Два режима отбора. Третьего у дня 24 нет (`days/day24/env.js`, `MODES`). */
export const MODES = ['rerank', 'rewrite']

/**
 * Подпись файла. Говорит ровно то, что было: механика посчитана, судейства не
 * было. Текст живёт в файле результата, а не в разметке страницы, — тот же
 * довод, что у рубрики дня 22.
 */
export const NOTE =
  'Судейство не проводилось (решение владельца 2026-10-05): день 24 сдаёт только механику. ' +
  'Поэтому оба вердикта — «смысл ответа совпадает с цитатами» и «ответ верен по эталону» — ' +
  'в файле стоят пустыми, и страница показывает их как «не прогнан». Рубрика здесь тоже не ' +
  'приводится: по ней никто не судил, и напечатанная она читалась бы как след суждения.'

/**
 * Дословность цитат словом: все / часть / ни одной.
 *
 * ЦИТАТ НЕ БЫЛО ВОВСЕ — это `null`, а не `none`. «Ни одна цитата не нашлась
 * дословно» про пустой список было бы верно пусто и читалось бы как провал
 * сверки, которой не было; рядом в механике и так стоит «цитаты приведены:
 * нет». Страницу это устраивает по построению: строку с `null` она не печатает
 * (`public/evalview.js`, `mechanics`).
 */
export function verifiedWord(quotes) {
  if (quotes.length === 0) return null
  const verified = quotes.filter((item) => item?.verified === true).length
  if (verified === quotes.length) return 'all'
  return verified === 0 ? 'none' : 'some'
}

/**
 * Назван ли путь эталона — СРАВНЕНИЕМ ПУТИ С ПУТЁМ, точным, без нормализации и
 * без подстроки. Берутся пути из `cited[].source`, то есть из отбора: что
 * модель назвала словами, здесь не при чём — её собственное слово сверяет
 * `checks.cited_exact` агента, и это другая величина (см. шапку).
 */
export function citedExact(cited, expected) {
  const named = new Set(cited.map((item) => item?.source))
  return expected.some((path) => named.has(path))
}

/**
 * Один запуск → запись `run` для `eval.json`.
 *
 * `result` — объект `result` ответа запуска (`agents/src/rag-agent.js`,
 * `runs.finish`; форма — `agent_docs/guides/day24-cited-contract.md`).
 *
 * `has_sources` и `has_quotes` берутся ПРИЗНАКАМИ АГЕНТА (`checks`), а не
 * считаются здесь второй копией по длине списков: две копии разъехались бы, и
 * мера показывала бы не то, что показывает пульт. У исходов «не знаю» оба
 * признака ложны по построению агента, и это не «не проверяли», а «нечему
 * быть».
 */
export function scoreRun(question, result) {
  const checks = result?.checks ?? {}
  const quotes = Array.isArray(result?.quotes) ? result.quotes : []
  const cited = Array.isArray(result?.cited) ? result.cited : []
  const expected = Array.isArray(question.sources) ? question.sources : []
  return {
    outcome: OUTCOMES.includes(result?.outcome) ? result.outcome : null,
    answer: typeof result?.answer === 'string' ? result.answer : '',
    has_sources: checks.sources_present === true,
    has_quotes: checks.quotes_present === true,
    quotes_verified: verifiedWord(quotes),
    // Верного источника у общего вопроса не бывает — признака нет (`null`), а
    // не `false`: «путь не совпал» про вопрос без эталона было бы упрёком
    // ответу за то, чего от него не ждали.
    cited_exact: expected.length === 0 ? null : citedExact(cited, expected),
    // Вердикты ставит судья. Прогон их не знает и знать не может.
    meaning: null,
    correct: null,
  }
}

/**
 * Файл результата целиком (`days/day24/public/eval.json`). Форма — та, которую
 * читает страница (`days/day24/public/evalview.js`, `parseEval`).
 *
 * ПОЛЕ `expect` ФАЙЛА — ЭТО ПУТИ ЭТАЛОНА, а не выверенный текст ответа.
 * Страница печатает его под подписью «ВЕРНЫЙ ИСТОЧНИК» и строит из него ссылки
 * (`public/app.js`, `renderQuestion`), поэтому сюда едет `sources` записи
 * набора. В `days/day22/eval/questions.json` словом `expect` назван другой
 * предмет — выверенный текст ответа; он в этой мере не участвует вовсе
 * (сверки по тексту здесь нет), и совпадение имён — только совпадение имён.
 *
 * `runs` — Map по `id` вопроса со значением `{result}` либо `{failure}`.
 * Вопрос, у которого запуск не удался, получает `run: null` — страница скажет
 * «не прогнан» и исключит его из сводки, а причина ляжет в `failures`: иначе
 * отказ службы потерялся бы между прогоном и экраном.
 */
export function buildReport({ questions, runs, ranAt, mode, index, note = NOTE }) {
  const failures = []
  const out = questions.map((q) => {
    const got = runs.get(q.id)
    if (got?.failure) failures.push({ id: q.id, ...got.failure })
    return {
      id: q.id,
      set: q.set,
      question: q.question,
      expect: q.sources,
      run: got?.result ? scoreRun(q, got.result) : null,
    }
  })
  return {
    ranAt,
    mode,
    index,
    judge: { name: null, rubric: null },
    note,
    questions: out,
    failures,
  }
}

/**
 * Проверка файла результата на форму. Нужна не прогону (он сам его собрал), а
 * ПОСЛЕ него: `public/eval.json` — вторая копия полей набора, и ровно её читает
 * экран. Разъезд копий уже случался внутри ветки PR в дне 22 (находка
 * `reviewer` к PR #304), поэтому равенство сверяется здесь, а не только в
 * тесте: `--check` обязан падать на нём тоже.
 *
 * Возвращает список претензий строками. Пустой список — форма цела.
 */
export function checkReport(report, questions) {
  const problems = []
  const ids = questions.map((q) => q.id)
  if (typeof report?.ranAt !== 'string' || report.ranAt === '')
    problems.push('нет даты прогона (ranAt)')
  if (!MODES.includes(report?.mode))
    problems.push(`режим прогона ${JSON.stringify(report?.mode)} не ${MODES.join(' и не ')}`)
  if (typeof report?.index?.commit !== 'string' || report.index.commit === '')
    problems.push('нет коммита индекса (index.commit)')
  if (typeof report?.index?.strategy !== 'string' || report.index.strategy === '')
    problems.push('нет стратегии индекса (index.strategy)')
  if (typeof report?.note !== 'string' || report.note === '')
    problems.push('нет подписи файла (note)')
  const name = report?.judge?.name
  if (!(typeof name === 'string' && name !== '') && name !== null)
    problems.push('имя судьи (judge.name) — не строка и не пусто')
  const rubric = report?.judge?.rubric
  if (!(typeof rubric === 'string' && rubric !== '') && rubric !== null)
    problems.push('рубрика (judge.rubric) — не строка и не пусто')

  const got = Array.isArray(report?.questions) ? report.questions : []
  if (got.length !== questions.length)
    problems.push(`вопросов ${got.length}, а в наборе ${questions.length}`)
  for (const q of got) {
    if (!ids.includes(q?.id)) {
      problems.push(`вопрос ${JSON.stringify(q?.id)} не из набора`)
      continue
    }
    const source = questions.find((x) => x.id === q.id)
    if (q.set !== source.set) problems.push(`${q.id}: часть набора разошлась с questions.json`)
    if (q.question !== source.question) problems.push(`${q.id}: текст вопроса разошёлся`)
    if (JSON.stringify(q.expect) !== JSON.stringify(source.sources))
      problems.push(`${q.id}: пути эталона разошлись с questions.json`)
    const run = q.run
    if (run === null || run === undefined) continue
    if (!OUTCOMES.includes(run.outcome))
      problems.push(`${q.id}: исход ${JSON.stringify(run.outcome)} не из четырёх`)
    if (typeof run.answer !== 'string' || run.answer === '')
      problems.push(`${q.id}: нет текста ответа`)
    for (const field of ['has_sources', 'has_quotes'])
      if (typeof run[field] !== 'boolean') problems.push(`${q.id}: ${field} — не да/нет`)
    if (!(['all', 'some', 'none'].includes(run.quotes_verified) || run.quotes_verified === null))
      problems.push(`${q.id}: quotes_verified ${JSON.stringify(run.quotes_verified)} не все/часть/ни одной`)
    // Признак эталона есть тогда и только тогда, когда у вопроса есть эталон.
    // Иначе общий вопрос получил бы `false` — упрёк за то, чего от него не
    // ждали, — а вопрос с эталоном промолчал бы о главном.
    const wantExact = source.sources.length > 0
    if (wantExact ? typeof run.cited_exact !== 'boolean' : run.cited_exact !== null)
      problems.push(
        wantExact
          ? `${q.id}: cited_exact — не да/нет, а эталон у вопроса есть`
          : `${q.id}: cited_exact назван, а эталона у вопроса нет`,
      )
    for (const field of ['meaning', 'correct'])
      if (!([0, 1, 2].includes(run[field]) || run[field] === null))
        problems.push(`${q.id}: вердикт ${field} ${JSON.stringify(run[field])} вне рубрики 0/1/2`)
  }

  // Вердикт без судьи — претензия, а вердиктов нет вовсе — нет. Это и есть
  // граница, которую `--check` здесь держит: см. `pendingVerdicts`.
  if (judgedVerdicts(report) > 0 && !(typeof name === 'string' && name !== ''))
    problems.push('вердикты стоят, а имени судьи нет (judge.name)')
  return problems
}

/** Сколько вердиктов УЖЕ стоит. Ноль — судейства не было. */
export function judgedVerdicts(report) {
  let judged = 0
  for (const q of Array.isArray(report?.questions) ? report.questions : [])
    for (const field of ['meaning', 'correct'])
      if ([0, 1, 2].includes(q?.run?.[field])) judged += 1
  return judged
}

/**
 * Сколько вердиктов ещё не стоит. ЧИСЛО ДЛЯ ВЫВОДА, а не повод упасть, и это
 * отличие от дня 22 названо прямо: судейства в дне 24 не было по решению
 * владельца, поэтому пустых вердиктов ровно столько, сколько прогнанных
 * вопросов на два, и падать на этом значило бы краснеть по плану.
 *
 * ЧЕСТНАЯ ГРАНИЦА: из этого следует, что НЕДОсуженный файл `--check` не
 * поймает — он поймает только вердикт, выставленный без имени судьи, и вердикт
 * вне рубрики. Если судейство когда-нибудь состоится, полноту придётся
 * сверять глазами или заводить для неё отдельный признак.
 */
export function pendingVerdicts(report) {
  let pending = 0
  for (const q of Array.isArray(report?.questions) ? report.questions : [])
    for (const field of ['meaning', 'correct'])
      if (q?.run !== null && q?.run !== undefined && q.run[field] === null) pending += 1
  return pending
}
