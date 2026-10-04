// Механика сравнения двух режимов — чистые функции без сети (ADR
// 2026-10-04-0735, п. 6).
//
// ГРАНИЦА МЕЖДУ МЕХАНИКОЙ И СУДЬЁЙ ЗДЕСЬ ПРОВЕДЕНА КОДОМ, а не обещанием.
// Механика считает четыре признака и ни одного вердикта: `retrieved`, `cited`,
// `key`, `refused`. Поле `verdict` этот модуль ставит только в `null` —
// вердикт 0/1/2 даёт отдельный экземпляр роли `reviewer` после прогона, и
// подставить его отсюда нечем. Поэтому ни одна функция здесь не знает ни
// рубрики, ни правильного ответа «по смыслу»: сверка по фразе ловит форму.
//
// Что каждый признак значит ровно:
//   retrieved — верный источник вопроса оказался среди НАЙДЕННЫХ фрагментов;
//               у режима без RAG поиска не было, у общего вопроса верного
//               источника не бывает — в обоих случаях `null`, а не `false`;
//   cited     — путь верного источника назван в тексте ответа (подстрокой);
//   key       — ключевая фраза набора есть в ответе (нормализованно);
//   refused   — модель сказала фразу отказа строгого промпта. Берётся ПОЛЕМ
//               ответа запуска (`agents/src/rag-agent.js`, `isRefusal`), а не
//               считается здесь второй копией фразы: две копии разъехались бы,
//               и прогон мерил бы не то, что показывает страница.

/** Рубрика судьи — ADR, п. 6. Текст живёт в файле результата, не в разметке. */
export const RUBRIC =
  '0 — неверно или выдумано; 1 — частично; 2 — верно и по источнику'

/** Два режима и их порядок — тот же, что у агента и у страницы. */
export const MODES = ['rag', 'norag']

/**
 * Нормализация для сверки по фразе: регистр и переносы строк различием не
 * считаются, остальное — считается. Ни замены ё на е, ни выкидывания знаков
 * здесь нет намеренно: каждое такое послабление делает `key: true` дешевле, а
 * признак — слабее, и заметить это по экрану уже нельзя.
 */
