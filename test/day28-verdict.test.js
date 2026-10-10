// Вердикт страницы дня 28 — site/day28/verdict.js, тот же файл, которым
// страница строит фразу «Итога». Тест лежит вне site/: каталог отдаётся Caddy
// целиком как корень сайта (так же устроен test/day21-verdict.test.js).
//
// Правило, которое здесь держится: страница не утверждает больше, чем считает.
// Индексы двух сторон разные, и вывод дня считается только по вопросам с
// совпавшим поиском — иначе разница поиска выдавалась бы за разницу моделей
// (спецификация дней 26–30, тело дня 28, п. 4).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import '../site/day28/verdict.js'

const { matched, counts, noise, diffWord, summaryRows, verdictText, matchLine,
  cutsCell, stability } = globalThis.DAY28_VERDICT

const DATA = () => JSON.parse(readFileSync(new URL('../site/day28/results.json', import.meta.url), 'utf8'))

/** Синтетика: n вопросов с совпавшим поиском, оценки сторон заданы списками. */
function synth({ local = [], cloud = [], match = null, timeLocal = null, timeCloud = null }) {
  const verdictOf = (s) => (s === 2 ? 'верно' : s === 1 ? 'частично' : 'неверно')
  const questions = local.map((s, i) => ({
    id: 'q' + i,
    text: 'вопрос ' + i,
    retrieved_match: match ? match[i] : true,
    local: { score: s, verdict: verdictOf(s), time_s: 10, refused: false, sources: [] },
    cloud: { score: cloud[i], verdict: verdictOf(cloud[i]), time_s: 10, refused: false, sources: [] },
  }))
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length
  return {
    day: 28,
    questions,
    summary: {
      local: { score_avg: avg(local), retrieved: 0, cited: 0, refused: 0, time_s_mean: timeLocal, answers: local.length },
      cloud: { score_avg: avg(cloud), retrieved: 0, cited: 0, refused: 0, time_s_mean: timeCloud, answers: cloud.length },
    },
  }
}

test('настоящие данные: вывод считается по совпавшему поиску и называет их число', () => {
  const data = DATA()
  const qs = matched(data.questions)
  const c = counts(data.questions)
  assert.equal(qs.length, 6)
  assert.deepEqual([c.total, c.matched, c.missed, c.nodoc], [10, 6, 2, 2])
  const text = verdictText(data)
  assert.match(text, /не хуже облачной в пределах шума/)
  assert.match(text, /по 6 вопросам с совпавшим поиском из 10/)
  // Средняя по всем десяти (1,70 против 1,90) в выводе не участвует: вывод
  // стоит на шести совпавших, где обе стороны дают 1,83.
  assert.match(text, /1,83 против 1,83/)
  assert.match(text, /Скорость сторон не сравнивается/)
  assert.match(matchLine(data), /^Поиск совпал на 6 вопросах из 10/)
})

test('порог шума — два вопроса из набора, а не константа', () => {
  assert.equal(noise(6), 2 / 6)
  assert.equal(noise(10), 2 / 10)
  assert.equal(noise(0), null)
})

test('разница больше шума: сторона названа, и названа та, что ниже', () => {
  // Четыре вопроса, порог шума 0,5; локальная ниже на 0,75.
  const data = synth({ local: [2, 1, 1, 1], cloud: [2, 2, 2, 2] })
  const text = verdictText(data)
  assert.match(text, /^Локальная модель хуже облачной по оценке на 0,75\./)
  assert.doesNotMatch(text, /в пределах шума/)
})

test('разница в один вопрос из набора вывода не меняет: это шум', () => {
  const data = synth({ local: [2, 2, 1, 2], cloud: [2, 2, 2, 2] })
  assert.match(verdictText(data), /не хуже облачной в пределах шума/)
})

test('метрики расходятся: оценка у одной стороны, скорость у другой', () => {
  const data = synth({
    local: [2, 2, 2, 2], cloud: [1, 1, 1, 2], timeLocal: 90, timeCloud: 20,
  })
  const text = verdictText(data)
  assert.match(text, /^Метрики расходятся: оценка выше у локальной, скорость — у облачной/)
  assert.match(text, /одного ответа числа не дают/)
})

test('одна сторона из двух: вывод не считается вовсе', () => {
  const data = synth({ local: [2, 2], cloud: [2, 2] })
  delete data.summary.cloud
  const text = verdictText(data)
  assert.match(text, /Сравнивать нечего: измерена одна сторона из двух/)
  assert.doesNotMatch(text, /в пределах шума/)
})

test('поиск не совпал ни на одном вопросе: сравнивать нечего', () => {
  const data = synth({ local: [2, 1], cloud: [1, 2], match: [false, null] })
  assert.match(verdictText(data), /верный документ не нашли обе стороны ни на одном из 2/)
})

test('слово к знаку: равенство названо равенством, шум — шумом', () => {
  assert.equal(diffWord(0, 0.33, 'выше у локальной', 'выше у облачной'), 'столько же')
  assert.equal(diffWord(0.2, 0.33, 'выше у локальной', 'выше у облачной'), 'в пределах шума')
  assert.equal(diffWord(-0.5, 0.33, 'выше у локальной', 'выше у облачной'), 'выше у облачной')
  assert.equal(diffWord(null, 0.33, 'a', 'b'), 'нет данных')
})

test('непомеренное время — «нет данных», а не нуль', () => {
  const rows = summaryRows(DATA())
  const time = rows.find((r) => /Полное время/.test(r.name))
  assert.equal(time.b, null, 'время облачной стороны не измерено, а в данных появилось число')
  assert.equal(time.d, null)
  assert.equal(time.word, 'нет данных')
})

test('незаписанная причина остановки — «нет данных», а не нуль обрывов', () => {
  assert.equal(cutsCell([{ done_reason: null }, { done_reason: null }]), 'нет данных')
  assert.equal(cutsCell([{ done_reason: 'stop' }, { done_reason: 'length' }]), '1')
  assert.equal(cutsCell([]), 'нет данных')
})

test('стабильность: расхождение вердиктов названо по вопросу', () => {
  const data = DATA()
  const st = stability(data)
  assert.equal(st.rows.length, 3)
  assert.match(st.text, /Прогнаны по три раза 3 вопроса — q08, q72, m01/)
  assert.match(st.text, /остальные 7 — однажды/)
  assert.match(st.text, /вердикты разошлись на q72 \(неверно, верно, верно\)/)
  assert.match(st.text, /причину остановки прогон не записал/)
})

test('сошедшиеся вердикты не делают секцию пустой', () => {
  const data = DATA()
  data.questions.forEach((q) => {
    if (q.local && Array.isArray(q.local.runs)) {
      q.local.runs = q.local.runs.map((r) => ({ ...r, verdict: 'верно', done_reason: 'stop' }))
    }
  })
  const st = stability(data)
  assert.match(st.text, /вердикты не расходились/)
  assert.match(st.text, /обрывов не было/)
})

test('меньше трёх ответов у вопроса стабильности: это сказано, а не сглажено', () => {
  const data = DATA()
  const q = data.questions.find((x) => x.local && Array.isArray(x.local.runs) && x.local.runs.length === 3)
  q.local.runs = q.local.runs.slice(0, 2)
  assert.match(stability(data).text, new RegExp('у ' + q.id + ' пришло меньше трёх ответов'))
})
