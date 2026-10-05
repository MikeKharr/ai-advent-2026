// Механика меры дня 24 исполнением: четыре признака, исход и форма файла.
// Сети здесь нет вовсе — предмет проверки чистые функции `eval/score.mjs`.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildReport,
  checkReport,
  citedExact,
  judgedVerdicts,
  NOTE,
  pendingVerdicts,
  scoreRun,
  verifiedWord,
} from '../eval/score.mjs'

const DOD = 'agent_docs/guides/dod.md'
const OTHER = 'agent_docs/guides/verification.md'

const ask = (over = {}) => ({
  id: 'q08',
  set: 'first',
  question: 'что входит в Definition of Done проекта',
  sources: [DOD],
  ...over,
})

/** Результат запуска дня 24 — поля контракта `day24-cited-contract.md`. */
const answered = (over = {}) => ({
  mode: 'rerank',
  outcome: 'answered',
  answer: 'ответ по корпусу',
  cited: [{ n: 1, source: DOD, section: '', claimedSource: DOD, claimedSection: '' }],
  quotes: [{ n: 1, text: 'снимок', verified: true }],
  checks: { sources_present: true, quotes_present: true, quotes_verbatim: true, cited_exact: true },
  index: { commit: 'abc1234', strategy: 'structural' },
  ...over,
})

test('дословность цитат — три слова и «нечего сверять» четвёртым случаем', () => {
  assert.equal(verifiedWord([{ verified: true }, { verified: true }]), 'all')
  assert.equal(verifiedWord([{ verified: true }, { verified: false }]), 'some')
  assert.equal(verifiedWord([{ verified: false }]), 'none')
  // Цитат не было — сверки не было, и «ни одна не нашлась» было бы ложным
  // упрёком сверке, которой не случилось.
  assert.equal(verifiedWord([]), null)
})

test('путь эталона сверяется ТОЧНО, а не подстрокой (находка дня 22 про q72)', () => {
  // Путь эталона — суффикс названного: подстрочная механика дня 22 сказала бы
  // «да». Здесь — «нет», и это весь смысл замены признака.
  assert.equal(citedExact([{ source: `prefix/${DOD}` }], [DOD]), false)
  assert.equal(citedExact([{ source: DOD }], [DOD]), true)
  // Названо несколько источников, эталон среди них — «да».
  assert.equal(citedExact([{ source: OTHER }, { source: DOD }], [DOD]), true)
  assert.equal(citedExact([{ source: OTHER }], [DOD]), false)
})

test('cited_exact меры и checks.cited_exact агента — РАЗНЫЕ величины', () => {
  // Агент говорит «да»: модель назвала ровно тот путь, что стоит у фрагмента.
  // Но фрагмент — из чужого файла, и эталон вопроса не назван. Мера обязана
  // сказать «нет»: иначе она мерила бы аккуратность ссылок, а не верность.
  const run = scoreRun(
    ask(),
    answered({
      cited: [{ n: 1, source: OTHER, claimedSource: OTHER, section: '', claimedSection: '' }],
      checks: { sources_present: true, quotes_present: true, quotes_verbatim: true, cited_exact: true },
    }),
  )
  assert.equal(run.cited_exact, false, 'мера повторила признак агента вместо сверки с эталоном')
})

test('у общего вопроса признака эталона нет вовсе, а не «нет»', () => {
  const run = scoreRun(ask({ id: 'm01', set: 'general', sources: [] }), answered())
  assert.equal(run.cited_exact, null)
})

test('признаки источников и цитат берутся из checks агента', () => {
  const run = scoreRun(ask(), answered({ checks: { sources_present: false, quotes_present: false } }))
  assert.equal(run.has_sources, false)
  assert.equal(run.has_quotes, false)
})

test('исход вне четырёх — не исход, а пусто', () => {
  assert.equal(scoreRun(ask(), answered({ outcome: 'отлично' })).outcome, null)
  assert.equal(scoreRun(ask(), answered({ outcome: 'unknown_filter' })).outcome, 'unknown_filter')
})

test('вердикты механика не ставит — ни при каком ответе', () => {
  const run = scoreRun(ask(), answered())
  assert.equal(run.meaning, null)
  assert.equal(run.correct, null)
})

const questions = [ask(), ask({ id: 'm01', set: 'general', question: 'что такое MCP', sources: [] })]

const build = (runs) =>
  buildReport({
    questions,
    runs: new Map(runs),
    ranAt: '2026-10-05T10:00:00.000Z',
    mode: 'rerank',
    index: { commit: 'abc1234', strategy: 'structural' },
  })

