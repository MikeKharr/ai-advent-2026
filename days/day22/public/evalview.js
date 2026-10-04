// Правила секции «Итоги 10 контрольных вопросов» — чистые функции без DOM
// (раскладка 2026-10-04-1003, п. 9). Проверяются исполнением в
// test/evalview.test.js.
//
// ПОЧЕМУ ВЫНЕСЕНО. Правило «страница не утверждает больше, чем считает»
// ломалось у страницы дня 21 дважды, и оба раза ловилось ревью, а не CI
// (`site/day21/verdict.js`, шапка). Здесь вердикт и состав набора — тот же
// предмет, и у них тот же держатель: функции, которые исполняет тест.
//
// Все числа секции приходят ИЗ ФАЙЛА `eval.json` (ADR 2026-10-04-0735, п. 6).
// Ни одно не стоит литералом в разметке — включая состав набора 6/2/2 и число
// вопросов: изменится файл, изменится и текст (п. 9.3, критерий 10).
//
// Файл пишет прогон (PR 3 дня 22). На момент этого PR его нет, и страница
// говорит об этом словами — это честное пустое состояние, а не недоделка
// (п. 10).

import { plural } from './run.js'

/** Порядок режимов на экране — тот же, что в сводке и в строке вопроса. */
export const MODES = ['rag', 'norag']

/** Вердикт рубрики словом (п. 9.4). Цифра живёт рядом со словом в раскрытом теле. */
export const VERDICT_WORD = { 2: 'верно', 1: 'частично', 0: 'неверно' }
/** Отказ — свой случай, не вердикт: он занимает место вердикта в сводке. */
export const REFUSED_WORD = 'отказ'
/** Режим у вопроса не прогнан. Заглушки «—» здесь нет (I-8). */
export const NOT_RUN = 'не прогнан'

/** Порог шума — два вопроса из десяти, как на странице дня 21 (п. 9.1). */
export const NOISE = 2

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v) => (typeof v === 'string' ? v : '')
const int = (v) => (Number.isInteger(v) ? v : null)

/**
 * Разбор `eval.json`. Форма проверяется, а не принимается на веру: файл
 * собирает прогон, и недостающее поле обязано стать отсутствием строки, а не
 * `undefined` на экране.
 *
 * `set` — к какой части набора отнесён вопрос: `first` (поиск находил верный
 * документ первым в обеих стратегиях), `missed` (промахивался в обеих),
 * `general` (вопроса в проекте нет вовсе). Из него считается состав набора
 * в тексте границ метода (п. 9.3).
 */
export function parseEval(raw) {
  const d = isObject(raw) ? raw : {}
  const judge = isObject(d.judge) ? d.judge : {}
  const index = isObject(d.index) ? d.index : {}
  return {
    ranAt: str(d.ranAt) || null,
    index: { commit: str(index.commit) || null, strategy: str(index.strategy) || null },
    judge: { name: str(judge.name) || null, rubric: str(judge.rubric) || null },
    questions: (Array.isArray(d.questions) ? d.questions : []).filter(isObject).map((q) => {
      const modes = isObject(q.modes) ? q.modes : {}
      const one = (name) => {
        const m = modes[name]
        if (!isObject(m)) return null
        return {
          answer: str(m.answer),
          retrieved: typeof m.retrieved === 'boolean' ? m.retrieved : null,
          cited: typeof m.cited === 'boolean' ? m.cited : null,
          key: typeof m.key === 'boolean' ? m.key : null,
          refused: m.refused === true,
          verdict: [0, 1, 2].includes(m.verdict) ? m.verdict : null,
        }
      }
      return {
        id: str(q.id) || null,
        set: ['first', 'missed', 'general'].includes(q.set) ? q.set : null,
        question: str(q.question),
        expect: str(q.expect) || null,
        key: str(q.key) || null,
        sources: (Array.isArray(q.sources) ? q.sources : []).filter((s) => str(s) !== ''),
        rag: one('rag'),
        norag: one('norag'),
      }
    }),
  }
}

/** Слово вердикта в сводке строки: отказ — отдельный случай, не прогнан — третий. */
export function verdictWord(mode) {
  if (mode === null) return NOT_RUN
  if (mode.refused) return REFUSED_WORD
  return mode.verdict === null ? NOT_RUN : VERDICT_WORD[mode.verdict]
}

/**
 * Четыре числа на режим (п. 9.1). Считаются ТОЛЬКО по вопросам, где прогнаны
 * ОБА режима: сравнение по разным наборам сравнением не является.
 *
 * Отказ занимает место вердикта, а не добавляется к нему: иначе суммы строк
 * сошлись бы к большему, чем число вопросов, и сводка солгала бы о своём
 * основании (пример п. 9.1: 6 + 2 + 0 + 2 = 10).
 */
