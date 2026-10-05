// Правила показа итогов прогона — исполнением (days/day24/public/evalview.js).
//
// Предмет здесь поведенческий: какие числа и какие слова даст секция при
// таких-то данных файла. Файла прогона на момент этого PR нет вовсе, и это
// отдельный проверяемый случай: пустой вход обязан дать честное пустое
// состояние, а не нули и не `undefined` на экране.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  GENERAL_NOTE,
  judged,
  JUDGE_ROWS,
  judgeSummaryRows,
  limitsText,
  mechanics,
  NOT_RUN,
  OUTCOME_ROWS,
  outcomeWord,
  parseEval,
  partialNote,
  tally,
  verdict,
  verdictWord,
  VERIFIED_WORD,
} from '../public/evalview.js'

const run = (over = {}) => ({
  outcome: 'answered',
  answer: 'Ответ модели.',
  has_sources: true,
  has_quotes: true,
  quotes_verified: 'all',
  cited_exact: true,
  meaning: 2,
  correct: 2,
  ...over,
})

const question = (over = {}) => ({
  id: 'q01',
  set: 'first',
  question: 'где держится инвариант I-4',
  expect: ['agent_docs/invariants.md'],
  run: run(),
  ...over,
})

const file = (questions) => ({
  ranAt: '2026-10-05T12:00:00Z',
  mode: 'rerank',
  index: { commit: '57a5cd7', strategy: 'structural' },
  judge: { name: 'reviewer (отдельный экземпляр)', rubric: 'две шкалы 0/1/2' },
  questions,
})

test('пустого файла хватает на честное пустое состояние, а не на нули', () => {
  for (const raw of [undefined, null, 42, {}, { questions: 'нет' }]) {
    const parsed = parseEval(raw)
    assert.deepEqual(parsed.questions, [], String(raw))
    const t = tally(parsed)
    assert.equal(t.total, 0)
    assert.equal(t.ran, 0)
    // Вывода у пустого прогона нет вовсе: вопросов, о которых он говорит, не было.
    assert.equal(verdict(t), null)
    assert.equal(partialNote(t), null)
    // И текст границ метода не выдумывает состава набора, которого нет.
    assert.ok(!/\bНабор\b/.test(limitsText(parsed)), limitsText(parsed))
  }
})

test('поля файла разбираются по одному, и чужое значение полем не становится', () => {
  const parsed = parseEval(file([question()]))
  assert.equal(parsed.mode, 'rerank')
  assert.equal(parsed.judge.name, 'reviewer (отдельный экземпляр)')
  const q = parsed.questions[0]
  assert.equal(q.id, 'q01')
  assert.equal(q.set, 'first')
  assert.deepEqual(q.expect, ['agent_docs/invariants.md'])
  assert.equal(q.run.outcome, 'answered')
  assert.equal(q.run.verified, 'all')
  // Чужие значения становятся `null`, а не попадают на экран как есть.
  const bad = parseEval(
    file([question({ set: 'что-то', expect: ['', 7], run: run({ outcome: 'refused', quotes_verified: 'почти', meaning: 3, cited_exact: 'да' }) })]),
  ).questions[0]
  assert.equal(bad.set, null)
  assert.deepEqual(bad.expect, [])
  assert.equal(bad.run.outcome, null)
  assert.equal(bad.run.verified, null)
  assert.equal(bad.run.meaning, null)
  assert.equal(bad.run.citedExact, null)
  // Вопрос без запуска — `null`, а не пустой запуск с нулями.
  assert.equal(parseEval(file([question({ run: undefined })])).questions[0].run, null)
})

test('исходов четыре, и честное «не знаю» не сливается с ответом без подтверждения', () => {
  assert.deepEqual(
    OUTCOME_ROWS.map(([key]) => key),
    ['answered', 'unsupported', 'unknown_model', 'unknown_filter'],
  )
  const t = tally(
    parseEval(
      file([
        question({ id: 'q01', run: run({ outcome: 'answered' }) }),
        question({ id: 'q02', run: run({ outcome: 'unsupported' }) }),
        question({ id: 'q03', set: 'missed', run: run({ outcome: 'unknown_model' }) }),
        question({ id: 'q04', set: 'general', run: run({ outcome: 'unknown_filter' }) }),
      ]),
    ),
  )
  assert.deepEqual(t.outcomes, {
    answered: 1,
    unsupported: 1,
    unknown_model: 1,
    unknown_filter: 1,
  })
  // Два вида «не знаю» СКЛАДЫВАЮТСЯ в одно число только для фразы вывода, а в
  // сводке остаются порознь: решил реранкер или решила модель — разные вещи.
  assert.equal(t.unknown, 2)
  // И ни один из них не попал в ведро «без подтверждения»: ровно это смешение
  // и было долгом дня 22.
  assert.equal(t.outcomes.unsupported, 1)
})