test('expect файла — это ПУТИ эталона: их читает страница под подписью «верный источник»', () => {
  const report = build([['q08', { result: answered() }]])
  assert.deepEqual(report.questions[0].expect, [DOD])
  assert.deepEqual(report.questions[1].expect, [])
})

test('отказ запуска даёт run: null и строку в failures — он не теряется', () => {
  const report = build([['q08', { failure: { code: 'answer_invalid', message: 'не по форме' } }]])
  assert.equal(report.questions[0].run, null)
  assert.deepEqual(report.failures, [{ id: 'q08', code: 'answer_invalid', message: 'не по форме' }])
  // Вопроса, которого в прогоне не было вовсе, в failures нет: отказа не было.
  assert.equal(report.questions[1].run, null)
  assert.equal(report.failures.length, 1)
})

test('судья в собранном файле пуст, а подпись говорит об этом словами', () => {
  const report = build([['q08', { result: answered() }]])
  assert.equal(report.judge.name, null)
  assert.equal(report.judge.rubric, null)
  assert.equal(report.note, NOTE)
  assert.match(report.note, /судейство не проводилось/i)
})

test('форма целого файла претензий не вызывает', () => {
  const report = build([
    ['q08', { result: answered() }],
    ['m01', { result: answered({ outcome: 'unknown_model', cited: [], quotes: [] }) }],
  ])
  assert.deepEqual(checkReport(report, questions), [])
})

test('checkReport ловит каждую порчу поля по очереди', () => {
  const good = build([['q08', { result: answered() }]])
  const cases = [
    [(r) => (r.ranAt = ''), /ranAt/],
    [(r) => (r.mode = 'rag'), /режим прогона/],
    [(r) => (r.index.commit = ''), /index\.commit/],
    [(r) => (r.index.strategy = ''), /index\.strategy/],
    [(r) => (r.note = ''), /note/],
    [(r) => (r.judge.name = 7), /judge\.name/],
    [(r) => (r.judge.rubric = 7), /judge\.rubric/],
    [(r) => r.questions.pop(), /вопросов 1, а в наборе 2/],
    [(r) => (r.questions[0].id = 'q99'), /не из набора/],
    [(r) => (r.questions[0].set = 'missed'), /часть набора/],
    [(r) => (r.questions[0].question = 'другой'), /текст вопроса/],
    [(r) => (r.questions[0].expect = [OTHER]), /пути эталона/],
    [(r) => (r.questions[0].run.outcome = 'хорошо'), /исход/],
    [(r) => (r.questions[0].run.answer = ''), /нет текста ответа/],
    [(r) => (r.questions[0].run.has_sources = 'да'), /has_sources/],
    [(r) => (r.questions[0].run.has_quotes = null), /has_quotes/],
    [(r) => (r.questions[0].run.quotes_verified = 'почти'), /quotes_verified/],
    [(r) => (r.questions[0].run.cited_exact = null), /cited_exact — не да\/нет/],
    [(r) => (r.questions[0].run.correct = '2'), /вне рубрики/],
  ]
  for (const [bend, expected] of cases) {
    const copy = structuredClone(good)
    bend(copy)
    const problems = checkReport(copy, questions)
    assert.ok(
      problems.some((p) => expected.test(p)),
      `порча ${expected} не поймана: ${JSON.stringify(problems)}`,
    )
  }
})

test('признак эталона у общего вопроса ловится в обратную сторону тоже', () => {
  const report = build([['m01', { result: answered({ cited: [], quotes: [] }) }]])
  const copy = structuredClone(report)
  copy.questions[1].run.cited_exact = false
  assert.ok(
    checkReport(copy, questions).some((p) => /cited_exact назван, а эталона/.test(p)),
    'выдуманный признак у вопроса без эталона прошёл молча',
  )
})

test('вердикт без имени судьи — претензия; отсутствие вердиктов — нет', () => {
  const report = build([['q08', { result: answered() }]])
  assert.equal(judgedVerdicts(report), 0)
  assert.deepEqual(checkReport(report, questions), [], 'пустые вердикты сами по себе не претензия')
  const judged = structuredClone(report)
  judged.questions[0].run.correct = 2
  assert.equal(judgedVerdicts(judged), 1)
  assert.ok(
    checkReport(judged, questions).some((p) => /имени судьи/.test(p)),
    'вердикт появился без судьи и это прошло',
  )
  judged.judge.name = 'reviewer (экземпляр 2)'
  assert.deepEqual(checkReport(judged, questions), [])
})

test('пустые вердикты считаются только у прогнанных вопросов', () => {
  // Два вердикта на один прогнанный вопрос; непрогнанный не ждёт ничего.
  const report = build([['q08', { result: answered() }]])
  assert.equal(pendingVerdicts(report), 2)
})
