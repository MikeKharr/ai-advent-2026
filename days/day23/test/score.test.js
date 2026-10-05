// Механика меры дня 23 — исполнением (days/day23/eval/score.mjs).
//
// Предмет: ранги считаются той же формулой, что меряет собственный прогон
// службы поиска (`rag/metrics.py`), отбор вопросов детерминирован, а сводка не
// может разойтись со строками таблицы под ней. Судьи у этой меры нет вовсе, и
// проверять его нечем.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { EVAL_MODES, METRICS, parseEval } from '../public/evalview.js'
import {
  buildReport,
  checkReport,
  mergeReports,
  MODES,
  PICK_COUNT,
  PICK_STEP,
  pendingRuns,
  recallAt,
  reciprocalRank,
  scoreRun,
  selectQuestions,
  summarize,
} from '../eval/score.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const QUERIES = join(here, '..', '..', '..', 'rag', 'eval', 'queries.json')
const METRICS_PY = join(here, '..', '..', '..', 'rag', 'metrics.py')

const INV = 'agent_docs/invariants.md'
const DOD = 'agent_docs/guides/dod.md'

const frag = (n, source) => ({ n, source, section: '', score: 0.5 })
const ask = (over = {}) => ({ id: 'q01', question: 'вопрос', expect: [INV], ...over })

test('отбор вопросов — каждый третий по порядку, ровно 30, и это q01…q88', () => {
  const queries = JSON.parse(readFileSync(QUERIES, 'utf8')).queries
  assert.equal(queries.length, 100, 'эталон сменил размер — объём прогона пересчитывается')
  const picked = selectQuestions(queries)
  assert.equal(picked.length, PICK_COUNT)
  assert.equal(picked[0].id, 'q01')
  assert.equal(picked[1].id, 'q04')
  assert.equal(picked.at(-1).id, 'q88')
  // Шаг — свойство отбора, а не совпадение: между соседними ровно три номера.
  const numberOf = (id) => Number(id.slice(1))
  for (let at = 1; at < picked.length; at += 1)
    assert.equal(numberOf(picked[at].id) - numberOf(picked[at - 1].id), PICK_STEP, `шаг сбился на ${picked[at].id}`)
  // Текст и верные документы берутся из эталона, а не переписываются.
  assert.equal(picked[0].question, queries[0].question)
  assert.deepEqual(picked[0].expect, queries[0].expected)
})

test('отбор не смотрит ни на ранги, ни на содержание — только на место в списке', () => {
  // ЧТО ЭТО ДЕРЖИТ: «без подбора» из решения владельца. Мутация «брать вопросы
  // с самым длинным списком верных документов» прошла бы проверку выше, если бы
  // та сверяла только число 30.
  const queries = Array.from({ length: 12 }, (_, at) => ({
    id: `x${at}`,
    question: `в${at}`,
    expected: [`${at}.md`],
  }))
  assert.deepEqual(
    selectQuestions(queries, { count: 4 }).map((q) => q.id),
    ['x0', 'x3', 'x6', 'x9'],
  )
  // Набор короче требуемого — берётся сколько есть, а не выдумывается добор.
  assert.equal(selectQuestions(queries.slice(0, 4), { count: 30 }).length, 2)
})

test('формулы рангов — те же, что в rag/metrics.py: доля делится на верные документы вопроса', () => {
  // Доля считается по ВЕРНЫМ ДОКУМЕНТАМ ВОПРОСА, а не по числу найденного и не
  // по k (находка гейтов дня 21).
  assert.equal(recallAt([INV, 'a', 'b'], [INV, DOD]), 0.5)
  assert.equal(recallAt([INV, DOD], [INV, DOD]), 1)
  assert.equal(recallAt(['a', 'b', 'c', 'd', 'e', INV], [INV]), 0, 'шестое место попало в Recall@5')
  assert.equal(recallAt([INV], []), 0, 'без верных документов доля не единица')

  assert.equal(reciprocalRank([INV], [INV]), 1)
  assert.equal(reciprocalRank(['a', 'b', INV], [INV]), 1 / 3)
  assert.equal(reciprocalRank(Array(9).fill('a').concat(INV), [INV]), 1 / 10)
  assert.equal(reciprocalRank(Array(10).fill('a').concat(INV), [INV]), 0, 'одиннадцатое место попало в MRR@10')
})

