// Правила показа ИТОГОВ ПРОГОНА дня 23 — чистые функции без DOM. Проверяются
// исполнением в test/evalview.test.js; DOM живёт в app.js.
//
// Мера дня 23 механическая целиком: ранги считаются по эталону
// `rag/eval/queries.json`, судьи нет (ADR 2026-10-05-0544, п. 0.3). Объём —
// 30 вопросов в двух режимах — 60 запусков (решение владельца по развилке Р3,
// вариант «в») при суточном потолке дня 150 (ADR 2026-10-05-1004: при потолке
// 50 мера не укладывалась в одни сутки).
//
// Чего здесь НЕТ — и это прямое следствие долгов дня 22 (развилка Р8):
//
//   механики `cited` нет вовсе. В дне 22 она искала путь эталона ПОДСТРОКОЙ в
//   тексте ответа и ошибалась в обе стороны (q72 получил `cited: true` при
//   `retrieved: false`, q57 — `cited: false` при верном ответе; пункт
//   «Владельцу» в `agent_docs/backlog.md`). Здесь сравниваются ПУТИ с путями,
//   и слово «сослался» не произносится ни разу: мера дня 23 говорит про
//   ранги, а про ссылки в тексте ответа не знает ничего;
//
//   пустого отбора нет в числителе провалов. Вопрос, на котором реранкер не
//   оставил ни одного фрагмента, — ОТДЕЛЬНАЯ СТРОКА сводки («отбор ничего не
//   оставил»), а не ноль в одном ведре с неверной выдачей. Это второй долг
//   дня 22: честное «не знаю» и выдумка попадали там в один вердикт 0.

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v) => (typeof v === 'string' ? v : '')
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Режимы меры. `rag` в прогон не идёт: он и есть «до» внутри каждого запуска. */
export const EVAL_MODES = [
  ['rerank', 'с отбором'],
  ['rewrite', 'с переписыванием'],
]

/** Метрики. Обе считаются дважды — по выдаче до отбора и после (ADR, п. 1.5). */
export const METRICS = [
  ['recall5', 'Recall@5'],
  ['mrr10', 'MRR@10'],
]

/** Доля — три знака, как близость на пульте. Не измерено — строки нет (I-8). */
export const formatMetric = (v) => (v === null ? '' : v.toFixed(3).replace('.', ','))

/**
 * Разность «после минус до» со знаком. Ноль печатается нулём, а не прочерком:
 * «разницы нет» — это результат дня, а не отсутствие данных (ADR,
 * «Последствия»: потолок отбора низкий и назван заранее).
 */
export function delta(before, after) {
  if (before === null || after === null) return ''
  const d = after - before
  const sign = d > 0 ? '+' : d < 0 ? '−' : '±'
  return `${sign}${formatMetric(Math.abs(d))}`
}

function parseScores(raw) {
  const d = isObject(raw) ? raw : {}
  const side = (v) => {
    const o = isObject(v) ? v : {}
    return { recall5: num(o.recall5), mrr10: num(o.mrr10) }
  }
  return { before: side(d.before), after: side(d.after) }
}

function parseModeSummary(raw) {
  if (!isObject(raw)) return null
  const scores = parseScores(raw)
  return {
    ...scores,
    ran: num(raw.ran),
    // Вопросы, на которых отбор не оставил ничего. Отдельное число, не провал.
    emptyPicks: num(raw.emptyPicks),
  }
}

function parseQuestionMode(raw) {
  if (!isObject(raw)) return null
  return {
    ...parseScores(raw),
    candidates: num(raw.candidates),
    kept: num(raw.kept),
    // Пустой отбор — ПОЛЕ прогона, а не вывод страницы из `kept === 0`:
    // «реранкер никого не оставил» и «числа не пришло» — разные вещи.
    empty: raw.empty === true,
  }
}

