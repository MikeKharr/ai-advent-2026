// Механика сравнения — исполнением (days/day22/eval/score.mjs).
//
// Предмет: четыре признака считаются по тексту ответа и выдаче поиска, вердикт
// не считается НИКОГДА, а «нечего проверять» (`null`) и «проверили, нет»
// (`false`) — разные ответы. Последнее важнее всего остального в этом файле:
// страница печатает строку механики только для не-`null`, и подмена одного
// другим превратила бы «поиска не было» в «источник не найден».

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildReport,
  checkReport,
  flatten,
  pendingVerdicts,
  RUBRIC,
  scoreRun,
} from '../eval/score.mjs'

const DOD = 'agent_docs/guides/dod.md'

/** Вопрос набора в форме questions.json. */
const ask = (over = {}) => ({
  id: 'q08',
  origin: 'q08',
  set: 'first',
  question: 'что входит в Definition of Done проекта',
  expect: 'верный ответ',
  key: 'snapshot.md',
  sources: [DOD],
  ...over,
})

/** Ответ запуска в форме result агента (agents/src/rag-agent.js). */
const result = (over = {}) => ({
  mode: 'rag',
  answer: 'ответ',
  refused: false,
  sources: [{ n: 1, source: DOD, section: '', score: 0.7, text: 'текст' }],
  index: { commit: '57a5cd7', strategy: 'structural', chunks: 3167 },
  ...over,
})

test('нормализация сводит регистр и переносы и больше ничего', () => {
  assert.equal(flatten(' Два\n  слова '), 'два слова')
  // Буква ё отдельной буквой и остаётся: сведение её к е сделало бы `key`
  // дешевле ровно на те вопросы, где фраза различается только ею.
  assert.notEqual(flatten('подчёркивание'), flatten('подчеркивание'))
  assert.equal(flatten(null), '')
})

test('верный источник среди найденных — да, не среди найденных — нет', () => {
  assert.equal(scoreRun(ask(), 'rag', result()).retrieved, true)
  const other = result({ sources: [{ n: 1, source: 'README.md', section: '', score: 0.3 }] })
  assert.equal(scoreRun(ask(), 'rag', other).retrieved, false)
})

test('путь источника сравнивается точно, а не по вхождению', () => {
  // Что это держит: подмену точного сравнения на `includes`, при которой
  // найденный `agent_docs/guides/dod.md.bak` сошёл бы за верный источник.
  const near = result({ sources: [{ n: 1, source: `${DOD}.bak`, section: '', score: 0.9 }] })
  assert.equal(scoreRun(ask(), 'rag', near).retrieved, false)
})

test('у режима без RAG поиска не было — это null, а не «не найден»', () => {
  const m = scoreRun(ask(), 'norag', result({ sources: [] }))
  assert.equal(m.retrieved, null)
})

test('у общего вопроса верного источника не бывает — null в обоих режимах', () => {
  const general = ask({ id: 'm01', origin: null, set: 'general', key: null, sources: [] })
  for (const mode of ['rag', 'norag']) {
    const m = scoreRun(general, mode, result())
    assert.equal(m.retrieved, null, `${mode}: источник`)
    assert.equal(m.cited, null, `${mode}: назван`)
    assert.equal(m.key, null, `${mode}: ключевая фраза`)
  }
})

test('источник назван в ответе — да; назван другой — нет', () => {
  const named = result({ answer: `Это описано в ${DOD}, раздел «Минимальный DoD».` })
  assert.equal(scoreRun(ask(), 'rag', named).cited, true)
  const wrong = result({ answer: 'Это описано в agent_docs/snapshot.md.' })
  assert.equal(scoreRun(ask(), 'rag', wrong).cited, false)
})

test('ключевая фраза ищется нормализованно', () => {
  const split = result({ answer: 'Среди пунктов —\nSnapshot.md  обновлён.' })
  assert.equal(scoreRun(ask(), 'rag', split).key, true)
  assert.equal(scoreRun(ask(), 'rag', result({ answer: 'без неё' })).key, false)
})

test('отказ берётся полем ответа запуска, а не ищется по фразе второй раз', () => {
  // Что это держит: вторую копию фразы отказа в прогоне. Ответ ниже фразу
  // несёт, но агент отказом его не счёл — и прогон обязан согласиться с
  // агентом, иначе страница и файл разойдутся на одном и том же ответе.
  const said = result({ answer: 'В найденных фрагментах ответа нет.', refused: false })
  assert.equal(scoreRun(ask(), 'rag', said).refused, false)
  assert.equal(scoreRun(ask(), 'rag', result({ answer: 'своими словами', refused: true })).refused, true)
})