test('сумма исходов считается по прогнанным, и непрогнанный вопрос её не портит', () => {
  const t = tally(parseEval(file([question(), question({ id: 'q02', run: undefined })])))
  assert.equal(t.total, 2)
  assert.equal(t.ran, 1)
  assert.equal(Object.values(t.outcomes).reduce((a, b) => a + b, 0), 1)
  assert.equal(partialNote(t), 'Прогнано 1 вопрос из 2: у остальных запуска не было.')
  // Вывода при неполном прогоне нет: он говорит обо всём наборе.
  assert.equal(verdict(t), null)
})

test('вердикты судьи считаются по трём значениям, и «не судили» не ноль', () => {
  assert.deepEqual(
    JUDGE_ROWS.map(([key]) => key),
    ['meaning', 'correct'],
  )
  const t = tally(
    parseEval(
      file([
        question({ id: 'q01', run: run({ meaning: 2, correct: 1 }) }),
        question({ id: 'q02', run: run({ meaning: 0, correct: null }) }),
      ]),
    ),
  )
  assert.deepEqual(t.judge.meaning, { 0: 1, 1: 0, 2: 1 })
  // `correct: null` НЕ стал нулём: «не судили» и «вердикт 0» — разные вещи.
  assert.deepEqual(t.judge.correct, { 0: 0, 1: 1, 2: 0 })
  assert.equal(verdictWord(null), NOT_RUN)
  assert.equal(verdictWord(0), 'нет')
  assert.equal(verdictWord(2), 'да')
})

test('фраза вывода собрана из чисел и сверяет ожидание «не знаю» в обе стороны', () => {
  const made = (outcomes, sets) =>
    tally(
      parseEval(
        file(outcomes.map((outcome, i) => question({ id: `q0${i}`, set: sets[i], run: run({ outcome }) }))),
      ),
    )
  // Ожидание сошлось: «не знаю» ждали у двух вопросов, вышло у двух.
  const ok = verdict(made(['answered', 'unknown_model', 'unknown_filter', 'answered'], ['first', 'missed', 'general', 'first']))
  assert.match(ok.lead, /^По 4 вопросам: 2 ответа с подтверждённой цитатой, 2 «не знаю», 0 без подтверждения\.$/)
  assert.match(ok.text, /Ожидание сошлось/)
  // РАЗЛИЧАЮЩИЙ СЛУЧАЙ: ожидание названо в ADR ДО прогона, и его несовпадение
  // обязано попасть на экран, а не исчезнуть вместе с удачным случаем.
  const miss = verdict(made(['answered', 'answered', 'unsupported', 'answered'], ['first', 'missed', 'general', 'first']))
  assert.match(miss.text, /Ожидание не сошлось/)
  assert.match(miss.text, /ожидалось у 2 вопросов набора, а вышло у 0/)
  // И ответ без подтверждения не назван ни верным, ни выдуманным.
  assert.match(miss.text, /нечем проверить по источникам/)
  assert.ok(!/выдум/i.test(miss.text), miss.text)
})

test('границы метода считают состав набора по данным, а не по литералу', () => {
  const text = limitsText(
    parseEval(
      file([
        question({ id: 'q01', set: 'first' }),
        question({ id: 'q02', set: 'first' }),
        question({ id: 'q03', set: 'missed' }),
        question({ id: 'q04', set: 'general' }),
        question({ id: 'q05', set: null }),
      ]),
    ),
  )
  assert.match(text, /Вопросов 5, статистики здесь нет\./)
  assert.match(text, /2 вопроса, где поиск находил верный документ первым/)
  assert.match(text, /1, где он промахивался/)
  assert.match(text, /1 общий/)
  // Вопрос без пометки состава не прячется в одну из трёх групп: иначе сумма в
  // тексте не сошлась бы с числом вопросов молча.
  assert.match(text, /Ещё 1 вопрос состав не называет/)
  // И названа граница самой сверки: она ловит форму, а не правду.
  assert.match(text, /ловит ФОРМУ, а не правду/)
})