/**
 * Разбор файла итогов. Файл собирает прогон (`days/day23/eval/run.mjs`, PR 3),
 * страница читает его как обычную статику и ОТКАЗОМ ПУЛЬТ НЕ ЛОМАЕТ: два
 * источника данных на экране живут порознь.
 */
export function parseEval(raw) {
  const d = isObject(raw) ? raw : {}
  const index = isObject(d.index) ? d.index : null
  const modes = isObject(d.modes) ? d.modes : {}
  return {
    at: str(d.at) || null,
    index: index
      ? {
          commit: str(index.commit) || null,
          strategy: str(index.strategy) || null,
          chunks: num(index.chunks),
        }
      : null,
    total: num(d.questionsTotal),
    modes: Object.fromEntries(EVAL_MODES.map(([key]) => [key, parseModeSummary(modes[key])])),
    questions: Array.isArray(d.questions)
      ? d.questions.filter(isObject).map((q, at) => ({
          id: str(q.id) || `#${at + 1}`,
          question: str(q.question),
          expect: Array.isArray(q.expect) ? q.expect.filter((v) => typeof v === 'string') : [],
          rerank: parseQuestionMode(q.rerank),
          rewrite: parseQuestionMode(q.rewrite),
        }))
      : [],
    note: str(d.note) || null,
  }
}

/** Прогона в этом режиме не было. Пустое место на его месте — заглушка (I-8). */
export const NOT_RUN = 'В этом режиме вопрос не прогоняли.'
/** Честный исход отбора. Он назван своим именем и в своей строке. */
export const EMPTY_PICK = 'Отбор не оставил ни одного фрагмента — исход «не знаю», не промах.'

/** Есть ли что показывать вовсе. */
export const hasRun = (parsed) =>
  parsed.questions.length > 0 || EVAL_MODES.some(([key]) => parsed.modes[key] !== null)

/**
 * Фраза вывода собирается ИЗ ЧИСЕЛ, а не выбирается автором. Три исхода, и
 * третий назван заранее в ADR («Последствия»): разницы нет — это результат.
 *
 * Порог «заметно» — 0,02 по MRR@10: то самое число, которым ADR (п. 2.4)
 * выбирает режим для дня 24. Второго числа для того же вопроса здесь не
 * заводится.
 */
export const NOTABLE = 0.02

/**
 * Ожидание этого дня, названное ДО прогона, — про НАПРАВЛЕНИЕ: отбор ПОДНИМАЕТ
 * Recall@5, примерно с 0,48 без него до 0,58 после (ADR 2026-10-05-0544,
 * п. 1.2 — счёт по рангам дня 21). Оба числа стоят здесь, потому что без базы
 * «0,58» читается как уровень, которого надо достичь, а ожидание было о другом:
 * вторая ступень должна была метрику поднять, а не довести до числа. Уровня
 * можно достичь и не отбором — так в этом дне и вышло.
 */
export const RECALL_BASE = 0.48
export const RECALL_EXPECTED = 0.58

/**
 * Что мера сказала про ВТОРУЮ метрику, когда отбор её опустил. Фраза вывода
 * выбирает режим по MRR@10 — так велит ADR (п. 2.4), — и этого мало: отбор
 * может поднять MRR@10 и ОДНОВРЕМЕННО выбросить верные документы из пятёрки,
 * то есть «лучший режим» будет назван на фоне падения Recall@5. Строка
 * собирается из чисел файла: называются режимы, в которых `after` ниже
 * `before`, со своими числами; не опустил ни в одном — строки нет вовсе.
 *
 * НЕ ПОДТВЕРДИЛОСЬ НАПРАВЛЕНИЕ, А НЕ УРОВЕНЬ, и путать их здесь нельзя
 * (находка `design-review` к PR #327): ожидание было «отбор поднимает Recall@5
 * с ≈0,48 до ≈0,58», а отбор его опустил — при этом число «после» у режима с
 * переписыванием 0,58 перешагнуло. Поэтому про уровень строка говорит отдельным
 * предложением и только когда он взят: взят он не отбором, а тем, что стояло до
 * него.
 */