test('вердикт прогон не ставит никогда', () => {
  for (const mode of ['rag', 'norag']) assert.equal(scoreRun(ask(), mode, result()).verdict, null)
})

test('битый ответ запуска не роняет прогон и не выдумывает текст', () => {
  const m = scoreRun(ask(), 'rag', null)
  assert.equal(m.answer, '')
  assert.equal(m.retrieved, false)
  assert.equal(m.cited, false)
  assert.equal(m.key, false)
})

const questions = [ask(), ask({ id: 'm01', origin: null, set: 'general', key: null, sources: [] })]

function report(over = {}) {
  const runs = new Map([
    ['q08:rag', { result: result({ answer: `по ${DOD}: snapshot.md обновлён` }) }],
    ['q08:norag', { result: result({ answer: 'по памяти', sources: [] }) }],
    ['m01:rag', { result: result({ answer: 'про MCP' }) }],
    ['m01:norag', { result: result({ answer: 'про MCP по памяти', sources: [] }) }],
  ])
  return buildReport({
    questions,
    runs,
    ranAt: '2026-10-04T20:00:00.000Z',
    index: { commit: '57a5cd7', strategy: 'structural' },
    ...over,
  })
}

test('файл результата несёт дату, коммит индекса и текст рубрики', () => {
  const r = report()
  assert.equal(r.ranAt, '2026-10-04T20:00:00.000Z')
  assert.equal(r.index.commit, '57a5cd7')
  assert.equal(r.judge.rubric, RUBRIC)
  // Имя судьи не выдумывается прогоном: судейства ещё не было.
  assert.equal(r.judge.name, null)
  assert.equal(pendingVerdicts(r), 4)
})

test('неудавшийся запуск не попадает в режимы, но и не теряется', () => {
  const runs = new Map([
    ['q08:rag', { failure: { code: 'search_refused', message: 'суточный потолок' } }],
    ['q08:norag', { result: result({ answer: 'по памяти', sources: [] }) }],
  ])
  const r = buildReport({ questions: [ask()], runs, ranAt: 'x', index: {} })
  assert.equal(r.questions[0].modes.rag, undefined, 'режима в файле нет — страница скажет «не прогнан»')
  assert.ok(r.questions[0].modes.norag, 'второй режим на месте')
  assert.deepEqual(r.failures, [
    { id: 'q08', mode: 'rag', code: 'search_refused', message: 'суточный потолок' },
  ])
})

test('целый файл результата претензий не вызывает', () => {
  assert.deepEqual(checkReport(report(), questions), [])
})

test('проверка формы ловит вердикт вне рубрики и строкой', () => {
  const r = report()
  r.questions[0].modes.rag.verdict = '2'
  assert.deepEqual(checkReport(r, questions), ['q08/rag: вердикт "2" вне рубрики 0/1/2'])
  r.questions[0].modes.rag.verdict = 3
  assert.deepEqual(checkReport(r, questions), ['q08/rag: вердикт 3 вне рубрики 0/1/2'])
  r.questions[0].modes.rag.verdict = 2
  assert.deepEqual(checkReport(r, questions), [])
})

test('проверка формы ловит потерянные дату, коммит и рубрику', () => {
  const r = report()
  delete r.ranAt
  r.index.commit = ''
  r.judge.rubric = null
  const problems = checkReport(r, questions)
  assert.deepEqual(problems, [
    'нет даты прогона (ranAt)',
    'нет коммита индекса (index.commit)',
    'нет текста рубрики (judge.rubric)',
  ])
})

test('проверка формы ловит чужой вопрос и разъехавшийся текст', () => {
  const r = report()
  r.questions[0].id = 'q07'
  assert.deepEqual(checkReport(r, questions), ['вопрос "q07" не из набора'])
  const other = report()
  other.questions[0].question = 'другой вопрос'
  other.questions[1].set = 'first'
  assert.deepEqual(checkReport(other, questions), [
    'q08: текст вопроса разошёлся',
    'm01: часть набора разошлась с questions.json',
  ])
})

test('проверка формы ловит ответ без текста и признак не да/нет', () => {
  const r = report()
  r.questions[0].modes.rag.answer = ''
  r.questions[0].modes.rag.cited = 'да'
  r.questions[0].modes.norag.refused = null
  assert.deepEqual(checkReport(r, questions), [
    'q08/rag: нет текста ответа',
    'q08/rag: cited — не да/нет и не «нечего проверять»',
    'q08/norag: refused — не да/нет',
  ])
})