test('срезы метрик равны срезам rag/metrics.py — копия числа под проверкой', () => {
  // Единица `rag/` на Python, импортировать нечего, поэтому 5 и 10 стоят здесь
  // копией. Что держит копию: сменится срез там — покраснеет здесь, а не
  // разойдутся числа дней 21 и 23 молча.
  const py = readFileSync(METRICS_PY, 'utf8')
  assert.match(py, /RECALL_K = 5/, 'срез Recall в rag/metrics.py уже не 5')
  assert.match(py, /MRR_K = 10/, 'срез MRR в rag/metrics.py уже не 10')
  assert.match(
    py,
    /len\(\[e for e in expected if e in top\]\) \/ len\(expected\)/,
    'recall_at_k считает уже не долю верных документов вопроса',
  )
})

test('одна выдача запуска даёт ДВА числа: до отбора и после', () => {
  const m = scoreRun(ask(), {
    candidates: [frag(1, 'a'), frag(2, INV), frag(3, 'b')],
    sources: [frag(2, INV)],
    outcome: 'answered',
  })
  assert.deepEqual(m.before, { recall5: 1, mrr10: 0.5 }, 'до отбора верный документ стоял вторым')
  assert.deepEqual(m.after, { recall5: 1, mrr10: 1 }, 'после отбора он первый')
  assert.equal(m.candidates, 3)
  assert.equal(m.kept, 1)
  assert.equal(m.empty, false)
})

test('пустой отбор берётся ИСХОДОМ запуска, а не выводится из нуля оставленных', () => {
  const empty = scoreRun(ask(), { candidates: [frag(1, 'a')], sources: [], outcome: 'unknown_filter' })
  assert.equal(empty.empty, true)
  assert.deepEqual(empty.after, { recall5: 0, mrr10: 0 }, 'отбор ничего не оставил — рангов «после» нет')
  // Тот же ноль оставленных, но исход другой: «не знаю» объявляет агент, и
  // второго правила для того же вывода мера не заводит.
  const answered = scoreRun(ask(), { candidates: [frag(1, 'a')], sources: [], outcome: 'answered' })
  assert.equal(answered.empty, false)
})

test('судьба второго поиска записывается полем — иначе числа rewrite не прочитать', () => {
  // ПОЧЕМУ ЭТО ВАЖНО: «переписывание не помогло» и «служба отказала на втором
  // поиске» дают ОДИНАКОВЫЕ ранги. Без этого поля режим `rewrite` мог бы
  // оказаться замером `rerank` под другим именем, и заметить это было бы
  // нечем. Значение берётся у агента, а не выводится из числа кандидатов.
  const ok = scoreRun(ask(), { candidates: [frag(1, INV)], sources: [frag(1, INV)], rewriteSearch: 'ok' })
  assert.equal(ok.rewriteSearch, 'ok')
  const failed = scoreRun(ask(), { candidates: [frag(1, INV)], sources: [], rewriteSearch: 'failed' })
  assert.equal(failed.rewriteSearch, 'failed')
  // Режим без второго поиска поля не несёт — и это `null`, а не «ok».
  assert.equal(scoreRun(ask(), { candidates: [], sources: [] }).rewriteSearch, null)

  // Значение вне контракта дня сверку валит: опечатка не должна читаться как
  // состояние поиска.
  const questions = [ask()]
  const report = buildReport({
    questions,
    runs: new Map([['q01:rewrite', { result: { candidates: [frag(1, INV)], sources: [frag(1, INV)], rewriteSearch: 'ok' } }]]),
    at: '2026-10-05T09:00:00.000Z',
    index: { commit: 'c', strategy: 's', chunks: 7 },
  })
  assert.deepEqual(checkReport(report, questions), [])
  const typo = structuredClone(report)
  typo.questions[0].rewrite.rewriteSearch = 'оk'
  assert.ok(
    checkReport(typo, questions).some((p) => p.includes('вне контракта дня')),
    'значение вне контракта прошло сверку',
  )
  // Поля могло не быть вовсе — строки приёма 1 собраны раннером до него.
  const older = structuredClone(report)
  delete older.questions[0].rewrite.rewriteSearch
  assert.deepEqual(checkReport(older, questions), [], 'отсутствие поля объявлено ошибкой формы')
})