export function tally(parsed) {
  const compared = parsed.questions.filter((q) => q.rag !== null && q.norag !== null)
  const counts = {}
  for (const name of MODES) {
    const rows = { correct: 0, partial: 0, wrong: 0, refused: 0 }
    for (const q of compared) {
      const m = q[name]
      if (m.refused) rows.refused += 1
      else if (m.verdict === 2) rows.correct += 1
      else if (m.verdict === 1) rows.partial += 1
      else if (m.verdict === 0) rows.wrong += 1
    }
    counts[name] = rows
  }
  return { compared: compared.length, total: parsed.questions.length, counts }
}

/**
 * Фраза вывода, СОБРАННАЯ ИЗ ЧИСЕЛ, а не выбранная автором (п. 9.1). Три
 * случая, и третий обязателен: подменять его выбором по одной колонке
 * нельзя (I-8 по духу).
 *
 * При неполном прогоне вывода нет вовсе (п. 10): десяти вопросов, о которых
 * он говорит, ещё не было.
 */
export function verdict(t) {
  if (t.compared < t.total || t.compared === 0) return null
  const rag = t.counts.rag
  const norag = t.counts.norag
  const dCorrect = rag.correct - norag.correct
  if (Math.abs(dCorrect) <= NOISE)
    return {
      kind: 'same',
      lead: 'Режимы на этом наборе не различились:',
      text: ` разница не больше ${NOISE} ${plural(NOISE, 'вопроса', 'вопросов', 'вопросов')} из ${t.compared}.`,
    }
  const better = dCorrect > 0 ? 'rag' : 'norag'
  const worse = better === 'rag' ? 'norag' : 'rag'
  const name = { rag: 'с RAG', norag: 'без RAG' }
  // Числа могут расходиться: верных больше у одного режима, а выдуманных —
  // тоже у него. Одного вывода такие числа не дают, и так и говорится.
  if (t.counts[better].wrong > t.counts[worse].wrong)
    return {
      kind: 'split',
      lead: 'Числа расходятся:',
      text:
        ` верных больше у режима ${name[better]}, выдуманных — тоже. ` +
        `Одного вывода эти ${t.compared} ${plural(t.compared, 'вопрос', 'вопроса', 'вопросов')} не дают.`,
    }
  return {
    kind: 'better',
    lead: `По ${t.compared} ${plural(t.compared, 'вопросу', 'вопросам', 'вопросам')} режим ${name[better]} вернее:`,
    text:
      ` ${t.counts[better].correct} ${plural(t.counts[better].correct, 'ответ', 'ответа', 'ответов')} ` +
      `верны и подтверждены источником против ${t.counts[worse].correct}; ` +
      `выдуманных — ${t.counts[better].wrong} против ${t.counts[worse].wrong}.`,
  }
}

/** Прогнаны не все вопросы в обоих режимах — об этом говорится прямо (п. 10). */
export function partialNote(t) {
  if (t.total === 0 || t.compared === t.total) return null
  return (
    `Сравнение считается по ${t.compared} ${plural(t.compared, 'вопросу', 'вопросам', 'вопросам')} ` +
    `из ${t.total}: у остальных прогнан один режим.`
  )
}

/**
 * Границы метода (п. 9.3) — текст с числами ИЗ ДАННЫХ. Состав набора
 * (6 / 2 / 2 на сегодня) приходит полем `set` каждого вопроса: изменится
 * состав — изменится текст.
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
      : ` Набор отобран по рангам прогона дня 21, а не случайно: ` +
        `${first} ${plural(first, 'вопрос', 'вопроса', 'вопросов')}, где поиск находил верный документ первым, ` +
        `${missed}, где он промахивался в обеих стратегиях, и ` +
        `${general} ${plural(general, 'общий', 'общих', 'общих')} — без источника в проекте вовсе.` +
        // Вопрос без пометки состава не прячется в одну из трёх групп: иначе
        // сумма в тексте не сошлась бы с числом вопросов молча.
        (unknown > 0
          ? ` Ещё ${unknown} ${plural(unknown, 'вопрос', 'вопроса', 'вопросов')} состав не называет.`
          : '')
  return (
    `Вопросов ${n}, статистики здесь нет.${composition}` +
    ' На каждый вопрос взят один образец ответа; повтор даст другие тексты.' +
    ' Сверка по ключевой фразе ловит форму, а не смысл. Судья — тоже модель.'
  )
}

/** Строки механики в раскрытом теле (п. 9.4): «что: да/нет», без галочек и точек. */
export function mechanics(mode, { rag }) {
  if (mode === null) return []
  const yn = (v) => (v === null ? null : v ? 'да' : 'нет')
  const rows = []
  if (rag) {
    const found = yn(mode.retrieved)
    if (found !== null) rows.push(`источник найден: ${found}`)
  } else {
    rows.push('поиска не было')
  }
  const cited = yn(mode.cited)
  if (cited !== null) rows.push(`источник назван: ${cited}`)
  const key = yn(mode.key)
  if (key !== null) rows.push(`ключевая фраза: ${key}`)
  return rows
}

/** У общего вопроса верного источника не бывает — так и сказано (п. 9.4). */
export const GENERAL_NOTE =
  'Этого вопроса в проекте нет: верного источника у него не бывает, и строгий промпт обязан отказать.'