export function flatten(text) {
  return String(text ?? '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** Верный источник среди найденных. Сравнение путей — точное, не по подстроке. */
function retrievedOf(sources, expected) {
  const found = new Set(sources.map((s) => s.source))
  return expected.some((path) => found.has(path))
}

/**
 * Путь верного источника назван в ответе — подстрокой после той же
 * нормализации, что и ключевая фраза: регистр и переносы различием не
 * считаются. Что это ловит, кроме попадания: `cited: true` у ответа, который
 * назвал путь и соврал про его содержимое. Поэтому признак и стоит рядом с
 * вердиктом судьи, а не вместо него.
 */
function citedOf(answer, expected) {
  const flat = flatten(answer)
  return expected.some((path) => flat.includes(flatten(path)))
}

/**
 * Один запуск → запись режима для `eval.json`.
 *
 * `result` — объект `result` ответа запуска (`agents/src/rag-agent.js`,
 * `runs.finish`): `{mode, answer, refused, sources, index, ...}`.
 */
export function scoreRun(question, mode, result) {
  const answer = typeof result?.answer === 'string' ? result.answer : ''
  const sources = Array.isArray(result?.sources) ? result.sources : []
  const expected = Array.isArray(question.sources) ? question.sources : []
  const hasSource = expected.length > 0
  return {
    answer,
    // Поиск есть только у режима с RAG; верный источник есть только у
    // вопроса из проекта. Нет того или другого — признака нет (`null`), и
    // страница такую строку механики просто не печатает.
    retrieved: mode === 'rag' && hasSource ? retrievedOf(sources, expected) : null,
    cited: hasSource ? citedOf(answer, expected) : null,
    key: question.key === null ? null : flatten(answer).includes(flatten(question.key)),
    refused: result?.refused === true,
    // Вердикт ставит судья. Прогон его не знает и знать не может.
    verdict: null,
  }
}

/**
 * Файл результата целиком (`days/day22/public/eval.json`). Форма — та, которую
 * читает страница (`days/day22/public/evalview.js`, `parseEval`): `ranAt`,
 * `index.commit`, `index.strategy`, `judge.name`, `judge.rubric` и вопросы с
 * двумя режимами. Имя судьи здесь `null`: судейства ещё не было, и выдумывать
 * имя нельзя — его впишет тот, кто судил.
 *
 * `runs` — Map по ключу `${id}:${mode}` со значением `{result}` либо
 * `{failure}`. Режим, у которого запуск не удался, в `modes` НЕ ПОПАДАЕТ:
 * страница покажет «не прогнан» и исключит вопрос из сравнения, а причина
 * ляжет в `failures` — иначе отказ службы потерялся бы между прогоном и
 * экраном.
 */
export function buildReport({ questions, runs, ranAt, index, rubric = RUBRIC }) {
  const failures = []
  const out = questions.map((q) => {
    const modes = {}
    for (const mode of MODES) {
      const got = runs.get(`${q.id}:${mode}`)
      if (!got) continue
      if (got.failure) {
        failures.push({ id: q.id, mode, ...got.failure })
        continue
      }
      modes[mode] = scoreRun(q, mode, got.result)
    }
    return {
      id: q.id,
      set: q.set,
      question: q.question,
      expect: q.expect,
      key: q.key,
      sources: q.sources,
      modes,
    }
  })
  return {
    ranAt,
    index,
    judge: { name: null, rubric },
    questions: out,
    failures,
  }
}

/**
 * Проверка файла результата на форму. Нужна не прогону (он сам его и собрал),
 * а ПОСЛЕ судейства: вердикты в файл впишет человекоподобный судья руками, и
 * опечатка вида `verdict: "2"` или потерянная запятая превратилась бы на
 * странице в «не прогнан» — молча, потому что `parseEval` всё неизвестное
 * сводит к `null`.
 *
 * Возвращает список претензий строками. Пустой список — форма цела.
 */
export function checkReport(report, questions) {
  const problems = []
  const ids = questions.map((q) => q.id)
  if (typeof report?.ranAt !== 'string' || report.ranAt === '')
    problems.push('нет даты прогона (ranAt)')
  if (typeof report?.index?.commit !== 'string' || report.index.commit === '')
    problems.push('нет коммита индекса (index.commit)')
  if (typeof report?.index?.strategy !== 'string' || report.index.strategy === '')
    problems.push('нет стратегии индекса (index.strategy)')
  if (typeof report?.judge?.rubric !== 'string' || report.judge.rubric === '')
    problems.push('нет текста рубрики (judge.rubric)')

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
    for (const mode of MODES) {
      const m = q.modes?.[mode]
      if (m === undefined) continue
      if (typeof m.answer !== 'string' || m.answer === '')
        problems.push(`${q.id}/${mode}: нет текста ответа`)
      for (const name of ['retrieved', 'cited', 'key']) {
        if (!(typeof m[name] === 'boolean' || m[name] === null))
          problems.push(`${q.id}/${mode}: ${name} — не да/нет и не «нечего проверять»`)
      }
      if (typeof m.refused !== 'boolean') problems.push(`${q.id}/${mode}: refused — не да/нет`)
      if (!([0, 1, 2].includes(m.verdict) || m.verdict === null))
        problems.push(`${q.id}/${mode}: вердикт ${JSON.stringify(m.verdict)} вне рубрики 0/1/2`)
    }
  }
  return problems
}

/** Сколько вердиктов ещё не стоит. Нужно ровно для того, чтобы сказать это вслух. */
export function pendingVerdicts(report) {
  let pending = 0
  for (const q of Array.isArray(report?.questions) ? report.questions : [])
    for (const mode of MODES) {
      const m = q.modes?.[mode]
      if (m !== undefined && m.verdict === null) pending += 1
    }
  return pending
}
