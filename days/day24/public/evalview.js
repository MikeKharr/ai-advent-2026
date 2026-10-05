// Правила показа ИТОГОВ ПРОГОНА дня 24 — чистые функции без DOM. Проверяются
// исполнением в test/evalview.test.js; DOM живёт в app.js.
//
// Мера дня 24 — ДЕСЯТЬ вопросов дня 22 (`days/day22/eval/questions.json`):
// восемь с эталоном и два общих, без источника в проекте вовсе
// (ADR 2026-10-05-0544, п. 0.3). Половина меры механическая — исход, источники,
// цитаты, точное совпадение пути, — половина судейская: два вердикта 0/1/2
// ставит отдельный экземпляр роли `reviewer` (ADR, п. 2.5).
//
// СУДЕЙСТВА НА ПРОГОНЕ 2026-10-05 НЕ БЫЛО (решение владельца: день 24 сдаёт
// только механику). Поэтому ни одно место здесь не считает вердикт сделанным:
// `verdictWord` говорит «не прогнан», а `limitsText` не обещает вердиктов,
// которых нет (`judged`). Файл с вердиктами эти же функции обслуживают без
// правок — судейская половина не удалена, она просто может быть пустой.
//
// Все числа секции приходят ИЗ ФАЙЛА `eval.json`. Ни одно не стоит литералом в
// разметке, включая число вопросов и состав набора: изменится файл — изменится
// и текст. Файл пишет прогон (`days/day24/eval/run.mjs`); нет файла — страница
// говорит об этом словами, честным пустым состоянием, а не недоделкой.
//
// Чего здесь НЕТ, и это следствие долгов дня 22:
//
//   честное «не знаю» НЕ попадает в одно ведро с неверным ответом. Исходов
//   четыре, и каждый — своя строка сводки: в дне 22 отказ и выдумка получали
//   один вердикт 0 (пункт «Владельцу» в `agent_docs/backlog.md`);
//
//   признак «источник назван» НЕ ищет путь подстрокой в тексте ответа. Он
//   приходит полем `cited_exact` и сравнивает ПУТЬ С ПУТЁМ: подстрочная
//   механика дня 22 ошибалась в обе стороны (q72, q57).

import { plural } from './run.js'

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v) => (typeof v === 'string' ? v : '')
const int = (v) => (Number.isInteger(v) ? v : null)

/**
 * Исходы в порядке строк сводки — те же четыре, что на пульте, и те же слова.
 * Порядок не «от хорошего к плохому»: сперва два исхода с ответом, потом два
 * вида «не знаю», потому что различать их и есть предмет дня.
 */
export const OUTCOME_ROWS = [
  ['answered', 'ответ с подтверждённой цитатой'],
  ['unsupported', 'ответ без подтверждения'],
  ['unknown_model', '«не знаю» от модели'],
  ['unknown_filter', '«не знаю» от отбора'],
]

/** Вердикт судьи словом (рубрика 0/1/2). Цифра стоит рядом со словом в теле. */
export const VERDICT_WORD = { 2: 'да', 1: 'частично', 0: 'нет' }

/** Два вопроса судье. Формулировки — ADR, п. 2.5, и они не пересказываются. */
export const JUDGE_ROWS = [
  ['meaning', 'смысл ответа совпадает с цитатами'],
  ['correct', 'ответ верен по эталону'],
]

/** Вопрос не прогнан. Заглушки «—» здесь нет (I-8). */
export const NOT_RUN = 'не прогнан'

/** Сверка цитат: все / часть / ни одной — три состояния, и они не сливаются. */
export const VERIFIED_WORD = {
  all: 'все цитаты нашлись дословно',
  some: 'часть цитат нашлась дословно',
  none: 'ни одна цитата не нашлась дословно',
}

/**
 * Разбор `eval.json`. Форма проверяется, а не принимается на веру: файл
 * собирает прогон, и недостающее поле обязано стать отсутствием строки, а не
 * `undefined` на экране.
 *
 * `set` — к какой части набора отнесён вопрос: `first` (поиск находил верный
 * документ первым), `missed` (промахивался), `general` (вопроса в проекте нет
 * вовсе). Из него считается состав набора и ожидание «не знаю», названное в
 * ADR заранее.
 */