export function recallText(parsed) {
  const measured = EVAL_MODES.map(([key, word]) => [word, parsed.modes[key]]).filter(
    ([, m]) => m !== null && m.before.recall5 !== null && m.after.recall5 !== null,
  )
  const fell = measured.filter(([, m]) => m.after.recall5 < m.before.recall5)
  if (fell.length === 0) return ''
  const pair = ([word, m]) =>
    `«${word}» ${formatMetric(m.before.recall5)} → ${formatMetric(m.after.recall5)}`
  const over = measured.filter(([, m]) => m.after.recall5 >= RECALL_EXPECTED)
  return (
    ` Recall@5 отбор при этом опустил: ${fell.map(pair).join(', ')}. Ожидание дня было о` +
    ` направлении: отбор поднимает Recall@5 — примерно с ${formatMetric(RECALL_BASE)} без` +
    ` него до ${formatMetric(RECALL_EXPECTED)} после. Направления мера не подтвердила.` +
    (over.length === 0
      ? ''
      : ` Самого уровня ${formatMetric(RECALL_EXPECTED)} выдача после отбора достигает` +
        ` (${over.map(([word, m]) => `«${word}» ${formatMetric(m.after.recall5)}`).join(', ')}),` +
        ' но взят он не отбором: до отбора там стояло больше.')
  )
}

export function verdict(parsed) {
  const rows = EVAL_MODES.map(([key, word]) => [key, word, parsed.modes[key]]).filter(
    ([, , m]) => m !== null && m.before.mrr10 !== null && m.after.mrr10 !== null,
  )
  if (rows.length === 0) return null
  const best = rows.reduce((a, b) =>
    b[2].after.mrr10 - b[2].before.mrr10 > a[2].after.mrr10 - a[2].before.mrr10 ? b : a,
  )
  const gain = best[2].after.mrr10 - best[2].before.mrr10
  if (gain >= NOTABLE)
    return {
      lead: `Отбор поднял MRR@10 на ${formatMetric(gain)}. `,
      text:
        `Лучший режим — «${best[1]}». Это выше порога заметности ${formatMetric(NOTABLE)}, которым ADR выбирает режим для следующего дня.` +
        recallText(parsed),
    }
  if (gain <= -NOTABLE)
    return {
      lead: `Отбор опустил MRR@10 на ${formatMetric(Math.abs(gain))}. `,
      text:
        'Вторая ступень здесь мешает, а не помогает: она выбрасывает фрагменты, которые стояли выше по близости.' +
        recallText(parsed),
    }
  return {
    lead: 'Разницы нет. ',
    text:
      `Ни один режим не сдвинул MRR@10 больше чем на ${formatMetric(NOTABLE)}. Это результат дня, а не недоделанный прогон: потолок отбора при десяти кандидатах был назван до прогона — верного документа нет и в десятке почти у половины вопросов эталона.` +
      recallText(parsed),
  }
}

/**
 * Границы метода — ВНУТРИ секции и без раскрытия чего-либо: «насколько
 * уверенно» — часть ответа. Числа берутся из файла; чего в файле нет, о том
 * строка молчит.
 */
export function limitsText(parsed) {
  const parts = [
    'Прогон механический: судьи нет, ранги считаются по эталону вопросов службы поиска той же формулой, что меряет её собственный прогон.',
  ]
  if (parsed.total !== null)
    parts.push(
      `Вопросов в прогоне ${parsed.total} — меньше, чем в эталоне службы: суточный потолок дня занят платными вызовами, и объём выбран владельцем под него.`,
    )
  if (parsed.index?.commit)
    parts.push(`Индекс того прогона — ${parsed.index.commit.slice(0, 7)}; на другом индексе числа будут другими.`)
  return parts.join(' ')
}