test('механика — строки по пришедшему; чего не сказали, того в списке нет', () => {
  const parsedRun = (over) => parseEval(file([question({ run: run(over) })])).questions[0].run
  assert.deepEqual(mechanics(parsedRun()), [
    'источники названы: да',
    'цитаты приведены: да',
    VERIFIED_WORD.all,
    'путь источника совпал с эталоном точно: да',
  ])
  // Поля `has_quotes` в файле не было — строки о цитатах нет вовсе, а не
  // «цитаты приведены: нет»: непришедшее не проваленное (I-8).
  assert.deepEqual(
    mechanics(parsedRun({ has_quotes: undefined, quotes_verified: 'none', cited_exact: false })),
    ['источники названы: да', VERIFIED_WORD.none, 'путь источника совпал с эталоном точно: нет'],
  )
  assert.deepEqual(mechanics(null), [])
})

test('исход словом, а у общего вопроса «не знаю» назван верным исходом', () => {
  assert.equal(outcomeWord(null), NOT_RUN)
  assert.equal(outcomeWord({ outcome: null }), NOT_RUN)
  assert.equal(outcomeWord({ outcome: 'unknown_filter' }), '«не знаю» от отбора')
  // Общий вопрос: источника у него не бывает, и «не знаю» здесь не промах.
  assert.match(GENERAL_NOTE, /верный исход, а не промах/)
})

// ——— судейства могло не быть: ни одно место не считает вердикт сделанным ———
// (находки `reviewer` и `design-review` к PR #319 на живом прогоне 2026-10-05,
// где вердиктов ноль)

/** Вопрос без вердиктов — то, что даёт прогон без судейства. */
const unjudged = (over = {}) => question({ run: run({ meaning: null, correct: null }), ...over })

test('границы метода НЕ обещают вердиктов, которых нет', () => {
  const text = limitsText(parseEval(file([unjudged({ id: 'q01' })])))
  assert.match(text, /судейство не проводилось/)
  assert.match(text, /закрывать её нечем/)
  // Обещания «рядом стоят два вердикта» в этой ветви быть не должно: оно и
  // было неправдой на живых данных.
  assert.ok(!/стоят два вердикта/.test(text), text)
})

test('границы метода обещают вердикты, когда они есть', () => {
  const text = limitsText(parseEval(file([question({ id: 'q01' })])))
  assert.match(text, /рядом с механикой стоят два вердикта/)
  assert.ok(!/судейство не проводилось/.test(text), text)
})

test('судили или нет — считается по вердиктам, а не по имени судьи', () => {
  // Имя в файле есть у обоих: `file` его ставит. Различает только вердикт.
  assert.equal(judged(parseEval(file([question({ id: 'q01' })]))), true)
  assert.equal(judged(parseEval(file([unjudged({ id: 'q01' })]))), false)
  // Один вердикт из двух — уже судили: обещание про вердикты становится правдой.
  assert.equal(judged(parseEval(file([question({ id: 'q01', run: run({ meaning: null }) })]))), true)
  // Непрогнанный вопрос вердикта не ждёт и за судейство не считается.
  assert.equal(judged(parseEval(file([question({ id: 'q01', run: null })]))), false)
})

test('сводка вердиктов без судейства — слово, а не три нуля', () => {
  const t = tally(parseEval(file([unjudged({ id: 'q01' }), unjudged({ id: 'q02' })])))
  const rows = judgeSummaryRows(t)
  // Две строки, по одной на вопрос судьи, и в каждой — слово.
  assert.deepEqual(rows, [
    ['смысл ответа совпадает с цитатами', NOT_RUN],
    ['ответ верен по эталону', NOT_RUN],
  ])
  // Нуля в клетках нет вовсе: именно он читался как «верных нет».
  assert.ok(!rows.some(([, cell]) => cell === '0'), JSON.stringify(rows))
})

test('сводка вердиктов с судейством — три строки на вопрос, с числами', () => {
  const t = tally(
    parseEval(
      file([question({ id: 'q01' }), question({ id: 'q02', run: run({ meaning: 1, correct: 0 }) })]),
    ),
  )
  assert.deepEqual(judgeSummaryRows(t), [
    ['смысл ответа совпадает с цитатами: да', '1'],
    ['смысл ответа совпадает с цитатами: частично', '1'],
    ['смысл ответа совпадает с цитатами: нет', '0'],
    ['ответ верен по эталону: да', '1'],
    ['ответ верен по эталону: частично', '0'],
    ['ответ верен по эталону: нет', '1'],
  ])
})

// ——— «нечем проверить» бывает по двум причинам, и фраза их не сливает ———