export function parseEval(raw) {
  const d = isObject(raw) ? raw : {}
  const judge = isObject(d.judge) ? d.judge : {}
  const index = isObject(d.index) ? d.index : {}
  return {
    ranAt: str(d.ranAt) || null,
    // Режим прогона — из файла. Литерала здесь нет: прогон мог идти не тем
    // режимом, который стоит на странице сегодня.
    mode: str(d.mode) || null,
    index: { commit: str(index.commit) || null, strategy: str(index.strategy) || null },
    judge: { name: str(judge.name) || null, rubric: str(judge.rubric) || null },
    note: str(d.note) || null,
    questions: (Array.isArray(d.questions) ? d.questions : []).filter(isObject).map((q) => {
      const r = isObject(q.run) ? q.run : null
      return {
        id: str(q.id) || null,
        set: ['first', 'missed', 'general'].includes(q.set) ? q.set : null,
        question: str(q.question),
        expect: (Array.isArray(q.expect) ? q.expect : []).filter((s) => str(s) !== ''),
        run:
          r === null
            ? null
            : {
                outcome: OUTCOME_ROWS.some(([key]) => key === r.outcome) ? r.outcome : null,
                answer: str(r.answer),
                hasSources: typeof r.has_sources === 'boolean' ? r.has_sources : null,
                hasQuotes: typeof r.has_quotes === 'boolean' ? r.has_quotes : null,
                verified: ['all', 'some', 'none'].includes(r.quotes_verified) ? r.quotes_verified : null,
                citedExact: typeof r.cited_exact === 'boolean' ? r.cited_exact : null,
                meaning: [0, 1, 2].includes(r.meaning) ? r.meaning : null,
                correct: [0, 1, 2].includes(r.correct) ? r.correct : null,
              },
      }
    }),
  }
}

/** Слово исхода в строке вопроса. Исхода нет — «не прогнан», а не пустота. */
export function outcomeWord(run) {
  if (run === null || run.outcome === null) return NOT_RUN
  return OUTCOME_ROWS.find(([key]) => key === run.outcome)[1]
}

/** Слово вердикта судьи. Не судили — так и сказано, а не ноль (I-8). */
export function verdictWord(value) {
  return value === null ? NOT_RUN : VERDICT_WORD[value]
}

/**
 * Числа сводки. Считаются ТОЛЬКО по прогнанным вопросам: вопрос без запуска в
 * ведро исхода не падает и сумму не портит.
 *
 * `expectedUnknown` — сколько вопросов набора ОБЯЗАНЫ были дать «не знаю»:
 * общие (источника в проекте нет) и промахи поиска. Ожидание названо в ADR
 * (п. 2.5) заранее, и сводка сверяет его числом, а не впечатлением.
 */
export function tally(parsed) {
  const ran = parsed.questions.filter((q) => q.run !== null)
  const outcomes = {}
  for (const [key] of OUTCOME_ROWS) outcomes[key] = ran.filter((q) => q.run.outcome === key).length
  const unknown = outcomes.unknown_model + outcomes.unknown_filter
  const judge = {}
  for (const [key] of JUDGE_ROWS)
    judge[key] = { 0: 0, 1: 0, 2: 0 }
  for (const q of ran)
    for (const [key] of JUDGE_ROWS) {
      const v = q.run[key]
      if (v !== null) judge[key][v] += 1
    }
  // ПОЧЕМУ `unsupported` РАЗБИТ НА ДВА. «Нечем проверить» бывает по двум
  // разным причинам, и одной фразой они сливались в неправду: у q94 прогона
  // 2026-10-05 цитат не было вовсе, а фраза уверяла, что «цитаты в них есть,
  // во фрагментах их нет» (находка `design-review` к PR #319). Это та же
  // разница, которую пульт одного запуска держит константами `QUOTES_NONE` и
  // `UNVERIFIED_NOTE`, и сводка обязана её держать тоже (I-8).
  //
  // Третий случай — прогон не сказал, были ли цитаты (`hasQuotes === null`), —
  // не падает ни в одно ведро: иначе сумма двух чисел молча расходилась бы с
  // числом ответов без подтверждения.
  const bad = ran.filter((q) => q.run.outcome === 'unsupported')
  const unsupported = {
    noQuotes: bad.filter((q) => q.run.hasQuotes === false).length,
    unverified: bad.filter((q) => q.run.hasQuotes === true).length,
  }
  return {
    total: parsed.questions.length,
    ran: ran.length,
    outcomes,
    unknown,
    unsupported,
    judge,
    expectedUnknown: parsed.questions.filter((q) => q.set === 'general' || q.set === 'missed').length,
  }
}