test('сводка — среднее по прогнанным, а «не прогнали» не считается нулём', () => {
  const rows = [
    { before: { recall5: 1, mrr10: 1 }, after: { recall5: 1, mrr10: 1 }, candidates: 10, kept: 2, empty: false },
    { before: { recall5: 0, mrr10: 0 }, after: { recall5: 0, mrr10: 0 }, candidates: 10, kept: 0, empty: true },
    null,
  ]
  const got = summarize(rows)
  assert.deepEqual(got.before, { recall5: 0.5, mrr10: 0.5 })
  assert.equal(got.ran, 2, 'непрогнанный вопрос попал в знаменатель')
  assert.equal(got.emptyPicks, 1)
  assert.equal(summarize([null, null]), null, 'из ничего вышла сводка')
})

test('пустой отбор входит в среднее «после» нулями, и это названо, а не спрятано', () => {
  // ЧТО ЭТО ДЕРЖИТ: исключение таких вопросов из среднего завысило бы «после»
  // ровно на тех вопросах, где отбор сработал хуже всего. Мутация «считать
  // только непустые» оставила бы `ran` равным 1 и `after.mrr10` равным 1.
  const rows = [
    { before: { recall5: 1, mrr10: 1 }, after: { recall5: 1, mrr10: 1 }, candidates: 10, kept: 2, empty: false },
    { before: { recall5: 1, mrr10: 1 }, after: { recall5: 0, mrr10: 0 }, candidates: 10, kept: 0, empty: true },
  ]
  const got = summarize(rows)
  assert.equal(got.ran, 2)
  assert.deepEqual(got.after, { recall5: 0.5, mrr10: 0.5 })
})

test('отчёт собирается в форме, которую читает страница', () => {
  const questions = [ask(), ask({ id: 'q04', expect: [DOD] })]
  const runs = new Map([
    ['q01:rerank', { result: { candidates: [frag(1, INV)], sources: [frag(1, INV)], outcome: 'answered' } }],
    ['q04:rerank', { failure: { code: 'search_empty', message: 'поиск ничего не нашёл' } }],
  ])
  const report = buildReport({ questions, runs, at: '2026-10-05T09:00:00.000Z', index: { commit: 'c', strategy: 's', chunks: 7 } })
  assert.equal(report.questionsTotal, 2)
  assert.equal(report.modes.rerank.ran, 1)
  assert.equal(report.modes.rewrite, null, 'непрогнанный режим стал нулями вместо «не прогнали»')
  assert.equal(report.questions[1].rerank, null, 'отказ стал числами')
  assert.deepEqual(report.failures, [{ id: 'q04', mode: 'rerank', code: 'search_empty', message: 'поиск ничего не нашёл' }])
  assert.equal(pendingRuns(report), 3)

  // Та же форма разбирается страницей — иначе прогон писал бы в пустоту.
  const parsed = parseEval(report)
  assert.equal(parsed.total, 2)
  assert.equal(parsed.modes.rerank.ran, 1)
  assert.equal(parsed.questions[0].rerank.after.mrr10, 1)
})

test('режимы и метрики прогона совпадают с режимами и метриками страницы', () => {
  assert.deepEqual(MODES, EVAL_MODES.map(([key]) => key), 'прогон и страница мерят разные режимы')
  assert.deepEqual(['recall5', 'mrr10'], METRICS.map(([key]) => key))
})

test('второй приём дописывает недостающее и не затирает первого', () => {
  const questions = [ask(), ask({ id: 'q04', expect: [DOD] })]
  const firstRun = buildReport({
    questions,
    runs: new Map([
      ['q01:rerank', { result: { candidates: [frag(1, INV)], sources: [frag(1, INV)], outcome: 'answered' } }],
    ]),
    at: 'первый',
    index: { commit: 'c', strategy: 's', chunks: 7 },
  })
  const secondRun = buildReport({
    questions,
    runs: new Map([
      ['q01:rewrite', { result: { candidates: [frag(1, INV)], sources: [frag(1, INV)], outcome: 'answered' } }],
    ]),
    at: 'второй',
    index: { commit: 'c', strategy: 's', chunks: 7 },
  })
  const merged = mergeReports(firstRun, secondRun)
  assert.ok(merged.questions[0].rerank, 'приём 2 стёр измеренное приёмом 1')
  assert.ok(merged.questions[0].rewrite)
  assert.equal(merged.at, 'второй', 'дата прогона осталась от прошлого приёма')
  // Сводки ПЕРЕСЧИТАНЫ по слитым строкам, а не сложены: среднее от средних на
  // разных объёмах — не среднее.
  assert.equal(merged.modes.rerank.ran, 1)
  assert.equal(merged.modes.rewrite.ran, 1)
  assert.deepEqual(checkReport(merged, questions), [])
})