const bad = (id, hasQuotes) =>
  question({
    id,
    run: run({
      outcome: 'unsupported',
      has_sources: true,
      has_quotes: hasQuotes,
      quotes_verified: hasQuotes ? 'none' : null,
    }),
  })

/** Ответ без подтверждения, у которого И ИСТОЧНИКОВ не названо (cited.js:316). */
const noSrc = (id) =>
  question({
    id,
    run: run({
      outcome: 'unsupported',
      has_sources: false,
      has_quotes: false,
      quotes_verified: null,
    }),
  })

test('ответ без цитат вовсе и ответ с ненайденными цитатами названы порознь', () => {
  // q94 живого прогона: цитат не было вовсе. Прежняя фраза уверяла, что
  // «цитаты в них есть, во фрагментах их нет», — про него это ложь.
  const t = tally(parseEval(file([bad('q01', false), bad('q02', true), bad('q03', true)])))
  assert.deepEqual(t.unsupported, { noSources: 0, noQuotes: 1, unverified: 2 })
  const v = verdict(t)
  assert.match(v.text, /3 ответа нечем проверить по источникам/)
  assert.match(v.text, /у 1 ответа цитат нет вовсе/)
  assert.match(v.text, /у 2 цитаты есть, но во фрагментах не нашлись/)
})

test('«источники не названы» — свой случай, а не «цитат нет вовсе»', () => {
  // Исход `unsupported` накрывает и это (`agents/src/rag/cited.js`:
  // `sources.length > 0 && verified > 0 ? 'answered' : 'unsupported'`). Без
  // своей строки такой ответ назывался бы «цитат нет вовсе» — правдой,
  // умалчивающей о главном: цитировать было нечего (находка `reviewer`, #319).
  const t = tally(parseEval(file([noSrc('q01'), bad('q02', false)])))
  assert.deepEqual(t.unsupported, { noSources: 1, noQuotes: 1, unverified: 0 })
  const v = verdict(t)
  assert.match(v.text, /у 1 ответа источники не названы/)
  assert.match(v.text, /у 1 ответа цитат нет вовсе/)
  // И такой ответ НЕ посчитан дважды: сумма сходится, остатка нет.
  assert.ok(!/прогон не сказал/.test(v.text), v.text)
})

test('«нет цитат» и «ни одна не нашлась» считаются по разным полям', () => {
  // `unverified` берётся по `quotes_verified === 'none'`, а не по
  // `has_quotes === true`: расходящийся файл (цитаты есть, а слова сверки нет)
  // обязан уехать в остаток, а не соврать, будто сверка была и провалилась.
  const t = tally(
    parseEval(
      file([
        question({
          id: 'q01',
          run: run({ outcome: 'unsupported', has_sources: true, has_quotes: true, quotes_verified: null }),
        }),
      ]),
    ),
  )
  assert.deepEqual(t.unsupported, { noSources: 0, noQuotes: 0, unverified: 0 })
  assert.match(verdict(t).text, /про 1 прогон не сказал, были ли цитаты/)
})

test('встретилась одна причина — названа одна, без пустой половины фразы', () => {
  const only = verdict(tally(parseEval(file([bad('q01', false)]))))
  assert.match(only.text, /у 1 ответа цитат нет вовсе\./)
  assert.ok(!/во фрагментах не нашлись/.test(only.text), only.text)
  const other = verdict(tally(parseEval(file([bad('q01', true)]))))
  assert.match(other.text, /у 1 цитаты есть, но во фрагментах не нашлись\./)
  assert.ok(!/цитат нет вовсе/.test(other.text), other.text)
})

test('прогон не сказал про цитаты — это третий случай, и сумма не врёт', () => {
  // `has_quotes` потерялся: в оба ведра такой ответ не падает, иначе два
  // числа молча расходились бы с числом ответов без подтверждения.
  const t = tally(
    parseEval(
      file([
        bad('q01', false),
        question({ id: 'q02', run: run({ outcome: 'unsupported', has_quotes: 'да' }) }),
      ]),
    ),
  )
  assert.deepEqual(t.unsupported, { noSources: 0, noQuotes: 1, unverified: 0 })
  const v = verdict(t)
  assert.match(v.text, /2 ответа нечем проверить/)
  assert.match(v.text, /про 1 прогон не сказал, были ли цитаты/)
})

test('подтверждённых ответов хватает — про «нечем проверить» не говорится вовсе', () => {
  const t = tally(parseEval(file([question({ id: 'q01' })])))
  assert.equal(t.unsupported.noQuotes, 0)
  assert.ok(!/нечем проверить/.test(verdict(t).text), verdict(t).text)
})