/**
 * Фраза вывода, СОБРАННАЯ ИЗ ЧИСЕЛ, а не выбранная автором. При неполном
 * прогоне её нет вовсе: десяти вопросов, о которых она говорит, ещё не было.
 *
 * Про ожидание «не знаю» сказано в обе стороны — и когда оно сошлось, и когда
 * нет: ожидание названо в ADR до прогона, и прятать его несовпадение значило бы
 * оставить на экране только удачный случай.
 */
export function verdict(t) {
  if (t.ran === 0 || t.ran < t.total) return null
  const ok = t.outcomes.answered
  const bad = t.outcomes.unsupported
  const head =
    `По ${t.ran} ${plural(t.ran, 'вопросу', 'вопросам', 'вопросам')}: ` +
    `${ok} ${plural(ok, 'ответ', 'ответа', 'ответов')} с подтверждённой цитатой, ` +
    `${t.unknown} «не знаю», ` +
    `${bad} без подтверждения.`
  const expectation =
    t.expectedUnknown === 0
      ? ''
      : t.unknown >= t.expectedUnknown
        ? ` Ожидание сошлось: «не знаю» ожидалось у ${t.expectedUnknown} ${plural(t.expectedUnknown, 'вопроса', 'вопросов', 'вопросов')} набора, и столько их и вышло или больше.`
        : ` Ожидание не сошлось: «не знаю» ожидалось у ${t.expectedUnknown} ${plural(t.expectedUnknown, 'вопроса', 'вопросов', 'вопросов')} набора, а вышло у ${t.unknown}.`
  // Причины «нечем проверить» названы порознь и только те, что встретились:
  // одна фраза на оба случая была бы ложью про один из них.
  const why = []
  if (t.unsupported.noQuotes > 0)
    why.push(
      `у ${t.unsupported.noQuotes} ${plural(t.unsupported.noQuotes, 'ответа', 'ответов', 'ответов')} цитат нет вовсе`,
    )
  if (t.unsupported.unverified > 0)
    why.push(`у ${t.unsupported.unverified} цитаты есть, но во фрагментах не нашлись`)
  const restBad = bad - t.unsupported.noQuotes - t.unsupported.unverified
  if (restBad > 0) why.push(`про ${restBad} прогон не сказал, были ли цитаты`)
  const unsupported =
    bad === 0
      ? ''
      : ` ${bad} ${plural(bad, 'ответ', 'ответа', 'ответов')} нечем проверить по источникам: ${why.join('; ')}.`
  return { lead: head, text: `${expectation}${unsupported}` }
}

/** Прогнаны не все вопросы — об этом говорится прямо, числом из файла. */
export function partialNote(t) {
  if (t.total === 0 || t.ran === t.total) return null
  return `Прогнано ${t.ran} ${plural(t.ran, 'вопрос', 'вопроса', 'вопросов')} из ${t.total}: у остальных запуска не было.`
}

/**
 * Строки вердиктов для сводки: `[заголовок строки, значение клетки]`.
 *
 * ПРАВИЛО ЖИВЁТ ЗДЕСЬ, А НЕ В DOM, потому что оно правило показа, а не
 * разметка: `app.js` только рисует то, что вернула эта функция, и проверяется
 * она исполнением.
 *
 * Не судили — ОДНА строка со словом вместо трёх строк нулей. Нуль в строке
 * «ответ верен по эталону: да» читается как «верных нет», то есть как
 * суждение, которого никто не выносил (находка `design-review` к PR #319).
 */
