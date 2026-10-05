// Правила показа ИТОГОВ ПРОГОНА дня 24 — чистые функции без DOM. Проверяются
// исполнением в test/evalview.test.js; DOM живёт в app.js.
//
// Мера дня 24 — ДЕСЯТЬ вопросов дня 22 (`days/day22/eval/questions.json`):
// восемь с эталоном и два общих, без источника в проекте вовсе
// (ADR 2026-10-05-0544, п. 0.3). Половина меры механическая — исход, источники,
// цитаты, точное совпадение пути, — половина судейская: два вердикта 0/1/2
// ставит отдельный экземпляр роли `reviewer` (ADR, п. 2.5).
//
// Все числа секции приходят ИЗ ФАЙЛА `eval.json`. Ни одно не стоит литералом в
// разметке, включая число вопросов и состав набора: изменится файл — изменится
// и текст. Файл пишет прогон (PR 2 дня 24); на момент этого PR его нет, и
// страница говорит об этом словами — честное пустое состояние, а не недоделка.
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
  return {
    total: parsed.questions.length,
    ran: ran.length,
    outcomes,
    unknown,
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
  const unsupported =
    bad === 0
      ? ''
      : ` ${bad} ${plural(bad, 'ответ', 'ответа', 'ответов')} ${plural(bad, 'нечем', 'нечем', 'нечем')} проверить по источникам: цитаты в них есть, во фрагментах их нет.`
  return { lead: head, text: `${expectation}${unsupported}` }
}

/** Прогнаны не все вопросы — об этом говорится прямо, числом из файла. */
export function partialNote(t) {
  if (t.total === 0 || t.ran === t.total) return null
  return `Прогнано ${t.ran} ${plural(t.ran, 'вопрос', 'вопроса', 'вопросов')} из ${t.total}: у остальных запуска не было.`
}

/**
 * Границы метода — текст с числами ИЗ ДАННЫХ. Состав набора приходит полем
 * `set` каждого вопроса: изменится состав — изменится текст.
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
    ' ответе. Поэтому рядом с механикой стоят два вердикта, и ставит их тоже модель.'
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