test('отказ прошлого приёма остаётся в файле, пока вопрос так и не измерен', () => {
  const questions = [ask()]
  const failed = buildReport({
    questions,
    runs: new Map([['q01:rerank', { failure: { code: 'search_failed', message: 'служба молчит' } }]]),
    at: 'первый',
    index: { commit: 'c', strategy: 's', chunks: 7 },
  })
  const retried = buildReport({
    questions,
    runs: new Map([
      ['q01:rerank', { result: { candidates: [frag(1, INV)], sources: [frag(1, INV)], outcome: 'answered' } }],
    ]),
    at: 'второй',
    index: { commit: 'c', strategy: 's', chunks: 7 },
  })
  assert.deepEqual(mergeReports(failed, retried).failures, [], 'вопрос измерен, а старый отказ остался висеть')
  const stillEmpty = buildReport({ questions, runs: new Map(), at: 'второй', index: { commit: 'c', strategy: 's', chunks: 7 } })
  assert.equal(mergeReports(failed, stillEmpty).failures.length, 1, 'причина пропуска потерялась вместе с приёмом')
})

test('сверка формы ловит разъезд сводки со строками таблицы', () => {
  const questions = [ask()]
  const report = buildReport({
    questions,
    runs: new Map([
      ['q01:rerank', { result: { candidates: [frag(1, 'a'), frag(2, INV)], sources: [frag(2, INV)], outcome: 'answered' } }],
    ]),
    at: '2026-10-05T09:00:00.000Z',
    index: { commit: 'c', strategy: 's', chunks: 7 },
  })
  assert.deepEqual(checkReport(report, questions), [])

  // ЧТО ЭТО ДЕРЖИТ: число на экране правится руками в одну строку, а строки
  // таблицы под ним — нет. Без пересчёта подмена прошла бы молча.
  const tweaked = structuredClone(report)
  tweaked.modes.rerank.after.mrr10 = 0.9
  assert.ok(
    checkReport(tweaked, questions).some((p) => p.includes('сводка rerank')),
    'подменённая сводка прошла сверку',
  )
})

test('сверка формы ловит разъезд вопроса с эталоном и негодные числа', () => {
  const questions = [ask(), ask({ id: 'q04', expect: [DOD] })]
  const base = buildReport({
    questions,
    runs: new Map([['q01:rerank', { result: { candidates: [frag(1, INV)], sources: [frag(1, INV)], outcome: 'answered' } }]]),
    at: '2026-10-05T09:00:00.000Z',
    index: { commit: 'c', strategy: 's', chunks: 7 },
  })
  const broken = {
    'текст вопроса разошёлся': (r) => (r.questions[0].question = 'подменённый вопрос'),
    'верные документы разошлись': (r) => (r.questions[0].expect = ['NOT-A-FILE.md']),
    'а по отбору q04': (r) => (r.questions[1].id = 'q99'),
    'не доля от 0 до 1': (r) => (r.questions[0].rerank.after.recall5 = 42),
    'empty — не да/нет': (r) => (r.questions[0].rerank.empty = 'да'),
    'пустой отбор, а оставленных': (r) => (r.questions[0].rerank.empty = true),
    'нет даты прогона': (r) => (r.at = ''),
    'нет коммита индекса': (r) => (r.index.commit = ''),
    'questionsTotal': (r) => (r.questionsTotal = 99),
  }
  for (const [expected, breakIt] of Object.entries(broken)) {
    const copy = structuredClone(base)
    breakIt(copy)
    const problems = checkReport(copy, questions)
    assert.ok(
      problems.some((p) => p.includes(expected)),
      `подмена «${expected}» прошла молча: ${problems.join('; ') || 'претензий нет'}`,
    )
  }
})