export function judgeSummaryRows(t) {
  const rows = []
  for (const [key, label] of JUDGE_ROWS) {
    const counts = t.judge[key]
    if (counts[0] + counts[1] + counts[2] === 0) {
      rows.push([label, verdictWord(null)])
      continue
    }
    for (const value of [2, 1, 0]) rows.push([`${label}: ${verdictWord(value)}`, String(counts[value])])
  }
  return rows
}

/**
 * Стоит ли рядом с механикой хоть один вердикт судьи.
 *
 * Считается ПО ВЕРДИКТАМ, а не по `judge.name`: имя в файле могло появиться
 * без выставленных вердиктов, и тогда страница обещала бы суждение, которого
 * на экране нет. Предмет вопроса — то, что видно в таблице.
 */
export function judged(parsed) {
  return parsed.questions.some(
    (q) => q.run !== null && JUDGE_ROWS.some(([key]) => q.run[key] !== null),
  )
}

/**
 * Границы метода — текст с числами ИЗ ДАННЫХ. Состав набора приходит полем
 * `set` каждого вопроса: изменится состав — изменится текст.
 *
 * ПОСЛЕДНЯЯ ФРАЗА ЗАВИСИТ ОТ ТОГО, СУДИЛИ ЛИ. Сверка цитат ловит форму, а не
 * правду, — и эту границу закрывают два вердикта судьи. Если судейства не было,
 * закрывать её нечем, и сказать «рядом с механикой стоят два вердикта» значило
 * бы пообещать несделанное: ровно это и случилось на прогоне 2026-10-05, где
 * вердиктов ноль (находка `reviewer` к PR #319).
 */
export function limitsText(parsed) {
  const n = parsed.questions.length
  const by = (name) => parsed.questions.filter((q) => q.set === name).length
  const first = by('first')
  const missed = by('missed')
  const general = by('general')
  const unknown = n - first - missed - general
  const composition =
    n === 0
      ? ''
      : ` Набор — вопросы дня 22: ${first} ${plural(first, 'вопрос', 'вопроса', 'вопросов')}, где поиск находил верный документ первым, ` +
        `${missed}, где он промахивался, и ${general} ${plural(general, 'общий', 'общих', 'общих')} — без источника в проекте вовсе.` +
        (unknown > 0
          ? ` Ещё ${unknown} ${plural(unknown, 'вопрос', 'вопроса', 'вопросов')} состав не называет.`
          : '')
  return (
    `Вопросов ${n}, статистики здесь нет.${composition}` +
    ' На каждый вопрос взят один образец ответа; повтор даст другие тексты.' +
    ' Сверка цитат ловит ФОРМУ, а не правду: подтверждённая цитата не обещает верного' +
    ' пересказа, а цитата из обрезанного хвоста фрагмента не подтвердится и при верном' +
    ' ответе.' +
    (judged(parsed)
      ? ' Поэтому рядом с механикой стоят два вердикта, и ставит их тоже модель.'
      : ' Эту границу закрывали бы два вердикта судьи, но судейство не проводилось:' +
        ' вердиктов в этом прогоне нет, и закрывать её нечем.')
  )
}

/**
 * Строки механики в раскрытом теле: «что: да/нет», без галочек и точек. Чего
 * прогон не сказал, того в списке нет — прочерк на месте признака был бы
 * заглушкой (I-8).
 */
export function mechanics(run) {
  if (run === null) return []
  const yn = (v) => (v === null ? null : v ? 'да' : 'нет')
  const rows = []
  const sources = yn(run.hasSources)
  if (sources !== null) rows.push(`источники названы: ${sources}`)
  const quotes = yn(run.hasQuotes)
  if (quotes !== null) rows.push(`цитаты приведены: ${quotes}`)
  if (run.verified !== null) rows.push(VERIFIED_WORD[run.verified])
  const exact = yn(run.citedExact)
  if (exact !== null) rows.push(`путь источника совпал с эталоном точно: ${exact}`)
  return rows
}

/** У общего вопроса верного источника не бывает — так и сказано. */
export const GENERAL_NOTE =
  'Этого вопроса в проекте нет: верного источника у него не бывает, и «не знаю» здесь — верный исход, а не промах.'
